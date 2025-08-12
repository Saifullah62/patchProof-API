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
  const leaseMs = 10 * 60 * 1000; // 10-minute lease with heartbeat extension
  const result = await lockManager.withLockHeartbeat(lockName, leaseMs, async () => {
    logger.info(`[UTXO Manager] Starting run. Dry Run: ${argv.dryRun}`);

    try {
      // 1. Sync on-chain state with the local database.
      logger.info('[1/3] Syncing local UTXO pool with on-chain state...');
      const syncResult = await utxoManagerService.syncUtxos(argv.dryRun);
      logger.info(syncResult, 'Sync complete.');

      // 2. Sweep dust UTXOs to consolidate funds.
      logger.info('[2/3] Checking for dust to sweep...');
      const sweepResult = await utxoManagerService.sweepDust(argv.dryRun);
      logger.info(sweepResult, 'Dust sweep check complete.');

      // 3. Split a large UTXO if the available pool is too small.
      logger.info('[3/3] Checking if UTXO pool needs splitting...');
      const splitResult = await utxoManagerService.splitIfNeeded(argv.dryRun);
      logger.info(splitResult, 'Split check complete.');

      return { ok: true };
    } catch (error) {
      logger.error('[UTXO Manager] A critical error occurred during the run:', error);
      process.exitCode = 1;
      return { ok: false, error };
    } finally {
      await closeDb();
      logger.info('[UTXO Manager] Run finished.');
    }
  });

  if (!result.ok && result.error !== 'LOCK_NOT_ACQUIRED') {
    process.exitCode = 1;
  }
}

main();
