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
  const leaseMs = 5 * 60 * 1000; // 5 minutes with heartbeat
  const res = await lockManager.withLockHeartbeat(lockName, leaseMs, async () => {
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
      return true;
    } catch (error) {
      logger.error('[Reaper] An error occurred during the reaping process:', error);
      process.exitCode = 1;
      return false;
    } finally {
      await closeDb();
      logger.info('[Reaper] Reaper process finished.');
    }
  });

  if (!res.ok && res.error === 'LOCK_NOT_ACQUIRED') {
    logger.info('[Reaper] Reaper process is already running (lock not acquired). Exiting.');
  }
}

main();
