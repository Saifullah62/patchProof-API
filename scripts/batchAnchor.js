// scripts/batchAnchor.js
require('dotenv').config(); // Load environment variables from .env file
const mongoose = require('mongoose');
const { initDb, closeDb } = require('../config/db');
const { computeSha256, computeMerkleRoot, computeMerklePath } = require('../keyUtils');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const { constructAndBroadcastTx } = require('../services/blockchainService'); // Using modern service

async function batchAnchorRecords() {
  console.log('Starting batch anchoring process...');
  await initDb();

  try {
    // 1. Find records that haven't been anchored yet.
    // This assumes a field like `anchorTxid` is null for unanchored records.
    const recordsToAnchor = await AuthenticationRecord.find({ 'record_data.auth.anchorTxid': null }).limit(100);

    if (!recordsToAnchor.length) {
      console.log('No new records to anchor.');
      return;
    }
    console.log(`Found ${recordsToAnchor.length} records to anchor.`);

    // 2. Compute hashes and the Merkle root
    const hashes = recordsToAnchor.map(r => computeSha256(r.record_data));
    const merkleRoot = computeMerkleRoot(hashes);

    // 3. Broadcast the Merkle root to the blockchain
    const opReturnData = [Buffer.from('PatchProofBatch'), merkleRoot];
    const broadcastResult = await constructAndBroadcastTx(opReturnData, 'BatchAnchor');
    
    if (!broadcastResult.success) {
      throw new Error(`Failed to broadcast Merkle root: ${broadcastResult.error || 'Unknown error'}`);
    }
    const anchorTxid = broadcastResult.txid;
    console.log(`Successfully broadcasted Merkle root in transaction: ${anchorTxid}`);

    // 4. Update each record with its Merkle proof and the anchor TXID
    for (let i = 0; i < recordsToAnchor.length; i++) {
      const record = recordsToAnchor[i];
      const path = computeMerklePath(i, [...hashes]);
      
      record.record_data.auth.merkleRoot = merkleRoot.toString('hex');
      record.record_data.auth.merklePath = path.map(buf => buf.toString('hex'));
      record.record_data.auth.anchorTxid = anchorTxid;
      
      // Mark the document as modified since we are changing a nested object
      record.markModified('record_data');
      await record.save();
    }

    console.log(`Successfully updated ${recordsToAnchor.length} records with anchor proof.`);

  } catch (error) {
    console.error('An error occurred during the batch anchoring process:', error);
    process.exitCode = 1;
  } finally {
    await closeDb();
    console.log('Batch anchoring process finished.');
  }
}

if (require.main === module) {
  batchAnchorRecords();
}