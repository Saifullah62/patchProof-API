# Configuration

All configuration is sourced from environment variables (via `.env`) and secrets (via `secrets.js`). This doc lists the important keys by area.

## Required Secrets (Fail-Fast in Production)
The application validates these secrets at startup and will exit in production if any are missing:

- MASTER_SECRET
- JWT_SECRET
- API_KEY
- MONGODB_URI
- REDIS_URL
- UTXO_FUNDING_KEY_IDENTIFIER
- UTXO_FUNDING_ADDRESS
- UTXO_CHANGE_ADDRESS
- KMS_SIGN_URL
- KMS_API_KEY
- ISSUER_KEY_IDENTIFIER

## Core
- MONGODB_URI: Mongo connection string
- DB_NAME: Database name (default: patchproof_prod)
- PORT: HTTP port (default: 3000)
- NODE_ENV: development | production | test
- API_KEY: Required for admin/production endpoints. Loaded once at startup; in production the app exits if missing.

## Blockchain / UTXO
- WOC_NETWORK: main | test (WhatsOnChain network)
- WOC_API_KEY: Optional API key for WhatsOnChain requests (sent as `woc-api-key` header)
- WOC_TIMEOUT_MS: HTTP timeout in milliseconds for WhatsOnChain requests (default 8000)
- WOC_RETRIES: Number of retry attempts for retryable errors (default 2)
- UTXO_CHANGE_ADDRESS: Optional change address to receive change from splits; if omitted, defaults to funding address
- keyIdentifier (concept): Stable identifier for the funding key (e.g., public key string) provided by your KMS. Used by `scripts/addUtxo.js` to associate on-chain UTXOs to a managed key. No private keys are handled by scripts.
- KMS_SIGN_URL: HTTPS endpoint of your signing service used by `services/kmsSigner.js`
- KMS_API_KEY: API key for the KMS signing service (sent via Authorization header)
- MIN_UTXO_COUNT / UTXO_MIN_POOL: Minimal pool size before splitting (default 10)
- UTXO_SPLIT_SIZE_SATS: Target UTXO size (e.g., 6000) OR use range:
  - UTXO_SPLIT_SIZE_SATS_MIN
  - UTXO_SPLIT_SIZE_SATS_MAX
- MAX_SPLIT_OUTPUTS: Cap on outputs per split tx (default depends on service logic)
- FEE_SAT_PER_BYTE: Fee rate (2–3 typical)
- UTXO_FEE_BUFFER: Extra fee headroom (e.g., 3000)
- UTXO_MIN_CONFIRMATIONS: Min confs to treat on-chain UTXOs as usable
- SPLIT_COOLDOWN_MS: Cooldown between split operations (e.g., 900000 for 15 min)
- SPLIT_LEASE_MS: Distributed lease duration to avoid concurrent split (default 300000)
- SPLIT_DRY_RUN: 1 to simulate without broadcasting
  Notes:
  - Operational scripts (split/sweep/sync) never accept or handle WIFs; all signing is delegated to the external KMS via `kmsSigner`.
  - The WhatsOnChain client (`clients/wocClient.js`) is initialized at server startup in `app.js`. Standalone scripts that use it must call `wocClient.initialize()` before making requests (see `scripts/check-health.js`, `scripts/addUtxo.js`).

## Jobs / Queues
- JOBS_ASYNC: 1 to enable BullMQ flows (optional)
- REDIS_URL: Redis connection string for rate limiting, BullMQ, and SVD caches.
  - Production requires Redis availability; SVD challenge/replay caches are Redis-only and the app fails fast on startup if unavailable.

## Email / SMTP
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (or SMTP_PASSWORD): SMTP transport configuration for `workers/emailWorker.js`.
- EMAIL_FROM: Optional default "from" address; falls back to `SMTP_USER`.

## SVD (Passwordless)
- SVD_USE_KMS: Set to `1` (recommended) to force KMS-backed SVD in all environments
- SVD_KMS_KID: Optional label for the active SVD KID (e.g., `svd-kms`)
- KMS_SIGN_URL / KMS_API_KEY: KMS endpoint and API key used by `kmsSigner` to derive shared secrets
- SVD_M_TTL_SEC: Challenge M TTL (seconds, default ~180)
- SVD_BEGIN_WINDOW_MS: Rate limit window for begin requests (default 60000)
- SVD_BEGIN_MAX: Max begin requests per window (default 20)
- SVD_COMPLETE_WINDOW_MS: Rate limit window for complete requests (default 60000)
- SVD_COMPLETE_MAX: Max complete requests per window (default 30)
- SVD_CANARY_WINDOW_MS: Rate limit window for canary endpoint (default 60000)
- SVD_CANARY_MAX: Max canary requests per window (default 30)

## Authentication Rate Limiting
- AUTH_REQUEST_WINDOW_MS: Window for verification request limiting (default 60000)
- AUTH_REQUEST_MAX: Max verification requests per window (default 1)
- AUTH_SUBMIT_WINDOW_MS: Window for failed submit attempts (default 600000)
- AUTH_SUBMIT_MAX: Max failed submits per window (default 5)
- PUBLIC_API_WINDOW_MS: Window for general-purpose public endpoints (default 60000)
- PUBLIC_API_MAX: Max requests per window for public endpoints (default 60)
  Notes:
  - Limits are keyed by a normalized identifier (trimmed, lowercased). If missing, falls back to IP.
  - A shared Redis store (REDIS_URL) is required for limits to be enforced across multiple instances.

## Security
- JWT_SECRET: HMAC secret for JWT creation/verification
- RATE_LIMIT_*: Configuration for express-rate-limit and RedisStore if present
  - AUTH_REQUEST_WINDOW_MS, AUTH_REQUEST_MAX, AUTH_SUBMIT_WINDOW_MS, AUTH_SUBMIT_MAX, PUBLIC_API_WINDOW_MS, PUBLIC_API_MAX, etc.

## Deployment
- DEPLOY_SHA: Optional release identifier included in metrics/logs
 - /metrics endpoint is exposed for Prometheus scraping via `prom-client`.

## Tips
- Never commit real secrets. For production, mount `/etc/patchproof/patchproof.env` (see DEPLOYMENT_DO.md).
- Validate addresses match `WOC_NETWORK` (1* => main).
- Manual UTXO seeding uses `scripts/addUtxo.js` with `--keyId` (KMS public key identifier). Do not place WIFs into CLI flags or additional envs for this operation.
