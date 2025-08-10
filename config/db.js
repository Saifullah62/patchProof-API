// config/db.js
const mongoose = require('mongoose');
const logger = require('../logger');
const { getSecret } = require('../secrets');

let mongoServer = null;

async function initDb() {
  if (mongoose.connection.readyState === 1) return;

  let uri = getSecret('MONGODB_URI') || process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'patchproof_prod';

  if (process.env.NODE_ENV === 'test' && !uri) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    logger.info('[DB] Starting MongoMemoryServer for tests...');
    mongoServer = await MongoMemoryServer.create();
    uri = mongoServer.getUri();
  }

  if (!uri) {
    throw new Error('Database connection string is missing (MONGODB_URI).');
  }

  try {
    await mongoose.connect(uri, { dbName });
    logger.info(`[DB] Connected to MongoDB (dbName=${dbName}).`);
  } catch (err) {
    logger.error('[DB] Failed to connect to MongoDB.', err);
    throw err;
  }
}

async function closeDb() {
  try {
    await mongoose.disconnect();
    logger.info('[DB] Mongoose connection disconnected.');
    if (mongoServer) {
      await mongoServer.stop();
      logger.info('[DB] MongoMemoryServer stopped.');
    }
  } catch (err) {
    logger.error('[DB] Error during database disconnection.', err);
  }
}

module.exports = { initDb, closeDb };
