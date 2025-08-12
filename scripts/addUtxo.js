#!/usr/bin/env node
// scripts/addUtxo.js
// Secure CLI to add a funding UTXO without handling raw private keys.
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const logger = require('../logger');
const { initDb, closeDb } = require('../config/db');
const utxoService = require('../services/utxoService');
const wocClient = require('../clients/wocClient');
const Utxo = require('../models/Utxo');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --txid <txid> --vout <n> --satoshis <n> --keyId <keyId> [options]')
    .option('txid', { describe: 'Transaction ID of the UTXO', type: 'string', demandOption: true })
    .option('vout', { describe: 'Output index (vout) of the UTXO', type: 'number', demandOption: true })
    .option('satoshis', { describe: 'Value of the UTXO in satoshis', type: 'number', demandOption: true })
    .option('keyId', { describe: 'Key identifier (public key string) managed by KMS', type: 'string', demandOption: true })
    .option('script', { describe: 'Hex-encoded scriptPubKey (optional)', type: 'string' })
    .option('exclusive', { describe: 'Mark all other available UTXOs as spent', type: 'boolean', default: false })
    .option('confirm', { describe: 'Required to confirm --exclusive operation', type: 'boolean', default: false })
    .help().alias('h', 'help')
    .argv;

  if (argv.exclusive && !argv.confirm) {
    logger.error('The --exclusive flag requires --confirm to proceed. Aborting.');
    process.exit(1);
  }

  await initDb();

  // Initialize WOC client
  try { wocClient.initialize(); } catch (e) {
    logger.error('Failed to initialize WOC client', e);
    await closeDb();
    process.exit(2);
  }

  const utxoData = {
    txid: argv.txid,
    vout: argv.vout,
    satoshis: argv.satoshis,
    keyIdentifier: argv.keyId,
    scriptPubKey: argv.script,
  };

  // Validate unspent status with robust client (timeouts/retries)
  try {
    const spent = await wocClient.isUtxoSpent(utxoData.txid, utxoData.vout);
    if (spent) {
      logger.error(`Refusing to add UTXO ${utxoData.txid}:${utxoData.vout} because it is already spent on-chain.`);
      await closeDb();
      process.exit(2);
    }
  } catch (e) {
    logger.error('Failed to verify UTXO status on-chain (WOC). Aborting.', e);
    await closeDb();
    process.exit(3);
  }

  if (argv.exclusive) {
    logger.warn('--- EXCLUSIVE MODE --- Marking other available UTXOs as spent.');
    const res = await Utxo.updateMany(
      { status: 'available', $or: [{ txid: { $ne: utxoData.txid } }, { vout: { $ne: utxoData.vout } }] },
      { $set: { status: 'spent', updated_at: new Date() } }
    );
    logger.info(`Marked ${res.modifiedCount || 0} other available UTXO(s) as spent.`);
  }

  await utxoService.addUtxo(utxoData);
  logger.info('UTXO added successfully!', { txid: utxoData.txid, vout: utxoData.vout });

  await closeDb();
}

main().catch(async (err) => {
  logger.error('Failed to add UTXO:', err);
  try { await closeDb(); } catch (_) {}
  process.exit(1);
});
