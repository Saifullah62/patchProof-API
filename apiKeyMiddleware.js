// apiKeyMiddleware.js
// A secure, production-grade middleware for validating static API keys.
const crypto = require('crypto');
const logger = require('./logger');
const { getSecret } = require('./secrets');

// --- Secure Key Loading ---
// The API key is loaded once at application startup/module load.
const SERVER_API_KEY = getSecret('API_KEY');
const SERVER_KEY_BUFFER = Buffer.from(SERVER_API_KEY || '');

// Fail-fast in production if the API key is not configured.
if (process.env.NODE_ENV === 'production' && !SERVER_API_KEY) {
  logger.error('[API Key] FATAL: API_KEY is not defined. The service cannot run securely.');
  process.exit(1);
}

/**
 * A middleware that validates the 'x-api-key' header against the server's configured API key
 * using a constant-time comparison to prevent timing attacks.
 */
function apiKeyMiddleware(req, res, next) {
  const clientKey = req.header('x-api-key') || '';
  const clientKeyBuffer = Buffer.from(clientKey);

  // Use constant-time comparison when lengths match
  let areKeysEqual = false;
  if (clientKeyBuffer.length === SERVER_KEY_BUFFER.length && SERVER_KEY_BUFFER.length > 0) {
    try {
      areKeysEqual = crypto.timingSafeEqual(clientKeyBuffer, SERVER_KEY_BUFFER);
    } catch (_) {
      areKeysEqual = false;
    }
  }

  if (!areKeysEqual) {
    (req.log || logger).warn({
      message: 'Unauthorized access attempt: Invalid API key provided.',
      ip: req.ip,
      route: req.originalUrl,
    });
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid API key.' });
  }

  return next();
}

module.exports = apiKeyMiddleware;
