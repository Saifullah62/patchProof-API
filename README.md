# PatchProof™ Authentication API – Production Deployment Guide

![CI](https://github.com/Saifullah62/patchProof_PROD/actions/workflows/ci.yml/badge.svg)

## Overview
This API provides secure authentication, chain of custody, and on-chain anchoring for PatchProof™ records. It is designed for production with robust error handling, modular funding, JWT-based authentication, and flexible database and secrets management.

---

## Documentation Index

- Getting Started: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)
- Configuration: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- API Reference: [docs/API.md](docs/API.md)
- UTXO Maintenance: [docs/UTXO_MAINTENANCE.md](docs/UTXO_MAINTENANCE.md)
- SVD (Passwordless) Auth: [docs/SVD_AUTH.md](docs/SVD_AUTH.md)
- Operations Runbook: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Grafana Monitoring: [docs/GRAFANA.md](docs/GRAFANA.md)
- Security: [docs/SECURITY.md](docs/SECURITY.md)
- Testing: [docs/TESTING.md](docs/TESTING.md)
 - Developer: see [Developer](#developer)

---

## 🚀 Deployment Requirements

### 1. Environment Variables

For production, you must set the following environment variables. Do not hardcode these values.

#### Database
- `MONGODB_URI` – Required. The full connection string for your MongoDB Atlas cluster.
- `DB_NAME` – The name of the database to use within your cluster (e.g., `appdb`).

⚠️ Production enforcement

- In `production`, the server fails fast during startup if `MONGODB_URI` does not include credentials.
- Example (MongoDB, with auth):
  - `mongodb://dbuser:STRONG_PASS@mongo-host:27017/appdb?authSource=admin`
  - `mongodb+srv://dbuser:STRONG_PASS@cluster0.xxxx.mongodb.net/appdb`

#### Secrets Management
- `MASTER_SECRET` – Required. A strong, unique secret for deterministic key derivation.
- `API_KEY` – Required. The API key for accessing protected endpoints.
- `JWT_SECRET` – Required. The secret used for signing JSON Web Tokens.

#### On-Chain Anchoring (KMS-based Signing)
All transaction signing is delegated to an external KMS. The application never handles raw private keys.

- `KMS_SIGN_URL` – HTTPS endpoint for your signing service used by `services/kmsSigner.js`.
- `KMS_API_KEY` – Optional bearer key for authenticating to the KMS.
- UTXO ingestion and pool management are handled internally. For manual seeding, use `scripts/addUtxo.js` with a KMS `--keyId` (public key identifier); no WIFs are accepted by scripts.

#### Other
- `PORT` – Port to run the API (default: 3001).
- `NODE_ENV` - Set to `production` for live environments.
  
#### Redis
- `REDIS_URL` – Redis connection string for rate limiting, BullMQ, and caches.
- `REDIS_PASSWORD` – Optional. Required in production if the password is not embedded in `REDIS_URL`.

⚠️ Production enforcement

- In `production`, the server fails fast if Redis authentication is not provided.
- Provide either:
  - `REDIS_URL` with inline credentials, e.g., `redis://default:STRONG_PASSWORD@redis-host:6379`, or
  - `REDIS_PASSWORD` alongside host/port `REDIS_URL` (without inline pass) or `REDIS_HOST`/`REDIS_PORT`.
 
#### External KMS (Signing)
- `KMS_SIGN_URL` – HTTPS endpoint for external KMS signing. The service never handles raw private keys.
- `KMS_API_KEY` – Optional bearer key for the KMS endpoint.
- Optional tuning: `KMS_SIGN_RETRY_ATTEMPTS`, `KMS_SIGN_RETRY_DELAY_MS`.

#### WhatsOnChain (WOC) Client
- `WOC_API_KEY` – Optional. API key header used by `clients/wocClient.js` when present.
- `WOC_TIMEOUT_MS` – Optional. HTTP timeout in milliseconds for WOC requests (default: 15000).
- `WOC_RETRIES` – Optional. Number of retry attempts on retryable failures (5xx or network), default: 2.
- `WOC_NETWORK` – `main` | `test` network selector (already listed under configuration docs).

Initialization:
- The WOC client is initialized at server startup in `app.js` (`wocClient.initialize()`).
- Standalone scripts that use the client (e.g., `scripts/check-health.js`, `scripts/addUtxo.js`) explicitly call `wocClient.initialize()` before use.

#### Metrics (Prometheus)
- `METRICS_ENABLED` – Optional. Enable metrics collection (default: true).
- Endpoint: `GET /internal/metrics` (protected by API key) exposes counters:
  - `pp_challenges_issued`
  - `pp_jwt_success`
  Use edge blocking (e.g., Nginx) to restrict `/internal/*` in addition to API key gating.

---

## Production Boot Verification (Windows PowerShell)

Quick commands to verify production startup enforces authenticated MongoDB and Redis. These validate the fail-fast checks without needing live services.

### Negative test (should fail fast on missing credentials)

```powershell
# Clear env first (minimal set)
Remove-Item Env:\MONGODB_URI -ErrorAction SilentlyContinue
Remove-Item Env:\REDIS_URL -ErrorAction SilentlyContinue
Remove-Item Env:\REDIS_PASSWORD -ErrorAction SilentlyContinue

$env:NODE_ENV = 'production'

# Intentionally INSECURE URIs (no credentials)
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/appdb?authSource=admin'
$env:REDIS_URL   = 'redis://127.0.0.1:6379'

node app.js
```

### Positive auth check (passes auth checks; may fail on connectivity if services aren’t running)

```powershell
$env:NODE_ENV        = 'production'
$env:MONGODB_URI     = 'mongodb://dbuser:STRONG_PASS@127.0.0.1:27017/appdb?authSource=admin&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000'
$env:REDIS_URL       = 'redis://127.0.0.1:6379'
$env:REDIS_PASSWORD  = 'STRONG_PASS'

node app.js
```

Expectations:
- The first run exits early due to missing MongoDB and/or Redis authentication.
- The second run proceeds past auth enforcement; if Mongo/Redis aren’t available, you’ll see normal connection errors instead.

## DigitalOcean Droplet Deployment (systemd + Nginx)

If you deploy on a DigitalOcean Droplet, use a root-owned env file and a systemd unit for a hardened setup:

- Secrets in `/etc/patchproof/patchproof.env` (root:root, chmod 600)
- App managed by systemd (`ops/systemd/patchproof.service`)
- Optional Nginx reverse proxy with TLS (`ops/nginx/patchproof.conf`)
- One-command deploy/rollback scripts in `ops/`

Start here: `docs/DEPLOYMENT_DO.md`

Quick commands (on the droplet):

```bash
sudo cp /opt/patchproof/ops/systemd/patchproof.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable patchproof && sudo systemctl start patchproof
sudo journalctl -u patchproof -f
```

Deploy with:

```bash
sudo -E bash /opt/patchproof/ops/deploy.sh
```

Notes:
- The deploy script ensures `/var/log/patchproof` exists with correct ownership and permissions for the runtime user.

Rollback with (previous commit by default, or pass a git ref):

```bash
sudo -E bash /opt/patchproof/ops/rollback.sh
sudo -E bash /opt/patchproof/ops/rollback.sh HEAD~2
sudo -E bash /opt/patchproof/ops/rollback.sh <commit-sha>
```

---

## Security & Operational Best Practices
- **Secrets:** Use a cloud secrets manager or HSM in production. On DigitalOcean Droplets, store secrets in a root-owned env file at `/etc/patchproof/patchproof.env` (chmod 600) and load via systemd `EnvironmentFile`. Never hardcode secrets in source code or config files.
- **Key Rotation:** Rotate KMS keys per policy. Because the app never receives private keys, rotation is performed within the KMS. Update `keyIdentifier` usage in ops as needed.
- **JWT Expiry:** JWTs are short-lived (default 10 minutes). Adjust expiry as needed.
- **CORS:** Restrict allowed origins to trusted domains only.
  - **Rate Limiting:** Adjust thresholds based on expected traffic and threat model.
    - Use a shared Redis (`REDIS_URL`) for distributed enforcement across instances.
    - Auth limiter envs: `AUTH_REQUEST_WINDOW_MS`, `AUTH_REQUEST_MAX`, `AUTH_SUBMIT_WINDOW_MS`, `AUTH_SUBMIT_MAX`.
- **Monitoring:** Configure Winston to forward logs to a central aggregation service.
  - Import the SVD Grafana dashboard from `grafana/svd-dashboard.json` and set the Prometheus datasource to "Prometheus".
  - Key KPIs: Success Rate (%), Error Rate (%), Logins/min, Failure Breakdown, Challenge Age p50/p90/p99.

- **API Key Hardening:** Protected routes use constant-time comparison (`crypto.timingSafeEqual`). In production, the service exits on startup if `API_KEY` is missing.

---

## CORS & Rate Limiting Configuration

### CORS
For production, restrict origins by setting the `CORS_ALLOWED_ORIGINS` environment variable. For example: `https://proofpatch.com,https://www.proofpatch.com`.

### Rate Limiting
The default is 100 requests per 15 minutes per IP. Adjust for your needs in `app.js`.

---

## CI/CD & Automated Testing

This project is set up for continuous integration and deployment via GitHub Actions.

- **CI Workflow:** See `.github/workflows/ci.yml` (Node 18, cached npm, runs tests on push/PR to `main`).
- **Tests:** Runs `npm test` (Jest + Supertest) on every push.
- **MongoDB Readiness:** Tests can use `mongodb-memory-server` when `MONGODB_URI` is not set.

### GitHub Actions Secrets (required)
To avoid context/secret lint warnings and ensure tests run, configure these repository secrets in GitHub:

- `API_KEY`
- `JWT_SECRET`
- `MASTER_SECRET`
- `KMS_SIGN_URL`
- `KMS_API_KEY`
- `ISSUER_KEY_IDENTIFIER`
- `UTXO_FUNDING_KEY_IDENTIFIER`
- `UTXO_FUNDING_ADDRESS`
- `UTXO_CHANGE_ADDRESS` (optional but referenced)
- `WOC_API_KEY` (optional; recommended if CI hits WOC)

These are consumed by `.github/workflows/ci.yml` and validated at runtime.

---

## Database Schema (MongoDB + Mongoose)

- This project uses MongoDB with Mongoose models. No SQL/Knex migrations are required.
- **Models**:
  - `models/AuthenticationRecord.js`
  - `models/PatchState.js`
  - `models/VerificationCode.js`
- The server will only start after a successful Mongoose connection is established.

---

## Environment Setup

- Copy `.env.example` to `.env` and set all required secrets.
- Start server:
```sh
node app.js
```

API Documentation
OpenAPI/Swagger docs are available at /docs when the server is running.

See the openapi.yaml file for full endpoint specifications.

### Helpful npm scripts

```sh
npm run db:ensure-indexes   # Ensure MongoDB indexes in production
npm run db:profile          # Toggle MongoDB profiler and inspect slow queries
npm run utxo:manage         # Run UTXO manager (sync/sweep/split) locally
```

Cryptography & Signing
All hashing, Merkle batching, and signing are handled by production services:
- `services/blockchainService.js` (v2) prepares transactions, hashing helpers, and broadcasting.
- `services/kmsSigner.js` performs all signing via an external KMS (no WIFs in codebase).
- Scripts that perform Merkle batching include local helpers where needed (e.g., `scripts/batchAnchor.js`).

Deployment Checklist
This is a high-level checklist for deploying the API to a production environment.

[ ] Secrets Management: All secrets (e.g., MONGODB_URI, JWT_SECRET, MASTER_SECRET) must be populated in a secure secrets manager.

[ ] CORS Configuration: Set CORS_ALLOWED_ORIGINS to your production domains.

[ ] Database Indexes: Verify that all necessary indexes have been created in your production MongoDB instance.

[ ] Rate Limiting: Configure and enable production-appropriate rate limiting.

[ ] Logging: Configure Winston transports to forward logs to your centralized provider (Datadog, CloudWatch, etc.).

[ ] On-Chain Funding: Ensure your chosen funding method is configured with a monitored, funded wallet.

## API Key Authentication

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
    "metadata": { "notes": "Test" },
    "auth": { "owner": "1YourInitialOwnerAddress" }
  }'
