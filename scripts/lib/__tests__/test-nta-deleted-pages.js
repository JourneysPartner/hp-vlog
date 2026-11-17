'use strict';

/**
 * 国税庁のエラーページへの転送を「削除済み」として扱う（段 1）の試験。
 *   node scripts/lib/__tests__/test-nta-deleted-pages.js
 *
 * 通信はしない。nta-crawler の部品は globalThis.fetch を偽物に差し替え、
 * 取り込みの CLI は vm で動かして fetch / 保存を偽物にする。
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const crawler = require('../nta-crawler');
const deletions = require('../nta-deletions');
const indexBuilder = require('../nta-index-builder');
const shitsugiTopics = require('../shitsugi-topics');
const store = require('../nta-store');
const ntaUnlisted = require('../nta-unlisted');
const { detectContentChange } = require('../nta-content-change');

const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures/nta-deleted-pages');
const CLI = path.join(ROOT, 'scripts/crawl-nta-sources.js');
const NOW = '2026-11-17T00:00:00Z';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const nearMisses = readJson(path.join(FIXTURES, 'near-miss-redirects.json'));
const existing5441 = readJson(path.join(FIXTURES, 'existing-taxanswer-5441.json'));
const existingShitsugi = readJson(path.join(FIXTURES, 'existing-shitsugi.json'));

let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n${error.stack}`);
  }
}

// ── fetch の偽物 ────────────────────────────────────────────────
function fakeResponse({ status = 200, url, redirected = false, body = '<html><body>本文</body></html>', headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected,
    url,
    headers: { get: name => (Object.hasOwn(headers, name.toLowerCase()) ? headers[name.toLowerCase()] : null) },
    arrayBuffer: async () => Buffer.from(body, 'utf8'),
  };
}

async function withFakeFetch(fake, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return fake(url, options);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ── 取り込み CLI を vm で 1 回動かす ───────────────────────────
function idFromUrl(url) {
  const match = new URL(url).pathname.match(/\/([^/]+)\.htm$/);
  return match ? match[1] : '';
}

function sectionFromUrl(url) {
  const match = new URL(url).pathname.match(/\/shitsugi\/[^/]+\/(\d+)\/(\d+)\.htm$/);
  return match ? match[1] : '00';
}

function taxanswerParsed(url) {
  return {
    id: idFromUrl(url),
    type: 'taxanswer',
    tax_category: '法人税',
    tax_category_code: 'hojin',
    title: `題名 ${idFromUrl(url)}`,
    law_version: '令和8年4月1日現在法令等',
    body: '本文です。',
    url,
  };
}

function shitsugiParsed(url) {
  const section = sectionFromUrl(url);
  return {
    id: idFromUrl(url),
    section,
    type: 'shitsugi',
    tax_category: '譲渡所得',
    tax_category_code: 'joto',
    title: `質疑応答 ${idFromUrl(url)}`,
    law_version: '令和8年4月1日現在の法令・通達等',
    body_combined: '回答です。',
    url,
  };
}

async function runCli({ argv, dependencies, onExit }) {
  const filename = CLI;
  const logs = [];
  let exitCode = null;
  const exit = code => {
    if (exitCode !== null) return;
    exitCode = code;
    if (onExit) onExit(code);
    const error = new Error(`process.exit(${code})`);
    error.exitCode = code;
    throw error;
  };
  const context = {
    __dirname: path.dirname(filename),
    require: name => {
      if (name === 'path') return path;
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      const key = path.relative(path.join(ROOT, 'scripts/lib'), name).split(path.sep).join('/');
      if (Object.hasOwn(dependencies, key)) return dependencies[key];
      throw new Error(`Unexpected require: ${name}`);
    },
    process: { argv: ['node', filename, ...argv], exit },
    console: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
  };
  const source = fs.readFileSync(filename, 'utf8')
    .replace('main().catch(e => {', 'globalThis.crawlDone = main().catch(e => {');
  vm.runInNewContext(source, context, { filename });
  let result;
  try {
    result = await context.crawlDone;
  } catch (error) {
    // process.exit を模した例外だけ握りつぶす（想定外の失敗はそのまま返す）。
    if (exitCode === null) throw error;
  }
  return { result, exitCode, logs };
}

// 段 2: 中身のファイルを消す部品が呼ばれたら落ちる偽の fs（U11・V18）。
const removalCalls = [];
const guardedFs = new Proxy(fs, {
  get(target, prop) {
    if (prop === 'unlinkSync' || prop === 'rmSync' || prop === 'rmdirSync') {
      return (...args) => {
        removalCalls.push({ prop, args });
        throw new Error(`ファイルを消してはいけません: ${String(prop)}`);
      };
    }
    return target[prop];
  },
});

function baseDependencies({ saved = [], existing = () => null, fetchPage, fetchPageHead,
  taxanswerEntries = [], shitsugiEntries = [], recordKeys = [], extra = {} } = {}) {
  const dependencies = {
    'nta-crawler': {
      RateLimiter: class { async wait() {} },
      fetchPageHead: fetchPageHead || (async () => ({
        ok: false, reason: 'nta_error_page', status: 200,
        finalUrl: crawler.NTA_ERROR_PAGE_URL, checkedAt: NOW,
      })),
      decideIncrementalAction: crawler.decideIncrementalAction,
      fetchPage: fetchPage || (async () => ({
        ok: false, reason: 'nta_error_page', status: 200,
        finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW,
      })),
    },
    'nta-parsers/taxanswer': { parseTaxAnswerHtml: (html, url) => taxanswerParsed(url) },
    'nta-index/taxanswer-index': { fetchTaxAnswerIndex: async () => taxanswerEntries },
    'nta-parsers/shitsugi': { parseShitsugiHtml: (html, url) => shitsugiParsed(url) },
    'nta-index/shitsugi-index': { fetchShitsugiIndex: async () => shitsugiEntries },
    'nta-store': {
      loadTaxAnswerEntry: (category, id) => existing({ id: String(id), category }, 'taxanswer'),
      readJson: file => existing({ id: path.basename(file, '.json'), file }, 'shitsugi'),
      shitsugiPath: (category, section, id) => `memory/${category}/${section}/${id}.json`,
      listRecordKeys: () => recordKeys,
      saveTaxAnswerEntry: entry => saved.push({ type: 'taxanswer', entry: clone(entry) }),
      saveShitsugiEntry: entry => saved.push({ type: 'shitsugi', entry: clone(entry) }),
    },
    'nta-index-builder': {
      buildIndex: () => ({ total_count: 0, by_type: {} }),
      saveIndex: () => {},
      saveMeta: () => {},
    },
    'nta-figures': { extractFigureRefs: () => [], fetchAndStoreFigures: async () => [] },
    'nta-content-change': { detectContentChange },
    'nta-deletions': deletions,
    'nta-unlisted': ntaUnlisted,
    fs: guardedFs,
  };
  return { ...dependencies, ...extra };
}

async function runCrawl(options = {}) {
  const saved = [];
  const dependencies = baseDependencies({ ...options, saved });
  const argv = options.argv || ['--type', options.type || 'taxanswer', '--incremental', '--skip-index'];
  const { result, exitCode, logs } = await runCli({ argv, dependencies });
  return { result, exitCode, logs, saved };
}

function taxentry(id, extra = {}) {
  return {
    id: String(id),
    category: 'hojin',
    url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/${id}.htm`,
    ...extra,
  };
}

function shitsugiEntry(id, section = '16', extra = {}) {
  return {
    id: String(id),
    section,
    category: 'joto',
    url: `https://www.nta.go.jp/law/shitsugi/joto/${section}/${id}.htm`,
    label: `質疑 ${id}`,
    ...extra,
  };
}

function existingRecord(entry, kind, overrides = {}) {
  if (kind === 'taxanswer') {
    return { ...existing5441, ...taxanswerParsed(entry.url), ...overrides,
      id: String(entry.id), url: entry.url, html_hash: 'hash-' + entry.id };
  }
  return { ...existingShitsugi, ...shitsugiParsed(entry.url), ...overrides,
    id: String(entry.id), section: entry.section, url: entry.url, html_hash: 'hash-' + entry.id };
}

function okFetch(hash, extra = {}) {
  return async () => ({
    ok: true, html: '<html><body>本文</body></html>', htmlHash: hash,
    byteSize: 20, encoding: 'utf-8', fetchedAt: NOW,
    lastModified: 'Thu, 01 Oct 2026 00:00:00 GMT', etag: `"${hash}"`, ...extra,
  });
}

// ── 段 2（一覧から外れた記録）用の小さな道具 ────────────────────
function taEntry(category, id) {
  return {
    id: String(id),
    category,
    url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/${category}/${id}.htm`,
    label: `一覧の題名 ${id}`,
  };
}

function taKey(category, id) {
  return { type: 'taxanswer', category, id: String(id), file_path: `taxanswer/${category}/${id}.json` };
}

function shitsugiKey(category, section, id) {
  return {
    type: 'shitsugi', category, section: String(section), id: String(id),
    file_path: `shitsugi/${category}/${section}/${id}.json`,
  };
}

// 題名・本文は架空（実在の記録の写しは置かない）。
function taRecord(category, id, overrides = {}) {
  const url = `https://www.nta.go.jp/taxes/shiraberu/taxanswer/${category}/${id}.htm`;
  return {
    id: String(id), type: 'taxanswer', tax_category: '架空の分類', tax_category_code: category,
    url, title: `架空の題名 ${id}`, law_version: '令和8年4月1日現在法令等',
    body: '架空の本文です。', char_count_body: 8,
    fetched_at: '2026-06-21T00:00:00Z', last_checked_at: '2026-09-01T00:00:00Z',
    html_hash: `old-hash-${category}-${id}`, byte_size: 100, encoding: 'utf-8',
    last_modified: 'Wed, 01 Apr 2026 00:00:00 GMT', etag: `"etag-${category}-${id}"`,
    first_fetched_at: '2026-06-21T00:00:00Z',
    ...overrides,
  };
}

function shitsugiRecord(category, section, id, overrides = {}) {
  const url = `https://www.nta.go.jp/law/shitsugi/${category}/${section}/${id}.htm`;
  return {
    id: String(id), section: String(section), type: 'shitsugi', tax_category: '架空の分類',
    tax_category_code: category, url, title: `架空の質疑 ${id}`,
    body_combined: '架空の本文です。', char_count_body: 8,
    fetched_at: '2026-06-21T00:00:00Z', last_checked_at: '2026-09-01T00:00:00Z',
    html_hash: `old-hash-${category}-${section}-${id}`, byte_size: 100, encoding: 'utf-8',
    last_modified: 'Wed, 01 Apr 2026 00:00:00 GMT', etag: `"etag-${category}-${id}"`,
    first_fetched_at: '2026-06-21T00:00:00Z',
    ...overrides,
  };
}

// 記録の置き場所をキーにした記録の集まりから、一覧にある記録・外れた記録を読む。
function loadRecords(records) {
  return (ref, kind) => {
    let key = null;
    if (kind === 'taxanswer') {
      key = `taxanswer/${ref.category}/${ref.id}`;
    } else {
      const match = String(ref.file || '').match(/^memory\/([^/]+)\/([^/]+)\/([^/]+)\.json$/);
      if (match) key = `shitsugi/${match[1]}/${match[2]}/${match[3]}`;
    }
    const record = key ? records[key] : null;
    return record ? clone(record) : null;
  };
}

// URL ごとに応答を返す。map に無ければ fallback（関数か値）を返す。
function routed(fallback, map = {}) {
  return async url => {
    const value = Object.hasOwn(map, url) ? map[url] : fallback;
    return typeof value === 'function' ? value(url) : clone(value);
  };
}

const goneGet = () => ({
  ok: false, reason: 'nta_error_page', status: 200,
  finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW,
});
const goneHead = () => ({
  ok: false, reason: 'nta_error_page', status: 200,
  finalUrl: crawler.NTA_ERROR_PAGE_URL, checkedAt: NOW,
});
const aliveHead = etag => () => ({ ok: true, checkedAt: NOW, etag, lastModified: 'same' });
const changedHead = () => ({ ok: true, checkedAt: NOW, etag: '"changed"', lastModified: 'changed' });

async function main() {
  // ── T1 本文の取得 ───────────────────────────────────────────
  await test('T1 本文の取得: 302 でエラーページへ転送 → nta_error_page（状態 200/404 とも）', async () => {
    for (const status of [200, 404]) {
      await withFakeFetch(
        () => fakeResponse({ status, url: crawler.NTA_ERROR_PAGE_URL, redirected: true }),
        async calls => {
          const result = await crawler.fetchPage('https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm', { maxRetries: 0 });
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'nta_error_page');
          assert.equal(result.status, status);
          assert.equal(result.finalUrl, crawler.NTA_ERROR_PAGE_URL);
          assert.equal(calls.length, 1, 'fetch は 1 回だけ');
        });
    }
  });

  // ── T2 HEAD ────────────────────────────────────────────────
  await test('T2 HEAD: エラーページへの転送 → nta_error_page（url / checkedAt 付き）', async () => {
    for (const status of [200, 404]) {
      await withFakeFetch(
        () => fakeResponse({ status, url: crawler.NTA_ERROR_PAGE_URL, redirected: true }),
        async calls => {
          const result = await crawler.fetchPageHead('https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm', { maxRetries: 0 });
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'nta_error_page');
          assert.equal(result.status, status);
          assert.equal(result.url, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm');
          assert.equal(result.finalUrl, crawler.NTA_ERROR_PAGE_URL);
          assert.equal(typeof result.checkedAt, 'string');
          assert.equal(calls.length, 1);
          assert.equal(calls[0].options.method, 'HEAD');
        });
    }
  });

  // ── T3 似て非なる行き先（G3・G7(d)）───────────────────────────
  await test('T3 S3 の似て非なる行き先は nta_error_page・not_found にしない（GET/HEAD、状態 200/404）', async () => {
    const origin = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm';
    assert.equal(nearMisses.errorPageUrl, crawler.NTA_ERROR_PAGE_URL);
    for (const url of nearMisses.nearMisses) {
      for (const status of [200, 404]) {
        const label = `${url} / 状態 ${status}`;
        await withFakeFetch(() => fakeResponse({ status, url, redirected: true }), async calls => {
          const result = await crawler.fetchWithRetry(origin, { maxRetries: 0 });
          assert.notEqual(result.reason, 'nta_error_page', `GET: ${label}`);
          assert.notEqual(result.reason, 'not_found', `GET: ${label}`);
          assert.equal(result.ok, status === 200, `GET: ${label}`);
          assert.equal(calls.length, 1, `GET: ${label}`);
        });
        await withFakeFetch(() => fakeResponse({ status, url, redirected: true }), async calls => {
          const result = await crawler.fetchPageHead(origin, { maxRetries: 0 });
          assert.notEqual(result.reason, 'nta_error_page', `HEAD: ${label}`);
          assert.notEqual(result.reason, 'not_found', `HEAD: ${label}`);
          assert.equal(result.ok, status === 200, `HEAD: ${label}`);
          assert.equal(calls.length, 1, `HEAD: ${label}`);
          assert.equal(calls[0].options.method, 'HEAD', `HEAD: ${label}`);
        });
      }
    }
    // 転送されていない応答は、行き先がエラーページでも削除にしない。
    await withFakeFetch(
      () => fakeResponse({ status: 200, url: crawler.NTA_ERROR_PAGE_URL, redirected: false }),
      async () => {
        const result = await crawler.fetchWithRetry(origin, { maxRetries: 0 });
        assert.equal(result.ok, true);
      });
    // 国税庁の別のページへの転送は削除にしない。
    await withFakeFetch(
      () => fakeResponse({ status: 200, url: 'https://www.nta.go.jp/law/shitsugi/joto/16/09.htm', redirected: true }),
      async () => {
        const result = await crawler.fetchWithRetry(origin, { maxRetries: 0 });
        assert.equal(result.ok, true);
        assert.notEqual(result.reason, 'nta_error_page');
      });
    // 転送されずに 404/410 が返ったときは、今までどおり not_found（GET と HEAD）。
    for (const status of [404, 410]) {
      await withFakeFetch(() => fakeResponse({ status, url: origin, redirected: false }), async () => {
        const get = await crawler.fetchWithRetry(origin, { maxRetries: 0 });
        assert.equal(get.reason, 'not_found', `GET 転送なし ${status}`);
        assert.equal(get.status, status);
      });
      await withFakeFetch(() => fakeResponse({ status, url: origin, redirected: false }), async () => {
        const head = await crawler.fetchPageHead(origin, { maxRetries: 0 });
        assert.equal(head.reason, 'not_found', `HEAD 転送なし ${status}`);
        assert.equal(head.status, status);
      });
    }
  });

  // ── T4 decideIncrementalAction ──────────────────────────────
  await test('T4 差分判定: head_error_page / recheck_deleted / 既存の skip / head_404', async () => {
    assert.deepEqual(
      crawler.decideIncrementalAction({ html_hash: 'h', etag: '"a"' }, { ok: false, reason: 'nta_error_page' }),
      { decision: 'mark_deleted', reason: 'head_error_page' });
    assert.deepEqual(
      crawler.decideIncrementalAction({ html_hash: 'h', deleted: true, etag: '"a"' },
        { ok: true, etag: '"a"', lastModified: 'same' }),
      { decision: 'fetch', reason: 'recheck_deleted' });
    assert.deepEqual(
      crawler.decideIncrementalAction({ html_hash: 'h', etag: '"a"' }, { ok: true, etag: '"a"', lastModified: 'same' }),
      { decision: 'skip', reason: 'etag_match' });
    assert.deepEqual(
      crawler.decideIncrementalAction({ html_hash: 'h', etag: '"a"' }, { ok: false, reason: 'not_found', status: 404 }),
      { decision: 'mark_deleted', reason: 'head_404' });
  });

  // ── T5 記録あり＋エラーページ ────────────────────────────────
  await test('T5 記録あり＋本文がエラーページ: 4 項目だけが違う記録を保存', async () => {
    const before = clone(existing5441);
    const { saved } = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: (ref, kind) => (kind === 'taxanswer' ? clone(existing5441) : null),
    });
    assert.equal(saved.length, 1);
    const entry = saved[0].entry;
    assert.equal(entry.deleted, true);
    assert.equal(entry.deleted_reason, 'nta_error_page');
    assert.equal(entry.deleted_at, NOW);
    assert.equal(entry.last_checked_at, NOW);
    const expected = { ...clone(existing5441), deleted: true, deleted_reason: 'nta_error_page',
      deleted_at: NOW, last_checked_at: NOW };
    assert.deepEqual(entry, expected);
    assert.deepEqual(existing5441, before, '既存の記録は書き換えない');
  });

  // ── T6 記録なし＋エラーページ ────────────────────────────────
  await test('T6 記録なし＋エラーページ: 保存せず goneUnrecorded。errors に入れない', async () => {
    const { result, saved } = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: () => null,
    });
    assert.equal(saved.length, 0);
    assert.deepEqual(Array.from(result.gone_unrecorded_urls), [taxentry('5441').url]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.deleted, 0);
  });

  // ── T7 S2 の失敗は削除にしない ──────────────────────────────
  await test('T7 S2 の失敗は削除にせず、記録も変えない', async () => {
    const cases = [
      { reason: 'retry_exhausted', status: 0 },
      { reason: 'http_error', status: 403 },
      { reason: 'retry_exhausted', status: 503 },
      { reason: 'mojibake_detected', status: 200 },
      { reason: 'parse_failed', status: 200 },
    ];
    for (const failure of cases) {
      const { result, saved } = await runCrawl({
        taxanswerEntries: [taxentry('5441')],
        existing: (ref, kind) => (kind === 'taxanswer' ? clone(existing5441) : null),
        fetchPageHead: async () => ({ ok: true, checkedAt: NOW, etag: '"changed"', lastModified: 'changed' }),
        fetchPage: async () => ({ ok: false, reason: failure.reason, status: failure.status, fetchedAt: NOW }),
      });
      assert.equal(saved.length, 0, `${failure.reason}/${failure.status} は保存しない`);
      assert.equal(result.deleted, 0);
      assert.equal(result.deletion_held, 0);
      assert.equal(result.deleted_still, 0);
      assert.equal(result.errors.length, 1, `${failure.reason}/${failure.status} は失敗`);
    }
    // 国税庁の別のページへの転送で本文が取れた場合は、削除にせず普通に保存する。
    const other = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: (ref, kind) => (kind === 'taxanswer' ? clone(existing5441) : null),
      fetchPageHead: async () => ({ ok: true, checkedAt: NOW, etag: '"changed"', lastModified: 'changed' }),
      fetchPage: okFetch('another-page'),
    });
    assert.equal(other.saved.length, 1);
    assert.equal(Object.hasOwn(other.saved[0].entry, 'deleted'), false);
    assert.equal(other.result.deleted, 0);
    assert.equal(other.result.errors.length, 0);
  });

  // ── T8 上限 ────────────────────────────────────────────────
  await test('T8 上限: 21 件・上限 20 は 0 件保存、ちょうど 20 は 20 件保存', async () => {
    const make = count => ({
      taxanswerEntries: Array.from({ length: count }, (_, i) => taxentry(6001 + i)),
      existing: (ref, kind) => (kind === 'taxanswer' ? existingRecord(taxentry(ref.id), kind) : null),
    });
    const over = await runCrawl({ ...make(21), argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '20'] });
    assert.equal(over.saved.length, 0);
    assert.equal(over.result.deleted, 0);
    assert.equal(over.result.deletion_held, 21);
    assert.equal(over.result.deletion_held_entries.length, 21);
    assert(over.logs.some(line => line.startsWith('[held]')));
    assert.equal(over.logs.some(line => line.startsWith('[deleted]')), false);

    const exact = await runCrawl({ ...make(20), argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '20'] });
    assert.equal(exact.saved.length, 20);
    assert.equal(exact.result.deleted, 20);
    assert.equal(exact.result.deletion_held, 0);

    const raised = await runCrawl({ ...make(21), argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '25'] });
    assert.equal(raised.saved.length, 21);
    assert.equal(raised.result.deleted, 21);

    const zero = await runCrawl({ ...make(1), argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '0'] });
    assert.equal(zero.saved.length, 0);
    assert.equal(zero.result.deletion_held, 1);
  });

  await test('T8 上限: タックスアンサーと質疑応答を合わせて数える', async () => {
    const { saved, result } = await runCrawl({
      type: 'all',
      taxanswerEntries: Array.from({ length: 11 }, (_, i) => taxentry(7001 + i)),
      shitsugiEntries: Array.from({ length: 10 }, (_, i) => shitsugiEntry(String(21 + i).padStart(2, '0'))),
      existing: (ref, kind) => (kind === 'taxanswer'
        ? existingRecord(taxentry(ref.id), kind)
        : existingRecord(shitsugiEntry(ref.id), 'shitsugi')),
      argv: ['--type', 'all', '--incremental', '--skip-index', '--max-deletions', '20'],
    });
    assert.equal(result.deleted + result.deletion_held, 21);
    assert.equal(result.deleted, 0);
    assert.equal(result.deletion_held, 21);
    assert.equal(saved.length, 0);

    // 合わせて 20 件・上限 20 なら 20 件とも保存する。
    const exact = await runCrawl({
      type: 'all',
      taxanswerEntries: Array.from({ length: 10 }, (_, i) => taxentry(7101 + i)),
      shitsugiEntries: Array.from({ length: 10 }, (_, i) => shitsugiEntry(String(31 + i).padStart(2, '0'))),
      existing: (ref, kind) => (kind === 'taxanswer'
        ? existingRecord(taxentry(ref.id), kind)
        : existingRecord(shitsugiEntry(ref.id), 'shitsugi')),
      argv: ['--type', 'all', '--incremental', '--skip-index', '--max-deletions', '20'],
    });
    assert.equal(exact.result.deleted, 20);
    assert.equal(exact.result.deletion_held, 0);
    assert.equal(exact.saved.length, 20);
  });

  // ── T9 前から削除済み ──────────────────────────────────────
  await test('T9 前から削除済み＋今回も無い: 新しい削除に数えず上限にも数えない', async () => {
    const previous = { ...clone(existing5441), deleted: true, deleted_reason: 'not_found', deleted_at: '2026-10-01T00:00:00Z' };
    const { saved, result } = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: (ref, kind) => (kind === 'taxanswer' ? clone(previous) : null),
      argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '0'],
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].entry.deleted, true);
    assert.equal(saved[0].entry.deleted_at, '2026-10-01T00:00:00Z');
    assert.equal(result.deleted, 0);
    assert.equal(result.deleted_still, 1);
    assert.equal(result.deletion_held, 0);
  });

  // ── T10 復活 ───────────────────────────────────────────────
  await test('T10 復活: hash が違っても同じでも印を外して保存し restored に入れる', async () => {
    for (const hash of ['new-hash', 'old-hash-5441']) {
      const previous = { ...clone(existing5441), deleted: true, deleted_reason: 'nta_error_page', deleted_at: '2026-10-01T00:00:00Z' };
      const { saved, result } = await runCrawl({
        taxanswerEntries: [taxentry('5441')],
        existing: (ref, kind) => (kind === 'taxanswer' ? clone(previous) : null),
        fetchPageHead: async () => ({ ok: true, checkedAt: NOW, etag: '"changed"', lastModified: 'changed' }),
        fetchPage: okFetch(hash),
      });
      assert.equal(saved.length, 1);
      const entry = saved[0].entry;
      for (const key of ['deleted', 'deleted_reason', 'deleted_at']) {
        assert.equal(Object.hasOwn(entry, key), false, `${hash}: ${key} を残さない`);
      }
      assert.equal(result.restored_entries.length, 1);
      assert.equal(result.restored_entries[0].url, taxentry('5441').url);
    }
  });

  // ── T11 報告ファイル ────────────────────────────────────────
  await test('T11 報告: 題名・URL・理由・使っている所、上限の節と再実行の 1 文、| と改行の置換', async () => {
    const entry = {
      type: 'taxanswer',
      url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm',
      title: '研究|開発\n税制',
      file_path: 'taxanswer/hojin/5441.json',
      reason: 'nta_error_page',
    };
    const held = {
      type: 'shitsugi',
      url: 'https://www.nta.go.jp/law/shitsugi/joto/16/09.htm',
      title: '質疑|応答',
      file_path: 'shitsugi/joto/16/09.json',
      reason: 'not_found',
    };
    const markdown = deletions.renderReport({
      deleted: [entry],
      held: [held],
      restored: [{ type: 'taxanswer', url: entry.url, title: '戻った題名' }],
      deletedStill: 2,
      goneUnrecorded: ['https://www.nta.go.jp/a.htm', 'https://www.nta.go.jp/b.htm'],
      maxDeletions: 1,
      references: { [entry.url]: ['content/posts/a.md', 'data/fact-check/b.json'] },
    });
    assert(markdown.includes('## 国税庁で削除されたページ（この PR で「削除済み」の印を付けたもの）: 1 件'));
    assert(markdown.includes('| タックスアンサー | No.5441 研究\\|開発 税制 |'));
    assert(markdown.includes('国税庁のエラーページ（/error/404.htm）へ転送'));
    assert(markdown.includes('`content/posts/a.md`、`data/fact-check/b.json`'));
    assert(markdown.includes('## 上限を超えたため印を付けなかったもの: 1 件（上限 1 件）'));
    assert(markdown.includes('max_deletions に 1 以上'));
    assert(markdown.includes('| 質疑応答事例 | 質疑\\|応答 |'));
    assert(markdown.includes('404/410 が返った'));
    assert(markdown.includes('## 国税庁で戻ったページ（「削除済み」の印を外したもの）: 1 件'));
    assert(markdown.includes('## 前から削除済みで、今回も無かったもの: 2 件'));
    assert(markdown.includes('## 国税庁の一覧には載っているがページが無いもの（DB に記録なし・変更なし）: 2 件'));
    assert(markdown.includes('- https://www.nta.go.jp/a.htm'));
    const empty = deletions.renderReport({ maxDeletions: 20 });
    assert(empty.includes('削除済み」の印を付けたもの）: 0 件'));
    assert(empty.includes('上限を超えたため印を付けなかったもの: 0 件（上限 20 件）'));
    assert(empty.includes('なし'));

    const many = deletions.renderReport({
      deleted: [{ ...entry, title: '題名', references: [] }],
      maxDeletions: 20,
      references: { [entry.url]: Array.from({ length: 12 }, (_, i) => `content/posts/${i}.md`) },
    });
    assert(many.includes('ほか 2 件'));
  });

  await test('T11 報告ファイル: CLI の --report-file が --skip-index でも書かれる', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-deleted-report-'));
    try {
      const reportFile = path.join(dir, 'nested', 'report.md');
      const { saved } = await runCrawl({
        taxanswerEntries: [taxentry('5441')],
        existing: (ref, kind) => (kind === 'taxanswer' ? clone(existing5441) : null),
        argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--report-file', reportFile],
      });
      assert.equal(saved.length, 1);
      const markdown = fs.readFileSync(reportFile, 'utf8');
      assert(markdown.includes(taxentry('5441').url));
      assert(markdown.includes('| タックスアンサー | No.5441 研究開発税制について(概要) |'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('T11 報告ファイル: 上限で止めたときの節と再実行の 1 文', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-deleted-held-'));
    try {
      const reportFile = path.join(dir, 'report.md');
      const { saved } = await runCrawl({
        taxanswerEntries: [taxentry('5441'), taxentry('5442')],
        existing: (ref, kind) => (kind === 'taxanswer' ? existingRecord(taxentry(ref.id), kind) : null),
        argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '1', '--report-file', reportFile],
      });
      assert.equal(saved.length, 0);
      const markdown = fs.readFileSync(reportFile, 'utf8');
      assert(markdown.includes('## 上限を超えたため印を付けなかったもの: 2 件（上限 1 件）'));
      assert(markdown.includes('max_deletions に 2 以上'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T12 findReferences ─────────────────────────────────────
  await test('T12 findReferences: 記事の URL 引用・taxanswer_id・__tests__ と assets の除外', () => {
    const root = path.join(FIXTURES, 'references');
    const tax = { type: 'taxanswer', url: taxentry('5441').url };
    const shitsugi = { type: 'shitsugi', url: shitsugiEntry('09').url };
    const result = deletions.findReferences([tax, shitsugi], { root });
    assert.deepEqual(result[tax.url], [
      'content/posts/hojin-5441.md',
      'data/fact-check/hojin.json',
      'data/tax-simulator/sim.json',
      'data/tax-simulator/unquoted.json',
      'scripts/lib/source-links.js',
    ]);
    assert.deepEqual(result[shitsugi.url], ['scripts/topic-pool.js']);
    assert.equal(result[tax.url].some(file => file.includes('__tests__')), false);
    assert.equal(result[tax.url].some(file => file.startsWith('assets/')), false);
    assert.equal(result[tax.url].some(file => file.includes('other.json')), false);
  });

  // ── T13 saveMeta ───────────────────────────────────────────
  await test('T13 saveMeta: R5 の項目と total_entries_processed、未指定は 0・空配列', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-meta-deleted-'));
    try {
      const file = path.join(dir, 'meta.json');
      indexBuilder.saveMeta({
        startedAt: '2026-11-17T00:00:00Z',
        finishedAt: '2026-11-17T00:01:00Z',
        results: { fetched: 2, skipped: 3, deleted: 1, deleted_still: 2, deletion_held: 4,
          restored: 1, gone_unrecorded: 5, errors: [] },
        byType: {},
        maxDeletions: 20,
        deletedEntries: [{ type: 'shitsugi', url: 'https://b', title: 'B', file_path: 'b', reason: 'not_found' },
          { type: 'taxanswer', url: 'https://a', title: 'A', file_path: 'a', reason: 'nta_error_page' }],
        deletionHeldEntries: [{ type: 'taxanswer', url: 'https://c', title: 'C', file_path: 'c', reason: 'nta_error_page' }],
        restoredEntries: [{ type: 'taxanswer', url: 'https://d', title: 'D' }],
        goneUnrecordedUrls: ['https://f', 'https://e'],
        metaFile: file,
      });
      const meta = readJson(file);
      assert.deepEqual(meta.crawl_results, {
        fetched: 2, skipped: 3, deleted: 1, deleted_still: 2, deletion_held: 4,
        restored: 1, gone_unrecorded: 5, errors_count: 0,
      });
      assert.equal(meta.total_entries_processed, 12);
      assert.equal(meta.max_deletions, 20);
      assert.deepEqual(meta.deleted_entries.map(entry => entry.url), ['https://a', 'https://b']);
      assert.equal(meta.deletion_held_entries.length, 1);
      assert.deepEqual(meta.restored_entries, [{ type: 'taxanswer', url: 'https://d', title: 'D' }]);
      assert.deepEqual(meta.gone_unrecorded_urls, ['https://e', 'https://f']);

      const minimal = path.join(dir, 'minimal.json');
      indexBuilder.saveMeta({ startedAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:00Z',
        results: { fetched: 0 }, metaFile: minimal });
      const minimalMeta = readJson(minimal);
      assert.equal(minimalMeta.crawl_results.deleted, 0);
      assert.equal(minimalMeta.crawl_results.deleted_still, 0);
      assert.equal(minimalMeta.crawl_results.deletion_held, 0);
      assert.equal(minimalMeta.crawl_results.restored, 0);
      assert.equal(minimalMeta.crawl_results.gone_unrecorded, 0);
      assert.equal(minimalMeta.max_deletions, 0);
      assert.deepEqual(minimalMeta.deleted_entries, []);
      assert.deepEqual(minimalMeta.deletion_held_entries, []);
      assert.deepEqual(minimalMeta.restored_entries, []);
      assert.deepEqual(minimalMeta.gone_unrecorded_urls, []);
      assert.equal(minimalMeta.total_entries_processed, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T14 題材の除外 ─────────────────────────────────────────
  await test('T14 expandShitsugiTopics: 削除済みの質疑応答を題材にしない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-shitsugi-topics-'));
    try {
      const sourceRoot = path.join(dir, 'sources');
      const candidateFile = path.join(dir, 'candidates.json');
      const sourceDir = path.join(sourceRoot, 'shitsugi/joto/16');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, '09.json'), JSON.stringify({
        ...existingShitsugi, deleted: true, deleted_reason: 'nta_error_page',
        deleted_at: '2026-10-01T00:00:00Z', shokai_yoshi: '削除された質疑の要旨',
      }));
      fs.writeFileSync(path.join(sourceDir, '10.json'), JSON.stringify({
        ...existingShitsugi, id: '10', shokai_yoshi: '生きている質疑の要旨',
      }));
      const base = {
        adopted: true,
        tax_category: '譲渡所得',
        tax_category_code: 'joto',
        section: '16',
        score: 3,
        score_breakdown: { search_need: 1, judgment_ambiguity: 2 },
        shitsugi_title: '質疑の題名',
        proposed: { persona: 'general_individual_proprietor', macro: '税目実務', article_type: 'guide' },
      };
      fs.writeFileSync(candidateFile, JSON.stringify({ candidates: [
        { ...base, id: '09', file_path: 'shitsugi/joto/16/09.json', shitsugi_url: shitsugiEntry('09').url },
        { ...base, id: '10', file_path: 'shitsugi/joto/16/10.json', shitsugi_url: shitsugiEntry('10').url },
      ] }));
      const warnings = [];
      const topics = shitsugiTopics.expandShitsugiTopics({
        candidateFile,
        sourceRoot,
        personaAllowlist: ['general_individual_proprietor'],
        filterRelevance: false,
        logger: { warn: message => warnings.push(message) },
      });
      const stats = shitsugiTopics.getLastExpansionStats();
      assert.deepEqual(topics.map(topic => topic.slug), ['shitsugi-joto-16-10']);
      assert.equal(stats.unreadable, 1);
      assert(warnings.some(message => message.includes('国税庁で削除済みです')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── T15 --backfill-figures（G7(a)）───────────────────────────
  await test('T15 --backfill-figures: 本物の fetchPage でエラーページへ転送されたら記録を書き換えない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-backfill-deleted-'));
    try {
      const sources = path.join(dir, 'nta-sources');
      const recordDir = path.join(sources, 'taxanswer/hojin');
      fs.mkdirSync(recordDir, { recursive: true });
      const file = path.join(recordDir, '5441.json');
      fs.writeFileSync(file, JSON.stringify(existing5441), 'utf8');
      const before = fs.readFileSync(file, 'utf8');
      // 本物の nta-crawler（fetchPage）に、302 でエラーページへ転送する偽の fetch を
      // 食わせる。偽の応答は状態 200・redirected が true・url がエラーページ。
      await withFakeFetch(
        () => fakeResponse({ status: 200, url: crawler.NTA_ERROR_PAGE_URL, redirected: true,
          body: '<html><body>国税庁のエラーページ</body></html>' }),
        async calls => {
          const dependencies = baseDependencies({
            extra: {
              'nta-crawler': crawler,
              'nta-store': {
                NTA_SOURCES_DIR: sources,
                readJson: target => JSON.parse(fs.readFileSync(target, 'utf8')),
                writeJsonAtomic: () => { throw new Error('記録を書き換えてはいけません'); },
              },
            },
          });
          const { exitCode } = await runCli({ argv: ['--backfill-figures'], dependencies });
          assert.equal(exitCode, null);
          assert.equal(calls.length, 1, '本文は 1 回だけ取る');
          assert.equal(calls[0].options.method, undefined, 'GET で取る');
        });
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── S7 一覧に載っていない資料は訪ねない ─────────────────────
  await test('S7 一覧が空ならページを訪ねず、削除にもしない', async () => {
    let fetched = 0;
    const { result, saved } = await runCrawl({
      taxanswerEntries: [],
      existing: () => clone(existing5441),
      fetchPage: async () => { fetched++; return { ok: false, reason: 'nta_error_page', status: 200,
        finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW }; },
    });
    assert.equal(fetched, 0);
    assert.equal(saved.length, 0);
    assert.equal(result.deleted, 0);
    assert.equal(result.gone_unrecorded_urls.length, 0);
  });

  await test('S7 一覧の取得に失敗したら何も削除しない', async () => {
    let fetchCalls = 0;
    const dependencies = baseDependencies({
      fetchPage: async () => { fetchCalls++; return { ok: false, reason: 'nta_error_page', status: 200,
        finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW }; },
      extra: {
        'nta-index/taxanswer-index': { fetchTaxAnswerIndex: async () => { throw new Error('一覧が取れません'); } },
      },
    });
    const { exitCode } = await runCli({
      argv: ['--type', 'taxanswer', '--incremental', '--skip-index'],
      dependencies,
    });
    assert.equal(exitCode, 1);
    assert.equal(fetchCalls, 0);
  });

  // ── T16 引数 ───────────────────────────────────────────────
  await test('T16 引数: --max-deletions は 0 以上の整数だけを受け入れる', async () => {
    for (const value of ['-1', 'abc', '1.5']) {
      const dependencies = baseDependencies();
      const { exitCode } = await runCli({
        argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', value],
        dependencies,
      });
      assert.equal(exitCode, 2, `${value} は終了コード 2`);
    }
  });

  // ── F1 --dry-run ───────────────────────────────────────────
  await test('F1 --dry-run: taxanswer / shitsugi / all で終了せず、数は 0（NaN でない）', async () => {
    for (const type of ['taxanswer', 'shitsugi', 'all']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-dry-run-'));
      try {
        const reportFile = path.join(dir, 'report.md');
        const { result, exitCode, saved } = await runCrawl({
          type,
          taxanswerEntries: [taxentry('5441')],
          shitsugiEntries: [shitsugiEntry('09')],
          existing: () => clone(existing5441),
          argv: ['--type', type, '--incremental', '--dry-run', '--report-file', reportFile],
        });
        assert.equal(exitCode, null, `${type}: process.exit を呼ばない`);
        assert.equal(saved.length, 0, `${type}: 保存 0 件`);
        for (const key of ['deleted', 'deleted_still', 'deletion_held']) {
          assert.equal(result[key], 0, `${type}: ${key} は 0`);
          assert.equal(Number.isNaN(result[key]), false, `${type}: ${key} は NaN でない`);
          assert.equal(typeof result[key], 'number', `${type}: ${key} は数`);
        }
        assert.equal(result.errors.length, 0, `${type}: 失敗なし`);
        const markdown = fs.readFileSync(reportFile, 'utf8');
        assert(markdown.includes('## 国税庁で削除されたページ（この PR で「削除済み」の印を付けたもの）: 0 件'), type);
        assert(markdown.includes('## 上限を超えたため印を付けなかったもの: 0 件（上限 20 件）'), type);
        assert(markdown.includes('## 国税庁で戻ったページ（「削除済み」の印を外したもの）: 0 件'), type);
        assert(markdown.includes('## 前から削除済みで、今回も無かったもの: 0 件'), type);
        assert(markdown.includes('## 国税庁の一覧には載っているがページが無いもの（DB に記録なし・変更なし）: 0 件'), type);
        assert.equal(markdown.includes('NaN'), false, `${type}: 報告に NaN を出さない`);
        assert.equal(markdown.split('\n').filter(line => line === 'なし').length, 5,
          `${type}: 該当なしの節はすべて「なし」`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // ── F2 上限の値が整数でないとき ─────────────────────────────
  await test('F2 上限が 0 以上の整数でないときは save を呼ばず全件 held', () => {
    for (const maxDeletions of [undefined, NaN, -1, 1.5, '20']) {
      const saved = [];
      const result = deletions.applyPendingDeletions([{ url: 'https://www.nta.go.jp/a.htm' }], {
        maxDeletions,
        save: item => saved.push(item),
      });
      assert.equal(saved.length, 0, `${String(maxDeletions)}: save 0 回`);
      assert.deepEqual(Array.from(result.applied), [], `${String(maxDeletions)}: applied 0 件`);
      assert.equal(result.held.length, 1, `${String(maxDeletions)}: held 1 件`);
    }

    const savedZero = [];
    const zero = deletions.applyPendingDeletions([{ url: 'https://www.nta.go.jp/a.htm' }], {
      maxDeletions: 0,
      save: item => savedZero.push(item),
    });
    assert.equal(savedZero.length, 0, '0: save 0 回');
    assert.equal(zero.held.length, 1, '0: held 1 件');

    const savedTwenty = [];
    const twenty = deletions.applyPendingDeletions(
      Array.from({ length: 20 }, (_, i) => ({ url: `https://www.nta.go.jp/${i}.htm` })),
      { maxDeletions: 20, save: item => savedTwenty.push(item) });
    assert.equal(savedTwenty.length, 20, '20: save 20 回');
    assert.equal(twenty.applied.length, 20);
    assert.equal(twenty.held.length, 0);
  });

  // ── F3 戻ったページの行の題名 ───────────────────────────────
  await test('F3 戻ったページの行は題名の改行を空白にして 1 行に収める', () => {
    const markdown = deletions.renderReport({
      restored: [{
        type: 'shitsugi',
        title: '戻った\n題名\r\nです',
        url: 'https://www.nta.go.jp/law/shitsugi/joto/16/09.htm',
      }],
      maxDeletions: 20,
    });
    const lines = markdown.split('\n');
    const line = lines.find(l => l.startsWith('- 質疑応答事例'));
    assert.equal(line, '- 質疑応答事例 戻った 題名 です <https://www.nta.go.jp/law/shitsugi/joto/16/09.htm>');
    assert.equal(lines.some(l => l.includes('題名') && !l.startsWith('- 質疑応答事例')), false);
  });

  // ── G1 報告の行数の上限 ────────────────────────────────────
  await test('G1 報告の上限: 見出しは全件・表は 50 行・「ほか 900 件」、全件なら 500 行', () => {
    const held = Array.from({ length: 500 }, (_, i) => ({
      type: 'taxanswer',
      url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/${6000 + i}.htm`,
      title: `題名 ${i}`,
      file_path: `taxanswer/hojin/${6000 + i}.json`,
      reason: 'nta_error_page',
    }));
    const gone = Array.from({ length: 1000 }, (_, i) => `https://www.nta.go.jp/gone/${i}.htm`);
    const markdown = deletions.renderReport({ held, goneUnrecorded: gone, maxDeletions: 20 },
      { maxRows: 50 });
    assert(markdown.length < 60000, `PR 用は 60,000 字未満（実際 ${markdown.length} 字）`);
    assert(markdown.includes('## 上限を超えたため印を付けなかったもの: 500 件（上限 20 件）'));
    assert(markdown.includes('## 国税庁の一覧には載っているがページが無いもの（DB に記録なし・変更なし）: 1000 件'));
    assert(markdown.includes('ほか 450 件'));
    assert(markdown.includes('ほか 900 件'));
    assert.equal(markdown.split('\n').filter(line => line.startsWith('| タックスアンサー |')).length, 50);

    const full = deletions.renderReport({ held, goneUnrecorded: gone, maxDeletions: 20 });
    assert.equal(full.split('\n').filter(line => line.startsWith('| タックスアンサー |')).length, 500);
    assert.equal(full.includes('ほか 450 件'), false);
    assert(full.length > markdown.length);
  });

  await test('G1 CLI: --report-file は 50 行まで・--report-full-file は全件、両方を同時に書ける', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-report-both-'));
    try {
      const prFile = path.join(dir, 'pr', 'report.md');
      const fullFile = path.join(dir, 'full', 'report.md');
      const { saved, result } = await runCrawl({
        taxanswerEntries: Array.from({ length: 60 }, (_, i) => taxentry(6001 + i)),
        existing: (ref, kind) => (kind === 'taxanswer' ? existingRecord(taxentry(ref.id), kind) : null),
        argv: ['--type', 'taxanswer', '--incremental', '--skip-index', '--max-deletions', '0',
          '--report-file', prFile, '--report-full-file', fullFile],
      });
      assert.equal(saved.length, 0);
      assert.equal(result.deletion_held, 60);
      const pr = fs.readFileSync(prFile, 'utf8');
      const full = fs.readFileSync(fullFile, 'utf8');
      assert(pr.length < 60000);
      assert(pr.includes('## 上限を超えたため印を付けなかったもの: 60 件（上限 0 件）'));
      assert.equal(pr.split('\n').filter(line => line.startsWith('| タックスアンサー |')).length, 50);
      assert(pr.includes('ほか 10 件'));
      assert.equal(full.split('\n').filter(line => line.startsWith('| タックスアンサー |')).length, 60);
      assert.equal(full.includes('ほか 10 件'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── G2 上限で止めたときの案内 ──────────────────────────────
  await test('G2 上限の案内: この PR は閉じてから…（両方をマージしない）', () => {
    const markdown = deletions.renderReport({
      held: [{ type: 'taxanswer', url: 'https://www.nta.go.jp/a.htm', title: 'A', reason: 'nta_error_page' }],
      maxDeletions: 20,
    });
    assert(markdown.includes('本当に削除なら、この PR は閉じてから、Actions の『Crawl NTA Sources』を '
      + 'max_deletions に 1 以上を入れて手動で実行し直してください（両方をマージしない）。'));
  });

  // ── G4 HEAD だけで削除にしない ─────────────────────────────
  await test('G4 HEAD だけで削除にしない: 本文が取れれば保存・取れなければ失敗・無いなら削除', async () => {
    const url = taxentry('5441').url;
    const headErrorPage = async () => ({ ok: false, reason: 'nta_error_page', status: 200,
      url, finalUrl: crawler.NTA_ERROR_PAGE_URL, checkedAt: NOW });
    const withExisting = { existing: (ref, kind) => (kind === 'taxanswer'
      ? existingRecord(taxentry('5441'), 'taxanswer') : null) };

    // (1) HEAD がエラーページ＋本文が取れる → 削除の印は付かず普通に保存
    const live = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      ...withExisting,
      fetchPageHead: headErrorPage,
      fetchPage: okFetch('new-hash-5441'),
    });
    assert.equal(live.saved.length, 1);
    assert.equal(Object.hasOwn(live.saved[0].entry, 'deleted'), false);
    assert.equal(live.saved[0].entry.html_hash, 'new-hash-5441');
    // HEAD の失敗の結果は使わず、本文の取得の ETag・Last-Modified を使う
    assert.equal(live.saved[0].entry.etag, '"new-hash-5441"');
    assert.equal(live.saved[0].entry.last_modified, 'Thu, 01 Oct 2026 00:00:00 GMT');
    assert.equal(live.result.deleted, 0);
    assert.equal(live.result.errors.length, 0);

    // (2) 既存が削除済み＋本文が取れる（hash が同じ）→ 印が外れ restored に入る
    const previous = { ...existingRecord(taxentry('5441'), 'taxanswer'), deleted: true,
      deleted_reason: 'not_found', deleted_at: '2026-10-01T00:00:00Z' };
    const back = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: (ref, kind) => (kind === 'taxanswer' ? clone(previous) : null),
      fetchPageHead: headErrorPage,
      fetchPage: okFetch('hash-5441'),
    });
    assert.equal(back.saved.length, 1);
    for (const key of ['deleted', 'deleted_reason', 'deleted_at']) {
      assert.equal(Object.hasOwn(back.saved[0].entry, key), false, `${key} を残さない`);
    }
    assert.equal(back.result.restored_entries.length, 1);
    assert.equal(back.result.deleted, 0);

    // (3) HEAD がエラーページ＋本文もエラーページ → 新しい削除
    const gone = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      ...withExisting,
      fetchPageHead: headErrorPage,
      fetchPage: async () => ({ ok: false, reason: 'nta_error_page', status: 200,
        finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW }),
    });
    assert.equal(gone.saved.length, 1);
    assert.equal(gone.saved[0].entry.deleted, true);
    assert.equal(gone.saved[0].entry.deleted_reason, 'nta_error_page');
    assert.equal(gone.result.deleted, 1);

    // (4) HEAD が 404＋本文が retry_exhausted → 失敗、保存なし
    const failed = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      ...withExisting,
      fetchPageHead: async () => ({ ok: false, reason: 'not_found', status: 404, url, checkedAt: NOW }),
      fetchPage: async () => ({ ok: false, reason: 'retry_exhausted', status: 0, fetchedAt: NOW }),
    });
    assert.equal(failed.saved.length, 0);
    assert.equal(failed.result.deleted, 0);
    assert.equal(failed.result.deletion_held, 0);
    assert.equal(failed.result.errors.length, 1);
    assert.equal(failed.result.errors[0].reason, 'retry_exhausted');
  });

  // ── G6 使っている所を探すファイル ──────────────────────────
  await test('G6 findReferences: 題材の候補・出典の昇格のファイルも探す', () => {
    const root = path.join(FIXTURES, 'references-g6');
    const item = { type: 'shitsugi', url: shitsugiEntry('09').url };
    const result = deletions.findReferences([item], { root });
    assert.deepEqual(result[item.url], [
      'data/curated-source-promotions.json',
      'data/nta-shitsugi-topics-candidate.json',
    ]);
  });

  // ── G7(b) --full / --incremental の本文エラーページ ────────
  await test('G7(b) --full でも新しい削除と上限、--incremental の本文エラーページ', async () => {
    const existing = (ref, kind) => (kind === 'taxanswer'
      ? existingRecord(taxentry(ref.id), kind) : null);
    // --full（--incremental なし）で記録あり＋本文がエラーページ → 新しい削除
    const full = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing,
      argv: ['--type', 'taxanswer', '--skip-index'],
    });
    assert.equal(full.exitCode, null);
    assert.equal(full.saved.length, 1);
    assert.equal(full.saved[0].entry.deleted, true);
    assert.equal(full.result.deleted, 1);

    // --full でも上限が効く（21 件・上限 20 → 保存 0）
    const over = await runCrawl({
      taxanswerEntries: Array.from({ length: 21 }, (_, i) => taxentry(6001 + i)),
      existing,
      argv: ['--type', 'taxanswer', '--skip-index', '--max-deletions', '20'],
    });
    assert.equal(over.saved.length, 0);
    assert.equal(over.result.deleted, 0);
    assert.equal(over.result.deletion_held, 21);

    // --incremental で HEAD が通り本文がエラーページ → 新しい削除
    const incremental = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing,
      fetchPageHead: async () => ({ ok: true, checkedAt: NOW, etag: '"changed"', lastModified: 'changed' }),
      argv: ['--type', 'taxanswer', '--incremental', '--skip-index'],
    });
    assert.equal(incremental.saved.length, 1);
    assert.equal(incremental.saved[0].entry.deleted, true);
    assert.equal(incremental.result.deleted, 1);
  });

  // ── G7(c) 本文を読む部品の例外 ─────────────────────────────
  await test('G7(c) bodyArea が見つからない例外は失敗に数え、保存も削除の印もしない', async () => {
    const { saved, result, exitCode } = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: (ref, kind) => (kind === 'taxanswer' ? existingRecord(taxentry('5441'), 'taxanswer') : null),
      fetchPageHead: async () => ({ ok: true, checkedAt: NOW, etag: '"changed"', lastModified: 'changed' }),
      fetchPage: okFetch('new-hash'),
      extra: {
        'nta-parsers/taxanswer': {
          parseTaxAnswerHtml: () => { throw new Error('bodyArea が見つかりません'); },
        },
      },
    });
    assert.equal(exitCode, null);
    assert.equal(saved.length, 0);
    assert.equal(result.deleted, 0);
    assert.equal(result.deletion_held, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].reason, 'parse_failed');
    assert(result.errors[0].error.includes('bodyArea が見つかりません'));
  });

  // ── G7(e) 削除済み＋ETag 同じでも本文を取り直す ────────────
  await test('G7(e) 削除済み＋HEAD が通り ETag が同じでも本文を取り直して印を外す', async () => {
    let fetched = 0;
    const previous = { ...existingRecord(taxentry('5441'), 'taxanswer'), deleted: true,
      deleted_reason: 'nta_error_page', deleted_at: '2026-10-01T00:00:00Z' };
    const { saved, result } = await runCrawl({
      taxanswerEntries: [taxentry('5441')],
      existing: (ref, kind) => (kind === 'taxanswer' ? clone(previous) : null),
      fetchPageHead: async () => ({ ok: true, checkedAt: NOW,
        etag: previous.etag, lastModified: previous.last_modified }),
      fetchPage: async () => { fetched++; return okFetch('new-hash')(); },
    });
    assert.equal(fetched, 1, '本文を取り直す');
    assert.equal(saved.length, 1);
    for (const key of ['deleted', 'deleted_reason', 'deleted_at']) {
      assert.equal(Object.hasOwn(saved[0].entry, key), false, `${key} を残さない`);
    }
    assert.equal(result.restored_entries.length, 1);
    assert.equal(result.restored_entries[0].url, taxentry('5441').url);
  });

  // ══ 段 2: 国税庁の一覧から外れた DB の記録 ═════════════════════
  await test('V1 一覧から外れた 2 件＋HEAD・本文ともエラーページ → 削除の印と報告', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-unlisted-v1-'));
    try {
      const reportFile = path.join(dir, 'report.md');
      const listed = [taEntry('gensen', '1001'), taEntry('shohi', '1001')];
      const records = {
        'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed-gensen"' }),
        'taxanswer/shohi/1001': taRecord('shohi', '1001', { etag: '"listed-shohi"' }),
        'taxanswer/gensen/2882': taRecord('gensen', '2882'),
        'taxanswer/shohi/6555': taRecord('shohi', '6555'),
      };
      const { saved, result } = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882'),
          taKey('shohi', '1001'), taKey('shohi', '6555')],
        existing: loadRecords(records),
        fetchPageHead: routed(goneHead, {
          [listed[0].url]: aliveHead('"listed-gensen"'),
          [listed[1].url]: aliveHead('"listed-shohi"'),
        }),
        fetchPage: routed(goneGet),
        argv: ['--type', 'all', '--incremental', '--skip-index', '--report-file', reportFile],
      });

      const deleted = saved.filter(item => item.entry.deleted === true);
      assert.equal(deleted.length, 2);
      for (const [category, id] of [['gensen', '2882'], ['shohi', '6555']]) {
        const entry = deleted.find(item => item.entry.id === id).entry;
        assert.deepEqual(entry, {
          ...records[`taxanswer/${category}/${id}`],
          deleted: true, deleted_reason: 'nta_error_page', deleted_at: NOW, last_checked_at: NOW,
        }, `${category}/${id}: 4 項目だけが違う`);
      }
      assert.equal(result.unlisted_check, 'done');
      assert.equal(result.unlisted_check_limit, 100);
      assert.equal(result.unlisted, 2);
      assert.deepEqual(Array.from(result.unlisted_entries, entry => entry.outcome), ['deleted', 'deleted']);
      assert.equal(result.deleted_entries.length, 2);
      assert(result.deleted_entries.every(entry => entry.unlisted === true), 'deleted_entries に unlisted');
      assert.equal(result.deleted_entries.every(entry => entry.file_path), true);

      const markdown = fs.readFileSync(reportFile, 'utf8');
      assert(markdown.includes('## 国税庁の一覧から外れた DB の記録: 2 件'));
      assert(markdown.includes('（国税庁の一覧からも外れている）'));
      const rows = markdown.split('\n').filter(line => line.startsWith('| タックスアンサー |')
        && line.includes('新しく削除済みにした'));
      assert.equal(rows.length, 2);
      assert(rows.some(row => row.includes('No.2882')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('V2 一覧から外れた記録＋転送なしの 404・410 → 削除の印（U1）', async () => {
    for (const status of [404, 410]) {
      const listed = [taEntry('gensen', '1001')];
      const records = {
        'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
        'taxanswer/gensen/2882': taRecord('gensen', '2882'),
      };
      const { saved, result } = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
        existing: loadRecords(records),
        fetchPageHead: routed(url => ({ ok: false, reason: 'not_found', status, checkedAt: NOW }),
          { [listed[0].url]: aliveHead('"listed"') }),
        fetchPage: routed(() => ({ ok: false, reason: 'not_found', status, fetchedAt: NOW })),
      });
      const entry = saved.find(item => item.entry.id === '2882');
      assert(entry, `${status}: 削除の印を付けて保存する`);
      assert.equal(entry.entry.deleted, true);
      assert.equal(entry.entry.deleted_reason, 'not_found');
      assert.equal(result.unlisted_entries[0].outcome, 'deleted');
    }
  });

  await test('V3 一覧から外れた記録＋HEAD はエラーページでも本文が取れる → 削除にしない', async () => {
    const listed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': taRecord('gensen', '2882'),
    };
    const { saved, result } = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
      existing: loadRecords(records),
      fetchPageHead: routed(goneHead, { [listed[0].url]: aliveHead('"listed"') }),
      fetchPage: routed(okFetch('new-hash-2882')),
    });
    assert.equal(saved.some(item => item.entry.deleted === true), false);
    assert.equal(result.unlisted_entries[0].outcome, 'alive_updated');
    assert.equal(result.unlisted_entries[0].url, records['taxanswer/gensen/2882'].url);
  });

  await test('V4 一覧から外れた記録＋段 1 の S2 の失敗 → 印なし・保存なし・errors（U2）', async () => {
    const cases = [
      { reason: 'retry_exhausted', status: 0 },
      { reason: 'http_error', status: 403 },
      { reason: 'mojibake_detected', status: 200 },
      { reason: 'parse_failed', status: 200 },
      { reason: 'http_error', status: 404 },
    ];
    for (const failure of cases) {
      const listed = [taEntry('gensen', '1001')];
      const records = {
        'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
        'taxanswer/gensen/2882': taRecord('gensen', '2882'),
      };
      const before = clone(records);
      const { saved, result } = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
        existing: loadRecords(records),
        fetchPageHead: routed(changedHead, { [listed[0].url]: aliveHead('"listed"') }),
        fetchPage: routed(() => ({ ok: false, reason: failure.reason, status: failure.status, fetchedAt: NOW })),
      });
      const label = `${failure.reason}/${failure.status}`;
      assert.equal(saved.some(item => item.entry.id === '2882'), false, `${label}: 保存しない`);
      assert.equal(result.deleted, 0, `${label}: 削除にしない`);
      assert.equal(result.errors.length, 1, `${label}: errors に数える`);
      assert.equal(result.errors[0].reason, failure.reason);
      const entry = result.unlisted_entries.find(item => item.url === records['taxanswer/gensen/2882'].url);
      assert.equal(entry.outcome, 'error', `${label}: error`);
      assert.equal(entry.reason, failure.reason, `${label}: 理由付き`);
      assert.deepEqual(records, before, `${label}: 記録は変えない`);
    }
  });

  await test('V5 上限: 一覧にある 15 件＋一覧から外れた 6 件・上限 20（U3）', async () => {
    const build = nListed => {
      const listed = Array.from({ length: nListed }, (_, i) => taEntry('gensen', String(1001 + i)));
      const unlistedIds = ['2882', '2883', '2884', '2885', '2886', '2887'];
      const records = {};
      for (const entry of listed) records[`taxanswer/gensen/${entry.id}`] = taRecord('gensen', entry.id);
      for (const id of unlistedIds) records[`taxanswer/gensen/${id}`] = taRecord('gensen', id);
      return {
        taxanswerEntries: listed,
        recordKeys: [...listed.map(entry => taKey('gensen', entry.id)),
          ...unlistedIds.map(id => taKey('gensen', id))],
        existing: loadRecords(records),
      };
    };

    const over = await runCrawl({
      type: 'all', ...build(15), fetchPageHead: routed(goneHead), fetchPage: routed(goneGet),
      argv: ['--type', 'all', '--incremental', '--skip-index', '--max-deletions', '20'],
    });
    assert.equal(over.saved.length, 0, '21 件・上限 20 は保存 0');
    assert.equal(over.result.deleted, 0);
    assert.equal(over.result.deletion_held, 21);
    assert.equal(over.result.deletion_held_entries.length, 21);
    const heldUnlisted = over.result.unlisted_entries.filter(entry => entry.outcome === 'held');
    assert.equal(heldUnlisted.length, 6);
    assert.equal(over.result.deletion_held_entries.filter(entry => entry.unlisted === true).length, 6);

    const exact = await runCrawl({
      type: 'all', ...build(14), fetchPageHead: routed(goneHead), fetchPage: routed(goneGet),
      argv: ['--type', 'all', '--incremental', '--skip-index', '--max-deletions', '20'],
    });
    assert.equal(exact.result.deleted, 20, '合わせて 20 件は保存する');
    assert.equal(exact.result.deletion_held, 0);
    assert.equal(exact.saved.length, 20);

    const zeroListed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': taRecord('gensen', '2882'),
    };
    const zero = await runCrawl({
      type: 'all',
      taxanswerEntries: zeroListed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
      existing: loadRecords(records),
      fetchPageHead: routed(goneHead, { [zeroListed[0].url]: aliveHead('"listed"') }),
      fetchPage: routed(goneGet),
      argv: ['--type', 'all', '--incremental', '--skip-index', '--max-deletions', '0'],
    });
    assert.equal(zero.result.deleted, 0);
    assert.equal(zero.result.deletion_held, 1);
    assert.equal(zero.result.unlisted_entries[0].outcome, 'held');
    assert.equal(zero.saved.some(item => item.entry.deleted === true), false);
  });

  await test('V6 U4: 絞り込み・--dry-run では一覧から外れた記録を訪ねない', async () => {
    const cases = [
      { argv: ['--type', 'taxanswer', '--incremental', '--skip-index'], keys: [taKey('gensen', '2882')], urls: [taEntry('gensen', '2882').url], check: 'skipped_filter' },
      { argv: ['--type', 'shitsugi', '--incremental', '--skip-index'], keys: [shitsugiKey('joto', '16', '01')], urls: ['https://www.nta.go.jp/law/shitsugi/joto/16/01.htm'], check: 'skipped_filter' },
      { argv: ['--type', 'all', '--category', 'hojin', '--incremental', '--skip-index'], keys: [taKey('hojin', '2882')], urls: [taEntry('hojin', '2882').url], check: 'skipped_filter' },
      { argv: ['--type', 'all', '--max-pages', '5', '--incremental', '--skip-index'], keys: [taKey('gensen', '2882')], urls: [taEntry('gensen', '2882').url], check: 'skipped_filter' },
      { argv: ['--type', 'all', '--dry-run'], keys: [taKey('gensen', '2882')], urls: [taEntry('gensen', '2882').url], check: 'skipped_dry_run' },
    ];
    for (const item of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-unlisted-v6-'));
      try {
        const reportFile = path.join(dir, 'report.md');
        const visited = [];
        const { result, saved } = await runCrawl({
          type: 'all',
          recordKeys: item.keys,
          taxanswerEntries: [taEntry('gensen', '1001')],
          existing: () => null,
          fetchPage: async url => { visited.push(url); return { ok: false, reason: 'nta_error_page', status: 200, finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW }; },
          fetchPageHead: async url => { visited.push(url); return goneHead(); },
          argv: [...item.argv, '--report-file', reportFile],
        });
        assert.equal(result.unlisted_check, item.check, item.argv.join(' '));
        for (const url of item.urls) assert.equal(visited.includes(url), false, `${item.argv.join(' ')}: ${url} を訪ねない`);
        assert.equal(saved.some(entry => entry.entry.deleted === true), false);
        const markdown = fs.readFileSync(reportFile, 'utf8');
        assert(markdown.includes(item.check === 'skipped_dry_run'
          ? '--dry-run のため確かめていません'
          : '絞り込み（--type・--category・--max-pages）があるため確かめていません'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  await test('V7 U5: 一覧が 1 件も取れなかった分類の記録は訪ねない', async () => {
    // 質疑応答: 一覧は shohi だけ。joto の記録は category_unlisted。
    const shitsugiListed = [{ id: '01', section: '02', category: 'shohi', url: 'https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm', label: '一覧' }];
    const shitsugiRecords = {
      'shitsugi/shohi/02/01': shitsugiRecord('shohi', '02', '01', { etag: '"listed"' }),
      'shitsugi/joto/16/01': shitsugiRecord('joto', '16', '01'),
      'shitsugi/shohi/02/02': shitsugiRecord('shohi', '02', '02'),
    };
    const visited = [];
    const shitsugiRun = await runCrawl({
      type: 'all',
      shitsugiEntries: shitsugiListed,
      recordKeys: [shitsugiKey('shohi', '02', '01'), shitsugiKey('joto', '16', '01'), shitsugiKey('shohi', '02', '02')],
      existing: loadRecords(shitsugiRecords),
      fetchPage: async url => { visited.push(url); return goneGet(); },
      fetchPageHead: async url => {
        visited.push(url);
        return url === shitsugiListed[0].url ? aliveHead('"listed"')() : goneHead();
      },
    });
    const joto = shitsugiRun.result.unlisted_entries.find(entry => entry.file_path === 'shitsugi/joto/16/01.json');
    assert.equal(joto.outcome, 'category_unlisted');
    assert.equal(visited.includes(shitsugiRecords['shitsugi/joto/16/01'].url), false, 'joto は訪ねない');
    const shohi = shitsugiRun.result.unlisted_entries.find(entry => entry.file_path === 'shitsugi/shohi/02/02.json');
    assert.equal(shohi.outcome, 'deleted', '一覧に項目のある分類は訪ねる');

    // タックスアンサー: 一覧は gensen だけ。shohi の記録は category_unlisted。
    const taxListed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': taRecord('gensen', '2882'),
      'taxanswer/shohi/6555': taRecord('shohi', '6555'),
    };
    const visited2 = [];
    const taxRun = await runCrawl({
      type: 'all',
      taxanswerEntries: taxListed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882'), taKey('shohi', '6555')],
      existing: loadRecords(records),
      fetchPage: async url => { visited2.push(url); return goneGet(); },
      fetchPageHead: async url => {
        visited2.push(url);
        return url === taxListed[0].url ? aliveHead('"listed"')() : goneHead();
      },
    });
    const shohiTax = taxRun.result.unlisted_entries.find(entry => entry.file_path === 'taxanswer/shohi/6555.json');
    assert.equal(shohiTax.outcome, 'category_unlisted');
    assert.equal(visited2.includes(records['taxanswer/shohi/6555'].url), false, 'shohi は訪ねない');
    const gensen = taxRun.result.unlisted_entries.find(entry => entry.file_path === 'taxanswer/gensen/2882.json');
    assert.equal(gensen.outcome, 'deleted');
  });

  await test('V8 U6: 訪ねる対象 101 件は一件も訪ねず、100 件ちょうどは訪ねる', async () => {
    const listed = [taEntry('gensen', '1001')];
    const buildKeys = count => {
      const ids = Array.from({ length: count }, (_, i) => String(3000 + i));
      const records = { 'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }) };
      for (const id of ids) records[`taxanswer/gensen/${id}`] = taRecord('gensen', id);
      return { ids, records };
    };

    const many = buildKeys(101);
    const manyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-unlisted-v8-'));
    try {
      const manyRun = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001'), ...many.ids.map(id => taKey('gensen', id))],
        existing: loadRecords(many.records),
        fetchPage: routed(goneGet),
        fetchPageHead: routed(goneHead, { [listed[0].url]: aliveHead('"listed"') }),
        argv: ['--type', 'all', '--incremental', '--skip-index', '--report-file', path.join(manyDir, 'report.md')],
      });
      assert.equal(manyRun.result.unlisted_check, 'skipped_too_many');
      assert.equal(manyRun.result.unlisted_entries.length, 101);
      assert.equal(manyRun.result.unlisted_entries.every(entry => entry.outcome === 'not_checked'), true);
      assert.equal(manyRun.saved.length, 1, '一覧にある記録だけを保存する（skip の 1 件）');
      const markdown = fs.readFileSync(path.join(manyDir, 'report.md'), 'utf8');
      assert(markdown.includes('上限（100 件）を超えた'));
    } finally {
      fs.rmSync(manyDir, { recursive: true, force: true });
    }

    const exact = buildKeys(100);
    const exactRun = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [
        taKey('gensen', '1001'),
        ...exact.ids.map(id => taKey('gensen', id)),
        taKey('gensen', '4001'), // 記録なし（U8）
        taKey('gensen', '4002'), // 前から削除済み（U7）
      ],
      existing: loadRecords({
        ...exact.records,
        'taxanswer/gensen/4002': { ...taRecord('gensen', '4002'), deleted: true, deleted_at: '2026-10-01T00:00:00Z' },
      }),
      fetchPage: routed(goneGet),
      fetchPageHead: routed(goneHead, { [listed[0].url]: aliveHead('"listed"') }),
      argv: ['--type', 'all', '--incremental', '--skip-index'],
    });
    assert.equal(exactRun.result.unlisted_check, 'done');
    assert.equal(exactRun.result.unlisted_entries.filter(entry => entry.outcome === 'not_checked').length, 0);
    assert.equal(exactRun.result.unlisted_entries.filter(entry => entry.outcome === 'invalid_record').length, 1);
    assert.equal(exactRun.result.unlisted_entries.filter(entry => entry.outcome === 'deleted_before').length, 1);
    assert.equal(exactRun.result.unlisted_entries.filter(entry => entry.outcome === 'deleted' || entry.outcome === 'held').length, 100);
  });

  await test('V9 U7: 前から削除済みで一覧にも無い記録は訪ねない（deleted_before）', async () => {
    const listed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': taRecord('gensen', '2882', {
        deleted: true, deleted_reason: 'nta_error_page', deleted_at: '2026-10-01T00:00:00Z',
      }),
    };
    const visited = [];
    const { result, saved } = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
      existing: loadRecords(records),
      fetchPage: async url => { visited.push(url); return goneGet(); },
      fetchPageHead: async url => {
        visited.push(url);
        return url === listed[0].url ? aliveHead('"listed"')() : goneHead();
      },
    });
    assert.equal(visited.includes(records['taxanswer/gensen/2882'].url), false, '訪ねない');
    assert.equal(saved.some(item => item.entry.id === '2882'), false, '記録は変えない');
    assert.equal(result.unlisted_entries.find(entry => entry.file_path === 'taxanswer/gensen/2882.json').outcome,
      'deleted_before');
    assert.equal(result.deleted_still, 0);
  });

  await test('V10 U8: URL が正しくない・記録が読めない記録は訪ねない（invalid_record）', async () => {
    const listed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2001': (() => { const r = taRecord('gensen', '2001'); delete r.url; return r; })(),
      'taxanswer/gensen/2002': taRecord('gensen', '2002', { url: 'http://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2002.htm' }),
      'taxanswer/gensen/2003': taRecord('gensen', '2003', { url: 'https://www.nta.go.jp.example.com/taxes/shiraberu/taxanswer/gensen/2003.htm' }),
      'taxanswer/gensen/2004': taRecord('gensen', '2004', { url: taEntry('gensen', '9999').url }),
      // gensen/2005 は記録なし（読めない）
    };
    const visited = [];
    const { result } = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [
        taKey('gensen', '1001'),
        taKey('gensen', '2001'), taKey('gensen', '2002'), taKey('gensen', '2003'),
        taKey('gensen', '2004'), taKey('gensen', '2005'),
      ],
      existing: loadRecords(records),
      fetchPage: async url => { visited.push(url); return goneGet(); },
      fetchPageHead: async url => {
        visited.push(url);
        return url === listed[0].url ? aliveHead('"listed"')() : goneHead();
      },
    });
    const invalid = result.unlisted_entries.filter(entry => entry.outcome === 'invalid_record');
    assert.equal(invalid.length, 5);
    for (const entry of invalid) assert.equal(visited.includes(entry.url), false, `${entry.file_path} は訪ねない`);
    assert.equal(visited.includes(taEntry('gensen', '9999').url), false);
  });

  await test('V11 U9: 本文は取れたが国税庁の別のページへ転送 → 保存しない（errors にも入れない）', async () => {
    const listed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': taRecord('gensen', '2882'),
    };
    const elsewhere = 'https://www.nta.go.jp/law/shitsugi/joto/16/09.htm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-unlisted-v11-'));
    try {
      const run = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
        existing: loadRecords(records),
        fetchPageHead: routed(changedHead, { [listed[0].url]: aliveHead('"listed"') }),
        fetchPage: routed(okFetch('new-hash', { redirected: true, finalUrl: elsewhere })),
        argv: ['--type', 'all', '--incremental', '--skip-index', '--report-file', path.join(dir, 'report.md')],
      });
      assert.equal(run.saved.some(item => item.entry.id === '2882'), false, '保存しない');
      assert.equal(run.result.errors.length, 0, 'errors に入れない');
      assert.equal(run.result.unlisted_entries[0].outcome, 'redirected_elsewhere');
      assert.equal(run.result.unlisted_entries[0].final_url, elsewhere);
      const markdown = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
      assert(markdown.includes(elsewhere));
      assert(markdown.includes('国税庁の別のページへ転送（記録は変えない）'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // 転送されても行き先が記録の url と同じなら、今までどおり保存する。
    const same = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
      existing: loadRecords(records),
      fetchPageHead: routed(changedHead, { [listed[0].url]: aliveHead('"listed"') }),
      fetchPage: routed(okFetch('new-hash', { redirected: true, finalUrl: records['taxanswer/gensen/2882'].url })),
    });
    assert(same.saved.some(item => item.entry.id === '2882'), '同じ url なら保存する');
    assert.equal(same.result.unlisted_entries[0].outcome, 'alive_updated');
  });

  await test('V12 U10: 変わっていなければ last_checked_at だけ、変わっていれば中身を更新', async () => {
    const listed = [taEntry('gensen', '1001')];
    const record = taRecord('gensen', '2882');
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': record,
    };
    const unchanged = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
      existing: loadRecords(records),
      fetchPageHead: routed(changedHead, {
        [listed[0].url]: aliveHead('"listed"'),
        [record.url]: aliveHead(record.etag),
      }),
      fetchPage: routed(okFetch('unused')),
    });
    const kept = unchanged.saved.find(item => item.entry.id === '2882').entry;
    assert.deepEqual(kept, { ...record, last_checked_at: NOW }, 'last_checked_at だけが違う');
    assert.equal(unchanged.result.unlisted_entries[0].outcome, 'alive_unchanged');
    assert.equal(unchanged.result.fetched, 0);

    const updated = await runCrawl({
      type: 'all',
      taxanswerEntries: listed,
      recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
      existing: loadRecords(records),
      fetchPageHead: routed(changedHead, {
        [listed[0].url]: aliveHead('"listed"'),
        [record.url]: changedHead(),
      }),
      fetchPage: routed(okFetch('new-hash-2882', { redirected: false, finalUrl: record.url })),
    });
    const changed = updated.saved.find(item => item.entry.id === '2882').entry;
    assert.equal(changed.html_hash, 'new-hash-2882');
    assert.equal(updated.result.unlisted_entries[0].outcome, 'alive_updated');
    assert.equal(updated.result.fetched, 1);
  });

  await test('V13 U12: 一覧にある記録は新しい節に出ず、同じ URL を 2 度訪ねない', async () => {
    const listed = [taEntry('gensen', '1001')];
    const records = {
      'taxanswer/gensen/1001': taRecord('gensen', '1001', { etag: '"listed"' }),
      'taxanswer/gensen/2882': taRecord('gensen', '2882'),
    };
    const headCalls = [];
    const getCalls = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-unlisted-v13-'));
    try {
      const reportFile = path.join(dir, 'report.md');
      const { result } = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001'), taKey('gensen', '2882')],
        existing: loadRecords(records),
        fetchPageHead: async url => {
          headCalls.push(url);
          return url === listed[0].url ? aliveHead('"listed"')() : goneHead();
        },
        fetchPage: async url => { getCalls.push(url); return goneGet(); },
        argv: ['--type', 'all', '--incremental', '--skip-index', '--report-file', reportFile],
      });
      for (const calls of [headCalls, getCalls]) {
        for (const url of new Set(calls)) {
          assert.equal(calls.filter(value => value === url).length, 1, `${url} は 1 回まで`);
        }
      }
      assert.equal(result.unlisted_entries.length, 1);
      assert.equal(result.unlisted_entries[0].file_path, 'taxanswer/gensen/2882.json');
      const markdown = fs.readFileSync(reportFile, 'utf8');
      const section = markdown.slice(markdown.indexOf('## 国税庁の一覧から外れた DB の記録'));
      assert.equal(section.includes(listed[0].url), false, '一覧にある記録は節に出さない');

      // 一覧から外れた記録が 0 件なら、新しい節は「なし」。
      const none = await runCrawl({
        type: 'all',
        taxanswerEntries: listed,
        recordKeys: [taKey('gensen', '1001')],
        existing: loadRecords({ 'taxanswer/gensen/1001': records['taxanswer/gensen/1001'] }),
        fetchPageHead: routed(goneHead, { [listed[0].url]: aliveHead('"listed"') }),
        argv: ['--type', 'all', '--incremental', '--skip-index', '--report-file', path.join(dir, 'none.md')],
      });
      const noneMarkdown = fs.readFileSync(path.join(dir, 'none.md'), 'utf8');
      assert(noneMarkdown.includes('## 国税庁の一覧から外れた DB の記録: 0 件'));
      assert(noneMarkdown.slice(noneMarkdown.indexOf('## 国税庁の一覧から外れた DB の記録')).includes('なし'));
      assert.equal(none.result.deleted, 0);
      assert.equal(none.result.unlisted_check, 'done');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('V14 listRecordKeys: 置き場所の形だけを file_path の順で返す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-list-records-'));
    try {
      const write = relative => {
        const file = path.join(dir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}');
      };
      for (const relative of [
        'taxanswer/gensen/2882.json',
        'shitsugi/joto/16/01.json',
        'images/x.json',
        'index.json',
        'meta.json',
        'token-df.json',
        'taxanswer/gensen/1.json.tmp',
        'taxanswer/gensen/sub/2.json',
        'shitsugi/joto/3.json',
        'taxanswer/x.json',
      ]) write(relative);
      assert.deepEqual(store.listRecordKeys(dir), [
        { type: 'shitsugi', category: 'joto', section: '16', id: '01', file_path: 'shitsugi/joto/16/01.json' },
        { type: 'taxanswer', category: 'gensen', id: '2882', file_path: 'taxanswer/gensen/2882.json' },
      ]);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-list-empty-'));
      try {
        assert.deepEqual(store.listRecordKeys(empty), []);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('V15 fetchPage: 転送の有無と最後の URL を返す', async () => {
    const url = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm';
    await withFakeFetch(() => fakeResponse({ status: 200, url, redirected: false }), async () => {
      const result = await crawler.fetchPage(url, { maxRetries: 0 });
      assert.equal(result.ok, true);
      assert.equal(result.redirected, false);
      assert.equal(result.finalUrl, url);
    });
    const destination = 'https://www.nta.go.jp/law/shitsugi/joto/16/09.htm';
    await withFakeFetch(() => fakeResponse({ status: 200, url: destination, redirected: true }), async () => {
      const result = await crawler.fetchPage(url, { maxRetries: 0 });
      assert.equal(result.ok, true);
      assert.equal(result.redirected, true);
      assert.equal(result.finalUrl, destination);
    });
    await withFakeFetch(() => fakeResponse({ status: 200, url: crawler.NTA_ERROR_PAGE_URL, redirected: true }), async () => {
      const result = await crawler.fetchPage(url, { maxRetries: 0 });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'nta_error_page');
      assert.equal(result.finalUrl, crawler.NTA_ERROR_PAGE_URL);
    });
  });

  await test('V16 saveMeta: 一覧から外れた記録の項目を書く（渡さない呼び出しは今のまま）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-meta-unlisted-'));
    try {
      const file = path.join(dir, 'meta.json');
      indexBuilder.saveMeta({
        startedAt: '2026-11-17T00:00:00Z',
        finishedAt: '2026-11-17T00:01:00Z',
        results: { fetched: 1, skipped: 0, deleted: 1, unlisted: 2, errors: [] },
        byType: {},
        maxDeletions: 20,
        deletedEntries: [{ type: 'taxanswer', url: 'https://a', title: 'A', file_path: 'a', reason: 'nta_error_page', unlisted: true }],
        unlistedEntries: [
          { type: 'shitsugi', url: 'https://b', title: 'B', file_path: 'b', outcome: 'deleted_before' },
          { type: 'taxanswer', url: 'https://a', title: 'A', file_path: 'a', outcome: 'deleted' },
        ],
        unlistedCheck: 'done',
        unlistedCheckLimit: 100,
        metaFile: file,
      });
      const meta = readJson(file);
      assert.equal(meta.crawl_results.unlisted, 2);
      assert.equal(meta.unlisted_check, 'done');
      assert.equal(meta.unlisted_check_limit, 100);
      assert.deepEqual(meta.unlisted_entries.map(entry => entry.url), ['https://a', 'https://b']);
      assert.equal(meta.total_entries_processed, 2, '数え方は変えない');
      assert.equal(meta.deleted_entries[0].unlisted, true);

      const minimal = path.join(dir, 'minimal.json');
      indexBuilder.saveMeta({ startedAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:00Z',
        results: { fetched: 0 }, metaFile: minimal });
      const minimalMeta = readJson(minimal);
      // 【要判断】T13 の deepEqual を壊さないよう、一覧から外れた記録を渡さない
      // 呼び出しでは crawl_results.unlisted を足さない（ほかの項目は今のまま）。
      assert.equal(minimalMeta.crawl_results.unlisted, undefined);
      assert.equal(minimalMeta.unlisted_check, null);
      assert.equal(minimalMeta.unlisted_check_limit, null);
      assert.deepEqual(minimalMeta.unlisted_entries, []);
      assert.equal(minimalMeta.crawl_results.deleted, 0);
      assert.equal(minimalMeta.total_entries_processed, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('V17 報告: 一覧から外れた記録の節のラベル・行き先・理由・| と改行・上限', () => {
    const entries = [
      { type: 'taxanswer', url: 'https://www.nta.go.jp/a.htm', title: '題名|に\n改行', file_path: 'a', outcome: 'deleted' },
      { type: 'taxanswer', url: 'https://www.nta.go.jp/b.htm', title: 'B', file_path: 'b', outcome: 'held' },
      { type: 'taxanswer', url: 'https://www.nta.go.jp/c.htm', title: 'C', file_path: 'c', outcome: 'alive_updated' },
      { type: 'shitsugi', url: 'https://www.nta.go.jp/d.htm', title: 'D', file_path: 'd', outcome: 'alive_unchanged' },
      { type: 'taxanswer', url: 'https://www.nta.go.jp/e.htm', title: 'E', file_path: 'e', outcome: 'redirected_elsewhere', final_url: 'https://www.nta.go.jp/law/x.htm' },
      { type: 'taxanswer', url: 'https://www.nta.go.jp/f.htm', title: 'F', file_path: 'f', outcome: 'error', reason: 'http_error' },
      { type: 'taxanswer', url: 'https://www.nta.go.jp/g.htm', title: 'G', file_path: 'g', outcome: 'deleted_before' },
      { type: 'taxanswer', url: 'https://www.nta.go.jp/h.htm', title: 'H', file_path: 'h', outcome: 'invalid_record' },
      { type: 'shitsugi', url: 'https://www.nta.go.jp/i.htm', title: 'I', file_path: 'i', outcome: 'category_unlisted' },
    ];
    const markdown = deletions.renderReport({ unlisted: entries, unlistedCheck: 'done', unlistedLimit: 100 });
    assert(markdown.includes('## 国税庁の一覧から外れた DB の記録: 9 件'));
    assert(markdown.includes('| タックスアンサー | No.a 題名\\|に 改行 |'));
    assert(markdown.includes('新しく削除済みにした'));
    assert(markdown.includes('上限を超えたため印を付けなかった'));
    assert(markdown.includes('ページはある（中身を更新）'));
    assert(markdown.includes('ページはある（変わっていない）'));
    assert(markdown.includes('国税庁の別のページへ転送（記録は変えない）: https://www.nta.go.jp/law/x.htm'));
    assert(markdown.includes('取れなかった（HTTP エラー、記録は変えない）'));
    assert(markdown.includes('前から削除済み（訪ねない）'));
    assert(markdown.includes('記録が読めない・URL が正しくない（訪ねない）'));
    assert(markdown.includes('国税庁の一覧でこの分類が 1 件も取れなかった（訪ねない）'));

    const limited = deletions.renderReport({ unlisted: entries, unlistedCheck: 'done', unlistedLimit: 100 },
      { maxRows: 2 });
    assert(limited.includes('## 国税庁の一覧から外れた DB の記録: 9 件'), '見出しは丸めない');
    assert(limited.includes('ほか 7 件'));
    assert(limited.includes('`unlisted_entries`'));
    assert.equal(limited.split('\n').filter(line => line.startsWith('| タックスアンサー |')).length, 2);

    const empty = deletions.renderReport({ unlisted: [], unlistedCheck: 'done' });
    assert(empty.slice(empty.indexOf('## 国税庁の一覧から外れた DB の記録')).includes('なし'));

    for (const [check, message] of [
      ['skipped_filter', '絞り込み（--type・--category・--max-pages）があるため確かめていません'],
      ['skipped_dry_run', '--dry-run のため確かめていません'],
    ]) {
      const text = deletions.renderReport({ unlisted: [], unlistedCheck: check });
      assert(text.includes(message), check);
    }
    const tooMany = deletions.renderReport({
      unlisted: Array.from({ length: 3 }, (_, i) => ({
        type: 'taxanswer', url: `https://www.nta.go.jp/${i}.htm`, title: `T${i}`, file_path: `f${i}`, outcome: 'not_checked',
      })),
      unlistedCheck: 'skipped_too_many',
      unlistedLimit: 100,
    });
    assert(tooMany.includes('訪ねる対象が 3 件あり、上限（100 件）を超えたため一件も訪ねていません。'));
    assert(tooMany.includes('国税庁の一覧の取得・読み取りの不具合を疑ってください'));
  });

  await test('V18 U11: V1〜V12 の実行でファイルを消す部品を一度も呼ばない', () => {
    assert.deepEqual(removalCalls, [], 'unlinkSync・rmSync・rmdirSync を呼ばない');
  });

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
