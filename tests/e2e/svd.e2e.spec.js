/*
 E2E SVD (mainnet, no mocks)
 Requires:
 - BASE_URL (server already running)
 - E2E_MAINNET=1 (guard)
 - Server configured for KMS (no WIFs), Redis, Mongo
*/

const bsv = require('bsv');

const BASE_URL = process.env.BASE_URL;

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: { 'content-type': 'application/json', ...(opts.headers||{}) }, ...opts });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  return { ok: res.ok, status: res.status, headers: res.headers, body };
}

function randomUserId() {
  return `e2e-user-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
}

function deriveCompressedPubHexFromWIF(wif) {
  const priv = bsv.PrivateKey.fromWIF(wif);
  const pub = priv.toPublicKey();
  // compressed buffer
  const buf = pub.toBuffer(true);
  return buf.toString('hex');
}

function signMWithDerivedP2c(wif, Mhex) {
  const priv = bsv.PrivateKey.fromWIF(wif);
  const n = bsv.crypto.Point.getN();
  const h = bsv.crypto.BN.fromBuffer(Buffer.from(require('crypto').createHash('sha256').update(Buffer.from(Mhex, 'hex')).digest()));
  const p2cBn = priv.bn.add(h).umod(n);
  if (p2cBn.isZero()) throw new Error('Derived client scalar invalid');
  const p2c = new bsv.PrivateKey(p2cBn);
  const msgHash = require('crypto').createHash('sha256').update(Buffer.from(Mhex, 'hex')).digest();
  const sig = bsv.crypto.ECDSA.sign(msgHash, p2c);
  return sig.toDER().toString('hex');
}

describe('SVD E2E (production-like, KMS-first)', () => {
  test('register -> begin -> complete -> replay prevention, headers and payload', async () => {
    const userId = randomUserId();
    const pmcPriv = new bsv.PrivateKey();
    const pmcPrivWIF = pmcPriv.toWIF();
    const pmcHex = deriveCompressedPubHexFromWIF(pmcPrivWIF);

    // register
    const reg = await fetchJson(`${BASE_URL}/api/svd/register`, {
      method: 'POST',
      body: JSON.stringify({ userId, pmcHex }),
    });
    expect(reg.ok).toBe(true);

    // begin
    const begin = await fetchJson(`${BASE_URL}/api/svd/begin`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    expect(begin.ok).toBe(true);
    expect(begin.body).toHaveProperty('M');
    expect(begin.body).toHaveProperty('pmcHex');
    const { M } = begin.body;

    // complete (direct fetch to inspect headers)
    const signatureHex = signMWithDerivedP2c(pmcPrivWIF, M);
    const completeRes = await fetch(`${BASE_URL}/api/svd/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, M, signatureHex }),
    });
    expect(completeRes.ok).toBe(true);
    // header check
    expect((completeRes.headers.get('cache-control') || '').toLowerCase()).toContain('no-store');
    const completeJson = await completeRes.json();
    expect(completeJson).toHaveProperty('token');

    // replay with same M/signature should fail
    const replay = await fetchJson(`${BASE_URL}/api/svd/complete`, {
      method: 'POST',
      body: JSON.stringify({ userId, M, signatureHex }),
    });
    expect(replay.ok).toBe(false);
    // code could be SVD_REPLAYED
    expect(replay.body?.code || replay.body?.error || '').toMatch(/SVD_REPLAYED|replay/i);
  }, 120000);
});
