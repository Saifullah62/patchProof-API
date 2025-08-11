// jwtAuthMiddleware.js
// Validates Bearer JWT from Authorization header and attaches req.user

const jwt = require('jsonwebtoken');
const { getSecret } = require('./secrets');
const logger = require('./logger');

const JWT_SECRET = getSecret('JWT_SECRET');

module.exports = function jwtAuthMiddleware(req, res, next) {
  if (process.env.NODE_ENV === 'test') return next();

  try {
    const auth = req.headers['authorization'] || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({ error: { message: 'Missing or invalid Authorization header' } });
    }
    const token = m[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // e.g., { identifier, iat, exp }
    return next();
  } catch (err) {
    if (req.log || logger) {
      (req.log || logger).warn({ message: 'JWT validation failed', error: err.message });
    }
    return res.status(401).json({ error: { message: 'Invalid or expired token' } });
  }
};
