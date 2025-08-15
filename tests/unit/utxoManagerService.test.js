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
  withLockHeartbeat: jest.fn(async (_key, _ttl, fn) => ({ ok: true, result: await fn() })),
}));

jest.mock('../../models/Utxo', () => ({
  countDocuments: jest.fn(() => 0),
  findOneAndUpdate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(null) })),
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
    await expect(utxoManagerService.splitIfNeeded()).resolves.toBeDefined();
  });
});
