// services/cryptoService.js
// Centralized cryptography utilities and secret management

const crypto = require('crypto');
const logger = require('../logger');

const MASTER_SECRET = process.env.MASTER_SECRET;

// Fail-fast in production if the master secret is missing
if (process.env.NODE_ENV === 'production' && !MASTER_SECRET) {
  logger.error('[CryptoService] FATAL: MASTER_SECRET is not defined. The service cannot run securely.');
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}

/**
 * Derive a key via HKDF-SHA256.
 * If `secret` is null/undefined, uses MASTER_SECRET from env.
 * @param {string|Buffer|null|undefined} secret
 * @param {string|Buffer} salt
 * @param {string|Buffer} info
 * @param {number} length
 * @returns {Buffer}
 */
function hkdfSha256(secret, salt, info, length = 32) {
  const inputKey = secret ?? MASTER_SECRET;
  if (!inputKey) {
    throw new Error('HKDF secret is missing.');
  }
  return crypto.hkdfSync('sha256', inputKey, Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt)), Buffer.isBuffer(info) ? info : Buffer.from(String(info)), length);
}

/**
 * AES-256-GCM decryption helper.
 * Expects dataBuf = ciphertext || authTag (last 16 bytes)
 * @param {Buffer} keyBuf
 * @param {Buffer} ivBuf
 * @param {Buffer} dataBuf
 * @returns {Buffer}
 */
function aesGcmDecrypt(keyBuf, ivBuf, dataBuf) {
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
    throw new Error('Invalid key: AES-256-GCM requires 32-byte key');
  }
  if (!Buffer.isBuffer(ivBuf) || ivBuf.length < 12) {
    throw new Error('Invalid IV: recommended length is 12 bytes');
  }
  if (!Buffer.isBuffer(dataBuf) || dataBuf.length < 16) {
    throw new Error('Invalid ciphertext: too short to contain auth tag');
  }
  const tag = dataBuf.subarray(dataBuf.length - 16);
  const enc = dataBuf.subarray(0, dataBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
  decipher.setAuthTag(tag);
  const p1 = decipher.update(enc);
  const p2 = decipher.final();
  return Buffer.concat([p1, p2]);
}

module.exports = {
  hkdfSha256,
  aesGcmDecrypt,
};
