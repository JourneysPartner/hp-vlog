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

function buildReport({ latest, queries, pages, previousQueries = null }) {
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
  const md = buildReport({ latest, queries, pages, previousQueries });
  fs.writeFileSync(path.join(outRoot, 'report.md'), md, 'utf8');
  (options.log || console.log)(`[gsc] → data/search-console/report.md（前回: ${prevDir || 'なし'}）`);
  return { status: 'written', prevDir };
}

if (require.main === module) run();

module.exports = { run, buildReport, pageKind };
