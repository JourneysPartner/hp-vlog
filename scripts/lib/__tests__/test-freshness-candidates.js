'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const freshness = require('../freshness-candidates');
const builder = require('../../build-freshness-candidates');
const reporter = require('../../report-search-console');
const notifier = require('../../notify-freshness-candidates');
const { buildMessage } = require(path.join(ROOT, 'netlify/functions/lib/notify/message'));

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const NOW = new Date('2026-09-27T03:00:00Z');
const CALENDAR = {
  entries: [{ id: 'kakutei-shinkoku', boost_months: [1, 2, 3] }],
};
const REFORM = {
  year: 2026,
  chapters: {
    '04': {
      label: '消費課税',
      tax_domains: ['consumption_tax', 'invoice_system'],
      items: [
        { title: '適格請求書等保存方式に係る経過措置の見直し', status: 'registered' },
        { title: 'その他', status: 'not_applicable' },
      ],
    },
  },
};

function post(slug, overrides = {}) {
  return {
    file: `2026-09-01-${slug}.md`,
    slug,
    title: `題名 ${slug}`,
    url: `https://mori-zeirishi.net/blog/${slug}/`,
    category: '消費税',
    tax_domain: 'consumption_tax',
    review_status: 'published',
    published_at: '2026-09-01T00:00:00+09:00',
    source_urls: [],
    body: '## はじめに\n新しい内容です。',
    ...overrides,
  };
}

function snapshot(impressionsBySlug, end = '2026-09-25') {
  return {
    range: { start: '2026-08-29', end },
    rows: Object.entries(impressionsBySlug).map(([slug, impressions]) => ({
      page: `https://mori-zeirishi.net/blog/${slug}/`,
      impressions,
    })),
  };
}

function inputs(posts, overrides = {}) {
  return {
    posts,
    sources: [],
    reform: null,
    calendar: CALENDAR,
    searchSnapshots: [],
    pickupConfig: {},
    ...overrides,
  };
}

function kinds(candidate) {
  return candidate ? candidate.reasons.map(reason => reason.kind) : [];
}

console.log('=== 1. 4 種の信号の一致・不一致 ===');
{
  const matching = post('source-match', {
    source_urls: ['https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm?x=1'],
  });
  const notMatching = post('source-no-match', {
    source_urls: ['https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/9999.htm'],
  });
  const sources = [{
    id: '6551', type: 'taxanswer', title: '輸出取引の免税',
    url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6551.htm',
    fetched_at: '2026-09-10T00:00:00Z',
    content_changed_at: '2026-09-10T00:00:00Z',
    content_change_kind: 'law_version',
    law_version: '令和8年4月1日現在法令等',
  }];
  const result = freshness.buildCandidates(inputs([matching, notMatching], { sources }), { now: NOW });
  assert(kinds(result.find(item => item.slug === 'source-match')).includes('source_updated'), '出典 URL が一致し、内容改訂日が公開日より後なら一致');
  assert(result.find(item => item.slug === 'source-match').reasons.some(reason => reason.detail === 'No.6551「輸出取引の免税」の本文が 2026-09-10 に改訂（令和8年4月1日現在法令等 に更新）' && reason.where === '出典欄'), '法令基準日の文言を表示する');
  const fetchedOnly = freshness.buildCandidates(inputs([matching], { sources: [{ ...sources[0], content_changed_at: null }] }), { now: NOW });
  assert(!fetchedOnly.some(item => kinds(item).includes('source_updated')), '取得日だけが新しくても出典更新としない');
  assert(!result.some(item => item.slug === 'source-no-match'), '出典 URL が違えば不一致');

  const reformMatch = post('reform-match', {
    body: '## インボイス\n適格請求書等保存方式に係る経過措置の見直しを確認します。',
  });
  const reformWrongDomain = post('reform-wrong-domain', {
    tax_domain: 'income_tax',
    body: reformMatch.body,
  });
  const reformGeneric = post('reform-generic', { body: '## 本文\nその他の注意点です。' });
  const reformResult = freshness.buildCandidates(inputs([reformMatch, reformWrongDomain, reformGeneric], { reform: REFORM }), { now: NOW });
  const reformCandidate = reformResult.find(item => item.slug === 'reform-match');
  assert(kinds(reformCandidate).includes('tax_reform') && reformCandidate.reasons[0].where === '## インボイス', '税目と制度見出し語が一致すれば税制改正の信号');
  assert(!reformResult.some(item => item.slug === 'reform-wrong-domain'), '制度名があっても税目が違えば不一致');
  assert(!reformResult.some(item => item.slug === 'reform-generic'), 'not_applicable の改正項目は不一致');

  const fiscalMatch = post('fiscal-match', { body: '## 申告の手順\n令和7年分を確認します。' });
  const fiscalCurrent = post('fiscal-current', { body: '## 申告の手順\n令和8年分を確認します。' });
  const fiscalDate = post('fiscal-date', { body: '## 適用日\n2024年4月1日以後の取引です。' });
  const fiscalResult = freshness.buildCandidates(inputs([fiscalMatch, fiscalCurrent, fiscalDate]), { now: NOW });
  assert(kinds(fiscalResult.find(item => item.slug === 'fiscal-match')).includes('fiscal_year'), '過去の令和年分は一致');
  assert(!fiscalResult.some(item => item.slug === 'fiscal-current'), '現在の令和年分は不一致');
  assert(kinds(fiscalResult.find(item => item.slug === 'fiscal-date')).includes('fiscal_year'), '過去の西暦適用日は一致');

  const searchMatch = post('search-match');
  const searchNoMatch = post('search-no-match');
  const searchResult = freshness.buildCandidates(inputs([searchMatch, searchNoMatch], {
    searchSnapshots: [
      snapshot({ 'search-match': 100, 'search-no-match': 100 }),
      snapshot({ 'search-match': 80, 'search-no-match': 80 }),
      snapshot({ 'search-match': 40, 'search-no-match': 60 }),
      snapshot({ 'search-match': 30, 'search-no-match': 30 }),
    ],
  }), { now: NOW });
  assert(kinds(searchResult.find(item => item.slug === 'search-match')).includes('search_decline'), '直近 2 回が基準平均の半分以下なら一致');
  assert(!searchResult.some(item => item.slug === 'search-no-match'), '直近 2 回の片方が半分を超えれば不一致');
}

