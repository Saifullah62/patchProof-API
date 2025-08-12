// services/configService.js
// Lightweight cached config reader backed by Settings collection.
// Periodically refreshes selected keys and serves them from memory.

const logger = require('../logger');
let Settings;
try { Settings = require('../models/Settings'); } catch (_) { Settings = null; }

class ConfigService {
  constructor() {
    this._cache = new Map();
    this._lastRefresh = 0;
    this._interval = null;
    this._keys = [
      'FEE_PER_KB',
      'MIN_UTXO_COUNT',
      'UTXO_SPLIT_SIZE_SATS',
      'MAX_SPLIT_OUTPUTS',
      'DUST_THRESHOLD_SATS',
      'DUST_SWEEP_LIMIT',
      'UTXO_MIN_CONFIRMATIONS',
    ];
  }

  initialize(pollMs = 60_000) {
    if (!Settings) {
      logger.warn('[ConfigService] Settings model unavailable; config cache disabled');
      return;
    }
    if (this._interval) return;
    this.refresh().catch((e) => logger.warn('[ConfigService] Initial refresh failed:', e.message));
    this._interval = setInterval(() => {
      this.refresh().catch((e) => logger.warn('[ConfigService] Periodic refresh failed:', e.message));
    }, pollMs).unref?.();
    logger.info('[ConfigService] Initialized with polling');
  }

  async refresh() {
    if (!Settings) return;
    const docs = await Settings.find({ key: { $in: this._keys } }).lean();
    for (const d of docs) this._cache.set(d.key, d.value);
    this._lastRefresh = Date.now();
  }

  getNumber(key, fallback) {
    const v = this._cache.get(key);
    const n = typeof v === 'string' ? parseInt(v, 10) : (typeof v === 'number' ? v : NaN);
    return Number.isFinite(n) ? n : fallback;
  }

  get(key, fallback) {
    return this._cache.has(key) ? this._cache.get(key) : fallback;
  }
}

module.exports = new ConfigService();
