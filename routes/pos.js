// routes/pos.js
const express = require('express');
const router = express.Router();
const posController = require('../controllers/posController');
const apiKeyMiddleware = require('../apiKeyMiddleware');

// Create claim intent (customer-signed)
router.post('/pos/claim-intent', posController.createClaimIntent);

// Approve claim (POS/cashier) — protected by admin API key
router.post('/pos/claim-approve', apiKeyMiddleware, posController.approveClaimIntent);

// Query claim status
router.get('/pos/claim-status/:id', posController.getClaimStatus);

module.exports = router;
