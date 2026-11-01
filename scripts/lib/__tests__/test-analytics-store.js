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

// 従来の path/ref の期待値を保ち、追加フィールドも独立に検証する。
function parsePageviewPayload(raw) {
  const { event, ...payload } = analytics.parseBeaconPayload(raw);
  assert.strictEqual(event, null);
  return payload;
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
    assert.deepStrictEqual(parsePageviewPayload(JSON.stringify(body)), expected);
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
    assert.deepStrictEqual(parsePageviewPayload(JSON.stringify({ p: '/contact', r })), { path: '/contact.html', ref: null });
  }

  let lineCases = 0;
  function testLine(label, fn) { fn(); lineCases++; console.log(`  ✓ ${label}`); }
  for (const [body, expected] of [
    [{ p: '/contact', e: 'line' }, { path: '/contact.html', ref: null, event: 'line' }],
    [{ p: '/contact', e: 'line', r: '/blog/x/' }, { path: '/contact.html', ref: '/blog/x/', event: 'line' }],
    [{ p: '/contact/', e: 'line', r: '/about' }, { path: '/contact.html', ref: '/about.html', event: 'line' }],
    [{ p: '/blog/x/', e: 'line', r: '/about' }, { path: '/blog/x/', ref: null, event: 'line' }],
    [{ p: '/contact-thanks', e: 'line', r: '/blog/x/' }, { path: '/contact-thanks.html', ref: '/blog/x/', event: 'line' }],
    [{ p: '/', e: 'line' }, { path: '/', ref: null, event: 'line' }],
  ]) {
    testLine(`LINE payload ${JSON.stringify(body)}`, () => {
      assert.deepStrictEqual(analytics.parseBeaconPayload(JSON.stringify(body)), expected);
      assert.strictEqual(analytics.parseBeaconBody(JSON.stringify(body)), expected.path);
    });
  }
  for (const e of ['LINE', 'other', '', 1, null, true, {}, ['line']]) {
    testLine(`LINE event の不正値 ${JSON.stringify(e)} を拒否`, () => {
      assert.strictEqual(analytics.parseBeaconPayload(JSON.stringify({ p: '/contact', e })), null);
    });
  }
  for (const body of [
    { p: '/random', e: 'line' }, { p: '/tools/shohizei-simulator/', e: 'line' },
    { p: '/contact', e: 'line', x: 1 }, { e: 'line' },
    { p: '/contact', e: 'line', r: 'x'.repeat(1024) },
  ]) {
    testLine('LINE でも許可外のパス・キー・大きすぎる本文は拒否', () => {
      assert.strictEqual(analytics.parseBeaconPayload(JSON.stringify(body)), null);
    });
  }
  for (const r of ['/contact', '/contact-thanks/', '/random', 'https://example.com/x']) {
    testLine(`LINE 遷移元の既存ガード ${r}`, () => {
      assert.deepStrictEqual(analytics.parseBeaconPayload(JSON.stringify({ p: '/contact', e: 'line', r })),
        { path: '/contact.html', ref: null, event: 'line' });
    });
  }
  testLine('従来の閲覧 payload には event: null を返す', () => {
    assert.deepStrictEqual(analytics.parseBeaconPayload('{"p":"/"}'), { path: '/', ref: null, event: null });
  });
  const lineStore = new FakeStore();
  const lineDate = '2026-10-27';
  assert.strictEqual(await analytics.incrementLine(lineStore, lineDate, '/blog/x/'), true);
  lineStore.failUpdates = 1;
  let lineSleeps = 0;
  assert.strictEqual(await analytics.incrementLine(lineStore, lineDate, '/blog/x/', { sleep: async () => { lineSleeps++; } }), true);
  assert.strictEqual(await analytics.incrementLine(lineStore, lineDate, '/contact.html'), true);
  testLine('LINE は line/ の日別・遷移元別に積み上がり CAS 競合を再試行する', () => {
    assert.deepStrictEqual(lineStore.values.get(analytics.lineKey(lineDate)),
      { date: lineDate, total: 3, byFrom: { '/blog/x/': 2, '/contact.html': 1 } });
    assert.deepStrictEqual([...lineStore.values.keys()], ['line/' + lineDate]);
    assert.strictEqual(lineSleeps, 1);
    assert.ok(lineStore.getOptions.every(options => options.consistency !== 'strong'));
  });
  lineStore.failUpdates = 3;
  assert.strictEqual(await analytics.incrementLine(lineStore, lineDate, '/blog/x/', { maxAttempts: 1 }), false);
  testLine('LINE は再試行切れで false を返し保存済み件数を保つ', () => {
    assert.strictEqual(lineStore.values.get(analytics.lineKey(lineDate)).total, 3);
  });
  console.log(`LINE analytics-store: ${lineCases} cases PASS`);

  let sourceCases = 0;
  async function testSource(label, fn) { await fn(); sourceCases++; }
  const hostGroups = {
    ai: ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'www.perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com'],
    google: ['google.com', 'www.google.co.jp', 'google.co.uk', 'www.google.com.au', 'com.google.android.googlequicksearchbox'],
    yahoo: ['search.yahoo.co.jp', 'search.yahoo.com', 'jp.co.yahoo.android.yjtop'],
    bing: ['bing.com', 'www.bing.com'], line: ['line.me', 'l.line.me', 'lin.ee'],
    sns: ['x.com', 't.co', 'twitter.com', 'facebook.com', 'm.facebook.com', 'instagram.com', 'l.instagram.com',
      'threads.net', 'threads.com', 'youtube.com', 'm.youtube.com', 'youtu.be', 'tiktok.com', 'www.tiktok.com',
      'linkedin.com', 'www.linkedin.com', 'lnkd.in'],
  };
  for (const [source, hosts] of Object.entries(hostGroups)) {
    for (const host of hosts) await testSource(host, () => {
      assert.deepStrictEqual(analytics.classifySource(host.toUpperCase()), { source, detail: null });
    });
  }
  for (const host of ['news.yahoo.co.jp', 'yahoo.co.jp', 'evilgoogle.com', 'google.com.evil.example',
    'bing.com.evil.example', 'evilperplexity.ai', 'notline.me', 'sub.chatgpt.com', 'example.com']) {
    await testSource(host, () => assert.deepStrictEqual(analytics.classifySource(host), { source: 'other', detail: host }));
  }
  for (const host of ['https://example.com/private?q=secret', 'example.com/path', 'bad host', '日本語.jp', 'x'.repeat(254), null, 1,
    '..', '.', '-', 'a..b', '.example.com', 'example.com.', '-a.example', 'a-.example']) {
    await testSource('invalid host', () => assert.deepStrictEqual(analytics.classifySource(host), { source: 'other', detail: null }));
  }
  await testSource('invalid marker details', () => {
    const key = detail => `src/2026-11-01/v/other/pc/${detail}/abcd1234`;
    assert.strictEqual(analytics.parseSourceKey(key('..')), null);
    assert.strictEqual(analytics.parseSourceKey(key('.')), null);
    assert.strictEqual(analytics.parseSourceKey(`src/2026-11-01/v/tagged/pc/_qr/abcd1234`), null);
    assert.strictEqual(analytics.parseSourceKey(key('example.com')).detail, 'example.com');
  });
  await testSource('utm の記号だけの値は使わず参照元で判定する', () => {
    for (const utm of ['-', '_', '-qr']) {
      assert.deepStrictEqual(analytics.classifySource('search.yahoo.co.jp', utm), { source: 'yahoo', detail: null });
    }
    assert.deepStrictEqual(analytics.classifySource('', 'qr-2026_a'), { source: 'tagged', detail: 'qr-2026_a' });
  });
  await testSource('direct', () => assert.deepStrictEqual(analytics.classifySource(''), { source: 'direct', detail: null }));
  for (const length of [64, 65, 253]) await testSource('detail length', () => {
    assert.deepStrictEqual(analytics.classifySource('x'.repeat(length)), { source: 'other', detail: length === 64 ? 'x'.repeat(length) : null });
  });
  const tags = {
    google: ['google'], yahoo: ['yahoo'], bing: ['bing'], line: ['line'],
    sns: ['x', 'twitter', 'facebook', 'instagram', 'threads', 'youtube', 'tiktok', 'linkedin'],
    ai: ['openai', 'chatgpt', 'perplexity', 'copilot', 'gemini', 'claude'],
    tagged: ['qr', 'newsletter_2026-11', 'x'.repeat(32)],
  };
  for (const [source, values] of Object.entries(tags)) for (const utm of values) {
    await testSource('utm priority ' + utm, () => assert.deepStrictEqual(analytics.classifySource('search.yahoo.co.jp', utm.toUpperCase()),
      { source, detail: source === 'tagged' ? utm : null }));
  }
  for (const utm of ['', 'x'.repeat(33), 'with space', '../secret', '日本語', null, 1]) {
    await testSource('invalid utm', () => assert.deepStrictEqual(analytics.classifySource('www.google.com', utm), { source: 'google', detail: null }));
  }
  const visitBody = { p: '/contact', r: '/blog/x/', v: 'abcd1234', s: 'search.yahoo.co.jp', u: 'QR' };
  await testSource('visit payload', () => assert.deepStrictEqual(analytics.parseBeaconPayload(JSON.stringify(visitBody)),
    { path: '/contact.html', ref: '/blog/x/', event: null, visit: { id: 'abcd1234', host: 'search.yahoo.co.jp', utm: 'QR' } }));
  for (const body of [{ ...visitBody, u: undefined, s: '' }, { ...visitBody, v: 'x'.repeat(32) }]) {
    await testSource('valid visit', () => assert.ok(analytics.parseBeaconPayload(JSON.stringify(body)).visit));
  }
  for (const change of [{ v: 'short' }, { v: 'UPPER123' }, { v: 12345678 }, { v: 'a'.repeat(33) },
    { v: null }, { s: undefined }, { s: {} }, { u: 3 }, { u: null },
    { s: 'mori-zeirishi.net' }, { s: 'WWW.MORI-ZEIRISHI.NET' }]) {
    await testSource('bad visit preserves PV', () => {
      const body = { ...visitBody, ...change };
      assert.deepStrictEqual(analytics.parseBeaconPayload(JSON.stringify(body)), { path: '/contact.html', ref: '/blog/x/', event: null });
      assert.strictEqual(analytics.parseBeaconPayload(JSON.stringify({ ...body, e: 'engaged' })), null);
    });
  }
  await testSource('engaged requires visit', () => {
    assert.strictEqual(analytics.parseBeaconPayload('{"p":"/","e":"engaged"}'), null);
    const parsed = analytics.parseBeaconPayload(JSON.stringify({ ...visitBody, e: 'engaged' }));
    assert.strictEqual(parsed.event, 'engaged');
    assert.strictEqual(parsed.visit.id, visitBody.v);
    assert.strictEqual(analytics.parseBeaconPayload(JSON.stringify({ ...visitBody, unknown: true })), null);
  });
  for (const [ua, device] of [['Mozilla iPhone', 'iphone'], ['iPod', 'iphone'], ['Android', 'android'], ['Windows', 'pc'], ['iPad', 'pc'], ['', 'pc']]) {
    await testSource('device ' + device, () => assert.strictEqual(analytics.deviceOf(ua), device));
  }
  const marker = { date: '2026-11-01', kind: 'v', source: 'other', device: 'iphone', detail: 'example.com', id: 'abcd1234' };
  for (const kind of ['v', 'e']) for (const [source, detail] of [['other', 'example.com'], ['other', null], ['google', null], ['tagged', 'qr_2026-11']]) {
    await testSource('marker roundtrip', () => {
      const value = { ...marker, kind, source, detail };
      assert.deepStrictEqual(analytics.parseSourceKey(analytics.sourceKey(value)), value);
    });
  }
  for (const key of ['src/2026-11-01/v/google/pc/-/abcd1234/extra', 'uniq/2026-11-01/v/google/pc/-/abcd1234',
    'src/2026-02-30/v/google/pc/-/abcd1234', 'src/not-date/v/google/pc/-/abcd1234', 'src/2026-11-01/x/google/pc/-/abcd1234',
    'src/2026-11-01/v/unknown/pc/-/abcd1234', 'src/2026-11-01/v/google/ipad/-/abcd1234',
    'src/2026-11-01/v/google/pc/example.com/abcd1234', 'src/2026-11-01/v/other/pc/<script>/abcd1234',
    'src/2026-11-01/v/tagged/pc/' + 'x'.repeat(33) + '/abcd1234', 'src/2026-11-01/v/google/pc/-/short', '', null]) {
    await testSource('malformed marker', () => assert.strictEqual(analytics.parseSourceKey(key), null));
  }
  await testSource('real Blobs PUT and paginated list', async () => {
    const { getStore } = require('@netlify/blobs');
    const requests = [];
    const key = analytics.sourceKey(marker);
    const second = { ...marker, id: 'second1234' };
    const secondKey = analytics.sourceKey(second);
    const actual = getStore({ name: 'analytics', siteID: 'source-test-site', token: 'test-token',
      edgeURL: 'https://blobs.invalid', fetch: async (url, options) => {
        requests.push({ url: String(url), ...options });
        if (options.method.toUpperCase() === 'PUT') return new Response('', { status: 200, headers: { etag: 'marker-etag' } });
        const nextPage = new URL(url).searchParams.get('cursor') === 'next-page';
        return new Response(JSON.stringify({ blobs: [{ key: nextPage ? secondKey : key, etag: 'marker-etag' }],
          directories: [], ...(!nextPage ? { next_cursor: 'next-page' } : {}) }), { status: 200 });
      } });
    await actual.set(key, '1');
    assert.strictEqual(requests[0].method.toUpperCase(), 'PUT');
    assert.strictEqual(requests[0].url, 'https://blobs.invalid/source-test-site/site:analytics/' + key);
    assert.strictEqual(requests[0].body, '1');
    assert.ok(!Object.keys(requests[0].headers).some(name => /if-match|if-none-match/i.test(name)));
    const listed = await analytics.listPrefixKeys(actual, 'src/');
    const parsed = listed.map(analytics.parseSourceKey);
    assert.deepStrictEqual(parsed, [marker, second]);
    const counts = {};
    for (const item of parsed) {
      const group = [item.date, item.kind, item.source, item.device].join('|');
      counts[group] = (counts[group] || 0) + 1;
    }
    assert.deepStrictEqual(counts, { '2026-11-01|v|other|iphone': 2 });
    assert.strictEqual(requests.length, 3);
    assert.ok(requests.slice(1).every(request => new URL(request.url).searchParams.get('prefix') === 'src/'));
  });
  console.log(`traffic sources analytics-store: ${sourceCases} cases PASS`);

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
  const retainedSource = analytics.sourceKey({ ...marker, date: '2026-07-30' });
  const staleSource = analytics.sourceKey({ ...marker, date: '2026-07-29' });
  const todaySource = analytics.sourceKey({ ...marker, date: '2026-10-27', kind: 'e' });
  for (const key of [oldestUniq, staleUniq, todayUniq, todayRate, staleRate, retainedSource, staleSource, todaySource, ...unrelated]) {
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
  assert.deepStrictEqual(JSON.parse(cleanupResult.body), { ok: true, uniq: 1, rate: 1, src: 1 });
  assert.deepStrictEqual([...cleanupStore.values.keys()].sort(), [oldestUniq, todayUniq, todayRate, retainedSource, todaySource, ...unrelated].sort(),
    '89日前のuniqは残り90日前は消える。当日のrateと対象外の集計データは残る');
  console.log('analytics-cleanup retention boundary: PASS');

  console.log('analytics-store: PASS');
})().catch(err => { console.error(err); process.exit(1); });