```

Notes:
- The API key value is read from the `API_KEY` environment variable (via `secrets.js`).
- In test environment (`NODE_ENV=test`), API key checks are bypassed to enable automated testing.

### Example: Rich registration payload (strict schema)

The registration endpoint enforces a strict schema. Allowed fields:
- product: uid_tag_id (required), category, sku, serial_number, material
- metadata: notes, image (URL), patch_location
- auth: owner (required)

Example (curl):

```sh
curl -X POST \
  http://localhost:3001/v1/patches \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{
    "product": {
      "uid_tag_id": "NFC_UID_011",
      "category": "jersey",
      "sku": "JERSEY-2025-007",
      "serial_number": "307100",
      "material": "Polyester + woven patch"
    },
    "metadata": {
      "notes": "Limited edition player-authenticated jersey.",
      "image": "https://vault.smartledger.solutions/assets/jersey007-front.png",
      "patch_location": "Lower right hem"
    },
    "auth": {
      "owner": "1YourInitialOwnerAddress"
    }
  }'
```

Example (PowerShell):

```powershell
$env:API_KEY = 'YOUR_API_KEY'

$body = @'
{
  "product": {
    "uid_tag_id": "NFC_UID_011",
    "category": "jersey",
    "sku": "JERSEY-2025-007",
    "serial_number": "307100",
    "material": "Polyester + woven patch"
  },
  "metadata": {
    "notes": "Limited edition player-authenticated jersey.",
    "image": "https://vault.smartledger.solutions/assets/jersey007-front.png",
    "patch_location": "Lower right hem"
  },
  "auth": {
    "owner": "1YourInitialOwnerAddress"
  }
}
'@

