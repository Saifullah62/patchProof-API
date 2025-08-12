// services/utxoManagerService.js
require('dotenv').config();
const https = require('https');
const bsv = require('bsv');
const Utxo = require('../models/Utxo');
const utxoService = require('./utxoService');
const blockchainService = require('./blockchainService');
const logger = require('../logger');
const Settings = require('../models/Settings');
const lockManager = require('./lockManager');
const kmsSigner = require('./kmsSigner');
const wocClient = require('../clients/wocClient');

// New production-grade orchestrator
class UtxoManagerService {
  constructor() {
    this.MIN_UTXO_COUNT = parseInt(process.env.UTXO_MIN_POOL || process.env.MIN_UTXO_COUNT || '10', 10);
    this.UTXO_SPLIT_SIZE_SATS = parseInt(process.env.UTXO_SPLIT_SIZE_SATS || '5000', 10);
    this.MAX_SPLIT_OUTPUTS = parseInt(process.env.MAX_SPLIT_OUTPUTS || '40', 10);
    this.DUST_THRESHOLD_SATS = parseInt(process.env.DUST_THRESHOLD_SATS || '2000', 10);
    this.DUST_SWEEP_LIMIT = parseInt(process.env.DUST_SWEEP_LIMIT || '20', 10);
    this.MIN_CONFIRMATIONS = Math.max(0, parseInt(process.env.UTXO_MIN_CONFIRMATIONS || '1', 10));
    this.FUNDING_KEY_ID = process.env.UTXO_FUNDING_KEY_IDENTIFIER || process.env.FUNDING_KEY_IDENTIFIER;
    this.FUNDING_ADDRESS = process.env.UTXO_FUNDING_ADDRESS || process.env.FUNDING_ADDRESS;
    this.CHANGE_ADDRESS = process.env.UTXO_CHANGE_ADDRESS || process.env.CHANGE_ADDRESS || this.FUNDING_ADDRESS;
    this.SPLIT_LEASE_MS = parseInt(process.env.SPLIT_LEASE_MS || '300000', 10);
    this.FEE_PER_KB = parseInt(process.env.FEE_PER_KB || '500', 10);
    this._lastConfigRefresh = 0;
  }

  initialize() {
    if (!this.FUNDING_KEY_ID || !this.FUNDING_ADDRESS || !this.CHANGE_ADDRESS) {
      logger.error('[UtxoManagerService] FATAL: Funding key/address configuration is missing.');
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }
    logger.info('[UtxoManagerService] Initialized.');
    // Non-blocking refresh from Settings to allow ops to tune without redeploy
    this.refreshConfigFromSettings().catch((e) => logger.warn('[UtxoManagerService] Settings refresh failed (continuing with env defaults):', e.message));
  }

