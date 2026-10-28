'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { detectContentChange, substantiveBody } = require('../nta-content-change');
const { backfill } = require('../../backfill-nta-content-changed');
const indexBuilder = require('../nta-index-builder');
const freshness = require('../freshness-candidates');
const refresh = require('../freshness-refresh');
const { renderPage } = require('../../../netlify/functions/admin-freshness-page');

const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURES = path.join(ROOT, 'docs/codex-tasks/freshness-as-of/fixtures');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const old2200 = readJson(path.join(FIXTURES, 'ta-2200-r7.json'));
const new2200 = readJson(path.join(FIXTURES, 'ta-2200-r8.json'));
const fetchedAt = '2026-10-01T20:00:00Z';
const priorDate = '2026-09-01T00:00:00Z';
const historyOf = entry => [entry.content_changed_at, entry.content_change_kind, entry.as_of_changed_at];
let passed = 0;
let failed = 0;

async function test(name, run) {
  try { await run(); passed++; console.log(`  PASS: ${name}`); }
  catch (error) { failed++; console.error(`  FAIL: ${name}\n${error.stack}`); }
}

async function crawlWithFigures(type, previous, images) {
  const filename = path.join(ROOT, 'scripts/crawl-nta-sources.js');
  const saved = [];
  const parsed = { id: '01', type, title: '図のある資料', tax_category_code: 'shohi', section: '02',
    url: type === 'taxanswer' ? new2200.url : 'https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm',
    body: '本文は同じ。', law_version: new2200.law_version };
  const target = { id: parsed.id, category: 'shohi', section: '02', url: parsed.url };
  const save = entry => saved.push(JSON.parse(JSON.stringify(entry)));
  const dependencies = {
    'nta-crawler': {
      RateLimiter: class { async wait() {} },
      fetchPageHead: async () => ({ checkedAt: fetchedAt }),
      decideIncrementalAction: () => ({ decision: 'fetch' }),
      fetchPage: async () => ({ ok: true, html: '<html>図のある資料</html>', htmlHash: 'new-hash', fetchedAt }),
    },
    'nta-parsers/taxanswer': { parseTaxAnswerHtml: () => ({ ...parsed }) },
    'nta-index/taxanswer-index': { fetchTaxAnswerIndex: async () => [target] },
    'nta-parsers/shitsugi': { parseShitsugiHtml: () => ({ ...parsed, body: undefined, body_combined: parsed.body }) },
    'nta-index/shitsugi-index': { fetchShitsugiIndex: async () => [target] },
    'nta-store': { loadTaxAnswerEntry: () => previous, readJson: () => previous,
      shitsugiPath: () => 'memory-only', saveTaxAnswerEntry: save, saveShitsugiEntry: save },
    'nta-index-builder': {},
    'nta-figures': { extractFigureRefs: () => images && images.length ? [{ url: 'https://www.nta.go.jp/figure.png' }] : [],
      fetchAndStoreFigures: async () => images },
    'nta-content-change': { detectContentChange },
  };
  const context = {
    __dirname: path.dirname(filename),
    require: name => {
      if (name === 'path') return path;
      const key = path.relative(path.join(ROOT, 'scripts/lib'), name).split(path.sep).join('/');
      if (Object.hasOwn(dependencies, key)) return dependencies[key];
      throw new Error(`Unexpected require: ${name}`);
    },
    process: { argv: ['node', filename, '--type', type, '--max-pages', '1', '--incremental', '--skip-index'],
      exit: code => { throw new Error(`crawl exit ${code}`); } },
    console: { log() {}, warn() {}, error() {} },
  };
  // 実際の CLI 経路を1回だけ実行し、終了を待つ。通信・保存はすべて偽物。
  vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace('main().catch(e => {', 'globalThis.crawlDone = main().catch(e => {'),
    context, { filename });
  await context.crawlDone;
  assert.equal(saved.length, 1);
  return saved[0];
}

