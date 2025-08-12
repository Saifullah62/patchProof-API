#!/usr/bin/env node
require('dotenv').config();
const express = require('express');
const { createBullBoard } = require('bull-board');
const { BullMQAdapter } = require('bull-board/bullMQAdapter');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

function getConnection() {
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || null;
  if (url) return new IORedis(url, { maxRetriesPerRequest: null });
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  return new IORedis({ host, port, password, maxRetriesPerRequest: null });
}

(async function main() {
  const app = express();
  const connection = getConnection();

  const queues = [
    new Queue('broadcast', { connection }),
    new Queue('email', { connection }),
  ];

  const { router } = createBullBoard(
    queues.map((q) => new BullMQAdapter(q))
  );

  // Basic protection: bind to localhost; add optional API key gate
  const adminKey = process.env.ADMIN_API_KEY || process.env.API_KEY;
  app.use((req, res, next) => {
    if (!adminKey) return next();
    const key = req.header('x-api-key') || req.query.key;
    if (key === adminKey) return next();
    res.status(401).send('Unauthorized');
  });

  app.use('/queues', router);

  const port = parseInt(process.env.QUEUES_DASHBOARD_PORT || '5050', 10);
  const host = process.env.QUEUES_DASHBOARD_HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`Bull Board running at http://${host}:${port}/queues`);
    console.log('Note: bound to host for safety. Configure reverse-proxy + auth in production.');
  });
})();
