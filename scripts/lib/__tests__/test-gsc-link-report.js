'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReport, buildInternalLinkSections, calculateBodyLinks, readLinkConfig, DEFAULT_LINK_CONFIG, run } = require('../../report-search-console');
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`PASS ${label}`); }
const url = slug => `https://mori-zeirishi.net/blog/${slug}/`;
const post = (slug, extra = {}) => ({ slug, title: `記事 ${slug}`, review_status: 'published', publish_at: '2020-01-01', primary_persona: 'retail_store', ...extra });
const page = (slug, extra = {}) => ({ page: url(slug), impressions: 100, clicks: 3, position: 8.5, ...extra });
const query = (text, extra = {}) => ({ query: text, impressions: 10, clicks: 1, position: 9, ctr: 0.1, ...extra });
const placement = (id, source, target, extra = {}) => ({ id, source, target, anchor: '指定の言葉', added_at: '2026-11-01', ...extra });
const ebay = DEFAULT_LINK_CONFIG.exclude_slugs[0];
const posts = [post('retail'), post('construction', { primary_persona: 'construction_solo' }), post('outside', { primary_persona: 'beauty_salon_owner' }),
  post(ebay, { primary_persona: 'ebay_export_seller' }), post('low-rank'), post('high-rank'), post('low-impressions'),
  post('source-dict', { _body: '## 本文\n\n辞書の言葉 辞書の言葉' }), post('source-placement', { _body: '## 本文\n\n指定の言葉' }),
  post('source-existing', { _body: '[元から](/blog/retail/)\n## 本文\n\n[再掲](/blog/retail/)' }),
  post('source-draft', { review_status: 'draft', _body: '## 本文\n\n辞書の言葉' }),
  post('source-future', { publish_at: '2099-01-01', _body: '## 本文\n\n辞書の言葉' }),
  post('source-no-date', { publish_at: '', _body: '## 本文\n\n辞書の言葉' }),
  post('merged', { review_status: 'merged', merged_into: 'retail' }), post('draft', { review_status: 'draft' }),
];
const pages = [page('retail'), page('construction', { impressions: 90, position: 4 }), page('outside', { impressions: 80, position: 20 }),
  page(ebay, { impressions: 70 }), page('low-rank', { position: 20.1 }), page('high-rank', { position: 3.9 }),
  page('low-impressions', { impressions: 19 }), page('draft', { impressions: 0 }),
  { page: 'https://mori-zeirishi.net/services/bookkeeping/', impressions: 500, clicks: 5, position: 10 }];
const placements = [placement('one', 'source-placement', 'retail', { baseline: { range_end: '2026-10-29', position: 9.7, impressions: 60, clicks: 2 } }),
  placement('missing-anchor', 'source-dict', 'retail', { added_at: '2026-11-03' }),
  placement('no-baseline', 'source-placement', 'construction', { anchor: '無い言葉' }),
  placement('disabled', 'source-dict', 'outside', { enabled: false })];
const linkTerms = [{ term: '辞書の言葉', slug: 'retail', macros: ['*'] },
  { term: '統合語', slug: 'merged', macros: ['not-used'] }, { term: '旧語', slug: 'merged', macros: ['not-used'] },
  { term: '未公開語', slug: 'draft', macros: ['not-used'] }, { term: '不存在語', slug: 'missing', macros: ['not-used'] },
  { term: '無効語', slug: 'disabled-missing', enabled: false }];
const aiLong = '長い質問の文章'.repeat(9) + ' 必要';
const queries = [query('小売　経費 方法', { impressions: 30 }), query('単語だけ'), query('単語 ふたつ'),
  query('甲　乙 丙', { impressions: 20 }), query('必要ですか', { impressions: 15 }), query('question: tax'), query(aiLong)];
