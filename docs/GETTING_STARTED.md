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

## Next steps
- Read ARCHITECTURE.md for high-level overview
- See API.md for endpoints
- See UTXO_MAINTENANCE.md for pool management
