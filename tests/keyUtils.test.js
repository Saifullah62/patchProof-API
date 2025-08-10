jest.setTimeout(30000);
console.log('[keyUtils.test] loaded');

// Ensure required secrets are set before loading keyUtils
process.env.MASTER_SECRET = process.env.MASTER_SECRET || 'test-master-secret';

// Unit tests for keyUtils.js advanced cryptographic utilities
const {
  deriveKeyFromMessage,
  deriveEphemeralSessionKey,
  computeMerkleRoot,
  signHash,
  verifyHashSignature,
  computeSha256,
  deriveKeyTree
} = require('../keyUtils');

const bsv = require('bsv');

beforeAll(() => {
  console.log('[keyUtils.test] beforeAll');
});

afterAll(() => {
  console.log('[keyUtils.test] afterAll');
});


describe('Key Derivation', () => {
  it('should deterministically derive the same key for same input', () => {
    const k1 = deriveKeyFromMessage('user@example.com');
    const k2 = deriveKeyFromMessage('user@example.com');
    expect(k1.toWIF()).toBe(k2.toWIF());
  });
  it('should derive different keys for different messages', () => {
    const k1 = deriveKeyFromMessage('userA@example.com');
    const k2 = deriveKeyFromMessage('userB@example.com');
    expect(k1.toWIF()).not.toBe(k2.toWIF());
  });
  it('should derive ephemeral keys with entropy', () => {
    const k1 = deriveEphemeralSessionKey('user@example.com', 'login');
    const k2 = deriveEphemeralSessionKey('user@example.com', 'login');
    // Should be different due to timestamp entropy
    expect(k1.toWIF()).not.toBe(k2.toWIF());
  });
  it('should derive a key tree with unique subkeys', () => {
    const tree = deriveKeyTree('user-abc', ['auth', 'transfer', 'encryption']);
    expect(tree.auth.toWIF()).not.toBe(tree.transfer.toWIF());
    expect(tree.transfer.toWIF()).not.toBe(tree.encryption.toWIF());
  });
});

describe('Signing and Verification', () => {
  it('should sign and verify a hash', () => {
    const key = deriveKeyFromMessage('user@example.com');
    const pubKey = key.pubKey.toString();
    const msg = Buffer.from('hello world');
    const sig = signHash(msg, key);
    expect(verifyHashSignature(msg, sig, pubKey)).toBe(true);
  });
  it('should fail verification for tampered hash', () => {
    const key = deriveKeyFromMessage('user@example.com');
    const pubKey = key.pubKey.toString();
    const msg = Buffer.from('hello world');
    const sig = signHash(msg, key);
    const tampered = Buffer.from('hello world!');
    expect(verifyHashSignature(tampered, sig, pubKey)).toBe(false);
  });
});

describe('Object Hashing', () => {
  it('should produce same hash for objects with same content (canonical)', () => {
    const obj1 = { a: 1, b: 2 };
    const obj2 = { b: 2, a: 1 };
    const h1 = computeSha256(obj1).toString('hex');
    const h2 = computeSha256(obj2).toString('hex');
    expect(h1).toBe(h2);
  });
  it('should produce different hashes for different objects', () => {
    const obj1 = { a: 1 };
    const obj2 = { a: 2 };
    const h1 = computeSha256(obj1).toString('hex');
    const h2 = computeSha256(obj2).toString('hex');
    expect(h1).not.toBe(h2);
  });
});

describe('Merkle Root', () => {
  it('should compute correct Merkle root for two hashes', () => {
    const h1 = computeSha256({ foo: 1 });
    const h2 = computeSha256({ bar: 2 });
    const root = computeMerkleRoot([h1, h2]);
    expect(root).toBeInstanceOf(Buffer);
    expect(root.length).toBe(32);
  });
  it('should compute correct Merkle root for empty array', () => {
    const root = computeMerkleRoot([]);
    expect(root).toBeInstanceOf(Buffer);
    expect(root.length).toBe(32);
    expect(root.equals(Buffer.alloc(32, 0))).toBe(true);
  });
});
