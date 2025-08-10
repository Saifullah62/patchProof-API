// services/blockchainService.js
// Minimal stub implementation to allow the server to boot.
// Replace with a production implementation that integrates with your blockchain stack.

const crypto = require('crypto');

function computeSha256(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(json).digest();
}

function deriveIssuerChildKey(uid_tag_id) {
  // Stub key material. Replace with real HD derivation using a seed/xpub.
  const pubKey = Buffer.from(`stub-pubkey-${uid_tag_id}`);
  const privKey = Buffer.from(`stub-privkey-${uid_tag_id}`);
  return { keyPair: { pubKey, privKey } };
}

function signHash(hashBuf, keyPair) {
  // Stub signature; a real impl would ECDSA-sign the hash with keyPair.privKey
  return `stub-signature:${hashBuf.toString('hex').slice(0,16)}:${keyPair.pubKey.toString('hex').slice(0,16)}`;
}

function verifySignature(hashBuf, signature, pubKey) {
  // Always true for stub. Replace with real verification.
  return true;
}

async function constructAndBroadcastTx(opReturnData, purpose, log) {
  if (log) log.info({ message: 'Stub broadcast tx', purpose, opReturnBytes: opReturnData.reduce((a,b)=>a+(b?.length||0),0) });
  // Return a deterministic mock txid
  const txid = crypto.createHash('sha256').update(`${purpose}:${Date.now()}`).digest('hex');
  return { success: true, txid };
}

async function constructAndBroadcastTransferTx(currentTxid, newOwnerAddress, currentOwnerSignature, opReturnData, log) {
  if (log) log.info({ message: 'Stub broadcast transfer', currentTxid, newOwnerAddress });
  const txid = crypto.createHash('sha256').update(`transfer:${currentTxid}:${newOwnerAddress}:${Date.now()}`).digest('hex');
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
