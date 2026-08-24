#!/usr/bin/env node
/**
 * 語の「珍しさ」表を作る（data/nta-sources/token-df.json）
 *
 * 出典探しの採点で使う。国税庁カタログの本文全体を見て、
 * 「その語が何ページに出てくるか」を数えるだけの表。
 *
 * なぜ必要か:
 *   「課税」は672ページ中360ページに出てくるので、記事と出典ページで
 *   この語が一致しても、そのページを選ぶ理由にならない。
 *   一方「前受金」は3ページにしか出てこないので、一致すれば強い手がかりになる。
 *   ページ名だけから数えるとページ名が短すぎて一般語を抑えきれないため、本文から数える。
 *
 * 出力を小さく保つため、3ページ以上に出てくる語だけを保存する。
 * 表に無い語は「2ページ相当の珍しさ」として扱う（nta-source-matcher 側）。
 *
 * 使い方: node scripts/build-nta-token-df.js
 * カタログを更新したら（crawl-nta-sources.js 実行後）作り直すこと。
 */
const fs = require('fs');
const path = require('path');
const { tokenizeForMatcher } = require('./lib/nta-source-matcher');

const SOURCES_DIR = path.join(__dirname, '..', 'data', 'nta-sources');
const INDEX_PATH = path.join(SOURCES_DIR, 'index.json');
const OUT_PATH = path.join(SOURCES_DIR, 'token-df.json');
const MIN_DF = 3;

// 本文末尾の定型文（全ページ共通なので語の珍しさを歪める）
const BOILERPLATE = ['お問い合わせ先', 'このコンテンツはお役にたちましたか'];

function stripBoilerplate(body) {
  let s = String(body || '');
  for (const marker of BOILERPLATE) {
    const i = s.indexOf(marker);
    if (i > 0) s = s.slice(0, i);
  }
  return s;
}

function build() {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  if (!index || !Array.isArray(index.entries)) throw new Error('index.json の形式が不正です');

  const df = new Map();
  let docs = 0;
  let skipped = 0;

  for (const entry of index.entries) {
    if (entry.type !== 'taxanswer' || entry.deleted === true || !entry.file_path) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(SOURCES_DIR, entry.file_path), 'utf8'));
    } catch (e) {
      skipped++;
      continue;
    }
    docs++;
    for (const token of tokenizeForMatcher(stripBoilerplate(parsed.body))) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  if (docs === 0) throw new Error('本文を1件も読めませんでした');

  const kept = [...df.entries()].filter(([, n]) => n >= MIN_DF).sort((a, b) => b[1] - a[1]);
  const out = { docs, min_df: MIN_DF, generated_from: 'data/nta-sources', df: Object.fromEntries(kept) };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 0) + '\n', 'utf8');

  console.log(`[token-df] 対象ページ: ${docs} 件${skipped ? `（読めず除外 ${skipped} 件）` : ''}`);
  console.log(`[token-df] 語の種類: ${df.size.toLocaleString()} → ${kept.length.toLocaleString()} 語を保存（${MIN_DF}ページ以上に出るもの）`);
  console.log(`[token-df] 出力: ${path.relative(process.cwd(), OUT_PATH)} (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB)`);
}

if (require.main === module) {
  try { build(); } catch (e) { console.error('[token-df] 失敗:', e.message); process.exit(1); }
}
module.exports = { build, stripBoilerplate, MIN_DF };
