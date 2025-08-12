# PatchProof Architecture Overview

This document provides a high-level view of services, layers, and key flows.

## Layers
- API Layer: Express routes/controllers in `controllers/` and `routes/`.
- Services Layer: Core logic in `services/` (blockchain, UTXO, jobs, SVD, etc.).
- Data Layer: Mongoose models in `models/` with indexes and migrations/scripts.
- Workers: BullMQ-based async workers in `workers/` for broadcasting and email.
- Scripts: Operational utilities in `scripts/`.
- Config/Secrets: `config/` for DB and runtime wiring; `secrets.js` centralizes secret access.
- Logging/Observability: `logger.js` with on-chain structured logs and health endpoints.

## Key Components
- BlockchainService (`services/blockchainService.js`)
  - v2 builds inputs/outputs and computes sighashes; signing is delegated to an external KMS via `services/kmsSigner.js` using a `keyIdentifier`.
  - Integrates with WhatsOnChain (WOC) for UTXO lookup/broadcast with robust retry (e.g., on "Missing inputs").
- UTXO Services
  - `models/Utxo.js`: UTXO pool with statuses: unconfirmed, available, locked, spent.
  - `services/utxoService.js`: key-agnostic, atomic DAL operating on `keyIdentifier`; provides selection/lock/spend/unlock with bulk ops and an orphaned lock reaper. No `.save()` usage.
  - `services/utxoManagerService.js`: health check, sync from chain, split planning, sweeping. Cooldown/lease handled via `Settings` KV and a Redis-backed `lockManager` using token-based locks.
- SVD (Passwordless) Auth
  - `services/svdService.js`, `routes/svdAuth.js`, `models/SvdRegistry.js`.
  - Short-TTL challenge M, low-S signatures, Redis-only caches for challenge issuance and replay protection; JWT HKDF binding.
- Jobs/Queues (`services/jobService.js`, `workers/`)
  - BullMQ integration; lifecycle-managed `JobService` with explicit `initialize()`/`close()`.
  - `workers/emailWorker.js`: verifies SMTP/Redis on start, centralized logging, graceful shutdown on signals.
- App/Server (`app.js`)
  - Startup self-tests for BSV/lib drift; initializes SvdService, JobService, KmsSigner, Redis-backed caches, and lockManager. Exposes `/metrics` for Prometheus.

## Security Controls
- API key middleware performs constant-time comparison (`crypto.timingSafeEqual`) and loads the secret once at startup; production fails fast if `API_KEY` is missing.
- Rate limits backed by Redis; per-route config with stricter SVD limits.
- Secrets accessed via `secrets.js`; never logged.

## Request Flow (Example: /v1/patches register)
1. Controller validates payload and API key (relaxed in test).
2. UTXO selected/locked (largest-first by configuration), tx built/signed with funding key.
3. Broadcast via WOC; on success, DB state updated; on error, detailed logs emitted.
4. Optionally enqueued to jobs for async email/processing.

## UTXO Lifecycle
- Ingested from WhatsOnChain to DB via `/v1/admin/utxo-health` or `scripts/utxo-manager.js`.
- Status transitions: unconfirmed → available → locked → spent (with confirmation-aware counts).
- Manager performs health check, sweep, sync, and split when pool falls below threshold.
- Cooldown/lease: enforced via `Settings` KV and `lockManager` (Redis, token-based) to prevent concurrent actions across hosts.

## Security/Resilience Highlights
- API key checks (constant-time); strict JSON schema for /v1/patches.
- Secrets centralized, never logged; SVD data redacted.
- Redis-backed rate limiting; WAF on SVD routes; no-store headers on sensitive endpoints.
- Redis-only SVD caches (fail-fast in production if unavailable).
- Operational scripts for Linux deploy; Nginx reverse proxy recommended.
