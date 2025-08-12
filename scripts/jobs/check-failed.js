#!/usr/bin/env node
// scripts/jobs/check-failed.js
// Exits with non-zero status if any failed jobs are present. Useful for cron/health checks.

require('dotenv').config();
const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

function getConnection() {
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || null;
  if (url) return new IORedis(url, { maxRetriesPerRequest: null });
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  return new IORedis({ host, port, password, maxRetriesPerRequest: null });
}

(async function main() {
  const connection = getConnection();
  const names = (process.env.BULL_QUEUES || 'broadcast,email').split(',').map((s) => s.trim()).filter(Boolean);
  const queues = names.map((n) => new Queue(n, { connection }));
  let totalFailed = 0;
  for (const q of queues) {
    const failed = await q.getFailed(0, 1000); // up to 1000 recent failures per queue
    console.log(`${q.name}: ${failed.length} failed`);
    totalFailed += failed.length;
  }
  await connection.quit();
  if (totalFailed > 0) {
    console.error(`Detected ${totalFailed} failed jobs across queues`);
    process.exit(2);
  } else {
    console.log('No failed jobs detected');
    process.exit(0);
  }
})();
