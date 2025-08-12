// services/svdService.js
// Secret Value Distribution (SVD) helper for passwordless auth and function-scoped secrets.
// Implements a Phase I/II-style flow using bsv:
//  - Register a user's master public key (PMC)
//  - Issue short-lived challenge M
//  - Verify signature using V2C derived from PMC and M
//  - Derive P2S from server PMS and M
//  - Compute shared secret S via ECDH (never transmitted)

const crypto = require('crypto');
const bsv = require('bsv');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const SvdRegistry = require('../models/SvdRegistry');
const { getSecret } = require('../secrets'); // falls back to env inside your project
const { SvdReplayError, SvdExpiredError, SvdInvalidSignatureError, SvdBadChallengeError, SvdNoPmcError } = require('../errors');

const replayCacheRedis = require('./svdReplayCacheRedis');
const challengeCache = require('./svdChallengeCacheRedis');
const metrics = require('./svdMetrics');
const logger = require('../logger');
const kmsSigner = require('./kmsSigner');
const DEPLOY_SHA = process.env.DEPLOY_SHA || process.env.COMMIT_SHA || 'unknown';

// Lifecycle-managed SVD service
class SvdService {
  constructor() {
    this.JWT_SECRET = null;
    this.SERVER_PMS = null; // bsv.PrivateKey
    this.SERVER_PUBLIC_KEY_HEX = null;
    this.ACTIVE_KID = null;
    this.CHALLENGE_TTL_SEC = 180;
    this.CLOCK_SKEW_SEC = 30;
    this.isReady = false;
    this.useKmsForSvd = false;
  }

  initialize() {
    if (this.isReady) return;
    const jwtSecret = typeof getSecret === 'function' ? getSecret('JWT_SECRET') : process.env.JWT_SECRET;
    const pmsWif = typeof getSecret === 'function' ? getSecret('SVD_SERVER_PMS_WIF') : process.env.SVD_SERVER_PMS_WIF;
    // Prefer KMS in production. Allow local PMS only outside production or when KMS is unavailable and explicitly configured.
    const forceKms = String(process.env.SVD_USE_KMS || '').toLowerCase() === '1';
    const kmsReady = !!kmsSigner && kmsSigner.isReady && (process.env.KMS_SIGN_URL && process.env.KMS_SIGN_URL !== 'mock');
    this.useKmsForSvd = forceKms || (process.env.NODE_ENV === 'production' ? kmsReady : kmsReady);
    if (process.env.NODE_ENV === 'production') {
      if (!jwtSecret) {
        logger.error('[SvdService] FATAL: Missing JWT_SECRET');
        process.exit(1);
      }
      if (!this.useKmsForSvd) {
        logger.error('[SvdService] FATAL: SVD requires KMS in production (configure KMS_SIGN_URL).');
        process.exit(1);
      }
    }
    this.JWT_SECRET = jwtSecret || null;
    try {
      if (!this.useKmsForSvd && pmsWif) {
        // Non-production local PMS fallback
        this.SERVER_PMS = bsv.PrivateKey.fromWIF(pmsWif);
        this.SERVER_PUBLIC_KEY_HEX = this.SERVER_PMS.publicKey.toString();
        const pubKeyHash = sha256Hex(Buffer.from(this.SERVER_PUBLIC_KEY_HEX, 'utf8'));
        this.ACTIVE_KID = `svd-${pubKeyHash.slice(0, 16)}`;
      } else if (this.useKmsForSvd) {
        // Defer PMS details to KMS; ACTIVE_KID will be provided per-operation or configured separately
        this.SERVER_PMS = null;
        this.SERVER_PUBLIC_KEY_HEX = null;
        this.ACTIVE_KID = process.env.SVD_KMS_KID || 'svd-kms';
      }
    } catch (err) {
      logger.error('[SvdService] FATAL: Invalid SVD_SERVER_PMS_WIF', err);
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }
    this.CHALLENGE_TTL_SEC = parseInt(process.env.SVD_CHALLENGE_TTL_SEC || '180', 10);
    this.CLOCK_SKEW_SEC = parseInt(process.env.SVD_CLOCK_SKEW_SEC || '30', 10);
    this.isReady = true;
    logger.info(`[SvdService] Initialized. Active KID: ${this.ACTIVE_KID || 'unknown'}`);
  }

