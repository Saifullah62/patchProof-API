# Getting Started

This guide helps you run PatchProof locally and in staging.

## Prerequisites
- Node.js 18+
- MongoDB 6+ (local or Atlas)
- Redis (recommended for rate limiting/queues; optional for local dev)

## Install
```
npm install
```

## Configuration
Copy `.env.example` to `.env` and populate required values. See CONFIGURATION.md for details.

Minimal local set:
```
MONGODB_URI=mongodb://localhost:27017
DB_NAME=appdb
API_KEY=dev-api-key
WOC_NETWORK=main
KMS_SIGN_URL=mock
KMS_API_KEY=dev
ISSUER_KEY_IDENTIFIER=dev-issuer
FUNDING_ADDRESS=1BGATxgPpuF8iGmKGQWpX4Rzt7PbjQzFUb
```

### Production configuration (authenticated connections)

Use authenticated URIs for MongoDB and Redis in staging/production. Rotate credentials regularly.

MongoDB (example):
```
MONGODB_URI=mongodb://patchproof_user:${MONGO_PASSWORD}@mongo.internal:27017/patchproof?authSource=admin
DB_NAME=patchproof
```

Redis (example):
```
REDIS_URL=redis://patchproof:${REDIS_PASSWORD}@redis.internal:6379
```

Secrets to set with strong randoms (generate via `openssl rand -hex 32`):
```
API_KEY=
JWT_SECRET=
MASTER_SECRET=
KMS_API_KEY=
```

Key rotation guidance:
- Change keys in your secret manager or server env.
- Deploy with new values; verify health and auth endpoints.
- Invalidate old keys/secrets in dependent systems (e.g., Nginx, KMS).
- For compromised credentials, rotate immediately and audit access logs.

## Run the server
```
npm start
```
- App will connect to Mongo and start HTTP server.

## Health checks
- Admin UTXO health (requires admin auth if enabled): `/v1/admin/utxo-health`
- SVD canary (admin-gated): `/api/svd/canary`

## UTXO seeding for local testing
- Seed a known UTXO via `scripts/addUtxo.js` or set up `scripts/utxo-manager.js` to sync from chain.

  Example:
  
  ```sh
  node scripts/addUtxo.js \
    --txid 0123ab...cdef \
    --vout 1 \
    --satoshis 150000 \
    --keyId <public-key-hex-or-identifier> \
    --script <scriptPubKeyHex>
  ```
  
  - Use `--exclusive --confirm` to mark all other available UTXOs as spent.

## Common scripts
- `node scripts/utxo-manager.js` — health/sync/split/sweep
- For production scheduling, use Linux cron. See `docs/OPERATIONS.md` → "Scheduling UTXO Manager (Production)".
- `node scripts/db/ensure-indexes.js` — ensure DB indexes

### Janitor and Recovery
- Revert stale UTXO locks:
  - `npm run utxos:revert-stale-locks -- --older-than-mins 60 --limit 500`
- Recover orphaned anchors (requeue stuck records):
  - `npm run jobs:recover-orphaned`

## Next steps
- Read ARCHITECTURE.md for high-level overview
- See API.md for endpoints
- See UTXO_MAINTENANCE.md for pool management

## Proof-of-Existence Certificate (Shareable)
After a patch is confirmed on-chain, you can share a simple certificate page:

```
http://localhost:3001/certificates/certificate.html?dataHash=<sha256>&txid=<txid>&blockHeight=<height>&timestamp=<unix_or_iso>&network=main
```

- The page renders a printable view and a block explorer link (WhatsOnChain).
- `network` can be `main` or `test` (defaults to `main`).

## Operations: Queue Monitoring and Alerts
- Bull Board dashboard (local-only by default):
  - Start: `npm run queues:dashboard`
  - URL: `http://127.0.0.1:${QUEUES_DASHBOARD_PORT:-5050}/queues`
  - Gate with `x-api-key: ${ADMIN_API_KEY}` if set.
- Failed jobs reporter (CI/cron-friendly):
  - List: `npm run jobs:report-failed`
  - Retry all: `node scripts/jobs/report-failed.js --retry`
  - Requeue: `node scripts/jobs/report-failed.js --requeue`

## Dynamic Fees and Runtime Settings
- Recommended fee-per-kB can be set via `Settings` or env.
  - Script to set/update: `npm run fees:refresh -- --set 512`
  - Or fetch from URL returning `{ feePerKb: number }`:
    - `npm run fees:refresh -- --from-url https://example.com/fee.json`
- Runtime Settings keys (in `models/Settings.js`):
  - `FEE_PER_KB`
  - `MIN_UTXO_COUNT`
  - `UTXO_SPLIT_SIZE_SATS`
  - `MAX_SPLIT_OUTPUTS`
  - `DUST_THRESHOLD_SATS`
  - `DUST_SWEEP_LIMIT`
  - `UTXO_MIN_CONFIRMATIONS`

The app periodically refreshes these via `services/configService.js` and applies updates without redeploy.
