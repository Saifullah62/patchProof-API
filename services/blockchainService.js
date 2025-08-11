// services/blockchainService.js
// Production-oriented BSV integration for PatchProof
// - Deterministic issuer key derivation (HD if ISSUER_XPRV is set; otherwise deterministic fallback)
// - ECDSA sign/verify for record hashing
// - Construct and broadcast transactions with OP_RETURN via WhatsOnChain

const https = require('https');
const bsv = require('bsv');
const crypto = require('crypto');
const { getSecret } = require('../secrets');
const utxoService = require('./utxoService');

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

// --- Sign / Verify ---
function signHash(hashBuf, keyPairOrPriv) {
  const priv = keyPairOrPriv.priv || keyPairOrPriv.privateKey || (keyPairOrPriv.keyPair && keyPairOrPriv.keyPair.privKey)
    ? (keyPairOrPriv.priv || keyPairOrPriv.privateKey || new bsv.PrivateKey(bsv.crypto.BN.fromBuffer(keyPairOrPriv.keyPair.privKey)))
    : null;
  const privateKey = priv instanceof bsv.PrivateKey ? priv : new bsv.PrivateKey(bsv.crypto.BN.fromBuffer(priv));
  const sig = bsv.crypto.ECDSA.sign(hashBuf, privateKey, 'little').set({ nhashtype: bsv.crypto.Signature.SIGHASH_ALL });
  return sig.toDER().toString('hex');
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
    // Try WIF
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

async function buildAndSignTx(opReturnData, purpose) {
  const estimatedFee = 1000;
  const utxos = await utxoService.selectAndLockUtxos(estimatedFee);
  if (!utxos || utxos.length === 0) {
    throw new Error('Funding UTXOs are not available or insufficient');
  }

  try {
    const dataScript = buildOpReturnScript(opReturnData);
    const tx = new bsv.Transaction();
    const signingKeys = [];

    for (const utxo of utxos) {
      let privKey;
      try {
        privKey = bsv.PrivateKey.fromWIF(utxo.privKeyWIF);
      } catch (e) {
        if (process.env.NODE_ENV === 'test') {
          privKey = new bsv.PrivateKey();
        } else {
          throw e;
        }
      }
      tx.from({ txId: utxo.txid, outputIndex: utxo.vout, script: utxo.scriptPubKey, satoshis: utxo.satoshis });
      signingKeys.push(privKey);
    }

    const changeAddr = getSecret('UTXO_CHANGE_ADDRESS') || signingKeys[0].toAddress().toString();

    tx.addOutput(new bsv.Transaction.Output({ script: dataScript, satoshis: 0 }));
    tx.change(changeAddr);
    tx.feePerKb(500);

    for (let i = 0; i < signingKeys.length; i++) {
      tx.sign(signingKeys[i]);
    }

    const rawHex = tx.serialize();
    const txid = typeof tx.hash === 'function' ? tx.hash() : tx.hash;

    const changeOutput = tx.outputs.find(o => o.script && typeof o.script.toAddress === 'function' && o.script.toAddress().toString() === changeAddr);
    const newChangeUtxo = changeOutput && changeOutput.satoshis > 0 ? {
      txid: txid,
      vout: tx.outputs.indexOf(changeOutput),
      satoshis: changeOutput.satoshis,
      scriptPubKey: changeOutput.script.toHex(),
      privKeyWIF: utxos[0].privKeyWIF,
    } : null;

    return { rawHex, txid, spentUtxos: utxos, newChangeUtxo };
  } catch (error) {
    await utxoService.unlockUtxos(utxos);
    throw error;
  }
}

function broadcastRawTx(rawHex, network = (getSecret('WOC_NETWORK') || 'main')) {
  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve({
      success: true,
      txid: crypto.createHash('sha256').update(rawHex).digest('hex'),
    });
  }
  const net = network.toLowerCase() === 'test' ? 'test' : 'main';
  const path = `/v1/bsv/${net}/tx/raw`;
  const options = {
    hostname: 'api.whatsonchain.com',
    port: 443,
    path,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const txid = typeof body === 'string' ? body : (body && (body.txid || body.id || body.result)) || String(body);
            resolve({ success: true, txid });
          } else {
            resolve({ success: false, error: body || data });
          }
        } catch (_) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, txid: (data || '').replace(/"/g, '') });
          } else {
            resolve({ success: false, error: data });
          }
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(JSON.stringify({ txhex: rawHex }));
    req.end();
  });
}

async function constructAndBroadcastTx(opReturnData, purpose, log) {
  const { rawHex, txid, spentUtxos, newChangeUtxo } = await buildAndSignTx(opReturnData, purpose);
  if (log) log.info({ message: 'Broadcasting tx', purpose, txid });
  const res = await broadcastRawTx(rawHex);
  if (res.success) {
    await utxoService.spendUtxos(spentUtxos);
    if (newChangeUtxo) {
      await utxoService.addUtxo(newChangeUtxo);
    }
    return { success: true, txid };
  }
  // On broadcast failure, unlock so it can be reused
  await utxoService.unlockUtxos(spentUtxos);
  return { success: false, error: res.error };
}

async function constructAndBroadcastTransferTx(currentTxid, newOwnerAddress, currentOwnerSignature, opReturnData, log) {
  const data = [...opReturnData, Buffer.from(`REF:${currentTxid}`)];
  if (log) log.info({ message: 'Broadcasting transfer', currentTxid, newOwnerAddress });
  return await constructAndBroadcastTx(data, 'Transfer', log);
}

module.exports = {
  computeSha256,
  deriveIssuerChildKey,
  signHash,
  verifySignature,
  publicKeyHexToAddress,
  constructAndBroadcastTx,
  constructAndBroadcastTransferTx,
};
