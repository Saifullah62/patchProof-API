// clients/wocClient.js
// A robust, production-grade WhatsOnChain client using axios for reliable HTTP requests.

const axios = require('axios');
const logger = require('../logger');

class WocClient {
  constructor() {
    this.axiosInstance = null;
    this.isReady = false;
  }

  initialize() {
    const apiKey = process.env.WOC_API_KEY;
    const timeout = parseInt(process.env.WOC_TIMEOUT_MS, 10) || 8000;

    this.axiosInstance = axios.create({
      baseURL: 'https://api.whatsonchain.com',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'woc-api-key': apiKey }),
      },
    });

    this.isReady = true;
    logger.info('[WocClient] Initialized');
  }

  async _request(config) {
    if (!this.isReady) throw new Error('WocClient is not initialized.');
    const maxRetries = parseInt(process.env.WOC_RETRIES, 10) || 2;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const res = await this.axiosInstance(config);
        return res.data;
      } catch (err) {
        lastError = err;
        const status = err?.response?.status;
        const retryable = !status || status >= 500;
        if (retryable && attempt <= maxRetries) {
          const delayMs = Math.pow(2, attempt - 1) * 200; // 200, 400, 800...
          logger.warn(`[WocClient] ${config.method || 'GET'} ${config.url} failed (attempt ${attempt}/${maxRetries + 1}): ${err.message}; retrying in ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  _network() {
    const n = (process.env.WOC_NETWORK || 'main').toLowerCase();
    return n === 'test' ? 'test' : 'main';
  }

  async getChainHealth(fundingAddress) {
    const network = this._network();
    const minConf = parseInt(process.env.UTXO_MIN_CONFIRMATIONS || '1', 10);
    const [unspent, info] = await Promise.all([
      this._request({ url: `/v1/bsv/${network}/address/${fundingAddress}/unspent` }),
      this._request({ url: `/v1/bsv/${network}/chain/info` }),
    ]);
    const height = info?.blocks || 0;
    const list = Array.isArray(unspent) ? unspent : [];
    const confirmed = list.filter(u => u.height > 0 && (height - u.height + 1) >= minConf);
    return {
      totalUtxos: list.length,
      totalSatoshis: list.reduce((s, u) => s + (u.value || 0), 0),
      confirmedUtxos: confirmed.length,
      confirmedSatoshis: confirmed.reduce((s, u) => s + (u.value || 0), 0),
      height,
    };
  }

  async isUtxoSpent(txid, vout) {
    const network = this._network();
    try {
      await this._request({ url: `/v1/bsv/${network}/tx/${txid}/out/${vout}/spend` });
      return true;
    } catch (err) {
      if (err?.response?.status === 404) return false;
      throw err;
    }
  }

  async broadcast(rawTxHex, networkOverride) {
    const network = networkOverride ? (String(networkOverride).toLowerCase() === 'test' ? 'test' : 'main') : this._network();
    const data = await this._request({ url: `/v1/bsv/${network}/tx/raw`, method: 'POST', data: { txhex: rawTxHex } });
    return typeof data === 'string' ? data.replace(/"/g, '').trim() : data;
  }

  async getUnspentOutputs(address, minConfirmations = 1) {
    const network = this._network();
    const unspent = await this._request({ url: `/v1/bsv/${network}/address/${address}/unspent` });
    if (!Array.isArray(unspent)) return [];
    if (minConfirmations > 0) {
      const info = await this._request({ url: `/v1/bsv/${network}/chain/info` });
      const height = info?.blocks || 0;
      return unspent.filter(u => u.height > 0 && (height - u.height + 1) >= minConfirmations);
    }
    return unspent;
  }

  async getChainInfo() {
    const network = this._network();
    return this._request({ url: `/v1/bsv/${network}/chain/info` });
  }
}

module.exports = new WocClient();