Invoke-RestMethod -Method POST `
  -Uri 'http://localhost:3001/v1/patches' `
  -ContentType 'application/json' `
  -Headers @{ 'x-api-key' = $env:API_KEY } `
  -Body $body
```

## JWT Authentication

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

## Ownership Transfer Authorization (Signature Verification)

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

## UTXO Funding Strategy

Current setup uses a single static UTXO defined in `utxoConfig.js`. This is simple for development but becomes a bottleneck in production (only one TX can be built at a time).

Recommended next step: implement a dynamic UTXO management service that can:
- Maintain a pool of confirmed UTXOs.
- Select appropriate inputs for each transaction (size/fee-aware coin selection).
- Refill/change handling and background consolidation.
- Support key rotation and multi-address funding.

Until that is implemented, ensure the static UTXO remains sufficiently funded and is not double-spent by concurrent operations.

### UTXO Pool Maintenance (Stale Lock Reversion)

If the server crashes or is terminated abruptly, a UTXO may be left in a `locked` state, preventing it from being used. A janitorial script is provided to clean up these stale locks.

This script should be run on a regular schedule (e.g., every 15–60 minutes) using a scheduler like cron or Windows Task Scheduler.

How it works:
- Finds UTXOs with status `locked` whose `updated_at` is older than the threshold and resets their status to `available`.

Usage (npm script):

```sh
npm run utxos:revert-stale-locks -- --older-than-mins 60 --limit 500 --dry-run=false
```

Direct node usage:

```sh
node scripts/revert-stale-locks.js --older-than-mins 60 --limit 500 --dry-run=false
```

Linux/macOS (cron) – run hourly:

```cron
0 * * * * /usr/bin/env node /opt/patchproof/scripts/revert-stale-locks.js --older-than-mins 60 --limit 500 --dry-run=false >> /var/log/patchproof/revert-stale-locks.log 2>&1
```

Windows (Task Scheduler) – PowerShell snippet:

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "C:\\opt\\patchproof\\scripts\\revert-stale-locks.js --older-than-mins 60 --limit 500 --dry-run=false"
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "PatchProof UTXO Stale Lock Reversion" -Description "Unlocks stale UTXOs for the PatchProof API."
```

