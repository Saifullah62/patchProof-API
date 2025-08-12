// services/blockchainService.js
// Production-oriented BSV integration for PatchProof
// - Deterministic issuer key derivation (HD if ISSUER_XPRV is set; otherwise deterministic fallback)
// - ECDSA sign/verify for record hashing
// - Construct and broadcast transactions with OP_RETURN via WhatsOnChain

/**
 * blockchainService.js
 *
 * Responsibilities:
 * - Deterministic hashing/signing helpers for canonical messages (toHashBuf, signHash)
 * - Issuer/funding key handling via KMS (no WIFs in production; dev/test-only WIF guarded)
 * - OP_RETURN transaction construction & signing using selected UTXOs
 * - Safety checks to prevent ambiguous messages and insufficient funds
 */
const bsv = require('bsv');
let stringify;
try {
  // Prefer deterministic stringify for stable hashing
  stringify = require('safe-stable-stringify');
} catch (_) {
  // Fallback: JSON.stringify (not stable across key orders). Consider `npm i safe-stable-stringify`.
  stringify = JSON.stringify;
}
const { Hash, ECDSA } = bsv.crypto;
const crypto = require('crypto');
const { getSecret } = require('../secrets');
const utxoService = require('./utxoService');
const wocClient = require('../clients/wocClient');
const logger = require('../logger');
const kmsSigner = require('./kmsSigner');

// Centralized aliases for readability (no behavior change)
const BsvBN = (bsv.crypto && bsv.crypto.BN) || bsv.BN;
const BsvPrivateKey = bsv.PrivateKey;
const BsvPublicKey = bsv.PublicKey;
const BsvTransaction = bsv.Transaction;
const BsvScript = bsv.Script;
const BsvHDPrivateKey = bsv.HDPrivateKey;

// --- Hashing ---
function computeSha256(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(Buffer.from(json)).digest();
}

// Safe helper: deterministic JSON -> UTF-8 -> single SHA-256 Buffer
function toHashBuf(obj) {
  const json = stringify(obj);
  return Hash.sha256(Buffer.from(json, 'utf8'));
}

// (Removed funding WIF helpers in favor of KMS signing)

// --- Issuer Key Derivation ---
function deriveIssuerChildKey(uid_tag_id) {
  const xprv = getSecret('ISSUER_XPRV');
  if (xprv) {
    try {
      const hd = bsv.HDPrivateKey.fromString(xprv);
      const idx = crypto.createHash('sha256').update(Buffer.from(uid_tag_id)).digest().readUInt32BE(0) >>> 1;
      const child = hd.deriveChild(idx);
      const priv = child.privateKey;
      const pub = priv.publicKey;
      return { keyPair: { privKey: priv.toBuffer(), pubKey: pub.toBuffer() }, priv, pub };
    } catch (e) {
      // fall through
    }
  }
  const seed = getSecret('ISSUER_SEED') || getSecret('MASTER_SECRET') || 'patchproof-default-seed';
  let d = crypto.createHmac('sha256', Buffer.from(seed)).update(Buffer.from(uid_tag_id)).digest();
  while (d.equals(Buffer.alloc(32))) {
    d = crypto.createHash('sha256').update(Buffer.concat([d, Buffer.from('tweak')])).digest();
  }
  // FIX: Use the bsv.crypto.BN constructor which is more stable across versions
  const bn = bsv.crypto.BN.fromBuffer(d);
  const priv = new bsv.PrivateKey(bn);
  const pub = priv.publicKey;
  return { keyPair: { privKey: priv.toBuffer(), pubKey: pub.toBuffer() }, priv, pub };
}

// Deterministic issuer key from MASTER_SECRET (bytes, not hex)
function deriveIssuerKeyFromSecret(secret) {
  const seed = Buffer.from(secret, 'utf8');
  const sk = Hash.sha256(seed); // 32 bytes
  return bsv.PrivateKey.fromBuffer(sk);
}

