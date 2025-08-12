# UTXO Maintenance

This document covers how PatchProof manages its UTXO pool, including health checks, syncing, sweeping, and splitting.

## Goals
- Keep enough small UTXOs available for registrations
- Avoid dust buildup and fragmented pools
- Ensure compatibility with BSV and WOC

## Components
- Model: `models/Utxo.js` (statuses: unconfirmed, available, locked, spent)
- Services: `services/utxoService.js`, `services/utxoManagerService.js`
- Script: `scripts/utxo-manager.js`
- Settings: `models/Settings.js` for cooldown and distributed split lease

## Health Check
- Marks stale/invalid/unconfirmed as appropriate
- Consolidates local state with on-chain via WOC

## Sync from Chain
- Pulls confirmed UTXOs for the funding address
- Adds new rows with `status=available` (or `unconfirmed` if below min confirmations)
- Respects `UTXO_MIN_CONFIRMATIONS`

## Splitting
- Triggered when pool < `MIN_UTXO_COUNT` (or `UTXO_MIN_POOL`)
- Plans outputs around `UTXO_SPLIT_SIZE_SATS` (or MIN/MAX range)
- Fee-aware: uses `FEE_SAT_PER_BYTE` and `UTXO_FEE_BUFFER`
- Change sent to `UTXO_CHANGE_ADDRESS`.
- Broadcast via WOC with retry on "Missing inputs"
- Cooldown: `SPLIT_COOLDOWN_MS` (persisted in Mongo)
- Lease: `SPLIT_LEASE_MS` to avoid concurrent splits across hosts

## Sweeping
- Consolidates dust from the configured change address back to the main funding address.
- Fee-aware; avoids excessive input counts where possible.
- Performed via the production-grade CLI `scripts/sweep-change.js`, which uses a distributed lock (`lockManager`) and never handles raw private keys.

### CLI

```
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

Notes:
- `--changeKeyId` is your key identifier string for observability; scripts do not accept or handle WIFs.
- All signing is delegated to an external KMS. The script calls `services/blockchainService.sweepAddress()`, which builds the transaction, computes input sighashes, requests signatures from the KMS by `keyIdentifier`, applies signatures, and broadcasts.
- The script acquires a 5-minute distributed lock named `sweep-address-<changeAddress>` to prevent concurrent runs.

KMS signer contract (summary):
- Input to KMS: `[{ keyIdentifier, sighash }]`
- Output from KMS: `[{ signatureHex, pubKeyHex }]` aligned to inputs
- Configure signer endpoint via `KMS_SIGN_URL` (+ optional `KMS_API_KEY`). See `services/kmsSigner.js`.

## Scripts
- Run on demand:
```
node scripts/utxo-manager.js            # real run
$env:SPLIT_DRY_RUN='1'; node scripts/utxo-manager.js  # dry run plan
```

To sweep the change address, see the Sweeping section above for `scripts/sweep-change.js` usage.

## Scheduling
- Production: use Linux cron. See `docs/OPERATIONS.md` → "Scheduling UTXO Manager (Production)".
  - Example cron: `/etc/cron.d/patchproof-utxo-manager`
  - Logs: `/var/log/patchproof/utxo-manager.log` (see logrotate template)

## Admin Endpoints
- `GET /v1/admin/utxo-health` — pool snapshot and on-chain stats
- `POST /v1/admin/utxo-maintenance` — trigger: { action: "sync" | "sweep" | "split" }

## Indexes
- Unique UTXO: { txid: 1, vout: 1 }
- Selection: { status: 1, keyIdentifier: 1, satoshis: -1 }

## Security
- Private keys are never stored in the database.
- Each UTXO persists a `keyIdentifier` (the funding public key string) to enable selection and observability by controller key.
- Operational scripts (split/sweep/sync) do not accept WIFs; signing is performed exclusively by an external KMS. The application never handles raw private keys.

## Troubleshooting
- Missing inputs: usually stale UTXO or race; sync then retry; manager already retries broadcast
- Network mismatch: ensure `WOC_NETWORK` matches addresses
- Insufficient funds: confirm pool is funded and the configured funding `keyIdentifier`/`FUNDING_ADDRESS` is correct
