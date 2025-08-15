// clients/svdSdk.js
// Minimal client helper to complete SVD auth: begin -> sign -> complete, with auto-retry on
// SVD_EXPIRED or SVD_REPLAYED. Works in Node 18+ (global fetch) or browsers.

const bsv = require('bsv');
const crypto = require('crypto');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

// Derive P2C = PMC + H(M) mod n (client-side private scalar for this challenge)
function _deriveP2cFromPmcWIF(pmcPrivWIF, Mhex) {
  const PMC = bsv.PrivateKey.fromWIF(pmcPrivWIF);
  const n = bsv.crypto.Point.getN();
  const h = new bsv.crypto.BN(sha256(Buffer.from(Mhex, 'hex')));
  const p2c = PMC.bn.add(h).umod(n);
  if (p2c.isZero()) throw new Error('Derived client scalar invalid');
  return new bsv.PrivateKey(p2c);
}

// --- Custom Error Classes for Better Diagnostics ---
class SvdError extends Error {
  constructor(message, code = null, cause = null) {
    super(message);
    this.name = 'SvdError';
    this.code = code;
    this.cause = cause;
  }
}

class SvdNetworkError extends SvdError {
  constructor(message, cause) {
    super(message, 'NETWORK_ERROR', cause);
    this.name = 'SvdNetworkError';
  }
}

/**
 * A robust, instance-configurable client for SVD authentication.
 */
class SvdSdk {
  /**
   * @param {object} config
   * @param {string} config.baseUrl Base URL of the API (e.g., http://localhost:3001)
   * @param {object} [config.defaultHeaders]
   * @param {number} [config.maxAttempts]
   */
  constructor({ baseUrl, defaultHeaders = {}, maxAttempts = 2 }) {
    if (!baseUrl) throw new Error('SvdSdk: `baseUrl` is required');
    this.baseUrl = baseUrl;
    this.defaultHeaders = { 'content-type': 'application/json', ...defaultHeaders };
    this.maxAttempts = maxAttempts;
  }

  _sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

  _deriveP2cFromPmcWIF(pmcPrivWIF, mHex) {
    const PMC = bsv.PrivateKey.fromWIF(pmcPrivWIF);
    const n = bsv.crypto.Point.getN();
    const h = new bsv.crypto.BN(this._sha256(Buffer.from(mHex, 'hex')));
    const p2c = PMC.bn.add(h).umod(n);
    if (p2c.isZero()) throw new SvdError('Derived client scalar is invalid (zero).', 'DERIVATION_FAILURE');
    return new bsv.PrivateKey(p2c);
  }

  async _fetchJson(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        let errorData;
        try {
          errorData = await res.json();
        } catch (_) {
          errorData = { error: res.statusText, code: `HTTP_${res.status}` };
        }
        throw new SvdError(errorData?.error || 'API request failed', errorData?.code);
      }
      if (res.status === 204) return {};
      return await res.json();
    } catch (err) {
      if (err instanceof SvdError) throw err;
      throw new SvdNetworkError(`Request to ${url} failed`, err);
    }
  }

  async begin({ userId, signal } = {}) {
    return this._fetchJson('/api/svd/begin', {
      method: 'POST',
      headers: this.defaultHeaders,
      body: JSON.stringify({ userId }),
      signal,
    });
  }

  async complete({ userId, M, signatureHex, signal } = {}) {
    return this._fetchJson('/api/svd/complete', {
      method: 'POST',
      headers: this.defaultHeaders,
      body: JSON.stringify({ userId, M, signatureHex }),
      signal,
    });
  }

  async getKid({ signal } = {}) {
    try {
      const data = await this._fetchJson('/api/svd/kid', { method: 'GET', headers: this.defaultHeaders, signal });
      return data?.kid || null;
    } catch (e) {
      // For kid fetching, return null on any error to keep callers simple
      return null;
    }
  }

  async login({ userId, pmcPrivWIF, signal } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw new SvdError('Login cancelled by user.', 'CANCELLED');
      }
      try {
        const { M } = await this.begin({ userId, signal });
        const p2c = this._deriveP2cFromPmcWIF(pmcPrivWIF, M);
        const msgHash = this._sha256(Buffer.from(M, 'hex'));
        const sig = bsv.crypto.ECDSA.sign(msgHash, p2c);
        const signatureHex = sig.toDER().toString('hex');
        return await this.complete({ userId, M, signatureHex, signal });
      } catch (e) {
        lastErr = e;
        // Attempt kid refresh on failures to adapt to rotation (best-effort)
        try { await this.getKid({ signal }); }
        // eslint-disable-next-line no-empty
        catch (_) {}
        if (e instanceof SvdError && (e.code === 'SVD_EXPIRED' || e.code === 'SVD_REPLAYED') && attempt < this.maxAttempts) {
          if (e.code === 'SVD_REPLAYED') {
            const delay = 50 + Math.floor(Math.random() * 200);
            await new Promise(r => setTimeout(r, delay));
          }
          continue;
        }
        throw e;
      }
    }
    throw new SvdError(`SVD login failed after ${this.maxAttempts} attempts.`, 'MAX_ATTEMPTS_REACHED', lastErr);
  }
}

// --- Backward-compatible wrappers ---
async function beginSvd({ baseUrl, userId, headers = {}, signal }) {
  const sdk = new SvdSdk({ baseUrl, defaultHeaders: headers });
  return sdk.begin({ userId, signal });
}

async function completeSvd({ baseUrl, userId, M, signatureHex, headers = {}, signal }) {
  const sdk = new SvdSdk({ baseUrl, defaultHeaders: headers });
  return sdk.complete({ userId, M, signatureHex, signal });
}

async function fetchKid({ baseUrl, headers = {}, signal } = {}) {
  const sdk = new SvdSdk({ baseUrl, defaultHeaders: headers });
  return sdk.getKid({ signal });
}

async function loginSvd({ baseUrl, userId, pmcPrivWIF, headers = {}, maxAttempts = 2, signal }) {
  const sdk = new SvdSdk({ baseUrl, defaultHeaders: headers, maxAttempts });
  return sdk.login({ userId, pmcPrivWIF, signal });
}

module.exports = { SvdSdk, SvdError, SvdNetworkError, loginSvd, beginSvd, completeSvd, fetchKid };
