// services/lockManager.js
const { createClient } = require('redis');
const crypto = require('crypto');
const logger = require('../logger');

class LockManager {
  constructor() {
    this.redisClient = null;
    this.isReady = false;
  }

  /**
   * Initialize a shared Redis client with retry/backoff.
   * Must be awaited during application startup before using locks.
   */
  async initialize() {
    if (this.isReady && this.redisClient) {
      logger.info('[LockManager] Redis client is already initialized.');
      return;
    }

    const url = process.env.REDIS_URL || process.env.REDIS_ENDPOINT || process.env.REDIS_HOST || 'redis://localhost:6379';
    logger.info(`[LockManager] Initializing Redis client at ${url}...`);

    this.redisClient = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
      },
    });

    this.redisClient.on('error', (err) => {
      logger.error('[LockManager] Redis Client Error', err);
      this.isReady = false;
    });
    this.redisClient.on('ready', () => {
      this.isReady = true;
      logger.info('[LockManager] Redis client is ready.');
    });

    try {
      await this.redisClient.connect();
    } catch (err) {
      logger.error('[LockManager] Failed to connect to Redis during initialize()', err);
      this.isReady = false;
    }
  }

  /**
   * Acquire a distributed lock.
   * @param {string} lockName
   * @param {number} ttlMs
   * @returns {Promise<string|null>} lock token if acquired, else null
   */
  async acquireLock(lockName, ttlMs = 30000) {
    if (!this.isReady || !this.redisClient) {
      logger.error('[LockManager] Cannot acquire lock: Redis not connected.');
      return null;
    }
    const key = `lock:${lockName}`;
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const res = await this.redisClient.set(key, token, { NX: true, PX: ttlMs });
      return res === 'OK' ? token : null;
    } catch (err) {
      logger.error(`[LockManager] Failed to acquire lock for ${lockName}`, err);
      return null;
    }
  }

  /**
   * Release a lock only if the token matches (atomic via Lua script).
   * @param {string} lockName
   * @param {string} token
   * @returns {Promise<boolean>} true if released
   */
  async releaseLock(lockName, token) {
    if (!this.isReady || !this.redisClient || !token) return false;
    const key = `lock:${lockName}`;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      const result = await this.redisClient.eval(script, { keys: [key], arguments: [token] });
      return result === 1;
    } catch (err) {
      logger.error(`[LockManager] Failed to release lock for ${lockName}`, err);
      return false;
    }
  }

  /**
   * Helper to run a critical section guarded by a lock.
   */
  async withLock(lockName, ttlMs, fn) {
    const token = await this.acquireLock(lockName, ttlMs);
    if (!token) return { ok: false, error: 'LOCK_NOT_ACQUIRED' };
    try {
      const result = await fn();
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e };
    } finally {
      try { await this.releaseLock(lockName, token); } catch (_) {}
    }
  }
}

module.exports = new LockManager();
