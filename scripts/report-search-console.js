#!/usr/bin/env node
'use strict';

/**
 * サーチコンソールの週次レポート（2026-09-03 並行A R3）
 *
 *   node scripts/report-search-console.js
 *
 * data/search-console/latest.json が指す取り込み結果から data/search-console/report.md を作る。
 *   ・検索語の上位30（表示回数順）
 *   ・伸ばしやすい語（順位11〜30位で表示回数が多いもの）
 *   ・ページ別の上位30
 *   ・ページ種別ごとの合計（トップ／サービス／業種ハブ／記事／ツール…）
 *   ・前回との差分（新しく表示され始めた検索語）
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { readAllPosts } = require('./lib/site-corpus');
const { normalizeQuery } = require('./lib/target-query');
const { locateQuery } = require('./lib/query-placement');
const { normalizeBold } = require('./lib/cjk-bold');
const { hubMacroOf, assignHubMacro } = require('./lib/hub-membership');
const { linkInternal, blogLinkTargets, readInternalLinkTerms, readInternalLinkPlacements } = require('./lib/internal-linker');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'data', 'search-console');
const DEFAULT_LINK_CONFIG = Object.freeze({
  position_min: 4, position_max: 20, min_impressions: 20,
  target_macros: ['小売', '建設'],
  exclude_slugs: [
    'ebay-export-consumption-tax-refund-complete-guide', 'ebay-taxable-vs-exempt-business',
    'ebay-export-invoice-system-impact', 'ebay-growth-incorporation-threshold-guide',
    'ebay-growth-expense-grayzone-guide',
  ],
  exclude_until: '2026-11-30', min_query_tokens: 3,
  question_words: ['どっち', 'とは', 'いつまで', 'しないと', 'どうなる', 'ばれ', 'バレ', 'いくら', '必要', '違い', 'やり方', '方法', 'かかる', 'できる', '?', '？'],
});

function readLinkConfig(filePath = path.join(ROOT, 'data', 'gsc-link-config.json')) {
  try { return { ...DEFAULT_LINK_CONFIG, ...readJson(filePath) }; }
  catch (_) { return { ...DEFAULT_LINK_CONFIG }; }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/**
 * Bing の取り込み（data/bing-webmaster/）を読む。無い・読めない・壊れているときは null。
 * 個々のファイルが読めないときは、その項目だけ null にする。
 */
function readBingData(bingRoot) {
  try {
    const latestPath = path.join(bingRoot, 'latest.json');
    if (!fs.existsSync(latestPath)) return null;
    const latest = readJson(latestPath);
    if (!latest || typeof latest !== 'object' || typeof latest.fetched_at !== 'string') return null;
    const files = latest.files && typeof latest.files === 'object' ? latest.files : {};
    const read = (key) => {
      const rel = files[key];
      if (typeof rel !== 'string' || !rel) return null;
      try { return readJson(path.join(bingRoot, rel)); } catch (_) { return null; }
    };
    return {
      latest,
      traffic: read('traffic'),
      queries: read('queries'),
      pages: read('pages'),
      crawl: read('crawl'),
      feeds: read('feeds'),
    };
  } catch (_) {
    return null;
  }
}

function n(v) { return Number(v || 0).toLocaleString('ja-JP'); }
function pct(v) { return `${(Number(v || 0) * 100).toFixed(1)}%`; }
function pos(v) { return Number(v || 0).toFixed(1); }