  getActiveKid() { return this.ACTIVE_KID; }

  async registerPMC(userId, pmcHex) {
    this._validatePmcHex(pmcHex);
    await SvdRegistry.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      { $set: { pmcHex } },
      { upsert: true, new: true }
    );
    return true;
  }

  async begin(userId) {
    if (!this.isReady) throw new Error('SvdService is not ready.');
    const M = makeM();
    const Mhex = M.toString('hex');
    await challengeCache.set(userId, Mhex, this.CHALLENGE_TTL_SEC);
    const svd = await SvdRegistry.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    try { metrics.inc('begin', { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA }); } catch (_) {}
    return { M: Mhex, pmcHex: svd?.pmcHex || null };
  }

  async complete({ userId, Mhex, signatureHex }) {
    if (!this.isReady) throw new Error('SvdService is not ready.');
    if (!this.useKmsForSvd && !this.SERVER_PMS) throw new Error('Server PMS not configured');
    const reg = await SvdRegistry.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    if (!reg || !reg.pmcHex) throw new SvdNoPmcError('User has no registered PMC');

    const Mbuf = Buffer.from(Mhex, 'hex');
    const mDigestHex = sha256Hex(Mbuf);
    const firstSeen = await replayCacheRedis.addIfNotExists(mDigestHex);
    if (!firstSeen) { try { metrics.inc('replayed', { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA }); } catch (_) {} throw new SvdReplayError(); }

    const issuedM = await challengeCache.get(userId);
    if (!issuedM) { try { metrics.inc('expired', { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA }); } catch (_) {} throw new SvdExpiredError('No active challenge'); }
    if (issuedM !== Mhex) throw new SvdBadChallengeError('Challenge mismatch');

    const V2C = deriveV2FromPMC(reg.pmcHex, Mbuf);
    const sig = bsv.crypto.Signature.fromDER(Buffer.from(signatureHex, 'hex'));
    const msgHash = sha256(Mbuf);
    const n = bsv.crypto.Point.getN();
    if (sig.s.gt(n.shrn(1))) { try { metrics.inc('malleable_reject', { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA }); } catch (_) {} throw new SvdInvalidSignatureError('Non-canonical signature'); }
    const ok = bsv.crypto.ECDSA.verify(msgHash, sig, V2C);
    if (!ok) { try { metrics.inc('invalid', { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA }); } catch (_) {} throw new SvdInvalidSignatureError('SVD signature invalid'); }

    let S;
    if (this.useKmsForSvd) {
      // Delegate secret derivation to KMS
      const resp = await kmsSigner.svdDeriveSharedSecret({ Mhex, pmcHex: reg.pmcHex });
      if (!resp || !resp.sharedSecretHex) throw new Error('KMS SVD derivation failed');
      if (resp.kid && !this.ACTIVE_KID) this.ACTIVE_KID = resp.kid;
      S = Buffer.from(resp.sharedSecretHex, 'hex');
    } else {
      const P2S = deriveP2FromPMS(this.SERVER_PMS.toWIF(), Mbuf);
      const pmsPubBuf = this.SERVER_PMS.publicKey.toBuffer();
      const pmcPubBuf = Buffer.from(reg.pmcHex, 'hex');
      S = deriveSharedSecret(P2S, V2C, { pmsPubBuf, pmcPubBuf, Mbuf });
    }

    const token = this._issueJwtForUser(userId, S, { mDigestHex, kid: this.ACTIVE_KID || 'unknown' });
    // Single-use: invalidate the challenge immediately upon success
    try { await challengeCache.del(userId); } catch (_) {}
    try { metrics.inc('complete', { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA }); } catch (_) {}
    try { logger.info({ message: 'svd complete', tags: { kid: this.ACTIVE_KID || 'unknown', sha: DEPLOY_SHA } }); } catch (_) {}
    try { msgHash.fill(0); } catch (_) {}
    return { token };
  }

  _validatePmcHex(pmcHex) {
    if (typeof pmcHex !== 'string' || !/^[0-9a-fA-F]{66}$/i.test(pmcHex)) throw new Error('pmcHex must be 33-byte compressed SEC hex');
    const buf = Buffer.from(pmcHex, 'hex');
    if (buf.length !== 33 || (buf[0] !== 0x02 && buf[0] !== 0x03)) throw new Error('pmcHex must be compressed secp256k1 point');
    try { const pub = bsv.PublicKey.fromBuffer(buf); if (!pub || !pub.point || pub.point.isInfinity()) throw new Error('invalid'); } catch (_) { throw new Error('pmcHex invalid'); }
  }

  _issueJwtForUser(userId, Sbuf, { mDigestHex, kid }) {
    const nowSec = Math.floor(Date.now() / 1000);
    // Derive a non-sensitive proof bound to user and mDigest; do not include raw shared secret in JWT
    const proofSalt = sha256(Buffer.concat([Buffer.from(String(userId)), Buffer.from(mDigestHex, 'hex')]));
    const svdProof = hkdf(Sbuf, 'JWT-Token', proofSalt).toString('hex');
    const payload = { sub: String(userId), jti: mDigestHex, cnf: { msha256: mDigestHex, svd_proof: svdProof }, iat: nowSec, nbf: nowSec - this.CLOCK_SKEW_SEC };
    const header = kid ? { kid } : undefined;
    return jwt.sign(payload, this.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m', header });
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}
function sha256Hex(buf) {
  return sha256(buf).toString('hex');
}

function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === 'string') {
    const hexish = /^[0-9a-fA-F]+$/;
    if (hexish.test(x) && x.length % 2 === 0) return Buffer.from(x, 'hex');
    return Buffer.from(x, 'utf8');
  }
  if (x == null) return Buffer.alloc(0);
  return Buffer.from(String(x), 'utf8');
}

