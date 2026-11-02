'use strict';

const assert = require('assert');
const A = require('../../../netlify/functions/lib/analytics-store');

class FakeStore {
  constructor() { this.values = new Map(); this.etags = new Map(); this.sequence = 0; this.failPrefix = ''; this.rejectPrefix = ''; this.deleted = []; }
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
  async delete(key) { this.deleted.push(key); this.values.delete(key); this.etags.delete(key); }
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
    let lineCases = 0;
    async function testLine(label, fn) { await fn(); lineCases++; console.log(`  ✓ ${label}`); }
    const lineEvent = (p = '/contact', r) => {
      const event = eventFor(p, r);
      event.body = JSON.stringify({ ...JSON.parse(event.body), e: 'line' });
      return event;
    };
    const lineSend = (target, p, r) => handler(lineEvent(p, r), { getStoreFn: () => target });
    const vidHash = A.hash(A.verifyVisitorCookie(cookie, process.env.ANALYTICS_COOKIE_SECRET).id);
    const minute = A.jstMinute();
    const lineRate = A.rateKey(minute, vidHash, 'line:/contact.html');
    const viewRate = A.rateKey(minute, vidHash, '/contact.html');
    for (const r of [undefined, '/blog/x/']) {
      await testLine(`LINE のみの保存（遷移元 ${r || 'なし'}）`, async () => {
        const target = new FakeStore();
        const response = await lineSend(target, '/contact', r);
        assert.strictEqual(response.statusCode, 204);
        assert.deepStrictEqual(target.values.get(A.lineKey(date)), { date, total: 1, byFrom: { [r || '/contact.html']: 1 } });
        assert.deepStrictEqual([...target.values.keys()].sort(), [lineRate, A.lineKey(date)].sort(),
          'daily/uniq/transitions/submissions を作らない');
        await lineSend(target, '/contact.html', r);
        assert.strictEqual(target.values.get(A.lineKey(date)).total, 1, '同じ分・同じ訪問者・別表記も1回');
        assert.deepStrictEqual(target.deleted, [], '重複リクエストは他のマーカーを消さない');
      });
    }
    for (const lineFirst of [false, true]) {
      await testLine(`同じ分の閲覧と LINE を独立して数える（LINE が先: ${lineFirst}）`, async () => {
        const target = new FakeStore();
        const view = () => send('/contact', '/blog/x/', target);
        const click = () => lineSend(target, '/contact', '/blog/x/');
        if (lineFirst) { await click(); await view(); } else { await view(); await click(); }
        const before = [...target.values.entries()].filter(([key]) => !key.startsWith('line/') && key !== lineRate);
        await click();
        assert.strictEqual(target.values.get(A.dailyKey(date)).pageviews, 1);
        assert.strictEqual(target.values.get(A.lineKey(date)).total, 1);
        assert.strictEqual(target.values.get(A.transitionKey(date)).total, 1);
        assert.ok(target.values.has(viewRate) && target.values.has(lineRate));
        assert.deepStrictEqual([...target.values.entries()].filter(([key]) => !key.startsWith('line/') && key !== lineRate), before);
      });
    }
    await testLine('既存の PV/UU/遷移/送信完了を LINE が増やさない', async () => {
      const before = structuredClone([...saved.values.entries()]);
      await lineSend(saved, '/contact', '/blog/x/');
      for (const [key, value] of before) assert.deepStrictEqual(saved.values.get(key), value, key);
    });
    await testLine('他の許可ページの LINE は押したページを遷移元にする', async () => {
      const target = new FakeStore();
      await lineSend(target, '/blog/x/', '/about');
      assert.deepStrictEqual(target.values.get(A.lineKey(date)), { date, total: 1, byFrom: { '/blog/x/': 1 } });
      assert.ok(![...target.values.keys()].some(key => /^(daily|uniq|transitions|submissions)\//.test(key)));
    });
    await testLine('LINE にも既存と同じ訪問者 Cookie を発行する', async () => {
      const event = lineEvent();
      delete event.headers.cookie;
      const response = await handler(event, { getStoreFn: () => new FakeStore() });
      assert.strictEqual(response.statusCode, 204);
      assert.ok(response.headers['Set-Cookie'].includes('HttpOnly; Secure; SameSite=Lax'));
    });
    for (const headers of [{ host: 'preview.netlify.app' }, { 'user-agent': 'Googlebot' },
      { origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }, { 'user-agent': '' }]) {
      await testLine(`LINE にも既存の公開受け口ガード ${JSON.stringify(headers)}`, async () => {
        const event = lineEvent();
        Object.assign(event.headers, headers);
        const target = new FakeStore();
        const response = await handler(event, { getStoreFn: () => target });
        assert.strictEqual(response.statusCode, 204);
        assert.deepStrictEqual([...target.values], []);
        assert.ok(!response.headers['Set-Cookie']);
      });
    }
    for (const e of ['LINE', 'other', '', 1, null, true]) {
      await testLine(`不正な LINE event ${JSON.stringify(e)} は保存しない`, async () => {
        const event = lineEvent();
        event.body = JSON.stringify({ p: '/contact', e });
        const target = new FakeStore();
        const response = await handler(event, { getStoreFn: () => target });
        assert.strictEqual(response.statusCode, 204);
        assert.deepStrictEqual([...target.values], []);
        assert.ok(!response.headers['Set-Cookie']);
      });
    }
    for (const failure of ['failPrefix', 'rejectPrefix']) {
      await testLine(`LINE 保存失敗 ${failure} で自分のマーカーだけ削除し再送できる`, async () => {
        const target = new FakeStore();
        await send('/contact', '/blog/x/', target);
        const before = structuredClone([...target.values.entries()]);
        target[failure] = 'line/';
        const response = await lineSend(target, '/contact', '/blog/x/');
        assert.strictEqual(response.statusCode, 204);
        assert.deepStrictEqual(target.deleted, [lineRate]);
        assert.deepStrictEqual([...target.values.entries()], before, '閲覧マーカーと既存のデータを保つ');
        target[failure] = '';
        await lineSend(target, '/contact', '/blog/x/');
        assert.strictEqual(target.values.get(A.lineKey(date)).total, 1, '失敗後は同じ分に再送できる');
      });
    }
    console.log(`LINE track-visit: ${lineCases} cases PASS`);
    let sourceCases = 0;
    async function testSource(label, fn) { await fn(); sourceCases++; }
    const sourceEvent = (body = {}, headers = {}) => {
      const event = eventFor('/contact', '/blog/x/');
      event.body = JSON.stringify({ ...JSON.parse(event.body), v: 'visitabc1234', s: 'search.yahoo.co.jp', ...body });
      Object.assign(event.headers, { 'user-agent': 'Mozilla iPhone' }, headers);
      return event;
    };
    const sourceSend = (target, body, headers) => handler(sourceEvent(body, headers), { getStoreFn: () => target });
    const visitMarker = A.sourceKey({ date, kind: 'v', source: 'yahoo', device: 'iphone', detail: null, id: 'visitabc1234' });
    const engagedMarker = A.sourceKey({ date, kind: 'e', source: 'yahoo', device: 'iphone', detail: null, id: 'visitabc1234' });
    const engagedRate = A.rateKey(minute, vidHash, 'engaged:/contact.html');
    await testSource('visit marker and unchanged legacy counts', async () => {
      const target = new FakeStore();
      const writes = [];
      const set = target.set.bind(target);
      target.set = async (...args) => { if (args[0].startsWith('src/')) writes.push(args); return set(...args); };
      const response = await sourceSend(target);
      assert.strictEqual(response.statusCode, 204);
      assert.deepStrictEqual(writes, [[visitMarker, '1']]);
      assert.strictEqual(target.values.get(A.dailyKey(date)).pageviews, 1);
      assert.strictEqual(target.values.get(A.transitionKey(date)).total, 1);
      assert.ok(!visitMarker.includes(vidHash));
      assert.ok(!visitMarker.includes(cookie));
      await sourceSend(target);
      assert.strictEqual(writes.length, 1, 'rate の確認を通らない再送は印を書かない');
    });
    await testSource('engaged writes only own rate and marker', async () => {
      const target = new FakeStore();
      await sourceSend(target, { e: 'engaged' });
      assert.deepStrictEqual([...target.values.keys()].sort(), [engagedMarker, engagedRate].sort());
      assert.strictEqual(target.values.get(engagedMarker), '1');
      await sourceSend(target, { e: 'engaged' });
      assert.deepStrictEqual(target.deleted, []);
      assert.strictEqual(target.values.size, 2);
    });
    for (const engagedFirst of [false, true]) await testSource('engaged and PV independent rates', async () => {
      const target = new FakeStore();
      if (engagedFirst) await sourceSend(target, { e: 'engaged' });
      await sourceSend(target);
      if (!engagedFirst) await sourceSend(target, { e: 'engaged' });
      assert.strictEqual(target.values.get(A.dailyKey(date)).pageviews, 1);
      assert.strictEqual(target.values.get(A.transitionKey(date)).total, 1);
      assert.ok(target.values.has(visitMarker));
      assert.ok(target.values.has(engagedMarker));
      assert.strictEqual([...target.values.keys()].filter(key => key.startsWith('uniq/')).length, 1);
    });
    await testSource('source failure preserves PV, transition and PV rate', async () => {
      const target = new FakeStore();
      const set = target.set.bind(target);
      target.set = (...args) => { if (args[0].startsWith('src/')) throw new Error('source unavailable'); return set(...args); };
      const response = await sourceSend(target);
      assert.strictEqual(response.statusCode, 204);
      assert.strictEqual(target.values.get(A.dailyKey(date)).pageviews, 1);
      assert.strictEqual(target.values.get(A.transitionKey(date)).total, 1);
      assert.ok(target.values.has(viewRate));
      assert.deepStrictEqual(target.deleted, []);
    });
    await testSource('engaged failure releases only its own marker and retries', async () => {
      const target = new FakeStore();
      await sourceSend(target);
      const before = structuredClone([...target.values]);
      const set = target.set.bind(target);
      target.set = (...args) => { if (args[0].startsWith('src/')) throw new Error('engaged unavailable'); return set(...args); };
      assert.strictEqual((await sourceSend(target, { e: 'engaged' })).statusCode, 204);
      assert.deepStrictEqual([...target.values], before);
      assert.deepStrictEqual(target.deleted, [engagedRate]);
      target.set = set;
      await sourceSend(target, { e: 'engaged' });
      assert.ok(target.values.has(engagedMarker));
    });
    for (const s of ['mori-zeirishi.net', 'www.mori-zeirishi.net', 'WWW.MORI-ZEIRISHI.NET']) {
      await testSource('own host is not a visit', async () => {
        const target = new FakeStore();
        await sourceSend(target, { s, u: 'google' });
        await sourceSend(target, { s, e: 'engaged' });
        assert.ok(![...target.values.keys()].some(key => key.startsWith('src/')));
        assert.strictEqual(target.values.get(A.dailyKey(date)).pageviews, 1);
      });
    }
    for (const e of [undefined, 'engaged']) for (const ua of ['Googlebot', 'HeadlessChrome', '']) {
      await testSource('bot has no source markers', async () => {
        const target = new FakeStore();
        assert.strictEqual((await sourceSend(target, { e }, { 'user-agent': ua })).statusCode, 204);
        assert.strictEqual(target.values.size, 0);
      });
    }
    for (const [ua, device] of [['Mozilla Android', 'android'], ['Mozilla Windows', 'pc']]) {
      await testSource('request device and utm', async () => {
        const target = new FakeStore();
        await sourceSend(target, { u: 'QR' }, { 'user-agent': ua });
        const keys = [...target.values.keys()].filter(key => key.startsWith('src/'));
        assert.strictEqual(keys.length, 1);
        assert.deepStrictEqual(A.parseSourceKey(keys[0]), { date, kind: 'v', source: 'tagged', device, detail: 'qr', id: 'visitabc1234' });
      });
    }
    await testSource('resends overwrite the same anonymous marker', async () => {
      const target = new FakeStore();
      await sourceSend(target);
      await target.delete(viewRate);
      await sourceSend(target);
      assert.strictEqual([...target.values.keys()].filter(key => key.startsWith('src/')).length, 1);
    });
    console.log(`traffic sources track-visit: ${sourceCases} cases PASS`);
    console.log('track-visit: PASS');
  } finally {
    global.Date = RealDate;
    if (previousSecret == null) delete process.env.ANALYTICS_COOKIE_SECRET;
    else process.env.ANALYTICS_COOKIE_SECRET = previousSecret;
  }
})().catch(err => { console.error(err); process.exit(1); });
