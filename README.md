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

## 🔑 API Key Authentication

Write endpoints are protected with an API key. Include your API key in the `x-api-key` header when calling protected routes:

- POST `/v1/patches`
- POST `/v1/patches/{txid}/transfer-ownership`
- POST `/v1/patches/{uid_tag_id}/unlock-content`
- GET `/v1/admin/utxo-health`
- POST `/v1/admin/batch-anchor`

Example (curl):

```sh
curl -X POST \
  http://localhost:3001/v1/patches \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{
    "product": { "uid_tag_id": "NFC_UID_001" },
    "metadata": { "notes": "Test" }
  }'
```

Notes:
- The API key value is read from the `API_KEY` environment variable (via `secrets.js`).
- In test environment (`NODE_ENV=test`), API key checks are bypassed to enable automated testing.

## 🔒 JWT Authentication

Certain sensitive routes additionally require a valid Bearer JWT in the `Authorization` header.

- How to obtain a JWT:
  1) POST `/v1/auth/request-verification` with `{ identifier: "you@example.com" }`.
  2) Retrieve the code from email (or logs in dev), then POST `/v1/auth/submit-verification` with `{ identifier, code }`.
  3) The response contains `token`.

- Use the token in requests:

```sh
curl -X POST \
  http://localhost:3001/v1/patches/txid123.../transfer-ownership \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -H 'Authorization: Bearer YOUR_JWT' \
  -d '{
    "newOwnerAddress": "1ABC...",
    "currentOwnerPubKey": "02abcdef...", 
    "currentOwnerSignature": "3045..."
  }'
```

Required on:
- POST `/v1/patches/{txid}/transfer-ownership` (requires BOTH `x-api-key` and `Authorization: Bearer <JWT>`)

JWT is signed with `JWT_SECRET`. In test environment, JWT checks are bypassed.

## 🔏 Ownership Transfer Authorization (Signature Verification)

For a transfer to proceed, the server verifies that the request is authorized by the CURRENT OWNER on record.

Required body fields for `POST /v1/patches/{txid}/transfer-ownership`:
- `newOwnerAddress` (string): Destination address becoming the new owner.
- `currentOwnerPubKey` (hex string): The owner’s public key corresponding to the current owner address on file.
- `currentOwnerSignature` (hex DER-encoded ECDSA signature): Signature produced by the private key for the `currentOwnerPubKey` over a canonical message.

Canonical message that must be signed:
```
{
  purpose: 'transfer_ownership',
  uid_tag_id: <from current record>,
  currentTxid: <path parameter>,
  newOwnerAddress: <request body>
}
```

The server:
1) Derives an address from `currentOwnerPubKey` and checks it equals the `current_owner_address` in PatchState.
2) Computes SHA-256 of the canonical message and verifies `currentOwnerSignature` against `currentOwnerPubKey`.
3) Only if both checks pass will the transfer broadcast and DB state update proceed.

## 🪙 UTXO Funding Strategy

Current setup uses a single static UTXO defined in `utxoConfig.js`. This is simple for development but becomes a bottleneck in production (only one TX can be built at a time).

Recommended next step: implement a dynamic UTXO management service that can:
- Maintain a pool of confirmed UTXOs.
- Select appropriate inputs for each transaction (size/fee-aware coin selection).
- Refill/change handling and background consolidation.
- Support key rotation and multi-address funding.

Until that is implemented, ensure the static UTXO remains sufficiently funded and is not double-spent by concurrent operations.

### 🧹 UTXO Pool Maintenance (Orphaned Lock Reaper)

If the server crashes or is terminated abruptly, a UTXO may be left in a `locked` state, preventing it from being used. A reaper script is provided to clean up these orphaned locks.

This script should be run on a regular schedule (e.g., every 15–30 minutes) using a scheduler like cron or Windows Task Scheduler.

How it works:
- Finds all UTXOs with status `locked` whose `updated_at` is older than the threshold (default 15 minutes) and resets their status to `available`.

Usage:

```sh
node scripts/reapLocks.js
```

Configuration (optional environment variables):
- `UTXO_REAPER_MINUTES` – threshold age in minutes (default: 15)
- `UTXO_REAPER_BATCH_LIMIT` – max number of UTXOs to process in one run (default: 500)

Examples

Linux/macOS (cron) – run every 15 minutes:

```cron
*/15 * * * * /usr/bin/env node /path/to/your/project/scripts/reapLocks.js >> /var/log/reaper.log 2>&1
```

Windows (Task Scheduler) – PowerShell snippet:

```powershell
# Creates a task that runs every 15 minutes
$action = New-ScheduledTaskAction -Execute "node" -Argument "C:\\path\\to\\project\\scripts\\reapLocks.js"
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 15) -Once -At (Get-Date).Date
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "PatchProof UTXO Reaper" -Description "Unlocks orphaned UTXOs for the PatchProof API."
```

### ⛓️ Batch Anchoring

For high-volume systems, anchoring each record in a separate transaction can be inefficient and costly. This API provides a batch anchoring endpoint that groups multiple records into a single on-chain transaction.

Endpoint: `POST /v1/admin/batch-anchor`

Authentication: Requires a valid `x-api-key` header.

How it Works:
1. The endpoint finds unanchored authentication records in the database.
2. It calculates the SHA-256 hash of each record.
3. It constructs a Merkle tree from these hashes to produce a single Merkle root.
4. This Merkle root is broadcast to the blockchain in an `OP_RETURN` transaction, creating an immutable, timestamped anchor for the entire batch.
5. Each individual record is then updated with its unique Merkle proof (the path needed to verify its inclusion in the Merkle root) and the `anchorTxid`.

This allows for the verification of thousands of records with a single on-chain footprint, significantly improving efficiency and reducing costs.

Optional parameters:
- `limit` (query or JSON body): maximum number of records to process (default 100, max 1000).

Usage (PowerShell):

```powershell
curl -Method POST `
  -Uri http://localhost:3001/v1/admin/batch-anchor `
  -Headers @{ 'x-api-key' = 'YOUR_API_KEY' }
```

Example success response:

```json
{
  "success": true,
  "txid": "<anchor_txid>",
  "processed": 42,
  "updated": 42
}
```

Example when nothing to anchor:

```json
{
  "success": true,
  "message": "No unanchored records found to process.",
  "processed": 0
}
```

## 🧰 Enhanced Error Logging

The centralized error handler logs structured context for faster debugging while redacting sensitive data:
- Redacts `Authorization` header and `x-api-key`.
- Redacts body fields containing `password`, `token`, `secret`, or `signature`.
- Captures request id, method, URL, headers, and sanitized body.

Forward logs to your aggregation provider (e.g., Datadog/CloudWatch) via Winston transports for production.

🤝 Contact & Support
For support or questions, contact SmartLedger or your system integrator.