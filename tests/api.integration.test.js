// tests/api.integration.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const { initDb, closeDb } = require('../config/db');
const { startServer } = require('../app');

// Enforce test environment and secrets
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.MASTER_SECRET = 'test-master-secret';
process.env.API_KEY = 'test-api-key';

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
    });

    // --- Test Data ---
    const testUserIdentifier = 'user@example.com';
    const mockPatchPayload = (uid) => ({
        product: {
            category: "jersey", name: "Test Jersey", serial_number: "123456",
            patch_type: "NFC embedded", material: "Polyester", uid_tag_id: uid,
            date_embedded: "2025-08-10"
        },
        metadata: {
            image: "https://example.com/image.png", patch_location: "Hem", notes: "Test item."
        },
        paymentAddress: "1MockPaymentAddressIssuer"
    });

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
            const response = await request(app)
                .post('/v1/patches')
                .send(mockPatchPayload(UID1));

            expect(response.statusCode).toBe(201);
            expect(response.body.txid).toBeDefined();
        });

        test('should prevent registration of a duplicate UID (Conflict)', async () => {
            await request(app).post('/v1/patches').send(mockPatchPayload(UID1)); // First registration

            const response = await request(app)
                .post('/v1/patches')
                .send(mockPatchPayload(UID1)); // Duplicate registration

            expect(response.statusCode).toBe(409);
        });

        test('should verify an authentic patch', async () => {
            await request(app).post('/v1/patches').send(mockPatchPayload(UID1));

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
});