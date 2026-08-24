'use strict';

/**
 * 出典と一致を確認したレコードを承認済みにする。
 *
 *   node masters/scripts/approve-records.js                      # 対象の内訳を出すだけ
 *   node masters/scripts/approve-records.js --by "氏名" --write   # 承認を書き込む
 *
 * 承認から外すもの:
 *   - blocked（確認待ち）
 *   - 導出値（_boundary_derived: true）— 出典に書かれていない値を計算で埋めたもの
 *   - source_locator が「未確認」のもの
 *
 * 施行前（legal_status: enacted）のレコードは承認しうる。
 * 「値が確認できたか」（data_review_status）と「適用中か」（legal_status）は別の軸で、
 * 施行前でも出典に金額が明記されていれば値としては確認できるため。
 * 計算エンジンは legal_status を見て、施行前の値を使ったことを結果に表示する。
 */

const fs = require('fs');
const path = require('path');

const MASTERS_DIR = process.env.MASTERS_DIR
  ? path.resolve(process.env.MASTERS_DIR)
  : path.join(__dirname, '..', 'data', 'tax-simulator', 'masters');
const DATA_DIR = path.join(MASTERS_DIR, 'data');

function ls(d) {
  const o = [];
  if (!fs.existsSync(d)) return o;
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) o.push(...ls(p));
    else if (n.endsWith('.json')) o.push(p);
  }
  return o;
}
function collect(node, acc) {
  if (Array.isArray(node)) { node.forEach(i => collect(i, acc)); return acc; }
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.record_id === 'string') { acc.push(node); return acc; }
  Object.values(node).forEach(v => collect(v, acc));
  return acc;
}

/**
 * 承認してよいか。だめなら理由を返す。
 *
 * 導出値（value_certainty: "derived"）は、概算であることを結果に表示できる形に
 * なっていれば承認する。出さないより概算でも出したほうが利用者の役に立つため。
 * 表示の担保が無いまま承認すると、確定値との区別がつかないまま公開されてしまう。
 */
function blocker(rec) {
  if (rec.data_review_status === 'blocked') return '確認待ち（blocked）';
  if (rec.data_review_status === 'approved') return null;         // すでに承認済み
  if (rec._boundary_derived) return '導出値だが value_certainty が未設定';
  if (rec.value_certainty === 'derived') {
    if (rec.requires_result_warning !== true) return '導出値なのに requires_result_warning が立っていない';
    if (!rec._derivation) return '導出値なのに導出の根拠（_derivation）が無い';
    if (!rec._warning_text) return '導出値なのに結果へ出す注記（_warning_text）が無い';
  }
  if (!rec.source_document_id) return '出典が無い';
  if (!rec.source_locator || rec.source_locator === '未確認') return '出典内の位置が未記載';
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--by');
  const by = bi >= 0 ? argv[bi + 1] : null;
  const write = argv.includes('--write');
  const today = new Date().toISOString().slice(0, 10);

  const files = ls(DATA_DIR);
  const target = [];
  const skipped = new Map();
  let already = 0;

  for (const f of files) {
    for (const rec of collect(JSON.parse(fs.readFileSync(f, 'utf8')), [])) {
      if (rec.data_review_status === 'approved') { already++; continue; }
      const b = blocker(rec);
      if (b) {
        if (!skipped.has(b)) skipped.set(b, []);
        skipped.get(b).push(rec.record_id);
      } else {
        target.push({ rec, file: path.relative(MASTERS_DIR, f).replace(/\\/g, '/') });
      }
    }
  }

  // 出典別の内訳
  const bySource = new Map();
  for (const { rec } of target) {
    const k = rec.source_document_id;
    bySource.set(k, (bySource.get(k) || 0) + 1);
  }

  console.log(`承認できる: ${target.length} 件 / すでに承認済み: ${already} 件 / 見送り: ${[...skipped.values()].flat().length} 件\n`);
  console.log('■ 承認対象の出典別内訳');
  [...bySource.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(4)} 件  ${k}`));

  const enacted = target.filter(t => t.rec.legal_status === 'enacted');
  if (enacted.length) {
    console.log(`\n■ うち施行前（legal_status: enacted）: ${enacted.length} 件`);
    enacted.forEach(t => console.log(`    ${t.rec.record_id}`));
  }

  if (skipped.size) {
    console.log('\n■ 見送るもの');
    for (const [reason, ids] of skipped) {
      console.log(`  ${reason}: ${ids.length} 件`);
      ids.forEach(i => console.log(`      ${i}`));
    }
  }

  if (!write) {
    console.log('\n--by "氏名" --write を付けると承認を書き込みます。');
    return;
  }
  if (!by) {
    console.error('\n--write には --by "承認者名" が必要です（verified_by に記録します）。');
    process.exitCode = 1;
    return;
  }

  const ids = new Set(target.map(t => t.rec.record_id));
  let n = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const out = [];
    let cur = null;
    let changed = false;
    for (const line of lines) {
      const idm = line.match(/^\s*"record_id":\s*"([^"]+)",\s*$/);
      if (idm) cur = idm[1];

      const va = line.match(/^(\s*)"verified_at":\s*null,\s*$/);
      if (va && cur && ids.has(cur)) { out.push(`${va[1]}"verified_at": "${today}",`); changed = true; continue; }

      const vb = line.match(/^(\s*)"verified_by":\s*null,\s*$/);
      if (vb && cur && ids.has(cur)) { out.push(`${vb[1]}"verified_by": ${JSON.stringify(by)},`); changed = true; continue; }

      const st = line.match(/^(\s*)"data_review_status":\s*"(?:unverified|single_checked|double_checked)"(,?)\s*$/);
      if (st && cur && ids.has(cur)) {
        out.push(`${st[1]}"data_review_status": "approved"${st[2]}`);
        n++; changed = true; continue;
      }
      out.push(line);
    }
    if (changed) fs.writeFileSync(f, out.join('\n'), 'utf8');
  }
  console.log(`\n${n} 件を承認しました（verified_by: ${by} / verified_at: ${today}）。`);
}

if (require.main === module) main();
