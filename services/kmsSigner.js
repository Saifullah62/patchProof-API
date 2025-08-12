// services/kmsSigner.js
// A robust, production-grade KMS signer client using axios for reliable HTTP requests.
const axios = require('axios');
const logger = require('../logger');

class KmsSigner {
  constructor() {
    this.axiosTx = null;   // for transaction signing: POST /sign
    this.axiosSvd = null;  // for SVD ops: POST /svd/derive-secret
    this.isReady = false;
  }

  /**
   * Initializes the KmsSigner. Must be called at application startup.
   */
  initialize() {
    const apiKey = process.env.KMS_API_KEY;
    const txUrl = process.env.KMS_TX_SIGN_URL || process.env.KMS_SIGN_URL || '';
    const svdUrl = process.env.KMS_SVD_URL || process.env.KMS_SIGN_URL || '';

    if (!txUrl && !svdUrl) {
      logger.warn('[KmsSigner] No KMS URLs configured (KMS_TX_SIGN_URL/KMS_SVD_URL/KMS_SIGN_URL). Signing/derivation disabled.');
      this.isReady = false;
      return;
    }

    const timeout = parseInt(process.env.KMS_SIGN_TIMEOUT_MS, 10) || 15000;
    const commonHeaders = {
      'Content-Type': 'application/json',
      ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
    };

    // TX signer axios (can be 'mock' in CI/dev)
    if (txUrl) {
      this.axiosTx = axios.create({ baseURL: txUrl, timeout, headers: commonHeaders });
    }
    // SVD axios (should point to real KMS in prod)
    if (svdUrl) {
      this.axiosSvd = axios.create({ baseURL: svdUrl, timeout, headers: commonHeaders });
    }

    this.isReady = true;
    logger.info(`[KmsSigner] Initialized. TX_URL=${txUrl || 'N/A'} SVD_URL=${svdUrl || 'N/A'}`);
  }

  /**
   * Sends a batch of signing requests to the KMS with exponential backoff.
   * Expects response: { signatures: [{ signatureHex, pubKeyHex }] }
   * @param {Array<object>} signingRequests
   * @returns {Promise<Array<object>>}
   */
  async signBatch(signingRequests) {
    if (!Array.isArray(signingRequests) || signingRequests.length === 0) return [];
    if (!this.isReady) {
      throw new Error('KMS signer is not configured or ready. Cannot sign transaction.');
    }
    const baseURL = this.axiosTx?.defaults?.baseURL || '';
    if (!this.axiosTx) throw new Error('TX signer endpoint not configured');
    if (baseURL.includes('mock')) {
      throw new Error('KMS signer is in mock mode. Refusing to sign.');
    }

    const body = { requests: signingRequests };
    const maxAttempts = parseInt(process.env.KMS_SIGN_RETRY_ATTEMPTS, 10) || 3;

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.axiosTx.post('/sign', body);
        if (response.data && Array.isArray(response.data.signatures)) {
          return response.data.signatures;
        }
        throw new Error('Invalid response structure from KMS.');
      } catch (err) {
        lastError = err;
        const isAxios = !!err.isAxiosError;
        const status = isAxios ? err.response?.status : undefined;
        const retryable = !isAxios || !status || status >= 500;
        if (retryable && attempt < maxAttempts) {
          const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          logger.warn(`[KmsSigner] Request failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`, { error: err.message });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  /**
   * Derive an SVD shared secret using the KMS without exposing PMS.
   * @param {{ Mhex: string, pmcHex: string }} payload
   * @returns {Promise<{ sharedSecretHex: string, kid?: string }>}
   */
  async svdDeriveSharedSecret(payload) {
    if (!this.isReady) {
      throw new Error('KMS signer is not configured or ready. Cannot derive SVD secret.');
    }
    if (!this.axiosSvd) throw new Error('SVD endpoint not configured');
    const baseURL = this.axiosSvd?.defaults?.baseURL || '';
    if (baseURL.includes('mock')) {
      throw new Error('KMS signer is in mock mode. Refusing to derive SVD secret.');
    }
    if (!payload || !payload.Mhex || !payload.pmcHex) {
      throw new Error('Invalid svdDeriveSharedSecret payload');
    }
    const maxAttempts = parseInt(process.env.KMS_SIGN_RETRY_ATTEMPTS, 10) || 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.axiosSvd.post('/svd/derive-secret', payload);
        if (res.data && typeof res.data.sharedSecretHex === 'string') return res.data;
        throw new Error('Invalid response from KMS svd/derive-secret');
      } catch (err) {
        lastError = err;
        const isAxios = !!err.isAxiosError;
        const status = isAxios ? err.response?.status : undefined;
        const retryable = !isAxios || !status || status >= 500;
        if (retryable && attempt < maxAttempts) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          logger.warn(`[KmsSigner] svdDeriveSharedSecret failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`, { error: err.message });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }
}

module.exports = new KmsSigner();
