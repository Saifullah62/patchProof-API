// routes/internalSigner.route.js
// Minimal internal signer route: holds WIF in memory, gated by API key. DO NOT EXPOSE PUBLICLY.
const express = require('express');
const crypto = require('crypto');
const bsv = require('bsv');

const router = express.Router();

const SIGN_API_KEY = process.env.KMS_API_KEY; // reuse KMS_API_KEY for simplicity
const PRIV_WIF = process.env.SIGNER_PRIV_WIF; // present only on the signer host
const NETWORK = (process.env.WOC_NETWORK || 'main') === 'main'
  ? bsv.Networks.mainnet
  : bsv.Networks.testnet;

if (!PRIV_WIF) {
  throw new Error('SIGNER_PRIV_WIF missing (required to enable internal signer)');
}

const priv = bsv.PrivateKey.fromWIF(PRIV_WIF);
const pub = priv.publicKey;
const address = pub.toAddress(NETWORK).toString();
const pubkeyHex = pub.toBuffer(true).toString('hex'); // compressed hex

function authed(req, res, next) {
  const headerAuth = String(req.header('authorization') || '');
  const bearer = headerAuth.startsWith('Bearer ')
    ? headerAuth.slice('Bearer '.length)
    : '';
  const got = String(req.header('x-api-key') || bearer || '');
  const want = String(SIGN_API_KEY || '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (!want || a.length !== b.length) return res.status(401).json({ error: 'unauthorized' });
  try {
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  } catch (_) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.get('/pubkey', authed, (_req, res) => {
  res.json({ compressedPubkeyHex: pubkeyHex, address });
});

// Batch-compatible sign endpoint for KmsSigner.signBatch
// Accepts either { requests: [{ sighash, keyIdentifier? }, ...] } or { hashHex }
router.post('/sign', authed, (req, res) => {
  const body = req.body || {};
  const toSign = [];

  if (Array.isArray(body.requests)) {
    for (const r of body.requests) {
      if (r && typeof r.sighash === 'string' && /^[0-9a-fA-F]{64}$/.test(r.sighash)) {
        toSign.push(r.sighash);
      }
    }
  } else if (typeof body.hashHex === 'string' && /^[0-9a-fA-F]{64}$/.test(body.hashHex)) {
    toSign.push(body.hashHex);
  }

  if (toSign.length === 0) {
    return res.status(400).json({ error: 'No valid hashes provided. Expect { requests: [{ sighash }] } or { hashHex }' });
  }

  try {
    const signatures = toSign.map((hashHex) => {
      const sig = bsv.crypto.ECDSA
        .sign(Buffer.from(hashHex, 'hex'), priv, 'big')
        .set({ lowS: true });
      return {
        signatureHex: sig.toDER().toString('hex'),
        pubKeyHex: pubkeyHex,
      };
    });
    res.json({ signatures });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
