'use strict';

/**
 * 社会保険料率の検証。
 *   node masters/scripts/__tests__/test-social-insurance-rates.js
 *
 * 都道府県別の健康保険料率は協会けんぽのページから自動読取りで取り込んでいる。
 * 47件×2年度を目で確かめるのは現実的でないため、機械で押さえられる性質を固定する。
 *   - 健保法160条1項の法定範囲（千分の30〜130）に収まっているか
 *   - 47都道府県が過不足なく揃っているか
 *   - 労使折半の率が合計率の半分になっているか
 */

const fs = require('fs');
const path = require('path');

const SI = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data', 'social-insurance');
const health = JSON.parse(fs.readFileSync(path.join(SI, 'health-insurance-rates.json'), 'utf8'));
const national = JSON.parse(fs.readFileSync(path.join(SI, 'national-rates.json'), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const val = (r) => Number(r.rate.num) / Number(r.rate.den);
const allNational = Object.values(national)
  .filter(v => v && typeof v === 'object' && Array.isArray(v.records))
  .flatMap(v => v.records);

console.log('\n=== Test 1: 都道府県別 健康保険料率 ===');
{
  const recs = health.records;
  assert(recs.length === 94, `47都道府県 × 2年度 = 94件（実: ${recs.length}）`);

  for (const year of [2025, 2026]) {
    const y = recs.filter(r => r.tax_year === year);
    assert(y.length === 47, `${year}年度が47件（実: ${y.length}）`);
    const codes = new Set(y.map(r => r.jurisdiction.prefectureCode));
    assert(codes.size === 47, `${year}年度の都道府県コードが47種すべて異なる（実: ${codes.size}）`);
    const expected = Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, '0'));
    const missing = expected.filter(c => !codes.has(c));
    assert(missing.length === 0, `${year}年度に欠けている都道府県コードが無い（欠: ${missing.join(',') || 'なし'}）`);
  }
}

console.log('\n=== Test 2: 健保法160条1項の法定範囲 ===');
{
  // 千分の三十から千分の百三十までの範囲内
  const lo = 30 / 1000, hi = 130 / 1000;
  const out = health.records.filter(r => val(r) < lo || val(r) > hi);
  assert(out.length === 0,
    `全94件が3%〜13%に収まる（範囲外 ${out.length} 件${out.length ? ': ' + out.map(r => r.record_id).join(',') : ''}）`);

  // 実在しうる幅から大きく外れた値（桁の取り違え）を弾く
  const weird = health.records.filter(r => val(r) < 0.08 || val(r) > 0.12);
  assert(weird.length === 0,
    `8%〜12%の常識的な幅に収まる（外れ ${weird.length} 件${weird.length ? ': ' + weird.map(r => `${r.prefecture_name} ${(val(r) * 100).toFixed(2)}%`).join(', ') : ''}）`);
}

console.log('\n=== Test 3: 取得時に照合した値 ===');
{
  // 取得元ページを別問いで読み直して一致を確認した6県と最高・最低
  const r8 = new Map(health.records.filter(r => r.tax_year === 2026).map(r => [r.prefecture_name, val(r)]));
  const expect = {
    '北海道': 0.1028, '東京都': 0.0985, '神奈川県': 0.0992,
    '大阪府': 0.1013, '佐賀県': 0.1055, '沖縄県': 0.0944,
  };
  for (const [name, v] of Object.entries(expect)) {
    assert(Math.abs(r8.get(name) - v) < 1e-9, `R8 ${name} = ${(v * 100).toFixed(2)}%`);
  }
  const vals = [...r8.values()];
  assert(Math.max(...vals) === 0.1055, `R8 最高が佐賀県 10.55%（実: ${(Math.max(...vals) * 100).toFixed(2)}%）`);
  // 最低は新潟県。取り込み時の照合では「6県の中での最低」を答えさせてしまい沖縄と出たが、
  // 全県を対象に取り直したところ新潟9.21%（令和7年度9.55%からの引下げ）が最低だった。
  // 照合は元の問いと同じ範囲で行わないと、答えが比較可能にならない。
  assert(Math.min(...vals) === 0.0921, `R8 最低が新潟県 9.21%（実: ${(Math.min(...vals) * 100).toFixed(2)}%）`);
  assert(r8.get('新潟県') === 0.0921, 'R8 新潟県 = 9.21%（全県対象で再取得して確認）');
  const below95 = [...r8.entries()].filter(([, v]) => v < 0.095).map(([n]) => n).sort();
  assert(below95.length === 2 && below95.includes('新潟県') && below95.includes('沖縄県'),
    `R8 で9.5%を下回るのは新潟県と沖縄県の2県（実: ${below95.join(', ')}）`);
}

