// controllers/adminController.js
const Utxo = require('../models/Utxo');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const { computeSha256, computeMerkleRoot, computeMerklePath } = require('../keyUtils');
const { constructAndBroadcastTx } = require('../services/blockchainService');

class AdminController {
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

      res.json(healthReport);
    } catch (err) {
      next(err);
    }
  }

  async batchAnchor(req, res, next) {
    try {
      // Optional query/body controls
      const limit = Math.min(parseInt(req.body?.limit || req.query?.limit || '100', 10) || 100, 1000);
      // 1) Load records that haven't been anchored yet
      const recordsToAnchor = await AuthenticationRecord.find({ 'record_data.auth.anchorTxid': null }).limit(limit);

      if (!recordsToAnchor.length) {
        return res.json({ success: true, message: 'No unanchored records found to process.', processed: 0 });
      }

      // 2) Build hashes and Merkle root
      const hashes = recordsToAnchor.map((r) => computeSha256(r.record_data));
      const merkleRoot = computeMerkleRoot(hashes);

      // 3) Broadcast OP_RETURN with merkle root
      const opReturnData = [Buffer.from('PatchProofBatch'), merkleRoot];
      const broadcastResult = await constructAndBroadcastTx(opReturnData, 'BatchAnchor');
      if (!broadcastResult.success) {
        return res.status(500).json({ success: false, error: broadcastResult.error || 'Broadcast failed' });
      }
      const anchorTxid = broadcastResult.txid;

      // 4) Update each record with proof
      let updated = 0;
      for (let i = 0; i < recordsToAnchor.length; i++) {
        const record = recordsToAnchor[i];
        const path = computeMerklePath(i, [...hashes]);

        record.record_data.auth.merkleRoot = merkleRoot.toString('hex');
        record.record_data.auth.merklePath = path.map((buf) => buf.toString('hex'));
        record.record_data.auth.anchorTxid = anchorTxid;
        record.markModified('record_data');
        await record.save();
        updated += 1;
      }

      return res.json({ success: true, txid: anchorTxid, processed: recordsToAnchor.length, updated });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AdminController();
