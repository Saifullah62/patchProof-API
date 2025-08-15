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
      NODE_ENV: 'test',
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
    jest.doMock('../../clients/wocClient', () => ({
      getUnspentOutputs: jest.fn(async () => []),
      getChainInfo: jest.fn(async () => ({ blocks: 0 })),
      getRecommendedFeePerKb: jest.fn(() => 512),
    }));
    jest.doMock('../../services/kmsSigner', () => ({
      signBatch: jest.fn(async () => []),
    }));
    jest.doMock('../../services/blockchainService', () => ({
      v2: {
        applySignatures: jest.fn(() => {}),
        broadcast: jest.fn(async () => 'txid'),
      },
      sweepAddress: jest.fn(async () => ({ success: true, txid: 'txid' })),
    }));
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('skips when pool is healthy', async () => {
    jest.doMock('../../models/Utxo', () => ({
      countDocuments: jest.fn(async () => 15),
    }));
    jest.doMock('../../services/lockManager', () => ({
      withLockHeartbeat: jest.fn(async (_key, _ttl, fn) => ({ ok: true, result: await fn() })),
    }));
    const utxoManagerService = require(path.resolve(__dirname, '../../services/utxoManagerService.js'));
    const res = await utxoManagerService.splitIfNeeded(true);
    expect(res).toMatchObject({ skipped: true, reason: 'pool_healthy' });
  });

  test('plans split with deficit in dry-run mode', async () => {
    const fakeSelected = { _id: 'x', txid: 'f'.repeat(64), vout: 0, satoshis: 300000 };
    // Stub bsv to avoid version-specific Transaction internals during fee calculation
    jest.doMock('bsv', () => ({
      Transaction: class {
        constructor() { this.inputs = [{ output: { script: '00', satoshis: fakeSelected.satoshis } }]; }
        from() { return this; }
        to() { return this; }
        change() { return this; }
        feePerKb() { return this; }
        getFee() { return 1500; }
      },
      Script: { buildPublicKeyHashOut: () => ({ toHex: () => '76a914deadbeef88ac' }) },
      crypto: { Signature: { SIGHASH_ALL: 0x01, SIGHASH_FORKID: 0x40 } },
    }));
    jest.doMock('../../models/Utxo', () => ({
      countDocuments: jest.fn(async () => 2),
      findOneAndUpdate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(fakeSelected) })),
    }));
    jest.doMock('../../services/lockManager', () => ({
      withLockHeartbeat: jest.fn(async (_key, _ttl, fn) => ({ ok: true, result: await fn() })),
    }));
    jest.doMock('../../services/utxoService', () => ({
      unlockUtxo: jest.fn(async () => {}),
    }));
    const utxoManagerService = require(path.resolve(__dirname, '../../services/utxoManagerService.js'));
    const res = await utxoManagerService.splitIfNeeded(true);
    expect(res).toHaveProperty('dryRun', true);
    expect(res).toHaveProperty('outputs');
    expect(Number.isFinite(res.fee)).toBe(true);
  });

  test('skips when lease held', async () => {
    jest.doMock('../../models/Utxo', () => ({
      countDocuments: jest.fn(async () => 0),
    }));
    jest.doMock('../../services/lockManager', () => ({
      withLockHeartbeat: jest.fn(async () => ({ ok: false, error: 'LOCK_NOT_ACQUIRED' })),
    }));
    const utxoManagerService = require(path.resolve(__dirname, '../../services/utxoManagerService.js'));
    const res = await utxoManagerService.splitIfNeeded(true);
    expect(res).toMatchObject({ skipped: true, reason: 'lease_held' });
  });
});
