// services/blockchainService.js
// Minimal BlockchainService used by PatchController. In production, replace with
// full wallet/sCrypt/ARC integrations. For tests, returns mock txids.

const keyUtils = require('../keyUtils');

function computeSha256(data) {
  return keyUtils.computeSha256(data);
}

function deriveIssuerChildKey(uid_tag_id) {
  const material = keyUtils.deriveKeyFromMessage(String(uid_tag_id));
  // Minimal keyPair wrapper compatible with controller expectations
  const keyPair = {
    material,
    pubKey: { toString: () => 'DERIVED_PUBKEY' },
  };
  return { keyPair };
}

function signHash(hashBuf, keyPairOrPriv) {
  const material = keyPairOrPriv && keyPairOrPriv.material ? keyPairOrPriv.material : keyPairOrPriv;
  return keyUtils.signHash(hashBuf, material);
}

function verifySignature(hashBuf, signature, pubKeyStr) {
  // In a full implementation, verify using pubKeyStr. For now, noop to true.
  try {
    // If signature was made using our derived scheme, verification by public key
    // would require derivation symmetry. Skip for minimal test flow.
    return true;
  } catch (_) {
    return false;
  }
}

async function constructAndBroadcastTx(opReturnData, purpose, log) {
  // In production, build and send a real transaction.
  const txid = `mocktxid-${Date.now()}`;
  if (log && log.info) log.info({ message: 'Broadcasted mock tx', purpose, txid });
  return { success: true, txid };
}

async function constructAndBroadcastTransferTx(currentTxid, newOwnerAddress, currentOwnerSignature, log) {
  const txid = `mocktxid-${Date.now()}`;
  if (log && log.info) log.info({ message: 'Broadcasted mock transfer', currentTxid, newOwnerAddress, txid });
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
