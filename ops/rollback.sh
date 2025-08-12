#!/usr/bin/env bash
#
# A robust, zero-downtime rollback script for the PatchProof API.
# WARNING: This script only rolls back application code. It does NOT handle
# database rollbacks. A proper rollback strategy requires corresponding
# "down" migrations to revert any database schema changes.
#
set -euo pipefail

# --- Configuration ---
APP_DIR="/opt/patchproof"
ENV_FILE="/etc/patchproof/patchproof.env"
PM2_APP_NAME="patchproof-api"
HEALTH_CHECK_URL="http://localhost:3001/health"
HEALTH_CHECK_TIMEOUT_SEC=60

# --- Helper Functions ---
log() { echo "[rollback] ==> $*"; }
fail() { echo "[rollback] ERROR: $*" >&2; exit 1; }

# The git ref to roll back to (e.g., a specific commit hash or tag). Defaults to the previous commit.
TARGET_REF="${1:-HEAD^}"

# --- Pre-flight Checks ---
log "Running pre-flight checks..."
if [[ "$(id -u)" -eq 0 ]]; then
  fail "This script should not be run as root. Run as the deployment user."
fi
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed. Cannot perform a git-based rollback."
fi
if ! command -v pm2 >/dev/null 2>&1; then
  fail "PM2 is not installed or not in the current user's PATH."
fi
if [[ ! -d "$APP_DIR" ]]; then
  fail "App directory not found: $APP_DIR"
fi

# --- 1. Build Phase (Rollback) ---
log "Entering build phase..."
cd "$APP_DIR"

CURRENT_SHA=$(git rev-parse --short HEAD)
log "Current (failing) commit is ${CURRENT_SHA}."
log "Attempting to roll back to git ref: ${TARGET_REF}"

git fetch --all --prune
git checkout "$TARGET_REF"
ROLLED_BACK_SHA=$(git rev-parse --short HEAD)
log "Successfully checked out commit ${ROLLED_BACK_SHA}."

log "Installing dependencies for the rolled-back version..."
npm ci --no-audit --no-fund --omit=dev

log "Injecting rolled-back DEPLOY_SHA=${ROLLED_BACK_SHA} into environment file..."
temp_env=$(mktemp)
grep -v '^DEPLOY_SHA=' "$ENV_FILE" > "$temp_env" || true
echo "DEPLOY_SHA=${ROLLED_BACK_SHA}" >> "$temp_env"
sudo mv "$temp_env" "$ENV_FILE"
sudo chown patchproof:patchproof "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"

# --- CRITICAL WARNING ---
log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
log "!! WARNING: Code has been rolled back. If the failed deployment !!"
log "!! included a database migration, you MUST now run the        !!"
log "!! corresponding 'down' migration manually to prevent errors.  !!"
log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
read -p "Press [Enter] to continue after confirming database state..."

# --- 2. Run Phase (Zero-Downtime Reload) ---
log "Entering run phase..."
log "Reloading application '${PM2_APP_NAME}' with PM2 for zero downtime..."
pm2 reload "$PM2_APP_NAME" --update-env

# --- 3. Verification Phase ---
log "Verifying service health after rollback..."
start_time=$(date +%s)
while true; do
  if curl --fail -s -o /dev/null "$HEALTH_CHECK_URL"; then
    log "✅ Health check passed. Service is online at commit ${ROLLED_BACK_SHA}."
    break
  fi

  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  if [[ $elapsed -ge $HEALTH_CHECK_TIMEOUT_SEC ]]; then
    fail "Health check timed out after rollback. The system may be in an unstable state. Check logs: pm2 logs ${PM2_APP_NAME}"
  fi

  echo -n "."
  sleep 2
done

log "🚀 Rollback complete."
