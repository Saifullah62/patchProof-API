# Operations Runbook

This runbook covers day-2 operations: backups, monitoring, logs, rate limits, alerts, and incident playbooks.

## Backups
- MongoDB
  - Use `mongodump` nightly with retention policy (e.g., 7 daily, 4 weekly, 12 monthly).
  - Validate restores quarterly using `mongorestore` to a staging instance.
  - Back up indexes implicitly; `syncIndexes()` runs on startup or via `scripts/db/ensure-indexes.js`.
- Secrets
  - `/etc/patchproof/patchproof.env` managed by ops; root-only permissions. Versioned securely, never in Git.
- Config & Scripts
  - Backup `docs/`, `ops/`, and any Nginx/systemd units.

## Monitoring & Metrics
- App health endpoints:
  - `/v1/admin/utxo-health` (pool snapshot; protect with API key)
  - `/api/svd/canary` (admin gated; self-test + metrics)
- Logs (Winston): ship to your aggregator (e.g., CloudWatch, ELK). Tag with `DEPLOY_SHA`.
- SVD metrics: counters and challenge age histogram by `kid` and `DEPLOY_SHA`.
- DB metrics: enable Mongo profiler in staging via `scripts/profile-db.js` for slow query investigation.
 - Grafana: import `grafana/svd-dashboard.json` (datasource uid/name: `Prometheus`). See `docs/GRAFANA.md`.
   - KPIs at top: Success Rate (%), Error Rate (%), Logins/min.
   - Drill-down: Failure Breakdown, Challenge Age p50/p90/p99.

## Logs
- Access logs via `morgan` (if enabled) and structured app logs via `logger`.
 - On-chain logs: `logger.onChain.info(message, meta)` for UTXO changes and broadcasts.
- Redaction: SVD fields, pmcHex, challenge `M` are redacted by design.
 - API key middleware logs unauthorized attempts with route and IP (no key material).

## Rate Limits
- express-rate-limit + RedisStore (if `REDIS_URL` provided).
- Tune per route (SVD is stricter). Watch 429s in logs for tuning signals.

## Alerts
- Set alerts on:
  - Elevated 5xx rate
  - Spike in SVD replay/expired errors
  - UTXO pool below threshold for prolonged period
  - Broadcast failures containing "Missing inputs"
  - Mongo connection errors/disconnects
  - Success Rate below 99% for 5m (SVD dashboard)
  - Error Rate above 5% for 5m (SVD dashboard)
  - Challenge Age p99 approaching expiry window (e.g., > 80% of expiry) for 5m
  - Redis unavailable at startup (SVD caches/JobService/lockManager fail to initialize)

## Incident Playbooks
- Registration failing with insufficient funds
  - Check `/v1/admin/utxo-health`; run `scripts/utxo-manager.js` (dry run first) or start scheduled task.
- Frequent "Missing inputs"
  - Ensure manager syncs before splitting, confirm WOC network and min confirmations.
- JWT verification issues
  - Check active `kid`, `JWT_SECRET`, and clock skew.
- Mongo slowness
  - Verify indexes with `node scripts/db/ensure-indexes.js`; inspect with `scripts/profile-db.js`.
- Redis turbulence/unavailable
  - The app requires Redis for SVD caches, BullMQ, and locks. If Redis is down, new processes will fail fast at startup.
  - For a running instance losing Redis: expect degraded behavior and errors from SVD endpoints and job processing; restore Redis promptly and restart the app.

## Workers (Email)
- `workers/emailWorker.js` must have SMTP configured to send emails. On startup, it verifies SMTP and Redis connections and exits on fatal misconfiguration.
- Graceful shutdown: sends SIGINT/SIGTERM to allow the worker to close connections cleanly.

### Change Address Sweep (CLI)
- Purpose: Consolidate dust from the configured change address back to the funding address.
- Concurrency: Protected by a distributed lock (`sweep-address-<changeAddress>`, 5m TTL).
- Keys: Scripts never handle WIFs; signing is delegated to the external KMS via `services/kmsSigner.js` + `blockchainService`.

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

Scheduling example (cron):