// --- Sign / Verify ---
function signHash(hashBuf, privKey) {
  if (!hashBuf || !Buffer.isBuffer(hashBuf)) {
    throw new Error('signHash: hashBuf missing or not a Buffer');
  }
  if (!privKey) {
    throw new Error('signHash: privKey is null/undefined');
  }
  const key = privKey instanceof bsv.PrivateKey ? privKey : ensurePrivateKey(privKey);
  const sig = ECDSA.sign(hashBuf, key);
  return sig.toBuffer().toString('hex');
}

function verifySignature(hashBuf, signatureHex, pubKeyHex) {
  try {
    const sig = bsv.crypto.Signature.fromDER(Buffer.from(signatureHex, 'hex'));
    const pub = new bsv.PublicKey(Buffer.from(pubKeyHex, 'hex'));
    return bsv.crypto.ECDSA.verify(hashBuf, sig, pub, 'little');
  } catch (e) {
    return false;
  }
}

function publicKeyHexToAddress(pubKeyHex) {
  const pub = new bsv.PublicKey(Buffer.from(pubKeyHex, 'hex'));
  return pub.toAddress().toString();
}

// Normalize various inputs into a bsv.PrivateKey instance without relying on fromBuffer
function ensurePrivateKey(src) {
  if (!src) throw new Error('No private key provided');
  if (src instanceof bsv.PrivateKey) return src;
  if (src.privateKey instanceof bsv.PrivateKey) return src.privateKey;
  if (src.priv instanceof bsv.PrivateKey) return src.priv;
  if (typeof src === 'string') {
    // Disallow raw WIF usage in production (dev/test convenience only)
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Raw WIF usage is not permitted in production');
    }
    // Dev/test convenience: try WIF
    try { return bsv.PrivateKey.fromWIF(src); } catch (_) {}
  }
  if (src.priv) {
    return ensurePrivateKey(src.priv);
  }
  if (src.privateKey) {
    return ensurePrivateKey(src.privateKey);
  }
  if (src.keyPair && src.keyPair.privKey) {
    const buf = Buffer.isBuffer(src.keyPair.privKey) ? src.keyPair.privKey : Buffer.from(src.keyPair.privKey);
    const bn = bsv.crypto && bsv.crypto.BN ? bsv.crypto.BN.fromBuffer(buf) : null;
    return bn ? new bsv.PrivateKey(bn) : new bsv.PrivateKey(buf);
  }
  // If a buffer itself was passed
  if (Buffer.isBuffer(src)) {
    const bn = bsv.crypto && bsv.crypto.BN ? bsv.crypto.BN.fromBuffer(src) : null;
    return bn ? new bsv.PrivateKey(bn) : new bsv.PrivateKey(src);
  }
  throw new Error('Unsupported private key format');
}

// --- TX Construction (with robust fallbacks) ---
function buildOpReturnScript(chunks) {
    const buffers = chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    if (bsv.Script && typeof bsv.Script.buildSafeDataOut === 'function') {
        return bsv.Script.buildSafeDataOut(buffers);
    }
    if (bsv.Script && typeof bsv.Script.buildDataOut === 'function' && buffers.length === 1) {
        return bsv.Script.buildDataOut(buffers[0]);
    }
    if (bsv.Script && typeof bsv.Script.fromASM === 'function') {
        const asm = ['OP_RETURN', ...buffers.map((b) => b.toString('hex'))].join(' ');
        return bsv.Script.fromASM(asm);
    }
    const script = new bsv.Script();
    try {
        script.add('OP_RETURN');
    } catch (e) {
        const opcodes = (bsv.Script && bsv.Script.opcodes) || (bsv.Opcode);
        const OP_RETURN = opcodes && (opcodes.OP_RETURN || opcodes['OP_RETURN']);
        if (!OP_RETURN) {
            throw new Error('Unable to construct OP_RETURN script: no opcode available');
        }
        script.add(OP_RETURN);
    }
    for (const buf of buffers) {
        script.add(buf);
    }
    return script;
}

// (Removed legacy buildAndSignTx in favor of v2 + KMS signing)

