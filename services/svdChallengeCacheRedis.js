// services/svdChallengeCacheRedis.js
// A robust, Redis-backed cache for SVD challenges with a managed lifecycle.
const IORedis = require('ioredis');
const logger = require('../logger');

const DEFAULT_TTL_SEC = parseInt(process.env.SVD_CHALLENGE_TTL_SEC || '180', 10);

class SvdChallengeCache {
  constructor() {
    this.redisClient = null;
    this.isReady = false;
  }

  // Initializes the Redis connection. Must be called at application startup.
  async initialize() {
    if (this.isReady) {
      logger.info('[SvdChallengeCache] Already initialized.');
      return;
    }

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.error('[SvdChallengeCache] FATAL: REDIS_URL is not configured. This service cannot operate.');
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
        logger.error('[SvdChallengeCache] In production, Redis must require authentication. Provide REDIS_URL with password (redis://:pass@host:6379) or REDIS_PASSWORD.');
        process.exit(1);
      }
    }

    try {
      this.redisClient = new IORedis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        password: process.env.REDIS_PASSWORD || undefined,
        reconnectOnError: (err) => {
          const targetError = 'READONLY';
          return err && typeof err.message === 'string' && err.message.includes(targetError);
        },
      });

      this.redisClient.on('connect', () => logger.info('[SvdChallengeCache] Connecting to Redis...'));
      this.redisClient.on('ready', () => {
        this.isReady = true;
        logger.info('[SvdChallengeCache] Redis connection is ready.');
      });
      this.redisClient.on('error', (err) => logger.error('[SvdChallengeCache] Redis connection error:', err));
    } catch (err) {
      logger.error('[SvdChallengeCache] Failed to initialize Redis connection.', err);
      this.isReady = false;
      throw err;
    }
  }

  // Gracefully closes the Redis connection.
  async close() {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.isReady = false;
      logger.info('[SvdChallengeCache] Redis connection closed.');
    }
  }

  _key(userId) {
    return `svd:challenge:${String(userId)}`;
  }

  async set(userId, mHex, ttlSec = DEFAULT_TTL_SEC) {
    if (!this.isReady) throw new Error('SvdChallengeCache is not ready.');
    await this.redisClient.set(this._key(userId), mHex, 'EX', ttlSec);
  }

  async get(userId) {
    if (!this.isReady) throw new Error('SvdChallengeCache is not ready.');
    return this.redisClient.get(this._key(userId));
  }
}

module.exports = new SvdChallengeCache();
