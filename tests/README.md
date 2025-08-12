# Test Suites

This repository uses a Testing Pyramid approach:

- Unit: fast, isolated tests for core services.
- Integration: thin seams across process boundaries (e.g., Redis queues) with critical externals mocked.
- E2E: production-like flows against a running server; opt-in via environment.

## Structure

- `tests/unit/`
  - `blockchainService.test.js`: Fee sourcing priority and sizing for v2 blockchain service.
  - `utxoService.test.js`: DAL operations for UTXO pool (lock, spend, unlock, reaper, queries).
  - `utxoManagerService.split.test.js`: Split planning paths and lock lease behavior.
  - `utxoManagerService.test.js`: Initialization/dust handling scaffold.
  - Note: `unit/services/utxoService.spec.js` was deprecated and will be removed; use `unit/utxoService.test.js` instead.

- `tests/integration/`
  - `workers/broadcastWorker.spec.js`: Broadcast worker + BullMQ using real Redis; `services/blockchainService` is mocked to prevent network I/O.

- `tests/e2e/`
  - `patches.e2e.spec.js`: Full lifecycle (register → verify → transfer → unlock).
  - `admin.utxo.e2e.spec.js`: Admin maintenance/health endpoints.
  - `metrics.e2e.spec.js`: Prometheus exposition.
  - `svd.e2e.spec.js`, `svd.kid.e2e.spec.js`: Secure Verification Dance endpoints.
  - All E2E suites auto-skip unless `BASE_URL` is set.

## Running tests

- Unit (default):
  ```bash
  npm test
  ```

- Integration (requires Redis):
  - Ensure Redis is running (defaults: host `127.0.0.1`, port `6379`).
  - Run full suite (unit + integration):
    ```bash
    npm test
    ```
  - The integration spec will detect missing Redis and skip gracefully.

- E2E (requires running server):
  - Set required environment:
    - `BASE_URL` (e.g., `http://localhost:3000`)
    - Optional: `API_KEY` for admin routes, `METRICS_API_KEY` if `/metrics` is gated
  - Then run with the E2E Jest config:
    ```bash
    npx jest -c tests/e2e/jest.e2e.config.js --runInBand
    ```

## Environment notes

- Fees: unit tests stub dynamic sources; they do not call external services.
- Redis: integration test uses `ioredis` and will skip if it cannot `PING`.
- E2E: tests are long-running and hit real services; they are opt-in and safe to keep in CI since they skip by default.

## Maintenance

- Prefer adding unit tests for pure logic and deterministic behavior.
- Add integration tests where interaction surfaces are critical but can be controlled (e.g., queues, locks).
- Keep E2E focused and minimal; rely on health checks, polling helpers, and clear guards.
- Remove or update any test that references APIs no longer present in the codebase.