async function broadcastRawTx(rawHex, network = (getSecret('WOC_NETWORK') || 'main')) {
  if (process.env.NODE_ENV === 'test') {
    return { success: true, txid: crypto.createHash('sha256').update(rawHex).digest('hex') };
  }
  const net = (network || 'main').toLowerCase();
  try {
    const txid = await wocClient.broadcast(rawHex, net);
    return { success: true, txid: typeof txid === 'string' ? txid.replace(/"/g, '') : String(txid) };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isMissingInputsError(err) {
  const s = typeof err === 'string' ? err : JSON.stringify(err || '');
  return /missing inputs/i.test(s);
}

// (Removed legacy constructAndBroadcastTx in favor of v2 + KMS signing)

// (Removed legacy constructAndBroadcastTransferTx in favor of v2 + KMS signing)

module.exports = {
  computeSha256,
  toHashBuf,
  deriveIssuerChildKey,
  deriveIssuerKeyFromSecret,
  signHash,
  verifySignature,
  publicKeyHexToAddress,
  broadcastRawTx,
};

// Add a high-level sweep API for administrative consolidation of change UTXOs
async function sweepAddress({ addressToSweep, signingKeyIdentifier, destinationAddress, isDryRun = false }) {
  // Fetch UTXOs via robust client
  const network = (getSecret('WOC_NETWORK') || process.env.WOC_NETWORK || 'main').toLowerCase();
  const utxos = await wocClient.getUnspentOutputs(addressToSweep, 0);

  if (utxos.length === 0) {
    return { success: true, utxosSwept: [], totalSatoshis: 0, estimatedFee: 0, finalAmount: 0, dryRun: !!isDryRun };
  }

  // Build transaction
  const tx = new bsv.Transaction();
  let totalSatoshis = 0;
  for (const u of utxos) {
    const vout = u.tx_pos != null ? u.tx_pos : u.vout;
    const sat = u.value != null ? u.value : u.satoshis;
    const scriptHex = bsv.Script.buildPublicKeyHashOut(addressToSweep).toHex();
    tx.from({ txid: u.tx_hash || u.txid, vout, scriptPubKey: scriptHex, script: scriptHex, satoshis: sat });
    totalSatoshis += sat;
  }

  // Use centralized fee policy
  const feePerKb = parseInt(process.env.FEE_PER_KB || '500', 10);
  tx.to(destinationAddress, Math.max(0, totalSatoshis - 1)); // placeholder; adjusted after fee
  tx.change(destinationAddress);
  tx.feePerKb(feePerKb);

  // Recompute send amount based on estimated fee
  const estimatedFee = tx.getFee();
  const finalAmount = totalSatoshis - estimatedFee;
  if (finalAmount <= 0) {
    return { success: false, error: 'Insufficient funds after fees', utxosSwept: utxos, totalSatoshis, estimatedFee, finalAmount: 0 };
  }

  // Rebuild outputs precisely
  const tx2 = new bsv.Transaction();
  for (const u of utxos) {
    const vout = u.tx_pos != null ? u.tx_pos : u.vout;
    const sat = u.value != null ? u.value : u.satoshis;
    const scriptHex = bsv.Script.buildPublicKeyHashOut(addressToSweep).toHex();
    tx2.from({ txid: u.tx_hash || u.txid, vout, scriptPubKey: scriptHex, script: scriptHex, satoshis: sat });
  }
  tx2.to(destinationAddress, finalAmount);
  tx2.change(destinationAddress);
  tx2.feePerKb(feePerKb);

  // Create signing requests for KMS (no private keys in codebase)
  const flags = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
  const signingRequests = tx2.inputs.map((input, index) => {
    const sighash = tx2
      .sighashForUTXO(index, input.output.script, input.output.satoshis, flags)
      .toString('hex');
    return { keyIdentifier: signingKeyIdentifier, sighash };
  });

  const signatures = await kmsSigner.signBatch(signingRequests);
  // Expect array aligned to inputs: [{ signatureHex, pubKeyHex }]
  module.exports.v2.applySignatures(tx2, signatures);

  const rawHex = tx2.serialize();

  if (isDryRun) {
    return {
      success: true,
      dryRun: true,
      utxosSwept: utxos,
      totalSatoshis,
      estimatedFee: tx2.getFee(),
      finalAmount,
    };
  }

  const res = await broadcastRawTx(rawHex, network);
  if (res.success) {
    return { success: true, txid: res.txid, utxosSwept: utxos, totalSatoshis, estimatedFee: tx2.getFee(), finalAmount };
  }
  return { success: false, error: res.error, utxosSwept: utxos, totalSatoshis, estimatedFee: tx2.getFee(), finalAmount };
}

module.exports.sweepAddress = sweepAddress;

// --- Key-agnostic, production-grade v2 service ---
// This cohesive service prepares transactions and delegates signing to an external KMS.
// It centralizes wocClient usage and avoids any raw private key handling.
let stableStringify;
try {
  stableStringify = require('safe-stable-stringify');
} catch (_) {
  stableStringify = JSON.stringify;
}
const extErrors = (() => { try { return require('../errors'); } catch (_) { return {}; } })();
class ServiceUnavailableError extends (extErrors.ServiceUnavailableError || Error) {}
class InsufficientFundsError extends (extErrors.InsufficientFundsError || Error) {}

class BlockchainServiceV2 {
  constructor() {
    this.network = (process.env.WOC_NETWORK || 'main').toLowerCase();
    this.feePerKb = parseInt(process.env.FEE_PER_KB, 10) || 512;
    logger.info(`[BlockchainServiceV2] Initialized for network: ${this.network} fee=${this.feePerKb} sat/kb`);
  }

  toHashBuf(obj) {
    const json = stableStringify(obj);
    return bsv.crypto.Hash.sha256(Buffer.from(json, 'utf8'));
  }

  verifySignature(hashBuf, signatureHex, pubKeyHex) {
    try {
      const sig = bsv.crypto.Signature.fromDER(Buffer.from(signatureHex, 'hex'));
      const pub = new bsv.PublicKey(Buffer.from(pubKeyHex, 'hex'));
      return bsv.crypto.ECDSA.verify(hashBuf, sig, pub, 'little');
    } catch (e) {
      logger.warn('[BlockchainServiceV2] Signature verification failed', e);
      return false;
    }
  }

  buildOpReturnTransaction(utxos, opReturnData, changeAddress) {
    if (!Array.isArray(utxos) || utxos.length === 0) {
      throw new InsufficientFundsError('No UTXOs provided to build the transaction.');
    }
    const tx = new bsv.Transaction();
    let total = 0;
    for (const u of utxos) {
      tx.from({
        txid: u.txid,
        vout: u.vout,
        scriptPubKey: u.scriptPubKey,
        satoshis: u.satoshis,
      });
      total += u.satoshis;
    }
    const dataScript = bsv.Script.buildSafeDataOut(opReturnData);
    tx.addOutput(new bsv.Transaction.Output({ script: dataScript, satoshis: 0 }));
    tx.change(changeAddress);
    tx.feePerKb(this.feePerKb);
    const fee = tx.getFee();
    if (total < fee) {
      throw new InsufficientFundsError(`Total funds (${total}) are less than the estimated fee (${fee}).`);
    }
    const signingHashes = tx.inputs.map((input, index) => ({
      keyIdentifier: utxos[index].keyIdentifier,
      sighash: tx.sighashForUTXO(
        index,
        input.output.script,
        input.output.satoshis,
        bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID,
      ).toString('hex'),
    }));
    return { transaction: tx, signingHashes };
  }

  applySignatures(transaction, signatures) {
    for (let i = 0; i < signatures.length; i++) {
      const { signatureHex, pubKeyHex } = signatures[i];
      const signature = bsv.crypto.Signature.fromDER(Buffer.from(signatureHex, 'hex'));
      const pubKey = new bsv.PublicKey(Buffer.from(pubKeyHex, 'hex'));
      transaction.inputs[i].setScript(bsv.Script.buildPublicKeyHashIn(pubKey, signature));
    }
    return transaction;
  }

  async broadcast(rawTxHex) {
    try {
      const result = await wocClient.broadcast(rawTxHex, this.network);
      if (!result || typeof result !== 'string') throw new Error('Invalid broadcast response');
      return result.replace(/"/g, '');
    } catch (err) {
      logger.error('[BlockchainServiceV2] Broadcast failed', err);
      throw new ServiceUnavailableError(`Broadcast failed: ${err.message}`);
    }
  }
}

module.exports.v2 = new BlockchainServiceV2();
