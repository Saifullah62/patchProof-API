// scripts/migrations/backfill-utxo-keyIdentifier.js
require('dotenv').config();
const mongoose = require('mongoose');
const bsv = require('bsv');

const Utxo = require('../../models/Utxo');

function getMongoUri() {
  return process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/patchproof';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

  const keyIdentifier = (process.env.FUNDING_PUBKEY_HEX || '').trim();
  if (!keyIdentifier || !/^[0-9a-fA-F]{66}$/.test(keyIdentifier)) {
    console.error('FUNDING_PUBKEY_HEX must be set to a 33-byte compressed SEC hex string to backfill keyIdentifier.');
    process.exit(2);
  }

  const uri = getMongoUri();
  const dbName = process.env.MONGODB_DB || 'patchproof';
  await mongoose.connect(uri, { dbName });

  try {
    const filter = { $or: [ { keyIdentifier: { $exists: false } }, { keyIdentifier: '' } ] };
    const total = await Utxo.countDocuments(filter);
    console.log(`Found ${total} UTXO(s) missing keyIdentifier.`);

    if (!total) {
      console.log('Nothing to do.');
      process.exit(0);
    }

    if (dryRun) {
      const sample = await Utxo.find(filter).limit(10).lean();
      console.log('Dry run; showing up to 10 example documents to be updated:');
      for (const d of sample) {
        console.log(` - ${d.txid}:${d.vout} sats=${d.satoshis} status=${d.status}`);
      }
      console.log('Run without --dry-run to perform the update.');
      process.exit(0);
    }

    // Stream and batch to avoid OOM on large collections
    const argBatchSize = (() => {
      const idx = process.argv.indexOf('--batch-size');
      if (idx !== -1 && process.argv[idx + 1]) {
        const n = parseInt(process.argv[idx + 1], 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 500;
    })();
    const logEvery = (() => {
      const idx = process.argv.indexOf('--log-every');
      if (idx !== -1 && process.argv[idx + 1]) {
        const n = parseInt(process.argv[idx + 1], 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 10_000;
    })();

    const cursor = Utxo.find(filter).select('_id').lean().cursor({ batchSize: 1000 });
    let batch = [];
    let modified = 0;
    let scanned = 0;
    for await (const doc of cursor) {
      scanned += 1;
      batch.push(doc._id);
      if (batch.length >= argBatchSize) {
        const res = await Utxo.updateMany({ _id: { $in: batch } }, { $set: { keyIdentifier } });
        modified += res.modifiedCount || 0;
        batch = [];
      }
      if (scanned % logEvery === 0) {
        console.log(`Scanned ${scanned}, updated so far ${modified}...`);
      }
    }
    if (batch.length) {
      const res = await Utxo.updateMany({ _id: { $in: batch } }, { $set: { keyIdentifier } });
      modified += res.modifiedCount || 0;
    }
    console.log(`Completed. Scanned ${scanned}, updated ${modified} UTXO(s) with keyIdentifier.`);
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

main();
