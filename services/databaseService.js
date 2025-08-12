// services/databaseService.js
const mongoose = require('mongoose');
const PatchState = require('../models/PatchState');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const logger = require('../logger');
const { ConflictError, NotFoundError } = require('../errors');

// Single, reusable transaction helper with safe fallback for non-replset dev envs
async function withTransaction(operations) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await operations(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    try { await session.abortTransaction(); } catch (_) {}
    if (String(error.message).includes('Transaction numbers are only allowed on a replica set')) {
      logger.warn('[DB] Transactions not supported; falling back to non-atomic operations. Not safe for production.');
      return operations(null);
    }
    throw error;
  } finally {
    session.endSession();
  }
}

class DatabaseService {
  async initialize() {
    // Connection lifecycle is handled by config/db.js (initDb/closeDb)
    return;
  }

  async getPatchState(uid_tag_id) {
    return PatchState.findOne({ uid_tag_id }).lean().exec();
  }

  async getRecordByTxid(txid) {
    const rec = await AuthenticationRecord.findOne({ txid, status: 'confirmed' }).lean().exec();
    return rec ? rec.record_data : null;
  }

  // --- Registration state machine helpers ---
  async createPendingRegistration(uid_tag_id, owner_address, record_data) {
    // Single-source-of-truth: create AuthenticationRecord in 'pending' state
    const doc = await AuthenticationRecord.create({ uid_tag_id, record_data, status: 'pending', type: 'REGISTRATION' });
    return doc.toObject();
  }

  async attachJobToPending(pendingId, jobId) {
    await AuthenticationRecord.updateOne({ _id: pendingId, status: 'pending' }, { $set: { job_id: jobId } }).exec();
  }

  // Unified confirmation for both REGISTRATION and TRANSFER pending records
  async markConfirmed(pendingId, txid) {
    return withTransaction(async (session) => {
      const pending = await AuthenticationRecord.findById(pendingId).session(session || undefined);
      if (!pending) throw new NotFoundError('Pending record not found');
      if (pending.status === 'confirmed') return { idempotent: true, txid: pending.txid };
      if (pending.status !== 'pending') throw new ConflictError(`Invalid pending status: ${pending.status}`);

      const { uid_tag_id, record_data, type, previous_txid } = pending;
      const newOwner = record_data?.auth?.owner || null;

      if (type === 'REGISTRATION') {
        await PatchState.updateOne(
          { uid_tag_id },
          { uid_tag_id, current_txid: txid, current_owner_address: newOwner },
          { upsert: true, session: session || undefined }
        );
      } else if (type === 'TRANSFER') {
        // Optimistic concurrency using version key via .save()
        const state = await PatchState.findOne({ uid_tag_id, current_txid: previous_txid }).session(session || undefined);
        if (!state) {
          throw new ConflictError('Optimistic lock failure: Patch state has changed or UTXO is already spent.');
        }
        state.current_txid = txid;
        state.current_owner_address = newOwner;
        await state.save({ session: session || undefined });
      } else {
        throw new ConflictError(`Unsupported pending type: ${type}`);
      }

      pending.status = 'confirmed';
      pending.txid = txid;
      pending.failure_reason = null;
      await pending.save({ session: session || undefined });

      return { idempotent: false, txid };
    });
  }

  async markRegistrationFailed(pendingId, reason) {
    await AuthenticationRecord.updateOne(
      { _id: pendingId, status: { $in: ['pending', 'failed'] } },
      { $set: { status: 'failed', failure_reason: String(reason || 'unknown error') } }
    ).exec();
  }

  async getPendingRegistrationById(id) {
    return AuthenticationRecord.findById(id).lean().exec();
  }

  // --- Transfer state machine helpers ---
  async createPendingTransfer(uid_tag_id, current_txid, new_owner_address, record_data) {
    // Create a pending AuthenticationRecord representing a transfer
    const doc = await AuthenticationRecord.create({
      uid_tag_id,
      record_data,
      status: 'pending',
      type: 'TRANSFER',
      previous_txid: current_txid,
    });
    return doc.toObject();
  }

  async attachJobToPendingTransfer(pendingId, jobId) {
    await AuthenticationRecord.updateOne({ _id: pendingId, status: 'pending' }, { $set: { job_id: jobId } }).exec();
  }

  // Deprecated specific confirm methods can delegate to unified path if still referenced
  async markRegistrationConfirmed(pendingId, txid) { return this.markConfirmed(pendingId, txid); }
  async markTransferConfirmed(pendingId, txid) { return this.markConfirmed(pendingId, txid); }

  async markFailed(pendingId, reason) {
    await AuthenticationRecord.updateOne(
      { _id: pendingId, status: 'pending' },
      { $set: { status: 'failed', failure_reason: String(reason || 'unknown error') } }
    ).exec();
  }
  // Backward-compatible wrappers
  async markTransferFailed(pendingId, reason) { return this.markFailed(pendingId, reason); }
  async markRegistrationFailed(pendingId, reason) { return this.markFailed(pendingId, reason); }

  async getPendingTransferById(id) {
    return AuthenticationRecord.findById(id).lean().exec();
  }

  // --- Recovery helper: revert a failed pending record back to pending for re-queueing ---
  async revertPending(pendingId) {
    await AuthenticationRecord.updateOne(
      { _id: pendingId, status: 'failed' },
      { $set: { status: 'pending', failure_reason: null } }
    ).exec();
  }

  // Removed synchronous registerPatch/updateOwnership in favor of async state machine (pending -> confirmed)
}

module.exports = new DatabaseService();
