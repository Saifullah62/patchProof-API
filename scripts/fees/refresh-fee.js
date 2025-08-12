#!/usr/bin/env node
// scripts/fees/refresh-fee.js
// Set or fetch a recommended sat/kB fee and persist to Settings (key=FEE_PER_KB).

require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

let Settings;
try { Settings = require('../../models/Settings'); } catch (_) { /* optional */ }

function usage() {
  console.log(`Usage:
  node scripts/fees/refresh-fee.js --set <satPerKb>
  node scripts/fees/refresh-fee.js --from-url <url>

Notes:
  - Persists FEE_PER_KB in the Settings collection.
  - --from-url expects JSON with { feePerKb: number }.
`);
}

function getMongoUri() {
  return process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/patchproof';
}

async function upsertSetting(key, value) {
  if (!Settings) throw new Error('Settings model not available');
  await Settings.updateOne({ key }, { $set: { value } }, { upsert: true });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    usage();
    process.exit(0);
  }

  const setIdx = args.indexOf('--set');
  const fromIdx = args.indexOf('--from-url');

  let feePerKb;
  if (setIdx !== -1 && args[setIdx + 1]) {
    feePerKb = parseInt(args[setIdx + 1], 10);
    if (!Number.isFinite(feePerKb) || feePerKb <= 0) throw new Error('Invalid --set value');
  } else if (fromIdx !== -1 && args[fromIdx + 1]) {
    const url = args[fromIdx + 1];
    const res = await axios.get(url, { timeout: 10000 });
    feePerKb = parseInt(res.data && (res.data.feePerKb ?? res.data.fee_per_kb), 10);
    if (!Number.isFinite(feePerKb) || feePerKb <= 0) throw new Error('Invalid fee from URL');
  } else {
    usage();
    process.exit(2);
  }

  const uri = getMongoUri();
  const dbName = process.env.MONGODB_DB || 'patchproof';
  await mongoose.connect(uri, { dbName });
  try {
    await upsertSetting('FEE_PER_KB', feePerKb);
    console.log(`Updated Settings.FEE_PER_KB = ${feePerKb}`);
    process.exit(0);
  } catch (e) {
    console.error('Failed to update fee:', e.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
