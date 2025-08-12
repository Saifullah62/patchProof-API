#!/usr/bin/env node
// scripts/revert-stale-locks.js
// Finds UTXOs that have been locked for longer than a threshold and reverts them to 'available'.
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { initDb, closeDb } = require('../config/db');
const Utxo = require('../models/Utxo');
const logger = require('../logger');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('older-than-mins', {
      alias: 'm',
      type: 'number',
      default: 60,
      describe: 'Only revert locks older than this many minutes',
    })
    .option('limit', {
      alias: 'n',
      type: 'number',
      default: 500,
      describe: 'Maximum number of UTXOs to process',
    })
    .option('dry-run', {
      type: 'boolean',
      default: true,
      describe: 'Preview changes without writing to DB',
    })
    .strict(false)
    .help()
    .parse();

  await initDb();
  try {
    const cutoff = new Date(Date.now() - argv['older-than-mins'] * 60 * 1000);
    const candidates = await Utxo.find({ status: 'locked', updated_at: { $lt: cutoff } })
      .limit(argv.limit)
      .lean()
      .exec();

    if (!candidates.length) {
      console.log('[revert-stale-locks] No stale locked UTXOs found.');
      return;
    }

    console.log(`[revert-stale-locks] Found ${candidates.length} stale locked UTXO(s) older than ${argv['older-than-mins']} minutes. Dry-run=${argv['dry-run']}`);

    if (argv['dry-run']) {
      for (const u of candidates) {
        console.log(`Would revert ${u.txid}:${u.vout} (satoshis=${u.satoshis}) from locked -> available`);
      }
      return;
    }

    const bulk = Utxo.collection.initializeUnorderedBulkOp();
    for (const u of candidates) {
      bulk.find({ _id: u._id, status: 'locked' }).updateOne({ $set: { status: 'available', lockId: null } });
    }
    const res = await bulk.execute();
    const modified = res.nModified || res.modifiedCount || 0;
    console.log(`[revert-stale-locks] Reverted ${modified} UTXO(s) to available.`);
  } catch (e) {
    logger.error('[revert-stale-locks] Failed', e);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  main();
}
