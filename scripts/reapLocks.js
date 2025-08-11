// scripts/reapLocks.js
// Finds and unlocks UTXOs that have been locked for an extended period.
require('dotenv').config();
const { initDb, closeDb } = require('../config/db');
const utxoService = require('../services/utxoService');
const logger = require('../logger');

const REAP_OLDER_THAN_MINUTES = parseInt(process.env.UTXO_REAPER_MINUTES || '15', 10);
const BATCH_LIMIT = parseInt(process.env.UTXO_REAPER_BATCH_LIMIT || '500', 10);

async function main() {
  logger.info('[Reaper] Starting orphaned UTXO lock reaper...');
  await initDb();

  try {
    const result = await utxoService.unlockOrphanedLocked(REAP_OLDER_THAN_MINUTES, BATCH_LIMIT);
    const unlocked = result.unlocked ?? result.modified ?? result.modifiedCount ?? 0;
    const matched = result.matched ?? result.matchedCount ?? 0;
    if (matched > 0) {
      logger.info(`[Reaper] Examined ${matched} locked UTXOs; unlocked ${unlocked}.`);
    } else {
      logger.info('[Reaper] No orphaned UTXOs found.');
    }
  } catch (error) {
    logger.error('[Reaper] An error occurred during the reaping process:', error);
    process.exitCode = 1;
  } finally {
    await closeDb();
    logger.info('[Reaper] Reaper finished.');
  }
}

main();
