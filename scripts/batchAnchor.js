#!/usr/bin/env node

// scripts/batchAnchor.js
// A robust, atomic, and idempotent script for batch-anchoring records.
require('dotenv').config();

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { initDb, closeDb } = require('../config/db');
const { constructAndBroadcastTx } = require('../services/blockchainService');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const logger = require('../logger');
const lockManager = require('../services/lockManager');

// --- Local cryptographic helpers (migrated from deprecated keyUtils) ---
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
    // build next level
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

async function batchAnchorRecords() {
  // Initialize services first
  await lockManager.initialize();
  await initDb();

  const lockName = 'batch-anchor-process';
  const leaseMs = 5 * 60 * 1000; // 5 minutes with heartbeat
  let claimedRecordIds = [];
  const res = await lockManager.withLockHeartbeat(lockName, leaseMs, async () => {
    logger.info({ message: 'Lock acquired, starting batch anchoring process.', lockName });

    const argv = yargs(hideBin(process.argv))
      .option('limit', {
        describe: 'The maximum number of records to anchor in this batch',
        type: 'number',
        default: 100,
      })
      .strict(false)
      .help(false)
      .parse();

    // 1. Find candidates and claim them to prevent reprocessing by other runs
    const recordsToClaim = await AuthenticationRecord.find({ status: 'pending' })
      .limit(argv.limit)
      .select('_id')
      .lean();

    claimedRecordIds = recordsToClaim.map((r) => r._id);

    if (claimedRecordIds.length === 0) {
      logger.info('No new records to anchor.');
      return true; // graceful
    }

    await AuthenticationRecord.updateMany(
      { _id: { $in: claimedRecordIds } },
      { $set: { status: 'anchoring' } }
    );
    logger.info(`Claimed ${claimedRecordIds.length} records for anchoring.`);

    const recordsToAnchor = await AuthenticationRecord.find({ _id: { $in: claimedRecordIds } });

    // 2. Compute hashes and the Merkle root
    const hashes = recordsToAnchor.map((r) => computeSha256(r.record_data));
    const merkleRoot = computeMerkleRoot(hashes);

    // 3. Broadcast the Merkle root to the blockchain
    const opReturnData = [Buffer.from('PatchProofBatch'), merkleRoot];
    const broadcastResult = await constructAndBroadcastTx(opReturnData, 'BatchAnchor');

    if (!broadcastResult.success) {
      throw new Error(`Failed to broadcast Merkle root: ${broadcastResult.error || 'Unknown error'}`);
    }
    const anchorTxid = broadcastResult.txid;
    logger.info(`Successfully broadcasted Merkle root in transaction: ${anchorTxid}`);

    // 4. Use a single bulkWrite operation to update all records efficiently.
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

    await AuthenticationRecord.bulkWrite(bulkOps);
    logger.info(`Successfully updated ${recordsToAnchor.length} records with anchor proof.`);
    return true;
  }).catch(async (error) => {
    // Ensure revert on error
    logger.error('An error occurred during the batch anchoring process:', error);
    if (claimedRecordIds.length > 0) {
      try {
        logger.info('Reverting status of claimed records back to "pending".');
        await AuthenticationRecord.updateMany(
          { _id: { $in: claimedRecordIds }, status: 'anchoring' },
          { $set: { status: 'pending' } }
        );
      } catch (revertErr) {
        logger.error('Failed to revert claimed records to pending:', revertErr);
      }
    }
    process.exitCode = 1; // Signal failure to scheduler
    return false;
  }).finally(async () => {
    await closeDb();
    logger.info('Batch anchoring process finished.');
  });

  if (!res || (res && res.ok === false) || res === 'LOCK_NOT_ACQUIRED') {
    // If lock not acquired, process would not run; not an error.
  }
}

if (require.main === module) {
  batchAnchorRecords();
}