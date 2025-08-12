// models/SvdRegistry.js
const mongoose = require('mongoose');

const SvdRegistrySchema = new mongoose.Schema(
  {
    // Link to your main User model
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true, unique: true },
    // User's registered master public key (compressed SEC hex, 33 bytes)
    pmcHex: { type: String, required: true },
    // Optional key identifier for rotation/observability
    keyId: {
      type: String,
      required: true,
      default: () => new mongoose.Types.ObjectId().toHexString(),
    },
    // Allow soft-disable/revocation
    revoked: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SvdRegistry', SvdRegistrySchema);
