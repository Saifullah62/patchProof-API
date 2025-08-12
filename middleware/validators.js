// middleware/validators.js
// A centralized repository for all application Joi validation schemas.
// These schemas are consumed by the generic `validateRequest` middleware.

const Joi = require('joi');

// Custom validation for a standard BSV address (basic P2PKH pattern).
const bsvAddress = () => Joi.string().trim().min(25).max(35).pattern(/^[13][a-km-zA-HJ-NP-Z1-9]{24,34}$/);

// --- Patch Schemas ---

const registerPatchSchema = Joi.object({
  product: Joi.object({
    uid_tag_id: Joi.string().trim().max(128).required(),
    name: Joi.string().trim().max(256).optional(),
  }).required(),
  metadata: Joi.object({
    notes: Joi.string().trim().max(4096).optional(),
    image: Joi.string().uri().optional(),
  }).default({}),
  auth: Joi.object({
    owner: bsvAddress().optional(),
  }).optional(),
});

const transferOwnershipSchema = Joi.object({
  newOwnerAddress: bsvAddress().required(),
  currentOwnerSignature: Joi.string().hex().required(),
  currentOwnerPubKey: Joi.string().hex().required(),
});

const unlockContentSchema = Joi.object({
  ownerPubKey: Joi.string().hex().required(),
  ownerSignature: Joi.string().required(),
  wrappedKeyB64: Joi.string().base64().optional(),
  wrapIvB64: Joi.string().base64().optional(),
  ciphertextB64: Joi.string().base64().optional(),
  cipherIvB64: Joi.string().base64().optional(),
});

// --- General Parameter Schemas ---

const txidParamSchema = Joi.object({
  txid: Joi.string().hex().length(64).required(),
});

const uidParamSchema = Joi.object({
  uid_tag_id: Joi.string().trim().min(3).max(128).required(),
});

// --- Auth Schemas ---

const requestVerificationSchema = Joi.object({
  identifier: Joi.string().trim().lowercase().email().required(),
});

const submitVerificationSchema = Joi.object({
  identifier: Joi.string().trim().lowercase().email().required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
});

// --- SVD Schemas ---
const objectId = () => Joi.string().hex().length(24);

const svdRegisterSchema = Joi.object({
  userId: objectId().required(),
  // Compressed SEC public key hex (33 bytes => 66 hex chars)
  pmcHex: Joi.string().hex().length(66).required(),
});

const svdBeginSchema = Joi.object({
  userId: objectId().required(),
});

const svdCompleteSchema = Joi.object({
  userId: objectId().required(),
  // 24-byte message => 48 hex chars
  M: Joi.string().hex().length(48).required(),
  // DER signature in hex (length varies); require hex and a reasonable min length
  signatureHex: Joi.string().hex().min(10).required(),
});

module.exports = {
  // Patch
  registerPatchSchema,
  transferOwnershipSchema,
  unlockContentSchema,
  // Params
  txidParamSchema,
  uidParamSchema,
  // Auth
  requestVerificationSchema,
  submitVerificationSchema,
  // SVD
  svdRegisterSchema,
  svdBeginSchema,
  svdCompleteSchema,
};
