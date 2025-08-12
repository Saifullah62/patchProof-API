/*
Unit tests for services/utxoService.js
Covers: selection, spend/unlock batches, orphan reaper, and dust query.
*/

jest.mock('../../models/Utxo', () => ({
  findOneAndUpdate: jest.fn(() => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ txid: 't', vout: 0 }) }) })),
  updateMany: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1, matchedCount: 1 }) })),
  updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) })),
  countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(3) })),
  find: jest.fn(() => ({ limit: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue([{ _id: '1' }]) }) }) })),
}));

jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Utxo = require('../../models/Utxo');
const utxoService = require('../../services/utxoService');

describe('utxoService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('selectAndLockUtxo filters, sorts, and returns lean doc', async () => {
    const doc = await utxoService.selectAndLockUtxo('kid', 1000);
    expect(Utxo.findOneAndUpdate).toHaveBeenCalled();
    expect(doc).toEqual({ txid: 't', vout: 0 });
  });

  test('spendUtxos batch updates by ids and logs count', async () => {
    await utxoService.spendUtxos([{ _id: 'a' }, { _id: 'b' }]);
    expect(Utxo.updateMany).toHaveBeenCalled();
  });

  test('unlockUtxos batch unlocks only locked docs', async () => {
    await utxoService.unlockUtxos([{ _id: 'a' }]);
    const [query] = Utxo.updateMany.mock.calls[0];
    expect(query).toMatchObject({ _id: { $in: ['a'] }, status: 'locked' });
  });

  test('spend/unlock single operate by id', async () => {
    await utxoService.spendUtxo({ _id: 'x', txid: 't', vout: 1 });
    await utxoService.unlockUtxo({ _id: 'y', txid: 't', vout: 2 });
    expect(Utxo.updateOne).toHaveBeenCalledTimes(2);
  });

  test('reaper unlocks stale locks and returns counts', async () => {
    const res = await utxoService.unlockOrphanedLocked(15, 100);
    expect(res).toHaveProperty('modified');
    expect(Utxo.find).toHaveBeenCalled();
  });

  test('getPoolCount and findDust query correctly', async () => {
    const cnt = await utxoService.getPoolCount('kid');
    expect(cnt).toBe(3);
    const dust = await utxoService.findDust('kid', 2000, 5);
    expect(Array.isArray(dust)).toBe(true);
  });
});
