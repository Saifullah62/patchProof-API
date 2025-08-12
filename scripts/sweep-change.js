#!/usr/bin/env node
// scripts/sweep-change.js
// A secure script to consolidate all UTXOs from a change address to the main funding address.
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { initDb, closeDb } = require('../config/db');
const blockchainService = require('../services/blockchainService');
const logger = require('../logger');
const lockManager = require('../services/lockManager');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --changeAddress <address> --changeKeyId <keyId> --destinationAddress <address> [options]')
    .option('changeAddress', {
      describe: 'The change address to sweep funds from',
      type: 'string',
      demandOption: true,
    })
    .option('changeKeyId', {
      describe: 'The KMS key identifier for the change address, used for signing',
      type: 'string',
      demandOption: true,
    })
    .option('destinationAddress', {
      describe: 'The main funding address to send the consolidated funds to',
      type: 'string',
      demandOption: true,
    })
    .option('dryRun', {
      describe: 'Simulate the sweep without broadcasting the transaction',
      type: 'boolean',
      default: false,
    })
    .help()
    .alias('h', 'help')
    .argv;

  await lockManager.initialize();
  await initDb();

  const lockName = `sweep-address-${argv.changeAddress}`;
  const lockToken = await lockManager.acquireLock(lockName, 5 * 60 * 1000); // 5-minute lock

  if (!lockToken) {
    logger.info('Sweep process for this address is already running. Exiting.');
    await closeDb();
    return;
  }

  logger.info({
    message: 'Starting change address sweep...',
    changeAddress: argv.changeAddress,
    changeKeyId: argv.changeKeyId,
    destinationAddress: argv.destinationAddress,
    dryRun: argv.dryRun,
  });

  try {
    // Delegate to blockchain service for UTXO fetch, fee calc, signing, and broadcast
    const result = await blockchainService.sweepAddress({
      addressToSweep: argv.changeAddress,
      signingKeyIdentifier: argv.changeKeyId,
      destinationAddress: argv.destinationAddress,
      isDryRun: argv.dryRun,
    });

    if (argv.dryRun) {
      logger.info('--- DRY RUN COMPLETE ---');
      logger.info(`Found ${result.utxosSwept.length} UTXO(s) to sweep.`);
      logger.info(`Total value: ${result.totalSatoshis} satoshis.`);
      logger.info(`Estimated fee: ${result.estimatedFee} satoshis.`);
      logger.info(`Transaction would send ${result.finalAmount} satoshis.`);
      logger.info('No transaction was broadcast.');
    } else {
      if (result.success) {
        logger.info(`Successfully broadcasted sweep transaction: ${result.txid}`);
      } else {
        logger.error('Failed to broadcast sweep transaction:', { error: result.error });
        process.exitCode = 1;
      }
    }
  } catch (error) {
    logger.error('An error occurred during the sweep process:', error);
    process.exitCode = 1;
  } finally {
    try { await lockManager.releaseLock(lockName, lockToken); } catch (_) {}
    await closeDb();
    logger.info('Sweep script finished.');
  }
}

main();
