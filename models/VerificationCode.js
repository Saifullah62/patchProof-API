// models/VerificationCode.js
const mongoose = require('mongoose');

const VerificationCodeSchema = new mongoose.Schema({
  identifier: { type: String, required: true, index: true },
  // Store only a secure hash of the verification code.
  codeHash: { type: String, required: true },
  // TTL index auto-removes after 15 minutes
  createdAt: { type: Date, default: Date.now, expires: '15m' },
});

module.exports = mongoose.model('VerificationCode', VerificationCodeSchema);