  async refreshConfigFromSettings() {
    const now = Date.now();
    if (now - this._lastConfigRefresh < 30_000) return; // throttle
    const keys = [
      'MIN_UTXO_COUNT',
      'UTXO_SPLIT_SIZE_SATS',
      'MAX_SPLIT_OUTPUTS',
      'DUST_THRESHOLD_SATS',
      'DUST_SWEEP_LIMIT',
      'UTXO_MIN_CONFIRMATIONS',
      'FEE_PER_KB',
    ];
    const rows = await Settings.find({ key: { $in: keys } }).lean();
    const map = new Map(rows.map(r => [r.key, r.value]));
    const num = (k, fallback) => {
      const v = map.get(k);
      const n = typeof v === 'string' ? parseInt(v, 10) : (typeof v === 'number' ? v : NaN);
      return Number.isFinite(n) ? n : fallback;
    };
    const old = {
      MIN_UTXO_COUNT: this.MIN_UTXO_COUNT,
      UTXO_SPLIT_SIZE_SATS: this.UTXO_SPLIT_SIZE_SATS,
      MAX_SPLIT_OUTPUTS: this.MAX_SPLIT_OUTPUTS,
      DUST_THRESHOLD_SATS: this.DUST_THRESHOLD_SATS,
      DUST_SWEEP_LIMIT: this.DUST_SWEEP_LIMIT,
      MIN_CONFIRMATIONS: this.MIN_CONFIRMATIONS,
      FEE_PER_KB: this.FEE_PER_KB,
    };
    this.MIN_UTXO_COUNT = num('MIN_UTXO_COUNT', this.MIN_UTXO_COUNT);
    this.UTXO_SPLIT_SIZE_SATS = num('UTXO_SPLIT_SIZE_SATS', this.UTXO_SPLIT_SIZE_SATS);
    this.MAX_SPLIT_OUTPUTS = num('MAX_SPLIT_OUTPUTS', this.MAX_SPLIT_OUTPUTS);
    this.DUST_THRESHOLD_SATS = num('DUST_THRESHOLD_SATS', this.DUST_THRESHOLD_SATS);
    this.DUST_SWEEP_LIMIT = num('DUST_SWEEP_LIMIT', this.DUST_SWEEP_LIMIT);
    this.MIN_CONFIRMATIONS = Math.max(0, num('UTXO_MIN_CONFIRMATIONS', this.MIN_CONFIRMATIONS));
    this.FEE_PER_KB = num('FEE_PER_KB', this.FEE_PER_KB);
    this._lastConfigRefresh = now;
    if (JSON.stringify(old) !== JSON.stringify({
      MIN_UTXO_COUNT: this.MIN_UTXO_COUNT,
      UTXO_SPLIT_SIZE_SATS: this.UTXO_SPLIT_SIZE_SATS,
      MAX_SPLIT_OUTPUTS: this.MAX_SPLIT_OUTPUTS,
      DUST_THRESHOLD_SATS: this.DUST_THRESHOLD_SATS,
      DUST_SWEEP_LIMIT: this.DUST_SWEEP_LIMIT,
      MIN_CONFIRMATIONS: this.MIN_CONFIRMATIONS,
      FEE_PER_KB: this.FEE_PER_KB,
    })) {
      logger.info('[UtxoManagerService] Runtime config updated from Settings', {
        MIN_UTXO_COUNT: this.MIN_UTXO_COUNT,
        UTXO_SPLIT_SIZE_SATS: this.UTXO_SPLIT_SIZE_SATS,
        MAX_SPLIT_OUTPUTS: this.MAX_SPLIT_OUTPUTS,
        DUST_THRESHOLD_SATS: this.DUST_THRESHOLD_SATS,
        DUST_SWEEP_LIMIT: this.DUST_SWEEP_LIMIT,
        MIN_CONFIRMATIONS: this.MIN_CONFIRMATIONS,
        FEE_PER_KB: this.FEE_PER_KB,
      });
    }
  }

  async syncUtxos(isDryRun = false) {
    const network = (process.env.WOC_NETWORK || 'main').toLowerCase();
    const [unspentList, info] = await Promise.all([
      wocClient.getUnspentOutputs(this.FUNDING_ADDRESS, 0),
      wocClient.getChainInfo(),
    ]);
    const height = info?.blocks || 0;
    const onChainUtxos = (Array.isArray(unspentList) ? unspentList : []).map(u => ({
      tx_hash: u.tx_hash || u.txid,
      tx_pos: u.tx_pos != null ? u.tx_pos : u.vout,
      value: u.value != null ? u.value : u.satoshis,
      confirmations: u.height && u.height > 0 ? (height - u.height + 1) : 0,
    }));

    const localUtxos = await Utxo.find({ status: { $in: ['available', 'unconfirmed'] }, keyIdentifier: this.FUNDING_KEY_ID }).lean();

    const onChainSet = new Set(onChainUtxos.map(u => `${u.tx_hash}:${u.tx_pos}`));
    const localSet = new Set(localUtxos.map(u => `${u.txid}:${u.vout}`));

    const toAdd = onChainUtxos.filter(u => !localSet.has(`${u.tx_hash}:${u.tx_pos}`));
    const toMarkSpent = localUtxos.filter(u => u.status === 'available' && !onChainSet.has(`${u.txid}:${u.vout}`));
    const toMarkConfirmed = localUtxos.filter(u => u.status === 'unconfirmed' && onChainSet.has(`${u.txid}:${u.vout}`));

    if (isDryRun) {
      logger.info('[UtxoManagerService][DryRun] Sync Plan', { toAdd: toAdd.length, toMarkSpent: toMarkSpent.length, toMarkConfirmed: toMarkConfirmed.length });
      return { added: 0, spent: 0, confirmed: 0 };
    }

    for (const u of toAdd) {
      await utxoService.addUtxo({
        txid: u.tx_hash,
        vout: u.tx_pos,
        satoshis: u.value,
        scriptPubKey: bsv.Script.buildPublicKeyHashOut(this.FUNDING_ADDRESS).toHex(),
        keyIdentifier: this.FUNDING_KEY_ID,
        status: (u.confirmations || 0) >= this.MIN_CONFIRMATIONS ? 'available' : 'unconfirmed',
      });
    }
    if (toMarkSpent.length) await utxoService.spendUtxos(toMarkSpent);
    if (toMarkConfirmed.length) {
      const ids = toMarkConfirmed.map(u => u._id);
      await Utxo.updateMany({ _id: { $in: ids } }, { $set: { status: 'available', updated_at: new Date() } }).exec();
    }
    return { added: toAdd.length, spent: toMarkSpent.length, confirmed: toMarkConfirmed.length };
  }

