#!/usr/bin/env node
// scripts/check-health.js
// A robust, production-grade health check script that outputs structured JSON.
require('dotenv').config();

const { initDb, closeDb } = require('../config/db');
const lockManager = require('../services/lockManager'); // For Redis check
const wocClient = require('../clients/wocClient'); // Robust API client
const Utxo = require('../models/Utxo');
const logger = require('../logger');

const REQUIRED_ENV_VARS = [
  'API_KEY',
  'JWT_SECRET',
  'MASTER_SECRET',
  'MONGODB_URI',
  'REDIS_URL',
  'UTXO_FEE_PER_BYTE',
  'UTXO_CHANGE_ADDRESS',
  // KMS-backed signing required in production
  'KMS_SIGN_URL',
  'KMS_API_KEY',
  'ISSUER_KEY_IDENTIFIER',
];


async function runHealthCheck() {
  const results = {
    overallStatus: 'PASS',
    timestamp: new Date().toISOString(),
    checks: [],
  };

  const addCheck = (name, status, details) => {
    results.checks.push({ name, status, details });
    if (status === 'FAIL') results.overallStatus = 'FAIL';
  };

  // 1. Environment Variables Check
  logger.info('Checking environment variables...');
  let envOk = true;
  for (const v of REQUIRED_ENV_VARS) {
    if (!process.env[v]) {
      envOk = false;
      logger.error(`Required environment variable "${v}" is not set.`);
    }
  }
  addCheck('Environment Variables', envOk ? 'PASS' : 'FAIL', `Checked ${REQUIRED_ENV_VARS.length} required variables (KMS + issuer id).`);

  // Initialize WOC client before any usage
  try {
    wocClient.initialize();
    addCheck('WOC Client Init', 'PASS', 'WocClient initialized');
  } catch (err) {
    addCheck('WOC Client Init', 'FAIL', `Initialization failed: ${err.message}`);
  }

  // 2. MongoDB Connection Check
  logger.info('Checking MongoDB connection...');
  try {
    await initDb();
    addCheck('MongoDB Connection', 'PASS', 'Successfully connected to MongoDB.');
  } catch (err) {
    addCheck('MongoDB Connection', 'FAIL', `Could not connect to MongoDB: ${err.message}`);
    return results; // Abort further checks if DB is down
  }

  // 3. Redis Connection Check
  logger.info('Checking Redis connection...');
  try {
    await lockManager.initialize();
    if (lockManager.isReady) {
      addCheck('Redis Connection', 'PASS', 'Successfully connected to Redis.');
    } else {
      addCheck('Redis Connection', 'FAIL', 'Redis client is not ready.');
    }
  } catch (err) {
    addCheck('Redis Connection', 'FAIL', `Could not connect to Redis: ${err.message}`);
  }

  // 4. UTXO Pool Health Check
  logger.info('Checking UTXO funding pool...');
  try {
    const availableUtxos = await Utxo.find({ status: 'available' }).lean();
    if (availableUtxos.length === 0) {
      addCheck('UTXO Pool Availability', 'FAIL', 'No available UTXOs found in the database.');
    } else {
      addCheck('UTXO Pool Availability', 'PASS', `Found ${availableUtxos.length} available UTXO(s).`);
      for (const utxo of availableUtxos) {
        const isSpent = await wocClient.isUtxoSpent(utxo.txid, utxo.vout);
        if (isSpent) {
          addCheck(`UTXO On-Chain Status (${utxo.txid}:${utxo.vout})`, 'FAIL', 'UTXO is spent on-chain but marked as available in DB.');
        } else {
          addCheck(`UTXO On-Chain Status (${utxo.txid}:${utxo.vout})`, 'PASS', 'UTXO is confirmed unspent.');
        }
      }
    }
  } catch (err) {
    addCheck('UTXO Pool Health', 'FAIL', `Error checking UTXO pool: ${err.message}`);
  }

  await closeDb();
  return results;
}

(async () => {
  let results;
  try {
    results = await runHealthCheck();
  } catch (err) {
    results = {
      overallStatus: 'FAIL',
      timestamp: new Date().toISOString(),
      error: 'Health check script crashed unexpectedly.',
      details: err.message,
    };
    process.exitCode = 1;
  }

  // Output as JSON for machine-readability
  console.log(JSON.stringify(results, null, 2));

  if (results.overallStatus === 'FAIL') {
    process.exitCode = 1;
  }
})();
