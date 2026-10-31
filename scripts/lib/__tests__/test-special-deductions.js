'use strict';

/**
 * 配偶者特別控除・特定親族特別控除の検証（所得税と住民税）。
 *   node scripts/lib/__tests__/test-special-deductions.js
 *
 * 住民税側は地方税法の算式（端数調整付き）から段階に展開している。
 * 展開が正しいかを、所得税側（No.1195・No.1177。別の出典）との一致で確かめる。
 * 所得税は表として公表されており、住民税は算式なので、出所が独立している。
 * 両者は高所得側の段で同額になるはずで、そこがずれれば展開を間違えている。
 */

const fs = require('fs');
const path = require('path');

const M = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data');
const itSpouse = JSON.parse(fs.readFileSync(path.join(M, 'income-deduction', 'spouse-special-deduction.json'), 'utf8'));
const itRel = JSON.parse(fs.readFileSync(path.join(M, 'income-deduction', 'specific-relative-deduction.json'), 'utf8'));
const rt = JSON.parse(fs.readFileSync(path.join(M, 'resident-tax', 'special-deductions.json'), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const yen = (m) => (m === null ? null : BigInt(m.value));

/** 計算年の期間と重なる記録だけを返す。nullの端点は無期限。 */
function recordsForYear(records, year) {
  const from = year + '-01-01';
  const to = year + '-12-31';
  return records.filter(record =>
    (record.effective_from === null || record.effective_from <= to) &&
    (record.effective_to === null || record.effective_to >= from)
  );
}

/** 段階表から引く。本人の所得と（あれば）相手の所得で選ぶ */
function lookup(records, selfIncome, otherIncome) {
  const s = BigInt(selfIncome);
  for (const r of records) {
    const lo = yen(r.income_lower_inclusive);
    const hi = yen(r.income_upper_inclusive);
    if (s < lo) continue;
    if (hi !== null && s > hi) continue;
    if (otherIncome !== undefined) {
      const o = BigInt(otherIncome);
      const conds = r.applicability_conditions || [];
      const ok = conds.every(c => {
        const v = BigInt(c.value.value);
        if (c.operator === 'gte') return o >= v;
        if (c.operator === 'lte') return o <= v;
        return true;
      });
      if (!ok) continue;
    }
    return yen(r.deduction_amount);
  }
  return null;
}

console.log('\n=== Test 1: 所得税の配偶者特別控除 ===');
{
  const R = recordsForYear(itSpouse.records, 2025);
  assert(R.length === 36, `36件（27通り＋適用なし9件。実: ${R.length}）`);
  assert(lookup(R, 0, 600000) === 380000n, '2025年: 配偶者60万円は58万円超なので配偶者特別控除38万円');
  // 出典の表の代表点
  assert(lookup(R, 0, 900000) === 380000n, '本人900万以下 × 配偶者95万以下 → 38万円');
  assert(lookup(R, 0, 960000) === 360000n, '本人900万以下 × 配偶者95万超100万以下 → 36万円');
  assert(lookup(R, 9200000, 900000) === 260000n, '本人900万超950万以下 × 配偶者95万以下 → 26万円');
  assert(lookup(R, 9800000, 900000) === 130000n, '本人950万超1000万以下 × 配偶者95万以下 → 13万円');
  assert(lookup(R, 0, 1320000) === 30000n, '配偶者130万超133万以下 → 3万円');
  assert(lookup(R, 10500000, 900000) === 0n, '本人1,000万円超は適用なし');
}

console.log('\n=== Test 2: 所得税の特定親族特別控除 ===');
{
  const R = recordsForYear(itRel.records, 2025);
  assert(lookup(R, 500000) === 0n, '特定親族の所得58万円以下は0円（扶養控除の対象なので重複適用しない）');
  assert(lookup(R, 580000) === 0n, '境界: ちょうど58万円は0円');
  assert(lookup(R, 580001) === 630000n, '境界: 58万円を1円超えると63万円');
  assert(lookup(R, 800000) === 630000n, '58万超85万以下 → 63万円');
  assert(lookup(R, 870000) === 610000n, '85万超90万以下 → 61万円');
  assert(lookup(R, 1220000) === 30000n, '120万超123万以下 → 3万円');
  assert(lookup(R, 1300000) === 0n, '123万円超は特定親族に該当しない');
}

console.log('\n=== Test 3: 住民税の配偶者特別控除（算式からの展開） ===');
{
  const R = rt.spouse_special.records;
  assert(R.length === 32, `8段階 × 4区分 ＝ 32件（実: ${R.length}）`);
  assert(lookup(R, 0, 900000) === 330000n, '本人900万以下 × 配偶者100万以下 → 33万円（配偶者控除と同額）');
  assert(lookup(R, 0, 1020000) === 310000n, '配偶者100万超105万以下 → 31万円');
  assert(lookup(R, 0, 1320000) === 30000n, '配偶者130万超133万以下 → 3万円');
  assert(lookup(R, 10500000, 900000) === 0n, '本人1,000万円超は適用なし');

  // 2/3・1/3 の按分と1万円未満切上げ
  assert(lookup(R, 9200000, 900000) === 220000n, '本人900万超950万以下 → 33万×2/3 ＝ 22万円');
  assert(lookup(R, 9800000, 900000) === 110000n, '本人950万超1000万以下 → 33万×1/3 ＝ 11万円');
  assert(lookup(R, 9200000, 1020000) === 210000n,
    '本人900万超 × 31万 → 31万×2/3＝206,666円を1万円未満切上げで21万円');
}

console.log('\n=== Test 4: 住民税の特定親族特別控除（算式からの展開） ===');
{
  const R = rt.specific_relative_special.records;
  assert(lookup(R, 900000) === 450000n, '所得95万以下 → 45万円（特定扶養親族の扶養控除と同額）');
  assert(lookup(R, 960000) === 410000n, '95万超100万以下 → 41万円');
  assert(lookup(R, 1160000) === 60000n, '115万超120万以下 → 6万円');
  assert(lookup(R, 1220000) === 30000n, '120万超123万以下 → 3万円');
  assert(lookup(R, 1300000) === 0n, '123万円超は特定親族に該当しない');
}

console.log('\n=== Test 5: 所得税と住民税の突き合わせ（展開の裏付け） ===');
for (const year of [2025, 2026]) {
  console.log('  対象年: ' + year);
  // 所得税は表（No.1195）、住民税は算式（地税法34条1項10号の2）で出所が違う。
  // 配偶者の所得が100万円を超える範囲では両者が同額になるはず。
  const IT = recordsForYear(itSpouse.records, year), RT = rt.spouse_special.records;
  const probes = [1020000, 1070000, 1120000, 1170000, 1220000, 1270000, 1320000];
  let mismatch = 0;
  for (const spouseIncome of probes) {
    for (const selfIncome of [0, 9200000, 9800000]) {
      const a = lookup(IT, selfIncome, spouseIncome);
      const b = lookup(RT, selfIncome, spouseIncome);
      if (a !== b) { mismatch++; console.log(`      不一致: 配偶者${spouseIncome} 本人${selfIncome} 所得税${a} 住民税${b}`); }
    }
  }
  assert(mismatch === 0,
    `配偶者所得100万円超では所得税と住民税が同額（不一致 ${mismatch} 件／${probes.length * 3} 点）`);

  // 100万円以下では違う（住民税33万 vs 所得税38万・36万）
  assert(lookup(IT, 0, 900000) !== lookup(RT, 0, 900000),
    '配偶者所得95万以下では所得税38万・住民税33万で異なる');

  // 特定親族特別控除も95万円超では一致するはず
  const ITR = recordsForYear(itRel.records, year), RTR = rt.specific_relative_special.records;
  let relMismatch = 0;
  for (const income of [960000, 1020000, 1070000, 1120000, 1160000, 1220000]) {
    const a = lookup(ITR, income), b = lookup(RTR, income);
    if (a !== b) { relMismatch++; console.log(`      不一致: 特定親族${income} 所得税${a} 住民税${b}`); }
  }
  assert(relMismatch === 0,
    `特定親族の所得95万円超では所得税と住民税が同額（不一致 ${relMismatch} 件）`);

  assert(lookup(ITR, 800000) !== lookup(RTR, 800000),
    '特定親族の所得85万以下では所得税63万・住民税45万で異なる');
}

console.log('\n=== Test 6: 段階の連続性 ===');
{
  // 所得が1軸のもの（特定親族特別控除）は income_lower/upper で連続性を見る
  for (const [label, records] of [
    ['住民税 特定親族特別控除', rt.specific_relative_special.records],
    ['所得税2025年 特定親族特別控除', recordsForYear(itRel.records, 2025)],
    ['所得税2026年 特定親族特別控除', recordsForYear(itRel.records, 2026)],
  ]) {
    const sorted = records
      .map(r => ({ lo: yen(r.income_lower_inclusive), hi: yen(r.income_upper_inclusive) }))
      .sort((a, b) => (a.lo < b.lo ? -1 : 1));
    let gaps = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].hi === null || sorted[i].hi + 1n !== sorted[i + 1].lo) gaps++;
    }
    assert(gaps === 0, `${label}: 段階に隙間が無い（隙間 ${gaps} 箇所）`);
  }

  // 配偶者特別控除は2軸。配偶者の所得は applicability_conditions 側にあるので
  // そちらで連続性を見る。本人の所得は同じ4区分が全帯で繰り返される。
  for (const [label, records] of [
    ['住民税 配偶者特別控除', rt.spouse_special.records],
    ['所得税2025年 配偶者特別控除', recordsForYear(itSpouse.records, 2025)],
    ['所得税2026年 配偶者特別控除', recordsForYear(itSpouse.records, 2026)],
  ]) {
    const spouseBands = new Map();
    for (const r of records) {
      const c = r.applicability_conditions || [];
      const lo = c.find(x => x.operator === 'gte');
      const hi = c.find(x => x.operator === 'lte');
      if (!lo || !hi) continue;
      spouseBands.set(`${lo.value.value}-${hi.value.value}`,
        { lo: BigInt(lo.value.value), hi: BigInt(hi.value.value) });
    }
    const sorted = [...spouseBands.values()].sort((a, b) => (a.lo < b.lo ? -1 : 1));
    let gaps = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].hi + 1n !== sorted[i + 1].lo) gaps++;
    }
    assert(gaps === 0, `${label}: 配偶者の所得の帯に隙間が無い（${sorted.length}帯・隙間 ${gaps} 箇所）`);
    assert(sorted[sorted.length - 1].hi === 1330000n,
      `${label}: 上端が133万円（実: ${sorted[sorted.length - 1].hi}）`);

    // 本人の所得の区分は全帯で同じ4段階が並ぶ
    const selfTiers = new Set(records.map(r =>
      `${r.income_lower_inclusive.value}-${r.income_upper_inclusive ? r.income_upper_inclusive.value : 'null'}`));
    assert(selfTiers.size === 4, `${label}: 本人の所得区分が4種（実: ${selfTiers.size}）`);
  }
}


