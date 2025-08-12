/**
 * Jest E2E (production-like) config
 * - No mocks; targets a running server (BASE_URL)
 * - Long timeouts; runInBand recommended
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.e2e.spec.js'],
  setupFilesAfterEnv: [require('path').resolve(__dirname, 'setup.js')],
  globalTeardown: require('path').resolve(__dirname, 'teardown.js'),
  testTimeout: 120000,
  verbose: true,
};