/** URL をページ種別に分ける（sitemap と同じ区分） */
function pageKind(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch (_) { p = String(url || ''); }
  if (p === '/' || p === '/index.html') return 'トップ';
  if (p.startsWith('/services/') || p === '/services.html' || p.startsWith('/pricing')) return 'サービス';
  if (p === '/blog/macro/' || p.startsWith('/blog/macro/')) return '業種ハブ';
  if (p.startsWith('/blog/category/')) return 'カテゴリ';
  if (p === '/blog/' || p.startsWith('/blog/page/')) return '記事一覧';
  if (p.startsWith('/blog/')) return '記事';
  if (p.startsWith('/tools/')) return 'ツール';
  if (p.startsWith('/area')) return '対応地域';
  return 'その他';
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function previousDir(outRoot, currentDir) {
  const dirs = fs.readdirSync(outRoot).filter(d => /^\d{8}$/.test(d) && d < currentDir).sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

function isIndexed(row = {}) {
  if (row.error) return false;
  return row.verdict === 'PASS' || /送信して登録されました|インデックス登録済み/.test(row.coverage || '');
}

function indexBucket(row = {}) {
  if (row.error) return 'failed';
  if (isIndexed(row)) return 'indexed';
  if (/検出.*インデックス未登録/.test(row.coverage || '')) return 'discovered';
  if (/Google に認識されていません/.test(row.coverage || '')) return 'unknown';
  return 'other';
}

function indexCounts(snapshot) {
  const counts = { indexed: 0, discovered: 0, unknown: 0, other: 0, failed: 0 };
  for (const row of (snapshot && snapshot.rows) || []) counts[indexBucket(row)]++;
  return counts;
}

function signed(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : `−${Math.abs(number)}`;
}

function articleSlug(url) {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch (_) { pathname = String(url || ''); }
  const match = pathname.match(/^\/blog\/([^/]+)\/?$/);
  if (!match || ['macro', 'category', 'page'].includes(match[1])) return '';
  return match[1];
}

function isPublishedPost(meta, now = new Date()) {
  if (!meta || meta.review_status !== 'published') return false;
  if (!meta.publish_at) return true;
  const publishAt = new Date(meta.publish_at);
  return Number.isNaN(publishAt.getTime()) || publishAt <= now;
}

/** 公開中の記事本文を1回だけ読み、slug で引ける形にする。 */
function readPublishedPostContents(postsDir = path.join(ROOT, 'content', 'posts'), now = new Date()) {
  const contents = new Map();
  if (!fs.existsSync(postsDir)) return contents;
  for (const file of fs.readdirSync(postsDir).filter(name => name.endsWith('.md')).sort()) {
    try {
      const parsed = matter(fs.readFileSync(path.join(postsDir, file), 'utf8'));
      if (!parsed.data.slug || !isPublishedPost(parsed.data, now)) continue;
      const body = String(parsed.content || '');
      const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim());
      contents.set(String(parsed.data.slug), {
        title: String(parsed.data.title || ''),
        headings,
        body,
        metadata: parsed.data,
      });
    } catch (_) {
      // 1記事が壊れていても週次レポートは継続する。
    }
  }
  return contents;
}

function contentForSlug(postContents, slug) {
  if (postContents instanceof Map) return postContents.get(slug);
  return postContents && postContents[slug];
}

function bestImpressionPage(query, queryPages) {
  const key = normalizeQuery(query);
  return (Array.isArray(queryPages) ? queryPages : [])
    .filter(row => row && normalizeQuery(row.query) === key)
    .sort((a, b) => Number(b.impressions || 0) - Number(a.impressions || 0)
      || Number(a.position || Infinity) - Number(b.position || Infinity))[0] || null;
}

function growableDetails(queryRow, queryPages, postContents) {
  if (!Array.isArray(queryPages)) return ['（不明）', '（不明）', '（不明）'];
  const page = bestImpressionPage(queryRow.query, queryPages);
  if (!page) return ['（不明）', '（不明）', '（不明）'];
  const kind = pageKind(page.page);
  if (kind !== '記事') return [kind, '（不明）', '該当ページの文面'];

  const slug = articleSlug(page.page);
  const content = contentForSlug(postContents, slug);
  if (!slug || !content) return [slug || '（不明）', '（不明）', '（不明）'];
  const location = locateQuery(queryRow.query, content);
  const locationLabel = { title: 'title', h2: 'h2', body: '本文', none: '無し' }[location];
  let recommendation = '題名の見直し';
  if (location === 'title') recommendation = '見出しと本文の充実';
  else if (location === 'none') recommendation = Number(queryRow.position || 0) <= 20 ? 'h2 の追加' : '新記事の候補';
  return [slug, locationLabel, recommendation];
}

function buildTargetQuerySection(posts, queries) {
  const targets = (Array.isArray(posts) ? posts : [])
    .filter(post => post && post.target_query && isPublishedPost(post));
  const lines = ['## 狙った語の順位', ''];
  if (targets.length === 0) {
    lines.push('（対象の記事はまだありません）');
    return lines;
  }
  const rows = targets.map(post => {
    const key = normalizeQuery(post.target_query);
    const hit = (Array.isArray(queries) ? queries : [])
      .filter(row => row && normalizeQuery(row.query) === key)
      .sort((a, b) => Number(b.impressions || 0) - Number(a.impressions || 0))[0];
    return hit
      ? [post.slug, post.target_query, pos(hit.position), n(hit.impressions), n(hit.clicks)]
      : [post.slug, post.target_query, '表示なし', '0', '0'];
  });
  lines.push(table(['記事', '狙った語', '順位', '表示', 'クリック'], rows));
  return lines;
}

function newlyIndexed(current, previous) {
  if (!current || !previous) return [];
  const previousByUrl = new Map((previous.rows || []).map(row => [row.url, row]));
  return (current.rows || []).filter(row => {
    const before = previousByUrl.get(row.url);
    return before && !isIndexed(before) && isIndexed(row);
  });
}

function buildIndexStatusSection({ current, previous = null, history = [], posts = [], pickupConfig = {} }) {
  const lines = ['## 索引の状態', ''];
  if (!current || !Array.isArray(current.rows)) {
    lines.push('（索引状態は未取得です）');
    return lines;
  }

  const currentCounts = indexCounts(current);
  const previousCounts = previous ? indexCounts(previous) : null;
  const labels = [
    ['indexed', '索引済み'],
    ['discovered', '検出 - 未登録'],
    ['unknown', 'Google 未認識'],
    ['other', 'その他'],
    ['failed', '取得失敗'],
  ];
  lines.push('### 合計');
  lines.push('');
  for (const [key, label] of labels) {
    const comparison = previousCounts ? `（前回比 ${signed(currentCounts[key] - previousCounts[key])}）` : '';
    lines.push(`- ${label}: ${n(currentCounts[key])}${comparison}`);
  }

  const kinds = new Map();
  for (const row of current.rows) {
    const kind = row.kind || 'その他';
    const value = kinds.get(kind) || { total: 0, indexed: 0 };
    value.total++;
    if (isIndexed(row)) value.indexed++;
    kinds.set(kind, value);
  }
  lines.push('');
  lines.push('### 種別ごと');
  lines.push('');
  lines.push(kinds.size
    ? table(['種別', '件数', '索引済み', '索引率'], [...kinds.entries()].map(([kind, value]) => [
      kind, n(value.total), n(value.indexed), pct(value.total ? value.indexed / value.total : 0),
    ]))
    : '（対象 URL がありません）');

  const postBySlug = new Map(posts.map(post => [post.slug, post]));
  const months = new Map();
  for (const row of current.rows.filter(item => item.kind === '記事')) {
    const post = postBySlug.get(articleSlug(row.url));
    const date = post && (post.published_at || post.publish_at || post.created_at);
    const month = date && /^\d{4}-\d{2}/.test(String(date)) ? String(date).slice(0, 7) : '不明';
    const value = months.get(month) || { total: 0, indexed: 0 };
    value.total++;
    if (isIndexed(row)) value.indexed++;
    months.set(month, value);
  }
  lines.push('');
  lines.push('### 記事の公開月ごと');
  lines.push('');
  const monthRows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  lines.push(monthRows.length
    ? table(['公開月', '件数', '索引済み'], monthRows.map(([month, value]) => [month, n(value.total), n(value.indexed)]))
    : '（記事 URL がありません）');

  const newRows = newlyIndexed(current, previous).slice(0, 30);
  lines.push('');
  lines.push('### 今週 新しく索引に入った URL');
  lines.push('');
  if (!previous) lines.push('（前回の索引状態が無いため比較できません）');
  else if (newRows.length === 0) lines.push('（該当なし）');
  else newRows.forEach(row => lines.push(`- ${row.url}`));

  const coreSlugs = new Set(Array.isArray(pickupConfig.netshop_core) ? pickupConfig.netshop_core : []);
  const important = current.rows.filter(row => {
    if (row.error || isIndexed(row)) return false;
    return ['サービス', '料金', '対応地域', '業種ハブ', 'ツール'].includes(row.kind) || coreSlugs.has(articleSlug(row.url));
  });
  lines.push('');
  lines.push('### 未索引の重要ページ');
  lines.push('');
  if (important.length === 0) lines.push('（該当なし）');
  else important.forEach(row => lines.push(`- ${row.url}（${row.coverage || '状態不明'}）`));

  const snapshots = history.filter(snapshot => snapshot && Array.isArray(snapshot.rows));
  const pace = [];
  for (let i = 1; i < snapshots.length; i++) pace.push(newlyIndexed(snapshots[i], snapshots[i - 1]).length);
  const recentPace = pace.slice(-4);
  if (recentPace.length === 4) {
    const average = recentPace.reduce((sum, value) => sum + value, 0) / recentPace.length;
    const unindexed = currentCounts.discovered + currentCounts.unknown + currentCounts.other;
    lines.push('');
    lines.push('### 待ち行列の目安');
    lines.push('');
    lines.push(average > 0
      ? `未索引 ${n(unindexed)} 件。直近 4 回の平均は週 ${average.toFixed(1)} 件で、このペースだと約 ${Math.ceil(unindexed / average)} 週です。`
      : `未索引 ${n(unindexed)} 件。直近 4 回に新しく索引へ入った URL がないため、目安は算出できません。`);
  }

  return lines;
}

function markdownLabel(value) {
  return String(value || '').replace(/[\[\]]/g, '');
}

/** Bing の節で使う小さな整形（数・順位・日付）。 */
function bingNumber(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : n(value);
}

function bingPosition(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : pos(value);
}

function bingSum(rows, key) {
  const values = rows.map(row => row && row[key]).filter(value => typeof value === 'number' && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function bingFetchedDay(latest) {
  const at = String((latest && latest.fetched_at) || '');
  return /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : '—';
}

/** GSC の取得が Bing より 3 日を超えて新しい = 今週の Bing の取り込みが失敗したか未設定。 */
function bingIsStale(latest, gscLatest) {
  const bingAt = Date.parse(latest && latest.fetched_at);
  const gscAt = Date.parse(gscLatest && gscLatest.fetched_at);
  if (!Number.isFinite(bingAt) || !Number.isFinite(gscAt)) return false;
  return (gscAt - bingAt) > 3 * 86400000;
}

/**
 * 「Bing の数字」の節（2026-11-13 bing-weekly R10）。
 * 置き場所は「索引の状態」の後、「更新候補（上位 10）」の前。
 */
function buildBingSection({ bing = null, gscLatest = null, gscPages = null } = {}) {
  const lines = ['## Bing の数字（Bing Webmaster Tools）', ''];
  if (!bing || !bing.latest) {
    lines.push('（Bing はまだ取り込まれていません。設定は docs/search-console-setup.md の「Bing Webmaster Tools の取り込み」を参照）');
    return lines;
  }

  const latest = bing.latest;
  const sections = latest.sections || {};
  const window = latest.window || null;

  if (bingIsStale(latest, gscLatest)) {
    lines.push(`**今週の Bing の取り込みは失敗したか未設定です。以下は ${bingFetchedDay(latest)} の取り込みの数字です。**`);
    lines.push('');
  }

  lines.push(`- 取得日時: ${latest.fetched_at}`);
  if (!window) {
    lines.push('- 期間: （まだ数字がありません）');
  } else {
    lines.push(`- 期間: ${window.start} 〜 ${window.end}（Bing が返した日数 ${bingNumber(window.days_reported)}/28）`);
    const conflicts = Array.isArray(window.conflicting_dates) ? window.conflicting_dates : [];
    if (conflicts.length) lines.push(`- Bing の数字が食い違ったため除いた日: ${conflicts.join(', ')}`);
    const totals = latest.totals || {};
    lines.push(`- 表示 ${n(totals.impressions)} ／ クリック ${n(totals.clicks)}（ウェブのほか、チャット・ニュース・画像・動画・ナレッジパネルの表示も含みます）`);
  }
  if (Array.isArray(gscPages) && gscLatest && gscLatest.range) {
    const impressions = gscPages.reduce((sum, row) => sum + Number((row && row.impressions) || 0), 0);
    const clicks = gscPages.reduce((sum, row) => sum + Number((row && row.clicks) || 0), 0);
    lines.push(`- 参考: Google（ページ別の合計、${gscLatest.range.start}〜${gscLatest.range.end}）表示 ${n(impressions)} ／ クリック ${n(clicks)}`);
  }
  lines.push('- AI の回答での引用（AI Performance）は API で取れないため、月 1 回 Bing の画面で確かめます。');

  const queryRows = bing.queries && Array.isArray(bing.queries.rows) ? bing.queries.rows : null;
  lines.push('');
  lines.push('### 検索語の上位 20（表示回数順）');
  lines.push('');
  if (sections.queries && sections.queries.status === 'failed') {
    lines.push(`（取得に失敗しました: ${sections.queries.reason || '理由不明'}）`);
  } else if (!queryRows || queryRows.length === 0) {
    lines.push('（まだデータがありません）');
  } else {
    const queriesSection = sections.queries || {};
    lines.push(`Bing は週ごとに上位の検索語だけを返すため、この表の合計は全体の数ではありません（期間内の週 ${n(queriesSection.weeks)}、うち上限に達した週 ${n(queriesSection.weeks_at_cap)}）。`);
    lines.push('');
    lines.push(table(['検索語', '表示', 'クリック', '平均順位'], queryRows.slice(0, 20).map(row => [
      linkCell(row.query), n(row.impressions), n(row.clicks), bingPosition(row.position),
    ])));
  }

  const pageRows = bing.pages && Array.isArray(bing.pages.rows) ? bing.pages.rows : null;
  lines.push('');
  lines.push('### ページの上位 20（クリック順）');
  lines.push('');
  if (sections.pages && sections.pages.status === 'failed') {
    lines.push(`（取得に失敗しました: ${sections.pages.reason || '理由不明'}）`);
  } else if (!pageRows || pageRows.length === 0) {
    lines.push('（まだデータがありません）');
  } else {
    const top = [...pageRows]
      .sort((a, b) => Number(b.clicks || 0) - Number(a.clicks || 0)
        || Number(b.impressions || 0) - Number(a.impressions || 0))
      .slice(0, 20);
    lines.push(table(['ページ', '種別', 'クリック', '表示', '平均順位'], top.map(row => [
      linkCell(row.page), pageKind(row.page), n(row.clicks), n(row.impressions), bingPosition(row.position),
    ])));
  }

  const crawlRows = bing.crawl && Array.isArray(bing.crawl.rows)
    ? [...bing.crawl.rows].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    : null;
  lines.push('');
  lines.push('### 巡回とサイトマップ');
  lines.push('');
  if (sections.crawl && sections.crawl.status === 'failed') {
    lines.push(`（取得に失敗しました: ${sections.crawl.reason || '理由不明'}）`);
  } else if (!crawlRows || crawlRows.length === 0) {
    lines.push('（まだデータがありません）');
  } else {
    const first = crawlRows[0];
    const lastRow = crawlRows[crawlRows.length - 1];
    const difference = typeof lastRow.InIndex === 'number' && typeof first.InIndex === 'number'
      ? lastRow.InIndex - first.InIndex : null;
    lines.push(`- 索引にあるページ（InIndex）: ${bingNumber(lastRow.InIndex)}（期間の初日 ${bingNumber(first.InIndex)}、差 ${difference === null ? '—' : signed(difference)}）`);
    lines.push(`- 期間の合計: 巡回したページ ${bingNumber(bingSum(crawlRows, 'CrawledPages'))} ／ 巡回の誤り ${bingNumber(bingSum(crawlRows, 'CrawlErrors'))} ／ 4xx ${bingNumber(bingSum(crawlRows, 'Code4xx'))} ／ 5xx ${bingNumber(bingSum(crawlRows, 'Code5xx'))} ／ robots.txt で止めた ${bingNumber(bingSum(crawlRows, 'BlockedByRobotsTxt'))}`);
    lines.push(`- 被リンク（InLinks、最新の日）: ${bingNumber(lastRow.InLinks)}`);
    const crawlConflicts = sections.crawl && Array.isArray(sections.crawl.conflicting_dates)
      ? sections.crawl.conflicting_dates : [];
    if (crawlConflicts.length) lines.push(`- 巡回の数字が食い違ったため除いた日: ${crawlConflicts.join(', ')}`);
  }

  const feedRows = bing.feeds && Array.isArray(bing.feeds.rows) ? bing.feeds.rows : [];
  lines.push('');
  if (sections.feeds && sections.feeds.status === 'failed') {
    lines.push(`（取得に失敗しました: ${sections.feeds.reason || '理由不明'}）`);
  } else if (feedRows.length === 0) {
    lines.push('（サイトマップの記録はありません）');
  } else {
    lines.push(table(['サイトマップ', '種類', '状態', '最後の読み込み', 'URL 数'], feedRows.map(row => [
      linkCell(row.Url), linkCell(row.Type), linkCell(row.Status),
      row.LastCrawled ? String(row.LastCrawled) : '—', bingNumber(row.UrlCount),
    ])));
  }

  return lines;
}

function buildFreshnessSection(candidates = []) {
  const lines = ['## 更新候補（上位 10）', ''];
  const top = Array.isArray(candidates) ? candidates.slice(0, 10) : [];
  if (top.length === 0) {
    lines.push('（該当なし）');
    return lines;
  }
  for (const candidate of top) {
    const reasons = (candidate.reasons || [])
      .map(reason => `${reason.detail}${reason.where ? `（${reason.where}）` : ''}`)
      .join('／');
    lines.push(`- [${markdownLabel(candidate.title || candidate.slug)}](${candidate.url}) — スコア ${candidate.score}、表示 ${n(candidate.impressions28d)} 回`);
    lines.push(`  - 理由: ${reasons || '理由なし'}`);
  }
  return lines;
}

// ビルドは呼ばず、同じ公開判定・本文・中核記事・リンク処理で集計する。
function calculateBodyLinks({ posts = [], postContents = new Map(), terms = [], placements = [], pickupConfig = {}, now = new Date() }) {
  const isPublished = post => post.review_status === 'published' && !!post.publish_at && new Date(post.publish_at) <= now;
  const published = posts.map(post => {
    const content = contentForSlug(postContents, post.slug);
    return { ...(content && content.metadata || post), _body: content ? content.body : post._body || '' };
  }).filter(isPublished).sort((a, b) => new Date(b.publish_at) - new Date(a.publish_at));
  assignHubMacro(published);
  const postsMap = new Map(published.map(post => [post.slug, post]));
  const coreSlugs = new Set((pickupConfig.netshop_core || []).filter(slug => postsMap.has(slug)));
  const incoming = new Map();
  const applied = new Set();
  for (const post of published) {
    const result = linkInternal(normalizeBold(post._body), { terms, placements, post, postsMap, isPublished, hubMacroOf, coreSlugs });
    for (const target of blogLinkTargets(result.markdown)) {
      const sources = incoming.get(target) || new Set();
      sources.add(post.slug);
      incoming.set(target, sources);
    }
    for (const id of result.stats.placements.linkedIds) applied.add(id);
  }
  return { incoming, applied };
}

function linkCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function buildInternalLinkSections({ pages, queries, queryPages, posts, postContents, pickupConfig,
  indexStatus, linkTerms = [], placements = [], linkConfig = DEFAULT_LINK_CONFIG, now = new Date() }) {
  const config = { ...DEFAULT_LINK_CONFIG, ...linkConfig };
  const { incoming, applied } = calculateBodyLinks({ posts, postContents, terms: linkTerms, placements, pickupConfig, now });
  const postBySlug = new Map(posts.map(post => [post.slug, post]));
  const pageBySlug = new Map(pages.filter(row => pageKind(row.page) === '記事').map(row => [articleSlug(row.page), row]));
  const indexBySlug = new Map(((indexStatus && indexStatus.rows) || []).map(row => [articleSlug(row.url), row]));
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const lines = ['## 内部リンクの候補（順位 4〜20 位）', '',
    'Claude がこの表と本文を読んでリンク案（リンク元・言い回し・行き先）を作り、承認されたものを data/internal-link-placements.json に足します。', ''];
  const candidates = pages.filter(row => pageKind(row.page) === '記事'
    && row.position >= config.position_min && row.position <= config.position_max && row.impressions >= config.min_impressions)
    .sort((a, b) => b.impressions - a.impressions).slice(0, 20);
  lines.push(candidates.length ? table(['記事', '業種', '表示', 'クリック', '順位', 'Google 登録', '本文からのリンク数', '主な検索語', '今回の対象'], candidates.map(row => {
    const slug = articleSlug(row.page);
    const post = postBySlug.get(slug);
    const content = contentForSlug(postContents, slug);
    const macro = post ? hubMacroOf(content && content.metadata || post) : '不明';
    const index = indexBySlug.get(slug);
    const target = today < config.exclude_until && config.exclude_slugs.includes(slug)
      ? 'eBay の確認中' : (config.target_macros.includes(macro) ? '○' : '業種外');
    const topQueries = (queryPages || []).filter(q => articleSlug(q.page) === slug)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 3).map(q => linkCell(q.query));
    return [linkCell(post && post.title || slug), macro, n(row.impressions), n(row.clicks), pos(row.position),
      !index || index.error ? '不明' : isIndexed(index) ? '○' : '×',
      n((incoming.get(slug) || new Set()).size), topQueries.join('、') || '（伏せられています）', target];
  })) : '（該当なし）');
  lines.push('', '## 足したリンクのその後', '');
  const groups = new Map();
  for (const entry of placements.filter(entry => entry.enabled !== false)) {
    const rows = groups.get(entry.target) || [];
    rows.push(entry); groups.set(entry.target, rows);
  }
  const metrics = row => row ? `${pos(row.position)} / ${n(row.impressions)} / ${n(row.clicks)}` : '—';
  lines.push(groups.size ? table(['行き先', 'リンク元の数（実際/指定）', '追加日', '経過週', '基準の順位・表示・クリック', '今の順位・表示・クリック', '順位の差'], [...groups].map(([slug, rows]) => {
    const ordered = [...rows].sort((a, b) => a.added_at.localeCompare(b.added_at));
    const earliest = ordered[0];
    const baselineEntry = ordered.find(entry => entry.baseline && Number.isFinite(entry.baseline.position));
    const baseline = baselineEntry && baselineEntry.baseline;
    const current = pageBySlug.get(slug);
    // 表示と同じ小数第1位で比べる（8.4 と 8.44 を「悪化」と書かない）。
    const delta = baseline && current ? Math.round((baseline.position - current.position) * 10) / 10 : null;
    const weeks = Math.max(0, Math.floor((Date.parse(today) - Date.parse(earliest.added_at)) / (7 * 86400000)));
    return [linkCell(postBySlug.get(slug) && postBySlug.get(slug).title || slug),
      `${rows.filter(entry => applied.has(entry.id)).length}/${rows.length}`, earliest.added_at, n(weeks),
      metrics(baseline), metrics(current), delta === null ? '—' : delta > 0 ? `+${pos(delta)} 位改善` : delta < 0 ? `−${pos(-delta)} 位悪化` : '0.0 位（変化なし）'];
  })) : '（まだありません）');
  const queryImpressions = queries.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  const pageImpressions = pages.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  lines.push('', '## 長い質問の検索語', '',
    `Google は件数の少ない検索語を伏せるため、ここに出るのは一部です（この期間の表示の約 ${pageImpressions ? (100 * queryImpressions / pageImpressions).toFixed(1) + '%' : '—（ページの表示なし）'}）。`, '');
  const aiQuery = row => Array.from(String(row.query)).length > 60 || /question:/i.test(row.query);
  const longQueries = [...queries].filter(row => aiQuery(row)
    || String(row.query).trim().split(/[\s\u3000]+/).filter(Boolean).length >= config.min_query_tokens
    || config.question_words.some(word => String(row.query).includes(word)))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 20);
  const queryTable = rows => rows.length ? table(['検索語', '表示', 'クリック', '順位', '該当ページ'], rows.slice(0, 20).map(row => {
    const page = bestImpressionPage(row.query, queryPages);
    return [linkCell(row.query), n(row.impressions), n(row.clicks), pos(row.position),
      page ? linkCell(pageKind(page.page) === '記事' ? articleSlug(page.page) : page.page) : '—'];
  })) : '（該当なし）';
  lines.push(queryTable(longQueries.filter(row => !aiQuery(row))), '', '### AI が代わりに検索したとみられる語', '', queryTable(longQueries.filter(aiQuery)));
  lines.push('', '## 辞書の行き先の点検', '');
  const enabledTerms = linkTerms.filter(entry => entry.enabled !== false);
  const problems = enabledTerms.flatMap(entry => {
    const post = postBySlug.get(entry.slug);
    let status = '';
    if (!post) status = '行き先がありません';
    else if (post.review_status === 'merged') status = `統合済み${post.merged_into ? `（${post.merged_into}）` : ''}`;
    else if (post.review_status !== 'published' || !post.publish_at || !(new Date(post.publish_at) <= now)) status = '未公開・取り下げ';
    return status ? [[linkCell(entry.term), linkCell(entry.slug), linkCell(status)]] : [];
  });
  lines.push(problems.length ? table(['語', '行き先', '状態'], problems) : '（問題ありません）');
  const unseen = new Set(enabledTerms.map(entry => entry.slug).filter(slug => !pageBySlug.has(slug) || !(pageBySlug.get(slug).impressions > 0)));
  lines.push('', `この期間に表示が無い辞書の行き先: ${n(unseen.size)} 件`);
  return lines;
}

function buildReport({
  latest,
  queries,
  pages,
  previousQueries = null,
  indexStatus = null,
  previousIndexStatus = null,
  indexHistory = [],
  posts = [],
  pickupConfig = {},
  freshnessCandidates = [],
  queryPages = null,
  postContents = new Map(),
  linkTerms = [], placements = [], linkConfig = DEFAULT_LINK_CONFIG, bing = null, now = new Date(),
}) {
  const byImp = [...queries].sort((a, b) => b.impressions - a.impressions);
  const top30 = byImp.slice(0, 30);
  const growable = byImp.filter(q => q.position >= 11 && q.position <= 30).slice(0, 20);
  const pageTop = [...pages].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 30);

  const kinds = new Map();
  for (const p of pages) {
    const k = pageKind(p.page);
    const cur = kinds.get(k) || { clicks: 0, impressions: 0, pages: 0 };
    cur.clicks += p.clicks; cur.impressions += p.impressions; cur.pages += 1;
    kinds.set(k, cur);
  }
  const kindRows = [...kinds.entries()].sort((a, b) => b[1].impressions - a[1].impressions);

  let newQueries = [];
  if (previousQueries) {
    const prev = new Set(previousQueries.map(q => q.query));
    newQueries = byImp.filter(q => !prev.has(q.query)).slice(0, 30);
  }

  const lines = [];
  lines.push(`# サーチコンソール 週次レポート`);
  lines.push('');
  lines.push(`- 取得日時: ${latest.fetched_at}`);
  lines.push(`- 期間: ${latest.range.start} 〜 ${latest.range.end}（28日）`);
  lines.push(`- プロパティ: ${latest.property}`);
  lines.push(`- 検索語 ${n(queries.length)} 行 ／ ページ ${n(pages.length)} 行`);
  lines.push('');
  lines.push('## 検索語の上位30（表示回数順）');
  lines.push('');
  lines.push(top30.length
    ? table(['検索語', '表示', 'クリック', 'CTR', '順位'], top30.map(q => [q.query, n(q.impressions), n(q.clicks), pct(q.ctr), pos(q.position)]))
    : '（まだデータがありません）');
  lines.push('');
  lines.push('## 伸ばしやすい語（順位11〜30位で表示回数が多いもの）');
  lines.push('');
  lines.push('順位を上げればクリックが増えやすい語です。該当する記事・サービスページの見出しと本文を見直す候補になります。');
  lines.push('');
  lines.push(growable.length
    ? table(['検索語', '表示', 'クリック', '順位', '該当ページ', '語の所在', '推奨'], growable.map(q => [
      q.query, n(q.impressions), n(q.clicks), pos(q.position),
      ...growableDetails(q, queryPages, postContents),
    ]))
    : '（該当なし）');
  lines.push('');
  lines.push(...buildTargetQuerySection(posts, queries));
  lines.push('');
  lines.push(...buildInternalLinkSections({ pages, queries, queryPages, posts, postContents, pickupConfig,
    indexStatus, linkTerms, placements, linkConfig, now }));
  lines.push('');
  lines.push('## ページ別の上位30（クリック順）');
  lines.push('');
  lines.push(pageTop.length
    ? table(['ページ', '種別', 'クリック', '表示', '順位'], pageTop.map(p => [p.page, pageKind(p.page), n(p.clicks), n(p.impressions), pos(p.position)]))
    : '（まだデータがありません）');
  lines.push('');
  lines.push('## ページ種別ごとの合計');
  lines.push('');
  lines.push(kindRows.length
    ? table(['種別', 'ページ数', 'クリック', '表示'], kindRows.map(([k, v]) => [k, n(v.pages), n(v.clicks), n(v.impressions)]))
    : '（まだデータがありません）');
  lines.push('');
  lines.push('## 前回との差分（新しく表示され始めた検索語）');
  lines.push('');
  if (!previousQueries) lines.push('（前回の取り込みが無いため比較できません）');
  else if (newQueries.length === 0) lines.push('（新しい検索語はありません）');
  else lines.push(table(['検索語', '表示', '順位'], newQueries.map(q => [q.query, n(q.impressions), pos(q.position)])));
  lines.push('');
  lines.push(...buildIndexStatusSection({
    current: indexStatus,
    previous: previousIndexStatus,
    history: indexHistory,
    posts,
    pickupConfig,
  }));
  lines.push('');
  // Bing の節は、data/bing-webmaster/ の中身が壊れていてもレポート全体を止めない（R15）。
  try {
    lines.push(...buildBingSection({ bing, gscLatest: latest, gscPages: pages }));
  } catch (_) {
    lines.push('## Bing の数字（Bing Webmaster Tools）', '',
      '（Bing の数字を読めませんでした。data/bing-webmaster/ の中身を確かめてください）');
  }
  lines.push('');
  lines.push(...buildFreshnessSection(freshnessCandidates));
  lines.push('');
  return lines.join('\n');
}

