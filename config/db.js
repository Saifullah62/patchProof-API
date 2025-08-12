// config/db.js
const mongoose = require('mongoose');
const logger = require('../logger');
const { getSecret } = require('../secrets');

let mongoServer = null;

// Helper function for retries with exponential backoff
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Basic check for presence of credentials in MongoDB URI
// Accepts forms like:
// - mongodb://user:pass@host/db
// - mongodb+srv://user:pass@cluster/db
// Note: This is a sanity check; actual auth is enforced by MongoDB server.
function hasAuthInMongoUri(uri) {
  try {
    if (typeof uri !== 'string') return false;
    // Quick allow-list: if SRV/standard with user:pass@
    if (/^mongodb(\+srv)?:\/\//i.test(uri) && /:\S+@/.test(uri)) return true;
    return false;
  } catch (_) { return false; }
}

async function initDb() {
  if (mongoose.connection.readyState === 1) {
    logger.info('[DB] Connection already established.');
    return;
  }

  let uri = getSecret('MONGODB_URI') || process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'patchproof_prod';

  if (process.env.NODE_ENV === 'test' && !uri) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    logger.info('[DB] Starting MongoMemoryServer for tests...');
    mongoServer = await MongoMemoryServer.create();
    uri = mongoServer.getUri();
  }

  if (!uri) {
    logger.error('[DB] Database connection string is missing (MONGODB_URI).');
    throw new Error('Database connection string is missing (MONGODB_URI).');
  }

  // Enforce authenticated connections in production
  if ((process.env.NODE_ENV === 'production') && !hasAuthInMongoUri(uri)) {
    logger.error('[DB] In production, MONGODB_URI must include credentials (mongodb://user:pass@host/...).');
    throw new Error('Unsafe MongoDB configuration: credentials required in MONGODB_URI for production.');
  }

  // --- Production-Ready Connection Options ---
  // Sourced from environment variables with sensible defaults.
  const options = {
    dbName,
    serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS, 10) || 5000,
    connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 10000,
    socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS, 10) || 45000,
    heartbeatFrequencyMS: parseInt(process.env.DB_HEARTBEAT_FREQUENCY_MS, 10) || 10000,
  };

  // --- Connection Retry Logic ---
  const maxRetries = 5;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      logger.info(`[DB] Attempting to connect to MongoDB (attempt ${attempt + 1}/${maxRetries})...`);
      await mongoose.connect(uri, options);
      logger.info(`[DB] Connected to MongoDB (dbName=${dbName}).`);

      // --- Connection Event Listeners ---
      mongoose.connection.on('error', (err) => {
        logger.error('[DB] MongoDB connection error:', err);
      });
      mongoose.connection.on('disconnected', () => {
        logger.warn('[DB] MongoDB disconnected.');
      });
      mongoose.connection.on('reconnected', () => {
        logger.info('[DB] MongoDB reconnected.');
      });

      return; // Success, exit the loop
    } catch (err) {
      attempt++;
      logger.error(`[DB] Failed to connect to MongoDB on attempt ${attempt}.`, err.message);
      if (attempt >= maxRetries) {
        logger.error('[DB] All connection attempts failed. Exiting.');
        throw err; // Re-throw the last error to fail the startup
      }
      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
      logger.info(`[DB] Retrying connection in ${delay / 1000} seconds...`);
      await sleep(delay);
    }
  }
}

async function closeDb() {
  try {
    // Check readyState before attempting to disconnect
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        logger.info('[DB] Mongoose connection disconnected.');
    }
    if (mongoServer) {
      await mongoServer.stop();
      logger.info('[DB] MongoMemoryServer stopped.');
      mongoServer = null; // Clean up reference
    }
  } catch (err) {
    logger.error('[DB] Error during database disconnection.', err);
  }
}

module.exports = { initDb, closeDb };