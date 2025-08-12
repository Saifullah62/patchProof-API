# SVD (Passwordless) Authentication

This document describes the passwordless SVD flow, security guarantees, and endpoints.

## Overview
SVD provides a challenge/response flow using secp256k1 signatures with strong constraints (compressed keys, low-S) and replay protection. Tokens are JWTs bound to the short-lived challenge.

## Components
- Routes: `routes/svdAuth.js`
- Service: `services/svdService.js`
- Model: `models/SvdRegistry.js`
- Middleware: JWT verification extended with SVD binding checks

## Flow
1. Client calls `POST /api/svd/begin` to obtain challenge `M` (short TTL).
2. Client signs `M` with private key, submits to `POST /api/svd/complete`.
3. Server verifies signature (low-S), validates TTL and replay protections, issues JWT.

## Validation
All SVD routes use centralized Joi validation via `middleware/validators.js`.

- Register PMC (`POST /api/svd/register`):
  - Body: `{ userId: <24-hex>, pmcHex: <66-hex compressed SEC> }`
- Begin (`POST /api/svd/begin`):
  - Body: `{ userId: <24-hex> }`
- Complete (`POST /api/svd/complete`):
  - Body: `{ userId: <24-hex>, M: <48-hex>, signatureHex: <DER signature hex> }`

Inputs are trimmed/normalized by schemas; invalid requests return HTTP 400 with error details.

## Security Features
- Challenge TTL: configurable (default ~3 minutes)
- One-time-use: `M` hash cached; replayed completes are rejected
- Low-S enforcement: canonical signatures only
- Key validation: compressed secp256k1 public keys
- JWT binding: `jti` and `cnf = sha256(M)`; `nbf` set to `iat - skew`
- Logging redaction: hides `M`, SVD fields, and pmcHex in logs
- Rate limiting: per-user on begin/complete
- Replay cache: in-memory, optional Redis-backed for multi-instance

## Examples

- Register PMC
  Request:
  ```json
  {
    "userId": "64b7f5e6ab9f2ea0c2d1f1aa",
    "pmcHex": "03c1e3...a9"  
  }
  ```
  Response:
  ```json
  { "success": true, "message": "PMC registered successfully." }
  ```

- Begin
  Request:
  ```json
  { "userId": "64b7f5e6ab9f2ea0c2d1f1aa" }
  ```
  Response (no-store):
  ```json
  { "M": "...48 hex...", "pmcHex": "03..." }
  ```

- Complete
  Request:
  ```json
  {
    "userId": "64b7f5e6ab9f2ea0c2d1f1aa",
    "M": "...48 hex...",
    "signatureHex": "3045..."
  }
  ```
  Response:
  ```json
  { "token": "<jwt>" }
  ```

## Configuration
- `SVD_USE_KMS` (recommended `1`): force KMS-backed SVD even in dev
- `SVD_KMS_KID` (optional): active SVD key identifier label
- `KMS_SIGN_URL`: HTTPS endpoint for KMS shared-secret derivation
- `KMS_API_KEY`: API key for KMS
- `SVD_M_TTL_SEC`: challenge TTL
- `JWT_SECRET`: HMAC for JWT
- `REDIS_URL`: enable Redis-backed replay/replay protection and rate limiting (recommended in prod)
- Rate limiter (per-user):
  - `SVD_BEGIN_WINDOW_MS` (default 60000)
  - `SVD_BEGIN_MAX` (default 20)
  - `SVD_COMPLETE_WINDOW_MS` (default 60000)
  - `SVD_COMPLETE_MAX` (default 30)

## Endpoints
- `POST /api/svd/begin`: returns `M` and metadata (no secrets)
- `POST /api/svd/complete`: returns JWT on success
- `GET /api/svd/kid`: active key id for clients
- `GET /api/svd/canary` (admin): health/self-test/metrics; Cache-Control: no-store

## Error Codes
The following SVD-specific error codes may be returned:
- `SVD_REPLAYED` (409)
- `SVD_EXPIRED` (400)
- `SVD_INVALID_SIGNATURE` (401)
- `SVD_BAD_CHALLENGE` (400)
- `SVD_NO_PMC` (400)

## Metrics
- Counters for begin/complete/success/error
- Challenge age histogram by kid and DEPLOY_SHA

## Troubleshooting
- Expired `M`: clock skew or network delay—client should retry begin
- Replay detected: ensure client deduplicates and respects one-time-use
- Signature invalid: check key format (compressed) and low-S
