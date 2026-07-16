'use strict';

const assert = require('assert');

class FailingStore {
  constructor() { this.deleted = []; this.setCount = 0; }
  async set() { this.setCount++; return { modified: true }; }
  async getWithMetadata() { throw new Error('simulated Blobs outage'); }
  async delete(key) { this.deleted.push(key); }
}

(async () => {
  console.log('\n=== track-visit ===');
  const modulePath = require.resolve('../../../netlify/functions/track-visit');
  const store = new FailingStore();
  const previousSecret = process.env.ANALYTICS_COOKIE_SECRET;
  process.env.ANALYTICS_COOKIE_SECRET = 'test-secret-that-is-long-enough';
  try {
    const { handler } = require(modulePath);
    const result = await handler({
      httpMethod: 'POST', body: JSON.stringify({ p: '/' }),
      headers: {
        host: 'mori-zeirishi.net', origin: 'https://mori-zeirishi.net',
        'sec-fetch-site': 'same-origin', 'user-agent': 'Mozilla/5.0',
      },
    }, { getStoreFn: () => store });
    assert.strictEqual(result.statusCode, 204);
    assert.ok(result.headers['Set-Cookie']);
    assert.strictEqual(store.deleted.length, 1, 'PV保存例外時に作成済みrateマーカーを補償削除する');
    console.log('track-visit: PASS');
  } finally {
    if (previousSecret == null) delete process.env.ANALYTICS_COOKIE_SECRET;
    else process.env.ANALYTICS_COOKIE_SECRET = previousSecret;
  }
})().catch(err => { console.error(err); process.exit(1); });
