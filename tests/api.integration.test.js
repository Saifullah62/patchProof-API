// tests/api.integration.test.js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.MASTER_SECRET = process.env.MASTER_SECRET || 'test-master-secret';

const request = require('supertest');
const mongoose = require('mongoose');
const { initDb, closeDb } = require('../config/db');
const { startServer } = require('../app');

let app;

describe('PatchProof API V1 Integration Tests', () => {
  beforeAll(async () => {
    await initDb();
    app = await startServer();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const testUserIdentifier = `user-${Date.now()}@example.com`;
  const mockPatchPayload = (uid) => ({
    product: {
      category: 'jersey', name: 'Test Jersey', serial_number: '123456',
      patch_type: 'NFC embedded', material: 'Polyester', uid_tag_id: uid,
      date_embedded: '2025-08-10',
    },
    metadata: { image: 'https://example.com/image.png', patch_location: 'Hem', notes: 'Test item.' },
    paymentAddress: '1MockPaymentAddressIssuer',
  });

  const authenticateUserHelper = async (identifier) => {
    const reqRes = await request(app)
      .post('/v1/auth/request-verification')
      .send({ identifier });
    expect(reqRes.statusCode).toBe(200);
    const code = reqRes.body.dev_code;
    const submitRes = await request(app)
      .post('/v1/auth/submit-verification')
      .send({ identifier, code });
    expect(submitRes.statusCode).toBe(200);
    return submitRes.body.token;
  };

  describe('Authentication Flow (v1/auth)', () => {
    test('should generate code and return JWT on successful submission', async () => {
      const token = await authenticateUserHelper(testUserIdentifier);
      expect(token).toBeDefined();
    });

    test('should fail validation with incorrect code and track attempts', async () => {
      await request(app)
        .post('/v1/auth/request-verification')
        .send({ identifier: testUserIdentifier });
      const submit = await request(app)
        .post('/v1/auth/submit-verification')
        .send({ identifier: testUserIdentifier, code: '000000' });
      expect(submit.statusCode).toBe(401);
      expect(submit.body.reason).toBe('InvalidCode');
    });
  });

  describe('Patch Lifecycle (v1/patches)', () => {
    const UID1 = 'NFC_UID_001';

    test('should register a new patch successfully', async () => {
      const res = await request(app)
        .post('/v1/patches')
        .send(mockPatchPayload(UID1));
      expect(res.statusCode).toBe(201);
      expect(res.body.txid).toBeDefined();
    });

    test('should prevent duplicate UID registration (Conflict)', async () => {
      await request(app).post('/v1/patches').send(mockPatchPayload(UID1));
      const res = await request(app).post('/v1/patches').send(mockPatchPayload(UID1));
      expect(res.statusCode).toBe(409);
    });

    test('should verify an authentic patch', async () => {
      await request(app).post('/v1/patches').send(mockPatchPayload(UID1));
      const res = await request(app).get(`/v1/patches/verify/${UID1}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('authentic');
      expect(res.body.verificationDetails.dataHashMatches).toBe(true);
      expect(res.body.verificationDetails.issuerSignatureValid).toBe(true);
    });

    test('should transfer ownership successfully', async () => {
      const reg = await request(app).post('/v1/patches').send(mockPatchPayload(UID1));
      const initialTxid = reg.body.txid;
      const userToken = await authenticateUserHelper(testUserIdentifier);
      const transfer = await request(app)
        .post(`/v1/patches/${initialTxid}/transfer-ownership`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ newOwnerAddress: '1NewOwnerAddress', currentOwnerSignature: 'MOCK_SIGNATURE' });
      expect(transfer.statusCode).toBe(200);
      const newTxid = transfer.body.newTxid;
      const verify = await request(app).get(`/v1/patches/verify/${UID1}`);
      expect(verify.body.record.auth.owner).toBe('1NewOwnerAddress');
      expect(verify.body.verificationDetails.onChainTxid).toBe(newTxid);
    });

    test('should prevent double-spend of same txid (Conflict)', async () => {
      const reg = await request(app).post('/v1/patches').send(mockPatchPayload(UID1));
      const initialTxid = reg.body.txid;
      const userToken = await authenticateUserHelper(testUserIdentifier);
      await request(app)
        .post(`/v1/patches/${initialTxid}/transfer-ownership`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ newOwnerAddress: '1OwnerA', currentOwnerSignature: 'MOCK_SIG' });
      const failed = await request(app)
        .post(`/v1/patches/${initialTxid}/transfer-ownership`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ newOwnerAddress: '1OwnerB', currentOwnerSignature: 'MOCK_SIG' });
      expect(failed.statusCode).toBe(409);
    });
  });
});
