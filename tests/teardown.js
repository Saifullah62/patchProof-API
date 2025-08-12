// tests/teardown.js
// Global Jest teardown: close shared resources (DB, Redis lock manager, etc.)
const { closeDb } = require('../config/db');
const lockManager = require('../services/lockManager');

module.exports = async () => {
  try {
    await closeDb();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Jest teardown] Error closing DB:', err && err.message);
  }

  try {
    if (lockManager && lockManager.redisClient && typeof lockManager.redisClient.quit === 'function') {
      await lockManager.redisClient.quit();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Jest teardown] Error closing Redis client:', err && err.message);
  }
};
