// logger.js
// A robust, production-grade Winston logger with environment-specific formatting.
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, json, errors, colorize, printf } = format;
let requestContext;
try { requestContext = require('./services/requestContext'); } catch (_) { requestContext = null; }

// --- Environment-Specific Formatting ---
// Use a simple, colorized format for development and structured JSON for production.
const withRequestId = format((info) => {
  if (requestContext) {
    const rid = requestContext.get('requestId');
    if (rid && !info.requestId) info.requestId = rid;
  }
  return info;
});

const devFormat = combine(
  withRequestId(),
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  printf(({ timestamp, level, message, ...meta }) => {
    const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta, null, 2)}` : '';
    return `${timestamp} ${level}: ${message}${rest}`;
  })
);

const prodFormat = combine(
  withRequestId(),
  timestamp(),
  errors({ stack: true }),
  json()
);

const isProduction = process.env.NODE_ENV === 'production';

// --- Main Logger Instance ---
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isProduction ? prodFormat : devFormat,
  transports: [
    new transports.Console(),
    // Add other production transports (e.g., file, HTTP) here if needed.
  ],
  // Do not exit on handled exceptions
  exitOnError: false,
});

// --- Child Logger for On-Chain Events ---
// This is the correct and efficient way to create specialized log streams.
// It inherits all the configuration from the parent logger.
logger.onChain = logger.child({ service: 'onchain-events' });

module.exports = logger;
