// workers/broadcastWorker.js
require('dotenv').config();
const { Worker, QueueEvents, Queue } = require('bullmq');
const IORedis = require('ioredis');
const BlockchainService = require('../services/blockchainService');
const dbService = require('../services/databaseService');

const connection = (() => {
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || null;
  if (process.env.NODE_ENV === 'production') {
    const hasPasswordInUrl = typeof url === 'string' && /^redis(s)?:\/\//i.test(url) && /:\\S+@/.test(url);
    const hasExplicitPassword = !!process.env.REDIS_PASSWORD;
    if (!hasPasswordInUrl && !hasExplicitPassword) {
      throw new Error('[broadcastWorker] Unsafe Redis configuration for production: authentication required');
    }
  }
  if (url) return new IORedis(url, { maxRetriesPerRequest: null, password: process.env.REDIS_PASSWORD || undefined });
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  return new IORedis({ host, port, password, maxRetriesPerRequest: null });
})();

const queueName = 'broadcast';

const queueEvents = new QueueEvents(queueName, { connection });
const broadcastQueue = new Queue(queueName, { connection });
queueEvents.on('failed', async ({ jobId, failedReason }) => {
  try {
    console.error(`[broadcastWorker] Job ${jobId} failed: ${failedReason}`);
    const autoRecover = String(process.env.RECOVER_FAILED_BROADCASTS || 'false').toLowerCase();
    if (!['1', 'true', 'yes'].includes(autoRecover)) return;

    const maxRequeues = parseInt(process.env.RECOVER_MAX_REQUEUES || '1', 10);
    const job = await broadcastQueue.getJob(jobId);
    if (!job) return;
    const data = job.data || {};
    const name = job.name || 'registration';

    // Only recover jobs linked to a pending AuthenticationRecord
    const pendingId = data.pendingId;
    if (!pendingId) return;

    // Guard against infinite loops
    const recoverCount = parseInt((data.recoverCount || 0), 10);
    if (recoverCount >= maxRequeues) {
      console.warn(`[broadcastWorker] Recovery skipped; max requeues reached for job ${jobId}`);
      return;
    }

    // Revert the DB record back to pending and requeue
    try { await dbService.revertPending(pendingId); } catch (e) { console.error('[broadcastWorker] revertPending failed:', e); return; }

    const newData = { ...data, recoverCount: recoverCount + 1 };
    await broadcastQueue.add(name, newData, { attempts: job.opts?.attempts || 3, backoff: job.opts?.backoff || { type: 'exponential', delay: 5000 } });
    console.log(`[broadcastWorker] Re-queued failed job ${jobId} as new attempt (recoverCount=${recoverCount + 1}).`);
  } catch (e) {
    console.error('[broadcastWorker] failed-handler error:', e);
  }
});
queueEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`[broadcastWorker] Job ${jobId} completed:`, returnvalue);
});

const worker = new Worker(
  queueName,
  async (job) => {
    if (job.name === 'transfer') {
      const { pendingId, uid_tag_id, currentTxid, newOwnerAddress, record } = job.data;
      const opReturnData = [Buffer.from(JSON.stringify(record))];
      const res = await BlockchainService.constructAndBroadcastTransferTx(
        currentTxid,
        newOwnerAddress,
        record?.auth?.current_owner_signature,
        opReturnData
      );
      if (!res.success) {
        if (pendingId) {
          try { await dbService.markTransferFailed(pendingId, res.error || 'broadcast failed'); }
          // eslint-disable-next-line no-empty
          catch (_) {}
        }
        throw new Error(`Broadcast failed: ${res.error}`);
      }
      const newTxid = res.txid;
      record.auth.txid = newTxid;
      if (pendingId) {
        await dbService.markTransferConfirmed(pendingId, newTxid);
      } else {
        // Should not happen in new flow; no legacy path since transfer previously used updateOwnership directly in controller
        // Best-effort: do nothing extra
      }
      return { txid: newTxid };
    }

    // default/registration path
    const { record, uid_tag_id, initialOwner, purpose, pendingId } = job.data;
    const opReturnData = [Buffer.from(JSON.stringify(record))];
    const res = await BlockchainService.constructAndBroadcastTx(opReturnData, purpose || 'Registration');
    if (!res.success) {
      if (pendingId) {
        try { await dbService.markRegistrationFailed(pendingId, res.error || 'broadcast failed'); }
        // eslint-disable-next-line no-empty
        catch (_) {}
      }
      throw new Error(`Broadcast failed: ${res.error}`);
    }
    const txid = res.txid;
    record.auth.txid = txid;
    if (pendingId) {
      await dbService.markRegistrationConfirmed(pendingId, txid);
    } else {
      // Legacy fallback for older jobs without pendingId
      await dbService.registerPatch(uid_tag_id, txid, initialOwner, record);
    }
    return { txid };
  },
  { connection }
);

worker.on('error', (err) => {
  console.error('[broadcastWorker] Worker error:', err);
});
