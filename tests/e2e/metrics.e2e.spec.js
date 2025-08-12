/* E2E metrics test (mainnet, no mocks) */

const BASE_URL = process.env.BASE_URL;
const maybe = BASE_URL ? describe : describe.skip;
const METRICS_API_KEY = process.env.METRICS_API_KEY || null;

async function fetchText(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  return { ok: res.ok, status: res.status, headers: res.headers, text };
}

maybe('Metrics E2E', () => {
  test('GET /metrics gated (if configured) and exposes prometheus format', async () => {
    const headers = {};
    if (METRICS_API_KEY) headers['x-api-key'] = METRICS_API_KEY;
    const res = await fetchText(`${BASE_URL}/metrics`, { headers });
    expect(res.ok).toBe(true);
    // Prometheus exposition format usually has lines like: '# HELP' and '# TYPE'
    expect(res.text).toMatch(/#\s*HELP|#\s*TYPE/);
  }, 30000);
});
