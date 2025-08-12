// middleware/jwtAuthSvd.js
// Hardened JWT verification middleware that securely validates SVD-bound tokens.

const jwt = require('jsonwebtoken');
const { getSecret } = require('../secrets');
const logger = require('../logger');

const JWT_SECRET = (typeof getSecret === 'function' && getSecret('JWT_SECRET')) || process.env.JWT_SECRET;

// --- CRITICAL SECRET CHECK ---
// Fail-fast on startup if the JWT_SECRET is missing or insecure in production.
if (process.env.NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET === 'change-me')) {
  logger.error('[JWT] FATAL: JWT_SECRET is not defined or is insecure. The service cannot run.');
  process.exit(1);
}

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

module.exports = function jwtAuthSvd(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token', message: 'Authorization token is required.' });
  }

  const token = authHeader.slice(7);

  try {
    // --- SECURE VERIFICATION ---
    // Use jwt.verify as the single, atomic operation for both verification and decoding.
    // The `complete: true` option safely returns the decoded header and payload.
    const { header, payload } = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      complete: true,
    });

    // --- SVD BINDING VALIDATION ---
    const cnf = payload.cnf || {};
    const msha = cnf.msha256;
    const jti = payload.jti;

    // The presence of 'cnf.msha256' is the definitive indicator of an SVD-bound token.
    if (msha) {
      // If the SVD claim exists, the binding MUST be valid.
      if (!isHex64(msha) || !isHex64(jti) || msha.toLowerCase() !== jti.toLowerCase()) {
        logger.warn({ message: 'Invalid SVD token binding detected', jti, msha, sub: payload.sub });
        return res.status(401).json({ error: 'invalid_svd_binding', message: 'SVD token binding is invalid.' });
      }

      req.auth = {
        userId: payload.sub,
        svd: true,
        svdKid: header.kid || null, // Key ID from the verified header
        svdJti: jti,
      };
    } else {
      // This is a standard, non-SVD JWT.
      req.auth = {
        userId: payload.sub,
        svd: false,
      };
    }

    return next();
  } catch (err) {
    // --- CONTEXTUAL ERROR HANDLING ---
    if (err instanceof jwt.TokenExpiredError) {
      logger.info({ message: 'Expired JWT presented', expiredAt: err.expiredAt });
      return res.status(401).json({ error: 'token_expired', message: 'Token has expired.' });
    }
    if (err instanceof jwt.JsonWebTokenError) {
      logger.warn({ message: 'Invalid JWT presented', error: err.message });
      return res.status(401).json({ error: 'token_invalid', message: `Token is invalid: ${err.message}` });
    }

    // For any other unexpected errors, pass to the global error handler.
    return next(err);
  }
};
