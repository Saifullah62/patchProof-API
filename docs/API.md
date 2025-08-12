# API Reference (v1)

This document lists the primary HTTP endpoints and their behaviors.

Base URL: http://localhost:3001
All JSON responses set Cache-Control appropriately. Sensitive routes may use no-store.

## Authentication
- API key header: `x-api-key: <API_KEY>`
- In test mode, some routes are relaxed to match integration tests.
 - Security: API key is validated using a constant-time comparison (`crypto.timingSafeEqual`). The key is loaded once at startup from `secrets.js`. In production, the service fails fast if `API_KEY` is missing.

## Registration
POST /v1/patches
- Purpose: Register a product/patch linking to an owner.
- Auth: API key (relaxed under test per config)
- Body (allowed fields only):
  - product: { uid_tag_id, category, sku, serial_number, material }
  - metadata: { notes, image, patch_location }
  - auth: { owner }
- Flow: Validates schema → selects UTXO → builds/signs tx → broadcasts → persists record.
- Errors: 400 (validation), 401 (auth), 402 (insufficient funds), 500 (broadcast)

GET /v1/patches/pending/registration/:id
- Purpose: Poll the status of a pending registration by its id.
- Response: { status: "pending" | "anchoring" | "confirmed" | "failed", ... }

GET /v1/patches/pending/transfer/:id
- Purpose: Poll the status of a pending ownership transfer by its id.
- Response: { status: "pending" | "anchoring" | "confirmed" | "failed", ... }

POST /v1/patches/:txid/transfer-ownership
- Purpose: Transfer ownership of a patch to a new address.
- Auth: Requires BOTH API key (`x-api-key`) and Bearer JWT (`Authorization: Bearer <jwt>`)
- Body: `{ newOwnerAddress, currentOwnerPubKey, currentOwnerSignature }`
- Validation: Ensures `currentOwnerPubKey` matches current owner on record and signature is valid over canonical payload.

## Admin UTXO Health
GET /v1/admin/utxo-health
- Purpose: View pool health, funding address, thresholds, on-chain stats.
- Auth: API key required (in production).
- Query: optional caching knobs.
- Response includes counts for available/unconfirmed/locked/spent and on-chain snapshot.

POST /v1/admin/utxo-maintenance
- Purpose: Trigger maintenance actions: sync/sweep/split.
- Auth: API key required.
- Body example: { action: "sync" | "sweep" | "split" }

## SVD (Passwordless)
POST /api/svd/begin
- Purpose: Issue short-lived challenge M for passwordless auth.
- Validation: body `{ userId: <24-hex> }`
- Rate limited per-user; response avoids exposing sensitive material.
- Example request:
  ```json
  { "userId": "64b7f5e6ab9f2ea0c2d1f1aa" }
  ```
- Example response:
  ```json
  { "M": "<48-hex>", "pmcHex": "<66-hex>" }
  ```

POST /api/svd/complete
- Purpose: Verify proof, enforce low-S signatures, issue JWT bound to challenge.
- Validation: body `{ userId: <24-hex>, M: <48-hex>, signatureHex: <DER hex> }`
- Errors: see Error Codes below; also rate limit exceeded (429).
- Example request:
  ```json
  {
    "userId": "64b7f5e6ab9f2ea0c2d1f1aa",
    "M": "...",
    "signatureHex": "3045..."
  }
  ```
- Example response:
  ```json
  { "token": "<jwt>" }
  ```

GET /api/svd/kid
- Purpose: Return active key id for client-side binding.
- Headers: Cache-Control: no-store.

GET /api/svd/canary (admin-gated)
- Purpose: Health/self-test/metrics (challenge age histogram, counters).

## Metrics

GET /metrics
- Purpose: Prometheus exposition of SVD/app metrics.
- Gating: Optionally gated by API key via `METRICS_REQUIRE_API_KEY=1`.

GET /internal/metrics
- Purpose: Prometheus exposition of internal counters (e.g., `pp_challenges_issued`, `pp_jwt_success`).
- Gating: Always API-key protected. Additionally recommended to block `/internal/*` at the edge (Nginx).

Error Codes
- `SVD_REPLAYED` (409)
- `SVD_EXPIRED` (400)
- `SVD_INVALID_SIGNATURE` (401)
- `SVD_BAD_CHALLENGE` (400)
- `SVD_NO_PMC` (400)

Notes
- Rate limiting env vars: `SVD_BEGIN_WINDOW_MS`, `SVD_BEGIN_MAX`, `SVD_COMPLETE_WINDOW_MS`, `SVD_COMPLETE_MAX`.
- See `docs/SVD_AUTH.md` for full flow, validation, and configuration details.

## Error Model
- All application errors extend a centralized `AppError` base carrying an HTTP status code (see `errors.js`).
- JSON shape:
  ```json
  {
    "error": {
      "name": "NotFoundError",
      "message": "Resource not found",
      "code": "NOT_FOUND",
      "status": 404,
      "details": { }
    }
  }
  ```
- SVD errors use typed classes (e.g., `SvdReplayError`, `SvdInvalidSignatureError`) mapped to specific HTTP codes as documented above.
- Logs redact SVD fields, `pmcHex`, and challenge `M`.

## Notes
- JWTs include jti/cnf (sha256(M)), nbf, iat; signed with current kid.
- Registration signatures use hardened deterministic hashing (safe-stable-stringify) and DER hex output.
