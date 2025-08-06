// scripts/batchAnchor.js
const { computeSha256, computeMerkleRoot, computeMerklePath } = require('../keyUtils');
const { saveRecord, getUnanchoredRecords, markAsAnchored } = require('../db');
const { broadcastRecord } = require('../broadcaster');

async function batchAnchorRecords() {
  const records = await getUnanchoredRecords(); // [{ id, record }]
  if (!records.length) return console.log('No records to anchor.');

  const hashes = records.map(r => computeSha256(r.record));
  const merkleRoot = computeMerkleRoot(hashes);

  const anchorTx = await broadcastRecord(merkleRoot);
  if (!anchorTx.broadcasted) {
    console.error('Failed to anchor batch:', anchorTx.error);
    return;
  }

  for (let i = 0; i < records.length; i++) {
    const path = computeMerklePath(i, [...hashes]);
    records[i].record.auth = {
      merkleRoot: merkleRoot.toString('hex'),
      merklePath: path.map(buf => buf.toString('hex')),
      anchorTxid: anchorTx.txid
    };
    await saveRecord(records[i].id, records[i].record);
    await markAsAnchored(records[i].id);
  }

  console.log(`Anchored ${records.length} records to tx: ${anchorTx.txid}`);
}

if (require.main === module) {
  batchAnchorRecords();
}
