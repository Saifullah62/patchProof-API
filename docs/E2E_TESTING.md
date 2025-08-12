# End-to-End (E2E) Testing (Production-Like, No Mocks)

This document describes how to run a production-like E2E test suite against a running PatchProof server configured for mainnet and KMS-first (no server-side WIFs).

- No server-side WIFs, ever. All signing is delegated to your external KMS.
- Real integrations only: Mainnet WOC, Redis, MongoDB, KMS.
- Tests generate ephemeral client keys to drive SVD flows. These stay on the client (test harness) only.

## Prerequisites

- A running server (`npm start`) configured for production-like settings.
- Ensure these environment variables are set for the server process:
  - Core: `NODE_ENV=production`, `MONGODB_URI`, `DB_NAME`, `REDIS_URL`
  - Auth: `API_KEY`, `JWT_SECRET`, `MASTER_SECRET`
  - KMS: `KMS_SIGN_URL`, `KMS_API_KEY`, `ISSUER_KEY_IDENTIFIER`, `SVD_USE_KMS=1`, `SVD_KMS_KID`
  - UTXO: `FUNDING_ADDRESS` (KMS-controlled), `UTXO_FEE_PER_BYTE`, `WOC_NETWORK=main`, optional `WOC_API_KEY`
  - Ops: `METRICS_REQUIRE_API_KEY=1` (recommended), optional `METRICS_API_KEY`

We strongly recommend using a dedicated database (e.g., `DB_NAME=e2e_<timestamp>`) and a dedicated WOC API key for tests.

## E2E Runner Environment

E2E tests run from a separate process against the running server and require:

- `E2E_MAINNET=1`  Guard to opt into mainnet E2E runs.
- `BASE_URL`       The base URL of your server (e.g., `http://localhost:3001`).
- `METRICS_API_KEY` Optional key if `/metrics` is gated.

Example (PowerShell):

```powershell
$env:E2E_MAINNET = "1"
$env:BASE_URL = "http://localhost:3001"
$env:METRICS_API_KEY = "<if-required>"
```

## Installing and Running

The repo includes E2E tests under `tests/e2e/` and a Jest config.

- Install dependencies (updates lockfile if needed):

```powershell
npm install
```

- Run the E2E suite (server must already be running):

```powershell
npm run test:e2e
```

Jest config: `tests/e2e/jest.e2e.config.js` uses `setup.js` (guards) and `teardown.js` (no-op).

## What Gets Tested

- SVD authentication flow (`routes/svdAuth.js`, `services/svdService.js`):
  - Register -> Begin -> Complete using client-derived P2C for signing `M`.
  - `Cache-Control: no-store` on `/api/svd/complete`.
  - Replay protection: reusing the same `M` fails.
  - JWT payload contains non-sensitive `svd_proof` and `msha256`; no raw secret is ever included.

- Metrics (`/metrics` in `app.js`):
  - Prometheus exposition format; optional API-key gating via `METRICS_REQUIRE_API_KEY`.

Future additions (recommended):

- UTXO pool and on-chain split concurrency (admin endpoints; Redis locks).
- Issuer signing path via KMS-backed signing validation.
- KMS failure modes and error mapping.
- SVD expiration behavior (short TTL) and rate limit behavior.

## Safety on Mainnet

- Use small fee rates and small output sizes in admin split tests.
- Use a dedicated funding key in KMS with low-value UTXOs.
- Rate limits: provide `WOC_API_KEY` and expect exponential backoff.
- Isolate test data (dedicated `DB_NAME` and, optionally, a Redis key prefix).

## Troubleshooting

- `429` errors from WOC:
  - Provide `WOC_API_KEY` and re-run; allow time for backoff.
- Health script failures for envs:
  - Ensure `UTXO_FEE_PER_BYTE` and KMS envs are defined.
- Missing jest/eslint:
  - Run `npm install` to sync `package-lock.json`.

## File Map

- E2E tests: `tests/e2e/*.e2e.spec.js`
  - `svd.e2e.spec.js`: SVD happy path and replay prevention
  - `metrics.e2e.spec.js`: Metrics endpoint gating and format
- Runner config: `tests/e2e/jest.e2e.config.js`, `tests/e2e/setup.js`, `tests/e2e/teardown.js`
- Client helper for SVD (optional reference): `clients/svdSdk.js`

## Notes

- Production posture: No server-side WIFs; KMS-only. See `docs/SECURITY.md`.
- `/metrics` should avoid leaking secrets; verify logs do not contain tokens or signatures.
