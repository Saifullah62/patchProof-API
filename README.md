# PatchProof™ Authentication API – Production Deployment Guide

## Overview
This API provides secure authentication, chain of custody, and on-chain anchoring for PatchProof™ records. It is designed for production with robust error handling, modular funding, JWT-based authentication, and flexible database and secrets management.

---

## 🚀 Deployment Requirements

### 1. Environment Variables

For production, you must set the following environment variables. Do not hardcode these values.

#### Database
- `MONGODB_URI` – Required. The full connection string for your MongoDB Atlas cluster.
- `DB_NAME` – The name of the database to use within your cluster (e.g., `appdb`).

#### Secrets Management
- `MASTER_SECRET` – Required. A strong, unique secret for deterministic key derivation.
- `API_KEY` – Required. The API key for accessing protected endpoints.
- `JWT_SECRET` – Required. The secret used for signing JSON Web Tokens.

#### On-Chain Anchoring (Funding Modes)
Choose one of the two modes below for on-chain anchoring.

**A. Dynamic SmartLedger Wallet Mode (Recommended for Production):**
- `SMARTLEDGER_API_BASE_URL` – e.g. `https://smartledger.dev`
- `SMARTLEDGER_API_KEY` – Your SmartLedger API key.
- `FUNDING_ADDRESS` – BSV address to fund anchoring transactions.
- `FUNDING_WIF` – Corresponding private key (WIF) for signing.

**B. Static/Manual Mode (Single UTXO, for dev/test):**
- `MERCHANT_API_URL` – Merchant API endpoint for BSV broadcast.
- `UTXO_TXID`, `UTXO_OUTPUT_INDEX`, `UTXO_SATOSHIS`, `UTXO_SCRIPT_HEX`, `UTXO_PRIVKEY_WIF`, `UTXO_CHANGE_ADDRESS`

#### Other
- `PORT` – Port to run the API (default: 3001).
- `NODE_ENV` - Set to `production` for live environments.

---

## Security & Operational Best Practices
- **Secrets:** Use a cloud secrets manager or HSM in production. Never hardcode secrets in source code or config files.
- **Key Rotation:** With dynamic funding, rotate `FUNDING_WIF` and funding addresses regularly.
- **JWT Expiry:** JWTs are short-lived (default 10 minutes). Adjust expiry as needed.
- **CORS:** Restrict allowed origins to trusted domains only.
- **Rate Limiting:** Adjust thresholds based on expected traffic and threat model.
- **Monitoring:** Configure Winston to forward logs to a central aggregation service.

---

## CORS & Rate Limiting Configuration

### CORS
For production, restrict origins by setting the `CORS_ALLOWED_ORIGINS` environment variable. For example: `https://proofpatch.com,https://www.proofpatch.com`.

### Rate Limiting
The default is 100 requests per 15 minutes per IP. Adjust for your needs in `app.js`.

---

## 🚀 CI/CD & Automated Testing

This project is set up for continuous integration and deployment.

- **Lint & Test:** Runs `npm test` (Jest + Supertest) on every push.
- **MongoDB Readiness:** Tests will automatically use `mongodb-memory-server` when `MONGODB_URI` is not set.

---

## 🗄️ Database Schema (MongoDB + Mongoose)

- This project uses MongoDB with Mongoose models. No SQL/Knex migrations are required.
- **Models**:
  - `models/AuthenticationRecord.js`
  - `models/PatchState.js`
  - `models/VerificationCode.js`
- The server will only start after a successful Mongoose connection is established.

---

## ⚙️ Environment Setup

- Copy `.env.example` to `.env` and set all required secrets.
- Start server:
  ```sh
  node app.js

  📖 API Documentation
OpenAPI/Swagger docs are available at /docs when the server is running.

See the openapi.yaml file for full endpoint specifications.

🔐 Advanced Cryptographic Utilities
This project uses a production-grade cryptographic toolkit in keyUtils.js for secure and auditable operations, including deterministic key derivation, digital signatures, and Merkle batching. See the source file for detailed documentation.

🚀 Deployment Checklist
This is a high-level checklist for deploying the API to a production environment.

[ ] Secrets Management: All secrets (e.g., MONGODB_URI, JWT_SECRET, MASTER_SECRET) must be populated in a secure secrets manager.

[ ] CORS Configuration: Set CORS_ALLOWED_ORIGINS to your production domains.

[ ] Database Indexes: Verify that all necessary indexes have been created in your production MongoDB instance.

[ ] Rate Limiting: Configure and enable production-appropriate rate limiting.

[ ] Logging: Configure Winston transports to forward logs to your centralized provider (Datadog, CloudWatch, etc.).

[ ] On-Chain Funding: Ensure your chosen funding method is configured with a monitored, funded wallet.

🤝 Contact & Support
For support or questions, contact SmartLedger or your system integrator.