### Change Address Sweep (KMS-based)

Consolidate dust from the configured change address back to the funding address using the production-grade sweep CLI. The script uses a distributed lock and never handles raw private keys; signing is centralized in `services/blockchainService.sweepAddress()` using the env funding key.

Usage:

```sh
# Dry run (no broadcast)
node scripts/sweep-change.js \
  --changeAddress 1YourChangeAddress \
  --changeKeyId keyIdentifier-for-change \
  --destinationAddress 1YourFundingAddress \
  --dryRun

# Execute sweep
node scripts/sweep-change.js \
  --changeAddress 1YourChangeAddress \
  --changeKeyId keyIdentifier-for-change \
  --destinationAddress 1YourFundingAddress
```

Notes:
- Requires Redis-backed `lockManager` initialized by the app; the script acquires `sweep-address-<changeAddress>` for 5 minutes to prevent concurrent runs.
- Signing is delegated to the external KMS via `services/kmsSigner.js` + `services/blockchainService.sweepAddress()`; no env WIFs are used.
- `--changeKeyId` is the KMS key identifier for the change address (observability/key attribution). Scripts do not accept WIFs.
- All signing is delegated to an external KMS. `blockchainService.sweepAddress()` builds the transaction, computes input sighashes, requests signatures from the KMS, applies signatures, and broadcasts.
- Broadcasting uses WOC with retries; see `clients/wocClient.js`.

