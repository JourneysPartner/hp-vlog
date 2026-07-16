'use strict';

const assert = require('assert');
const analytics = require('../../../netlify/functions/lib/analytics-store');

class FakeStore {
  constructor() { this.values = new Map(); this.etags = new Map(); this.next = 1; this.failUpdates = 0; }
  async getWithMetadata(key) {
    if (!this.values.has(key)) return null;
    return { data: JSON.parse(JSON.stringify(this.values.get(key))), etag: this.etags.get(key), metadata: {} };
  }
  async set(key, value, options = {}) { return this.write(key, value, options); }
  async setJSON(key, value, options = {}) { return this.write(key, JSON.parse(JSON.stringify(value)), options); }
  async write(key, value, options) {
    const exists = this.values.has(key);
    if (options.onlyIfNew && exists) return { modified: false };
    if (options.onlyIfMatch && (!exists || options.onlyIfMatch !== this.etags.get(key))) return { modified: false };
    if (options.onlyIfMatch && this.failUpdates-- > 0) return { modified: false };
    this.values.set(key, value);
    const etag = String(this.next++); this.etags.set(key, etag);
    return { modified: true, etag };
  }
  async delete(key) { this.values.delete(key); this.etags.delete(key); }
  async *list({ prefix }) {
    const all = [...this.values.keys()].filter(key => key.startsWith(prefix));
    for (let i = 0; i < all.length; i += 2) yield { blobs: all.slice(i, i + 2).map(key => ({ key, etag: this.etags.get(key) })) };
  }
}

(async () => {
  console.log('\n=== analytics-store ===');
  const secret = 'test-secret-that-is-long-enough';
  const value = analytics.issueVisitorCookie(secret);
  assert.ok(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value));
  assert.ok(analytics.verifyVisitorCookie(value, secret));
  assert.strictEqual(analytics.verifyVisitorCookie(`${value}x`, secret), null);

  assert.strictEqual(analytics.parseBeaconBody(JSON.stringify({ p: '/blog/example-post/' })), '/blog/example-post/');
  assert.strictEqual(analytics.parseBeaconBody(JSON.stringify({ p: '/random' })), null);
  assert.strictEqual(analytics.parseBeaconBody(JSON.stringify({ p: '/../secret' })), null);
  assert.strictEqual(analytics.isAllowedPath('/about.html'), true);
  assert.strictEqual(analytics.isAllowedPath('/about/'), false);

  const store = new FakeStore();
  const date = '2026-07-14';
  const vid = analytics.hash('visitor');
  assert.strictEqual((await analytics.markUnique(store, date, vid)).modified, true);
  assert.strictEqual((await analytics.markUnique(store, date, vid)).modified, false);
  assert.strictEqual(await analytics.countPrefix(store, `uniq/${date}/`), 1);

  // 新規キー onlyIfNew → ETag CAS の競合リトライでPVが欠落しない。
  assert.strictEqual(await analytics.incrementPageview(store, date, '/'), true);
  store.failUpdates = 1;
  assert.strictEqual(await analytics.incrementPageview(store, date, '/'), true);
  const daily = (await store.getWithMetadata(analytics.dailyKey(date))).data;
  assert.strictEqual(daily.pageviews, 2);
  assert.strictEqual(daily.byPath['/'], 2);

  const minute = '2026-07-14-1200';
  const rate = await analytics.markRate(store, minute, vid, '/');
  assert.strictEqual(rate.modified, true);
  assert.strictEqual((await analytics.markRate(store, minute, vid, '/')).modified, false);
  // PV CAS が最終失敗した場合に作成者が補償削除する想定を確認。
  await store.delete(analytics.rateKey(minute, vid, '/'));
  assert.strictEqual((await analytics.markRate(store, minute, vid, '/')).modified, true);

  console.log('analytics-store: PASS');
})().catch(err => { console.error(err); process.exit(1); });
