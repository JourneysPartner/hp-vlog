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
const { readAllPosts } = require('./lib/site-corpus');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'data', 'search-console');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
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
    ? table(['検索語', '表示', 'クリック', '順位'], growable.map(q => [q.query, n(q.impressions), n(q.clicks), pos(q.position)]))
    : '（該当なし）');
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
  const md = buildReport({
    latest,
    queries,
    pages,
    previousQueries,
    indexStatus,
    previousIndexStatus: previousIndexEntry ? previousIndexEntry.data : null,
    indexHistory: indexSnapshots.map(entry => entry.data),
    posts: readAllPosts(),
    pickupConfig,
    freshnessCandidates,
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
};