async function main() {
  await test('1. No.2200 の fixture は基準日だけの改訂', () => {
    const before = JSON.stringify([old2200, new2200]);
    assert.notEqual(old2200.html_hash, new2200.html_hash);
    const result = detectContentChange(old2200, new2200, fetchedAt);
    assert.deepEqual(historyOf(result), [null, null, fetchedAt]);
    assert.equal(result.first_fetched_at, old2200.first_fetched_at);
    assert.equal(JSON.stringify([old2200, new2200]), before);
    assert.deepEqual(historyOf(detectContentChange(null, new2200, fetchedAt)), [null, null, null]);
  });

  await test('2. No.6501 は内容と基準日の改訂', () => {
    const previous = readJson(path.join(FIXTURES, 'ta-6501-r7.json'));
    const current = readJson(path.join(FIXTURES, 'ta-6501-r8.json'));
    assert.deepEqual(historyOf(detectContentChange({ ...previous, as_of_changed_at: priorDate }, current, fetchedAt)),
      [fetchedAt, 'law_version', priorDate]);
  });

  await test('3. 問い合わせ先・空白だけの変更は3項目を引き継ぐ', () => {
    const previous = { ...old2200, law_version: new2200.law_version,
      content_changed_at: priorDate, content_change_kind: 'body', as_of_changed_at: '2026-08-01T00:00:00Z' };
    assert.deepEqual(historyOf(detectContentChange(previous, new2200, fetchedAt)), historyOf(previous));
    assert.equal(substantiveBody({ body: ' Ａ　Ｂ\nＣ ' }), 'ABC');
    assert.equal(substantiveBody({ body: '[令和７年４月１日現在法令等]本文令和８年４月１日現在法令等' }),
      '本文令和8年4月1日現在法令等');
  });

  await test('4. 同じ基準日で本文の1文が変われば body', () => {
    const previous = { ...new2200, html_hash: 'previous', as_of_changed_at: priorDate };
    const current = { ...new2200, body: new2200.body.replace('含まれます。', '含まれません。') };
    assert.notEqual(current.body, previous.body);
    assert.deepEqual(historyOf(detectContentChange(previous, current, fetchedAt)), [fetchedAt, 'body', priorDate]);
  });

  await test('5. 同一ハッシュの履歴と索引で as_of_changed_at を保持', () => {
    const previous = { ...old2200, content_changed_at: priorDate, content_change_kind: 'body', as_of_changed_at: priorDate };
    const current = { ...new2200, html_hash: previous.html_hash, body: '違う本文' };
    assert.deepEqual(historyOf(detectContentChange(previous, current, fetchedAt)), historyOf(previous));
    const stored = { ...new2200, ...detectContentChange(old2200, new2200, fetchedAt) };
    const file = path.join(ROOT, 'data/nta-sources/taxanswer/shotoku/2200.json');
    assert.equal(indexBuilder.buildIndexEntry(stored, file).as_of_changed_at, fetchedAt);
    assert.equal(indexBuilder.buildIndexEntry(old2200, file).as_of_changed_at, null);
    assert.equal(Object.keys(indexBuilder.buildIndexEntry(stored, file)).slice(-3).join(','),
      'content_change_kind,as_of_changed_at,law_version');
  });

  await test('6. 質疑応答・平成・元年・括弧なしの基準日も除外', () => {
    const previous = { body_combined: '回答は同じです。', law_version: '令和7年8月1日現在の法令・通達等', html_hash: 'old' };
    const current = { ...previous, law_version: '令和8年8月1日現在の法令・通達等', html_hash: 'new' };
    assert.deepEqual(historyOf(detectContentChange(previous, current, fetchedAt)), [null, null, fetchedAt]);
    for (const label of ['[平成元年8月1日現在法令等]', '平成31年4月1日現在法令等',
      '[令和元年8月1日現在の法令・通達等]', '令和８年８月１日現在の法令・通達等']) {
      assert.equal(substantiveBody({ body_combined: `${label}回答は同じです。` }), previous.body_combined);
    }
    assert.equal(substantiveBody({ body: null, body_combined: '回答' }), '回答');
  });

  await test('7. 問い合わせ先より前の本文・リンク・法令・注記は内容として比較', () => {
    const previous = { ...old2200, body: '本文。お問い合わせ先旧案内' };
    assert.equal(detectContentChange(previous, { ...new2200, body: '変更した本文。お問い合わせ先新案内' }, fetchedAt).content_change_kind,
      'law_version');
    assert.equal(substantiveBody({ body: 'お問い合わせ先の説明。本文。お問い合わせ先定型文' }), 'お問い合わせ先の説明。本文。お問い合わせ先定型文');
    assert.equal(substantiveBody({ body: '本文。このコンテンツはお役にたちましたか？旧案内' }), '本文。');
    assert.equal(substantiveBody({ body: '本文。このコンテンツはお役にたちましたか？お問い合わせ先定型文' }),
      '本文。このコンテンツはお役にたちましたか?お問い合わせ先定型文');
    for (const section of ['関連リンク', '根拠法令等', '（注）']) {
      assert.equal(detectContentChange({ body: `本文${section}旧内容` }, { body: `本文${section}新内容` }, fetchedAt).content_change_kind, 'body');
    }
    assert.equal(substantiveBody({}), null);
    for (const [previousBody, currentBody] of [[null, '本文'], ['本文', null]]) {
      assert.equal(detectContentChange({ body: previousBody }, { body: currentBody }, fetchedAt).content_change_kind, 'body');
    }
    assert.equal(detectContentChange({ law_version: '令和7年' }, { law_version: '令和8年' }, fetchedAt).content_change_kind, 'law_version');
  });

  await test('8. 補正は履歴キャッシュだけで書き込み・消去・dry-run・要約を検証', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-as-of-'));
    try {
      const directory = path.join(root, 'data/nta-sources/taxanswer/shotoku');
      fs.mkdirSync(directory, { recursive: true });
      const relative = id => `data/nta-sources/taxanswer/shotoku/${id}.json`;
      const file = id => path.join(root, relative(id));
      const firstDate = '2026-06-21T00:00:00Z';
      const previousDate = '2026-09-28T00:00:00Z';
      const previous = { ...old2200, fetched_at: previousDate, content_changed_at: previousDate, content_change_kind: 'body' };
      const entries = {
        asof: { ...new2200, fetched_at: fetchedAt },
        body: { ...new2200, fetched_at: fetchedAt, body: new2200.body.replace('含まれます。', '含まれません。') },
        initial: { ...new2200, fetched_at: firstDate, as_of_changed_at: fetchedAt },
        clean: { ...new2200, fetched_at: fetchedAt, as_of_changed_at: fetchedAt },
      };
      const firstVersions = {};
      const previousVersions = {};
      for (const [id, entry] of Object.entries(entries)) {
        fs.writeFileSync(file(id), JSON.stringify({ ...entry, id }));
        firstVersions[relative(id)] = { ...old2200, fetched_at: firstDate };
        previousVersions[relative(id)] = id === 'clean'
          ? { ...new2200, fetched_at: previousDate, content_changed_at: null, content_change_kind: null }
          : previous;
      }
      const historyFile = path.join(root, 'history.json');
      fs.writeFileSync(historyFile, JSON.stringify({ firstVersions, previousVersions }));
      const before = Object.keys(entries).map(id => fs.readFileSync(file(id), 'utf8'));
      const preview = backfill({ root, historyFile, dryRun: true });
      assert.equal(preview.total, 4);
      assert.equal(preview.updated, 4);
      assert.deepEqual(preview.changed, [
        { id: 'asof', type: 'taxanswer', date: previousDate, kind: 'body' },
        { id: 'asof', type: 'taxanswer', date: fetchedAt, kind: 'as_of' },
        { id: 'body', type: 'taxanswer', date: fetchedAt, kind: 'law_version' },
      ]);
      assert.deepEqual(Object.keys(entries).map(id => fs.readFileSync(file(id), 'utf8')), before);

      // CLI も一時 root と historyFile に固定し、git の起動を禁止する。
      const filename = path.join(ROOT, 'scripts/backfill-nta-content-changed.js');
      const cliModule = { exports: {} };
      const lines = [];
      const cliRequire = name => {
        if (name === 'child_process') return { execFileSync: () => { throw new Error('git must not run'); } };
        if (name === './lib/nta-content-change') return { detectContentChange };
        if (name === './lib/nta-index-builder') return indexBuilder;
        if (name === './lib/nta-store') return require('../nta-store');
        if (name === 'fs' || name === 'path') return require(name);
        throw new Error(`Unexpected require: ${name}`);
      };
      cliRequire.main = cliModule;
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: cliRequire, module: cliModule, __dirname: path.join(root, 'scripts'),
        process: { argv: ['node', filename, '--dry-run'], env: { NTA_BACKFILL_HISTORY_FILE: historyFile } },
        console: { log: line => lines.push(line) },
      }, { filename });
      assert(lines.includes(`asof\ttaxanswer\t${fetchedAt}\tas_of`));
      assert.equal(lines.at(-1), '内容の改訂 2 件・基準日だけ 1 件');
      assert.deepEqual(Object.keys(entries).map(id => fs.readFileSync(file(id), 'utf8')), before);

      assert.deepEqual(backfill({ root, historyFile }), preview);
      assert.deepEqual(historyOf(readJson(file('asof'))), [previousDate, 'body', fetchedAt]);
      assert.deepEqual(historyOf(readJson(file('body'))), [fetchedAt, 'law_version', undefined]);
      for (const id of ['initial', 'clean']) {
        const entry = readJson(file(id));
        for (const key of ['content_changed_at', 'content_change_kind', 'as_of_changed_at']) assert(!Object.hasOwn(entry, key));
      }
      assert.equal(readJson(file('asof')).html_hash, entries.asof.html_hash);
      assert.equal(readJson(file('asof')).body, entries.asof.body);
      assert.equal(readJson(file('asof')).first_fetched_at, entries.asof.first_fetched_at);
      assert.equal(backfill({ root, historyFile }).updated, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('9. 候補の基準日理由・重み・確認済み・併存と偽LLMの呼び出しなし', async () => {
    const post = { slug: 'asof', title: '記事', review_status: 'published', published_at: priorDate,
      source_urls: [new2200.url], body: '## 説明\n記事の本文です。' };
    const source = { ...new2200, content_changed_at: priorDate, as_of_changed_at: fetchedAt };
    const build = (sources, overrides = {}) => freshness.buildCandidates({
      posts: [{ ...post, ...overrides }], sources,
    }, { now: new Date('2026-10-27T00:00:00Z') });
    const candidate = build([source])[0];
    assert.equal(freshness.SIGNAL_WEIGHTS.source_as_of_updated, 1);
    assert.equal(candidate.score, 1);
    assert.equal(candidate.refreshable, false);
    assert.deepEqual(candidate.reasons, [{ kind: 'source_as_of_updated',
      detail: `${source.title_full}の基準日が 2026-10-02 に「${source.law_version}」へ更新（内容の変更なし）`, where: '出典欄' }]);
    assert.deepEqual(build([source], { reviewed_at: '2026-10-20T00:00:00Z' }), []);
    assert.deepEqual(build([source], { reviewed_at: fetchedAt }), []);
    assert.equal(build([source], { reviewed_at: '2026-08-20T00:00:00Z' }).length, 1);
    assert.deepEqual(build([{ ...source, as_of_changed_at: priorDate }]), []);
    assert.deepEqual(build([{ ...source, as_of_changed_at: 'invalid' }]), []);
    assert.deepEqual(build([source], { published_at: undefined }), []);
    const content = build([{ ...source, content_changed_at: fetchedAt }])[0];
    assert.deepEqual(content.reasons, [{ kind: 'source_updated',
      detail: `${source.title_full}の本文が 2026-10-02 に改訂（${source.law_version} に更新）`, where: '出典欄' }]);
    assert.equal(content.score, 3);
    assert.equal(content.refreshable, true);
    const second = { ...source, url: 'https://www.nta.go.jp/second.htm', title_full: '別の出典', content_changed_at: fetchedAt };
    const mixed = build([source, second], { source_urls: [source.url, second.url] })[0];
    assert.deepEqual(mixed.reasons.map(reason => reason.kind), ['source_updated', 'source_as_of_updated']);
    assert.equal(mixed.score, 4);
    assert.equal(mixed.refreshable, true);
    const newer = { ...source, url: 'https://www.nta.go.jp/newer.htm', title_full: '最新の出典', as_of_changed_at: '2026-10-12T00:00:00Z' };
    const latest = build([source, newer], { source_urls: [source.url, newer.url] })[0];
    assert.equal(latest.reasons.length, 1);
    assert(latest.reasons[0].detail.startsWith('最新の出典の基準日が 2026-10-12'));
    assert.equal(build([{ ...source, title_full: null }])[0].reasons[0].detail.startsWith('No.2200'), true);
    assert.deepEqual(refresh.buildRefreshPlan(post, candidate.reasons), []);
    assert.deepEqual(refresh.buildRefreshPlan(post, mixed.reasons),
      refresh.buildRefreshPlan(post, mixed.reasons.filter(reason => reason.kind !== 'source_as_of_updated')));
    let calls = 0;
    const fakeLLM = async value => { calls++; return value; };
    await refresh.runRefresh({ content: '---\ntitle: 記事\n---\n本文', reasons: candidate.reasons,
      regenerateSection: fakeLLM, regenerateTargeted: fakeLLM });
    assert.equal(calls, 0);
    assert(freshness.reasonText(candidate).includes(candidate.reasons[0].detail));
  });

  await test('10. 管理画面の札・案内文・操作ボタン・HTMLエスケープ', () => {
    const asof = { slug: 'asof', score: 1, impressions28d: 0, refreshable: false,
      reasons: [{ kind: 'source_as_of_updated', detail: '<b>基準日</b>', where: '<em>出典欄</em>' }] };
    const guide = '内容の変更はありません。記事の記述が今も正しいか確かめて「確認済み（変更なし）」を押してください。';
    const html = renderPage([asof], []);
    assert(html.includes('class="tag">基準日の改訂あり</span>'));
    assert(html.includes(guide));
    assert(html.indexOf(guide) < html.indexOf('data-action="reviewed"'));
    assert(html.includes('確認済み（変更なし）</button>'));
    assert(!html.includes('更新案を作る'));
    assert(!html.includes('更新案を作れる理由はありません。'));
    assert(html.includes('&lt;b&gt;基準日&lt;/b&gt;'));
    assert(html.includes('&lt;em&gt;出典欄&lt;/em&gt;'));
    assert(!html.includes('<b>') && !html.includes('<em>'));
    const content = { ...asof, slug: 'content', refreshable: true,
      reasons: [{ kind: 'source_updated', detail: '文言に依存しない', where: '出典欄' }] };
    const contentHtml = renderPage([content], []);
    assert(contentHtml.includes('class="tag tag-content">内容の改訂あり</span>'));
    assert(contentHtml.includes('更新案を作る</button>'));
    assert(!contentHtml.includes(guide));
    const mixed = renderPage([{ ...content, reasons: [...content.reasons, ...asof.reasons] }], []);
    assert(mixed.includes('内容の改訂あり</span>') && mixed.includes('基準日の改訂あり</span>'));
    assert(!mixed.includes(guide));
    const other = renderPage([{ ...asof, reasons: [{ kind: 'search_decline', detail: '基準日の改訂あり', where: '検索' }] }], []);
    assert(!other.includes('<span class="tag'));
    assert(!other.includes(guide));
    assert(other.includes('更新案を作れる理由はありません。'));
    assert(!renderPage([{ ...asof, reasons: [] }], []).includes(guide));
  });

  await test('F1. 関係法令通達と題名の変更・追加・削除は内容の改訂', () => {
    const previous = { body_combined: '回答は同じ。', title: '題名Ａ', kankei_hourei: '所得税法第１条',
      law_version: old2200.law_version, html_hash: 'old' };
    const current = { ...previous, law_version: new2200.law_version, html_hash: 'new' };
    for (const [key, value] of [['kankei_hourei', '所得税法第2条'], ['title', '題名B']]) {
      assert.deepEqual(historyOf(detectContentChange(previous, { ...current, [key]: value }, fetchedAt)),
        [fetchedAt, 'law_version', null]);
      const missing = { ...previous };
      delete missing[key];
      assert.equal(detectContentChange(missing, current, fetchedAt).content_change_kind, 'law_version');
      const removed = { ...current };
      delete removed[key];
      assert.equal(detectContentChange(previous, removed, fetchedAt).content_change_kind, 'law_version');
      assert.equal(detectContentChange(previous, { ...previous, html_hash: 'new', [key]: value }, fetchedAt).content_change_kind, 'body');
    }
    assert.deepEqual(historyOf(detectContentChange(previous, { ...current, title: '題名 A', kankei_hourei: '所得税法 第1条' }, fetchedAt)),
      [null, null, fetchedAt]);
  });

  await test('F2. 図のハッシュの並び・追加・削除を内容として比較', () => {
    const previous = { body: '本文', law_version: old2200.law_version, html_hash: 'old', images: [{ sha256: 'a' }, { sha256: 'b' }] };
    const current = { ...previous, law_version: new2200.law_version, html_hash: 'new' };
    for (const images of [[{ sha256: 'c' }, { sha256: 'b' }], [{ sha256: 'b' }, { sha256: 'a' }], [{ sha256: 'a' }], []]) {
      assert.deepEqual(historyOf(detectContentChange(previous, { ...current, images }, fetchedAt)), [fetchedAt, 'law_version', null]);
    }
    const noImages = { ...previous };
    delete noImages.images;
    const removed = { ...current };
    delete removed.images;
    assert.equal(detectContentChange(previous, removed, fetchedAt).content_change_kind, 'law_version');
    assert.equal(detectContentChange(noImages, current, fetchedAt).content_change_kind, 'law_version');
    assert.equal(detectContentChange(noImages, { ...current, images: [] }, fetchedAt).content_change_kind, 'law_version');
    assert.deepEqual(historyOf(detectContentChange(noImages, removed, fetchedAt)), [null, null, fetchedAt]);
    assert.deepEqual(historyOf(detectContentChange(previous, { ...current, images: [{ sha256: 'a', alt: '変更後' }, { sha256: 'b' }] }, fetchedAt)),
      [null, null, fetchedAt]);
  });

  await test('F2. タックスアンサー・質疑応答の取り込みで図取得後に判定', async () => {
    for (const type of ['taxanswer', 'shitsugi']) {
      const previous = { title: '図のある資料', law_version: old2200.law_version, html_hash: 'old-hash',
        first_fetched_at: priorDate, fetched_at: priorDate, images: [{ sha256: 'old-figure' }],
        ...(type === 'taxanswer' ? { body: '本文は同じ。' } : { body_combined: '本文は同じ。' }) };
      for (const images of [[{ sha256: 'new-figure' }], undefined, [{ sha256: 'old-figure' }]]) {
        const stored = await crawlWithFigures(type, previous, images);
        assert.deepEqual(historyOf(stored), images && images[0].sha256 === 'old-figure'
          ? [null, null, fetchedAt] : [fetchedAt, 'law_version', null]);
        assert.equal(stored.first_fetched_at, priorDate);
        assert.equal(stored.fetched_at, fetchedAt);
        assert.equal(stored.html_hash, 'new-hash');
        assert.deepEqual(stored.images, images);
      }
      const initial = await crawlWithFigures(type, null, [{ sha256: 'new-figure' }]);
      assert.deepEqual(historyOf(initial), [null, null, null]);
    }
  });

  await test('F1・F2. 補正も題名・法令・図の変更を履歴キャッシュから判定', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-as-of-review-'));
    try {
      const directory = path.join(root, 'data/nta-sources/shitsugi/shohi/02');
      fs.mkdirSync(directory, { recursive: true });
      const previous = { body_combined: '回答', title: '題名', kankei_hourei: '第1条',
        law_version: old2200.law_version, html_hash: 'old', images: [{ sha256: 'old-figure' }], fetched_at: priorDate };
      const firstVersions = {};
      const previousVersions = {};
      const changes = { changed: { images: [{ sha256: 'new-figure' }] }, added: {}, removed: { images: undefined },
        same: {}, title: { title: '新しい題名' }, law: { kankei_hourei: '第2条' } };
      for (const [id, change] of Object.entries(changes)) {
        const relative = `data/nta-sources/shitsugi/shohi/02/${id}.json`;
        firstVersions[relative] = { fetched_at: '2026-06-21T00:00:00Z' };
        previousVersions[relative] = id === 'added' ? { ...previous, images: undefined } : previous;
        fs.writeFileSync(path.join(root, relative), JSON.stringify({ ...previous, ...change, id, type: 'shitsugi',
          law_version: new2200.law_version, html_hash: 'new', fetched_at: fetchedAt }));
      }
      const historyFile = path.join(root, 'history.json');
      fs.writeFileSync(historyFile, JSON.stringify({ firstVersions, previousVersions }));
      const preview = backfill({ root, historyFile, dryRun: true });
      assert.equal(preview.changed.filter(item => item.kind === 'law_version').length, 5);
      assert.equal(preview.changed.filter(item => item.kind === 'as_of').length, 1);
      assert.deepEqual(backfill({ root, historyFile }), preview);
      for (const id of Object.keys(changes)) {
        assert.deepEqual(historyOf(readJson(path.join(directory, `${id}.json`))), id === 'same'
          ? [undefined, undefined, fetchedAt] : [fetchedAt, 'law_version', undefined]);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('F3. 本文内の「お問い合わせ先」以降も内容として比較', () => {
    const previous = { body: 'お問い合わせ先は所轄税務署。税率は10%', html_hash: 'old' };
    assert.equal(detectContentChange(previous, { body: 'お問い合わせ先は所轄税務署。税率は20%', html_hash: 'new' }, fetchedAt).content_change_kind, 'body');
    assert.equal(substantiveBody({ body: '本文。お問い合わせ先旧案内このコンテンツはお役にたちましたか？' }), '本文。');
    assert.equal(substantiveBody({ body: 'お問い合わせ先の説明。本文。お問い合わせ先定型文このコンテンツはお役にたちましたか？' }),
      'お問い合わせ先の説明。本文。');
    const old = { body: '本文。お問い合わせ先旧案内このコンテンツはお役にたちましたか？', html_hash: 'old' };
    const next = { body: '本文。お問い合わせ先新案内このコンテンツはお役にたちましたか？', html_hash: 'new' };
    assert.deepEqual(historyOf(detectContentChange(old, next, fetchedAt)), [null, null, null]);
  });

  await test('F4. 基準日の全角半角・空白だけの差は改訂にしない', () => {
    const previous = { body: '本文', law_version: '令和７年８月１日現在の法令・通達等', html_hash: 'old',
      content_changed_at: priorDate, content_change_kind: 'body', as_of_changed_at: priorDate };
    const current = { ...previous, law_version: '令和7年 8月1日 現在の法令・通達等', html_hash: 'new' };
    assert.deepEqual(historyOf(detectContentChange(previous, current, fetchedAt)), historyOf(previous));
    assert.equal(detectContentChange(previous, { ...current, body: '変更した本文' }, fetchedAt).content_change_kind, 'body');
  });

  await test('F5. 不完全な law_version や本文内の日付で内容の差を消さない', () => {
    const previous = { body: '令和7年分の税率', law_version: '令和8年', html_hash: 'old' };
    const current = { ...previous, body: '令和8年分の税率', html_hash: 'new' };
    assert.deepEqual(historyOf(detectContentChange(previous, current, fetchedAt)), [fetchedAt, 'body', null]);
    assert.equal(detectContentChange({ ...previous, law_version: '令和7年' }, current, fetchedAt).content_change_kind, 'law_version');
    assert.equal(substantiveBody({ body: '本文で引用する令和8年4月1日現在法令等は残す。' }), '本文で引用する令和8年4月1日現在法令等は残す。');
  });

  await test('F6. 基準日だけの案内文は操作できるカードだけに表示', () => {
    const candidate = { slug: 'asof', refreshable: false,
      reasons: [{ kind: 'source_as_of_updated', detail: '基準日の改訂', where: '出典欄' }] };
    const guide = '内容の変更はありません。記事の記述が今も正しいか確かめて「確認済み（変更なし）」を押してください。';
    assert(renderPage([candidate], []).includes(guide));
    const unsupported = renderPage([{ ...candidate, slug: 'bad/slug' }], []);
    assert(!unsupported.includes(guide));
    assert(!unsupported.includes('data-action="reviewed"'));
    const withPr = renderPage([candidate], [{ head: { ref: 'draft/refresh-asof' }, html_url: 'https://example.invalid/pr' }]);
    assert(!withPr.includes(guide));
    assert(withPr.includes('更新案あり：'));
    assert(withPr.includes('data-action="reviewed"'));
  });

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
