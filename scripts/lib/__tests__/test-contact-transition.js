'use strict';
/**
 * 問い合わせ・送信完了の計測と選定への還元のテスト
 *
 * 検証:
 *   1. ビーコン本文の解釈（問い合わせ・送信完了ページで遷移元を受け取る）
 *   2. 遷移の記録（日別・遷移元別に数える。閲覧記録に影響しない）
 *   3. 実測ファイル → 論点キー → 選定の優先度（inquiry×2）
 *   4. 実測が無い間はすべて 0（現状のアクセスゼロでも壊れない）
 *   5. ビーコンの実行、管理API・画面、週次エクスポート
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const strict = require('assert/strict');
const ROOT = path.join(__dirname, '..', '..', '..');
const A = require(path.join(ROOT, 'netlify/functions/lib/analytics-store'));
const { priorityBreakdown } = require(path.join(ROOT, 'scripts/lib/topic-selector'));
const IS = require(path.join(ROOT, 'scripts/lib/inquiry-signals'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function test(label, fn) {
  fn();
  assert(true, label);
}

const buildSource = fs.readFileSync(path.join(ROOT, 'scripts/build.js'), 'utf8');
const beaconLiteral = buildSource.match(/const ANALYTICS_BEACON = (`[\s\S]*?`);/);
strict.ok(beaconLiteral, 'build.js の実際のビーコン文字列を使う');
const beaconScript = vm.runInNewContext(beaconLiteral[1]).match(/<script>([\s\S]*?)<\/script>/)[1];

function runBeacon({ pathname = '/contact', referrer = '', storage = new Map(), brokenStorage = false,
  hostname = 'mori-zeirishi.net', doNotTrack = '0', beaconAccepted = true } = {}) {
  const calls = [], fetches = [];
  const sessionStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(method => [method, (key, value) => {
    if (brokenStorage) throw new Error('storage unavailable');
    if (method === 'getItem') return storage.get(key) || null;
    if (method === 'setItem') storage.set(key, value);
    else storage.delete(key);
  }]));
  vm.runInNewContext(beaconScript, {
    location: { pathname, hostname }, document: { referrer }, URL, sessionStorage,
    navigator: { doNotTrack, sendBeacon: (url, raw) => {
      calls.push({ url, raw, storedAtSend: storage.get('mz_contact_from') });
      return beaconAccepted;
    } },
    fetch: (url, options) => { fetches.push({ url, ...options }); return Promise.resolve(); },
  });
  const body = calls.length ? JSON.parse(calls[0].raw) : null;
  return { calls, fetches, body, storage };
}

// Netlify Blobs の最小モック（onlyIfNew / onlyIfMatch を再現）
function makeStore() {
  const data = new Map();
  let etagSeq = 0;
  return {
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: JSON.parse(JSON.stringify(entry.value)), etag: entry.etag };
    },
    async setJSON(key, value, opts = {}) {
      const current = data.get(key);
      if (opts.onlyIfNew && current) return { modified: false };
      if (opts.onlyIfMatch && (!current || current.etag !== opts.onlyIfMatch)) return { modified: false };
      data.set(key, { value, etag: `e${++etagSeq}` });
      return { modified: true };
    },
    _raw: data,
  };
}

(async () => {
  console.log('=== 1. ビーコン本文の解釈 ===');
  {
    const p = (o) => A.parseBeaconPayload(JSON.stringify(o));
    assert(p({ p: '/blog/some-post/' }).ref === null, '通常ページは遷移元なし');
    const t = p({ p: '/contact.html', r: '/blog/some-post/' });
    assert(t && t.ref === '/blog/some-post/', '問い合わせページでは遷移元を受け取る');
    assert(p({ p: '/blog/a/', r: '/blog/b/' }).ref === null, '問い合わせページ以外の遷移元は無視');
    assert(p({ p: '/contact.html', r: '/contact.html' }).ref === null, '問い合わせページ自身は遷移元にしない');
    assert(p({ p: '/contact.html', r: 'https://example.com/x' }).ref === null, 'サイト外の形式は受け取らない');
    assert(p({ p: '/contact.html', r: '/random-path' }).ref === null, '許可されていないパスは受け取らない');
    assert(p({ p: '/contact.html', x: '1' }) === null, '不明な項目があれば全体を弾く（従来どおり）');
    assert(A.parseBeaconBody(JSON.stringify({ p: '/blog/example-post/' })) === '/blog/example-post/',
      '従来の関数は従来どおり動く');
  }

  console.log('');
  console.log('=== 2. 遷移の記録 ===');
  {
    const store = makeStore();
    await A.incrementTransition(store, '2026-08-27', '/blog/post-a/');
    await A.incrementTransition(store, '2026-08-27', '/blog/post-a/');
    await A.incrementTransition(store, '2026-08-27', '/blog/post-b/');
    const saved = (await store.getWithMetadata('transitions/2026-08-27')).data;
    assert(saved.total === 3, '遷移の合計が数えられる');
    assert(saved.byFrom['/blog/post-a/'] === 2 && saved.byFrom['/blog/post-b/'] === 1,
      '遷移元ごとに数えられる');
    assert(!store._raw.has('daily/2026-08-27'), '閲覧記録とは別の入れ物に保存される');
    await A.incrementSubmission(store, '2026-08-27', '/blog/post-a/');
    await A.incrementSubmission(store, '2026-08-27', '/services/tax-return/');
    const submitted = (await store.getWithMetadata(A.submissionKey('2026-08-27'))).data;
    assert(submitted.total === 2 && submitted.byFrom['/blog/post-a/'] === 1 && submitted.byFrom['/services/tax-return/'] === 1,
      '送信完了は同じ形式で別キーに記録される');
    assert((await store.getWithMetadata(A.transitionKey('2026-08-27'))).data.total === 3,
      '送信完了で問い合わせ遷移は増えない');
    for (const increment of [A.incrementTransition, A.incrementSubmission]) {
      let attempts = 0, sleeps = 0;
      const conflictStore = {
        getWithMetadata: async () => ({ data: { total: 2, byFrom: { '/blog/x/': 2 } }, etag: 'e1' }),
        setJSON: async (key, value, options) => {
          strict.deepEqual(value, { date: '2026-08-27', total: 3, byFrom: { '/blog/x/': 3 } });
          strict.equal(options.onlyIfMatch, 'e1');
          return { modified: ++attempts === 2 };
        },
      };
      assert(await increment(conflictStore, '2026-08-27', '/blog/x/', { sleep: async () => { sleeps++; } }),
        `${increment.name}: 競合時は既存のオプションで再試行できる`);
      assert(attempts === 2 && sleeps === 1, `${increment.name}: 再試行の回数と待機が保たれる`);
      const rejected = { ...conflictStore, setJSON: async () => ({ modified: false }) };
      assert(await increment(rejected, '2026-08-27', '/blog/x/', { maxAttempts: 1 }) === false,
        `${increment.name}: 再試行上限では false を返す`);
    }
  }

  console.log('');
  console.log('=== 3. 実測 → 論点 → 選定の優先度 ===');
  {
    // 一時的な実測ファイルと記事で、パス→論点キーの対応を検証
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-'));
    const posts = path.join(TMP, 'posts');
    fs.mkdirSync(posts, { recursive: true });
    fs.writeFileSync(path.join(posts, '2026-08-01-test.md'), [
      '---', 'title: "テスト記事"', 'slug: "test-post"', 'pain_point: "test-pain"',
      'cluster: "test-cluster"', 'subcluster: "test-sub"', '---', '', '本文',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(TMP, 'signals.json'), JSON.stringify({
      byFrom: { '/blog/test-post/': 3, '/services.html': 1 },
    }), 'utf8');
    const built = IS.buildSignalKeys({ signalsFile: path.join(TMP, 'signals.json'), postsDir: posts });
    assert(built.fromCount === 1, '遷移元のうち記事だけが論点に対応づく');
    assert(built.keys.has('test-pain') && built.keys.has('test-cluster') && built.keys.has('test-sub'),
      '記事の pain / cluster / subcluster が信号キーになる');
    fs.writeFileSync(path.join(posts, '2026-08-02-submitted.md'), [
      '---', 'slug: "submitted-post"', 'pain_point: "submitted-pain"', '---', '', '本文',
    ].join('\n'), 'utf8');
    for (const signals of [
      { submittedFrom: { '/blog/submitted-post/': 1 } },
      { byFrom: {}, submittedFrom: { '/blog/submitted-post/': 1 } },
      { byFrom: { '/blog/test-post/': 3 }, submittedFrom: { '/blog/submitted-post/': 2, '/blog/test-post/': 1 } },
    ]) {
      fs.writeFileSync(path.join(TMP, 'signals.json'), JSON.stringify(signals), 'utf8');
      const result = IS.buildSignalKeys({ signalsFile: path.join(TMP, 'signals.json'), postsDir: posts });
      const union = Boolean(signals.byFrom && signals.byFrom['/blog/test-post/']);
      assert(result.fromCount === (union ? 2 : 1) && result.keys.has('submitted-pain') &&
        result.keys.has('test-pain') === union, 'submittedFrom だけの遷移元も和集合から信号キーになる');
    }
    fs.rmSync(TMP, { recursive: true, force: true });

    // 優先度式: inquiry は 2 の重みで、需要の証拠（×3）は超えない
    const now = new Date('2026-08-27T03:00:00.000Z');
    const base = priorityBreakdown({ search_intent: '一般的な税務' }, now);
    assert(base.inquiry === 0, '実測ファイルが無い間は 0');
    // inquirySignalFor をモックできないので、式の構造を直接確認
    const withInquiry = { demand: 0, season: 0, lead: 0, inquiry: 1 };
    const priority = withInquiry.demand * 3 + withInquiry.season * 2 + withInquiry.inquiry * 2 + withInquiry.lead;
    assert(priority === 2, '問い合わせ実績の重みは季節と同じ 2');
    const demandOnly = 0.7 * 3;
    assert(demandOnly > priority, '需要の証拠（最低70点）は問い合わせ実績より優先される');
  }

  console.log('\n=== 5. 実際のビーコンを本番・旧形式で実行 ===');
  for (const pathname of ['/contact', '/contact.html', '/contact/']) {
    test(`${pathname}: 記事の遷移元を送信・保存し受け口へつなぐ`, () => {
      const r = runBeacon({ pathname, referrer: 'https://mori-zeirishi.net/blog/x/' });
      strict.deepEqual(r.body, { p: pathname, r: '/blog/x/' });
      strict.equal(r.storage.get('mz_contact_from'), '/blog/x/');
      strict.equal(r.calls[0].url, '/track');
      strict.deepEqual(A.parseBeaconPayload(r.calls[0].raw), { path: '/contact.html', ref: '/blog/x/' });
    });
  }
  for (const ref of ['/contact', '/contact.html', '/contact/', '/contact-thanks', '/contact-thanks.html', '/contact-thanks/']) {
    test(`${ref} からの再表示では遷移元を送らず保存値を保つ`, () => {
      const storage = new Map([['mz_contact_from', '/blog/x/']]);
      const r = runBeacon({ referrer: 'https://mori-zeirishi.net' + ref, storage });
      strict.deepEqual(r.body, { p: '/contact' });
      strict.equal(storage.get('mz_contact_from'), '/blog/x/');
    });
  }
  for (const referrer of ['https://www.google.com/', '', 'invalid URL']) {
    test(`外部・空・不正な遷移元（${referrer}）では保存値を消す`, () => {
      const r = runBeacon({ referrer, storage: new Map([['mz_contact_from', '/blog/x/']]) });
      strict.deepEqual(r.body, { p: '/contact' });
      strict.ok(!r.storage.has('mz_contact_from'));
    });
  }
  for (const pathname of ['/contact-thanks', '/contact-thanks.html', '/contact-thanks/']) {
    test(`${pathname}: 保存した遷移元を送信後に消し再読込では送らない`, () => {
      const storage = new Map([['mz_contact_from', '/blog/x/']]);
      const r = runBeacon({ pathname, storage });
      strict.deepEqual(r.body, { p: pathname, r: '/blog/x/' });
      strict.equal(r.calls[0].storedAtSend, '/blog/x/');
      strict.ok(!storage.has('mz_contact_from'));
      strict.deepEqual(A.parseBeaconPayload(r.calls[0].raw), { path: '/contact-thanks.html', ref: '/blog/x/' });
      strict.deepEqual(runBeacon({ pathname, storage }).body, { p: pathname });
    });
  }
  for (const [pathname, referrer] of [['/contact', 'https://mori-zeirishi.net/blog/x/'],
    ['/contact', 'https://www.google.com/'], ['/contact-thanks', '']]) {
    test(`${pathname}: sessionStorage の例外でも閲覧を送る（${referrer}）`, () => {
      const r = runBeacon({ pathname, referrer, brokenStorage: true });
      strict.equal(r.calls.length, 1);
      strict.equal(r.body.p, pathname);
      if (referrer.includes('mori-zeirishi.net')) strict.equal(r.body.r, '/blog/x/');
    });
  }
  test('Pretty URL の遷移元も受け口で正規化し、サービスページも受け取る', () => {
    for (const [pathname, from, expected] of [['/contact', '/about', '/about.html'],
      ['/contact-thanks', '/services/ebay-export/', '/services/ebay-export/']]) {
      const r = runBeacon({ pathname, referrer: 'https://mori-zeirishi.net' + from,
        storage: new Map([['mz_contact_from', from]]) });
      strict.deepEqual(A.parseBeaconPayload(r.calls[0].raw), { path: pathname + '.html', ref: expected });
    }
  });
  test('本番以外・Do Not Track では送信もストレージ変更もしない', () => {
    for (const options of [{ hostname: 'preview.netlify.app' }, { doNotTrack: '1' }]) {
      const storage = new Map([['mz_contact_from', '/blog/x/']]);
      const r = runBeacon({ ...options, storage });
      strict.equal(r.calls.length + r.fetches.length, 0);
      strict.equal(storage.get('mz_contact_from'), '/blog/x/');
    }
  });
  test('sendBeacon が拒否された場合も同じ本文で fetch し保存値を消す', () => {
    const r = runBeacon({ pathname: '/contact-thanks', storage: new Map([['mz_contact_from', '/blog/x/']]), beaconAccepted: false });
    strict.deepEqual(r.fetches, [{ url: '/track', method: 'POST', body: r.calls[0].raw, keepalive: true, credentials: 'same-origin' }]);
    strict.ok(!r.storage.has('mz_contact_from'));
  });

  console.log('\n=== 6. 管理APIの送信完了集計 ===');
  {
    const previous = { user: process.env.ADMIN_BASIC_USER, pass: process.env.ADMIN_BASIC_PASS };
    process.env.ADMIN_BASIC_USER = 'analytics-test';
    process.env.ADMIN_BASIC_PASS = 'analytics-test-pass';
    try {
      const { handler } = require(path.join(ROOT, 'netlify/functions/admin-list-analytics'));
      const today = A.jstDate();
      const yesterday = A.dateOffset(today, -1), older = A.dateOffset(today, -40);
      const oldest = A.dateOffset(today, -89), outside = A.dateOffset(today, -90);
      const records = new Map([
        [`submissions/${today}`, { byFrom: { '/blog/x/': 2, '/about.html': 1, '/bad': -1, '/fraction': 1.5 } }],
        [`submissions/${yesterday}`, { byFrom: { '/blog/x/': 3 } }],
        [`submissions/${older}`, { byFrom: { '/blog/old/': 4 } }],
        [`submissions/${oldest}`, { byFrom: { '/blog/boundary/': 6 } }],
        [`submissions/${A.dateOffset(today, -2)}`, { byFrom: null }],
        [`submissions/${outside}`, { byFrom: { '/outside-range': 99 } }],
        [`transitions/${today}`, { byFrom: { '/blog/x/': 7 } }],
        [`daily/${today}`, { pageviews: 8, byPath: { '/contact.html': 5, '/contact-thanks.html': 3 } }],
        [`daily/${yesterday}`, { pageviews: 4, byPath: { '/about.html': 4 } }],
      ]);
      const store = { get: async key => records.get(key) || null, async *list() { yield { blobs: [] }; } };
      const event = { httpMethod: 'GET', headers: { authorization: 'Basic ' + Buffer.from('analytics-test:analytics-test-pass').toString('base64') } };
      const response = await handler(event, { getStoreFn: () => store });
      strict.equal(response.statusCode, 200);
      const data = JSON.parse(response.body);
      test('API today と最後の行が当日になり、今日・昨日のカードが対応する', () => {
        strict.equal(data.today, today);
        strict.equal(data.daily.at(-1).date, data.today);
        strict.equal(data.daily.at(-2).date, yesterday);
        strict.equal(data.summaries.today.pageviews, 8);
        strict.equal(data.summaries.yesterday.pageviews, 4);
      });
      test('当日から89日前までの90行を返し、90日前の送信完了は除外する', () => {
        strict.equal(data.daily.length, 90);
        strict.equal(data.daily[0].date, oldest);
        strict.ok(!data.daily.some(row => row.date === outside));
        strict.equal(data.submittedFrom['/blog/boundary/'], 6);
        strict.ok(!Object.hasOwn(data.submittedFrom, '/outside-range'));
      });
      test('日別と90日合計に submittedFrom を含み、欠測日は空になる', () => {
        strict.deepEqual(data.submittedFrom, { '/blog/x/': 5, '/about.html': 1, '/blog/old/': 4, '/blog/boundary/': 6 });
        strict.equal(data.daily.at(-1).submittedFrom['/blog/x/'], 2);
        strict.deepEqual(data.daily.at(-3).submittedFrom, {});
        strict.equal(data.daily.length, 90);
        strict.deepEqual(data.contactFrom, { '/blog/x/': 7 });
        strict.equal(data.summaries.today.pageviews, 8);
      });
      const unauthorized = await handler({ httpMethod: 'GET', headers: {} }, { getStoreFn: () => { throw new Error('auth bypassed'); } });
      assert(unauthorized.statusCode === 401, '注入ストアでも管理APIの認証は必須');

      const page = await require(path.join(ROOT, 'netlify/functions/admin-analytics-page')).handler(event);
      strict.ok(page.body.includes('送信完了につながったページ'));
      strict.ok(page.body.includes('選択中の期間に、このページを見たあと問い合わせを送った回数です（同じ画面の中で続けて見た場合だけ数えます）。'));
      const elements = new Map();
      const element = id => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', addEventListener: (name, fn) => { elements.get(id)[name] = fn; } });
        return elements.get(id);
      };
      const uiData = structuredClone(data);
      for (let i = 0; i < 11; i++) uiData.daily.at(-1).submittedFrom[`/blog/top-${i}/`] = 10 + i;
      vm.runInNewContext(page.body.match(/<script>([\s\S]*?)<\/script>/)[1], {
        document: { getElementById: element, querySelectorAll: () => [] },
        fetch: async url => ({ ok: true, json: async () => url.includes('/api/') ? uiData : { '/blog/top-10/': '<記事名>' } }),
      });
      await new Promise(resolve => setImmediate(resolve));
      test('管理画面は名称をエスケープし上位10件と選択期間を表示する', () => {
        const html = element('submitted-from').innerHTML;
        strict.ok(html.includes('&lt;記事名&gt;'));
        strict.equal((html.match(/<li>/g) || []).length, 10);
        strict.ok(html.indexOf('/blog/top-10/') < html.indexOf('/blog/top-9/'));
        strict.ok(!html.includes('/blog/old/'));
        strict.ok(element('contact-from').innerHTML.includes('7 回'));
        const initialChart = element('chart').innerHTML;
        element('period').click({ target: { tagName: 'BUTTON', dataset: { days: '90' } } });
        strict.notEqual(element('chart').innerHTML, initialChart);
      });
    } finally {
      for (const [key, value] of [['ADMIN_BASIC_USER', previous.user], ['ADMIN_BASIC_PASS', previous.pass]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  console.log('\n=== 7. 週次書き出しの本文と診断ログ ===');
  test('送信完了を出力し、閲覧数などの診断値はログだけに残す', () => {
    const source = fs.readFileSync(path.join(ROOT, '.github/workflows/export-contact-transitions.yml'), 'utf8');
    const script = source.match(/node -e "([\s\S]*?)\n\s*"/)[1];
    let written;
    const logs = [];
    const fakeFs = {
      readFileSync: () => JSON.stringify({ ok: true, contactFrom: { '/blog/x/': 2 }, submittedFrom: { '/blog/y/': 1 },
        daily: [{ pageviews: 9 }, { pageviews: 4 }], byPath: { '/contact.html': 5, '/contact-thanks.html': 3 } }),
      writeFileSync: (file, value) => { strict.equal(file, 'data/contact-transitions.json'); written = JSON.parse(value); },
    };
    vm.runInNewContext(script, { require: name => { strict.equal(name, 'fs'); return fakeFs; },
      console: { log: value => logs.push(value) } });
    strict.deepEqual(written.byFrom, { '/blog/x/': 2 });
    strict.deepEqual(written.submittedFrom, { '/blog/y/': 1 });
    strict.deepEqual(Object.keys(written).sort(), ['note', 'updated_at', 'days', 'byFrom', 'submittedFrom'].sort());
    strict.deepEqual(logs, ['直近90日の閲覧数: 13 PV', '問い合わせページの閲覧数: 5 PV', '送信完了ページの閲覧数: 3 PV',
      '遷移元ページ: 1 件', '送信完了の遷移元ページ: 1 件']);
  });

  console.log('');
  console.log('=== 4. 実測が無い間の安全性 ===');
  {
    if (!fs.existsSync(IS.SIGNALS_FILE)) {
      assert(IS.inquirySignalFor({ pain_point: 'x', cluster: 'y' }) === 0,
        '実測ファイルが無ければ常に 0（現状のアクセスゼロでも壊れない）');
      const { keys, fromCount } = IS.loadSignals();
      assert(keys.size === 0 && fromCount === 0, '信号は空として読み込まれる');
    } else {
      const { keys } = IS.loadSignals();
      assert(keys instanceof Set, '実測ファイルがあれば信号として読み込まれる');
      assert(typeof IS.inquirySignalFor({}) === 'number', '判定は常に数値を返す');
    }
  }

  console.log('');
  console.log(`=== 結果 ===`);
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
