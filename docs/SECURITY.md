# Security

This document outlines PatchProof's security model: threat considerations, secret management, key rotation, JWT claims, and PII handling.

## Threat Model (non-exhaustive)
- Credential leakage (API keys, JWT secret, WIFs)
- Replay of SVD challenges
- Weak/invalid signatures or key formats
- Request floods (DoS) and brute force
- Supply chain/library drift causing signature mismatches
- Server-side secrets exposure via logs or errors

## Core Controls
- Secrets centralized in `secrets.js`; never logged; loaded from environment and cached in-process.
- Strict SVD flow:
  - Compressed secp256k1 key validation
  - Low-S signature enforcement
  - Short TTL for challenge M
  - One-time-use via replay cache (Redis-backed in multi-instance)
  - JWT binding with `jti`/`cnf = sha256(M)` and `nbf = iat - skew`; JWTs do not contain the raw shared secret.
- API key required for protected routes (relaxed in tests only); validated using constant-time comparison to prevent timing attacks
- Rate limiting (Redis store recommended)
- WAF-like limits on SVD endpoints and payload size
- Robust logging with redaction of secrets and sensitive fields

## Secret Management
- Production: root-only env file `/etc/patchproof/patchproof.env` (chmod 600), or managed secrets service.
- Never commit secrets to Git. Avoid putting secrets into systemd unit files directly; use `EnvironmentFile`.
- Rotate secrets periodically and on incident.
- Application fails fast in production if critical secrets are missing (e.g., API_KEY), preventing a misconfigured but running instance.

## Key Rotation
- Funding keys: private keys are never handled directly by the app. All signing is delegated to the external KMS by `keyIdentifier`. Rotate KMS keys per policy.
- JWT secret (JWT_SECRET): rotate with dual-verify deployment if needed; rely on short-lived tokens.
- SVD key IDs (kid): expose active kid via endpoint and tag tokens/logs for smoother rotation.
- KMS key identifiers: operational scripts (e.g., `scripts/addUtxo.js`) must use a stable `keyIdentifier` (e.g., public key string) issued by your KMS. Private keys must never be injected into CLI flags or ad-hoc envs for one-off ops.
  - Operational scripts and services (sync/sweep/split) never accept or handle WIFs; signing is centralized via `kmsSigner` + `blockchainService` with sighash requests.

## Production KMS-Only
- In production, the server never loads or handles raw private keys (no WIFs). All cryptographic operations (issuer signing, UTXO transactions, SVD shared-secret derivation) are delegated to an external KMS.

## UTXO Data Access Layer (DAL)
- `services/utxoService.js` is key-agnostic, operating only on `keyIdentifier`.
- Uses atomic, version-safe database updates; no `.save()` on loaded documents.
- Concurrency-safe unlock/spend operations and reaper for orphaned locks.

## API Key Middleware
- `apiKeyMiddleware.js` loads `API_KEY` once at startup and uses `crypto.timingSafeEqual` for constant-time validation of `x-api-key`.
- In production, missing `API_KEY` causes immediate process exit to avoid insecure runtime.

## Workers
- `workers/broadcastWorker.js` and `workers/emailWorker.js` use robust lifecycles with verified dependencies (Redis/SMTP), centralized logging, and graceful shutdown on SIGINT/SIGTERM.

## JWT Claims & Validation
- iss/aud: set per deployment if needed.
- iat/nbf/exp: short-lived tokens; tolerate small clock skew.
- jti: unique per challenge; tracked for replay prevention.
- cnf: sha256(M) to bind token to challenge.

## PII Handling
- Minimize data collection; only required fields are stored for product/owner.
- Avoid logging request bodies containing PII; redaction defaults apply.
- Provide deletion/export tooling if regulatory requirements apply.

## Dependencies
- Pin critical crypto libs (e.g., `bsv` is pinned). Keep `lockfile` under source control.
- Startup self-test validates lib behavior to catch drift early.

## Transport & Network
- Enforce HTTPS/TLS via reverse proxy in production.
- CORS restricted to trusted origins.
- Firewalls restrict DB/Redis access to app nodes.

## Backups & Recovery
- Encrypt backups at rest. Protect access paths to dumps and env files.
- Test restores regularly in staging.

## Incident Response
- On secrets exposure: rotate keys, revoke tokens, audit access, increase logging, and perform forensics.
- Maintain contact runbook, on-call, and notification channels.
