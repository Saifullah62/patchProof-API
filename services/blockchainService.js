// services/blockchainService.js
// Production-oriented BSV integration for PatchProof
// - Deterministic issuer key derivation (HD if ISSUER_XPRV is set; otherwise deterministic fallback)
// - ECDSA sign/verify for record hashing
// - Construct and broadcast transactions with OP_RETURN via WhatsOnChain

const https = require('https');
const bsv = require('bsv');
const crypto = require('crypto');
const { getSecret } = require('../secrets');
const utxoConfig = require('../utxoConfig');

// --- Hashing ---
function computeSha256(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return bsv.crypto.Hash.sha256(Buffer.from(json));
}

// --- Issuer Key Derivation ---
function deriveIssuerChildKey(uid_tag_id) {
  const xprv = getSecret('ISSUER_XPRV');
  if (xprv) {
    try {
      const hd = bsv.HDPrivateKey.fromString(xprv);
      // Derive a child index from the first 31 bits of the uid hash (keeps index < 2^31)
      const idx = bsv.crypto.Hash.sha256(Buffer.from(uid_tag_id)).readUInt32BE(0) >>> 1;
      const child = hd.deriveChild(idx);
      const priv = child.privateKey;
      const pub = priv.publicKey;
      return { keyPair: { privKey: Buffer.from(priv.toBuffer()), pubKey: Buffer.from(pub.toBuffer()) }, priv, pub };
    } catch (e) {
      // fall through to deterministic fallback
    }
  }
  // Deterministic fallback (not as secure as HD): derive private key from HMAC(uid)
  const seed = getSecret('ISSUER_SEED') || 'patchproof-default-seed';
  let d = bsv.crypto.Hash.sha256hmac(Buffer.from(seed), Buffer.from(uid_tag_id));
  // Ensure d within curve range; if zero, tweak
  while (d.equals(Buffer.alloc(32))) {
    d = bsv.crypto.Hash.sha256(Buffer.concat([d, Buffer.from('tweak')]));
  }
  const priv = bsv.PrivateKey.fromBuffer(d);
  const pub = priv.publicKey;
  return { keyPair: { privKey: Buffer.from(priv.toBuffer()), pubKey: Buffer.from(pub.toBuffer()) }, priv, pub };
}

// --- Sign / Verify ---
function signHash(hashBuf, keyPairOrPriv) {
  const priv = keyPairOrPriv.priv || keyPairOrPriv.privateKey || (keyPairOrPriv.keyPair && keyPairOrPriv.keyPair.privKey)
    ? (keyPairOrPriv.priv || keyPairOrPriv.privateKey || bsv.PrivateKey.fromBuffer(keyPairOrPriv.keyPair.privKey))
    : null;
  const privateKey = priv instanceof bsv.PrivateKey ? priv : bsv.PrivateKey.fromBuffer(priv);
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

// --- TX Construction ---
function buildOpReturnScript(chunks) {
  const script = new bsv.Script();
  script.add(bsv.Opcode.OP_RETURN);
  for (const c of chunks) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    script.add(buf);
  }
  return script;
}

function buildAndSignTx(opReturnData, purpose) {
  const { utxo, privKeyWIF, changeAddress } = utxoConfig;
  if (!utxo || !utxo.txid || utxo.vout == null || !utxo.satoshis || !utxo.scriptPubKey) {
    throw new Error('Funding UTXO is not fully configured');
  }
  if (!privKeyWIF) throw new Error('privKeyWIF is not configured');

  const privKey = bsv.PrivateKey.fromWIF(privKeyWIF);
  const changeAddr = changeAddress || privKey.toAddress().toString();

  const dataScript = buildOpReturnScript(opReturnData);

  const tx = new bsv.Transaction()
    .from({ txId: utxo.txid, outputIndex: utxo.vout, script: utxo.scriptPubKey, satoshis: utxo.satoshis })
    .addOutput(new bsv.Transaction.Output({ script: dataScript, satoshis: 0 }))
    .change(changeAddr)
    .feePerKb(500); // ~0.5 sat/byte

  tx.sign(privKey);
  const rawHex = tx.serialize();
  const txid = tx.hash;
  return { rawHex, txid };
}

function broadcastRawTx(rawHex, network = (getSecret('WOC_NETWORK') || 'main')) {
  const net = network.toLowerCase() === 'test' ? 'test' : 'main';
  const path = `/v1/bsv/${net}/tx/raw`; // POST body: rawtx hex string
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
  const { rawHex, txid } = buildAndSignTx(opReturnData, purpose);
  if (log) log.info({ message: 'Broadcasting tx', purpose, txid });
  const res = await broadcastRawTx(rawHex);
  if (!res.success) return { success: false, error: res.error };
  return { success: true, txid };
}

async function constructAndBroadcastTransferTx(currentTxid, newOwnerAddress, currentOwnerSignature, opReturnData, log) {
  // For now, construct a new OP_RETURN-only tx similar to registration, with transfer metadata
  const data = [...opReturnData, Buffer.from(`REF:${currentTxid}`)];
  const { rawHex, txid } = buildAndSignTx(data, 'Transfer');
  if (log) log.info({ message: 'Broadcasting transfer', currentTxid, newOwnerAddress, txid });
  const res = await broadcastRawTx(rawHex);
  if (!res.success) return { success: false, error: res.error };
  return { success: true, txid };
}

module.exports = {
  computeSha256,
  deriveIssuerChildKey,
  signHash,
  verifySignature,
  constructAndBroadcastTx,
  constructAndBroadcastTransferTx,
};
