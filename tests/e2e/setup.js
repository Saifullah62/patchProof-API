// tests/e2e/setup.js
// Preconditions for E2E tests. We assume server is already running.
// Guard: require explicit opt-in to avoid accidental mainnet hits.

const assert = require('assert');

module.exports = async () => {
  const required = ['E2E_MAINNET', 'BASE_URL'];
  for (const k of required) {
    if (!process.env[k]) {
      throw new Error(`Missing required env for E2E: ${k}`);
    }
  }
  assert.strictEqual(process.env.E2E_MAINNET, '1', 'E2E_MAINNET must be set to "1" for mainnet E2E');

  // Optional helpful defaults
  if (!process.env.METRICS_API_KEY) {
    // metrics may be public if METRICS_REQUIRE_API_KEY is not set
    // tests will branch accordingly
  }

  // Nothing else to start; server should already be up (npm start)
};
