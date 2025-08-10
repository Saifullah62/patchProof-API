// requestId.js
// Express middleware to assign a unique request ID and create a per-request logger
const { randomUUID } = require('crypto');
const logger = require('./logger');

function requestIdMiddleware(req, res, next) {
  const incomingId = req.get('x-request-id');
  const requestId = incomingId || randomUUID();

  // Create a child logger with the requestId attached as a field
  req.log = logger.child({ requestId });

  res.setHeader('X-Request-Id', requestId);
  next();
}

module.exports = requestIdMiddleware;
