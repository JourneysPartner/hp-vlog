'use strict';

/**
 * 別表第五の規則が、原文の表を再現することを検証する。
 *   node masters/scripts/__tests__/test-appendix5-rule.js
 *
 * masters/data/salary-income-deduction/appendix5.json は、1,175行の帯表を
 * 「収入を4,000円単位に切り捨ててから給与所得控除の算式を適用する」という規則で持っている。
 * 規則は原文からの導出なので、原文の全帯を fixture として残し、
 * 規則が表を再現し続けることをここで担保する。
 *
 * 改正で規則が崩れた場合（帯の幅が変わる、区間が動く等）、このテストが落ちる。
 */

const fs = require('fs');
const path = require('path');

const MASTERS = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters');
const golden = JSON.parse(fs.readFileSync(path.join(MASTERS, 'fixtures', 'appendix5-r7-golden.json'), 'utf8'));
const apdx = JSON.parse(fs.readFileSync(path.join(MASTERS, 'data', 'salary-income-deduction', 'appendix5.json'), 'utf8'));
const salary = JSON.parse(fs.readFileSync(path.join(MASTERS, 'data', 'salary-income-deduction', 'deductions.json'), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const yen = (m) => BigInt(m.value);

// ── 給与所得控除額（マスターの算式表から組み立てる。数値は直書きしない） ──
function buildDeduction(tiers) {
  const rows = tiers.map(r => ({
    lower: yen(r.revenue_lower_inclusive),
    upper: r.revenue_upper_inclusive ? yen(r.revenue_upper_inclusive) : null,
    type: r.deduction_type,
    fixed: r.fixed_amount ? yen(r.fixed_amount) : null,
    num: r.rate ? BigInt(r.rate.num) : null,
    den: r.rate ? BigInt(r.rate.den) : null,
    add: r.rate_addition ? yen(r.rate_addition) : null,
  })).sort((a, b) => (a.lower < b.lower ? -1 : 1));

  return (revenue) => {
    for (const r of rows) {
      if (revenue < r.lower) continue;
      if (r.upper !== null && revenue > r.upper) continue;
      if (r.type === 'fixed') return r.fixed;
      return (revenue * r.num) / r.den + r.add;   // BigInt 除算は切捨て
    }
    throw new Error(`該当する段階がない: ${revenue}`);
  };
}

// ── 別表第五の規則を、マスターのセグメント定義から実行する ──
function buildAppendix5(segments, deductionOf) {
  const segs = segments.map(s => ({
    lower: yen(s.revenue_lower_inclusive),
    upper: s.revenue_upper_inclusive ? yen(s.revenue_upper_inclusive) : null,
    method: s.method,
    fixedResult: s.fixed_result ? yen(s.fixed_result) : null,
    sub: s.subtract_amount ? yen(s.subtract_amount) : null,
    step: s.band_step ? yen(s.band_step) : null,
    num: s.rate ? BigInt(s.rate.num) : null,
    den: s.rate ? BigInt(s.rate.den) : null,
  })).sort((a, b) => (a.lower < b.lower ? -1 : 1));

  return (revenue) => {
    for (const s of segs) {
      if (revenue < s.lower) continue;
      if (s.upper !== null && revenue > s.upper) continue;
      switch (s.method) {
        case 'fixed_result':
          return s.fixedResult;
        case 'subtract_fixed':
          return revenue - s.sub;
        case 'rate_minus_fixed':
          return (revenue * s.num) / s.den - s.sub;
        case 'floor_to_band_then_deduction_table': {
          const a = (revenue / s.step) * s.step;      // 4,000円単位に切捨て
          return a - deductionOf(a);
        }
        default:
          throw new Error(`未知の method: ${s.method}`);
      }
    }
    throw new Error(`該当するセグメントがない: ${revenue}`);
  };
}

const deductionOf = buildDeduction(salary.r7.records);
const appendix5 = buildAppendix5(apdx.r7.records, deductionOf);

// ── 1. fixture の健全性 ──
console.log('\n=== Test 1: 原文から抽出した表 ===');
assert(golden.band_count === 1175, `帯の数が1,175（実: ${golden.band_count}）`);
assert(golden.bands.length === golden.band_count, '宣言された数と実データ数が一致');
{
  const widths = new Set(golden.bands.map(([f, t]) => t - f));
  assert(widths.size === 1 && widths.has(4000), `帯の幅がすべて4,000円（実: ${[...widths].join(',')}）`);
  let disc = 0;
  for (let i = 0; i < golden.bands.length - 1; i++) {
    if (golden.bands[i][1] !== golden.bands[i + 1][0]) disc++;
  }
  assert(disc === 0, `帯が連続している（不連続 ${disc} 箇所）`);
  assert(golden.bands[0][0] === 1900000, `下端が1,900,000（実: ${golden.bands[0][0]}）`);
  assert(golden.bands[golden.bands.length - 1][1] === 6600000,
    `上端が6,600,000（実: ${golden.bands[golden.bands.length - 1][1]}）`);
}

// ── 2. 規則が原文の全帯を再現する ──
console.log('\n=== Test 2: 規則 vs 原文（1,175帯） ===');
{
  const bad = [];
  for (const [from, to, income] of golden.bands) {
    // 帯の下限・中間・上限直前のいずれでも同じ結果になるはず
    for (const probe of [from, from + 1999, to - 1]) {
      const got = appendix5(BigInt(probe));
      if (got !== BigInt(income)) bad.push({ probe, expected: income, got: String(got) });
    }
  }
  assert(bad.length === 0,
    `全帯・各3点で一致（不一致 ${bad.length} 件${bad.length ? ': ' + JSON.stringify(bad.slice(0, 3)) : ''}）`);
}

// ── 3. 帯の外側の区間 ──
console.log('\n=== Test 3: 帯表の外側 ===');
{
  assert(appendix5(0n) === 0n, '0円 → 給与所得0');
  assert(appendix5(650999n) === 0n, '650,999円 → 0（算式なら999円になるので表が要る）');
  assert(appendix5(651000n) === 1000n, '651,000円 → 1,000円');
  assert(appendix5(1899999n) === 1249999n, '1,899,999円 → 1,249,999円（1円単位・帯にしない）');
  // 6,600,000〜: 収入×90% − 1,100,000
  assert(appendix5(6600000n) === 4840000n, '6,600,000円 → 4,840,000円');
  assert(appendix5(8499999n) === 6549999n, '8,499,999円 → 6,549,999円');
  // 8,500,000〜: 収入 − 1,950,000
  assert(appendix5(8500000n) === 6550000n, '8,500,000円 → 6,550,000円');
  assert(appendix5(20000000n) === 18050000n, '20,000,000円 → 18,050,000円（原文末尾の値と一致）');
}

// ── 4. 算式表をそのまま使うと合わないことの確認 ──
// これが合ってしまうなら別表第五を持つ意味が無い。ずれることを明示的に固定する。
console.log('\n=== Test 4: 算式表で代用した場合との差 ===');
{
  const cases = [3000000n, 4500000n, 5990000n];
  let diffs = 0;
  for (const rev of cases) {
    const byTable = appendix5(rev);
    const byFormula = rev - deductionOf(rev);
    if (byTable !== byFormula) diffs++;
  }
  assert(diffs > 0,
    `算式で代用すると差が出る（${diffs}/${cases.length} 件でずれる → 別表第五が必要）`);
  // 差がどの程度かを記録
  for (const rev of cases) {
    const d = appendix5(rev) - (rev - deductionOf(rev));
    console.log(`      収入 ${rev} 円: 別表第五との差 ${d} 円`);
  }
}

// ── 5. 令和8年版の原本から抽出した検算表 ──
console.log('\n=== Test 5: 令和8年版の検算表の健全性 ===');
const goldenR8 = JSON.parse(fs.readFileSync(path.join(MASTERS, 'fixtures', 'appendix5-r8-golden.json'), 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const appendix5R8 = buildAppendix5(apdx.r8.records, buildDeduction(salary.r8.records));
{
  assert(goldenR8.band_count === goldenR8.bands.length, '令和8年版の宣言された帯数と実データ数が一致');
  assert(same(goldenR8.bands[0], [2026000, 2028000, 1336000]), '最初の帯は2,026,000〜2,028,000円 → 1,336,000円');
  assert(goldenR8.bands.slice(1).every(([from, to]) => to - from === 4000), '最初以外の全帯の幅が4,000円');
  assert(goldenR8.bands.every((band, i, rows) => i === 0 || rows[i - 1][1] === band[0]), '令和8年版の帯が隙間も重なりもなく連続する');
  assert(goldenR8.bands[goldenR8.bands.length - 1][1] === 6600000, '令和8年版の上端は6,600,000円');
  assert(goldenR8.text_rows.zero_below === 691000, '691,000円未満は給与所得0円');
  assert(same(goldenR8.text_rows.subtract_fixed, [691000, 2026000, 690000]), '下側の文の行は691,000〜2,026,000円、690,000円控除');
  assert(same(goldenR8.text_rows.rate_minus_fixed, [6600000, 8500000, 90, 1100000]), '割合の文の行は6,600,000〜8,500,000円、90% − 1,100,000円');
  assert(same(goldenR8.text_rows.subtract_fixed_upper, [8500000, 20000000, 1950000]), '上側の文の行は8,500,000〜20,000,000円、1,950,000円控除');
}

console.log('\n=== Test 6: 令和8年分の規則 vs 原文（220万円以上） ===');
{
  const bands = goldenR8.bands.filter(([from]) => from >= 2200000);
  const bad = [];
  for (const [from, to, income] of bands) {
    for (const probe of [from, from + 1999, to - 1]) {
      const got = appendix5R8(BigInt(probe));
      if (got !== BigInt(income)) bad.push({ probe, expected: income, got: String(got) });
    }
  }
  assert(bands.length === 1100 && bad.length === 0,
    '全' + bands.length + '帯・各3点で一致（不一致 ' + bad.length + '件' + (bad.length ? ': ' + JSON.stringify(bad.slice(0, 3)) : '') + '）');
}

console.log('\n=== Test 7: 令和7年版との差は先頭3帯 ===');
{
  const r7ByLower = new Map(golden.bands.map(band => [band[0], band]));
  const shared = goldenR8.bands.filter(([from]) => from >= 2036000);
  assert(shared.length === 1141 && shared.every(band => same(band, r7ByLower.get(band[0]))), '2,036,000円以上の1,141帯は令和7年版と完全一致');
  const changed = goldenR8.bands.filter(([from]) => from >= 2026000 && from < 2036000);
  assert(changed.length === 3 && changed.every(band => !same(band, r7ByLower.get(band[0]))), '2,026,000〜2,036,000円の3帯は令和7年版と異なる');
}

console.log('\n=== Test 8: 令和8年分の9区分の並びと適用期間 ===');
{
  const records = apdx.r8.records;
  assert(records.length === 9 && records.every((record, i) => record.calculation_order === i + 1), '9件がcalculation_order 1〜9の順');
  assert(yen(records[0].revenue_lower_inclusive) === 0n && records[records.length - 1].revenue_upper_inclusive === null &&
    records.every((record, i) => i === records.length - 1 || (record.revenue_upper_inclusive !== null &&
      yen(record.revenue_upper_inclusive) + 1n === yen(records[i + 1].revenue_lower_inclusive))),
  '下端0円から上限なしまで隙間も重なりもない');
  assert(records.every(record => record.tax_year === 2026 && record.effective_from === '2026-01-01' && record.effective_to === '2026-12-31'), '全9件の対象年と適用期間が令和8年分');
  assert(records.filter(record => record.method === 'floor_to_band_then_deduction_table').length === 1, '帯へ切り捨てて算式表を使う区分はちょうど1件');
}

console.log('\n=== Test 9: 法令の文言から計算した令和8年分の期待値 ===');
{
  // 指示書R4-1の期待値。マスターから期待値を生成しない。
  const cases = [
    [0, 0], [690999, 0], [691000, 0], [740999, 0], [741000, 1000],
    [1000000, 260000], [2190999, 1450999], [2191000, 1451000], [2192999, 1451000],
    [2193000, 1453000], [2195999, 1453000], [2196000, 1456000], [2199999, 1456000],
    [2200000, 1460000], [2203999, 1460000], [2204000, 1462800], [3000000, 2020000],
    [3600000, 2440000], [3603999, 2440000], [3604000, 2443200], [6599999, 4836800],
    [6600000, 4840000], [8499999, 6549999], [8500000, 6550000],
  ];
  for (const [revenue, income] of cases) {
    assert(appendix5R8(BigInt(revenue)) === BigInt(income), '令和8年分の収入 ' + revenue + '円 → 給与所得 ' + income + '円');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
