// services/jobService.js
// A robust, production-grade service for managing background jobs with BullMQ.
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const logger = require('../logger');

class JobService {
  constructor() {
    this.redisConnection = null;
    this.queues = {};
    this.isReady = false;
  }

  // Initializes the Redis connection and queues. Call at app startup.
  async initialize() {
    if (this.isReady) {
      logger.info('[JobService] Already initialized.');
      return;
    }

    if (!this.isEnabled()) {
      logger.warn('[JobService] Asynchronous jobs are disabled. Service will not connect to Redis.');
      this.isReady = true; // Ready in a disabled state.
      return;
    }

    const redisUrl = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || 'redis://127.0.0.1:6379';
    // Enforce authenticated Redis in production
    if (process.env.NODE_ENV === 'production') {
      const hasPasswordInUrl = typeof redisUrl === 'string' && /^redis(s)?:\/\//i.test(redisUrl) && /:\\S+@/.test(redisUrl);
      const hasExplicitPassword = !!process.env.REDIS_PASSWORD;
      if (!hasPasswordInUrl && !hasExplicitPassword) {
        logger.error('[JobService] In production, Redis must require authentication. Provide REDIS_URL with password (redis://:pass@host:6379) or REDIS_PASSWORD.');
        throw new Error('Unsafe Redis configuration for production: authentication required');
      }
    }
    try {
      this.redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null, password: process.env.REDIS_PASSWORD || undefined });
      this.redisConnection.on('connect', () => logger.info('[JobService] Connecting to Redis for BullMQ...'));
      this.redisConnection.on('ready', () => {
        logger.info('[JobService] Redis connection for BullMQ is ready.');
        this.isReady = true;
      });
      this.redisConnection.on('error', (err) => logger.error('[JobService] BullMQ Redis connection error:', err));

      // Dedicated queues for separation of concerns
      this.queues.broadcast = new Queue('broadcast', { connection: this.redisConnection });
      this.queues.email = new Queue('email', { connection: this.redisConnection });

      logger.info('[JobService] All message queues initialized.');
    } catch (err) {
      logger.error('[JobService] Failed to initialize Redis connection for jobs.', err);
      this.isReady = false;
      throw err;
    }
  }

  isEnabled() {
    const v = process.env.JOBS_ASYNC || '';
    return ['1', 'true'].includes(v.toLowerCase());
  }

  // Graceful shutdown for queues and Redis
  async close() {
    if (!this.isEnabled()) return;
    if (!this.redisConnection) return;
    logger.info('[JobService] Closing all message queues and Redis connection...');
    try {
      await Promise.all(Object.values(this.queues).map((q) => q.close()));
    } finally {
      await this.redisConnection.quit();
    }
    logger.info('[JobService] All connections closed.');
  }

  _getQueue(name) {
    if (!this.isEnabled()) {
      logger.warn(`[JobService] Jobs are disabled, attempted to use queue: ${name}.`);
      return null;
    }
    if (!this.isReady) {
      throw new Error('JobService is not ready. Call initialize() at startup.');
    }
    const q = this.queues[name];
    if (!q) throw new Error(`Unknown queue: ${name}`);
    return q;
  }

  async addBroadcastJob(payload) {
    const q = this._getQueue('broadcast');
    if (!q) return null;
    // More specific job name for registrations
    const job = await q.add('registration', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    return job.id;
  }

  async addTransferJob(payload) {
    const q = this._getQueue('broadcast');
    if (!q) return null;
    const job = await q.add('transfer', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    return job.id;
  }

  async addEmailJob(payload) {
    const q = this._getQueue('email');
    if (!q) return null;
    const job = await q.add('send-email', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
    });
    return job.id;
  }
}

module.exports = new JobService();
