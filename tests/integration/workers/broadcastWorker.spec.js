// tests/integration/workers/broadcastWorker.spec.js

const IORedis = require('ioredis');
const { Queue, QueueEvents } = require('bullmq');

// Mock BlockchainService to avoid real network calls
jest.mock('../../../services/blockchainService', () => ({
  constructAndBroadcastTx: jest.fn(async () => ({ success: true, txid: 'mock_txid_123' })),
  constructAndBroadcastTransferTx: jest.fn(async () => ({ success: true, txid: 'mock_txid_transfer_456' })),
}));

const BlockchainService = require('../../../services/blockchainService');

// Importing the worker will start it
let workerModule; // loaded in beforeAll after Redis check

const queueName = 'broadcast';
let connection;
let queue;
let queueEvents;
let SKIP = false;

jest.setTimeout(30000);

beforeAll(async () => {
  // Point worker and our client to the same Redis
  process.env.REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
  process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';

  // Try connecting to Redis; if it fails, skip tests
  try {
    connection = new IORedis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT, 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 2,
    });
    await connection.ping();
  } catch (e) {
    SKIP = true;
    return;
  }

  queue = new Queue(queueName, { connection });
  queueEvents = new QueueEvents(queueName, { connection });
  await queueEvents.waitUntilReady();

  // Now require the worker so it starts listening
  workerModule = require('../../../workers/broadcastWorker');
});

afterAll(async () => {
  if (queue) await queue.close();
  if (queueEvents) await queueEvents.close();
  if (connection) await connection.quit();
});

describe('broadcastWorker integration', () => {
  it('processes a registration job and calls BlockchainService.constructAndBroadcastTx', async () => {
    if (SKIP) {
      console.warn('[integration] Redis unavailable; skipping test.');
      return;
    }

    const record = { type: 'AUTHENTICATION_RECORD', product: { uid_tag_id: 'uid-123' }, metadata: {}, auth: { owner: null, ts: Date.now() } };
    const job = await queue.add('registration', { record, uid_tag_id: 'uid-123', initialOwner: null, purpose: 'Registration' }, { removeOnComplete: true, removeOnFail: true });

    const result = await new Promise((resolve, reject) => {
      const onCompleted = ({ jobId, returnvalue }) => {
        if (String(jobId) === String(job?.id)) {
          queueEvents.off('completed', onCompleted);
          queueEvents.off('failed', onFailed);
          resolve(returnvalue);
        }
      };
      const onFailed = (evt) => {
        if (String(evt.jobId) === String(job?.id)) {
          queueEvents.off('completed', onCompleted);
          queueEvents.off('failed', onFailed);
          reject(new Error(evt.failedReason || 'job failed'));
        }
      };
      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);
    });

    expect(BlockchainService.constructAndBroadcastTx).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result.txid).toBe('mock_txid_123');
  });
});
