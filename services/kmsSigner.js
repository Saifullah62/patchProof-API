// services/kmsSigner.js
// A robust, production-grade KMS signer client using axios for reliable HTTP requests.
const axios = require('axios');
const logger = require('../logger');

class KmsSigner {
  constructor() {
    this.axiosInstance = null;
    this.isReady = false;
  }

  /**
   * Initializes the KmsSigner. Must be called at application startup.
   */
  initialize() {
    const kmsUrl = process.env.KMS_SIGN_URL;
    const apiKey = process.env.KMS_API_KEY;

    if (!kmsUrl) {
      logger.warn('[KmsSigner] KMS_SIGN_URL is not configured. Signing will be disabled.');
      this.isReady = false;
      return;
    }
    if (kmsUrl === 'mock') {
      logger.warn('[KmsSigner] KMS signer is in mock mode. It will refuse to sign.');
      this.isReady = true; // Ready, but will throw on use.
      this.axiosInstance = axios.create({ baseURL: kmsUrl });
      return;
    }

    this.axiosInstance = axios.create({
      baseURL: kmsUrl,
      timeout: parseInt(process.env.KMS_SIGN_TIMEOUT_MS, 10) || 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
      },
    });

    this.isReady = true;
    logger.info(`[KmsSigner] Initialized for KMS endpoint: ${kmsUrl}`);
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
    const baseURL = this.axiosInstance?.defaults?.baseURL || '';
    if (baseURL.includes('mock')) {
      throw new Error('KMS signer is in mock mode. Refusing to sign.');
    }

    const body = { requests: signingRequests };
    const maxAttempts = parseInt(process.env.KMS_SIGN_RETRY_ATTEMPTS, 10) || 3;

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.axiosInstance.post('/sign', body);
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
    const baseURL = this.axiosInstance?.defaults?.baseURL || '';
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
        const res = await this.axiosInstance.post('/svd/derive-secret', payload);
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
