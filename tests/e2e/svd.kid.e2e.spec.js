/* E2E SVD kid discovery */
const BASE_URL = process.env.BASE_URL;

describe('SVD kid discovery', () => {
  test('GET /api/svd/kid returns kid when configured', async () => {
    const res = await fetch(`${BASE_URL}/api/svd/kid`);
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json).toHaveProperty('kid');
    expect(typeof json.kid === 'string').toBe(true);
  }, 30000);
});
