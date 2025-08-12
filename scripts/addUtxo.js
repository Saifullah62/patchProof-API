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
const bsv = require('bsv');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --txid <txid> --vout <n> --satoshis <n> --keyId <keyId> [--address <addr> | --script <hex>] [--force] [options]')
    .option('txid', { describe: 'Transaction ID of the UTXO', type: 'string', demandOption: true })
    .option('vout', { describe: 'Output index (vout) of the UTXO', type: 'number', demandOption: true })
    .option('satoshis', { describe: 'Value of the UTXO in satoshis', type: 'number', demandOption: true })
    .option('keyId', { describe: 'Key identifier (public key string) managed by KMS', type: 'string', demandOption: true })
    .option('address', { describe: 'Funding address the UTXO belongs to (recommended for on-chain validation)', type: 'string' })
    .option('script', { describe: 'Hex-encoded scriptPubKey (optional; used to derive address for validation if provided)', type: 'string' })
    .option('force', { describe: 'Proceed even if on-chain validation fails or is unavailable', type: 'boolean', default: false })
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

  // Optional on-chain existence and amount verification when address or script is provided
  let verified = false;
  try {
    let addr = argv.address;
    if (!addr && argv.script) {
      try {
        const net = (process.env.WOC_NETWORK || 'main').toLowerCase() === 'test' ? bsv.Networks.testnet : bsv.Networks.mainnet;
        const sc = bsv.Script.fromHex(argv.script);
        addr = sc.toAddress(net)?.toString();
      } catch (e) {
        logger.warn('Could not derive address from provided script; will skip address-based verification.');
      }
    }
    if (addr) {
      const unspent = await wocClient.getUnspentOutputs(addr, 0);
      const match = (Array.isArray(unspent) ? unspent : []).find(u => {
        const txh = u.tx_hash || u.txid;
        const v = u.tx_pos != null ? u.tx_pos : u.vout;
        return String(txh) === String(utxoData.txid) && Number(v) === Number(utxoData.vout);
      });
      if (!match) {
        logger.error(`On-chain check: ${utxoData.txid}:${utxoData.vout} not found for address ${addr}.`);
        if (!argv.force) {
          logger.error('Refusing to add UTXO without --force. Provide the correct address/script or use --force to override.');
          await closeDb();
          process.exit(4);
        }
      } else {
        const value = match.value != null ? match.value : match.satoshis;
        if (Number(value) !== Number(utxoData.satoshis)) {
          logger.warn(`On-chain value (${value}) does not match provided satoshis (${utxoData.satoshis}).`);
          if (!argv.force) {
            logger.error('Refusing to add UTXO due to amount mismatch. Use --force to override.');
            await closeDb();
            process.exit(5);
          }
        }
        // Backfill scriptPubKey if missing and we have a standard P2PKH address
        if (!utxoData.scriptPubKey && addr) {
          try {
            utxoData.scriptPubKey = bsv.Script.buildPublicKeyHashOut(addr).toHex();
          } catch (_) { /* ignore */ }
        }
        verified = true;
      }
    } else {
      logger.warn('No address or derivable address from script provided; cannot fully verify existence/amount.');
      if (!argv.force) {
        logger.error('Provide --address or --script for verification, or use --force to bypass.');
        await closeDb();
        process.exit(6);
      }
    }
  } catch (e) {
    logger.error('On-chain verification error while checking address unspents.', e);
    if (!argv.force) {
      await closeDb();
      process.exit(7);
    }
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
  logger.info('UTXO added successfully!', { txid: utxoData.txid, vout: utxoData.vout, verified });

  await closeDb();
}

main().catch(async (err) => {
  logger.error('Failed to add UTXO:', err);
  try { await closeDb(); } catch (_) {}
  process.exit(1);
});