console.log('\n=== Test 4: 厚生年金の労使折半 ===');
{
  const find = (k) => allNational.find(r => r.value_key === k);
  const total = find('employees_pension_rate_total');
  const er = find('employees_pension_rate_employer');
  const ee = find('employees_pension_rate_employee');

  assert(val(total) === 0.183, `合計率が18.3%（厚年法81条4項。実: ${(val(total) * 100).toFixed(2)}%）`);
  assert(val(er) === val(ee), '事業主負担と被保険者負担が同額（厚年法82条1項）');
  assert(Math.abs(val(er) + val(ee) - val(total)) < 1e-12,
    `折半の合計が合計率と一致（${val(er)} + ${val(ee)} = ${val(total)}）`);
}

console.log('\n=== Test 5: 全国一律の各料率・保険料額 ===');
{
  const find = (k) => allNational.filter(r => r.value_key === k);
  const yen = (r) => BigInt(r.fixed_amount.value);

  // 介護保険料率は2年度分（R7を2026-09-01に協会けんぽ公式で確認して追加）。年度で引く
  const nursingByYear = Object.fromEntries(
    find('nursing_care_insurance_rate_total').map(r => [r.tax_year, val(r)])
  );
  assert(Object.keys(nursingByYear).length === 2, '介護保険料率が2年度分');
  assert(nursingByYear[2025] === 0.0159, '介護保険料率 R7 = 1.59%');
  assert(nursingByYear[2026] === 0.0162, '介護保険料率 R8 = 1.62%');
  assert(val(find('child_rearing_support_rate')[0]) === 0.0023, '子ども・子育て支援金 R8 = 0.23%');
  assert(val(find('child_support_levy_rate')[0]) === 0.0036, '子ども・子育て拠出金 = 0.36%');

  const np = find('national_pension_monthly_premium').sort((a, b) => a.tax_year - b.tax_year);
  assert(np.length === 2, `国民年金保険料が2年度分（実: ${np.length}）`);
  assert(yen(np[0]) === 17510n, `令和7年度 = 17,510円（実: ${yen(np[0])}）`);
  assert(yen(np[1]) === 17920n, `令和8年度 = 17,920円（実: ${yen(np[1])}）`);
  assert(yen(np[1]) > yen(np[0]), '年度が進むと保険料が上がっている');

  assert(yen(find('national_pension_additional_premium')[0]) === 400n, '付加保険料 = 400円');
}

console.log('\n=== Test 6: 標準賞与額の上限 ===');
{
  const find = (k) => allNational.find(r => r.value_key === k);
  const h = find('health_insurance_bonus_cap');
  const p = find('employees_pension_bonus_cap');

  assert(BigInt(h.fixed_amount.value) === 5730000n, '健保 = 573万円（健保法45条1項）');
  assert(h.cap_period === 'annual', '健保は年度累計');
  assert(BigInt(p.fixed_amount.value) === 1500000n, '厚年 = 150万円（政令246号2条）');
  assert(p.cap_period === 'per_payment', '厚年は1回あたり');
  assert(h.cap_period !== p.cap_period, '健保と厚年で上限の単位が違う（取り違え防止）');
  assert(h.rounding_rule_id === 'R-TRUNC-1000-BONUS' && p.rounding_rule_id === 'R-TRUNC-1000-BONUS',
    '双方とも標準賞与額の1,000円未満切捨てが紐づく');
}

console.log('\n=== Test 7: 適用期間の切替 ===');
{
  const r8 = health.records.find(r => r.tax_year === 2026 && r.prefecture_name === '東京都');
  assert(r8.effective_from === '2026-03-01',
    `健保料率は3月分から切り替わる（実: ${r8.effective_from}）— 年度(4月)始まりではない`);
  const support = allNational.find(r => r.value_key === 'child_rearing_support_rate');
  assert(support.effective_from === '2026-04-01',
    `支援金は4月分から（実: ${support.effective_from}）— 健保料率と1か月ずれる`);
  const np = allNational.find(r => r.value_key === 'national_pension_monthly_premium' && r.tax_year === 2026);
  assert(np.effective_from === '2026-04-01', `国民年金は年度（4月）始まり（実: ${np.effective_from}）`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
