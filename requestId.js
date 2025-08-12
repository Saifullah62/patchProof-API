// requestId.js
// Express middleware to assign a unique request ID and bind it to AsyncLocalStorage
const { randomUUID } = require('crypto');
const logger = require('./logger');
let requestContext;
try { requestContext = require('./services/requestContext'); } catch (_) { requestContext = null; }

function requestIdMiddleware(req, res, next) {
  const incomingId = req.get('x-request-id');
  const requestId = incomingId || randomUUID();

  // Child logger for convenience within handlers
  req.log = logger.child({ requestId });
  res.setHeader('X-Request-Id', requestId);

  if (!requestContext) return next();
  // Bind the requestId into AsyncLocalStorage so all logs include it automatically
  requestContext.runWithContext({ requestId }, () => next());
}

module.exports = requestIdMiddleware;
