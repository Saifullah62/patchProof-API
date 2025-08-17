// models/PatchState.js
const mongoose = require('mongoose');

const PatchStateSchema = new mongoose.Schema(
  {
    uid_tag_id: {
      type: String,
      required: true,
      unique: true, // unique index implicitly created
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
      index: true,
    },
  },
  {
    // Enable full timestamps and optimistic concurrency control
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: 'version',
  }
);

// Indexes to speed up lookups and recent activity queries
// Unique on uid_tag_id is created automatically by the schema
// current_owner_address already has a path-level index: true
PatchStateSchema.index({ updated_at: -1 });

module.exports = mongoose.model('PatchState', PatchStateSchema);
