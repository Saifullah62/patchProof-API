// models/PatchState.js
const mongoose = require('mongoose');

const PatchStateSchema = new mongoose.Schema(
  {
    uid_tag_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Transaction ID representing the current UTXO/state
    current_txid: {
      type: String,
      required: true,
      unique: true,
    },
    current_owner_address: {
      type: String,
      required: true,
    },
  },
  { timestamps: { createdAt: false, updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('PatchState', PatchStateSchema);