const queryPages = [
  { ...query('検索上位', { impressions: 50 }), page: url('retail') },
  { ...query('検索中位', { impressions: 40 }), page: url('retail') },
  { ...query('検索下位', { impressions: 30 }), page: url('retail') },
  { ...query('検索4位', { impressions: 20 }), page: url('retail') },
  { ...query('甲　乙 丙', { impressions: 10 }), page: url('retail') },
  { ...query('甲　乙 丙', { impressions: 30 }), page: url('construction') },
];
const indexStatus = { rows: [{ url: url('retail'), verdict: 'PASS' }, { url: url('construction'), verdict: 'FAIL' }, { url: url(ebay), error: 'failed' }] };
const options = { pages, queries, queryPages, posts, postContents: new Map(), pickupConfig: {}, indexStatus, placements, linkTerms, now: new Date('2026-11-15T12:00:00+09:00') };
const originalWarn = console.warn;
console.warn = () => {};
try {
  const sections = buildInternalLinkSections(options).join('\n');
  const section = (text, heading) => text.split(`## ${heading}`)[1].split(/\n## /)[0];
  const candidates = section(sections, '内部リンクの候補');
  const row = (text, label) => text.split('\n').find(line => line.startsWith(`| ${label} |`));
  check('R9: 順位・表示・ページ種別で絞る', () => {
    assert(!candidates.includes('記事 low-rank')); assert(!candidates.includes('記事 high-rank'));
    assert(!candidates.includes('記事 low-impressions')); assert(!candidates.includes('bookkeeping'));
    assert(candidates.includes('記事 construction') && candidates.includes('記事 outside'));
  });
  check('R9: 表示順', () => assert(candidates.indexOf('記事 retail') < candidates.indexOf('記事 construction')));
  check('R9: 小売・建設を対象にする', () => {
    assert(row(candidates, '記事 retail').endsWith('| ○ |')); assert(row(candidates, '記事 construction').endsWith('| ○ |'));
  });
  check('R9: 業種外', () => assert(row(candidates, '記事 outside').endsWith('| 業種外 |')));
  check('R9: 除外期間中', () => assert(row(candidates, `記事 ${ebay}`).endsWith('| eBay の確認中 |')));
  const includedConfig = { ...DEFAULT_LINK_CONFIG, target_macros: ['小売', '建設', '物販'] };
  for (const date of ['2026-11-30T00:00:00+09:00', '2026-12-01T00:00:00+09:00']) check(`R9: 除外期間終了 ${date}`, () => {
    const text = buildInternalLinkSections({ ...options, now: new Date(date), linkConfig: includedConfig }).join('\n');
    assert(row(section(text, '内部リンクの候補'), `記事 ${ebay}`).endsWith('| ○ |'));
  });
  check('R9: 終了後も業種外を判定', () => {
    const text = buildInternalLinkSections({ ...options, now: new Date('2026-12-01') }).join('\n');
    assert(row(section(text, '内部リンクの候補'), `記事 ${ebay}`).endsWith('| 業種外 |'));
  });
  check('R9: 本文リンクは辞書・指定・元のリンクを記事単位で数える', () => {
    const { incoming, applied } = calculateBodyLinks({ ...options, terms: linkTerms });
    assert.deepStrictEqual([...incoming.get('retail')].sort(), ['source-dict', 'source-existing', 'source-placement']);
    assert.deepStrictEqual([...applied], ['one']); assert(row(candidates, '記事 retail').includes('| 3 | 検索上位、検索中位、検索下位 |'));
  });
  check('R9: pickup中核記事には辞書から付けない', () => {
    const result = calculateBodyLinks({ ...options, terms: linkTerms, pickupConfig: { netshop_core: ['retail'] } });
    assert.strictEqual(result.incoming.get('retail').size, 2); assert(result.applied.has('one'));
  });
  check('R9: normalizeBold後の本文を使う', () => {
    const result = calculateBodyLinks({ ...options, posts: [post('a', { _body: '## 本文\n**言葉**（説明）' }), post('retail')], terms: [], placements: [placement('bold', 'a', 'retail', { anchor: '言葉' })] });
    assert(result.applied.has('bold'));
  });
  check('R9: 生成前のmetadataと本文を使う', () => {
    const result = calculateBodyLinks({ ...options, posts: [post('source-dict'), post('retail')], terms: linkTerms,
      postContents: new Map([['source-dict', { metadata: post('source-dict', { review_status: 'draft' }), body: '## 本文\n辞書の言葉' }]]) });
    assert(!result.incoming.has('retail'));
  });
  check('R9: Google登録の○・×・不明', () => {
    assert(row(candidates, '記事 retail').includes('| ○ | 3 |')); assert(row(candidates, '記事 construction').includes('| × | 0 |'));
    assert(row(candidates, `記事 ${ebay}`).includes('| 不明 | 0 |'));
  });
  check('R9: 検索語が無ければ伏せられています', () => assert(!row(candidates, '記事 construction').includes('（伏せられています）') && row(candidates, '記事 outside').includes('（伏せられています）')));
  check('R9: 最大20行・題名が無ければslug', () => {
    const rows = Array.from({ length: 23 }, (_, i) => page(`extra-${i}`, { impressions: 100 - i }));
    const text = section(buildInternalLinkSections({ ...options, pages: rows }).join('\n'), '内部リンクの候補');
    assert(text.includes('| extra-19 |')); assert(!text.includes('| extra-20 |'));
  });
  const follow = section(sections, '足したリンクのその後');
  check('R10: baseline・実際/指定・最初の日付・経過週・改善', () => assert.strictEqual(row(follow, '記事 retail'), '| 記事 retail | 1/2 | 2026-11-01 | 2 | 9.7 / 60 / 2 | 8.5 / 100 / 3 | +1.2 位改善 |'));
  check('R10: baselineなし', () => assert(row(follow, '記事 construction').includes('| — | 4.0 / 90 / 3 | — |')));
  check('R10: disabledを除外', () => assert(!follow.includes('記事 outside')));
  check('R10: 0件', () => assert(section(buildInternalLinkSections({ ...options, placements: [] }).join('\n'), '足したリンクのその後').includes('（まだありません）')));
  check('R10: 今の表示なし', () => assert(row(section(buildInternalLinkSections({ ...options, pages: [] }).join('\n'), '足したリンクのその後'), '記事 retail').endsWith('| — | — |')));
  check('R10: 悪化を表示', () => {
    const text = buildInternalLinkSections({ ...options, pages: [page('retail', { position: 11 })] }).join('\n');
    assert(section(text, '足したリンクのその後').includes('−1.3 位悪化'));
  });
  const questions = section(sections, '長い質問の検索語');
  const [normal, ai] = questions.split('### AI が代わりに検索したとみられる語');
  check('R11: 半角と全角で3語・質問語', () => assert(normal.includes('甲　乙 丙') && normal.includes('必要ですか')));
  check('R11: 2語以下は除外', () => assert(!questions.includes('単語だけ') && !questions.includes('単語 ふたつ')));
  check('R11: AI風の語は別表', () => assert(!normal.includes(aiLong) && !normal.includes('question:') && ai.includes(aiLong) && ai.includes('question: tax')));
  check('R11: 表示最大の該当ページ', () => assert(row(normal, '甲　乙 丙').endsWith('| construction |')));
  check('R11: 見える表示割合を計算', () => {
    const total = pages.reduce((sum, p) => sum + p.impressions, 0);
    assert(questions.includes(`${(queries.reduce((sum, q) => sum + q.impressions, 0) / total * 100).toFixed(1)}%`));
  });
  check('R11: 表示0でもNaNにしない', () => assert(!buildInternalLinkSections({ ...options, pages: [], queries: [] }).join('\n').match(/NaN|Infinity/)));
  check('R11: 設定の語数・質問語', () => {
    const text = section(buildInternalLinkSections({ ...options, queries: [query('甲 乙'), query('独自ワード')], linkConfig: { min_query_tokens: 2, question_words: ['独自'] } }).join('\n'), '長い質問の検索語');
    assert(text.includes('甲 乙') && text.includes('独自ワード'));
  });
  check('R11: AI表と合わせて表示上位20件まで', () => {
    const rows = Array.from({ length: 24 }, (_, i) => query(i % 2 ? `question: ${i}` : `必要な語${i}`, { impressions: 100 - i }));
    const text = section(buildInternalLinkSections({ ...options, queries: rows }).join('\n'), '長い質問の検索語');
    assert(text.includes('question: 19')); assert(!text.includes('必要な語20')); assert(!text.includes('question: 21'));
  });
  const audit = section(sections, '辞書の行き先の点検');
  check('R12: 統合先を併記', () => assert(audit.includes('| 統合語 | merged | 統合済み（retail） |')));
  check('R12: 未公開と不存在・disabled除外', () => assert(audit.includes('| 未公開語 | draft | 未公開・取り下げ |') && audit.includes('| 不存在語 | missing | 行き先がありません |') && !audit.includes('disabled-missing')));
  check('R12: 表示無しは行き先の種類を数える', () => assert(audit.includes('表示が無い辞書の行き先: 3 件')));
  check('R12: 問題なし', () => assert(section(buildInternalLinkSections({ ...options, linkTerms: [linkTerms[0]] }).join('\n'), '辞書の行き先の点検').includes('（問題ありません）')));
  check('4節は狙った語の直後に既存の順を維持して置く', () => {
    const text = buildReport({ ...options, latest: { fetched_at: 'today', range: { start: 'a', end: 'b' }, property: 'test' } });
    assert.deepStrictEqual(text.match(/^## .+/gm), ['## 検索語の上位30（表示回数順）', '## 伸ばしやすい語（順位11〜30位で表示回数が多いもの）', '## 狙った語の順位', '## 内部リンクの候補（順位 4〜20 位）', '## 足したリンクのその後', '## 長い質問の検索語', '## 辞書の行き先の点検', '## ページ別の上位30（クリック順）', '## ページ種別ごとの合計', '## 前回との差分（新しく表示され始めた検索語）', '## 索引の状態', '## 更新候補（上位 10）']);
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-link-report-'));
  try {
    const missing = path.join(tmp, 'missing.json');
    check('R8: 設定無しで既定値', () => assert.deepStrictEqual(readLinkConfig(missing), DEFAULT_LINK_CONFIG));
    check('R8: 設定無しでレポートを最後まで作る', () => {
      fs.mkdirSync(path.join(tmp, '20261101'));
      fs.writeFileSync(path.join(tmp, 'latest.json'), JSON.stringify({ fetched_at: '2026-11-01', range: { start: '2026-10-02', end: '2026-10-29' }, property: 'test', files: { queries: '20261101/queries.json', pages: '20261101/pages.json' } }));
      for (const file of ['queries', 'pages']) fs.writeFileSync(path.join(tmp, '20261101', `${file}.json`), '{"rows":[]}');
      assert.strictEqual(run({ outRoot: tmp, linkConfigPath: missing, log() {} }).status, 'written');
      assert(fs.readFileSync(path.join(tmp, 'report.md'), 'utf8').includes('## 辞書の行き先の点検'));
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
} finally { console.warn = originalWarn; }
console.log(`PASS: ${passed} / FAIL: 0`);
