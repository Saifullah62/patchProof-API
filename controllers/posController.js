// controllers/posController.js
const Joi = require('joi');
const ClaimIntent = require('../models/ClaimIntent');
const dbService = require('../services/databaseService');
const jobService = require('../services/jobService');
const BlockchainService = require('../services/blockchainService');

const TTL_MS = parseInt(process.env.CLAIM_INTENT_TTL_MS || '180000', 10); // default 3 minutes

const createIntentSchema = Joi.object({
  uid: Joi.string().min(3).max(128).required(),
  customer: Joi.object({
    address: Joi.string().required(),
    userId: Joi.string().required(),
    pubKey: Joi.string().hex().required(),
  }).required().unknown(false),
  challenge: Joi.object({
    ts: Joi.number().integer().required(),
    nonce: Joi.string().min(6).max(128).required(),
  }).required().unknown(false),
  signature: Joi.string().hex().required(),
}).unknown(false);

const approveSchema = Joi.object({
  intentId: Joi.string().required(),
  approvedBy: Joi.string().required(),
}).unknown(false);

function buildCanonical(uid, addr, ts, nonce) {
  return `PATCHPROOF_CLAIM|uid:${uid}|addr:${addr}|ts:${ts}|nonce:${nonce}`;
}

class PosController {
  // POST /v1/pos/claim-intent
  async createClaimIntent(req, res, next) {
    try {
      const { error } = createIntentSchema.validate(req.body);
      if (error) return res.status(400).json({ error: { message: 'Validation failed', details: error.details.map(d => d.message) } });

      const { uid, customer, challenge, signature } = req.body;
      const { address, pubKey, userId } = customer;
      const { ts, nonce } = challenge;

      // TTL check
      const now = Date.now();
      if (Math.abs(now - Number(ts)) > TTL_MS) {
        return res.status(400).json({ error: { message: 'Challenge timestamp expired' } });
      }

      // Derive address from pubKey and compare
      const derivedAddr = BlockchainService.publicKeyHexToAddress(pubKey);
      if (derivedAddr !== address) {
        return res.status(400).json({ error: { message: 'Address does not match public key' } });
      }

      // Verify signature over canonical string
      const canonical = buildCanonical(uid, address, ts, nonce);
      const hashBuf = BlockchainService.computeSha256(canonical);
      const ok = BlockchainService.verifySignature(hashBuf, signature, pubKey);
      if (!ok) return res.status(401).json({ error: { message: 'Invalid signature' } });

      // Ensure patch exists
      const state = await dbService.getPatchState(uid);
      if (!state) return res.status(404).json({ error: { message: 'Patch not found' } });

      const intent = await ClaimIntent.create({
        uid,
        customer: { address, userId, pubKey },
        ts,
        nonce,
        signature,
        status: 'pending',
      });

      return res.status(201).json({ id: String(intent._id), status: intent.status });
    } catch (err) {
      return next(err);
    }
  }

  // POST /v1/pos/claim-approve
  async approveClaimIntent(req, res, next) {
    try {
      const { error } = approveSchema.validate(req.body);
      if (error) return res.status(400).json({ error: { message: 'Validation failed', details: error.details.map(d => d.message) } });

      const { intentId, approvedBy } = req.body;
      const intent = await ClaimIntent.findById(intentId);
      if (!intent) return res.status(404).json({ error: { message: 'Intent not found' } });
      if (intent.status !== 'pending') return res.status(409).json({ error: { message: `Intent is ${intent.status}` } });

      // TTL re-check
      const now = Date.now();
      if (Math.abs(now - Number(intent.ts)) > TTL_MS) {
        intent.status = 'expired';
        await intent.save();
        return res.status(409).json({ error: { message: 'Intent expired' } });
      }

      // Validate current patch state
      const state = await dbService.getPatchState(intent.uid);
      if (!state) return res.status(404).json({ error: { message: 'Patch state not found' } });

      const currentRecord = await dbService.getRecordByTxid(state.current_txid);
      if (!currentRecord) return res.status(404).json({ error: { message: 'Current record not found' } });

      // Build transfer record (mirrors transferOwnership controller style)
      const record = {
        type: 'AUTHENTICATION_RECORD',
        product: currentRecord.product,
        metadata: currentRecord.metadata,
        auth: {
          owner: intent.customer.address,
          previous_owner: state.current_owner_address,
          // Note: In POS flow, server-authorized transfer replaces current owner signature requirement.
          pos_approved_by: approvedBy,
          ts: Date.now(),
        },
      };

      const pending = await dbService.createPendingTransfer(intent.uid, state.current_txid, intent.customer.address, record);

      let jobId = null;
      if (jobService.isEnabled()) {
        jobId = await jobService.addTransferJob({
          pendingId: pending._id || pending.id,
          uid_tag_id: intent.uid,
          currentTxid: state.current_txid,
          newOwnerAddress: intent.customer.address,
          record,
          // Link back for worker-side status propagation
          posIntentId: String(intent._id),
        });
        try {
          await dbService.attachJobToPendingTransfer(pending._id || pending.id, jobId);
        } catch (e) {
          // Non-fatal: job id attachment is best-effort
          if (req && req.log) req.log.warn({ message: 'attachJobToPendingTransfer failed', error: e?.message, pendingId: String(pending._id || pending.id), jobId });
          else console.warn('[POS] attachJobToPendingTransfer failed', e);
        }
      }

      intent.status = 'approved';
      intent.approvedBy = approvedBy;
      intent.approved_at = new Date();
      intent.transfer_pending_id = String(pending._id || pending.id);
      await intent.save();

      return res.status(200).json({ id: String(intent._id), status: intent.status, pendingId: String(pending._id || pending.id), jobId });
    } catch (err) {
      return next(err);
    }
  }

  // GET /v1/pos/claim-status/:id
  async getClaimStatus(req, res, next) {
    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: { message: 'Missing id' } });
      const intent = await ClaimIntent.findById(id).lean().exec();
      if (!intent) return res.status(404).json({ error: { message: 'Not found' } });
      const { status, txid, error, approvedBy } = intent;
      return res.status(200).json({ id: String(id), status, txid: txid || null, error: error || null, approvedBy: approvedBy || null });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PosController();
