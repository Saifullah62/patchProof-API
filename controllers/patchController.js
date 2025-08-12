// controllers/patchController.js
const Joi = require('joi');
const bsv = require('bsv');
const { Hash } = bsv.crypto;
const BlockchainService = require('../services/blockchainService');
const kmsSigner = require('../services/kmsSigner');
const dbService = require('../services/databaseService');
const jobService = require('../services/jobService');
const cryptoService = require('../services/cryptoService');

const registerSchema = Joi.object({
    product: Joi.object({
        // Required fields
        uid_tag_id: Joi.string().required(),

        // Optional but allowed product fields from concept
        category: Joi.string().optional(),
        sku: Joi.string().optional(),
        serial_number: Joi.string().optional(),
        material: Joi.string().optional(),
      }).required().unknown(false),

    metadata: Joi.object({
        // Optional but allowed metadata fields from concept
        notes: Joi.string().optional(),
        image: Joi.string().uri().optional(),
        patch_location: Joi.string().optional(),
      }).required().unknown(false),

    auth: Joi.object({
        owner: Joi.string().required(),
      }).required().unknown(false),

    paymentAddress: Joi.string().optional(),
});

const transferSchema = Joi.object({
    newOwnerAddress: Joi.string().required(),
    currentOwnerSignature: Joi.string().required(),
    currentOwnerPubKey: Joi.string().hex().required(),
}).unknown(false);

const txidParamSchema = Joi.object({
    txid: Joi.string().hex().length(64).required()
});

const uidParamSchema = Joi.object({
    uid_tag_id: Joi.string().min(3).max(128).required()
});

const unlockBodySchema = Joi.object({
  ownerPubKey: Joi.string().hex().required(),
  ownerSignature: Joi.string().required(),
  // Optional key unwrap + decrypt fields
  wrappedKeyB64: Joi.string().base64().optional(),
  wrapIvB64: Joi.string().base64().optional(),
  ciphertextB64: Joi.string().base64().optional(),
  cipherIvB64: Joi.string().base64().optional(),
}).unknown(false);

// Crypto utilities centralized in services/cryptoService

