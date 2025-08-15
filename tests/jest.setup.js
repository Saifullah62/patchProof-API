// Jest global setup for unit tests
// - Reduce noisy logs
// - Keep behavior unchanged

// Silence morgan HTTP logs during tests
jest.mock('morgan', () => () => (req, res, next) => next());

// Reduce console noise but keep errors visible
const noop = () => {};
// Keep console.error to surface failures
if (typeof console.log === 'function') jest.spyOn(console, 'log').mockImplementation(noop);
if (typeof console.info === 'function') jest.spyOn(console, 'info').mockImplementation(noop);
if (typeof console.warn === 'function') jest.spyOn(console, 'warn').mockImplementation(noop);

// Reasonable default timeout for slower unit tests
jest.setTimeout(15000);
