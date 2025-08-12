#!/usr/bin/env node
// scripts/utxo-manager.js
// A robust, production-grade script for orchestrating UTXO wallet maintenance.
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { initDb, closeDb } = require('../config/db');
const utxoManagerService = require('../services/utxoManagerService');
const logger = require('../logger');
const lockManager = require('../services/lockManager');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('dryRun', {
      describe: 'Simulate all operations without broadcasting transactions or saving changes.',
      type: 'boolean',
      default: false,
    })
    .help()
    .alias('h', 'help')
    .argv;

  // Initialize services first
  await lockManager.initialize();
  await initDb();

  const lockName = 'utxo-manager-process';
  const lockToken = await lockManager.acquireLock(lockName, 10 * 60 * 1000); // 10-minute lock

  if (!lockToken) {
    logger.info('[UTXO Manager] Process is already running (lock not acquired). Exiting.');
    await closeDb();
    return;
  }

  logger.info(`[UTXO Manager] Starting run. Dry Run: ${argv.dryRun}`);

  try {
    // 1. Sync on-chain state with the local database.
    // This service method will handle fetching on-chain data and marking local UTXOs as spent if necessary.
    logger.info('[1/3] Syncing local UTXO pool with on-chain state...');
    const syncResult = await utxoManagerService.syncUtxos(argv.dryRun);
    logger.info(syncResult, 'Sync complete.');

    // 2. Sweep dust UTXOs to consolidate funds.
    // The service encapsulates the logic for finding and sweeping dust.
    logger.info('[2/3] Checking for dust to sweep...');
    const sweepResult = await utxoManagerService.sweepDust(argv.dryRun);
    logger.info(sweepResult, 'Dust sweep check complete.');

    // 3. Split a large UTXO if the available pool is too small.
    // The service encapsulates the logic for checking the pool and performing the split.
    logger.info('[3/3] Checking if UTXO pool needs splitting...');
    const splitResult = await utxoManagerService.splitIfNeeded(argv.dryRun);
    logger.info(splitResult, 'Split check complete.');

  } catch (error) {
    logger.error('[UTXO Manager] A critical error occurred during the run:', error);
    process.exitCode = 1;
  } finally {
    await lockManager.releaseLock(lockName, lockToken);
    await closeDb();
    logger.info('[UTXO Manager] Run finished.');
  }
}

main();
