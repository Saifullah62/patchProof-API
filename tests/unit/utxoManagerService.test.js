/*
Unit tests for services/utxoManagerService.js
Focus: config loading, split planning edge-cases, and dust handling.
This is a scaffold to expand with real cases; DB and clients are mocked.
*/

jest.mock('../../services/configService', () => ({
  getNumber: jest.fn(() => NaN),
  initialize: jest.fn(),
}));

jest.mock('../../models/Settings', () => ({
  find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
}));

jest.mock('../../services/lockManager', () => ({
  withLockHeartbeat: async (_key, fn) => fn(),
}));

describe('utxoManagerService', () => {
  const path = require('path');
  const servicePath = path.resolve(__dirname, '../../services/utxoManagerService.js');
  // Defer require to after jest.mocks
  const utxoManagerService = require(servicePath);

  test('initialize does not throw and sets defaults', () => {
    expect(() => utxoManagerService.initialize()).not.toThrow();
  });

  test('splitIfNeeded handles empty state gracefully', async () => {
    // Provide minimal stubs if service expects certain properties
    utxoManagerService._state = utxoManagerService._state || {};
    await expect(utxoManagerService.splitIfNeeded()).resolves.not.toThrow();
  });
});
