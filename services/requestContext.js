// services/requestContext.js
// Provides AsyncLocalStorage for propagating per-request context (e.g., requestId)
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

function get(key) {
  const store = als.getStore();
  return store ? store[key] : undefined;
}

function set(key, value) {
  const store = als.getStore();
  if (store) store[key] = value;
}

module.exports = { runWithContext, get, set };