console.log('\n=== 2. SEO 改稿信号の一致・不一致 ===');
{
  const seoMain = post('seo-main', {
    title: 'インボイスの実務',
    body: '## レシート\n伸び語一と伸び語二、伸び語三、伸び語四を解説します。',
  });
  const position10 = post('position-10', { body: '## 本文\n10位語を解説します。' });
  const position31 = post('position-31', { body: '## 本文\n31位語を解説します。' });
  const impressions9 = post('impressions-9', { body: '## 本文\n9表示語を解説します。' });
  const inTitle = post('in-title', { title: '題名内語の解説', body: '## 本文\n解説します。' });
  const notTop = post('not-top', { body: '## 本文\n最多でない語を解説します。' });
  const latest = snapshot({}, '2026-09-25');
  latest.queryPageRows = [
    { query: '伸び語一', page: seoMain.url, impressions: 40, position: 15 },
    { query: '伸び語二', page: seoMain.url, impressions: 30, position: 16.2 },
    { query: '伸び語三', page: seoMain.url, impressions: 20, position: 17 },
    { query: '伸び語四', page: seoMain.url, impressions: 10, position: 18 },
    { query: '10位語', page: position10.url, impressions: 20, position: 10 },
    { query: '31位語', page: position31.url, impressions: 20, position: 31 },
    { query: '9表示語', page: impressions9.url, impressions: 9, position: 20 },
    { query: '題名内語', page: inTitle.url, impressions: 20, position: 20 },
    { query: '最多でない語', page: notTop.url, impressions: 20, position: 20 },
    { query: '最多でない語', page: 'https://mori-zeirishi.net/services/bookkeeping/', impressions: 30, position: 18 },
  ];
  const result = freshness.buildCandidates(inputs([
    seoMain, position10, position31, impressions9, inTitle, notTop,
  ], { searchSnapshots: [latest] }), { now: NOW });
  const candidate = result.find(item => item.slug === 'seo-main');
  const seoReasons = candidate ? candidate.reasons.filter(reason => reason.kind === 'seo_growable') : [];
  assert(Boolean(candidate) && seoReasons.length === 3, '対象語を表示回数順で最大3件にする');
  assert(seoReasons[0] && seoReasons[0].detail === '「伸び語一」（表示40・15位）が題名に無い（所在: 本文）'
    && seoReasons[0].where === '題名', '理由に語・表示・順位・所在を出す');
  assert(!result.some(item => item.slug === 'position-10'), '順位10位は対象外');
  assert(!result.some(item => item.slug === 'position-31'), '順位31位は対象外');
  assert(!result.some(item => item.slug === 'impressions-9'), '表示9回は対象外');
  assert(!result.some(item => item.slug === 'in-title'), '語が題名にあれば対象外');
  assert(!result.some(item => item.slug === 'not-top'), 'その語の表示最多ページでなければ対象外');
  assert(freshness.SIGNAL_WEIGHTS.seo_growable === 2 && candidate.score === 2, 'seo_growable の重みは2');
}

