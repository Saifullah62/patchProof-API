// services/databaseService.js
const mongoose = require('mongoose');
const PatchState = require('../models/PatchState');
const AuthenticationRecord = require('../models/AuthenticationRecord');
const logger = require('../logger');

class DatabaseService {
  async initialize() {
    // Connection lifecycle is handled by config/db.js (initDb/closeDb)
    return;
  }

  async getPatchState(uid_tag_id) {
    return PatchState.findOne({ uid_tag_id }).lean().exec();
  }

  async getRecordByTxid(txid) {
    const rec = await AuthenticationRecord.findOne({ txid }).lean().exec();
    return rec ? rec.record_data : null;
  }

  async registerPatch(uid_tag_id, txid, owner_address, record_data) {
    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();

      await AuthenticationRecord.create([
        { txid, uid_tag_id, record_data },
      ], { session });

      await PatchState.create([
        { uid_tag_id, current_txid: txid, current_owner_address: owner_address },
      ], { session });

      await session.commitTransaction();
    } catch (error) {
      // Handle duplicate key
      if (session) {
        try { await session.abortTransaction(); } catch (_) {}
        session.endSession();
      }
      if (error.code === 11000) {
        logger.warn(`DB Conflict: duplicate patch registration for ${uid_tag_id}`);
        throw new Error('Conflict: Patch already registered (DB Constraint).');
      }
      // Fallback for environments without transactions (e.g., MongoMemoryServer without replset)
      if (String(error.message).includes('Transaction numbers are only allowed on a replica set')) {
        logger.warn('[DB] Transactions not supported in current MongoDB instance. Falling back to non-transactional flow.');
        // Best-effort sequential writes with unique constraints still providing safety
        await AuthenticationRecord.create({ txid, uid_tag_id, record_data });
        try {
          await PatchState.create({ uid_tag_id, current_txid: txid, current_owner_address: owner_address });
        } catch (err2) {
          // Roll-forward/compensating action is not feasible for immutable record; surface error
          if (err2.code === 11000) {
            throw new Error('Conflict: Patch already registered (DB Constraint).');
          }
          throw err2;
        }
        return;
      }
      throw error;
    } finally {
      if (session) session.endSession();
    }
  }

  async updateOwnership(uid_tag_id, currentTxid, newTxid, newOwnerAddress, newRecordData) {
    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();

      const updateResult = await PatchState.updateOne(
        { uid_tag_id, current_txid: currentTxid },
        { current_txid: newTxid, current_owner_address: newOwnerAddress }
      ).session(session);

      if (updateResult.modifiedCount === 0) {
        throw new Error('Conflict: UTXO already spent or invalid current TXID (Optimistic Lock Failure).');
      }

      await AuthenticationRecord.create([
        { txid: newTxid, uid_tag_id, record_data: newRecordData },
      ], { session });

      await session.commitTransaction();
    } catch (error) {
      if (session) {
        try { await session.abortTransaction(); } catch (_) {}
        session.endSession();
      }
      if (String(error.message).includes('Transaction numbers are only allowed on a replica set')) {
        logger.warn('[DB] Transactions not supported in current MongoDB instance. Falling back to non-transactional flow.');
        const updateResult = await PatchState.updateOne(
          { uid_tag_id, current_txid: currentTxid },
          { current_txid: newTxid, current_owner_address: newOwnerAddress }
        );
        if (updateResult.modifiedCount === 0) {
          throw new Error('Conflict: UTXO already spent or invalid current TXID (Optimistic Lock Failure).');
        }
        await AuthenticationRecord.create({ txid: newTxid, uid_tag_id, record_data: newRecordData });
        return;
      }
      throw error;
    } finally {
      if (session) session.endSession();
    }
  }
}

module.exports = new DatabaseService();