console.log('\n=== Test 7: 令和8年分の配偶者特別控除・特定親族特別控除 ===');
{
  assert(itSpouse.records.length === 40, '配偶者特別控除は全40件');
  assert(itRel.records.length === 13, '特定親族特別控除は全13件');
  const spouse = recordsForYear(itSpouse.records, 2026);
  const relative = recordsForYear(itRel.records, 2026);
  assert(spouse.length === 36, '2026年の配偶者特別控除は36件');
  assert(relative.length === 11, '2026年の特定親族特別控除は11件');
  for (const [self, other, expected] of [
    [0, 620000, null], [0, 620001, 380000n],
    [9200000, 620001, 260000n], [9800000, 620001, 130000n],
    [10500000, 620001, 0n], [0, 600000, null],
    [0, 960000, 360000n], [0, 1320000, 30000n],
  ]) {
    assert(lookup(spouse, self, other) === expected,
      '2026年: 本人' + self + '円・配偶者' + other + '円 → ' + expected);
  }
  for (const [income, expected] of [
    [500000, 0n], [600000, 0n], [620000, 0n], [620001, 630000n],
    [850000, 630000n], [850001, 610000n], [1220000, 30000n], [1300000, 0n],
  ]) {
    assert(lookup(relative, income) === expected,
      '2026年: 特定親族' + income + '円 → ' + expected + '円');
  }
}

