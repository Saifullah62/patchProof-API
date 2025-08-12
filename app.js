require('dotenv').config(); // This must be the first line
// app.js (Finalized Production Architecture)
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis'); // rate-limit-redis store
const { createClient } = require('redis'); // node-redis v4 client for limiter
const mongoose = require('mongoose');
const path = require('path');

const logger = require('./logger');
const { getSecret, validateRequiredSecrets } = require('./secrets');
const { initDb, closeDb } = require('./config/db');
const svdReplayCacheRedis = require('./services/svdReplayCacheRedis');
const svdChallengeCacheRedis = require('./services/svdChallengeCacheRedis');
const lockManager = require('./services/lockManager');
const { runBsvSelfTest } = require('./services/bsvSelfTest');
const jobService = require('./services/jobService');
const svdService = require('./services/svdService');
const kmsSigner = require('./services/kmsSigner');
const utxoManagerService = require('./services/utxoManagerService');
const wocClient = require('./clients/wocClient');
const configService = require('./services/configService');

// Controllers
const patchController = require('./controllers/patchController');
const authController = require('./controllers/authController');
const adminController = require('./controllers/adminController');
const setupSwagger = require('./swagger');
const authService = require('./services/authService');
const metrics = require('./services/metricsService');

// Middleware
const requestIdMiddleware = require('./requestId');
const apiKeyMiddleware = require('./apiKeyMiddleware');
const jwtAuthSvd = require('./middleware/jwtAuthSvd');

