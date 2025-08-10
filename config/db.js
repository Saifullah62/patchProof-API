// config/db.js
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const logger = require('../logger');
const { getSecret } = require('../secrets');

let mongoServer = null;

async function initDb() {
  if (mongoose.connection.readyState === 1) {
    return; // already connected
  }

  let uri = getSecret('DATABASE_URL') || process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'patchproof_prod';

  if (process.env.NODE_ENV === 'test' && !uri) {
    logger.info('[DB] NODE_ENV=test and no MONGODB_URI provided. Starting MongoMemoryServer...');
    mongoServer = await MongoMemoryServer.create();
    uri = mongoServer.getUri();
    logger.info('[DB] MongoMemoryServer started.');
  }

  if (!uri) {
    logger.error('[DB] Database connection string is not defined.');
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
    throw new Error('Database connection string is missing.');
  }

  try {
    await mongoose.connect(uri, {
      dbName,
    });
    logger.info(`[DB] Connected to MongoDB (dbName=${dbName}).`);
  } catch (err) {
    logger.error('[DB] Failed to connect to MongoDB.', err);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
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
      mongoServer = null;
    }
  } catch (err) {
    logger.error('[DB] Error during database disconnection.', err);
  }
}

module.exports = { initDb, closeDb };
