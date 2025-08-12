#!/usr/bin/env node
require('dotenv').config();
const { Queue, Job } = require('bullmq');
const IORedis = require('ioredis');

function getRedisConnection() {
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || null;
  if (url) return new IORedis(url, { maxRetriesPerRequest: null });
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  return new IORedis({ host, port, password, maxRetriesPerRequest: null });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { queue: 'broadcast', limit: 50, retry: false, requeue: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--queue' || a === '-q') opts.queue = args[++i];
    else if (a === '--limit' || a === '-n') opts.limit = parseInt(args[++i], 10) || 50;
    else if (a === '--retry') opts.retry = true;
    else if (a === '--requeue') opts.requeue = true; // add a new job with same data
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/jobs/report-failed.js [--queue <name>] [--limit <N>] [--retry | --requeue]\n\n` +
    `Examples:\n` +
    `  node scripts/jobs/report-failed.js\n` +
    `  node scripts/jobs/report-failed.js --queue email --limit 100\n` +
    `  node scripts/jobs/report-failed.js --retry\n` +
    `  node scripts/jobs/report-failed.js --requeue\n`);
}

async function main() {
  const opts = parseArgs();
  if (opts.help) return printHelp();

  const connection = getRedisConnection();
  const queue = new Queue(opts.queue, { connection });

  try {
    const failed = await queue.getFailed(0, opts.limit - 1);
    if (!failed.length) {
      console.log(`[report-failed] No failed jobs in queue '${opts.queue}'.`);
      return;
    }

    console.log(`[report-failed] Found ${failed.length} failed job(s) in '${opts.queue}':`);
    for (const job of failed) {
      console.log(`- id=${job.id} name=${job.name} attemptsMade=${job.attemptsMade} failedReason=${job.failedReason || ''}`);
    }

    if (opts.retry) {
      let ok = 0, err = 0;
      for (const job of failed) {
        try { await job.retry(); ok++; } catch (e) { err++; console.error(`[report-failed] retry id=${job.id} failed:`, e.message); }
      }
      console.log(`[report-failed] retry complete: ok=${ok} err=${err}`);
    } else if (opts.requeue) {
      let ok = 0, err = 0;
      for (const job of failed) {
        try {
          await queue.add(job.name, job.data, { attempts: job.opts.attempts || 3, backoff: job.opts.backoff || { type: 'exponential', delay: 5000 } });
          ok++;
        } catch (e) { err++; console.error(`[report-failed] requeue id=${job.id} failed:`, e.message); }
      }
      console.log(`[report-failed] requeue complete: ok=${ok} err=${err}`);
    }
  } finally {
    await queue.close();
    await connection.quit();
  }
}

main().catch((e) => { console.error('[report-failed] fatal:', e); process.exit(1); });