KMS signer contract (summary):
- Input to KMS: `[{ keyIdentifier, sighash }]`
- Output from KMS: `[{ signatureHex, pubKeyHex }]` aligned to inputs
- Configure signer endpoint via `KMS_SIGN_URL` (+ optional `KMS_API_KEY`). See `services/kmsSigner.js` and `docs/UTXO_MAINTENANCE.md`.

### Batch Anchoring

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

## Enhanced Error Logging

The centralized error handler logs structured context for faster debugging while redacting sensitive data:
- Redacts `Authorization` header and `x-api-key`.
- Redacts body fields containing `password`, `token`, `secret`, or `signature`.
- Captures request id, method, URL, headers, and sanitized body.

Forward logs to your aggregation provider (e.g., Datadog/CloudWatch) via Winston transports for production.

## UTXO Pool Maintenance (Health, Sweep, Split)

PatchProof includes proactive UTXO pool management with confirmation-aware syncing, dust consolidation (sweep), and pool replenishment via splitting. You can run it via API or as a cron/scheduled job.

### Endpoints

- GET `/v1/admin/utxo-health` (x-api-key)
  - Returns database pool stats by status (unconfirmed/available/locked/spent), counts controlled by the funding key, and on-chain stats (with lightweight WhatsOnChain caching).
- POST `/v1/admin/utxo-maintain` (x-api-key)
  - Body: `{ "action": "auto" | "sync" | "sweep" | "split" }` (default `auto`).
  - Triggers maintenance steps on demand, returning per-step results.

Examples (PowerShell):

```powershell
curl -Method GET -Uri http://localhost:3001/v1/admin/utxo-health -Headers @{ 'x-api-key' = 'YOUR_API_KEY' }

curl -Method POST -Uri http://localhost:3001/v1/admin/utxo-maintain -Headers @{ 'x-api-key' = 'YOUR_API_KEY' } -Body '{"action":"auto"}' -ContentType 'application/json'
```

### Environment Knobs

- `UTXO_FUNDING_KEY_IDENTIFIER` (required): Stable identifier for your KMS-managed funding key (e.g., public key hex or KID).
- `KMS_SIGN_URL` (required): HTTPS endpoint for the external KMS signer.
- `KMS_API_KEY` (required): API key for the KMS signer.
- `ISSUER_KEY_IDENTIFIER` (required): Issuer key identifier used for patch signing.
- `WOC_NETWORK` (default `main`): WhatsOnChain network.
- `UTXO_MIN_CONFIRMATIONS` (default `0`): Minimum confirmations to mark UTXOs as `available` (otherwise `unconfirmed`).
- `MIN_UTXO_COUNT` or `UTXO_MIN_POOL` (default `10`): Minimum healthy pool size. Split runs when below target.
- `UTXO_SPLIT_SIZE_SATS` (default `5000`): Target size of split outputs.
- `UTXO_FEE_BUFFER` (default `2000`): Conservative fee buffer used during split.
- `DUST_THRESHOLD_SATS` (default `2000`): UTXOs below this are treated as dust.
- `DUST_SWEEP_LIMIT` (default `20`): Sweep triggers when dust count exceeds this value.
- `HEALTH_WOC_CACHE_MS` (default `5000`): In-memory cache TTL for WhatsOnChain calls used by utxo-health.
- `AUTO_MAINTAIN_ON_HEALTH` (set to `1` to enable): Automatically schedules sweep/split when GET `/v1/admin/utxo-health` detects pool below target or excessive dust.