// Deterministic message M: 8 bytes unix time || 16 bytes random
function makeM() {
  const unix = Buffer.alloc(8);
  unix.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const rnd = crypto.randomBytes(16);
  return Buffer.concat([unix, rnd]);
}

// Derive V2 (client public) from PMC and M: V2 = PMC + H(M)*G
function deriveV2FromPMC(pmcHex, M) {
  const PMC = bsv.PublicKey.fromString(pmcHex);
  const mHash = sha256(toBuffer(M));
  const bnH = new bsv.crypto.BN(mHash);
  const G = bsv.crypto.Point.getG();
  const V2 = PMC.point.add(G.mul(bnH));
  return bsv.PublicKey.fromPoint(V2);
}

// Derive P2 (server private) from PMS and M: P2 = PMS + H(M) mod n
function deriveP2FromPMS(pmsWIF, M) {
  const PMS = bsv.PrivateKey.fromWIF(pmsWIF);
  const mHash = sha256(toBuffer(M));
  const bnH = new bsv.crypto.BN(mHash);
  const n = bsv.crypto.Point.getN();
  const p2 = PMS.bn.add(bnH).umod(n);
  if (p2.isZero()) throw new Error('Derived server scalar invalid');
  return new bsv.PrivateKey(p2);
}

// ECDH x-coordinate of (a * B)
function ecdhX(privKey, pubKey) {
  const P = pubKey.point.mul(privKey.bn);
  const x = P.getX();
  return x.toBuffer({ size: 32 });
}

// HKDF-lite expansion of the x-coordinate for a stable 32-byte session key
function deriveSharedSecret(P2S, V2C, { pmsPubBuf, pmcPubBuf, Mbuf }) {
  // ECDH: S = x( V2C * p2s_priv ) or equivalent shared point; P2S is a bsv.PrivateKey
  const Spoint = V2C.point.mul(P2S.bn);
  if (!Spoint || Spoint.isInfinity()) throw new Error('Shared secret invalid');
  const x = Spoint.getX().toBuffer();
  // HKDF with context binding for domain separation, salted to principals + challenge
  const salt = sha256(Buffer.concat([pmsPubBuf, pmcPubBuf, Mbuf]));
  return hkdf(x, 'SVD-Session', salt);
}

function hkdf(x, infoLabel, salt) {
  const prk = crypto.createHmac('sha256', salt).update(x).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.from(infoLabel)).digest();
}

// Simple hierarchical helpers for clients/servers that want linked challenges (kept for potential internal use)
function advanceM(M) { return sha256(toBuffer(M)); }
function forkM(M, label) { return sha256(Buffer.concat([toBuffer(M), toBuffer(label || '')])); }

module.exports = new SvdService();
