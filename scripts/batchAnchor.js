// scripts/batchAnchor.js
// Batch anchoring for records missing on-chain anchor metadata.
// Refactored to use Mongoose models and BlockchainService.

const { initDb, closeDb } = require('../config/db');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const BlockchainService = require('../services/blockchainService');
const { computeSha256, computeMerkleRoot, computeMerklePath } = require('../keyUtils');
const logger = require('../logger');

async function batchAnchorRecords() {
  await initDb();

  // Find records without anchorTxid (or still marked pending)
  const docs = await AuthenticationRecord.find({
    $or: [
      { 'record_data.auth.anchorTxid': { $exists: false } },
      { 'record_data.auth.merkle_proof': 'pending' },
    ],
  })
    .lean()
    .exec();

  const records = docs.map((d) => ({ id: d.txid, record: d.record_data }));
  if (!records.length) {
    console.log('No records to anchor.');
    return;
  }

  const hashes = records.map(r => computeSha256(r.record));
  const merkleRoot = computeMerkleRoot(hashes);

  const anchorTx = await BlockchainService.constructAndBroadcastTx([merkleRoot], 'BatchAnchor', logger);
  if (!anchorTx.success) {
    console.error('Failed to anchor batch:', anchorTx.error);
    return;
  }

  for (let i = 0; i < records.length; i++) {
    const path = computeMerklePath(i, [...hashes]);
    const updated = { ...records[i].record };
    updated.auth = Object.assign({}, updated.auth, {
      merkleRoot: merkleRoot.toString('hex'),
      merklePath: path.map(buf => buf.toString('hex')),
      anchorTxid: anchorTx.txid,
      merkle_proof: 'available',
    });

    await AuthenticationRecord.updateOne(
      { txid: records[i].id },
      { $set: { record_data: updated } }
    ).exec();
  }

  console.log(`Anchored ${records.length} records to tx: ${anchorTx.txid}`);
}

if (require.main === module) {
  batchAnchorRecords()
    .catch((e) => {
      console.error('Batch anchor failed:', e);
      process.exitCode = 1;
    })
    .finally(() => closeDb().catch(() => {}));
}
