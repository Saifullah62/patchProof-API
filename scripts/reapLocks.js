#!/usr/bin/env node
// scripts/reapLocks.js
// A robust script to find and unlock UTXOs that have been locked for an extended period.
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { initDb, closeDb } = require('../config/db');
const utxoService = require('../services/utxoService');
const logger = require('../logger');
const lockManager = require('../services/lockManager');

async function main() {
  // Initialize services first
  await lockManager.initialize();
  await initDb();

  const lockName = 'utxo-reaper-process';
  // Attempt to acquire the lock with a 5-minute TTL.
  const lockToken = await lockManager.acquireLock(lockName, 5 * 60 * 1000);

  if (!lockToken) {
    logger.info('[Reaper] Reaper process is already running (lock not acquired). Exiting.');
    await closeDb();
    return;
  }

  logger.info('[Reaper] Starting orphaned UTXO lock reaper...');

  try {
    const argv = yargs(hideBin(process.argv))
      .option('age', {
        describe: 'The minimum age in minutes for a lock to be considered orphaned',
        type: 'number',
        default: parseInt(process.env.UTXO_REAPER_MINUTES || '15', 10),
      })
      .option('limit', {
        describe: 'The maximum number of locks to reap in this run',
        type: 'number',
        default: parseInt(process.env.UTXO_REAPER_BATCH_LIMIT || '500', 10),
      })
      .strict(false)
      .help(false)
      .parse();

    const result = await utxoService.unlockOrphanedLocked(argv.age, argv.limit);
    const unlocked = result.modifiedCount ?? result.unlocked ?? result.modified ?? 0;
    const matched = result.matchedCount ?? result.matched ?? 0;

    if (matched > 0) {
      logger.info(`[Reaper] Examined ${matched} locked UTXOs; unlocked ${unlocked}.`);
    } else if (unlocked > 0) {
      logger.info(`[Reaper] Unlocked ${unlocked} orphaned UTXO(s).`);
    } else {
      logger.info('[Reaper] No orphaned UTXOs found meeting the criteria.');
    }
  } catch (error) {
    logger.error('[Reaper] An error occurred during the reaping process:', error);
    process.exitCode = 1;
  } finally {
    // Always attempt to release the lock and close the DB connection.
    try { await lockManager.releaseLock(lockName, lockToken); } catch (_) {}
    await closeDb();
    logger.info('[Reaper] Reaper process finished.');
  }
}

main();
