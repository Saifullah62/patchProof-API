#!/usr/bin/env bash
#
# A robust, zero-downtime deployment script for the PatchProof API.
# This script uses PM2 for graceful reloads and includes pre-deployment checks.
#
set -euo pipefail

# --- Configuration ---
APP_DIR="/opt/patchproof"
ENV_FILE="/etc/patchproof/patchproof.env"
PM2_APP_NAME="patchproof-api" # The name given in the systemd service file
HEALTH_CHECK_URL="http://localhost:3001/health"
HEALTH_CHECK_TIMEOUT_SEC=60 # Max seconds to wait for the app to become healthy

# --- Helper Functions ---
log() { echo "[deploy] ==> $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# --- Pre-flight Checks ---
log "Running pre-flight checks..."
if [[ "$(id -u)" -eq 0 ]]; then
  fail "This script should not be run as root. Run as the deployment user (e.g., 'patchproof')."
fi
if ! command -v pm2 >/dev/null 2>&1; then
  fail "PM2 is not installed or not in the current user's PATH."
fi
if [[ ! -d "$APP_DIR" ]]; then
  fail "App directory not found: $APP_DIR"
fi
if [[ ! -f "$ENV_FILE" ]]; then
  fail "Environment file not found: $ENV_FILE"
fi

# --- 1. Build Phase ---
log "Entering build phase..."
cd "$APP_DIR"

log "Pulling latest code from the 'main' branch..."
git fetch --all --prune
git checkout main
git pull --ff-only origin main

log "Installing dependencies with 'npm ci' for a clean, reproducible install..."
# Use 'npm ci' for production to ensure exact dependencies from package-lock.json
npm ci --no-audit --no-fund --omit=dev

# Inject the current commit SHA into the environment for observability
COMMIT_SHA=$(git rev-parse --short HEAD)
log "Injecting DEPLOY_SHA=${COMMIT_SHA} into environment file..."
# Create a temporary file, then replace the original to avoid corruption
temp_env=$(mktemp)
grep -v '^DEPLOY_SHA=' "$ENV_FILE" > "$temp_env" || true
echo "DEPLOY_SHA=${COMMIT_SHA}" >> "$temp_env"
# Use sudo only for the final move, assuming the deploy user has sudo rights for this action
sudo mv "$temp_env" "$ENV_FILE"
sudo chown patchproof:patchproof "$ENV_FILE" # Ensure correct ownership
sudo chmod 600 "$ENV_FILE" # Ensure correct permissions

# Run database migrations or other pre-start tasks here
log "Ensuring database indexes are up to date..."
node scripts/db/ensure-indexes.js

log "Build phase complete."

# --- 2. Run Phase (Zero-Downtime Reload) ---
log "Entering run phase..."
log "Reloading application '${PM2_APP_NAME}' with PM2 for zero downtime..."
pm2 reload "$PM2_APP_NAME" --update-env

# --- 3. Verification Phase ---
log "Verifying service health..."
start_time=$(date +%s)
while true; do
  if curl --fail -s -o /dev/null "$HEALTH_CHECK_URL"; then
    log "✅ Health check passed. Service is online."
    break
  fi

  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  if [[ $elapsed -ge $HEALTH_CHECK_TIMEOUT_SEC ]]; then
    fail "Health check timed out after ${HEALTH_CHECK_TIMEOUT_SEC} seconds. Deployment failed. Check logs: pm2 logs ${PM2_APP_NAME}"
  fi

  echo -n "."
  sleep 2
done

log "🚀 Deployment complete."
