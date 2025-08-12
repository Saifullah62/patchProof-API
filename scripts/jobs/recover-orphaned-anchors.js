#!/usr/bin/env node
/**
 * scripts/jobs/recover-orphaned-anchors.js
 *
 * Scans for AuthenticationRecord docs that are failed or stuck in anchoring and reverts them to pending.
 * Optionally re-queues broadcast/transfer jobs for processing.
 */
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { initDb, closeDb } = require('../../config/db');
const AuthenticationRecord = require('../../models/AuthenticationRecord');
const jobService = require('../../services/jobService');
const logger = require('../../logger');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('states', {
      describe: 'Comma-separated list of states to recover',
      type: 'string',
      default: 'failed,anchoring',
    })
    .option('stuck-mins', {
      describe: 'Only treat anchoring records older than this many minutes as stuck',
      type: 'number',
      default: 15,
    })
    .option('limit', {
      describe: 'Maximum number of records to process',
      type: 'number',
      default: 200,
    })
    .option('dry-run', {
      describe: 'Show what would be changed without modifying data or re-queuing',
      type: 'boolean',
      default: false,
    })
    .option('requeue', {
      describe: 'Re-queue a job for each reverted record',
      type: 'boolean',
      default: false,
    })
    .strict(false)
    .help()
    .parse();

  const states = argv.states.split(',').map(s => s.trim()).filter(Boolean);
  const includeFailed = states.includes('failed');
  const includeAnchoring = states.includes('anchoring');
  const cutoff = new Date(Date.now() - argv['stuck-mins'] * 60 * 1000);

  await initDb();
  if (argv.requeue) {
    try { await jobService.initialize(); } catch (e) { logger.error('[recover-orphaned-anchors] JobService init failed', e); }
  }

  try {
    const orFilters = [];
    if (includeFailed) {
      orFilters.push({ status: 'failed' });
    }
    if (includeAnchoring) {
      orFilters.push({ status: 'anchoring', updated_at: { $lt: cutoff } });
    }
    if (orFilters.length === 0) {
      console.log('Nothing to do. Specify --states failed,anchoring');
      return;
    }

    const candidates = await AuthenticationRecord.find({ $or: orFilters })
      .limit(argv.limit)
      .lean()
      .exec();

    if (!candidates.length) {
      console.log('[recover-orphaned-anchors] No candidates found.');
      return;
    }

    console.log(`[recover-orphaned-anchors] Found ${candidates.length} candidate(s). Dry-run=${argv['dry-run']}, Requeue=${argv.requeue}`);

    if (argv['dry-run']) {
      for (const c of candidates) {
        console.log(`Would revert ${c._id} (${c.type}) from ${c.status} -> pending`);
      }
      return;
    }

    const bulk = AuthenticationRecord.collection.initializeUnorderedBulkOp();
    for (const c of candidates) {
      bulk.find({ _id: c._id, status: c.status }).updateOne({ $set: { status: 'pending', failure_reason: null } });
    }
    const res = await bulk.execute();
    console.log(`[recover-orphaned-anchors] Reverted ${res.nModified || res.modifiedCount || 0} record(s) to pending.`);

    if (argv.requeue) {
      let queued = 0;
      for (const c of candidates) {
        try {
          if (c.type === 'TRANSFER') {
            await jobService.addTransferJob({
              pendingId: c._id,
              uid_tag_id: c.uid_tag_id,
              currentTxid: c.previous_txid,
              newOwnerAddress: c.record_data?.auth?.owner,
              record: c.record_data,
              recoverCount: (c.recoverCount || 0) + 1,
            });
          } else {
            await jobService.addBroadcastJob({
              pendingId: c._id,
              uid_tag_id: c.uid_tag_id,
              initialOwner: c.record_data?.auth?.owner,
              record: c.record_data,
              purpose: 'Registration',
              recoverCount: (c.recoverCount || 0) + 1,
            });
          }
          queued += 1;
        } catch (e) {
          logger.error('[recover-orphaned-anchors] Failed to enqueue job for', c._id, e);
        }
      }
      console.log(`[recover-orphaned-anchors] Re-queued ${queued} record(s).`);
    }
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
