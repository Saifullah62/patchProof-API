// models/VerificationCode.js
const mongoose = require('mongoose');

const VerificationCodeSchema = new mongoose.Schema({
  identifier: { type: String, required: true, index: true },
  code: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: '15m' }, // TTL index
});

module.exports = mongoose.model('VerificationCode', VerificationCodeSchema);
