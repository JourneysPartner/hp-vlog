'use strict';

/**
 * 国税庁の法令解釈通達（基本通達）を取得してカタログ化する。
 *
 *   node scripts/crawl-nta-tsutatsu.js                 # 全対象を取得
 *   node scripts/crawl-nta-tsutatsu.js --only shotoku  # 1つだけ
 *   node scripts/crawl-nta-tsutatsu.js --limit 5       # 動作確認用に節ページを5件だけ
 *
 * 背景（2026-08-20〜21）:
 *   通達に関する誤りが2日続けて出た。
 *     所基通37-14 を「按分が必要」と書いた（実際は継続適用が条件の任意の取扱い）
 *     商品券の「発行」を非課税と書いた（実際は不課税。消基通6-4-5）
 *   タックスアンサー番号はカタログで実在を照合できるが、通達番号は照合できず、
 *   1つ間違えても検出されないまま公開されていた。
 *
 * 方針:
 *   - タックスアンサーのカタログ（data/nta-sources）と同じ考え方
 *   - 条番号 → 見出し・本文・URL の対応表を作る
 *   - 記事の主出典（source_url）には使わない。引用の照合と原文の提示に使う
 */

const fs = require('fs');
const path = require('path');
const {
  parseTsutatsuPage, parseIndexPage, normalizeProvisionNo,
} = require('./lib/tsutatsu-parser');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'nta-tsutatsu');

// 対象。まず所得税・消費税から始める（読者が個人事業主中心のため）。
// 問題なく取得できたら法人税・相続税を追加する。
const CIRCULARS = {
  shotoku: {
    label: '所得税基本通達',
    short: '所基通',
    index: 'https://www.nta.go.jp/law/tsutatsu/kihon/shotoku/01.htm',
  },
  shohi: {
    label: '消費税法基本通達',
    short: '消基通',
    index: 'https://www.nta.go.jp/law/tsutatsu/kihon/shohi/01.htm',
  },
};

const SLEEP_MS = 1000;   // 1 秒 1 リクエスト
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchShiftJis(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'hp-vlog-tsutatsu-crawler' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 通達ページは Shift_JIS。meta で UTF-8 を名乗るページがあれば従う。
  const head = buf.slice(0, 1024).toString('latin1');
  const enc = /charset=utf-?8/i.test(head) ? 'utf-8' : 'shift_jis';
  return new TextDecoder(enc).decode(buf);
}

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function crawlCircular(key, def, limit) {
  console.log(`\n=== ${def.label} ===`);
  const indexHtml = await fetchShiftJis(def.index);
  let urls = parseIndexPage(indexHtml, key, def.index);
  if (limit) urls = urls.slice(0, limit);
  console.log(`  節ページ: ${urls.length} 件`);

  const provisions = [];
  const errors = [];
  let done = 0;

  for (const url of urls) {
    try {
      const html = await fetchShiftJis(url);
      const parsed = parseTsutatsuPage(html, { url, circular: key });
      for (const p of parsed.provisions) {
        provisions.push({ ...p, section: parsed.sectionTitle });
      }
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${urls.length} …`);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
    await sleep(SLEEP_MS);
  }

  // 条番号の重複を検出（同じ番号が2箇所に出るのは解析ミスの兆候）
  const byNo = new Map();
  const duplicates = [];
  for (const p of provisions) {
    if (byNo.has(p.no)) duplicates.push(p.no);
    else byNo.set(p.no, p);
  }

  console.log(`  取得: ${provisions.length} 条 / 重複 ${duplicates.length} / エラー ${errors.length}`);
  if (errors.length) errors.slice(0, 5).forEach(e => console.warn(`    ⚠ ${e}`));

  return { key, def, urls, provisions, duplicates, errors };
}

async function main() {
  const only = getArg('--only');
  const limit = Number(getArg('--limit')) || 0;
  const targets = Object.entries(CIRCULARS).filter(([k]) => !only || k === only);
  if (targets.length === 0) throw new Error(`--only の指定が不正: ${only}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index = [];
  let totalErrors = 0;

  for (const [key, def] of targets) {
    const r = await crawlCircular(key, def, limit);
    totalErrors += r.errors.length;

    // 本文は通達ごとに1ファイル。条番号で引ける形にする。
    const bodyPath = path.join(OUT_DIR, `${key}.json`);
    const byNo = {};
    for (const p of r.provisions) {
      // 同じ番号が複数あれば、本文が長いほうを残す（切れた抽出を採らない）
      if (!byNo[p.no] || p.body.length > byNo[p.no].body.length) {
        byNo[p.no] = { no: p.no, title: p.title, body: p.body, url: p.url, section: p.section };
      }
    }
    fs.writeFileSync(bodyPath, `${JSON.stringify({
      circular: key,
      label: def.label,
      short: def.short,
      index_url: def.index,
      fetched_at: new Date().toISOString(),
      section_pages: r.urls.length,
      provisions: byNo,
    }, null, 2)}\n`, 'utf8');

    index.push({
      circular: key,
      label: def.label,
      short: def.short,
      index_url: def.index,
      file: `${key}.json`,
      section_pages: r.urls.length,
      provision_count: Object.keys(byNo).length,
      errors: r.errors.length,
      fetched_at: new Date().toISOString(),
    });
    console.log(`  → ${path.relative(ROOT, bodyPath)}（${Object.keys(byNo).length} 条）`);
  }

  const indexPath = path.join(OUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`\n[tsutatsu] 目次: ${path.relative(ROOT, indexPath)}`);

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    const total = index.reduce((a, b) => a + b.provision_count, 0);
    fs.appendFileSync(ghOut, `provisions=${total}\n`);
    fs.appendFileSync(ghOut, `errors=${totalErrors}\n`);
  }

  if (totalErrors > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[tsutatsu] 失敗: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { CIRCULARS, crawlCircular, normalizeProvisionNo };
