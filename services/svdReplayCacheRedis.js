// services/svdReplayCacheRedis.js
// A robust, Redis-only cache for preventing SVD replay attacks.
const IORedis = require('ioredis');
const logger = require('../logger');

const DEFAULT_TTL_SEC = (parseInt(process.env.SVD_CHALLENGE_TTL_SEC, 10) || 180) * 2; // Keep replay records longer

class SvdReplayCache {
  constructor() {
    this.redisClient = null;
    this.isReady = false;
  }

  // Initializes the Redis connection. Must be called at application startup.
  async initialize() {
    if (this.isReady) {
      logger.info('[SvdReplayCache] Already initialized.');
      return;
    }

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.error('[SvdReplayCache] FATAL: REDIS_URL is not configured. This service cannot operate.');
      if (process.env.NODE_ENV === 'production') {
        process.exit(1);
      }
      this.isReady = false;
      return;
    }

    // Enforce authenticated Redis in production
    if (process.env.NODE_ENV === 'production') {
      const hasPasswordInUrl = typeof redisUrl === 'string' && /^redis(s)?:\/\//i.test(redisUrl) && /:\\S+@/.test(redisUrl);
      const hasExplicitPassword = !!process.env.REDIS_PASSWORD;
      if (!hasPasswordInUrl && !hasExplicitPassword) {
        logger.error('[SvdReplayCache] In production, Redis must require authentication. Provide REDIS_URL with password (redis://:pass@host:6379) or REDIS_PASSWORD.');
        process.exit(1);
      }
    }

    try {
      this.redisClient = new IORedis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        password: process.env.REDIS_PASSWORD || undefined,
      });

      this.redisClient.on('connect', () => logger.info('[SvdReplayCache] Connecting to Redis...'));
      this.redisClient.on('ready', () => {
        this.isReady = true;
        logger.info('[SvdReplayCache] Redis connection is ready.');
      });
      this.redisClient.on('error', (err) => logger.error('[SvdReplayCache] Redis connection error:', err));
    } catch (err) {
      logger.error('[SvdReplayCache] Failed to initialize Redis connection.', err);
      this.isReady = false;
      throw err;
    }
  }

  // Gracefully closes the Redis connection.
  async close() {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.isReady = false;
      logger.info('[SvdReplayCache] Redis connection closed.');
    }
  }

  _getKey(jtiHex) { return `svd:jti:${jtiHex}`; }

  // Atomically add JTI if not exists; returns true if added (not replay), false if exists (replay)
  async addIfNotExists(jtiHex, ttlSec = DEFAULT_TTL_SEC) {
    if (!this.isReady) {
      logger.error('[SvdReplayCache] Cannot check for replay: Redis is not connected.');
      return false; // fail closed for security sensitive path
    }
    const result = await this.redisClient.set(this._getKey(jtiHex), '1', 'EX', ttlSec, 'NX');
    return result === 'OK';
  }
}

module.exports = new SvdReplayCache();
