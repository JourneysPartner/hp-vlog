'use strict';

/** 社会保険計算エンジン第1版の境界・ゴールデンケーステスト。 */

const fs = require('fs');
const path = require('path');
const { exact, money, compareExactToMoney } = require('../../../src/tax-engine/common/money.js');
const { applyRounding } = require('../../../src/tax-engine/common/rounding.js');
const {
  determineStandardRemuneration,
  calculateMonthlyPremium,
  calculateBonusPremium,
} = require('../../../src/tax-engine/social-insurance/index.js');

const yen = value => money({ unit: 'JPY', value: BigInt(value) });
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function exactYen(value, expected) {
  return compareExactToMoney(value, yen(expected)) === 0;
}

function monthly(overrides = {}) {
  return calculateMonthlyPremium({
    premiumMonth: '2026-05',
    prefectureCode: '13',
    age: 39,
    monthlyRemuneration: yen(410000),
    ...overrides,
  });
}

console.log('\n=== 社会保険: half_down の50銭境界 ===');
{
  const below = exact({ unit: 'JPY', num: 4999n, den: 10000n });
  const half = exact({ unit: 'JPY', num: 1n, den: 2n });
  const above = exact({ unit: 'JPY', num: 5001n, den: 10000n });
  const halfDown = value => applyRounding(value, 'R-SHARE-EMPLOYEE-PAYROLL').value;
  const halfUp = value => applyRounding(value, 'R-ROUND-HALF-UP-1').value;
  assert(halfDown(half) === 0n && halfDown(above) === 1n,
    'half_down は50銭ちょうどを切り捨て、50銭+1/10000円を切り上げる');
  assert(halfDown(exact({ unit: 'JPY', num: -1n, den: 2n })) === 0n &&
    halfDown(exact({ unit: 'JPY', num: -5001n, den: 10000n })) === -1n,
  'half_down は負数を絶対値で丸めて符号を戻す');
  assert(halfDown(below) === halfUp(below) && halfDown(above) === halfUp(above) &&
    halfDown(half) === 0n && halfUp(half) === 1n,
  'half_up との差は50銭ちょうどの境界で固定される');
}

console.log('\n=== 社会保険: 標準報酬月額等級 ===');
{
  const high = determineStandardRemuneration(yen(700000), { onDate: '2026-05-01' });
  const low = determineStandardRemuneration(yen(10000), { onDate: '2026-05-01' });
  assert(high.healthInsurance.standardRemuneration.value === 710000n &&
    high.employeesPension.standardRemuneration.value === 650000n,
  '70万円は健保71万円・厚年65万円上限を別々の等級表から決定する');
  assert(low.healthInsurance.standardRemuneration.value === 58000n &&
    low.employeesPension.standardRemuneration.value === 88000n,
  '下限側は健保・厚年それぞれの最下等級になる');
  assert(high.notes.some(note => note.code === 'SI_STANDARD_REMUNERATION_TIMING_INPUT_RESPONSIBILITY'),
    '標準報酬の決定時期は入力側責務であることを注記する');
}

console.log('\n=== 社会保険: 介護年齢境界・支援金月境界 ===');
{
  const ages = [39, 40, 64, 65].map(age => monthly({ age }));
  assert(!ages[0].nursingCareApplicable && ages[1].nursingCareApplicable &&
    ages[2].nursingCareApplicable && !ages[3].nursingCareApplicable,
  '介護保険は40歳以上65歳未満（40〜64歳）だけに加算する');
  const march = monthly({ premiumMonth: '2026-03' });
  const april = monthly({ premiumMonth: '2026-04' });
  assert(!march.childRearingSupportApplicable && april.childRearingSupportApplicable &&
    march.healthInsurance.rateComponents.childRearingSupport === null &&
    april.healthInsurance.rateComponents.childRearingSupport.num === 23n,
  '支援金は2026年3月分には含めず、4月分から加算する');
}

