'use strict';

/**
 * 国民健康保険の市町村別料率マスターの検証。
 *   node scripts/lib/__tests__/test-nhi-municipal-rates.js
 *
 * 間違えやすい点を固定する。
 *   - 賦課方式が自治体で違う（平等割の有無、区分ごとの有無）
 *   - 政令の賦課限度額は上限であって、市町村はそれより低く定められる（大阪市の医療分66万円）
 *   - 所得割の基数は住民税の課税所得ではなく「総所得金額等 − 基礎控除43万円」
 *   - 自治体を変えると概算額が数万円単位で変わる
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters');
const load = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', ...p), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const doc = load('social-insurance', 'nhi-municipal-rates.json');
const capsDoc = load('social-insurance', 'national-health-insurance.json');
const recs = doc.records;
const yen = (m) => BigInt(m.value);
const rateOf = (r) => [BigInt(r.num), BigInt(r.den)];

const MUNI = {
  '13113': '東京都渋谷区',
  '14100': '横浜市',
  '23100': '名古屋市',
  '27100': '大阪市',
  '40130': '福岡市',
  '01100': '札幌市',
};
const COMPONENTS = ['medical', 'elderly_support', 'child_rearing_support', 'nursing_care'];
const get = (code, comp) =>
  recs.find(r => r.jurisdiction.municipalityCode === code && r.levy_component === comp);

console.log('\n=== Test 1: 6自治体 × 4区分がそろっている ===');
{
  assert(recs.length === 24, `レコードは24件（6自治体×4区分／実: ${recs.length}）`);
  for (const [code, name] of Object.entries(MUNI)) {
    const rows = recs.filter(r => r.jurisdiction.municipalityCode === code);
    assert(rows.length === 4, `${name}: 4区分そろっている`);
    assert(new Set(rows.map(r => r.levy_component)).size === 4,
      `${name}: 区分に重複が無い`);
  }
  assert(new Set(recs.map(r => r.value_key)).size === 1, '全レコードが同じ value_key');
  assert(recs.every(r => r.tax_year === 2026), '全レコードが令和8年度');
  assert(recs.every(r => r.effective_from === '2026-04-01' && r.effective_to === '2027-03-31'),
    '適用期間が令和8年度に閉じている（年度が変われば鮮度チェックが検知する）');
}

console.log('\n=== Test 2: 賦課限度額が政令の上限を超えていない ===');
{
  // 政令の上限（national-health-insurance.json）
  const capRecs = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.value_key === 'national_health_insurance_assessment_cap') capRecs.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  walk(capsDoc);
  const ceiling = Object.fromEntries(capRecs.map(r => [r.levy_component, yen(r.cap_amount)]));
  assert(Object.keys(ceiling).length === 4, '政令の上限が4区分ある');

  for (const r of recs) {
    const c = ceiling[r.levy_component];
    assert(yen(r.cap_amount) <= c,
      `${r.municipality_label} ${r.levy_component}: 限度額 ${yen(r.cap_amount)} ≦ 政令の上限 ${c}`);
  }

  // 大阪市の医療分だけ政令より低い
  const osaka = get('27100', 'medical');
  assert(yen(osaka.cap_amount) === 660000n && ceiling.medical === 670000n,
    '大阪市の医療分は66万円で、政令の上限67万円より低い');
  assert(/超えることができない|上限/.test(osaka._cap_below_national_ceiling || ''),
    '政令の限度額が上限であって強制ではないことが記録されている');

  const others = ['13113', '14100', '23100', '40130', '01100'];
  for (const code of others) {
    assert(yen(get(code, 'medical').cap_amount) === 670000n,
      `${MUNI[code]}の医療分は政令の上限どおり67万円`);
  }
}

console.log('\n=== Test 3: 賦課方式が自治体で違う ===');
{
  const noEqual = ['13113', '14100', '23100'];
  for (const code of noEqual) {
    assert(COMPONENTS.every(c => get(code, c).per_household_amount === null),
      `${MUNI[code]}: 平等割が無い（2方式）`);
  }

  // 大阪市は医療分・支援金分だけ平等割がある
  assert(get('27100', 'medical').per_household_amount !== null
    && get('27100', 'elderly_support').per_household_amount !== null,
    '大阪市: 医療分・支援金分に平等割がある');
  assert(get('27100', 'child_rearing_support').per_household_amount === null
    && get('27100', 'nursing_care').per_household_amount === null,
    '大阪市: 子ども分・介護分には平等割が無い（区分ごとに方式が違う）');

  // 福岡市・札幌市は4区分すべてに平等割がある
  for (const code of ['40130', '01100']) {
    assert(COMPONENTS.every(c => get(code, c).per_household_amount !== null),
      `${MUNI[code]}: 4区分すべてに平等割がある`);
  }

  assert(Object.keys(doc._assessment_methods || {}).length >= 3,
    '賦課方式の違いが文書に整理されている');
}

console.log('\n=== Test 4: 料率の値が公表値と一致する ===');
{
  const expect = [
    ['13113', 'medical', 751, 47600], ['13113', 'elderly_support', 280, 17600],
    ['13113', 'child_rearing_support', 27, 1873], ['13113', 'nursing_care', 243, 17800],
    ['14100', 'medical', 833, 40870], ['14100', 'elderly_support', 262, 13380],
    ['14100', 'child_rearing_support', 34, 1770], ['14100', 'nursing_care', 284, 16200],
    ['23100', 'medical', 883, 50591], ['23100', 'elderly_support', 258, 15784],
    ['23100', 'child_rearing_support', 26, 1771], ['23100', 'nursing_care', 234, 16120],
    ['27100', 'medical', 950, 34990], ['27100', 'elderly_support', 306, 11191],
    ['27100', 'child_rearing_support', 28, 1745], ['27100', 'nursing_care', 260, 18682],
    ['40130', 'medical', 558, 19807], ['40130', 'elderly_support', 314, 10441],
    ['40130', 'child_rearing_support', 28, 1039], ['40130', 'nursing_care', 261, 10160],
    ['01100', 'medical', 861, 20550], ['01100', 'elderly_support', 256, 6330],
    ['01100', 'child_rearing_support', 29, 1100], ['01100', 'nursing_care', 233, 6020],
  ];
  assert(expect.length === 24, '期待値も24件');
  for (const [code, comp, num, per] of expect) {
    const r = get(code, comp);
    const [n, d] = rateOf(r.income_rate);
    assert(n === BigInt(num) && d === 10000n && yen(r.per_capita_amount) === BigInt(per),
      `${MUNI[code]} ${comp}: 所得割 ${num / 100}% / 均等割 ${per}円`);
  }
  assert(recs.every(r => r.income_rate.den === '10000'),
    '所得割率は 1/10000 単位の整数対で保持している（小数リテラルを使わない）');
}

console.log('\n=== Test 5: 自治体を変えると概算額が大きく変わる ===');
{
  // 単身・40歳未満・事業所得500万円のケースで各自治体の年間保険料を試算する
  const income = 5000000n;
  const base = income - 430000n;   // 基礎控除43万円
  const annual = (code) => {
    let total = 0n;
    for (const comp of ['medical', 'elderly_support', 'child_rearing_support']) {
      const r = get(code, comp);
      const [n, d] = rateOf(r.income_rate);
      let v = base * n / d + yen(r.per_capita_amount)
        + (r.per_household_amount ? yen(r.per_household_amount) : 0n);
      const cap = yen(r.cap_amount);
      if (v > cap) v = cap;
      total += v;
    }
    return total;
  };
  const results = Object.keys(MUNI).map(c => [MUNI[c], annual(c)]);
  for (const [name, v] of results) console.log(`      ${name}: 約${v}円`);

  const values = results.map(([, v]) => v);
  const min = values.reduce((a, b) => (a < b ? a : b));
  const max = values.reduce((a, b) => (a > b ? a : b));
  assert(max - min > 100000n,
    `所得500万円・単身で自治体間の差が10万円を超える（最小${min}円・最大${max}円・差${max - min}円）`);
  assert(/幅/.test(doc._simulator_rule || ''),
    '幅を併記する方針が記録されている');
  assert(/数万円単位/.test(doc._critical_caveat || ''),
    '自治体の選択で概算額が大きく変わることが警告として記録されている');
}

console.log('\n=== Test 6: 所得割の基数と年度更新 ===');
{
  assert(/基礎控除43万円/.test(doc._income_base || ''),
    '所得割の基数が「総所得金額等 − 基礎控除43万円」であることが記録されている');
  assert(/住民税の課税所得（所得控除を全部引いた後）ではない/.test(doc._income_base || ''),
    '住民税の課税所得と取り違えないよう明記されている');
  assert(/毎年度改定/.test(doc._annual_update || ''),
    '年度更新が必要であることが記録されている');
  assert(/6桁|検査数字/.test(doc._municipality_code_note || ''),
    '団体コードの桁数についての仕様書の記述の問題が記録されている');
}

console.log('\n=== Test 7: 子ども・子育て支援金分の新設 ===');
{
  const child = COMPONENTS.includes('child_rearing_support');
  assert(child, '子ども・子育て支援金分が区分として存在する');
  for (const code of Object.keys(MUNI)) {
    const r = get(code, 'child_rearing_support');
    assert(/令和8年度に新設/.test(r._new_in_r8 || ''),
      `${MUNI[code]}: 令和8年度の新設であることが記録されている`);
    assert(yen(r.cap_amount) === 30000n, `${MUNI[code]}: 限度額は3万円`);
    assert(r.tax_or_insurance_type === 'child_rearing_support',
      `${MUNI[code]}: 税目が child_rearing_support`);
  }
  assert(/18歳未満/.test(doc._child_support_component || ''),
    '18歳未満の均等割が軽減されることが記録されている');
}

console.log('\n=== Test 8: 出典と承認状態 ===');
{
  assert(recs.every(r => r.source_document_id && r.source_locator),
    '全レコードに出典と参照位置がある');
  assert(recs.every(r => r.data_review_status === 'approved'), '全レコードが承認済み');
  assert(recs.every(r => r.legal_status === 'effective'), '全レコードが施行済み');
  assert(recs.every(r => r.jurisdiction.municipalityCode && r.jurisdiction.prefectureCode),
    '全レコードに都道府県コードと市区町村コードがある');

  const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'sources', 'source-registry.json'), 'utf8'));
  for (const id of new Set(recs.map(r => r.source_document_id))) {
    assert(!!registry.sources[id], `出典 ${id} が台帳に登録されている`);
    assert(registry.sources[id].update_cycle === 'fiscal_april',
      `出典 ${id} の更新周期が年度更新になっている`);
  }

  assert(/nhi-municipal-rates\.json/.test(capsDoc._estimation_decision || ''),
    '賦課限度額のマスターから市町村別料率のマスターへ参照がある');
  assert(/0円扱いは禁止/.test(capsDoc._simulator_rule || ''),
    '国保料を0円扱いにしない方針が維持されている');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
