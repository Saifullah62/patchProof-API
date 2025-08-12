// models/AuthenticationRecord.js
const mongoose = require('mongoose');

// --- Explicit Sub-Schema for record_data ---
// Replaces the insecure 'Mixed' type to enforce data integrity and enable efficient querying.
const RecordDataSchema = new mongoose.Schema({
  type: { type: String, required: true, default: 'AUTHENTICATION_RECORD' },
  product: {
    type: {
      uid_tag_id: { type: String, required: true },
      name: String,
      // Add other known product fields here
    },
    required: true,
    _id: false,
  },
  metadata: {
    type: {
      notes: String,
      image: String,
      // Add other known metadata fields here
    },
    default: {},
    _id: false,
  },
  auth: {
    type: {
      owner: { type: String, index: true },
      issuer_signature: { type: String, required: true },
      issuer_pubkey: { type: String, required: true },
      ts: { type: Number, required: true },
      txid: String,
      merkleRoot: String,
      merklePath: [String],
      anchorTxid: String,
    },
    required: true,
    _id: false,
  },
}, { _id: false });

const AuthenticationRecordSchema = new mongoose.Schema(
  {
    txid: {
      type: String,
      // Optional at creation; becomes unique once set after confirmation
      unique: true,
      sparse: true,
      index: true,
    },
    uid_tag_id: {
      type: String,
      required: true,
      // Covered by compound index below
    },
    // Distinguish registration vs transfer events
    type: {
      type: String,
      required: true,
      enum: ['REGISTRATION', 'TRANSFER'],
      index: true,
    },
    // For transfers, link to previous record's txid
    previous_txid: {
      type: String,
      required: function () { return this.type === 'TRANSFER'; },
      index: true,
    },
    // --- Status field for atomic processing ---
    status: {
      type: String,
      required: true,
      enum: ['pending', 'confirmed', 'failed'],
      default: 'pending',
      index: true,
    },
    // Store the well-defined record data.
    record_data: {
      type: RecordDataSchema,
      required: true,
    },
    block_height: {
      type: Number,
      default: null,
    },
    failure_reason: {
      type: String,
    },
    // Optional background job tracking id
    job_id: {
      type: String,
      default: null,
    },
  },
  {
    // Enable createdAt and updatedAt
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// Additional indexes for common access patterns
AuthenticationRecordSchema.index({ uid_tag_id: 1, created_at: -1 });
AuthenticationRecordSchema.index({ created_at: -1 });

module.exports = mongoose.model('AuthenticationRecord', AuthenticationRecordSchema);