async function startServer() {
  try {
    // Global process-level safety nets
    process.on('unhandledRejection', (reason, promise) => {
      try { logger.error('Unhandled Rejection at:', { promise, reason }); } catch (_) {}
    });
    process.on('uncaughtException', (err) => {
      try { logger.error('Uncaught Exception:', err); } catch (_) {}
    });
    // Validate required secrets before initializing dependencies
    try { validateRequiredSecrets(); } catch (e) { logger.error('[Secrets] validation error', e); throw e; }
    await initDb();
    // Initialize Settings-backed config cache (non-blocking, periodic refresh)
    try { configService.initialize(60_000); logger.info('[config] ConfigService initialized'); } catch (e) { logger.warn('[config] ConfigService init failed:', e.message); }

    // Initialize distributed lock manager (Redis) before any lock usage
    try {
      await lockManager.initialize();
    } catch (err) {
      logger.warn('[LockManager] initialize() failed; locking will be disabled until Redis is available');
    }
    // Initialize Redis-backed replay cache (hard dependency in prod)
    try {
      await svdReplayCacheRedis.initialize();
      logger.info('[svd] replay cache initialized');
    } catch (err) {
      logger.error('[svd] replay cache initialization failed', err);
      if (process.env.NODE_ENV === 'production') throw err;
    }
    // Initialize Redis-backed SVD challenge cache (hard dependency in prod)
    try {
      await svdChallengeCacheRedis.initialize();
      logger.info('[svd] challenge cache initialized');
    } catch (err) {
      logger.error('[svd] challenge cache initialization failed', err);
      if (process.env.NODE_ENV === 'production') throw err;
    }
    // Initialize KMS signer early so SVD can detect readiness
    try {
      kmsSigner.initialize();
      logger.info('[kms] KmsSigner initialized');
    } catch (err) {
      logger.error('[kms] KmsSigner initialization failed', err);
    }

    // Initialize SvdService (loads secrets, checks readiness)
    try {
      svdService.initialize();
      logger.info('[svd] service initialized');
    } catch (err) {
      logger.error('[svd] service initialization failed', err);
      if (process.env.NODE_ENV === 'production') throw err;
    }

    // Initialize WhatsOnChain client
    try {
      wocClient.initialize();
      logger.info('[woc] client initialized');
    } catch (err) {
      logger.error('[woc] client initialization failed', err);
      if (process.env.NODE_ENV === 'production') throw err;
    }

    // Run BSV self-test early to detect library drift
    try {
      runBsvSelfTest();
      logger.info('[svd] bsv self-test passed');
    } catch (err) {
      logger.error('[svd] bsv self-test failed:', err);
      throw err;
    }

    // Initialize AuthService email transport explicitly
    try {
      await authService.initialize();
      logger.info('[auth] AuthService initialized');
    } catch (err) {
      logger.error('[auth] AuthService initialization failed', err);
    }

    // Initialize background job service
    try {
      await jobService.initialize();
      logger.info('[jobs] JobService initialized');
    } catch (err) {
      logger.error('[jobs] JobService initialization failed', err);
    }
    // KMS signer was already initialized above
    // Initialize UTXO Manager orchestrator (validates funding config)
    try {
      utxoManagerService.initialize();
      logger.info('[utxo] UtxoManagerService initialized');
    } catch (err) {
      logger.error('[utxo] UtxoManagerService initialization failed', err);
      if (process.env.NODE_ENV === 'production') throw err;
    }

    const app = express();

    // --- Security and Core Middleware ---
    app.set('trust proxy', 1); // Trust first proxy if behind a reverse proxy/CDN
    app.use(helmet());

    // API-key-based rate limiting with optional Redis store
    /**
     * Keying strategy:
     *  - Prefer x-api-key when present to avoid one abusive client impacting others
     *  - Fallback to IP for unauthenticated or missing key traffic
     */
    const keyGenerator = (req) => req.header('x-api-key') || req.ip;
    const limiterOptions = {
      windowMs: 15 * 60 * 1000,
      max: process.env.NODE_ENV === 'test' ? 1000 : 100,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator,
    };
    const redisUrl = process.env.REDIS_URL || process.env.REDIS_ENDPOINT || 'redis://localhost:6379';
    const redisPassword = process.env.REDIS_PASSWORD || undefined;
    try {
      const redisClient = createClient({ url: redisUrl, password: redisPassword });
      await redisClient.connect();
      logger.info('[rate-limit] Connected to Redis');
      limiterOptions.store = new RedisStore({
        // node-redis v4 requires passing a sendCommand function
        sendCommand: (...args) => redisClient.sendCommand(args),
      });
    } catch (e) {
      logger.warn(`[rate-limit] Redis unavailable at ${redisUrl}, falling back to in-memory store`);
    }
    const limiter = rateLimit(limiterOptions);
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

    // --- Lightweight WAF: block oversized bodies under /api/svd* before JSON parsing ---
    app.use((req, res, next) => {
      try {
        if (req.path && req.path.startsWith('/api/svd')) {
          const cl = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : 0;
          if (Number.isFinite(cl) && cl > 32 * 1024) {
            return res.status(413).json({ error: 'payload too large' });
          }
        }
      } catch (_) { /* ignore */ }
      next();
    });

    app.use(express.json({ limit: '1mb' }));
    app.use(requestIdMiddleware);
    app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));

    // --- Minimal internal signer route (local/private only) ---
    // Mount only when explicitly enabled and signer WIF is present on this host.
    if (String(process.env.INTERNAL_SIGNER_ENABLED || '').toLowerCase() === '1') {
      try {
        if (!process.env.SIGNER_PRIV_WIF) {
          throw new Error('SIGNER_PRIV_WIF missing while INTERNAL_SIGNER_ENABLED=1');
        }
        const internalSignerRouter = require('./routes/internalSigner.route');
        app.use('/internal/signer', internalSignerRouter);
        logger.info('[internal-signer] Mounted at /internal/signer (ensure NOT publicly exposed)');
      } catch (e) {
        logger.error('[internal-signer] failed to mount', e);
        if (process.env.NODE_ENV === 'production') throw e;
      }
    }

    // --- SVD passwordless auth routes ---
    app.use('/api', require('./routes/svdAuth'));
    app.use('/api', require('./routes/svdKid'));
    app.use('/api', apiKeyMiddleware, require('./routes/svdCanary'));

    // --- Internal metrics endpoint (protect with API key) ---
    app.get('/internal/metrics', apiKeyMiddleware, (req, res) => {
      try {
        const body = metrics.renderPrometheus();
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        return res.status(200).send(body);
      } catch (e) {
        logger.error('[metrics] render failed', e);
        return res.status(500).send('metrics unavailable');
      }
    });

    // --- Routes (V1 Only) ---
    const requireApiKeyInProd = (req, res, next) => {
      if (process.env.NODE_ENV === 'test') return next();
      return apiKeyMiddleware(req, res, next);
    };
    // Authentication routes with strict, endpoint-specific rate limits and validation
    const validateRequest = require('./middleware/validateRequest');
    const { requestVerificationLimiter, submitVerificationLimiter } = require('./middleware/authRateLimiter');
    const { requestVerificationSchema, submitVerificationSchema, registerPatchSchema, txidParamSchema, uidParamSchema, transferOwnershipSchema, unlockContentSchema } = require('./middleware/validators');
    app.post(
      '/v1/auth/request-verification',
      requestVerificationLimiter,
      validateRequest(requestVerificationSchema),
      authController.requestVerification,
    );
    app.post(
      '/v1/auth/submit-verification',
      submitVerificationLimiter,
      validateRequest(submitVerificationSchema),
      authController.submitVerification,
    );
    app.post('/v1/patches', requireApiKeyInProd, validateRequest(registerPatchSchema), patchController.registerPatch);
    app.get('/v1/patches/verify/:uid_tag_id', validateRequest(uidParamSchema, 'params'), patchController.verifyPatch);
    app.post(
      '/v1/patches/:txid/transfer-ownership',
      jwtAuthSvd,
      validateRequest(txidParamSchema, 'params'),
      validateRequest(transferOwnershipSchema),
      patchController.transferOwnership,
    );
    // Pending status polling endpoints
    app.get('/v1/patches/pending/registration/:id', patchController.getPendingRegistrationStatus);
    app.get('/v1/patches/pending/transfer/:id', patchController.getPendingTransferStatus);
    app.post(
      '/v1/patches/:uid_tag_id/unlock-content',
      apiKeyMiddleware,
      validateRequest(uidParamSchema, 'params'),
      validateRequest(unlockContentSchema),
      patchController.unlockContent,
    );
    const privacyController = require('./controllers/privacyController');
    app.get('/v1/privacy/export', jwtAuthSvd, privacyController.exportData);
    app.delete('/v1/privacy/delete', jwtAuthSvd, privacyController.deleteMe);
    
    // --- API Docs ---
    setupSwagger(app);
    // Static markdown docs (raw) available at /docs/md
    app.use('/docs/md', express.static(path.join(__dirname, 'docs')));
    // Shareable Proof-of-Existence certificates (static HTML)
    app.use('/certificates', express.static(path.join(__dirname, 'public', 'certificates')));
    // Generate certificate PDF via headless browser
    app.get('/certificates/pdf', async (req, res) => {
      const { dataHash, txid, blockHeight, timestamp, network } = req.query || {};
      if (!dataHash || !txid) {
        return res.status(400).json({ error: { message: 'Missing required query params: dataHash and txid' } });
      }
      let browser;
      try {
        // Lazy import to avoid cold start cost on app boot
        const puppeteer = require('puppeteer');
        const base = `${req.protocol}://${req.get('host')}`;
        const params = new URLSearchParams();
        params.set('dataHash', String(dataHash));
        params.set('txid', String(txid));
        if (blockHeight) params.set('blockHeight', String(blockHeight));
        if (timestamp) params.set('timestamp', String(timestamp));
        if (network) params.set('network', String(network));
        const targetUrl = `${base}/certificates/certificate.html?${params.toString()}`;

        browser = await puppeteer.launch({
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const page = await browser.newPage();
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        const pdf = await page.pdf({ format: 'A4', printBackground: true });

        res.setHeader('Content-Type', 'application/pdf');
        const safeTxid = String(txid).slice(0, 64);
        res.setHeader('Content-Disposition', `attachment; filename="patchproof-certificate-${safeTxid}.pdf"`);
        return res.status(200).end(pdf);
      } catch (err) {
        return res.status(500).json({ error: { message: 'Failed to generate PDF', details: err?.message || String(err) } });
      } finally {
        try { if (browser) await browser.close(); } catch (_) {}
      }
    });
    
    // --- Operational Endpoints ---
    const svdMetrics = require('./services/svdMetrics');
    // Admin UTXO ops
    app.get('/v1/admin/utxo-health', apiKeyMiddleware, adminController.getUtxoHealth);
    app.post('/v1/admin/utxo-maintain', apiKeyMiddleware, adminController.triggerMaintenance);
    app.post('/v1/admin/batch-anchor', apiKeyMiddleware, adminController.batchAnchor);
    // Liveness
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    // Metrics text renderer
    const metricsHandler = async (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        res.set('Content-Type', svdMetrics.getContentType());
        res.end(await svdMetrics.getMetricsAsText());
      } catch (ex) {
        res.status(500).end(String(ex?.message || ex));
      }
    };
    if (String(process.env.METRICS_REQUIRE_API_KEY || '').toLowerCase() === '1') {
      app.get('/metrics', apiKeyMiddleware, metricsHandler);
    } else {
      app.get('/metrics', metricsHandler);
    }
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

    // Error handler with contextual logging (redacted)
    app.use((err, req, res, next) => {
      const log = req.log || logger;
      const headers = { ...req.headers };
      if (headers.authorization) headers.authorization = '[REDACTED]';
      if (headers['x-api-key']) headers['x-api-key'] = '[REDACTED]';
      let body = req.body;
      try {
        // Shallow redact common secrets
        if (body && typeof body === 'object') {
          body = { ...body };
          for (const k of Object.keys(body)) {
            if (/(password|token|secret|signature|svd|pmcHex|^M$|^jti$|^cnf$)/i.test(k)) body[k] = '[REDACTED]';
          }
        }
      } catch (_) {
        body = '[unserializable]';
      }
      // For SVD routes, redact entire body to hedge against scanners or unexpected shapes
      const isSvdRoute = (req.originalUrl || req.url || '').startsWith('/api/svd');
      log.error({
        message: 'Unhandled exception',
        error: err.message,
        stack: err.stack,
        request: {
          id: req.id,
          method: req.method,
          url: req.originalUrl || req.url,
          headers,
          body: isSvdRoute ? '[REDACTED_SVD_BODY]' : body,
        },
      });
      // Map custom errors to HTTP codes
      const { ConflictError, NotFoundError, ForbiddenError, DataInconsistencyError } = require('./errors');
      if (err instanceof ConflictError) return res.status(409).json({ error: { message: err.message } });
      if (err instanceof NotFoundError) return res.status(404).json({ error: { message: err.message } });
      if (err instanceof ForbiddenError) return res.status(403).json({ error: { message: err.message } });
      if (err instanceof DataInconsistencyError) return res.status(422).json({ error: { message: err.message } });
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
          try { await jobService.close(); } catch (_) {}
          try { await svdReplayCacheRedis.close(); } catch (_) {}
          try { await svdChallengeCacheRedis.close(); } catch (_) {}
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