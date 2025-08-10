// app.js (Finalized Production Architecture)
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const logger = require('./logger');
const { getSecret } = require('./secrets');
const { initDb, closeDb } = require('./config/db');

// Controllers
const patchController = require('./controllers/patchController');
const authController = require('./controllers/authController');

// Middleware
const requestIdMiddleware = require('./requestId');

async function startServer() {
  try {
    await initDb();

    const app = express();

    // --- Security and Core Middleware ---
    app.set('trust proxy', 1); // Trust first proxy if behind a reverse proxy/CDN
    app.use(helmet());

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: process.env.NODE_ENV === 'test' ? 1000 : 100, // 100 requests per IP per 15 min
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use(limiter);

    const allowedOrigins = (getSecret('CORS_ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
    app.use(cors({
        origin: (origin, callback) => {
          if (!origin || process.env.NODE_ENV !== 'production' || allowedOrigins.includes(origin)) {
            return callback(null, true);
          }
          logger.warn(`CORS blocked request from origin: ${origin}`);
          return callback(new Error('Not allowed by CORS'));
        },
    }));

    app.use(express.json({ limit: '1mb' }));
    app.use(requestIdMiddleware);
    app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));

    // --- Routes (V1 Only) ---
    app.post('/v1/auth/request-verification', authController.requestVerification);
    app.post('/v1/auth/submit-verification', authController.submitVerification);
    app.post('/v1/patches', patchController.registerPatch);
    app.get('/v1/patches/verify/:uid_tag_id', patchController.verifyPatch);
    app.post('/v1/patches/:txid/transfer-ownership', patchController.transferOwnership);
    app.post('/v1/patches/:uid_tag_id/unlock-content', patchController.unlockContent);
    
    // --- Operational Endpoints ---
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    app.get('/ready', (req, res) => {
        const isDbConnected = mongoose.connection.readyState === 1;
        if (isDbConnected) {
            res.json({ status: 'ready', database: 'connected' });
        } else {
            res.status(503).json({ status: 'not_ready', database: 'disconnected' });
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