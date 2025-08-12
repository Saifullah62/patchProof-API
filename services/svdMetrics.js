// services/svdMetrics.js
// Production-grade metrics service using the standard prom-client library.
const { register, Counter, Histogram, collectDefaultMetrics } = require('prom-client');

// Expose default Node.js metrics for overall health
collectDefaultMetrics({ prefix: 'patchproof_' });

// Custom metrics
const svdEvents = new Counter({
  name: 'patchproof_svd_events_total',
  help: 'Total number of SVD authentication events',
  labelNames: ['event_type', 'kid', 'sha'],
});

const svdChallengeAge = new Histogram({
  name: 'patchproof_svd_challenge_age_seconds',
  help: 'Histogram of the age of SVD challenges in seconds',
  labelNames: ['kid', 'sha'],
  buckets: [15, 30, 60, 120, 180, 300],
});

function inc(eventType, labels = {}) {
  svdEvents.inc({
    event_type: eventType,
    kid: labels.kid || 'unknown',
    sha: labels.sha || 'unknown',
  });
}

function observeAge(ageSec, labels = {}) {
  svdChallengeAge.observe({
    kid: labels.kid || 'unknown',
    sha: labels.sha || 'unknown',
  }, ageSec);
}

async function getMetricsAsText() {
  return register.metrics();
}

function getContentType() {
  return register.contentType;
}

module.exports = { inc, observeAge, getMetricsAsText, getContentType };
