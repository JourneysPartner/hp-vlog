'use strict';

/**
 * 協会けんぽの都道府県別 健康保険料率を取得して、マスターと突合する。
 *
 *   node masters/scripts/fetch-kenpo-rates.js                 # 突合のみ（既存マスターと比較）
 *   node masters/scripts/fetch-kenpo-rates.js --year r09      # 別年度のページを見る
 *   node masters/scripts/fetch-kenpo-rates.js --write         # 差分をマスターへ反映
 *
 * 料率は法定ではなく協会が支部ごとに決めるため（健保160条1項）、法令からは取れない。
 * 保険料額表のPDFはCIDフォントで機械抽出できないが、料率一覧はHTMLの表なので解析できる。
 * モデルにページを読ませるのではなく表を解析するので、転記ミスが入らない。
 *
 * 毎年3月頃に翌年度分が公表される。鮮度チェック（check-master-freshness）が
 * 3月に予告を出すので、それを受けてこのスクリプトを走らせる。
 */

const fs = require('fs');
const path = require('path');

const MASTERS_DIR = process.env.MASTERS_DIR
  ? path.resolve(process.env.MASTERS_DIR)
  : path.join(__dirname, '..', 'data', 'tax-simulator', 'masters');
const TARGET = path.join(MASTERS_DIR, 'data', 'social-insurance', 'health-insurance-rates.json');

const BASE = 'https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures';

// 全角 → 半角、％除去
const z2h = (s) => s
  .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  .replace(/[．]/g, '.')
  .replace(/[％%]/g, '');

async function fetchHtml(url, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'tax-simulator-master-fetch' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(s => setTimeout(s, 2000 * i));
    }
  }
}

/** 料率一覧の表から [{name, rates:[前年度, 当年度]}] を取り出す */
function parseRates(html) {
  const table = (html.match(/<table[\s\S]*?<\/table>/gi) || [])
    .find(t => /北海道/.test(t) && /沖縄/.test(t));
  if (!table) throw new Error('都道府県の料率表が見つからない（ページ構成が変わった可能性）');

  const out = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 2) continue;
    const name = cells[0];
    if (!/[都道府県]$/.test(name)) continue;
    const nums = cells.slice(1).map(z2h).filter(c => /^\d+\.\d+$/.test(c)).map(Number);
    if (nums.length === 0) continue;
    out.push({ name, rates: nums });
  }
  return out;
}

function toRate(pct) {
  const [a, b = ''] = String(pct).split('.');
  return { num: String(Number(a + (b + '00').slice(0, 2))), den: '10000' };
}

async function main() {
  const argv = process.argv.slice(2);
  const yi = argv.indexOf('--year');
  const year = yi >= 0 ? argv[yi + 1] : 'r08';
  const write = argv.includes('--write');

  const url = `${BASE}/${year}`;
  console.log(`取得: ${url}`);
  const html = await fetchHtml(url);
  const rows = parseRates(html);
  console.log(`表から抽出: ${rows.length} 都道府県`);

  if (rows.length !== 47) {
    console.error(`::error::47都道府県が揃っていません（${rows.length} 件）。ページ構成の変化を疑ってください。`);
    process.exitCode = 1;
    return;
  }

  // 健保160条1項の法定範囲
  const outOfRange = rows.flatMap(r => r.rates.filter(v => v < 3.0 || v > 13.0).map(v => `${r.name} ${v}%`));
  if (outOfRange.length) {
    console.error(`::error::法定範囲（3%〜13%）外の値: ${outOfRange.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(TARGET)) {
    console.log(`\nマスターが未作成: ${TARGET}`);
    console.log(rows.map(r => `  ${r.name} ${r.rates.join(' → ')}`).join('\n'));
    return;
  }

  // ── 既存マスターと突合 ──
  const master = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const byKey = new Map();
  for (const rec of master.records) {
    byKey.set(`${rec.prefecture_name}|${rec.tax_year}`, {
      pct: Number(rec.rate.num) / Number(rec.rate.den) * 100,
      rec,
    });
  }
  // 表の最終列が当年度、その手前が前年度
  const years = [...new Set(master.records.map(r => r.tax_year))].sort();
  const latest = years[years.length - 1];

  let matched = 0;
  const diffs = [];
  const additions = [];
  for (const r of rows) {
    const current = r.rates[r.rates.length - 1];
    const found = byKey.get(`${r.name}|${latest}`);
    if (!found) { additions.push(`${r.name} ${current}%`); continue; }
    if (Math.abs(found.pct - current) < 1e-9) matched++;
    else diffs.push({ name: r.name, master: found.pct, page: current, rec: found.rec });
  }

  console.log(`\n${latest}年度との突合: 一致 ${matched}/47`);
  if (additions.length) console.log(`マスターに無い: ${additions.length} 件 — ${additions.join(', ')}`);
  if (diffs.length) {
    console.log(`不一致 ${diffs.length} 件:`);
    diffs.forEach(d => console.log(`  - ${d.name}: マスター ${d.master}% / ページ ${d.page}%`));
  }

  if (diffs.length === 0 && additions.length === 0) {
    console.log('マスターは最新です。');
  } else if (write) {
    for (const d of diffs) {
      d.rec.rate = toRate(d.page);
      d.rec.as_of_date = new Date().toISOString().slice(0, 10);
      d.rec.data_review_status = 'unverified';   // 値が変わったら承認をやり直す
    }
    fs.writeFileSync(TARGET, JSON.stringify(master, null, 2) + '\n', 'utf8');
    console.log(`\n${diffs.length} 件を更新しました。data_review_status を unverified に戻しています。`);
    console.log('新年度分の追加が要る場合は、レコードを作ってから再実行してください。');
  } else {
    console.log('\n--write を付けると差分を反映します（承認状態は unverified に戻ります）。');
  }

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    fs.appendFileSync(ghOut, `matched=${matched}\n`);
    fs.appendFileSync(ghOut, `diffs=${diffs.length}\n`);
  }
  if (diffs.length) process.exitCode = 1;
}

module.exports = { parseRates, toRate };

if (require.main === module) {
  main().catch(e => { console.error(`[kenpo] 失敗: ${e.message}`); process.exit(1); });
}
