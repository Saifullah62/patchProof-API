// workers/broadcastWorker.js
require('dotenv').config();
const { Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const BlockchainService = require('../services/blockchainService');
const dbService = require('../services/databaseService');

const connection = (() => {
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || null;
  if (url) return new IORedis(url);
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  return new IORedis({ host, port, password });
})();

const queueName = 'broadcast';

const queueEvents = new QueueEvents(queueName, { connection });
queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[broadcastWorker] Job ${jobId} failed: ${failedReason}`);
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
          try { await dbService.markTransferFailed(pendingId, res.error || 'broadcast failed'); } catch (_) {}
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
        try { await dbService.markRegistrationFailed(pendingId, res.error || 'broadcast failed'); } catch (_) {}
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
