// secrets.js
// A robust, production-grade service for managing secrets and configuration.
// Provides clear precedence, caching, validation, and a pluggable hook for external secret managers.

const logger = require('./logger');

// Load .env for local development (no-op in production if not present)
try { require('dotenv').config(); } catch (_) {}

const secretsCache = {};

// Define known secrets and whether they are required in production
const SECRET_MAP = {
  // Critical application secrets
  MASTER_SECRET: { required: true },
  JWT_SECRET: { required: true },
  API_KEY: { required: true },
  MONGODB_URI: { required: true },
  REDIS_URL: { required: true },

  // KMS / signing (production requires KMS; dev/test may use fallbacks)
  KMS_SIGN_URL: { required: true },
  KMS_API_KEY: { required: true },
  ISSUER_KEY_IDENTIFIER: { required: true },
  SVD_KMS_KID: { required: false },
  SVD_USE_KMS: { required: false },

  // Public funding/display (no private keys)
  FUNDING_ADDRESS: { required: false },
  FUNDING_PUBKEY_HEX: { required: false },

  // Optional configuration
  CORS_ALLOWED_ORIGINS: { required: false },
  WOC_NETWORK: { required: false },
  MERCHANT_API_URL: { required: false },
  SMTP_HOST: { required: false },
  SMTP_PORT: { required: false },
  SMTP_USER: { required: false },
  SMTP_PASS: { required: false },
  EMAIL_FROM: { required: false },
  FEE_PER_KB: { required: false },
  METRICS_REQUIRE_API_KEY: { required: false },
};

function fromEnv(name) {
  return process.env[name] || null;
}

// Placeholder for future integrations (e.g., AWS Secrets Manager, Vault)
// Keep synchronous interface; integrate async manager via pre-loader if needed.
function fromExternalManager(_name) {
  // Not implemented. Return null to indicate miss.
  return null;
}

/**
 * Get a secret value with precedence: cache -> env -> external manager.
 * Returns null if not found.
 */
function getSecret(name) {
  if (Object.prototype.hasOwnProperty.call(secretsCache, name)) {
    return secretsCache[name];
  }
  let value = fromEnv(name);
  if (value == null && process.env.NODE_ENV === 'production') {
    // Optional: attempt external manager in production
    try { value = fromExternalManager(name); } catch (e) { logger.warn(`[Secrets] external manager error for ${name}: ${e.message}`); }
  }
  secretsCache[name] = value ?? null;
  return secretsCache[name];
}

/**
 * Require a secret to be present; throws in production if missing.
 */
function requireSecret(name) {
  const val = getSecret(name);
  if (!val) {
    const msg = `[Secrets] Required secret missing: ${name}`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    logger.warn(msg);
  }
  return val;
}

/**
 * Validate that all required secrets are present. Exit in production if any are missing.
 */
function validateRequiredSecrets() {
  logger.info('[Secrets] Validating required secrets...');
  const missing = [];
  for (const [name, cfg] of Object.entries(SECRET_MAP)) {
    if (cfg.required && !getSecret(name)) {
      missing.push(name);
    }
  }
  if (missing.length) {
    logger.error(`[Secrets] FATAL: Missing required secrets: ${missing.join(', ')}`);
    if (process.env.NODE_ENV === 'production') {
      // Fail fast in production
      process.exit(1);
    }
  } else {
    logger.info('[Secrets] All required secrets are present.');
  }
}

module.exports = {
  getSecret,
  requireSecret,
  validateRequiredSecrets,
};
