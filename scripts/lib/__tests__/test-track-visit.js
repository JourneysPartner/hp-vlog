'use strict';

const assert = require('assert');
const A = require('../../../netlify/functions/lib/analytics-store');

class FakeStore {
  constructor() { this.values = new Map(); this.etags = new Map(); this.sequence = 0; this.failPrefix = ''; this.rejectPrefix = ''; }
  async set(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) return { modified: false };
    this.values.set(key, value);
    return { modified: true };
  }
  async getWithMetadata(key) {
    if (this.failPrefix && key.startsWith(this.failPrefix)) throw new Error('simulated attribution outage');
    return this.values.has(key) ? { data: structuredClone(this.values.get(key)), etag: this.etags.get(key) } : null;
  }
  async setJSON(key, value, options = {}) {
    if (this.rejectPrefix && key.startsWith(this.rejectPrefix)) return { modified: false };
    if (options.onlyIfNew && this.values.has(key)) return { modified: false };
    if (options.onlyIfMatch && options.onlyIfMatch !== this.etags.get(key)) return { modified: false };
    this.values.set(key, structuredClone(value));
    this.etags.set(key, String(++this.sequence));
    return { modified: true };
  }
  async delete(key) { this.values.delete(key); this.etags.delete(key); }
}

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
  const RealDate = Date;
  process.env.ANALYTICS_COOKIE_SECRET = 'test-secret-that-is-long-enough';
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-27T03:00:00.000Z'])); }
  };
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
    const cookie = A.issueVisitorCookie(process.env.ANALYTICS_COOKIE_SECRET);
    const eventFor = (p, r) => ({
      httpMethod: 'POST', body: JSON.stringify({ p, ...(r ? { r } : {}) }),
      headers: { host: 'mori-zeirishi.net', origin: 'https://mori-zeirishi.net',
        'sec-fetch-site': 'same-origin', 'user-agent': 'Mozilla/5.0', cookie: `mz_vid=${cookie}` },
    });
    const saved = new FakeStore();
    const date = A.jstDate();
    const send = (p, r, target = saved) => handler(eventFor(p, r), { getStoreFn: () => target });
    await send('/contact', '/blog/x/');
    assert.strictEqual(saved.values.get(A.dailyKey(date)).byPath['/contact.html'], 1);
    assert.deepStrictEqual(saved.values.get(A.transitionKey(date)), { date, total: 1, byFrom: { '/blog/x/': 1 } });
    assert.ok(!saved.values.has(A.submissionKey(date)));
    await send('/contact.html', '/blog/x/');
    assert.strictEqual(saved.values.get(A.dailyKey(date)).pageviews, 1, '別表記でも同じ分の重複は数えない');
    assert.strictEqual(saved.values.get(A.transitionKey(date)).total, 1);
    await send('/contact-thanks', '/blog/x/');
    assert.strictEqual(saved.values.get(A.dailyKey(date)).byPath['/contact-thanks.html'], 1);
    assert.deepStrictEqual(saved.values.get(A.submissionKey(date)), { date, total: 1, byFrom: { '/blog/x/': 1 } });
    assert.strictEqual(saved.values.get(A.transitionKey(date)).total, 1, '送信完了は問い合わせ遷移に加算しない');
    await send('/contact-thanks.html', '/blog/x/');
    assert.strictEqual(saved.values.get(A.dailyKey(date)).pageviews, 2);
    assert.strictEqual(saved.values.get(A.submissionKey(date)).total, 1, '同じ分の送信完了は増えない');

    for (const p of ['/contact', '/contact-thanks']) {
      const withoutRef = new FakeStore();
      await send(p, undefined, withoutRef);
      assert.strictEqual(withoutRef.values.get(A.dailyKey(date)).pageviews, 1);
      assert.ok(![...withoutRef.values.keys()].some(k => /^(transitions|submissions)\//.test(k)));
      for (const failure of ['failPrefix', 'rejectPrefix']) {
        const failing = new FakeStore();
        const prefix = p === '/contact' ? 'transitions/' : 'submissions/';
        failing[failure] = prefix;
        const response = await send(p, '/blog/x/', failing);
        assert.strictEqual(response.statusCode, 204);
        assert.strictEqual(failing.values.get(A.dailyKey(date)).pageviews, 1, '遷移元の保存失敗でもPVを保つ');
        assert.ok([...failing.values.keys()].some(k => k.startsWith('rate/')), 'PV成功時は重複除外マーカーを保つ');
        assert.ok(!failing.values.has(prefix + date));
      }
    }
    for (const headers of [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' },
      { 'user-agent': 'Googlebot' }, { host: 'preview.netlify.app' }]) {
      const event = eventFor('/contact', '/blog/x/');
      Object.assign(event.headers, headers);
      const response = await handler(event, { getStoreFn: () => { throw new Error('guard bypassed'); } });
      assert.strictEqual(response.statusCode, 204);
      assert.ok(!response.headers['Set-Cookie'], '既存のガードはストアやCookie発行より前に働く');
    }
    console.log('track-visit: PASS');
  } finally {
    global.Date = RealDate;
    if (previousSecret == null) delete process.env.ANALYTICS_COOKIE_SECRET;
    else process.env.ANALYTICS_COOKIE_SECRET = previousSecret;
  }
})().catch(err => { console.error(err); process.exit(1); });
