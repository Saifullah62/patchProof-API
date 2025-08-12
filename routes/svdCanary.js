const express = require('express');
const router = express.Router();
const svdService = require('../services/svdService');
const { runBsvSelfTest } = require('../services/bsvSelfTest');
const { snapshot } = require('../services/svdMetrics');
const { svdCanaryLimiter } = require('../middleware/authRateLimiter');

// GET /api/svd/canary (admin-gated in app.js)
router.get('/svd/canary', svdCanaryLimiter, (req, res) => {
  const response = {
    ok: false,
    kid: svdService.getActiveKid(),
    metrics: snapshot(),
    timestamp: new Date().toISOString(),
  };

  try {
    runBsvSelfTest();
    response.ok = true;
  } catch (err) {
    response.error = {
      message: err?.message || String(err),
      stack: process.env.NODE_ENV !== 'production' ? err?.stack : undefined,
    };
    res.set('Cache-Control', 'no-store');
    return res.status(503).json(response);
  }

  res.set('Cache-Control', 'no-store');
  return res.json(response);
});

module.exports = router;
