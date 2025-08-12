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

    const res = await Utxo.updateMany(filter, { $set: { keyIdentifier } });
    console.log(`Updated ${res.modifiedCount || 0} UTXO(s) with keyIdentifier.`);
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

main();
