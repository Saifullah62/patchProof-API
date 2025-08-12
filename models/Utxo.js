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
  // Secure: do not store raw private keys. Use a stable key identifier.
  keyIdentifier: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['unconfirmed', 'available', 'locked', 'spent'],
    default: 'available',
    index: true,
  },
  lockId: {
    type: String,
    default: null,
  },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: 'version',
});

// Ensure that each UTXO (txid + vout) is unique
UtxoSchema.index({ txid: 1, vout: 1 }, { unique: true });
// Speed up selection queries by status/keyIdentifier/satoshis (descending for greedy picks)
UtxoSchema.index({ status: 1, keyIdentifier: 1, satoshis: -1 });

module.exports = mongoose.model('Utxo', UtxoSchema);
