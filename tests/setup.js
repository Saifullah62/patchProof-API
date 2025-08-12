// tests/setup.js
// Global Jest setup: initialize shared resources (DB, Redis lock manager, etc.)
const { initDb } = require('../config/db');
const lockManager = require('../services/lockManager');

module.exports = async () => {
  // Ensure test environment
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';

  // Some CI providers have very fast CPUs; keep Jest timers stable
  process.env.TZ = process.env.TZ || 'UTC';

  // Initialize MongoDB (uses in-memory server if no MONGODB_URI in test)
  await initDb();

  // Initialize Redis-based lock manager if REDIS_URL provided
  if (process.env.REDIS_URL || process.env.REDIS_ENDPOINT || process.env.REDIS_HOST) {
    try {
      await lockManager.initialize();
    } catch (err) {
      // In tests, we don't fail the entire suite if Redis is absent; individual tests can skip.
      // eslint-disable-next-line no-console
      console.warn('[Jest setup] LockManager initialize failed (tests will continue):', err && err.message);
    }
  }
};
