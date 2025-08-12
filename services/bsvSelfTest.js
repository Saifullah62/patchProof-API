// services/bsvSelfTest.js
// A deterministic self-test to detect library drift in bsv verify/derivation.

const bsv = require('bsv');
const crypto = require('crypto');

function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }

// Deterministically derive a private key from a fixed, non-secret seed without WIFs.
function privFromSeed(seedText) {
  const sk = sha256(Buffer.from(seedText, 'utf8'));
  // Reduce to curve order to avoid invalid key edge cases
  const n = bsv.crypto.Point.getN();
  const bn = bsv.crypto.BN.fromBuffer(sk).umod(n);
  if (bn.isZero()) bn.iaddn(1);
  return new bsv.PrivateKey(bn);
}

/**
 * Runs a deterministic self-test using fixed seeds to ensure the
 * underlying bsv library's cryptographic functions are behaving as expected.
 * Throws an error on failure.
 */
function runBsvSelfTest() {
  const pms = privFromSeed('PatchProof:SVD:PMS:SelfTest:v1');
  const pmc = privFromSeed('PatchProof:SVD:PMC:SelfTest:v1');
  const pmcPubHex = pmc.publicKey.toString();

  const M = Buffer.from('PatchProof SVD Self-Test Vector v1');
  const h = new bsv.crypto.BN(sha256(M));
  const n = bsv.crypto.Point.getN();

  // 1. Client-side derivation and signing
  const p2c = new bsv.PrivateKey(pmc.bn.add(h).umod(n));
  const msgHash = sha256(M);
  const sig = bsv.crypto.ECDSA.sign(msgHash, p2c);

  // 2. Server-side public key derivation
  const PMC_pub = bsv.PublicKey.fromString(pmcPubHex);
  const V2C = bsv.PublicKey.fromPoint(PMC_pub.point.add(bsv.crypto.Point.getG().mul(h)));

  // 3. Verification
  const isSignatureValid = bsv.crypto.ECDSA.verify(msgHash, sig, V2C);
  if (!isSignatureValid) {
    throw new Error('bsvSelfTest: ECDSA signature verification failed.');
  }

  // 4. ECDH shared secret derivation check
  const p2s = new bsv.PrivateKey(pms.bn.add(h).umod(n));
  const sharedSecretPoint = V2C.point.mul(p2s.bn);
  if (!sharedSecretPoint || sharedSecretPoint.isInfinity()) {
    throw new Error('bsvSelfTest: ECDH shared secret resulted in an invalid point.');
  }

  // If all checks pass, the library is behaving as expected.
  return { ok: true };
}

module.exports = { runBsvSelfTest };
