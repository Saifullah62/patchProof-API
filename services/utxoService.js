// services/utxoService.js
const Utxo = require('../models/Utxo');
const logger = require('../logger');

class UtxoService {
  /**
   * Finds and locks a single, suitable UTXO for a transaction.
   * @param {number} requiredAmount - The minimum number of satoshis needed.
   * @returns {Promise<import('mongoose').Document|null>} The locked UTXO document or null if none is found.
   */
  async selectAndLockUtxo(requiredAmount) {
    const utxo = await Utxo.findOneAndUpdate(
      {
        status: 'available',
        satoshis: { $gte: requiredAmount },
      },
      {
        $set: { status: 'locked', updated_at: new Date() },
      },
      {
        sort: { satoshis: 1 }, // best-fit strategy
        new: true,
      }
    ).exec();

    if (utxo) {
      logger.info({ message: 'Locked UTXO for funding', txid: utxo.txid, vout: utxo.vout });
    } else {
      logger.error({ message: 'No available UTXOs to fund transaction', requiredAmount });
    }

    return utxo;
  }

  /**
   * Adds a new UTXO to the pool, typically from a change output.
   * @param {{ txid:string, vout:number, satoshis:number, scriptPubKey:string, privKeyWIF:string }} utxoData
   */
  async addUtxo(utxoData) {
    const newUtxo = await Utxo.findOneAndUpdate(
      { txid: utxoData.txid, vout: utxoData.vout },
      { ...utxoData, status: 'available' },
      { upsert: true, new: true }
    ).exec();
    logger.info({ message: 'Added new UTXO to pool', txid: newUtxo.txid, vout: newUtxo.vout, satoshis: newUtxo.satoshis });
    return newUtxo;
  }

  /**
   * Marks a UTXO as spent.
   * @param {import('mongoose').Document & { status:string, save:Function, txid:string, vout:number }} utxo
   */
  async spendUtxo(utxo) {
    utxo.status = 'spent';
    await utxo.save();
    logger.info({ message: 'Marked UTXO as spent', txid: utxo.txid, vout: utxo.vout });
  }

  /**
   * Unlocks a UTXO if a transaction fails, making it available again.
   * @param {import('mongoose').Document & { status:string, save:Function, txid:string, vout:number }} utxo
   */
  async unlockUtxo(utxo) {
    utxo.status = 'available';
    await utxo.save();
    logger.warn({ message: 'Unlocked UTXO due to broadcast failure', txid: utxo.txid, vout: utxo.vout });
  }

  /**
   * Finds and locks multiple UTXOs to meet a required funding amount.
   * Uses a sequential atomic locking strategy (no DB txn required).
   * @param {number} requiredAmount - The minimum number of satoshis needed (excl. fee buffer internalized here).
   * @returns {Promise<Array<import('mongoose').Document>>} Locked UTXO documents.
   */
  async selectAndLockUtxos(requiredAmount) {
    const locked = [];
    let accumulated = 0;
    const feeBuffer = 1000; // conservative buffer to avoid underfunding due to fee growth with more inputs
    while (accumulated < requiredAmount + feeBuffer) {
      const utxo = await Utxo.findOneAndUpdate(
        { status: 'available', satoshis: { $gt: 0 } },
        { $set: { status: 'locked', updated_at: new Date() } },
        { sort: { satoshis: -1 }, new: true }
      ).exec();
      if (!utxo) {
        await this.unlockUtxos(locked);
        logger.error({ message: 'Insufficient funds. Could not meet the required amount.', requiredAmount });
        throw new Error('Insufficient funds to build the transaction.');
      }
      locked.push(utxo);
      accumulated += utxo.satoshis;
    }
    logger.info({ message: 'Locked UTXOs for funding', count: locked.length, totalSatoshis: accumulated });
    return locked;
  }

  /**
   * Unlocks an array of UTXOs, making them available again.
   * @param {Array<import('mongoose').Document>} utxos
   */
  async unlockUtxos(utxos) {
    if (!utxos || !utxos.length) return;
    const ids = utxos.map((u) => u._id);
    await Utxo.updateMany({ _id: { $in: ids } }, { $set: { status: 'available', updated_at: new Date() } }).exec();
    logger.warn({ message: 'Unlocked multiple UTXOs due to failure', count: utxos.length });
  }

  /**
   * Marks an array of UTXOs as spent.
   * @param {Array<import('mongoose').Document>} utxos
   */
  async spendUtxos(utxos) {
    if (!utxos || !utxos.length) return;
    const ids = utxos.map((u) => u._id);
    await Utxo.updateMany({ _id: { $in: ids } }, { $set: { status: 'spent', updated_at: new Date() } }).exec();
    logger.info({ message: 'Marked UTXOs as spent', count: utxos.length });
  }

  /**
   * Reaper: Unlocks UTXOs that have been locked longer than the specified number of minutes.
   * This protects against orphaned locks after crashes or unexpected terminations.
   * @param {number} minutes - Threshold age in minutes for a locked UTXO to be considered orphaned.
   * @param {number} limit - Max number of UTXOs to process in one run to avoid long scans.
   * @returns {Promise<{matched:number, modified:number}>}
   */
  async unlockOrphanedLocked(minutes = 15, limit = 500) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const filter = { status: 'locked', updated_at: { $lt: cutoff } };
    const stale = await Utxo.find(filter).limit(limit).exec();
    if (!stale.length) {
      logger.info({ message: 'UTXO reaper: no orphaned locks found', olderThanMins: minutes });
      return { matched: 0, modified: 0 };
    }
    const ids = stale.map((d) => d._id);
    const res = await Utxo.updateMany({ _id: { $in: ids } }, { $set: { status: 'available', updated_at: new Date() } }).exec();
    logger.warn({ message: 'UTXO reaper: unlocked orphaned UTXOs', count: res.modifiedCount || 0, olderThanMins: minutes });
    return { matched: res.matchedCount || stale.length, modified: res.modifiedCount || 0 };
  }
}

module.exports = new UtxoService();
