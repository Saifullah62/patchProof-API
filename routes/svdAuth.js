// routes/svdAuth.js
const express = require('express');
const router = express.Router();
const svdService = require('../services/svdService');
const validateRequest = require('../middleware/validateRequest');
const { svdBeginLimiter, svdCompleteLimiter } = require('../middleware/authRateLimiter');
const { svdRegisterSchema, svdBeginSchema, svdCompleteSchema } = require('../middleware/validators');
const { SvdReplayError, SvdExpiredError, SvdInvalidSignatureError, SvdBadChallengeError, SvdNoPmcError } = require('../errors');

// Note: PMS is managed by svdService (KMS-backed in production). No WIF handling here.

// Register a user's master public key (PMC)
router.post(
  '/svd/register',
  validateRequest(svdRegisterSchema),
  async (req, res, next) => {
    try {
      const { userId, pmcHex } = req.body;
      await svdService.registerPMC(userId, pmcHex);
      res.status(201).json({ success: true, message: 'PMC registered successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// Begin an SVD auth session: returns M and echoes PMC if stored
router.post(
  '/svd/begin',
  svdBeginLimiter,
  validateRequest(svdBeginSchema),
  async (req, res, next) => {
    try {
      const { userId } = req.body;
      const { M, pmcHex } = await svdService.begin(userId);
      res.set('Cache-Control', 'no-store');
      res.json({ M, pmcHex });
    } catch (err) {
      next(err);
    }
  }
);

// Complete SVD: client posts signature over M using V2C; server derives shared S and returns a JWT
router.post(
  '/svd/complete',
  svdCompleteLimiter,
  validateRequest(svdCompleteSchema),
  async (req, res, next) => {
    try {
      const { userId, M, signatureHex } = req.body;
      const { token } = await svdService.complete({
        userId,
        Mhex: M,
        signatureHex,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ token });
    } catch (err) {
      // Robust error mapping to HTTP and codes
      if (err instanceof SvdReplayError) return res.status(409).json({ error: 'SVD_REPLAYED', message: err.message });
      if (err instanceof SvdExpiredError) return res.status(400).json({ error: 'SVD_EXPIRED', message: err.message });
      if (err instanceof SvdInvalidSignatureError) return res.status(401).json({ error: 'SVD_INVALID_SIGNATURE', message: err.message });
      if (err instanceof SvdBadChallengeError) return res.status(400).json({ error: 'SVD_BAD_CHALLENGE', message: err.message });
      if (err instanceof SvdNoPmcError) return res.status(400).json({ error: 'SVD_NO_PMC', message: err.message });
      return next(err);
    }
  }
);

module.exports = router;

