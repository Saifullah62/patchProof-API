// jest.config.js
// Production-grade Jest configuration for PatchProof.
// - Parallel tests for speed
// - Global setup/teardown for reliable integration tests
// - Coverage collection and enforcement as a quality gate

module.exports = {
  // --- Core Setup ---
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,

  // --- Performance ---
  // Run tests in parallel using up to 50% of available CPU cores.
  // Override locally if needed: `jest --maxWorkers=75%`
  maxWorkers: '50%',

  // --- Reliability for Integration Tests ---
  // Initialize shared resources (DB/Redis locks, etc.) once per test run.
  globalSetup: './tests/setup.js',
  globalTeardown: './tests/teardown.js',

  // --- Diagnostics ---
  // Useful when diagnosing hanging tests; disable by default for performance.
  detectOpenHandles: false,

  // --- Code Quality: Coverage ---
  collectCoverage: true,
  collectCoverageFrom: [
    '**/services/**/*.js',
    '**/controllers/**/*.js',
    '**/workers/**/*.js',
    '!**/node_modules/**',
    '!**/tests/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
  },
};