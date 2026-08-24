'use strict';

/**
 * 相続税の税額控除と生前贈与加算のマスターの検証。
 *   node masters/scripts/__tests__/test-inheritance-credits.js
 *
 * 間違えやすい点を固定する。
 *   - 未成年者控除・障害者控除は端数を切り上げ、相次相続控除は切り捨てる（逆になっている）
 *   - 生前贈与加算の経過措置は「N年以内」ではない期間が挟まる
 *   - 100万円控除の開始日（令和9年1月2日）は加算期間の切替（令和9年1月1日）と1日ずれる
 */

const fs = require('fs');
const path = require('path');

const F = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data', 'inheritance-tax', 'tax-credits.json');
const doc = JSON.parse(fs.readFileSync(F, 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const all = Object.values(doc)
  .filter(v => v && typeof v === 'object' && Array.isArray(v.records))
  .flatMap(v => v.records);
const byId = new Map(all.map(r => [r.record_id, r]));
const yen = (m) => BigInt(m.value);

console.log('\n=== Test 1: 未成年者控除 ===');
{
  const r = byId.get('IHT-MINOR-CREDIT');
  assert(yen(r.per_year_amount) === 100000n, '1年につき10万円');
  assert(r.age_threshold === 18, '満18歳まで');
  assert(r.year_fraction_handling === 'round_up', '1年未満の期間は切り上げ');
  assert(r.effective_from === '2022-04-01',
    '18歳への引下げは令和4年4月1日から（成年年齢引下げに伴う）');

  // 出典の例: 15歳9か月 → 年齢は15歳（切捨て）→ 18-15=3年 → 30万円
  const age = 15;                       // 年齢は1年未満切捨て
  const years = r.age_threshold - age;  // 3
  assert(BigInt(years) * yen(r.per_year_amount) === 300000n,
    '出典の例（15歳9か月）で30万円になる');
}

console.log('\n=== Test 2: 障害者控除 ===');
{
  const g = byId.get('IHT-DISABILITY-CREDIT-GENERAL');
  const s = byId.get('IHT-DISABILITY-CREDIT-SPECIAL');
  assert(yen(g.per_year_amount) === 100000n, '一般障害者は1年10万円');
  assert(yen(s.per_year_amount) === 200000n, '特別障害者は1年20万円');
  assert(yen(s.per_year_amount) === yen(g.per_year_amount) * 2n, '特別は一般の2倍');
  assert(g.age_threshold === 85 && s.age_threshold === 85, 'いずれも満85歳まで');
  assert(g.year_fraction_handling === 'round_up' && s.year_fraction_handling === 'round_up',
    '1年未満の期間は切り上げ');

  // 同じ value_key・同じ期間で共存するので、条件で選び分けられる必要がある
  assert(g.value_key === s.value_key, '一般と特別は同じ value_key');
  const gc = JSON.stringify(g.applicability_conditions);
  const sc = JSON.stringify(s.applicability_conditions);
  assert(gc !== sc && gc && sc,
    '適用条件が両方にあり内容が違う（エンジンが選び分けられる）');
}

console.log('\n=== Test 3: 相次相続控除 ===');
{
  const r = byId.get('IHT-SUCCESSIVE-CREDIT');
  assert(r.lookback_years === 10, '10年以内の前相続が対象');
  assert(r.annual_reduction_rate.num === '10' && r.annual_reduction_rate.den === '100',
    '1年につき10%逓減');
  assert(/切り捨て/.test(r._year_fraction_handling),
    '経過年数は切り捨て（未成年者控除・障害者控除の切り上げと逆）');
  assert(Object.keys(r.formula_variables).length === 5, '算式の変数A〜Eが揃っている');
}

console.log('\n=== Test 4: 生前贈与加算の対象期間 ===');
{
  const periods = all.filter(r => r.value_key === 'inheritance_gift_addback_period')
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  assert(periods.length === 3, `経過措置を含めて3段階（実: ${periods.length}）`);

  const [p1, p2, p3] = periods;
  assert(p1.years_before_death === 3 && p1.effective_to === '2026-12-31',
    '第1段階: 令和8年12月31日以前の相続は3年以内');
  assert(p2.period_method === 'fixed_start_to_death' && p2.fixed_start_date === '2024-01-01',
    '第2段階: 令和6年1月1日からの固定起点（「N年以内」ではない）');
  assert(p2.years_before_death === null,
    '第2段階に年数を持たせていない（年数で計算すると誤る）');
  assert(p3.years_before_death === 7 && p3.effective_from === '2031-01-01',
    '第3段階: 令和13年1月1日以後の相続は7年以内');

  // 期間が隙間なく繋がっているか
  assert(p1.effective_to === '2026-12-31' && p2.effective_from === '2027-01-01',
    '第1段階と第2段階が連続');
  assert(p2.effective_to === '2030-12-31' && p3.effective_from === '2031-01-01',
    '第2段階と第3段階が連続');
  assert(p3.effective_to === null, '第3段階に終わりが無い');
}

console.log('\n=== Test 5: 100万円控除 ===');
{
  const r = byId.get('IHT-GIFT-ADDBACK-EXTRA-DEDUCTION');
  assert(yen(r.threshold_amount) === 1000000n, '総額100万円');
  assert(r.effective_from === '2027-01-02',
    `令和9年1月2日以後の相続から（実: ${r.effective_from}）`);
  const period2 = byId.get('IHT-GIFT-ADDBACK-TRANSITION');
  assert(r.effective_from !== period2.effective_from,
    '加算期間の切替（令和9年1月1日）とは1日ずれる — 日付を揃えないこと');
  assert(r.data_review_status !== 'blocked', '出典で確認できたので blocked は解除されている');
}

console.log('\n=== Test 6: 控除の適用順序 ===');
{
  // §28-1 の順序: 贈与税額控除 → 配偶者の税額軽減 → 未成年者 → 障害者 → 相次相続
  const order = (id) => byId.get(id).calculation_order;
  assert(order('IHT-MINOR-CREDIT') < order('IHT-DISABILITY-CREDIT-GENERAL'),
    '未成年者控除は障害者控除より先');
  assert(order('IHT-DISABILITY-CREDIT-GENERAL') < order('IHT-SUCCESSIVE-CREDIT'),
    '障害者控除は相次相続控除より先');
}

console.log('\n=== Test 7: 出典 ===');
{
  const expect = {
    'IHT-MINOR-CREDIT': 'NTA-TA-4164',
    'IHT-DISABILITY-CREDIT-GENERAL': 'NTA-TA-4167',
    'IHT-SUCCESSIVE-CREDIT': 'NTA-TA-4168',
    'IHT-GIFT-ADDBACK-3Y': 'NTA-TA-4161',
  };
  for (const [id, src] of Object.entries(expect)) {
    assert(byId.get(id).source_document_id === src, `${id} の出典が ${src}`);
  }
  assert(all.every(r => r.source_hash), '全レコードに出典のハッシュが記録されている');
  assert(all.every(r => r.source_locator && r.source_locator !== '未確認'),
    '全レコードに出典内の位置が記録されている');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
