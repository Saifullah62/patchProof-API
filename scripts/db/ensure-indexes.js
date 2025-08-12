#!/usr/bin/env node
// scripts/db/ensure-indexes.js
// Dynamically loads all models and ensures their MongoDB indexes are created.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../../logger');
const { initDb, closeDb } = require('../../config/db');

(async () => {
  try {
    await initDb();
    const modelsDir = path.join(__dirname, '..', '..', 'models');

    logger.info(`[DB] Scanning for models in: ${modelsDir}`);

    const modelFiles = fs.readdirSync(modelsDir).filter(file => file.endsWith('.js'));

    if (modelFiles.length === 0) {
      logger.warn('[DB] No model files found. Nothing to do.');
      await closeDb();
      process.exit(0);
    }

    // Use a for...of loop to process models sequentially.
    for (const file of modelFiles) {
      const modelPath = path.join(modelsDir, file);
      try {
        const Model = require(modelPath);
        // Mongoose automatically registers models, so we can get the name.
        const modelName = Model.modelName;

        if (modelName) {
          logger.info(`[DB] Ensuring indexes for model: ${modelName}...`);
          // syncIndexes is the modern replacement for ensureIndexes
          await Model.syncIndexes();
          logger.info(`[DB] Indexes for ${modelName} are in sync.`);
        } else {
          logger.warn(`[DB] File ${file} does not appear to be a valid Mongoose model, skipping.`);
        }
      } catch (modelErr) {
        logger.error(`[DB] Failed to process model file ${file}.`, modelErr);
        // Decide if you want to continue or exit on a single model failure.
        // For production, it's safer to exit.
        throw modelErr;
      }
    }

    logger.info('[DB] Index ensure completed successfully.');
  } catch (err) {
    logger.error('[DB] Index ensure script failed.', err);
  } finally {
    // Ensure the database connection is always closed.
    await closeDb();
    process.exit(err ? 1 : 0);
  }
})();