console.log('\n=== 3. 重み・表示順位係数・物販中核 ===');
{
  const high = post('high', { body: '## 年分\n令和7年分です。' });
  const low = post('low', { body: '## 年分\n令和7年分です。' });
  const ranked = freshness.buildCandidates(inputs([high, low], {
    searchSnapshots: [snapshot({ high: 100, low: 50 })],
  }), { now: NOW });
  assert(ranked.find(item => item.slug === 'high').score === 4, '表示 1 位は重み 2 × 係数 2.0');
  assert(ranked.find(item => item.slug === 'low').score === 2, '表示最下位は重み 2 × 係数 1.0');

  const pickup = freshness.buildCandidates(inputs([high, low], {
    searchSnapshots: [snapshot({ high: 100, low: 0 })],
    pickupConfig: { netshop_core: ['low'] },
  }), { now: NOW });
  assert(pickup.find(item => item.slug === 'low').score === 4, '物販中核は表示がなくても係数 2.0');

  const allSignals = post('all-signals', {
    source_urls: ['https://www.nta.go.jp/example'],
    body: '## 改正\n適格請求書等保存方式に係る経過措置の見直し。令和7年分です。',
  });
  const combined = freshness.buildCandidates(inputs([allSignals], {
    sources: [{ url: 'https://www.nta.go.jp/example', fetched_at: '2026-09-10T00:00:00Z', content_changed_at: '2026-09-10T00:00:00Z' }],
    reform: REFORM,
    searchSnapshots: [
      snapshot({ 'all-signals': 100 }), snapshot({ 'all-signals': 80 }),
      snapshot({ 'all-signals': 40 }), snapshot({ 'all-signals': 30 }),
    ],
  }), { now: NOW })[0];
  assert(combined.score === 16, '4 信号の重み合計 8 × 表示 1 位の係数 2.0');
}

console.log('\n=== 4. 対象件数・公開状態 ===');
{
  const many = Array.from({ length: 35 }, (_, index) => post(`old-${String(index).padStart(2, '0')}`, {
    body: '## 過去年\n2025年分です。',
  }));
  many.push(post('draft-old', { review_status: 'draft', body: '## 過去年\n2025年分です。' }));
  const result = freshness.buildCandidates(inputs(many), { now: NOW });
  assert(result.length === 30, '上位 30 件に切り詰める');
  assert(!result.some(item => item.slug === 'draft-old'), 'published 以外は除外する');
}