### Run via Script (Cron/Scheduler)

The same logic is exposed as a script for cron-friendly execution and uses the centralized `utxoManagerService`:

```sh
node scripts/utxo-manager.js
```

#### Seeding a UTXO (no WIF required)
Use the secure CLI to add a single funding UTXO, associated to your KMS-managed key via key identifier:

```sh
node scripts/addUtxo.js \
  --txid 0123ab...cdef \
  --vout 1 \
  --satoshis 150000 \
  --keyId <public-key-hex-or-identifier> \
  --script <scriptPubKeyHex>
```
- To mark all other available UTXOs as spent, add `--exclusive --confirm`.
- The CLI validates the UTXO is unspent on-chain with timeouts/retries and will abort if the UTXO is already spent or cannot be verified.

Linux/macOS (cron) – run every 10 minutes:

```cron
*/10 * * * * /usr/bin/env node /path/to/project/scripts/utxo-manager.js >> /var/log/utxo-manager.log 2>&1
```

Windows (Task Scheduler) – PowerShell snippet:

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "C:\\path\\to\\project\\scripts\\utxo-manager.js"
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 10) -Once -At (Get-Date).Date
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "PatchProof UTXO Manager" -Description "Maintains the PatchProof UTXO pool."
```

Notes
- Health endpoint uses lightweight caching to reduce WOC rate consumption.
- Setting `AUTO_MAINTAIN_ON_HEALTH=1` allows passive maintenance whenever operators or monitors query `/v1/admin/utxo-health`.
- For production, consider staggering cron and monitoring intervals to smooth on-chain calls.

## 🛠️ Operations Scripts (Deploy & Rollback)

Two helper scripts live under `ops/` for quick and safe operations on your Droplet:

- `ops/deploy.sh`
  - Pulls latest code (main), installs deps, writes `DEPLOY_SHA` into `/etc/patchproof/patchproof.env`, restarts `patchproof` service.
  - Performs `/health` check and optional `/api/svd/canary` if `API_KEY` is present in environment.
  - Usage:
    ```bash
    sudo chmod +x /opt/patchproof/ops/deploy.sh
    export API_KEY=YOUR_ADMIN_API_KEY  # optional for canary
    sudo -E bash /opt/patchproof/ops/deploy.sh
    ```

- `ops/rollback.sh [git-ref]`
  - Checks out a previous commit (default `HEAD^`) or a provided ref, installs deps for that version, updates `DEPLOY_SHA`, restarts the service, runs `/health`, and (optionally) `/api/svd/canary`.
  - Usage:
    ```bash
    sudo chmod +x /opt/patchproof/ops/rollback.sh
    export API_KEY=YOUR_ADMIN_API_KEY  # optional for canary
    sudo -E bash /opt/patchproof/ops/rollback.sh         # previous commit
    sudo -E bash /opt/patchproof/ops/rollback.sh HEAD~2   # two commits back
    sudo -E bash /opt/patchproof/ops/rollback.sh <sha>    # specific commit
    ```

Health & Canary endpoints:
- `GET /health` – basic readiness probe
- `GET /api/svd/canary` – admin-gated SVD self-test/metrics; include `x-api-key`

## ✅ E2E Testing (Production-Like, No Mocks)

For a full end-to-end validation of the KMS-first, mainnet integration (no mocks), see `docs/E2E_TESTING.md`.

Highlights:
- Runs against a live server (`BASE_URL`), `NODE_ENV=production`, real Mongo/Redis/WOC/KMS.
- Exercises SVD register/begin/complete with replay prevention and `Cache-Control: no-store`.
- Checks `/metrics` compatibility (Prometheus exposition, optional API key).
- Safe-by-default guard: requires `E2E_MAINNET=1` to run.

Run:
```powershell
$env:E2E_MAINNET = "1"
$env:BASE_URL = "http://localhost:3001"
npm install
npm run test:e2e
```

---

## Developer

- Bryan Daugherty — https://github.com/Saifullah62/ — @BWDaugherty on X

🤝 Contact & Support
For support or questions, contact SmartLedger or your system integrator.