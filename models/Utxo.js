// models/Utxo.js
const mongoose = require('mongoose');

const UtxoSchema = new mongoose.Schema({
  txid: {
    type: String,
    required: true,
  },
  vout: {
    type: Number,
    required: true,
  },
  satoshis: {
    type: Number,
    required: true,
  },
  scriptPubKey: {
    type: String,
    required: true,
  },
  privKeyWIF: {
    type: String, // Each UTXO has its own private key for signing
    required: true,
  },
  status: {
    type: String,
    enum: ['available', 'locked', 'spent'],
    default: 'available',
    index: true, // Index for efficient querying of available UTXOs
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Ensure that each UTXO (txid + vout) is unique
UtxoSchema.index({ txid: 1, vout: 1 }, { unique: true });

module.exports = mongoose.model('Utxo', UtxoSchema);
