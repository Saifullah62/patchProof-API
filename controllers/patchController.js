// controllers/patchController.js
const BlockchainService = require('../services/blockchainService');
const dbService = require('../services/databaseService');
const Joi = require('joi');

class PatchController {
  // POST /v1/patches
  async registerPatch(req, res, next) {
    try {
      const registerSchema = Joi.object({
        product: Joi.object({
          uid_tag_id: Joi.string().trim().min(1).required(),
          name: Joi.string().trim().optional(),
          // allow additional product fields but ensure object
        }).required(),
        metadata: Joi.object().required(),
        paymentAddress: Joi.string().trim().optional(),
        auth: Joi.object({
          owner: Joi.string().trim().optional(),
        }).optional(),
      }).unknown(false);

      const { value, error } = registerSchema.validate(req.body || {});
      if (error) {
        return res.status(400).json({ error: { message: 'Invalid request body', details: error.details.map(d => d.message) } });
      }
      const { product, metadata, paymentAddress, auth: inputAuth } = value;
      const uid_tag_id = product.uid_tag_id;

      // 1) Hash
      const dataToHash = { product, metadata };
      const hashBuf = BlockchainService.computeSha256(dataToHash);
      const sha256_hash = hashBuf.toString('hex').toUpperCase();

      // 2) Sign
      const { keyPair } = BlockchainService.deriveIssuerChildKey(uid_tag_id);
      const issuerSignature = BlockchainService.signHash(hashBuf, keyPair);

      // 3) Build record (partial)
      const initialOwner = (inputAuth && inputAuth.owner) || paymentAddress || null;
      const record = {
        type: 'AUTHENTICATION_RECORD',
        version: '1.0',
        issuer: 'SmartLedger Solutions',
        product,
        metadata,
        auth: {
          blockchain: 'SmartLedger',
          sha256_hash,
          owner: initialOwner,
          current_holder_unsigned: initialOwner,
          issuer_signature: issuerSignature,
          issuer_pubkey: keyPair.pubKey.toString(),
        },
      };

      // 4) Broadcast
      const opReturnData = [Buffer.from('PatchProofV1'), Buffer.from(JSON.stringify(record))];
      const broadcastResult = await BlockchainService.constructAndBroadcastTx(opReturnData, 'Registration', req.log || console);
      if (!broadcastResult.success) {
        throw new Error('Failed to broadcast transaction via ARC.');
      }
      const txid = broadcastResult.txid;

      // 5) Finalize record
      record.auth.txid = txid;
      record.auth.merkle_proof = 'pending';

      // 6) Persist atomically
      await dbService.registerPatch(uid_tag_id, txid, initialOwner, record);

      if (req.log && req.log.info) req.log.info({ message: 'Patch registered successfully', txid, uid_tag_id });
      return res.status(201).json({ message: 'Patch registered successfully', txid });
    } catch (err) {
      if (typeof err.message === 'string' && err.message.startsWith('Conflict:')) {
        return res.status(409).json({ error: { message: err.message } });
      }
      return next(err);
    }
  }

  // GET /v1/patches/verify/:uid_tag_id
  async verifyPatch(req, res, next) {
    try {
      const uid_tag_id = req.params.uid_tag_id;
      const state = await dbService.getPatchState(uid_tag_id);
      if (!state) {
        return res.status(404).json({ status: 'not_found', message: 'Patch not registered.' });
      }
      const record = await dbService.getRecordByTxid(state.current_txid);
      if (!record) {
        if (req.log && req.log.error) req.log.error('Data inconsistency: State exists but record not found.', { txid: state.current_txid });
        return res.status(500).json({ status: 'error', message: 'Data inconsistency.' });
      }
      const dataToHash = { product: record.product, metadata: record.metadata };
      const computedHashBuf = BlockchainService.computeSha256(dataToHash);
      const dataHashMatches = computedHashBuf.toString('hex').toUpperCase() === record.auth.sha256_hash;
      const issuerSignatureValid = BlockchainService.verifySignature(
        computedHashBuf,
        record.auth.issuer_signature,
        record.auth.issuer_pubkey
      );
      const status = dataHashMatches && issuerSignatureValid ? 'authentic' : 'compromised';
      const responseRecord = JSON.parse(JSON.stringify(record));
      if (status === 'authentic') {
        responseRecord.auth.last_verified = new Date().toISOString();
      }
      return res.json({
        status,
        record: responseRecord,
        verificationDetails: {
          dataHashMatches,
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
      const paramsSchema = Joi.object({
        txid: Joi.string().trim().min(1).required(),
      });
      const bodySchema = Joi.object({
        newOwnerAddress: Joi.string().trim().min(1).required(),
        currentOwnerSignature: Joi.string().trim().min(1).required(),
      }).unknown(false);

      const paramsVal = paramsSchema.validate(req.params || {});
      if (paramsVal.error) {
        return res.status(400).json({ error: { message: 'Invalid path parameters', details: paramsVal.error.details.map(d => d.message) } });
      }
      const { value: bodyVal, error: bodyErr } = bodySchema.validate(req.body || {});
      if (bodyErr) {
        return res.status(400).json({ error: { message: 'Invalid request body', details: bodyErr.details.map(d => d.message) } });
      }
      const currentTxid = req.params.txid;
      const { newOwnerAddress, currentOwnerSignature } = bodyVal;
      const currentRecord = await dbService.getRecordByTxid(currentTxid);
      if (!currentRecord) return res.status(404).json({ error: { message: 'Record not found' } });
      const uid_tag_id = currentRecord.product.uid_tag_id;

      const broadcastResult = await BlockchainService.constructAndBroadcastTransferTx(
        currentTxid,
        newOwnerAddress,
        currentOwnerSignature,
        req.log || console
      );
      if (!broadcastResult.success) {
        throw new Error('Failed to broadcast transfer transaction.');
      }
      const newTxid = broadcastResult.txid;

      const newRecordData = JSON.parse(JSON.stringify(currentRecord));
      newRecordData.auth.owner = newOwnerAddress;
      newRecordData.auth.current_holder_unsigned = newOwnerAddress;
      newRecordData.auth.txid = newTxid;
      newRecordData.auth.merkle_proof = 'pending';

      await dbService.updateOwnership(uid_tag_id, currentTxid, newTxid, newOwnerAddress, newRecordData);

      if (req.log && req.log.info) req.log.info({ message: 'Ownership transferred successfully', oldTxid: currentTxid, newTxid });
      return res.json({ message: 'Ownership transferred successfully', newTxid });
    } catch (err) {
      if (typeof err.message === 'string' && err.message.startsWith('Conflict:')) {
        return res.status(409).json({ error: { message: err.message } });
      }
      return next(err);
    }
  }

  // POST /v1/patches/:uid_tag_id/unlock-content (stub)
  async unlockContent(req, res, next) {
    try {
      const { uid_tag_id } = req.params;
      // Placeholder: fetch state and authorization checks
      const state = await dbService.getPatchState(uid_tag_id);
      if (!state) return res.status(404).json({ error: { message: 'Patch not found' } });
      return res.json({ message: 'Content unlocked (stub)', uid_tag_id, txid: state.current_txid });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PatchController();
