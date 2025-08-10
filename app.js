// app.js (Finalized Production Architecture)
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');

const logger = require('./logger');
const { getSecret } = require('./secrets');
const { initDb, closeDb } = require('./config/db'); // Mongoose lifecycle

// Controllers
const patchController = require('./controllers/patchController');
const authController = require('./controllers/authController');

// Optional correlation middleware if present
let correlationMiddleware;
try {
  correlationMiddleware = require('./requestId');
} catch (e) {
  correlationMiddleware = (req, res, next) => next();
}

async function startServer() {
  try {
    await initDb();

    const app = express();

    // Middleware
    app.use(helmet());

    const allowedOrigins = (getSecret('CORS_ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || process.env.NODE_ENV !== 'production' || allowedOrigins.includes(origin)) {
            return callback(null, true);
          }
          logger.warn(`CORS blocked request from origin: ${origin}`);
          return callback(new Error('Not allowed by CORS'));
        },
      })
    );

    app.use(express.json({ limit: '1mb' }));
    if (correlationMiddleware) app.use(correlationMiddleware);
    app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));

    // Routes (v1 only)
    // Auth
    app.post('/v1/auth/request-verification', (req, res, next) => authController.requestVerification(req, res, next));
    app.post('/v1/auth/submit-verification', (req, res, next) => authController.submitVerification(req, res, next));

    // Patches
    app.post('/v1/patches', (req, res, next) => patchController.registerPatch(req, res, next));
    app.get('/v1/patches/verify/:uid_tag_id', (req, res, next) => patchController.verifyPatch(req, res, next));
    app.post('/v1/patches/:txid/transfer-ownership', (req, res, next) => patchController.transferOwnership(req, res, next));
    app.post('/v1/patches/:uid_tag_id/unlock-content', (req, res, next) => patchController.unlockContent(req, res, next));

    // Health and Readiness Probe
    app.get('/health', (req, res) => {
      const isDbConnected = mongoose.connection.readyState === 1;
      if (isDbConnected) {
        res.json({ status: 'ok', database: 'connected' });
      } else {
        res.status(503).json({ status: 'error', database: 'disconnected' });
      }
    });

    // 404 handler
    app.use((req, res) => res.status(404).json({ error: { message: 'Not Found' } }));

    // Error handler
    app.use((err, req, res, next) => {
      const log = req.log || logger;
      log.error({ message: 'Unhandled exception', error: err.message, stack: err.stack });
      res.status(500).json({ error: { message: 'Internal Server Error' } });
    });

    if (require.main === module) {
      const PORT = process.env.PORT || 3001;
      const server = app.listen(PORT, () => {
        logger.info(`PatchProof API started on port ${PORT}`);
      });
      const gracefulShutdown = async () => {
        logger.info('Shutting down gracefully...');
        server.close(async () => {
          await closeDb();
          logger.info('Server closed.');
        });
      };
      process.on('SIGTERM', gracefulShutdown);
      process.on('SIGINT', gracefulShutdown);
    }

    return app;
  } catch (error) {
    logger.error('Fatal error during server startup:', error);
    throw error;
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
