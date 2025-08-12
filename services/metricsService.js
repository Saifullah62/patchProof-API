// services/metricsService.js
// Minimal in-memory counters with Prometheus text exposition.
const logger = require('../logger');

class MetricsService {
  constructor() {
    this.counters = Object.create(null);
    this.enabled = ['1', 'true', 'yes'].includes(String(process.env.METRICS_ENABLED || '1').toLowerCase());
  }

  inc(name, labels = {}) {
    if (!this.enabled) return;
    const key = this._key(name, labels);
    this.counters[key] = (this.counters[key] || 0) + 1;
  }

  set(name, value, labels = {}) {
    if (!this.enabled) return;
    const key = this._key(name, labels);
    this.counters[key] = Number(value) || 0;
  }

  _key(name, labels) {
    const sorted = Object.keys(labels).sort().map(k => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',');
    return sorted ? `${name}{${sorted}}` : name;
  }

  renderPrometheus() {
    // Simple text format
    const lines = [];
    lines.push('# HELP pp_challenges_issued Total SVD challenges issued');
    lines.push('# TYPE pp_challenges_issued counter');
    lines.push('# HELP pp_jwt_success Total JWT tokens successfully issued');
    lines.push('# TYPE pp_jwt_success counter');

    for (const [k, v] of Object.entries(this.counters)) {
      lines.push(`${k} ${v}`);
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = new MetricsService();
