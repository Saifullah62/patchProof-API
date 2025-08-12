/* E2E admin UTXO tests (mainnet, no mocks)
   Requires server running with admin API key.
   Env for test runner:
   - BASE_URL
   - API_KEY (admin)
*/

const BASE_URL = process.env.BASE_URL;
const API_KEY = process.env.API_KEY;

async function fetchJson(url, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  return { ok: res.ok, status: res.status, headers: res.headers, body };
}

function withApiKey(headers = {}) {
  const h = { ...(headers || {}) };
  if (API_KEY) h['x-api-key'] = API_KEY;
  return h;
}

describe('Admin UTXO E2E', () => {
  test('GET /v1/admin/utxo-health returns pool and funding info', async () => {
    const res = await fetchJson(`${BASE_URL}/v1/admin/utxo-health`, { method: 'GET', headers: withApiKey() });
    expect(res.ok).toBe(true);
    expect(res.body).toHaveProperty('db');
    expect(res.body).toHaveProperty('funding');
    // Optional chain details may be present or error depending on WOC rate limits
  }, 60000);

  test('POST /v1/admin/utxo-maintain concurrency: one runs, second gets 409', async () => {
    // Fire two maintenance requests concurrently
    const options = { method: 'POST', headers: withApiKey(), body: JSON.stringify({ action: 'auto' }) };
    const [a, b] = await Promise.all([
      fetchJson(`${BASE_URL}/v1/admin/utxo-maintain`, options),
      fetchJson(`${BASE_URL}/v1/admin/utxo-maintain`, options),
    ]);
    // One should succeed, the other likely 409. Order is not guaranteed.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBeGreaterThanOrEqual(200); // 200 or 409
    expect([a.status, b.status]).toContain(200);
    expect([a.status, b.status]).toContain(409);
  }, 120000);
});
