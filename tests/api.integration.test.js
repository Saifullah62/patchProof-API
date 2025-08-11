// tests/api.integration.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const bsv = require('bsv');
const { initDb, closeDb } = require('../config/db');

// Enforce test environment and secrets (set BEFORE requiring app)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.MASTER_SECRET = 'test-master-secret';
process.env.API_KEY = 'test-api-key';
process.env.UTXO_CHANGE_ADDRESS = '1changeAddressForTesting';

const { startServer } = require('../app');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const Utxo = require('../models/Utxo');
const utxoService = require('../services/utxoService');

let app;

describe('PatchProof API V1 Integration Tests', () => {

    // --- Lifecycle Hooks (Mongoose Only) ---
    beforeAll(async () => {
        await initDb();
        app = await startServer();
    });

    afterAll(async () => {
        await closeDb();
    });

    beforeEach(async () => {
        // Clean the database before each test
        const collections = mongoose.connection.collections;
        for (const key in collections) {
            await collections[key].deleteMany({});
        }
        // Ensure any spies/mocks are reset between tests
        jest.restoreAllMocks();
    });

    // --- Test Data ---
    const testUserIdentifier = 'user@example.com';
    const mockPatchPayload = (uid) => ({
        product: { uid_tag_id: uid, name: "Test Jersey" },
        metadata: { notes: "Test item." },
        auth: { owner: "1InitialOwnerAddress" }
    });

    const seedFundingUtxos = async (utxos) => {
        for (const utxo of utxos) {
            await utxoService.addUtxo(utxo);
        }
    };

    // --- Helper function to authenticate a user and get a JWT ---
    const authenticateUserHelper = async (identifier) => {
        const reqResponse = await request(app)
            .post('/v1/auth/request-verification')
            .send({ identifier });
        
        // Use dev_code optimization (available because NODE_ENV=test)
        const code = reqResponse.body.dev_code;

        const submitResponse = await request(app)
            .post('/v1/auth/submit-verification')
            .send({ identifier, code });

        return submitResponse.body.token;
    };

    // --- Test Cases ---

    describe('Authentication Flow (v1/auth)', () => {
        test('should generate code, validate successfully, and return JWT', async () => {
            const token = await authenticateUserHelper(testUserIdentifier);
            expect(token).toBeDefined();
        });

        test('should fail validation with incorrect code', async () => {
            await request(app)
                .post('/v1/auth/request-verification')
                .send({ identifier: testUserIdentifier });
            
            const submitResponse = await request(app)
                .post('/v1/auth/submit-verification')
                .send({ identifier: testUserIdentifier, code: "000000" }); // Incorrect code

            expect(submitResponse.statusCode).toBe(401);
            expect(submitResponse.body.reason).toBe('InvalidCode');
        });
    });

    describe('Patch Lifecycle (v1/patches)', () => {
        const UID1 = "NFC_UID_001";

        test('should register a new patch successfully', async () => {
            await seedFundingUtxos([{ txid: 'txid_fund', vout: 0, satoshis: 10000, scriptPubKey: 'script', privKeyWIF: 'L1aW4xcr1ES1LdYyG8rSjM3aW4xcr1ES1LdYyG8rSjM3a' }]);

            const response = await request(app)
                .post('/v1/patches')
                .set('x-api-key', 'test-api-key')
                .send(mockPatchPayload(UID1));

            expect(response.statusCode).toBe(201);
            expect(response.body.txid).toBeDefined();
        });

        test('should prevent registration of a duplicate UID (Conflict)', async () => {
            await seedFundingUtxos([{ txid: 'txid_fund', vout: 0, satoshis: 10000, scriptPubKey: 'script', privKeyWIF: 'L1aW4xcr1ES1LdYyG8rSjM3aW4xcr1ES1LdYyG8rSjM3a' }]);
            await request(app).post('/v1/patches').set('x-api-key', 'test-api-key').send(mockPatchPayload(UID1)); // First registration

            const response = await request(app)
                .post('/v1/patches')
                .set('x-api-key', 'test-api-key')
                .send(mockPatchPayload(UID1)); // Duplicate registration

            expect(response.statusCode).toBe(409);
        });

        test('should verify an authentic patch', async () => {
            await seedFundingUtxos([{ txid: 'txid_fund', vout: 0, satoshis: 10000, scriptPubKey: 'script', privKeyWIF: 'L1aW4xcr1ES1LdYyG8rSjM3aW4xcr1ES1LdYyG8rSjM3a' }]);
            await request(app).post('/v1/patches').set('x-api-key', 'test-api-key').send(mockPatchPayload(UID1));

            const response = await request(app)
                .get(`/v1/patches/verify/${UID1}`);

            expect(response.statusCode).toBe(200);
            expect(response.body.status).toBe('authentic');
        });

        test('should transfer ownership successfully', async () => {
            const regResponse = await request(app).post('/v1/patches').send(mockPatchPayload(UID1));
            const initialTxid = regResponse.body.txid;
            const userToken = await authenticateUserHelper(testUserIdentifier);

            const transferResponse = await request(app)
                .post(`/v1/patches/${initialTxid}/transfer-ownership`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({
                    newOwnerAddress: "1NewOwnerAddress",
                    currentOwnerSignature: "MOCK_SIGNATURE"
                });

            expect(transferResponse.statusCode).toBe(200);
            const newTxid = transferResponse.body.newTxid;

            const verifyResponse = await request(app).get(`/v1/patches/verify/${UID1}`);
            expect(verifyResponse.body.record.auth.owner).toBe("1NewOwnerAddress");
            expect(verifyResponse.body.verificationDetails.onChainTxid).toBe(newTxid);
        });
    });

    describe('UTXO Service Logic', () => {
        test('should combine multiple UTXOs to meet a required amount', async () => {
            await seedFundingUtxos([
                { txid: 'txidA', vout: 0, satoshis: 1000, scriptPubKey: 'scriptA', privKeyWIF: 'L1a' },
                { txid: 'txidB', vout: 0, satoshis: 1500, scriptPubKey: 'scriptB', privKeyWIF: 'L1b' },
                { txid: 'txidC', vout: 0, satoshis: 5000, scriptPubKey: 'scriptC', privKeyWIF: 'L1c' },
            ]);
            const requiredAmount = 5500;
            const selectedUtxos = await utxoService.selectAndLockUtxos(requiredAmount);
            expect(selectedUtxos).toHaveLength(2);
            expect(selectedUtxos.reduce((sum, u) => sum + u.satoshis, 0)).toBe(6500);
        });

        test('a signing failure should unlock all reserved UTXOs', async () => {
            await seedFundingUtxos([{ txid: 'txid_fund', vout: 0, satoshis: 10000, scriptPubKey: 'script', privKeyWIF: 'L1aW4xcr1ES1LdYyG8rSjM3aW4xcr1ES1LdYyG8rSjM3a' }]);

            const prev = process.env.TEST_FORCE_SIGN_FAIL;
            process.env.TEST_FORCE_SIGN_FAIL = '1';

            const res = await request(app)
                .post('/v1/patches')
                .set('x-api-key', 'test-api-key')
                .send(mockPatchPayload('FAIL_UID'));

            // Restore env
            if (prev === undefined) delete process.env.TEST_FORCE_SIGN_FAIL; else process.env.TEST_FORCE_SIGN_FAIL = prev;

            expect(res.statusCode).toBe(500);
            // Verify the UTXO was unlocked
            const availableCount = await Utxo.countDocuments({ status: 'available' });
            expect(availableCount).toBe(1);
        });
    });

    describe('Admin Batch Anchoring', () => {
        test('should find unanchored records, broadcast, and update them', async () => {
            await AuthenticationRecord.insertMany([
                { txid: 't1', uid_tag_id: 'u1', record_data: { auth: { anchorTxid: null } } },
                { txid: 't2', uid_tag_id: 'u2', record_data: { auth: { anchorTxid: null } } }
            ]);
            await seedFundingUtxos([{ txid: 'txid_fund', vout: 0, satoshis: 10000, scriptPubKey: 'script', privKeyWIF: 'L1aW4xcr1ES1LdYyG8rSjM3aW4xcr1ES1LdYyG8rSjM3a' }]);

            const response = await request(app)
                .post('/v1/admin/batch-anchor')
                .set('x-api-key', 'test-api-key')
                .send();

            expect(response.statusCode).toBe(200);
            expect(response.body.processed).toBe(2);
            expect(response.body.updated).toBe(2);

            const anchoredCount = await AuthenticationRecord.countDocuments({ 'record_data.auth.anchorTxid': { $ne: null } });
            expect(anchoredCount).toBe(2);
        });
    });
});