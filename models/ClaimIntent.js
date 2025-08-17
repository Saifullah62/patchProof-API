// models/ClaimIntent.js
const mongoose = require('mongoose');

const ClaimIntentSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, index: true },
    customer: {
      address: { type: String, required: true },
      userId: { type: String, required: true },
      pubKey: { type: String, required: true }, // compressed hex
    },
    // Canonical challenge components
    ts: { type: Number, required: true },
    nonce: { type: String, required: true },
    signature: { type: String, required: true }, // DER-hex over canonical string

    // Lifecycle
    status: { type: String, enum: ['pending', 'approved', 'confirmed', 'failed', 'expired'], default: 'pending', index: true },
    error: { type: String, default: null },

    // Approval metadata
    approvedBy: { type: String, default: null },
    approved_at: { type: Date, default: null },

    // Transfer linkage
    transfer_pending_id: { type: String, default: null },
    txid: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

ClaimIntentSchema.index({ created_at: -1 });

module.exports = mongoose.model('ClaimIntent', ClaimIntentSchema);
