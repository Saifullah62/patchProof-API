// services/utxoService.js
// A secure, atomic, and reliable Data Access Layer (DAL) for the UTXO collection.
// This service has no knowledge of private keys.
const Utxo = require('../models/Utxo');
const logger = require('../logger');

class UtxoService {
  /**
   * Atomically finds and locks a single UTXO that meets the required criteria.
   * @param {string} keyIdentifier - The identifier of the key controlling the UTXO.
   * @param {number} requiredAmount - The minimum number of satoshis needed.
   * @returns {Promise<object|null>} The locked UTXO document or null.
   */
  async selectAndLockUtxo(keyIdentifier, requiredAmount) {
    const utxo = await Utxo.findOneAndUpdate(
      {
        keyIdentifier,
        status: 'available',
        satoshis: { $gte: requiredAmount },
      },
      { $set: { status: 'locked', updated_at: new Date() } },
      { sort: { satoshis: 1 }, new: true }
    ).lean().exec();

    if (utxo) {
      logger.info({ message: 'Locked UTXO for funding', txid: utxo.txid, vout: utxo.vout });
    }
    return utxo;
  }

  /**
   * Adds a new UTXO to the pool or updates an existing one.
   * @param {object} utxoData - The UTXO data to add.
   * @returns {Promise<object>} The created or updated UTXO document.
   */
  async addUtxo(utxoData) {
    const newUtxo = await Utxo.findOneAndUpdate(
      { txid: utxoData.txid, vout: utxoData.vout },
      { ...utxoData },
      { upsert: true, new: true }
    ).lean().exec();
    logger.info({ message: 'Added/updated UTXO in pool', txid: newUtxo.txid, vout: newUtxo.vout });
    return newUtxo;
  }

  /**
   * Atomically marks a batch of UTXOs as spent.
   * @param {Array<object>} utxos - An array of UTXO documents to mark as spent.
   */
  async spendUtxos(utxos) {
    if (!utxos || utxos.length === 0) return;
    const ids = utxos.map(u => u._id);
    await Utxo.updateMany({ _id: { $in: ids } }, { $set: { status: 'spent', updated_at: new Date() } }).exec();
    logger.info({ message: 'Marked UTXOs as spent', count: utxos.length });
  }

  /**
   * Atomically unlocks a batch of UTXOs, making them available again.
   * This is used to recover from a failed transaction broadcast.
   * @param {Array<object>} utxos - An array of UTXO documents to unlock.
   */
  async unlockUtxos(utxos) {
    if (!utxos || utxos.length === 0) return;
    const ids = utxos.map(u => u._id);
    await Utxo.updateMany({ _id: { $in: ids }, status: 'locked' }, { $set: { status: 'available', updated_at: new Date() } }).exec();
    logger.warn({ message: 'Unlocked UTXOs due to failure', count: utxos.length });
  }

  /**
   * Atomically marks a single UTXO as spent by id.
   * Keeps compatibility with callers passing a doc.
   */
  async spendUtxo(utxo) {
    if (!utxo || !utxo._id) return;
    await Utxo.updateOne({ _id: utxo._id }, { $set: { status: 'spent', updated_at: new Date() } }).exec();
    logger.info({ message: 'Marked UTXO as spent', txid: utxo.txid, vout: utxo.vout });
  }

  /**
   * Atomically unlocks a single UTXO by id if currently locked.
   * Keeps compatibility with callers passing a doc.
   */
  async unlockUtxo(utxo) {
    if (!utxo || !utxo._id) return;
    await Utxo.updateOne({ _id: utxo._id, status: 'locked' }, { $set: { status: 'available', updated_at: new Date() } }).exec();
    logger.warn({ message: 'Unlocked UTXO due to failure', txid: utxo.txid, vout: utxo.vout });
  }

  /**
   * Reaper: Unlocks UTXOs that have been locked longer than the specified number of minutes.
   * Protects against orphaned locks after crashes.
   * @param {number} olderThanMinutes - Threshold age in minutes.
   * @param {number} limit - Max number of UTXOs to process.
   * @returns {Promise<{matched:number, modified:number}>}
   */
  async unlockOrphanedLocked(olderThanMinutes = 15, limit = 500) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const stale = await Utxo.find({ status: 'locked', updated_at: { $lt: cutoff } }).limit(limit).lean().exec();
    if (!stale.length) {
      logger.info({ message: 'UTXO reaper: no orphaned locks found', olderThanMins: olderThanMinutes });
      return { matched: 0, modified: 0 };
    }
    const ids = stale.map(d => d._id);
    const res = await Utxo.updateMany({ _id: { $in: ids } }, { $set: { status: 'available', updated_at: new Date() } }).exec();
    logger.warn({ message: 'UTXO reaper: unlocked orphaned UTXOs', count: res.modifiedCount || 0, olderThanMins: olderThanMinutes });
    return { matched: res.matchedCount || stale.length, modified: res.modifiedCount || 0 };
  }

  // --- Read-only helpers ---
  async getPoolCount(keyIdentifier) {
    return Utxo.countDocuments({ keyIdentifier, status: 'available' }).exec();
  }

  async findDust(keyIdentifier, dustThreshold, limit) {
    return Utxo.find({ keyIdentifier, status: 'available', satoshis: { $lt: dustThreshold } })
      .limit(limit)
      .lean()
      .exec();
  }

  async getUtxosByStatus(statuses) {
    return Utxo.find({ status: { $in: statuses } }).lean().exec();
  }
}

module.exports = new UtxoService();