class PatchController {
  // POST /v1/patches
  async registerPatch(req, res, next) {
    try {
      const { error } = registerSchema.validate(req.body);
      if (error) {
          return res.status(400).json({ error: { message: 'Validation failed', details: error.details.map(d => d.message) } });
      }
      const { product, metadata, paymentAddress, auth: inputAuth } = req.body;
      const uid_tag_id = product.uid_tag_id;

      // Build canonical message and sign via KMS (no WIF in server)
      const issuerKeyIdentifier = process.env.ISSUER_KEY_IDENTIFIER;
      if (process.env.NODE_ENV === 'production' && !issuerKeyIdentifier) {
        return res.status(500).json({ error: { message: 'Server misconfigured: ISSUER_KEY_IDENTIFIER not set' } });
      }
      const ts = Date.now();
      const canonicalMsg = {
        purpose: 'register_patch',
        uid_tag_id,
        metadata_sha256: Hash.sha256(Buffer.from(JSON.stringify(metadata || {}), 'utf8')).toString('hex'),
        ts,
      };
      const hashBuf = BlockchainService.toHashBuf(canonicalMsg);
      const sighash = Buffer.from(hashBuf).toString('hex');
      let issuerSignature, issuerPubKeyHex;
      try {
        const sigs = await kmsSigner.signBatch([{ keyIdentifier: issuerKeyIdentifier, sighash }]);
        if (!Array.isArray(sigs) || sigs.length !== 1) throw new Error('KMS signing failed');
        issuerSignature = sigs[0].signatureHex;
        issuerPubKeyHex = sigs[0].pubKeyHex;
      } catch (e) {
        return res.status(503).json({ error: { message: `Issuer signing unavailable: ${e.message}` } });
      }

      const initialOwner = (inputAuth && inputAuth.owner) || paymentAddress || null;
      const record = {
        type: 'AUTHENTICATION_RECORD',
        product,
        metadata,
        auth: {
          owner: initialOwner,
          issuer_signature: issuerSignature,
          issuer_pubkey: issuerPubKeyHex,
          ts,
        },
      };

      // Create pending intent first for atomicity
      const pending = await dbService.createPendingRegistration(uid_tag_id, initialOwner, record);

      // If async jobs enabled, enqueue and return 202
      if (jobService.isEnabled()) {
        const jobId = await jobService.addBroadcastJob({ pendingId: pending._id || pending.id, record, uid_tag_id, initialOwner, purpose: 'Registration' });
        try { await dbService.attachJobToPending(pending._id || pending.id, jobId); } catch (_) {}
        if (req.log) req.log.info({ message: 'Queued registration broadcast job', jobId, uid_tag_id, pendingId: pending._id || pending.id });
        return res.status(202).json({ message: 'Queued for broadcast', jobId, uid_tag_id, pendingId: pending._id || pending.id });
      }

      // Synchronous fallback for environments without workers
      const opReturnData = [Buffer.from(JSON.stringify(record))];
      const broadcastResult = await BlockchainService.constructAndBroadcastTx(opReturnData, 'Registration', req.log);
      if (!broadcastResult.success) {
        await dbService.markRegistrationFailed(pending._id || pending.id, broadcastResult.error || 'broadcast failed');
        throw new Error(`Broadcast failed: ${broadcastResult.error}`);
      }
      const txid = broadcastResult.txid;
      record.auth.txid = txid;
      await dbService.markRegistrationConfirmed(pending._id || pending.id, txid);

      if (req.log) req.log.info({ message: 'Patch registered successfully', txid, uid_tag_id });
      // Build shareable certificate URL (blockHeight/timestamp optional and may be filled later by client)
      const mhash = Hash.sha256(Buffer.from(JSON.stringify(metadata || {}), 'utf8')).toString('hex');
      const base = `${req.protocol}://${req.get('host')}`;
      const certPath = `/certificates/certificate.html?dataHash=${encodeURIComponent(mhash)}&txid=${encodeURIComponent(txid)}`;
      const certificateUrl = `${base}${certPath}`;
      return res.status(201).json({ message: 'Patch registered successfully', txid, certificateUrl });
    } catch (err) {
      if (err.message.startsWith('Conflict:')) {
        return res.status(409).json({ error: { message: err.message } });
      }
      return next(err);
    }
  }

