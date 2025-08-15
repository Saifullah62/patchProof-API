// controllers/adminController.js
const bsv = require('bsv');
const Utxo = require('../models/Utxo');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const utxoManager = require('../services/utxoManagerService');
const { constructAndBroadcastTx } = require('../services/blockchainService');
const crypto = require('crypto');

function computeSha256(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(Buffer.from(json)).digest();
}

function computeMerkleRoot(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return Buffer.alloc(32);
  let level = hashes.map((h) => (Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex')));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || level[i];
      next.push(crypto.createHash('sha256').update(Buffer.concat([left, right])).digest());
    }
    level = next;
  }
  return level[0];
}

function computeMerklePath(index, hashes) {
  const path = [];
  let idx = index;
  let level = hashes.map((h) => (Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex')));
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const pairIndex = isRight ? idx - 1 : idx + 1;
    const sibling = level[pairIndex] || level[idx];
    path.push(sibling);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || level[i];
      next.push(crypto.createHash('sha256').update(Buffer.concat([left, right])).digest());
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}
const wocClient = require('../clients/wocClient');
const logger = require('../logger');

// Simple in-process lock set (single-instance). For multi-node, replace with Redis lock.
const taskLocks = new Set();

class AdminController {
  _acquireLock(taskName) {
    if (taskLocks.has(taskName)) {
      logger && logger.warn && logger.warn(`[AdminController] Task '${taskName}' is already running.`);
      return false;
    }
    taskLocks.add(taskName);
    return true;
  }

  _releaseLock(taskName) {
    taskLocks.delete(taskName);
  }

  async getUtxoHealth(req, res, next) {
    try {
      const stats = await Utxo.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalSatoshis: { $sum: '$satoshis' },
          },
        },
      ]);

      const healthReport = {
        unconfirmed: { count: 0, totalSatoshis: 0 },
        available: { count: 0, totalSatoshis: 0 },
        locked: { count: 0, totalSatoshis: 0 },
        spent: { count: 0, totalSatoshis: 0 },
      };

      stats.forEach((stat) => {
        if (healthReport[stat._id]) {
          healthReport[stat._id].count = stat.count;
          healthReport[stat._id].totalSatoshis = stat.totalSatoshis;
        }
      });

      // Use configured public funding address (no WIF in server)
      const fundingAddress = (process.env.FUNDING_ADDRESS || '').trim() || null;

      let chain = null;
      if (fundingAddress) {
        try {
          chain = await wocClient.getChainHealth(fundingAddress);
        } catch (e) {
          logger && logger.error && logger.error('[AdminController] Failed to fetch chain health from WOC.', e);
          chain = { error: e.message };
        }
      }

      res.json({
        db: healthReport,
        funding: {
          address: fundingAddress,
          network: (process.env.WOC_NETWORK || 'main').toLowerCase(),
          minConfirmations: Math.max(0, parseInt(process.env.UTXO_MIN_CONFIRMATIONS || '0', 10)),
        },
        chain,
      });
    } catch (err) {
      next(err);
    }
  }

  async triggerMaintenance(req, res, next) {
    const lockName = 'utxo-maintenance';
    if (!this._acquireLock(lockName)) {
      return res.status(409).json({ success: false, error: 'Maintenance task is already in progress.' });
    }
    try {
      const action = (req.body?.action || 'auto').toLowerCase();
      const steps = [];
      logger && logger.info && logger.info(`[AdminController] Starting maintenance action: ${action}`);
      if (action === 'sync' || action === 'auto') {
        steps.push(['sync', await utxoManager.syncUtxos()]);
      }
      if (action === 'sweep' || action === 'auto') {
        steps.push(['sweep', await utxoManager.sweepDust()]);
      }
      if (action === 'split' || action === 'auto') {
        steps.push(['split', await utxoManager.splitIfNeeded()]);
      }
      const result = Object.fromEntries(steps);
      logger && logger.info && logger.info(`[AdminController] Maintenance action '${action}' completed successfully.`);
      return res.json({ success: true, action, result });
    } catch (err) {
      logger && logger.error && logger.error(`[AdminController] Maintenance task failed: ${err.message}`, err);
      return next(err);
    } finally {
      this._releaseLock(lockName);
    }
  }

  async batchAnchor(req, res, next) {
    const lockName = 'batch-anchor';
    if (!this._acquireLock(lockName)) {
      return res.status(409).json({ success: false, error: 'Batch anchor task is already in progress.' });
    }
    try {
      // Optional query/body controls
      const limit = Math.min(parseInt(req.body?.limit || req.query?.limit || '100', 10) || 100, 1000);
      logger && logger.info && logger.info(`[AdminController] Starting batch anchor process with limit: ${limit}`);
      // 1) Load records pending anchoring (status-based workflow)
      const recordsToAnchor = await AuthenticationRecord.find({ status: 'pending' }).limit(limit).lean();

      if (!recordsToAnchor.length) {
        logger && logger.info && logger.info('[AdminController] No unanchored records found.');
        return res.json({ success: true, message: 'No unanchored records found to process.', processed: 0 });
      }

      // 2) Build hashes and Merkle root
      const hashes = recordsToAnchor.map((r) => computeSha256(r.record_data));
      const merkleRoot = computeMerkleRoot(hashes);

      // 3) Broadcast OP_RETURN with merkle root
      const opReturnData = [Buffer.from('PatchProofBatch'), merkleRoot];
      const broadcastResult = await constructAndBroadcastTx(opReturnData, 'BatchAnchor');
      if (!broadcastResult.success) {
        logger && logger.error && logger.error(`[AdminController] Broadcast failed: ${broadcastResult.error}`);
        return res.status(500).json({ success: false, error: broadcastResult.error || 'Broadcast failed' });
      }
      const anchorTxid = broadcastResult.txid;
      logger && logger.info && logger.info(`[AdminController] Broadcast successful. Anchor TXID: ${anchorTxid}`);

      // 4) Use bulkWrite for efficiency and better atomicity
      const bulkOps = recordsToAnchor.map((record, i) => {
        const path = computeMerklePath(i, [...hashes]);
        return {
          updateOne: {
            filter: { _id: record._id },
            update: {
              $set: {
                'record_data.auth.merkleRoot': merkleRoot.toString('hex'),
                'record_data.auth.merklePath': path.map((buf) => buf.toString('hex')),
                'record_data.auth.anchorTxid': anchorTxid,
                status: 'confirmed',
              },
            },
          },
        };
      });

      const bulkResult = await AuthenticationRecord.bulkWrite(bulkOps);
      const updated = bulkResult.modifiedCount;
      logger && logger.info && logger.info(`[AdminController] Batch anchor process completed. Updated ${updated}/${recordsToAnchor.length} records.`);

      return res.json({ success: true, txid: anchorTxid, processed: recordsToAnchor.length, updated });
    } catch (err) {
      logger && logger.error && logger.error(`[AdminController] Batch anchor task failed: ${err.message}`, err);
      next(err);
    } finally {
      this._releaseLock(lockName);
    }
  }
}

module.exports = new AdminController();
