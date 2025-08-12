// routes/svdKid.js
// Surfaces the active SVD kid so clients can preflight. No secrets revealed.

const express = require('express');
const router = express.Router();
const svdService = require('../services/svdService');
const { publicApiLimiter } = require('../middleware/authRateLimiter');

// GET /api/svd/kid
router.get('/svd/kid', publicApiLimiter, (req, res) => {
  const kid = svdService.getActiveKid();
  if (!kid) return res.status(503).json({ error: 'service_unavailable', message: 'SVD service is not configured correctly.' });
  // Cache for 5 minutes; clients/proxies may cache this value safely
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ kid });
});

module.exports = router;
