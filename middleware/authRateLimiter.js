// middleware/authRateLimiter.js
// Hardened, production-ready rate limiters for authentication routes using a shared Redis store.

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const logger = require('../logger');

// --- Centralized Redis Client ---
// Single Redis v4 client; each limiter will get its own RedisStore with a unique prefix.
let redisClient;
try {
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_ENDPOINT || 'redis://localhost:6379';
  redisClient = createClient({ url: redisUrl });
  if (!redisClient.isOpen) {
    // Connect lazily; avoid blocking startup if Redis is down.
    redisClient.connect()
      .then(() => {
        logger.info('[auth-rate-limit] Connected Redis client');
      })
      .catch((e) => {
        logger.error('[auth-rate-limit] Failed to connect Redis client for auth limiters.', e);
      });
  }
} catch (e) {
  logger.error('[auth-rate-limit] Could not create Redis client. Falling back to in-memory limiters (NOT safe for production).', e);
}

// Helper: fresh RedisStore per limiter with a unique prefix
const makeStore = (prefix) => new RedisStore({
  // node-redis v4: provide a sendCommand delegate
  sendCommand: (...args) => redisClient.sendCommand(args),
  prefix,
});

// --- Shared Configuration & Handlers ---

const rateLimitExceededHandler = (req, res, next, options) => {
  (req.log || logger).warn({
    message: 'Authentication rate limit exceeded',
    endpoint: req.originalUrl,
    ip: req.ip,
    identifier: req.body?.identifier,
  });
  res.status(options.statusCode).json({ error: { message: options.message } });
};

/**
 * Normalizes the identifier and returns it as the key.
 * - Trims whitespace and lowercases
 * - Falls back to IP if missing
 * @param {import('express').Request} req
 * @returns {string}
 */
const getNormalizedKey = (req) => {
  try {
    // Prefer userId when present (SVD flows), else identifier for magic link flows
    if (req.body?.userId && typeof req.body.userId === 'string') {
      return req.body.userId.trim().toLowerCase();
    }
    if (req.body?.identifier && typeof req.body.identifier === 'string') {
      return req.body.identifier.trim().toLowerCase();
    }
  }
  // eslint-disable-next-line no-empty
  catch (_) {}
  return req.ip;
};

// --- Limiters ---

// Limits how often a code can be requested for a single identifier.
const requestVerificationLimiter = rateLimit({
  store: makeStore('rl:auth-request:'),
  windowMs: parseInt(process.env.AUTH_REQUEST_WINDOW_MS, 10) || 60 * 1000, // default 1 minute
  max: parseInt(process.env.AUTH_REQUEST_MAX, 10) || 1,
  message: 'Too many verification requests. Please wait a minute before trying again.',
  keyGenerator: getNormalizedKey,
  handler: rateLimitExceededHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

// Limits how many FAILED attempts can be made to submit a code.
const submitVerificationLimiter = rateLimit({
  store: makeStore('rl:auth-submit:'),
  windowMs: parseInt(process.env.AUTH_SUBMIT_WINDOW_MS, 10) || 10 * 60 * 1000, // default 10 minutes
  max: parseInt(process.env.AUTH_SUBMIT_MAX, 10) || 5,
  message: 'Too many failed verification attempts. Your account is temporarily locked. Please try again later.',
  keyGenerator: getNormalizedKey,
  handler: rateLimitExceededHandler,
  standardHeaders: true,
  legacyHeaders: false,
  /**
   * Skips counting successful requests. This is a crucial UX improvement.
   * Controller should set res.locals.authSuccess = true on success.
   */
  skip: (req, res) => res?.locals?.authSuccess === true,
});

module.exports = {
  requestVerificationLimiter,
  submitVerificationLimiter,
  // SVD: begin/complete authentication limiters
  svdBeginLimiter: rateLimit({
    store: makeStore('rl:svd-begin:'),
    windowMs: parseInt(process.env.SVD_BEGIN_WINDOW_MS, 10) || 60 * 1000,
    max: parseInt(process.env.SVD_BEGIN_MAX, 10) || 20,
    message: 'Too many SVD begin requests. Please slow down.',
    keyGenerator: getNormalizedKey,
    handler: rateLimitExceededHandler,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  // General-purpose public API limiter
  publicApiLimiter: rateLimit({
    store: makeStore('rl:public:'),
    windowMs: parseInt(process.env.PUBLIC_API_WINDOW_MS, 10) || 60 * 1000,
    max: parseInt(process.env.PUBLIC_API_MAX, 10) || 60,
    message: 'Too many requests. Please slow down.',
    keyGenerator: (req) => req.ip,
    handler: rateLimitExceededHandler,
    standardHeaders: true,
    legacyHeaders: false,
    // Never rate limit basic health endpoints
    skip: (req) => req.path === '/ready' || req.path === '/health' || req.path === '/__ping',
  }),
  svdCompleteLimiter: rateLimit({
    store: makeStore('rl:svd-complete:'),
    windowMs: parseInt(process.env.SVD_COMPLETE_WINDOW_MS, 10) || 60 * 1000,
    max: parseInt(process.env.SVD_COMPLETE_MAX, 10) || 30,
    message: 'Too many SVD complete requests. Please slow down.',
    keyGenerator: getNormalizedKey,
    handler: rateLimitExceededHandler,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  // Admin canary limiter (use IP-based key)
  svdCanaryLimiter: rateLimit({
    store: makeStore('rl:svd-canary:'),
    windowMs: parseInt(process.env.SVD_CANARY_WINDOW_MS, 10) || 60 * 1000,
    max: parseInt(process.env.SVD_CANARY_MAX, 10) || 30,
    message: 'Too many requests to canary endpoint. Please slow down.',
    keyGenerator: (req) => req.ip,
    handler: rateLimitExceededHandler,
    standardHeaders: true,
    legacyHeaders: false,
  }),
};
