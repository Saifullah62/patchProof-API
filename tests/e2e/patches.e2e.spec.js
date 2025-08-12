/* E2E: Patches register -> verify -> transfer -> unlock-content (mainnet, no mocks)
   Requires server running with KMS issuer, Mongo/Redis.
   Env: BASE_URL
*/

const bsv = require('bsv');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL;
const maybe = BASE_URL ? describe : describe.skip;

function randomUid() {
  return `e2e-uid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }
function computeSha256Json(obj) { return sha256(Buffer.from(JSON.stringify(obj), 'utf8')); }

function pubKeyToAddressHex(pubKey) {
  const address = new bsv.PublicKey(pubKey).toAddress().toString();
  return address;
}

function defaultHeaders() {
  const h = { 'content-type': 'application/json' };
  if (process.env.API_KEY) h['x-api-key'] = process.env.API_KEY;
  return h;
}

async function fetchJson(url, opts = {}) {
  const headers = { ...defaultHeaders(), ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  return { ok: res.ok, status: res.status, headers: res.headers, body };
}

async function pollPendingRegistration(id, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchJson(`${BASE_URL}/v1/patches/pending/registration/${id}`);
    if (res.ok && res.body && (res.body.status === 'confirmed' || res.body.status === 'failed')) {
      return res.body;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout waiting for pending registration');
}

async function pollPendingTransfer(id, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchJson(`${BASE_URL}/v1/patches/pending/transfer/${id}`);
    if (res.ok && res.body && (res.body.status === 'confirmed' || res.body.status === 'failed')) {
      return res.body;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout waiting for pending transfer');
}

maybe('Patches E2E (registration, verification, transfer, unlock)', () => {
  test('full lifecycle happy path', async () => {
    // Generate initial owner keypair
    const ownerPriv = new bsv.PrivateKey();
    const ownerPub = ownerPriv.toPublicKey();
    const ownerPubHex = ownerPub.toBuffer().toString('hex');
    const ownerAddress = ownerPub.toAddress().toString();

    const uid_tag_id = randomUid();
    const metadata = { notes: 'E2E test', image: 'https://example.com/img.png' };

    // Register patch
    const regPayload = {
      product: { uid_tag_id },
      metadata,
      auth: { owner: ownerAddress },
    };

    const regRes = await fetchJson(`${BASE_URL}/v1/patches`, {
      method: 'POST',
      body: JSON.stringify(regPayload),
    });

    let txid;
    if (regRes.status === 201) {
      txid = regRes.body.txid;
      expect(typeof txid).toBe('string');
    } else if (regRes.status === 202) {
      const { pendingId } = regRes.body;
      expect(pendingId).toBeTruthy();
      const final = await pollPendingRegistration(pendingId);
      expect(final.status).toBe('confirmed');
      txid = final.txid;
    } else {
      throw new Error(`Unexpected registration status: ${regRes.status} ${JSON.stringify(regRes.body)}`);
    }

    // Verify patch
    const verifyRes = await fetchJson(`${BASE_URL}/v1/patches/verify/${encodeURIComponent(uid_tag_id)}`);
    expect(verifyRes.ok).toBe(true);
    expect(verifyRes.body).toHaveProperty('status');
    expect(verifyRes.body).toHaveProperty('record');
    expect(verifyRes.body.verificationDetails.issuerSignatureValid).toBe(true);
    const currentTxid = verifyRes.body.verificationDetails.onChainTxid;

    // Transfer ownership to a new key
    const newOwnerPriv = new bsv.PrivateKey();
    const newOwnerPub = newOwnerPriv.toPublicKey();
    const newOwnerAddress = newOwnerPub.toAddress().toString();

    // Build canonical transfer message per controller
    const transferMessage = { purpose: 'transfer_ownership', uid_tag_id, currentTxid, newOwnerAddress };
    const hashBuf = computeSha256Json(transferMessage);
    const sig = bsv.crypto.ECDSA.sign(hashBuf, ownerPriv);
    const currentOwnerSignature = sig.toDER().toString('hex');
    const currentOwnerPubKey = ownerPubHex;

    const xferRes = await fetchJson(`${BASE_URL}/v1/patches/${currentTxid}/transfer-ownership`, {
      method: 'POST',
      body: JSON.stringify({ newOwnerAddress, currentOwnerSignature, currentOwnerPubKey }),
    });

    let newTxid;
    if (xferRes.ok && xferRes.status === 200) {
      newTxid = xferRes.body.newTxid;
    } else if (xferRes.status === 202) {
      const { pendingId } = xferRes.body;
      const final = await pollPendingTransfer(pendingId);
      expect(final.status).toBe('confirmed');
      newTxid = final.txid;
    } else {
      throw new Error(`Unexpected transfer status: ${xferRes.status} ${JSON.stringify(xferRes.body)}`);
    }

    expect(typeof newTxid).toBe('string');

    // Verify again; ownership should reflect new owner
    const verify2 = await fetchJson(`${BASE_URL}/v1/patches/verify/${encodeURIComponent(uid_tag_id)}`);
    expect(verify2.ok).toBe(true);
    expect(verify2.body.verificationDetails.issuerSignatureValid).toBe(true);

    // Unlock-content authorization using new owner
    const unlockMessage = { purpose: 'unlock_content', uid_tag_id, currentTxid: newTxid };
    const unlockHash = computeSha256Json(unlockMessage);
    const unlockSig = bsv.crypto.ECDSA.sign(unlockHash, newOwnerPriv).toDER().toString('hex');
    const unlockRes = await fetchJson(`${BASE_URL}/v1/patches/${encodeURIComponent(uid_tag_id)}/unlock-content`, {
      method: 'POST',
      body: JSON.stringify({ ownerPubKey: newOwnerPub.toBuffer().toString('hex'), ownerSignature: unlockSig }),
    });
    expect(unlockRes.ok).toBe(true);
    expect(unlockRes.body.authorized).toBe(true);
  }, 300000);
});