  async sweepDust(isDryRun = false) {
    const dustUtxos = await Utxo.find({ status: 'available', keyIdentifier: this.FUNDING_KEY_ID, satoshis: { $lt: this.DUST_THRESHOLD_SATS } })
      .limit(this.DUST_SWEEP_LIMIT + 50).exec();
    if (dustUtxos.length < this.DUST_SWEEP_LIMIT) {
      return { skipped: true, reason: 'dust_below_limit', count: dustUtxos.length };
    }

    // Consolidate entire address for simplicity and optimal consolidation, delegating to blockchainService
    const res = await require('./blockchainService').sweepAddress({
      addressToSweep: this.FUNDING_ADDRESS,
      signingKeyIdentifier: this.FUNDING_KEY_ID,
      destinationAddress: this.FUNDING_ADDRESS,
      isDryRun,
    });

    if (isDryRun) return res;
    if (res.success) {
      // Mark the dust inputs we intended to sweep as spent; the next sync will import resulting change/new UTXOs
      await utxoService.spendUtxos(dustUtxos);
      return { success: true, txid: res.txid, inputs: dustUtxos.length };
    }
    return { success: false, error: res.error || 'sweep_failed' };
  }

  async splitIfNeeded(isDryRun = false) {
    const poolCount = await Utxo.countDocuments({ status: 'available', keyIdentifier: this.FUNDING_KEY_ID });
    if (poolCount >= this.MIN_UTXO_COUNT) {
      return { skipped: true, reason: 'pool_healthy', poolCount };
    }

    const deficit = Math.min(this.MIN_UTXO_COUNT - poolCount, this.MAX_SPLIT_OUTPUTS);
    const requiredSatoshis = (this.UTXO_SPLIT_SIZE_SATS * deficit) + 5000; // fee buffer

    const locked = await lockManager.withLockHeartbeat('utxo_split_v2', this.SPLIT_LEASE_MS, async () => {
      const selected = await Utxo.findOneAndUpdate(
        { status: 'available', keyIdentifier: this.FUNDING_KEY_ID, satoshis: { $gte: requiredSatoshis } },
        { $set: { status: 'locked', updated_at: new Date() } },
        { sort: { satoshis: 1 }, new: true }
      ).exec();

      if (!selected) {
        return { success: false, error: 'no_large_utxo_available', required: requiredSatoshis };
      }

      try {
        const tx = new bsv.Transaction();
        const scriptHex = bsv.Script.buildPublicKeyHashOut(this.FUNDING_ADDRESS).toHex();
        tx.from({ txid: selected.txid, vout: selected.vout, scriptPubKey: scriptHex, script: scriptHex, satoshis: selected.satoshis });
        for (let i = 0; i < deficit; i++) {
          tx.to(this.FUNDING_ADDRESS, this.UTXO_SPLIT_SIZE_SATS);
        }
        tx.change(this.CHANGE_ADDRESS);
        tx.feePerKb(this.FEE_PER_KB);

        if (isDryRun) {
          await utxoService.unlockUtxo(selected);
          return { dryRun: true, outputs: deficit, fee: tx.getFee() };
        }

        const flags = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
        const sighash = tx.sighashForUTXO(0, tx.inputs[0].output.script, tx.inputs[0].output.satoshis, flags).toString('hex');
        const signatures = await kmsSigner.signBatch([{ keyIdentifier: this.FUNDING_KEY_ID, sighash }]);
        blockchainService.v2.applySignatures(tx, signatures);
        const txid = await blockchainService.v2.broadcast(tx.serialize());

        await utxoService.spendUtxo(selected);
        return { success: true, txid, outputs: deficit };
      } catch (err) {
        await utxoService.unlockUtxo(selected);
        throw err;
      }
    });

    if (!locked.ok) {
      if (locked.error === 'LOCK_NOT_ACQUIRED') return { skipped: true, reason: 'lease_held', poolCount };
      throw locked.error;
    }
    return locked.result;
  }
}

module.exports = new UtxoManagerService();