```
0 2 * * * /usr/bin/node /opt/patchproof/scripts/sweep-change.js --changeAddress 1Change... --changeKeyId keyId... --destinationAddress 1Fund... >> /var/log/patchproof/sweep-change.log 2>&1
```

## Change Management
- Use `ops/deploy.sh` and `ops/rollback.sh`. Monitor canary and health post-deploy.

## Scheduling UTXO Manager (Production)
- Platform: Linux (recommended). Use cron for consistency with systemd/nginx.
- Install example cron file to `/etc/cron.d/patchproof-utxo-manager`:

  ```
  # /etc/cron.d/patchproof-utxo-manager
  SHELL=/bin/bash
  USER=patchproof
  HOME=/opt/patchproof

  */15 * * * * /usr/bin/node /opt/patchproof/scripts/utxo-manager.js >> /var/log/patchproof/utxo-manager.log 2>&1
  ```

- Create least-privilege user and dirs:
  - `useradd -r -s /usr/sbin/nologin patchproof`
  - `mkdir -p /opt/patchproof /var/log/patchproof`
  - `chown -R patchproof:patchproof /opt/patchproof /var/log/patchproof`
- Log rotation: place `ops/logrotate/patchproof-utxo-manager` into `/etc/logrotate.d/`.
- Optional: wrap with a shell script that sources `/etc/patchproof/patchproof.env` before invoking node.

Notes (refactored script):
- The manager acquires a distributed lock `utxo-manager-process` (10m TTL) via `lockManager` to prevent concurrent runs.
- Supports `--dryRun` to simulate without broadcasting or persisting changes. Example manual test:
  - `node scripts/utxo-manager.js --dryRun`
- Ensure environment is loaded in cron (either via a wrapper script or by using systemd with `EnvironmentFile=/etc/patchproof/patchproof.env`).
- Logs: `/var/log/patchproof/utxo-manager.log` as in the cron example above.

### Windows Task Scheduler (Deprecated)
- The previous PowerShell scripts in `scripts/tasks/` are deprecated and should not be used in production.
- Rationale: least-privilege, unattended execution, and alignment with Linux-based stack.

### One-time Note: Verification Code Hashing Change
- As of August 2025, verification codes are stored as bcrypt hashes (`models/VerificationCode.js`).
- Legacy documents created before this change may exist briefly with plaintext `code` and no `codeHash`.
- The service includes a guard that treats such legacy records as expired and deletes them on next submit attempt.
- Operational impact: Users who requested a code immediately before deploy may need to request a new code once after the deploy.
- No database migration is required; TTL continues to purge records automatically.

## Security Hygiene
- Rotate the KMS signing key(s) and JWT secret on a schedule.
- Update `ISSUER_KEY_IDENTIFIER` to point to the new KMS key version/alias. No raw private keys are ever loaded on the server.
- Never expose `.env`; ensure servers are locked down and patched.
- Operational scripts (sweep/split/sync) do not accept or handle private keys; all signing occurs via the external KMS (`services/kmsSigner.js`).

### KMS Key Rotation (Server)
1. Create/rotate a new key version in your KMS and allow the PatchProof service principal to use it.
2. Update environment for the app:
   - `ISSUER_KEY_IDENTIFIER` → set to the new key identifier/alias.
   - Optionally set `SVD_KMS_KID` for SVD if using a different KMS key id for SVD ops.
3. Deploy. The service will fail fast on missing/inaccessible KMS secrets.
4. After cutover, disable or schedule retirement of the old key.

### Environment Variables (Key subset)
- `KMS_SIGN_URL` (required in prod): Base URL for KMS signer API.
- `KMS_API_KEY` (required in prod): API key for KMS signer.
- `ISSUER_KEY_IDENTIFIER` (required in prod): KMS key id/alias used for issuer signatures.
- `SVD_KMS_KID` (optional): KMS key id for SVD shared-secret derivation.
- `SVD_USE_KMS` (optional): Force KMS even in non-prod.
- `FUNDING_ADDRESS` (optional): Public address for display/health checks; not a secret.
- `FUNDING_PUBKEY_HEX` (optional): 33-byte compressed SEC hex for migrations.
- `METRICS_REQUIRE_API_KEY` (optional): Require API key for `/metrics`.
