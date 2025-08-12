/*
Unit tests for services/blockchainService.js (v2)
Covers: fee sourcing priority and fee growth with size.
*/

jest.mock('../../clients/wocClient', () => ({
  getRecommendedFeePerKb: jest.fn(() => NaN),
  broadcast: jest.fn(),
  initialize: jest.fn(),
}));

jest.mock('../../services/configService', () => ({
  getNumber: jest.fn(() => NaN),
  initialize: jest.fn(),
}));

const bsv = require('bsv');
const wocClient = require('../../clients/wocClient');
const configService = require('../../services/configService');
const { v2: blockchain } = require('../../services/blockchainService');

function makeDummyUtxo(sats = 10000) {
  // Minimal fake UTXO entries sufficient for bsv.Transaction.from
  return {
    txid: 'f'.repeat(64),
    vout: 0,
    scriptPubKey: bsv.Script.fromAddress(new bsv.PrivateKey().toAddress()).toHex(),
    satoshis: sats,
    keyIdentifier: 'kid',
  };
}

describe('blockchainService v2 - fee sourcing and sizing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEE_PER_KB = '512';
  });

  test('fee sourcing priority: Settings > WoC > env', () => {
    // Case 1: configService returns value
    configService.getNumber.mockReturnValueOnce(900);
    wocClient.getRecommendedFeePerKb.mockReturnValueOnce(300);
    expect(blockchain.getFeePerKb()).toBe(900);

    // Case 2: Settings NaN, WoC returns value
    configService.getNumber.mockReturnValueOnce(NaN);
    wocClient.getRecommendedFeePerKb.mockReturnValueOnce(300);
    expect(blockchain.getFeePerKb()).toBe(300);

    // Case 3: both NaN -> env default
    configService.getNumber.mockReturnValueOnce(NaN);
    wocClient.getRecommendedFeePerKb.mockReturnValueOnce(NaN);
    expect(blockchain.getFeePerKb()).toBe(512);
  });

  test('fee increases with additional outputs (size growth)', () => {
    // Force deterministic fee to avoid env/WoC variance
    configService.getNumber.mockReturnValue(NaN);
    wocClient.getRecommendedFeePerKb.mockReturnValue(NaN);
    process.env.FEE_PER_KB = '1000'; // larger to amplify differences

    const baseUtxo = makeDummyUtxo(20000);
    // 1 output (OP_RETURN only)
    const { transaction: tx1 } = blockchain.buildOpReturnTransaction([baseUtxo], [Buffer.from('a')], new bsv.PrivateKey().toAddress().toString());
    const fee1 = tx1.getFee();

    // 2 outputs: add small change by decreasing utxo sats to force change creation
    const utxo2 = makeDummyUtxo(50000);
    const { transaction: tx2 } = blockchain.buildOpReturnTransaction([utxo2], [Buffer.from('a'), Buffer.from('b')], new bsv.PrivateKey().toAddress().toString());
    const fee2 = tx2.getFee();

    expect(fee2).toBeGreaterThanOrEqual(fee1);
  });
});
