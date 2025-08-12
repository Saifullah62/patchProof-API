/*
Unit tests for services/utxoManagerService.js split planning
Covers: pool healthy skip, deficit dry-run plan with outputs and fee estimation, and lease held skip.
*/

describe('utxoManagerService.splitIfNeeded', () => {
  const ORIGINAL_ENV = { ...process.env };
  const path = require('path');

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV,
      MIN_UTXO_COUNT: '10',
      UTXO_SPLIT_SIZE_SATS: '5000',
      MAX_SPLIT_OUTPUTS: '40',
      DUST_THRESHOLD_SATS: '2000',
      DUST_SWEEP_LIMIT: '20',
      UTXO_MIN_CONFIRMATIONS: '0',
      FEE_PER_KB: '512',
      UTXO_FUNDING_KEY_IDENTIFIER: 'kid',
      UTXO_FUNDING_ADDRESS: '1GvSJVaZkQbBf1C2sP3m2Hq2F8B3o9h9hQ',
      UTXO_CHANGE_ADDRESS: '1GvSJVaZkQbBf1C2sP3m2Hq2F8B3o9h9hQ',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('skips when pool is healthy', async () => {
    jest.mock('../../models/Utxo', () => ({
      countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(15) })),
    }));
    jest.mock('../../services/lockManager', () => ({
      withLockHeartbeat: jest.fn(async (_key, _ttl, fn) => ({ ok: true, result: await fn() })),
    }));
    const utxoManagerService = require(path.resolve(__dirname, '../../services/utxoManagerService.js'));
    const res = await utxoManagerService.splitIfNeeded(true);
    expect(res).toMatchObject({ skipped: true, reason: 'pool_healthy' });
  });

  test('plans split with deficit in dry-run mode', async () => {
    const fakeSelected = { _id: 'x', txid: 'f'.repeat(64), vout: 0, satoshis: 300000 };
    jest.mock('../../models/Utxo', () => ({
      countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(2) })),
      findOneAndUpdate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(fakeSelected) })),
    }));
    jest.mock('../../services/lockManager', () => ({
      withLockHeartbeat: jest.fn(async (_key, _ttl, fn) => ({ ok: true, result: await fn() })),
    }));
    jest.mock('../../services/utxoService', () => ({
      unlockUtxo: jest.fn(async () => {}),
    }));
    const utxoManagerService = require(path.resolve(__dirname, '../../services/utxoManagerService.js'));
    const res = await utxoManagerService.splitIfNeeded(true);
    expect(res).toHaveProperty('dryRun', true);
    expect(res).toHaveProperty('outputs');
    expect(Number.isFinite(res.fee)).toBe(true);
  });

  test('skips when lease held', async () => {
    jest.mock('../../models/Utxo', () => ({
      countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(0) })),
    }));
    jest.mock('../../services/lockManager', () => ({
      withLockHeartbeat: jest.fn(async () => ({ ok: false, error: 'LOCK_NOT_ACQUIRED' })),
    }));
    const utxoManagerService = require(path.resolve(__dirname, '../../services/utxoManagerService.js'));
    const res = await utxoManagerService.splitIfNeeded(true);
    expect(res).toMatchObject({ skipped: true, reason: 'lease_held' });
  });
});