console.log('\n=== Test 8: 期間の切れ目と重複 ===');
{
  const relativeIds = ['IDED-SPECREL-T00', 'IDED-SPECREL-T01'];
  const spouseIds = [1, 2, 3, 4].map(n => 'IDED-SPOUSE-SP-S01-T' + n);
  for (const [records, ids] of [[itRel.records, relativeIds], [itSpouse.records, spouseIds]]) {
    for (const id of ids) {
      const old = records.filter(record => record.record_id === id);
      const newId = id.replace('IDED-SPECREL-', 'IDED-SPECREL-R8-')
        .replace('IDED-SPOUSE-SP-', 'IDED-SPOUSE-SP-R8-');
      const added = records.filter(record => record.record_id === newId);
      assert(old.length === 1 && old[0].effective_to === '2025-12-31', id + 'は2025年末で閉じる');
      assert(added.length === 1 && added[0].effective_from === '2026-01-01' &&
        added[0].effective_to === null, newId + 'は2026年から無期限');
    }
  }
  for (const year of [2025, 2026, 2027]) {
    const spouse = recordsForYear(itSpouse.records, year);
    const relative = recordsForYear(itRel.records, year);
    for (const other of [0, 580000, 580001, 600000, 620000, 620001, 950000, 950001, 1330000]) {
      for (const self of [0, 9000000, 9000001, 9500001, 10000001]) {
        const hits = spouse.filter(record => lookup([record], self, other) !== null);
        assert(hits.length <= 1, year + '年: 本人' + self + '円・配偶者' + other + '円の重複なし');
      }
    }
    for (const income of [0, 580000, 580001, 620000, 620001, 850000, 850001, 1230000, 1230001]) {
      const hits = relative.filter(record => lookup([record], income) !== null);
      assert(hits.length <= 1, year + '年: 特定親族' + income + '円の重複なし');
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