  // GET /v1/patches/verify/:uid_tag_id
  async verifyPatch(req, res, next) {
    try {
        const { error } = uidParamSchema.validate(req.params);
        if (error) {
            return res.status(400).json({ error: { message: 'Invalid UID Tag ID format.', details: error.details.map(d => d.message) } });
        }
      const { uid_tag_id } = req.params;
      const state = await dbService.getPatchState(uid_tag_id);
      if (!state) {
        return res.status(404).json({ status: 'not_found', message: 'Patch not registered.' });
      }
      const record = await dbService.getRecordByTxid(state.current_txid);
      if (!record) {
        return res.status(500).json({ status: 'error', message: 'Data inconsistency: State found but record is missing.' });
      }
      
      // Rebuild canonical message for verification
      const mhash = Hash.sha256(Buffer.from(JSON.stringify(record.metadata || {}), 'utf8')).toString('hex');
      const verifyMsg = {
        purpose: 'register_patch',
        uid_tag_id: record.product.uid_tag_id,
        metadata_sha256: mhash,
        ts: record.auth.ts,
      };
      const computedHashBuf = BlockchainService.toHashBuf(verifyMsg);
      const issuerSignatureValid = BlockchainService.verifySignature(
        computedHashBuf,
        record.auth.issuer_signature,
        record.auth.issuer_pubkey
      );
      
      const status = issuerSignatureValid ? 'authentic' : 'compromised';
      
      return res.json({
        status,
        record,
        verificationDetails: {
          issuerSignatureValid,
          onChainTxid: state.current_txid,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  // POST /v1/patches/:txid/transfer-ownership
  async transferOwnership(req, res, next) {
    try {
        const { error: paramsError } = txidParamSchema.validate(req.params);
        if (paramsError) {
            return res.status(400).json({ error: { message: 'Invalid TXID format.', details: paramsError.details.map(d => d.message) } });
        }
        const { error: bodyError } = transferSchema.validate(req.body);
        if (bodyError) {
            return res.status(400).json({ error: { message: 'Validation failed', details: bodyError.details.map(d => d.message) } });
        }

      const { txid: currentTxid } = req.params;
      const { newOwnerAddress, currentOwnerSignature, currentOwnerPubKey } = req.body;
      
      const currentRecord = await dbService.getRecordByTxid(currentTxid);
      if (!currentRecord) return res.status(404).json({ error: { message: 'Record not found for the given TXID' } });
      
      const uid_tag_id = currentRecord.product.uid_tag_id;

      // Load current state to check current owner address
      const state = await dbService.getPatchState(uid_tag_id);
      if (!state) return res.status(404).json({ error: { message: 'Patch state not found' } });

      // 1) PubKey must map to current owner address
      const derivedAddress = BlockchainService.publicKeyHexToAddress(currentOwnerPubKey);
      if (!state.current_owner_address || derivedAddress !== state.current_owner_address) {
        return res.status(403).json({ error: { message: 'Caller is not the current owner' } });
      }

      // 2) Verify signature over canonical message to prevent replay
      const message = { purpose: 'transfer_ownership', uid_tag_id, currentTxid, newOwnerAddress };
      const hashBuf = BlockchainService.computeSha256(message);
      const ok = BlockchainService.verifySignature(hashBuf, currentOwnerSignature, currentOwnerPubKey);
      if (!ok) {
        return res.status(403).json({ error: { message: 'Invalid owner signature' } });
      }

      // Build structured transfer record (JSON) to embed in OP_RETURN
      const ts = Date.now();
      const newRecordData = JSON.parse(JSON.stringify(currentRecord));
      newRecordData.auth.owner = newOwnerAddress;
      newRecordData.auth.prev_txid = currentTxid;
      newRecordData.auth.current_owner_pubkey = currentOwnerPubKey;
      newRecordData.auth.current_owner_signature = currentOwnerSignature;
      newRecordData.auth.ts = ts;

      // Create pending intent for atomicity
      const pending = await dbService.createPendingTransfer(uid_tag_id, currentTxid, newOwnerAddress, newRecordData);

      if (jobService.isEnabled()) {
        const jobId = await jobService.addTransferJob({ pendingId: pending._id || pending.id, uid_tag_id, currentTxid, newOwnerAddress, record: newRecordData });
        try { await dbService.attachJobToPendingTransfer(pending._id || pending.id, jobId); } catch (_) {}
        if (req.log) req.log.info({ message: 'Queued transfer broadcast job', jobId, uid_tag_id, pendingId: pending._id || pending.id });
        return res.status(202).json({ message: 'Queued for broadcast', jobId, uid_tag_id, pendingId: pending._id || pending.id });
      }

      // Synchronous fallback
      const opReturnData = [Buffer.from(JSON.stringify(newRecordData))];
      const broadcastResult = await BlockchainService.constructAndBroadcastTransferTx(
        currentTxid,
        newOwnerAddress,
        currentOwnerSignature,
        opReturnData,
        req.log
      );

      if (!broadcastResult.success) {
        await dbService.markTransferFailed(pending._id || pending.id, broadcastResult.error || 'broadcast failed');
        throw new Error(`Broadcast failed: ${broadcastResult.error}`);
      }
      const newTxid = broadcastResult.txid;
      newRecordData.auth.txid = newTxid;
      await dbService.markTransferConfirmed(pending._id || pending.id, newTxid);

      if (req.log) req.log.info({ message: 'Ownership transferred successfully', oldTxid: currentTxid, newTxid });
      return res.json({ message: 'Ownership transferred successfully', newTxid });
    } catch (err) {
      if (err.message.startsWith('Conflict:')) {
        return res.status(409).json({ error: { message: err.message } });
      }
      return next(err);
    }
  }

  // POST /v1/patches/:uid_tag_id/unlock-content
  async unlockContent(req, res, next) {
    try {
        const { error } = uidParamSchema.validate(req.params);
        if (error) {
            return res.status(400).json({ error: { message: 'Invalid UID Tag ID format.', details: error.details.map(d => d.message) } });
        }
        const { uid_tag_id } = req.params;
        const bodyCheck = unlockBodySchema.validate(req.body);
        if (bodyCheck.error) {
          return res.status(400).json({ error: { message: 'Validation failed', details: bodyCheck.error.details.map(d => d.message) } });
        }

        const { ownerPubKey, ownerSignature, wrappedKeyB64, wrapIvB64, ciphertextB64, cipherIvB64 } = req.body;

        const state = await dbService.getPatchState(uid_tag_id);
        if (!state) return res.status(404).json({ error: { message: 'Patch not found' } });

        // Verify caller owns the patch
        const derivedAddress = BlockchainService.publicKeyHexToAddress(ownerPubKey);
        if (!state.current_owner_address || derivedAddress !== state.current_owner_address) {
          return res.status(403).json({ error: { message: 'Caller is not the current owner' } });
        }

        // Verify signature to authorize unlock
        const message = { purpose: 'unlock_content', uid_tag_id, currentTxid: state.current_txid };
        const hashBuf = BlockchainService.computeSha256(message);
        const ok = BlockchainService.verifySignature(hashBuf, ownerSignature, ownerPubKey);
        if (!ok) {
          return res.status(403).json({ error: { message: 'Invalid owner signature' } });
        }

        // If no crypto payload provided, return authorization success only
        if (!wrappedKeyB64 || !wrapIvB64 || !ciphertextB64 || !cipherIvB64) {
          return res.json({ authorized: true, uid_tag_id, txid: state.current_txid });
        }

        // Attempt key unwrap + decrypt (fail-safe: cryptoService enforces missing secret policy)
        const wrappingKey = cryptoService.hkdfSha256(null, uid_tag_id, 'patchproof-unlock-key', 32);
        const wrappedKey = Buffer.from(wrappedKeyB64, 'base64');
        const wrapIv = Buffer.from(wrapIvB64, 'base64');
        const contentKey = cryptoService.aesGcmDecrypt(wrappingKey, wrapIv, wrappedKey);

        const cipherIv = Buffer.from(cipherIvB64, 'base64');
        const ciphertext = Buffer.from(ciphertextB64, 'base64');
        const plaintext = cryptoService.aesGcmDecrypt(contentKey, cipherIv, ciphertext);

        return res.json({ authorized: true, uid_tag_id, txid: state.current_txid, content: plaintext.toString('utf8') });
    } catch (err) {
      return next(err);
    }
  }

  // GET /v1/patches/pending/registration/:id
  async getPendingRegistrationStatus(req, res, next) {
    try {
      const id = req.params.id;
      if (!id || String(id).length < 8) {
        return res.status(400).json({ error: { message: 'Invalid pending id' } });
      }
      const doc = await dbService.getPendingRegistrationById(id);
      if (!doc) return res.status(404).json({ error: { message: 'Pending registration not found' } });
      let certificateUrl = null;
      if (doc.txid) {
        try {
          const record = await dbService.getRecordByTxid(doc.txid);
          if (record && record.metadata) {
            const mhash = Hash.sha256(Buffer.from(JSON.stringify(record.metadata || {}), 'utf8')).toString('hex');
            const base = `${req.protocol}://${req.get('host')}`;
            certificateUrl = `${base}/certificates/certificate.html?dataHash=${encodeURIComponent(mhash)}&txid=${encodeURIComponent(doc.txid)}`;
          }
        } catch (_) { /* ignore */ }
      }
      return res.json({
        id: doc._id,
        uid_tag_id: doc.uid_tag_id,
        status: doc.status,
        txid: doc.txid || null,
        certificateUrl,
        error: doc.failure_reason || null,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      });
    } catch (err) {
      return next(err);
    }
  }

  // GET /v1/patches/pending/transfer/:id
  async getPendingTransferStatus(req, res, next) {
    try {
      const id = req.params.id;
      if (!id || String(id).length < 8) {
        return res.status(400).json({ error: { message: 'Invalid pending id' } });
      }
      const doc = await dbService.getPendingTransferById(id);
      if (!doc) return res.status(404).json({ error: { message: 'Pending transfer not found' } });
      return res.json({
        id: doc._id,
        uid_tag_id: doc.uid_tag_id,
        status: doc.status,
        txid: doc.txid || null,
        error: doc.failure_reason || null,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PatchController();
