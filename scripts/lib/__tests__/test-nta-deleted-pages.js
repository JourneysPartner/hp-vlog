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

function baseDependencies({ saved = [], existing = () => null, fetchPage, fetchPageHead,
  taxanswerEntries = [], shitsugiEntries = [], extra = {} } = {}) {
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
    fs,
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

  // ── T3 似て非なる行き先 ─────────────────────────────────────
  await test('T3 S3 の似て非なる行き先は nta_error_page にしない', async () => {
    assert.equal(nearMisses.errorPageUrl, crawler.NTA_ERROR_PAGE_URL);
    for (const url of nearMisses.nearMisses) {
      await withFakeFetch(() => fakeResponse({ status: 200, url, redirected: true }), async () => {
        const result = await crawler.fetchWithRetry('https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm', { maxRetries: 0 });
        assert.equal(result.ok, true, url);
        assert.notEqual(result.reason, 'nta_error_page', url);
      });
    }
    // 転送されていない応答は、行き先がエラーページでも削除にしない。
    await withFakeFetch(
      () => fakeResponse({ status: 200, url: crawler.NTA_ERROR_PAGE_URL, redirected: false }),
      async () => {
        const result = await crawler.fetchWithRetry('https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5441.htm', { maxRetries: 0 });
        assert.equal(result.ok, true);
      });
    // 国税庁の別のページへの転送は削除にしない。
    await withFakeFetch(
      () => fakeResponse({ status: 200, url: 'https://www.nta.go.jp/law/shitsugi/joto/16/09.htm', redirected: true }),
      async () => {
        const result = await crawler.fetchWithRetry('https://www.nta.go.jp/law/shitsugi/joto/16/09.htm', { maxRetries: 0 });
        assert.equal(result.ok, true);
        assert.notEqual(result.reason, 'nta_error_page');
      });
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

  // ── T15 --backfill-figures ─────────────────────────────────
  await test('T15 --backfill-figures: エラーページへ転送されたら記録を書き換えない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-backfill-deleted-'));
    try {
      const sources = path.join(dir, 'nta-sources');
      const recordDir = path.join(sources, 'taxanswer/hojin');
      fs.mkdirSync(recordDir, { recursive: true });
      const file = path.join(recordDir, '5441.json');
      fs.writeFileSync(file, JSON.stringify(existing5441), 'utf8');
      const before = fs.readFileSync(file, 'utf8');
      const dependencies = baseDependencies({
        fetchPage: async () => ({ ok: false, reason: 'nta_error_page', status: 200,
          finalUrl: crawler.NTA_ERROR_PAGE_URL, fetchedAt: NOW }),
        extra: {
          'nta-store': {
            NTA_SOURCES_DIR: sources,
            readJson: target => JSON.parse(fs.readFileSync(target, 'utf8')),
            writeJsonAtomic: () => { throw new Error('記録を書き換えてはいけません'); },
          },
        },
      });
      const { exitCode } = await runCli({ argv: ['--backfill-figures'], dependencies });
      assert.equal(exitCode, null);
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

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
