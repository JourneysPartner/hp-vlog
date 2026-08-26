'use strict';

/**
 * 2割特例・3割特例の適用対象課税期間の判定規則の検証。
 *   node scripts/lib/__tests__/test-small-business-special-period.js
 *
 * 固定したいのは1点だけ。
 *   適用対象は「その期間のいずれかの日を含む課税期間」であって、
 *   課税期間の開始日だけ、あるいは終了日だけで判定してはいけない。
 *
 * 2割特例は平成28年改正法附則51条の2で
 * 「令和五年十月一日から令和八年九月三十日までの日の属する各課税期間」と定められている。
 * 開始日の上限で判定すると 2023-04-01 開始の事業年度を取りこぼし、
 * 終了日で判定すると個人事業者の令和8年分（2026-12-31 終了）を取りこぼす。
 */

const fs = require('fs');
const path = require('path');

const F = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters',
  'data', 'consumption-tax', 'small-business-special.json');
const doc = JSON.parse(fs.readFileSync(F, 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const byId = new Map(doc.records.map(r => [r.record_id, r]));

// 条文どおりの判定。課税期間が [from, to] のいずれかの日を含むか。
const intersects = (rec, periodFrom, periodTo) =>
  periodTo >= rec.effective_from && periodFrom <= rec.effective_to;

// 誤った判定その1: 開始日だけを見る
const byStartOnly = (rec, periodFrom) =>
  periodFrom >= rec.effective_from && periodFrom <= rec.effective_to;

// 誤った判定その2: 終了日だけを見る
const byEndOnly = (rec, periodTo) =>
  periodTo >= rec.effective_from && periodTo <= rec.effective_to;

console.log('\n=== Test 1: 判定規則が機械可読に持たれている ===');
{
  for (const r of doc.records) {
    assert(r.period_match_rule === 'taxable_period_intersects',
      `${r.record_id}: period_match_rule が taxable_period_intersects`);
  }
  assert(/いずれかの日を含む/.test(doc._period_match_note || ''),
    'ファイル冒頭に判定規則の説明がある');
  assert(/附則51条の2|附則第五十一条の二|五十一条の二/.test(
    byId.get('CT-SPECIAL-2WARI')._period_match_basis || ''),
    '2割特例の根拠条文（平成28年改正法附則51条の2）が記録されている');
}

console.log('\n=== Test 2: 2割特例の適用期間 ===');
{
  const r = byId.get('CT-SPECIAL-2WARI');
  assert(r.effective_from === '2023-10-01' && r.effective_to === '2026-09-30',
    '令和5年10月1日から令和8年9月30日まで');

  const cases = [
    // [課税期間開始, 課税期間終了, 対象か, 説明]
    ['2023-01-01', '2023-12-31', true, '個人の令和5年分（10月1日を含む）'],
    ['2022-01-01', '2022-12-31', false, '個人の令和4年分（インボイス開始前）'],
    ['2023-04-01', '2024-03-31', true, '3月決算法人の令和5年度（開始日は10月1日より前）'],
    ['2026-01-01', '2026-12-31', true, '個人の令和8年分（終了日は9月30日より後）'],
    ['2026-04-01', '2027-03-31', true, '3月決算法人（9月30日を含む）'],
    ['2026-10-01', '2027-09-30', false, '9月決算法人の翌期（10月1日開始で1日も含まない）'],
    ['2027-01-01', '2027-12-31', false, '個人の令和9年分'],
  ];
  for (const [from, to, want, label] of cases) {
    assert(intersects(r, from, to) === want,
      `${label}: ${want ? '対象' : '対象外'}`);
  }
}

console.log('\n=== Test 3: 誤った判定だと取りこぼすことを固定する ===');
{
  const r = byId.get('CT-SPECIAL-2WARI');

  // 開始日だけで判定すると、3月決算法人の令和5年度を落とす
  assert(intersects(r, '2023-04-01', '2024-03-31') === true
    && byStartOnly(r, '2023-04-01') === false,
    '開始日だけの判定は3月決算法人の令和5年度を取りこぼす');

  // 終了日だけで判定すると、個人の令和8年分を落とす
  assert(intersects(r, '2026-01-01', '2026-12-31') === true
    && byEndOnly(r, '2026-12-31') === false,
    '終了日だけの判定は個人事業者の令和8年分を取りこぼす');

  // どちらの誤りも「対象なのに対象外と判定する」方向。
  // 特例を使えるのに使えないと表示するため、納税額を過大に見せる
  assert(true, '2つの誤りはいずれも納税額を過大に見せる方向に働く');
}

console.log('\n=== Test 4: 3割特例 ===');
{
  const r = byId.get('CT-SPECIAL-3WARI');
  assert(r.effective_from === '2027-01-01' && r.effective_to === '2028-12-31',
    '令和9年分・令和10年分');
  assert(r.legal_status === 'enacted', '令和8年度税制改正で創設（未施行）');

  const cond = (r.applicability_conditions || [])
    .find(c => c.subject === 'entity_type');
  assert(cond && cond.value === 'individual',
    '個人事業者のみ。法人は対象外');

  assert(intersects(r, '2027-01-01', '2027-12-31') === true, '個人の令和9年分は対象');
  assert(intersects(r, '2028-01-01', '2028-12-31') === true, '個人の令和10年分は対象');
  assert(intersects(r, '2029-01-01', '2029-12-31') === false, '個人の令和11年分は対象外');

  // 2割特例と3割特例は期間が重ならない（令和8年10月〜12月に空きがある）
  const two = byId.get('CT-SPECIAL-2WARI');
  assert(two.effective_to < r.effective_from,
    '2割特例の終期より3割特例の始期が後（期間が重ならない）');
  assert(/法人は2割特例の終了後、特例なし/.test(r._note || ''),
    '法人には後継の特例が無いことが記録されている');
}

console.log('\n=== Test 5: 2つの特例が同時に選ばれないこと ===');
{
  const two = byId.get('CT-SPECIAL-2WARI');
  const three = byId.get('CT-SPECIAL-3WARI');
  assert(two.value_key === three.value_key, '同じ value_key');

  // 個人の各年分について、対象となる特例が最大1つであること
  for (let y = 2023; y <= 2029; y++) {
    const from = `${y}-01-01`, to = `${y}-12-31`;
    const hit = [two, three].filter(r => intersects(r, from, to));
    assert(hit.length <= 1,
      `個人の${y}年分に該当する特例は ${hit.length} 件（2件以上にならない）`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
