'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const analytics = require('../../../netlify/functions/lib/analytics-store');

class FakeStore {
  constructor() { this.values = new Map(); this.etags = new Map(); this.next = 1; this.failUpdates = 0; this.getOptions = []; }
  async getWithMetadata(key, options = {}) {
    this.getOptions.push(options);
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
  const dateCases = [
    ['2026-10-27', 0, '2026-10-27'],
    ['2026-10-27', -1, '2026-10-26'],
    ['2026-11-01', -1, '2026-10-31'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2026-10-27', -89, '2026-07-30'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-03-01', -1, '2028-02-29'],
  ];
  for (const [date, offset, expected] of dateCases) {
    assert.strictEqual(analytics.dateOffset(date, offset), expected, `dateOffset(${date}, ${offset})`);
  }
  console.log(`dateOffset: ${dateCases.length} cases PASS`);

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

  for (const name of ['about', 'contact', 'contact-thanks', 'services', 'voice', 'privacy', '404']) {
    for (const suffix of ['', '/', '.html']) {
      const path = `/${name}${suffix}`;
      assert.strictEqual(analytics.normalizePath(path), `/${name}.html`);
      assert.strictEqual(analytics.parseBeaconBody(JSON.stringify({ p: path })), `/${name}.html`);
    }
  }
  const payloadCases = [
    [{ p: '/contact', r: '/blog/x/' }, { path: '/contact.html', ref: '/blog/x/' }],
    [{ p: '/contact/', r: '/about' }, { path: '/contact.html', ref: '/about.html' }],
    [{ p: '/contact-thanks', r: '/services/ebay-export/' }, { path: '/contact-thanks.html', ref: '/services/ebay-export/' }],
    [{ p: '/contact-thanks', r: '/contact' }, { path: '/contact-thanks.html', ref: null }],
    [{ p: '/contact', r: '/contact-thanks.html' }, { path: '/contact.html', ref: null }],
    [{ p: '/about', r: '/blog/x/' }, { path: '/about.html', ref: null }],
    [{ p: '/contact', r: '/contact/' }, { path: '/contact.html', ref: null }],
    [{ p: '/contact-thanks/', r: '/contact-thanks/' }, { path: '/contact-thanks.html', ref: null }],
  ];
  for (const [body, expected] of payloadCases) {
    assert.deepStrictEqual(analytics.parseBeaconPayload(JSON.stringify(body)), expected);
    assert.strictEqual(analytics.parseBeaconBody(JSON.stringify(body)), expected.path);
  }
  for (const path of ['/pricing/', '/area/', '/services/tax-return/', '/services/tax-return', '/blog/x', '/blog/x/']) {
    assert.strictEqual(analytics.parseBeaconBody(JSON.stringify({ p: path })), path);
  }
  for (const path of ['/services/../x', '/servicesx', '/tools/shohizei-simulator/', '/random',
    '/pricing', '/area', '/blog/x.html', '/services/UPPER/', '/services/a/b/', '//example.com/',
    'https://example.com/blog/x/', '/blog/a\\b/', '/blog/a\u0000/', '/blog/' + 'x'.repeat(128)]) {
    assert.strictEqual(analytics.parseBeaconPayload(JSON.stringify({ p: path })), null, path);
    assert.strictEqual(analytics.parseBeaconBody(JSON.stringify({ p: path })), null, path);
  }
  for (const raw of ['null', '[]', '42', '{', JSON.stringify({ p: '/contact', extra: true }),
    JSON.stringify({ p: '/contact', r: 'x'.repeat(1024) })]) {
    assert.strictEqual(analytics.parseBeaconPayload(raw), null);
    assert.strictEqual(analytics.parseBeaconBody(raw), null);
  }
  for (const r of ['https://example.com/x', '/random', '/blog/' + 'x'.repeat(128), '/services/../x']) {
    assert.deepStrictEqual(analytics.parseBeaconPayload(JSON.stringify({ p: '/contact', r })), { path: '/contact.html', ref: null });
  }

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
  assert.ok(store.getOptions.every(options => options.consistency !== 'strong'),
    'Lambda互換Functionで利用できないstrong consistencyを要求しない');
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

  // 呼び出し側は変えず、実際のcleanupを偽Blobs接続・ストアで実行する。
  const cleanupStore = new FakeStore();
  const oldestUniq = 'uniq/2026-07-30/retained';
  const staleUniq = 'uniq/2026-07-29/stale';
  const todayUniq = 'uniq/2026-10-27/today';
  const todayRate = 'rate/2026-10-27-00:00/visitor/path';
  const staleRate = 'rate/2026-10-26-23:59/visitor/path';
  const unrelated = ['daily/2026-07-29', 'transitions/2026-07-29', 'submissions/2026-07-29'];
  for (const key of [oldestUniq, staleUniq, todayUniq, todayRate, staleRate, ...unrelated]) {
    await cleanupStore.set(key, '1');
  }
  const cleanupExports = {};
  let connected = 0;
  const cleanupPath = require.resolve('../../../netlify/functions/analytics-cleanup');
  vm.runInNewContext(fs.readFileSync(cleanupPath, 'utf8'), {
    exports: cleanupExports,
    require: name => {
      if (name === '@netlify/blobs') return {
        connectLambda: () => { connected++; },
        getStore: storeName => { assert.strictEqual(storeName, 'analytics'); return cleanupStore; },
      };
      if (name === './lib/analytics-store') return { ...analytics, jstDate: () => '2026-10-27' };
      throw new Error(`Unexpected cleanup dependency: ${name}`);
    },
    console: { log: () => {}, error: console.error },
  }, { filename: cleanupPath });
  const cleanupResult = await cleanupExports.handler({});
  assert.strictEqual(cleanupResult.statusCode, 200);
  assert.strictEqual(connected, 1);
  assert.deepStrictEqual(JSON.parse(cleanupResult.body), { ok: true, uniq: 1, rate: 1 });
  assert.deepStrictEqual([...cleanupStore.values.keys()].sort(), [oldestUniq, todayUniq, todayRate, ...unrelated].sort(),
    '89日前のuniqは残り90日前は消える。当日のrateと対象外の集計データは残る');
  console.log('analytics-cleanup retention boundary: PASS');

  console.log('analytics-store: PASS');
})().catch(err => { console.error(err); process.exit(1); });
