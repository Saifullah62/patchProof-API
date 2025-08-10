// models/AuthenticationRecord.js
const mongoose = require('mongoose');

const AuthenticationRecordSchema = new mongoose.Schema(
  {
    txid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    uid_tag_id: {
      type: String,
      required: true,
      index: true,
    },
    // Full immutable AUTHENTICATION_RECORD JSON stored on-chain
    record_data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    block_height: {
      type: Number,
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

module.exports = mongoose.model('AuthenticationRecord', AuthenticationRecordSchema);
