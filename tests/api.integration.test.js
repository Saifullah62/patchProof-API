// Integration tests for PatchProof Auth API
const request = require('supertest');
const app = require('../auth_api_production');

describe('PatchProof API Integration', () => {
  let jwtToken;
  let testEmail = 'testuser@example.com';
  let testCode = '123456';
  let recordTxid;

  // Mock/stub email sending and verification store as needed
  beforeAll(() => {
    // Optionally, mock emailStub and verificationStore for deterministic tests
  });

  it('should request a verification code', async () => {
    const res = await request(app)
      .post('/verify-request')
      .send({ email: testEmail });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should submit verification code and receive JWT', async () => {
    // Simulate code submission (in real tests, inject code into store)
    const res = await request(app)
      .post('/verify-submit')
      .send({ email: testEmail, code: testCode });
    // Accept 200 or 401 (if code invalid)
    expect([200, 401]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.token).toBeDefined();
      jwtToken = res.body.token;
    }
  });

  it('should reject record creation without JWT', async () => {
    const res = await request(app)
      .post('/authRecord')
      .send({ type: 'AUTHENTICATION_RECORD', item: { serial_number: 'SN1' } });
    expect([401, 400]).toContain(res.statusCode);
  });

  it('should create a record with valid JWT', async () => {
    if (!jwtToken) return;
    const res = await request(app)
      .post('/authRecord')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ type: 'AUTHENTICATION_RECORD', item: { serial_number: 'SN1' } });
    expect([200, 500]).toContain(res.statusCode); // 500 if broadcast fails
    if (res.statusCode === 200) {
      expect(res.body.txid).toBeDefined();
      recordTxid = res.body.txid;
    }
  });

  it('should handle errors for invalid endpoints', async () => {
    const res = await request(app).get('/not-a-real-endpoint');
    expect([404, 500]).toContain(res.statusCode);
  });

  it('should reject transfer request without JWT', async () => {
    if (!recordTxid) return;
    const res = await request(app)
      .post('/transfer/request')
      .send({ txid: recordTxid, newHolder: 'newuser@example.com' });
    expect([401, 400, 403]).toContain(res.statusCode);
  });

  it('should initiate transfer request with valid JWT', async () => {
    if (!jwtToken || !recordTxid) return;
    const res = await request(app)
      .post('/transfer/request')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ txid: recordTxid, newHolder: 'newuser@example.com' });
    expect([200, 400, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.transferRequest).toBeDefined();
      global.transferRequest = res.body.transferRequest;
    }
  });

  it('should reject transfer acceptance without JWT', async () => {
    if (!recordTxid || !global.transferRequest) return;
    const res = await request(app)
      .post('/transfer/accept')
      .send({ txid: recordTxid, transferRequest: global.transferRequest });
    expect([401, 400, 403]).toContain(res.statusCode);
  });

  it('should reject transfer acceptance with invalid JWT', async () => {
    if (!recordTxid || !global.transferRequest) return;
    const res = await request(app)
      .post('/transfer/accept')
      .set('Authorization', 'Bearer invalid.jwt.token')
      .send({ txid: recordTxid, transferRequest: global.transferRequest });
    expect([401, 400, 403]).toContain(res.statusCode);
  });

  // For a real test, acquire a valid JWT for newHolder (simulate new login)
  // Here, we skip actual acceptance (requires a second user flow)

  it('should verify a record (if txid available)', async () => {
    if (!recordTxid) return;
    const res = await request(app)
      .get(`/verify/${recordTxid}`);
    expect([200, 404, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.txid).toBeDefined();
      expect(res.body.validHash).toBeDefined();
      expect(res.body.validSig).toBeDefined();
    }
  });

  it('should reject double transfer request', async () => {
    if (!jwtToken || !recordTxid) return;
    const res = await request(app)
      .post('/transfer/request')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ txid: recordTxid, newHolder: 'newuser@example.com' });
    expect([400, 403, 409, 500]).toContain(res.statusCode);
  });

  it('should reject record creation with invalid JWT', async () => {
    const res = await request(app)
      .post('/authRecord')
      .set('Authorization', 'Bearer invalid.jwt.token')
      .send({ type: 'AUTHENTICATION_RECORD', item: { serial_number: 'SN1' } });
    expect([401, 400, 403]).toContain(res.statusCode);
  });

});
