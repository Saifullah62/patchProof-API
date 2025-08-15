#!/usr/bin/env node
/*
  Simple smoke test for PatchProof API health endpoints.
  - Bypasses shell/proxy quirks.
  - Prints status code, headers (Location for redirects), and body.
*/
const http = require('http');

const HOST = process.env.SMOKE_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

function request(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path, method: 'GET', timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({
          ok: true,
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body,
          json,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    req.end();
  });
}

(async () => {
  const health = await request('/health');
  const ready = await request('/ready');

  function print(label, res) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${label} ===`);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.log('error:', res.error);
      return;
    }
    // eslint-disable-next-line no-console
    console.log('status:', res.statusCode, res.statusMessage);
    if (res.headers.location) {
      // eslint-disable-next-line no-console
      console.log('location:', res.headers.location);
    }
    if (res.json) {
      // eslint-disable-next-line no-console
      console.log('json:', JSON.stringify(res.json, null, 2));
    } else {
      const b = (res.body || '').slice(0, 300);
      // eslint-disable-next-line no-console
      console.log('body:', b);
    }
  }

  print('GET /health', health);
  print('GET /ready', ready);
})();
