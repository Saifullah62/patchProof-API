// workers/emailWorker.js
// A robust, production-grade worker for processing email sending jobs.
require('dotenv').config();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const nodemailer = require('nodemailer');
const logger = require('../logger');
const { getSecret } = require('../secrets');

const QUEUE_NAME = 'email';

// --- Main Worker Logic ---

/**
 * The core processing function for the worker.
 * @param {import('bullmq').Job} job The job object from the queue.
 * @param {import('nodemailer').Transporter} transport The verified nodemailer transport.
 */
async function processJob(job, transport) {
  const { to, subject, text, html } = job.data;

  if (!transport) {
    logger.info(`[EmailWorker MOCK] Send email to ${to} | Subject: ${subject}`);
    return { mocked: true };
  }

  const fromAddress = getSecret('EMAIL_FROM') || getSecret('SMTP_USER');
  const info = await transport.sendMail({ from: fromAddress, to, subject, text, html });
  return { messageId: info.messageId };
}

// --- Worker Lifecycle Management ---

let worker;
let connection;
let transport;

async function start() {
  logger.info('[EmailWorker] Starting...');

  // 1. Initialize SMTP Transport
  try {
    const host = getSecret('SMTP_HOST');
    const port = parseInt(getSecret('SMTP_PORT') || '587', 10);
    const user = getSecret('SMTP_USER');
    const pass = getSecret('SMTP_PASS') || getSecret('SMTP_PASSWORD');

    if (host && user && pass) {
      transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
      // Verify connection and credentials
      await transport.verify();
      logger.info('[EmailWorker] SMTP transport connected and verified.');
    } else {
      logger.warn('[EmailWorker] SMTP not configured. Will run in mock mode.');
    }
  } catch (err) {
    logger.error('[EmailWorker] Could not initialize SMTP transport. Worker will not start.', err);
    // Fail fast if email is critical for your application
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }

  // 2. Initialize Redis Connection and Worker
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || null;
  if (process.env.NODE_ENV === 'production') {
    const hasPasswordInUrl = typeof redisUrl === 'string' && /^redis(s)?:\/\//i.test(redisUrl) && /:\\S+@/.test(redisUrl);
    const hasExplicitPassword = !!process.env.REDIS_PASSWORD;
    if (!hasPasswordInUrl && !hasExplicitPassword) {
      logger.error('[EmailWorker] Unsafe Redis configuration for production: authentication required');
      process.exit(1);
    }
  }
  connection = redisUrl ? new IORedis(redisUrl, { maxRetriesPerRequest: null, password: process.env.REDIS_PASSWORD || undefined })
                        : new IORedis({
                            host: process.env.REDIS_HOST || '127.0.0.1',
                            port: parseInt(process.env.REDIS_PORT || '6379', 10),
                            password: process.env.REDIS_PASSWORD || undefined,
                            maxRetriesPerRequest: null,
                          });

  worker = new Worker(
    QUEUE_NAME,
    (job) => processJob(job, transport), // Pass the transport to the processor
    { connection }
  );

  worker.on('completed', (job, result) => {
    logger.info({ message: 'Job completed', queue: QUEUE_NAME, jobId: job.id, result });
  });

  worker.on('failed', (job, err) => {
    logger.error({ message: 'Job failed', queue: QUEUE_NAME, jobId: job?.id, error: err?.message, stack: err?.stack });
  });

  worker.on('error', (err) => {
    logger.error('[EmailWorker] Worker error', err);
  });

  logger.info('[EmailWorker] Worker started and is listening for jobs.');
}

async function shutdown() {
  logger.info('[EmailWorker] Shutting down...');
  try { if (worker) await worker.close(); } catch (e) { logger.error('[EmailWorker] Error closing worker', e); }
  try { if (transport) transport.close(); } catch (e) { logger.error('[EmailWorker] Error closing transport', e); }
  try { if (connection) await connection.quit(); } catch (e) { logger.error('[EmailWorker] Error closing Redis', e); }
  logger.info('[EmailWorker] Shutdown complete.');
}

// Graceful shutdown handling
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
