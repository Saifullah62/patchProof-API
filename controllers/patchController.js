// controllers/patchController.js
const Joi = require('joi');
const BlockchainService = require('../services/blockchainService');
const dbService = require('../services/databaseService');

const registerSchema = Joi.object({
    product: Joi.object({
        uid_tag_id: Joi.string().required(),
    }).required().unknown(true),
    metadata: Joi.object().required().unknown(true),
    paymentAddress: Joi.string().optional(),
    auth: Joi.object({
        owner: Joi.string().optional()
    }).optional().unknown(true)
}).unknown(false);

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

      const dataToHash = { product, metadata };
      const hashBuf = BlockchainService.computeSha256(dataToHash);
      
      const { keyPair } = BlockchainService.deriveIssuerChildKey(uid_tag_id);
      const issuerSignature = BlockchainService.signHash(hashBuf, keyPair);

      const initialOwner = (inputAuth && inputAuth.owner) || paymentAddress || null;
      const record = {
        type: 'AUTHENTICATION_RECORD',
        product,
        metadata,
        auth: {
          owner: initialOwner,
          issuer_signature: issuerSignature,
          issuer_pubkey: keyPair.pubKey.toString(),
        },
      };

      const opReturnData = [Buffer.from(JSON.stringify(record))];
      const broadcastResult = await BlockchainService.constructAndBroadcastTx(opReturnData, 'Registration', req.log);
      if (!broadcastResult.success) {
        throw new Error(`Broadcast failed: ${broadcastResult.error}`);
      }
      const txid = broadcastResult.txid;
      record.auth.txid = txid;

      await dbService.registerPatch(uid_tag_id, txid, initialOwner, record);

      if (req.log) req.log.info({ message: 'Patch registered successfully', txid, uid_tag_id });
      return res.status(201).json({ message: 'Patch registered successfully', txid });
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
      
      const dataToHash = { product: record.product, metadata: record.metadata };
      const computedHashBuf = BlockchainService.computeSha256(dataToHash);
      
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

      // In a real implementation, you would construct a new OP_RETURN with updated ownership data
      const opReturnData = [Buffer.from(`TRANSFER ${uid_tag_id} TO ${newOwnerAddress}`)];
      const broadcastResult = await BlockchainService.constructAndBroadcastTransferTx(
        currentTxid,
        newOwnerAddress,
        currentOwnerSignature,
        opReturnData,
        req.log
      );

      if (!broadcastResult.success) {
        throw new Error(`Broadcast failed: ${broadcastResult.error}`);
      }
      const newTxid = broadcastResult.txid;

      const newRecordData = JSON.parse(JSON.stringify(currentRecord));
      newRecordData.auth.owner = newOwnerAddress;
      newRecordData.auth.txid = newTxid;

      await dbService.updateOwnership(uid_tag_id, currentTxid, newTxid, newOwnerAddress, newRecordData);

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
      const state = await dbService.getPatchState(uid_tag_id);
      if (!state) return res.status(404).json({ error: { message: 'Patch not found' } });
      // Placeholder for content unlocking logic
      return res.json({ message: 'Content unlocked (stub)', uid_tag_id, txid: state.current_txid });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PatchController();
