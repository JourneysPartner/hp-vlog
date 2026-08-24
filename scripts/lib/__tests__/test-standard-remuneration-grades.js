'use strict';

/**
 * 標準報酬月額の等級表の検証。
 *   node masters/scripts/__tests__/test-standard-remuneration-grades.js
 *
 * 2026-08-24: 厚生年金の等級表は、法20条1項の本文では第31級（620,000円）までしかない。
 * 現行の第32級（650,000円）は令和2年政令第246号による読替えで加わっている。
 * 法20条2項が「政令で最高等級の上に等級を加える改定を行うことができる」と定めており、
 * 改定しても法本文の表は書き換わらないため、法令原文だけを見ると31等級と誤認する。
 * このテストは、政令の読替えが反映された状態を固定する。
 */

const fs = require('fs');
const path = require('path');

const MASTERS = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters');
const doc = JSON.parse(fs.readFileSync(
  path.join(MASTERS, 'data', 'social-insurance', 'standard-remuneration-grades.json'), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const yen = (m) => (m === null ? null : BigInt(m.value));

/** 等級表の構造を検証する */
function checkTable(records, label, expect) {
  const g = records.map(r => ({
    grade: r.grade,
    std: yen(r.monthly_standard),
    lo: yen(r.remuneration_lower_inclusive),
    hi: yen(r.remuneration_upper_inclusive),
    id: r.record_id,
  })).sort((a, b) => a.grade - b.grade);

  assert(g.length === expect.count, `${label}: ${expect.count}等級（実: ${g.length}）`);
  assert(g.every((x, i) => x.grade === i + 1), `${label}: 等級番号が1から連番`);
  assert(g[0].std === BigInt(expect.min), `${label}: 最下級の標準報酬月額が ${expect.min}（実: ${g[0].std}）`);
  assert(g[g.length - 1].std === BigInt(expect.max), `${label}: 最上級が ${expect.max}（実: ${g[g.length - 1].std}）`);
  assert(g[0].lo === 0n, `${label}: 最下級の報酬月額に下限が無い（0から）`);
  assert(g[g.length - 1].hi === null, `${label}: 最上級の報酬月額に上限が無い`);

  // 報酬月額の範囲が隙間なく連続しているか（上限は 未満値-1 で持つので +1 で次の下限）
  let gaps = 0;
  for (let i = 0; i < g.length - 1; i++) {
    if (g[i].hi === null || g[i].hi + 1n !== g[i + 1].lo) gaps++;
  }
  assert(gaps === 0, `${label}: 報酬月額の範囲が連続（隙間 ${gaps} 箇所）`);

  // 標準報酬月額が単調増加か
  let nonMono = 0;
  for (let i = 0; i < g.length - 1; i++) if (g[i].std >= g[i + 1].std) nonMono++;
  assert(nonMono === 0, `${label}: 標準報酬月額が単調増加（違反 ${nonMono} 箇所）`);

  // 標準報酬月額が自分の報酬月額の範囲に収まっているか
  let outside = 0;
  for (const x of g) {
    if (x.std < x.lo) outside++;
    if (x.hi !== null && x.std > x.hi) outside++;
  }
  assert(outside === 0, `${label}: 標準報酬月額が自分の報酬月額の範囲内（違反 ${outside} 箇所）`);

  return g;
}

console.log('\n=== Test 1: 健康保険（50等級） ===');
checkTable(doc.health_insurance_grades, '健保', { count: 50, min: 58000, max: 1390000 });

console.log('\n=== Test 2: 厚生年金（32等級） ===');
const p = checkTable(doc.employees_pension_grades, '厚年', { count: 32, min: 88000, max: 650000 });

console.log('\n=== Test 3: 政令246号の読替えが反映されているか ===');
{
  const g31 = p.find(x => x.grade === 31);
  const g32 = p.find(x => x.grade === 32);
  assert(g32 !== undefined, '第32級が存在する（法本文の表には無い）');
  assert(g31.hi === 634999n,
    `第31級の報酬月額の上限が634,999円＝635,000円未満（実: ${g31.hi}）— 読替え前は上限なし`);
  assert(g32 && g32.std === 650000n, `第32級の標準報酬月額が650,000円（実: ${g32 && g32.std}）`);
  assert(g32 && g32.lo === 635000n, `第32級の報酬月額が635,000円以上（実: ${g32 && g32.lo}）`);

  const byOrder = doc.employees_pension_grades.filter(r => r.source_document_id === 'EGOV-PENSION-GRADE-ORDER-R2');
  assert(byOrder.length === 2, `政令を出典とするのは第31級・第32級の2件（実: ${byOrder.length}）`);
  assert(byOrder.every(r => r.effective_from === '2020-09-01'), '政令の施行日が令和2年9月1日');
}

console.log('\n=== Test 4: 等級の引き当て ===');
{
  const lookup = (grades, remuneration) => {
    const r = BigInt(remuneration);
    for (const x of grades) {
      if (r < x.lo) continue;
      if (x.hi !== null && r > x.hi) continue;
      return x;
    }
    return null;
  };
  const h = doc.health_insurance_grades.map(r => ({
    grade: r.grade, std: yen(r.monthly_standard),
    lo: yen(r.remuneration_lower_inclusive), hi: yen(r.remuneration_upper_inclusive),
  })).sort((a, b) => a.grade - b.grade);

  assert(lookup(h, 0).grade === 1, '健保: 報酬0円 → 第1級');
  assert(lookup(h, 62999).grade === 1, '健保: 62,999円 → 第1級');
  assert(lookup(h, 63000).grade === 2, '健保: 63,000円 → 第2級');
  assert(lookup(h, 300000).std === 300000n, '健保: 300,000円 → 標準報酬月額300,000円');
  assert(lookup(h, 99999999).grade === 50, '健保: 上限超 → 第50級');

  assert(lookup(p, 0).grade === 1, '厚年: 報酬0円 → 第1級');
  assert(lookup(p, 634999).grade === 31, '厚年: 634,999円 → 第31級（620,000円）');
  assert(lookup(p, 635000).grade === 32, '厚年: 635,000円 → 第32級（650,000円）');
  assert(lookup(p, 99999999).std === 650000n, '厚年: 上限超 → 650,000円で頭打ち');

  // 健保と厚年で同じ報酬でも等級・標準報酬月額が違う
  assert(lookup(h, 700000).std !== lookup(p, 700000).std,
    '同じ報酬700,000円でも健保と厚年で標準報酬月額が違う（取り違え防止）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
