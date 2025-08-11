// scripts/addUtxo.js
require('dotenv').config();

// If your project exposes db helpers elsewhere, adjust these imports accordingly
let initDb, closeDb;
try {
  ({ initDb, closeDb } = require('../config/db'));
} catch (e) {
  // Fallback: connect via mongoose directly using MONGODB_URI
  const mongoose = require('mongoose');
  initDb = async () => {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/patchproof';
    await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || 'patchproof' });
  };
  closeDb = async () => {
    const mongoose = require('mongoose');
    await mongoose.connection.close();
  };
}

const utxoService = require('../services/utxoService');

async function main() {
  await initDb();

  const utxoData = {
    txid: process.env.UTXO_TXID || 'YOUR_FUNDING_TXID',
    vout: Number(process.env.UTXO_VOUT ?? 0),
    satoshis: Number(process.env.UTXO_SATOSHIS ?? 100000),
    scriptPubKey: process.env.UTXO_SCRIPT_PUB_KEY || 'YOUR_SCRIPT_PUB_KEY_HEX',
    privKeyWIF: process.env.UTXO_PRIVKEY_WIF || 'YOUR_PRIVATE_KEY_IN_WIF',
  };

  await utxoService.addUtxo(utxoData);
  // eslint-disable-next-line no-console
  console.log('UTXO added successfully!', { txid: utxoData.txid, vout: utxoData.vout });

  await closeDb();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to add UTXO:', err);
  try { await closeDb(); } catch (_) {}
  process.exit(1);
});