console.log('\n=== 5. 入力なし・古い入力 ===');
{
  const tmpMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-missing-'));
  const missing = builder.run({ root: tmpMissing, now: NOW, log: () => {} });
  assert(missing.candidates.length === 0 && fs.existsSync(path.join(tmpMissing, 'data/freshness/candidates.json')), '入力が無くても空で正常終了する');
  fs.rmSync(tmpMissing, { recursive: true, force: true });

  const tmpOld = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-old-'));
  const postsDir = path.join(tmpOld, 'content', 'posts');
  const ntaDir = path.join(tmpOld, 'data', 'nta-sources');
  const gscDir = path.join(tmpOld, 'data', 'search-console', '20200101');
  fs.mkdirSync(postsDir, { recursive: true });
  fs.mkdirSync(ntaDir, { recursive: true });
  fs.mkdirSync(gscDir, { recursive: true });
  fs.writeFileSync(path.join(postsDir, '2026-09-01-neutral.md'), [
    '---', 'title: "中立"', 'slug: "neutral"', 'category: "消費税"',
    'tax_domain: "consumption_tax"', 'source_url: "https://www.nta.go.jp/example"',
    'review_status: "published"', 'published_at: "2026-09-01T00:00:00+09:00"',
    '---', '', '## 本文', '適格請求書等保存方式に係る経過措置の見直し', '',
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(path.join(tmpOld, 'data', 'tax-calendar.json'), JSON.stringify(CALENDAR), 'utf8');
  fs.writeFileSync(path.join(ntaDir, 'meta.json'), JSON.stringify({ last_crawl_finished_at: '2020-01-01T00:00:00Z' }), 'utf8');
  fs.writeFileSync(path.join(ntaDir, 'index.json'), JSON.stringify({ entries: [{ url: 'https://www.nta.go.jp/example', fetched_at: '2026-09-10T00:00:00Z' }] }), 'utf8');
  fs.writeFileSync(path.join(tmpOld, 'data', 'tax-reform-outline.json'), JSON.stringify({ ...REFORM, checked_at: '2020-01-01T00:00:00Z' }), 'utf8');
  fs.writeFileSync(path.join(gscDir, 'pages.json'), JSON.stringify(snapshot({ neutral: 100 }, '2020-01-01')), 'utf8');
  const old = builder.run({ root: tmpOld, now: NOW, log: () => {} });
  assert(old.candidates.length === 0, '古い入力は信号にせず空で正常終了する');
  fs.rmSync(tmpOld, { recursive: true, force: true });
}

console.log('\n=== 6. レポートの末尾節 ===');
{
  const candidate = {
    slug: 'report-post', title: 'レポート記事',
    url: 'https://mori-zeirishi.net/blog/report-post/', score: 6, impressions28d: 1234,
    reasons: [{ kind: 'source_updated', detail: 'No.6551が 2026-09-10 に更新', where: '出典欄' }],
  };
  const markdown = reporter.buildReport({
    latest: { fetched_at: '2026-09-27', range: { start: '2026-08-28', end: '2026-09-24' }, property: 'x' },
    queries: [], pages: [], freshnessCandidates: [candidate],
  }).replace(/\r\n/g, '\n');
  assert(markdown.includes('## 更新候補（上位 10）'), '更新候補の節がある');
  assert(markdown.includes('[レポート記事](https://mori-zeirishi.net/blog/report-post/)')
    && markdown.includes('表示 1,234 回') && markdown.includes('No.6551'), '題名リンク・理由・表示回数が出る');
  assert(markdown.indexOf('## 更新候補（上位 10）') > markdown.indexOf('## 索引の状態'), '既存の節の後、末尾に追加する');
}

console.log('\n=== 7. Chatwork 通知 ===');
{
  const candidate = {
    slug: 'notify-post', title: '通知記事', url: 'https://mori-zeirishi.net/blog/notify-post/',
    score: 5, impressions28d: 42,
    reasons: [{ kind: 'fiscal_year', detail: '「令和7年分」を含む', where: '## 手順' }],
  };
  const calls = [];
  const sent = notifier.run({
    candidates: [candidate], prUrl: 'https://github.com/example/pull/1', log: () => {},
    notifyImpl: (args, notification) => { calls.push({ args, notification }); return { status: 0 }; },
  });
  assert(sent.status === 'sent' && calls.length === 1, '候補を 1 通の通知として notify.js 呼び出しへ渡す');
  assert(calls[0].args.includes('freshness_candidates') && calls[0].notification.summary.includes('通知記事')
    && calls[0].notification.summary.includes('理由: 「令和7年分」を含む（## 手順）'), '通知本文に題名・理由を含む');
  const message = buildMessage(calls[0].notification.event, calls[0].notification);
  assert(message.subject === '【ブログ】記事の更新候補があります'
    && message.body.includes('Pull Request: https://github.com/example/pull/1')
    && message.body.includes('本文や更新日はまだ変更していません'), '既存通知基盤で日本語本文を組み立てる');

  let zeroCalls = 0;
  const skipped = notifier.run({ candidates: [], log: () => {}, notifyImpl: () => { zeroCalls++; } });
  assert(skipped.status === 'skipped' && zeroCalls === 0, '候補 0 件なら通知しない');
}

console.log('\n=== 8. 週次ワークフロー ===');
{
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/fetch-search-console.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(workflow.indexOf('node scripts/build-freshness-candidates.js') > workflow.indexOf('node scripts/fetch-search-console.js'), '週次取り込みの後に候補を生成する');
  assert(/git add data\/search-console data\/freshness/.test(workflow), '候補を週次 PR に同乗させる');
  assert(/notify-freshness-candidates\.js/.test(workflow), 'PR 作成後に更新候補を通知する');
  assert(workflow.indexOf('node scripts/update-gsc-topics.js') > workflow.indexOf('node scripts/report-search-console.js'),
    '鮮度候補とレポートの後に GSC 記事候補を更新する');
  assert(workflow.includes('data/gsc-topics.json') && workflow.includes('steps.gsc.outputs.summary'),
    'GSC 候補と新規候補の表を週次 PR に載せる');
  const noKeyBranch = workflow.slice(workflow.indexOf('if [ -z "$GSC_SERVICE_ACCOUNT_JSON" ]'), workflow.indexOf('- name: Create PR'));
  assert(!/SKIP=true|exit 0/.test(noKeyBranch), '鍵が無い週も候補生成まで進む');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