console.log('\n=== 社会保険: 月額保険料・blocked ===');
{
  const r8 = monthly({ age: 45 });
  assert(r8.healthInsurance.combinedRate.num === 117n &&
    r8.healthInsurance.combinedRate.den === 1000n &&
    r8.healthInsurance.employee.value === 23985n && exactYen(r8.healthInsurance.employer, 23985),
  'R8東京は9.85%+1.62%+0.23%を合算して1回だけ折半・丸めする');
  const separatelyRounded = [
    exact({ unit: 'JPY', num: 410000n * 985n, den: 10000n * 2n }),
    exact({ unit: 'JPY', num: 410000n * 162n, den: 10000n * 2n }),
    exact({ unit: 'JPY', num: 410000n * 23n, den: 10000n * 2n }),
  ].reduce((sum, value) => sum + applyRounding(value, 'R-SHARE-EMPLOYEE-PAYROLL').value, 0n);
  assert(separatelyRounded === 23984n && r8.healthInsurance.employee.value === 23985n,
    '410,000円では区分別丸めとの差が出るため、合算1回丸めを固定する');
  assert(r8.childSupportLevy.employee.value === 0n && exactYen(r8.childSupportLevy.employer, 1476),
    '子ども・子育て拠出金0.36%は本人負担0・全額事業主負担になる');
  const r7Care = monthly({ premiumMonth: '2025-05', age: 40 });
  assert(r7Care.status === 'blocked' && r7Care.blockedReasons.some(
    reason => reason.code === 'SI_NURSING_CARE_RATE_MISSING'
  ), '介護該当者のR7月は料率未登録を隠さず理由コード付きblockedにする');
  const society = monthly({ insurerType: 'health_insurance_society' });
  const noPrefecture = monthly({ prefectureCode: undefined, prefecture: undefined });
  assert(society.status === 'blocked' && society.blockedReasons.some(
    reason => reason.code === 'SI_INSURER_UNSUPPORTED'
  ), '健保組合はblockedにする');
  assert(noPrefecture.status === 'blocked' && noPrefecture.blockedReasons.some(
    reason => reason.code === 'SI_PREFECTURE_REQUIRED'
  ), '都道府県なしはblockedにする');
  const missingGrades = determineStandardRemuneration(yen(410000), { onDate: '2010-01-01' });
  const missingYearRate = monthly({ premiumMonth: '2027-05' });
  assert(missingGrades.status === 'blocked' && [
    'SI_HEALTH_STANDARD_REMUNERATION_GRADE_MISSING',
    'SI_PENSION_STANDARD_REMUNERATION_GRADE_MISSING',
  ].every(code => missingGrades.blockedReasons.some(reason => reason.code === code)),
  '対象日の等級表が無ければ健保・厚年それぞれの理由コード付きblockedにする');
  assert(missingYearRate.status === 'blocked' && missingYearRate.blockedReasons.some(
    reason => reason.code === 'SI_HEALTH_INSURANCE_RATE_MISSING'
  ), '対象年度の都道府県別健康保険料率が無ければblockedにする');
}

console.log('\n=== 社会保険: 賞与の端数・上限 ===');
{
  const bonus = calculateBonusPremium({
    premiumMonth: '2026-05', prefectureCode: '13', age: 39,
    bonusAmount: yen(2000999), healthInsuranceCumulativeBefore: yen(5000000),
  });
  assert(bonus.standardBonus.beforeCap.value === 2000000n,
    '賞与支給額の1,000円未満を切り捨てる');
  assert(bonus.standardBonus.employeesPension.value === 1500000n,
    '厚年の標準賞与額は1回ごとに150万円を上限とする');
  assert(bonus.standardBonus.healthInsurance.value === 730000n &&
    bonus.standardBonus.healthInsuranceCumulativeAfter.value === 5730000n,
  '健保の標準賞与額は年度累計573万円までの残額だけを賦課する');
  const exhausted = calculateBonusPremium({
    premiumMonth: '2026-05', prefectureCode: '13', age: 39,
    bonusAmount: yen(1000000), healthInsuranceCumulativeBefore: yen(5730000),
  });
  assert(exhausted.standardBonus.healthInsurance.value === 0n &&
    exhausted.standardBonus.employeesPension.value === 1000000n,
  '健保年度上限到達後も厚年は当該回の上限を独立して適用する');
}

console.log('\n=== 社会保険: official-examples の固定期待値 ===');
{
  const document = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
  ), 'utf8'));
  const cases = new Map(document.cases.map(item => [item.case_id, item]));
  for (const id of ['GC-SI-TOKYO-R7-410', 'GC-SI-TOKYO-R8-KAIGO']) {
    const item = cases.get(id);
    const result = calculateMonthlyPremium({
      premiumMonth: item.inputs.premium_month,
      prefectureCode: item.inputs.prefecture_code,
      age: item.inputs.age,
      insurerType: item.inputs.insurer_type,
      monthlyRemuneration: yen(item.inputs.monthly_remuneration),
    });
    assert(result.status === 'complete' &&
      result.standardRemuneration.healthInsurance.standardRemuneration.value ===
        BigInt(item.expected.health_standard_remuneration) &&
      exactYen(result.healthInsurance.total, item.expected.health_total) &&
      result.healthInsurance.employee.value === BigInt(item.expected.health_employee) &&
      exactYen(result.healthInsurance.employer, item.expected.health_employer) &&
      result.standardRemuneration.employeesPension.standardRemuneration.value ===
        BigInt(item.expected.employees_pension_standard_remuneration) &&
      exactYen(result.employeesPension.total, item.expected.employees_pension_total) &&
      result.employeesPension.employee.value === BigInt(item.expected.employees_pension_employee) &&
      exactYen(result.employeesPension.employer, item.expected.employees_pension_employer),
    `${id} の手入力した期待値とエンジン結果が一致する`);
  }
  const r8 = cases.get('GC-SI-TOKYO-R8-KAIGO');
  const result = monthly({ age: r8.inputs.age });
  assert(result.healthInsurance.combinedRate.num === BigInt(r8.expected.health_combined_rate_num) &&
    result.healthInsurance.combinedRate.den === BigInt(r8.expected.health_combined_rate_den) &&
    exactYen(result.childSupportLevy.total, r8.expected.child_support_levy_total) &&
    result.childSupportLevy.employee.value === BigInt(r8.expected.child_support_levy_employee) &&
    exactYen(result.childSupportLevy.employer, r8.expected.child_support_levy_employer),
  'GC-SI-TOKYO-R8-KAIGO の合算率・拠出金期待値を照合する');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
