// models/Settings.js
const mongoose = require('mongoose');

// Generic key-value schema for application settings
const SettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

module.exports = mongoose.model('Settings', SettingsSchema);
