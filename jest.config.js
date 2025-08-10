module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Do not ignore any tests; keyUtils tests are important
  testPathIgnorePatterns: [],
  // Improve stability on Windows CI by running tests serially
  // You can override by running: jest --maxWorkers=50%
  maxWorkers: 1,
  // Helpful when diagnosing hanging tests
  detectOpenHandles: true,
  verbose: true,
};