function run(options = {}) {
  const outRoot = options.outRoot || OUT_ROOT;
  const latestPath = path.join(outRoot, 'latest.json');
  if (!fs.existsSync(latestPath)) {
    (options.log || console.log)('[gsc] latest.json が無いためレポートを作りません');
    return { status: 'skipped' };
  }
  const latest = readJson(latestPath);
  const queries = readJson(path.join(outRoot, latest.files.queries)).rows;
  const pages = readJson(path.join(outRoot, latest.files.pages)).rows;
  const queryPageRel = latest.files && latest.files['query-page'];
  const queryPagePath = typeof queryPageRel === 'string' ? path.join(outRoot, queryPageRel) : '';
  const queryPages = Array.isArray(queryPageRel)
    ? queryPageRel
    : (queryPagePath && fs.existsSync(queryPagePath) ? readJson(queryPagePath).rows : null);
  const currentDir = latest.files.queries.split('/')[0];
  const prevDir = previousDir(outRoot, currentDir);
  const previousQueries = prevDir && fs.existsSync(path.join(outRoot, prevDir, 'queries.json'))
    ? readJson(path.join(outRoot, prevDir, 'queries.json')).rows : null;

  const indexRel = latest.files.indexStatus;
  const indexPath = indexRel ? path.join(outRoot, indexRel) : '';
  const indexStatus = indexPath && fs.existsSync(indexPath) ? readJson(indexPath) : null;
  const indexDir = indexRel ? indexRel.split('/')[0] : currentDir;
  const indexSnapshots = fs.readdirSync(outRoot)
    .filter(dir => /^\d{8}$/.test(dir) && dir <= indexDir && fs.existsSync(path.join(outRoot, dir, 'index-status.json')))
    .sort()
    .map(dir => ({ dir, data: readJson(path.join(outRoot, dir, 'index-status.json')) }));
  const previousIndexEntry = [...indexSnapshots].reverse().find(entry => entry.dir < indexDir);
  const pickupPath = path.join(ROOT, 'data', 'pickup-posts.json');
  const pickupConfig = fs.existsSync(pickupPath) ? readJson(pickupPath) : {};
  const freshnessPath = options.freshnessPath || path.join(outRoot, '..', 'freshness', 'candidates.json');
  let freshnessCandidates = [];
  try {
    const freshness = readJson(freshnessPath);
    freshnessCandidates = Array.isArray(freshness.candidates) ? freshness.candidates : [];
  } catch (_) {
    freshnessCandidates = [];
  }
  const posts = readAllPosts();
  const postContents = readPublishedPostContents();
  const bingRoot = options.bingRoot || path.join(ROOT, 'data', 'bing-webmaster');
  const bing = readBingData(bingRoot);
  const md = buildReport({
    latest,
    queries,
    pages,
    previousQueries,
    indexStatus,
    previousIndexStatus: previousIndexEntry ? previousIndexEntry.data : null,
    indexHistory: indexSnapshots.map(entry => entry.data),
    posts,
    queryPages,
    postContents,
    pickupConfig,
    freshnessCandidates,
    bing,
    linkTerms: readInternalLinkTerms(path.join(ROOT, 'data', 'internal-link-terms.json')),
    placements: readInternalLinkPlacements(path.join(ROOT, 'data', 'internal-link-placements.json')),
    linkConfig: readLinkConfig(options.linkConfigPath),
  });
  fs.writeFileSync(path.join(outRoot, 'report.md'), md, 'utf8');
  (options.log || console.log)(`[gsc] → data/search-console/report.md（前回: ${prevDir || 'なし'}）`);
  return { status: 'written', prevDir };
}

if (require.main === module) run();

module.exports = {
  run,
  buildReport,
  pageKind,
  isIndexed,
  indexBucket,
  indexCounts,
  newlyIndexed,
  buildIndexStatusSection,
  buildFreshnessSection,
  buildBingSection,
  readBingData,
  articleSlug,
  readPublishedPostContents,
  bestImpressionPage,
  growableDetails,
  buildTargetQuerySection,
  DEFAULT_LINK_CONFIG,
  readLinkConfig,
  calculateBodyLinks,
  buildInternalLinkSections,
};
