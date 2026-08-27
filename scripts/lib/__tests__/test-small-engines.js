'use strict';

/**
 * 法人成りの個人側で使う小エンジン3本の単体・ゴールデンテスト。
 *   node scripts/lib/__tests__/test-small-engines.js
 */

const fs = require('fs');
const path = require('path');
const nhi = require('../../../src/tax-engine/social-insurance/nhi-premium.js');
const businessTax = require('../../../src/tax-engine/business-tax/individual-business-tax.js');
const pension = require('../../../src/tax-engine/social-insurance/national-pension.js');

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const nhiInput = overrides => ({
  municipalityCode: '13113',
  taxYear: 2026,
  previousYearTotalIncome: '5000000',
  insuredAges: [39],
  ...overrides,
});

console.log('\n=== 国民健康保険料 ===');
{
  const high = nhi.calculate(nhiInput({ previousYearTotalIncome: '30000000' }));
  assert(high.components.medical.amount.value === 670000n && high.components.medical.capped,
    '所得3,000万円では医療分が67万円で頭打ちになる');

  const reduced = nhi.calculate(nhiInput({ previousYearTotalIncome: '430000' }));
  assert(reduced.reduction.tier === '70' &&
    reduced.components.medical.perCapitaLevyBeforeReduction.value === 47600n &&
    reduced.components.medical.fixedLevyAfterReduction.value === 14280n,
  '単身・所得43万円は7割軽減となり均等割が3割残る');

  const halfReduced = nhi.calculate(nhiInput({ previousYearTotalIncome: '500000' }));
  assert(halfReduced.reduction.tier === '50' &&
    halfReduced.components.medical.incomeLevy.value === 5257n &&
    halfReduced.components.medical.fixedLevyAfterReduction.value === 23800n,
  '軽減は均等割だけに適用し、所得割は減額しない');

  const noCare = nhi.calculate(nhiInput({ insuredAges: [39] }));
  const care = nhi.calculate(nhiInput({ insuredAges: [45] }));
  assert(noCare.components.nursing_care.amount.value === 0n &&
    care.components.nursing_care.amount.value > 0n &&
    care.annualPremium.value > noCare.annualPremium.value,
  '45歳の被保険者には介護分が乗る');

  const outside = nhi.calculate(nhiInput({ municipalityCode: '99999' }));
  assert(outside.status === 'blocked' && outside.blockedReasons.some(
    reason => reason.code === 'NHI_MUNICIPAL_RATE_NOT_REGISTERED'
  ), '登録外市町村は理由コード付きblockedになる');
  assert(noCare.notes.some(note => /選んだ自治体の料率による概算/.test(note.message)),
    'completeの結果には選択自治体による概算の注記が付く');
}

console.log('\n=== 個人事業税 ===');
{
  const notListed = businessTax.calculate({
    businessCategory: 'not_listed', businessIncome: '5000000', businessMonths: 12,
  });
  assert(notListed.status === 'complete' && notListed.taxAmount.value === 0n,
    'not_listedは法定業種外として0円・completeになる');

  const unknown = businessTax.calculate({
    businessCategory: 'unknown', businessIncome: '5000000', businessMonths: 12,
  });
  assert(unknown.status === 'blocked' && unknown.blockedReasons.some(
    reason => reason.code === 'IBT_BUSINESS_CATEGORY_UNKNOWN'
  ), 'unknownは0円扱いせず理由コード付きblockedになる');

  const halfYear = businessTax.calculate({
    businessCategory: 'type1', businessIncome: '5000000', businessMonths: 6,
  });
  assert(halfYear.ownerDeduction.num / halfYear.ownerDeduction.den === 1450000n &&
    halfYear.taxableBase.value === 3550000n,
  '6か月では事業主控除が145万円へ月割される');

  const belowDeduction = businessTax.calculate({
    businessCategory: 'type1', businessIncome: '2900000', businessMonths: 12,
  });
  assert(belowDeduction.taxableBase.value === 0n && belowDeduction.taxAmount.value === 0n,
    '通年所得290万円以下では課税標準・税額が0円になる');
}

console.log('\n=== 国民年金 ===');
{
  const r7 = pension.calculate({ taxYear: 2025 });
  assert(r7.monthlyPremium.value === 17510n && r7.totalPremium.value === 210120n,
    '令和7年度は月額17,510円を基礎に計算する');
  const additional = pension.calculate({ taxYear: 2026, includeAdditionalPremium: true });
  assert(additional.additionalMonthlyPremium.value === 400n &&
    additional.additionalPremium.value === 4800n &&
    additional.totalPremium.value === 219840n,
  '付加保険料は月額400円を納付月数分だけ加算する');
  for (const [field, code] of [
    ['prepaymentDiscount', 'NP_PREPAYMENT_DISCOUNT_UNSUPPORTED'],
    ['exemption', 'NP_EXEMPTION_UNSUPPORTED'],
    ['deferral', 'NP_DEFERRAL_UNSUPPORTED'],
  ]) {
    const result = pension.calculate({ taxYear: 2026, [field]: true });
    assert(result.status === 'blocked' && result.blockedReasons.some(reason => reason.code === code),
      `${field} は第1版対象外としてblockedになる`);
  }
}

console.log('\n=== official-examples の固定期待値 ===');
{
  const document = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
  ), 'utf8'));
  const cases = new Map(document.cases.map(item => [item.case_id, item]));

  const nhiCase = cases.get('GC-NHI-SHIBUYA-500');
  const nhiResult = nhi.calculate({
    municipalityCode: nhiCase.inputs.municipality_code,
    taxYear: nhiCase.inputs.tax_year,
    previousYearTotalIncome: nhiCase.inputs.previous_year_total_income,
    insuredAges: nhiCase.inputs.insured_ages,
  });
  assert(nhiResult.assessmentBase.value === BigInt(nhiCase.expected.assessment_base) &&
    nhiResult.components.medical.incomeLevy.value === BigInt(nhiCase.expected.medical_income_levy) &&
    nhiResult.components.medical.perCapitaLevyBeforeReduction.value ===
      BigInt(nhiCase.expected.medical_per_capita_levy) &&
    nhiResult.components.medical.amount.value === BigInt(nhiCase.expected.medical) &&
    nhiResult.components.elderly_support.incomeLevy.value ===
      BigInt(nhiCase.expected.elderly_support_income_levy) &&
    nhiResult.components.elderly_support.perCapitaLevyBeforeReduction.value ===
      BigInt(nhiCase.expected.elderly_support_per_capita_levy) &&
    nhiResult.components.elderly_support.amount.value === BigInt(nhiCase.expected.elderly_support) &&
    nhiResult.components.child_rearing_support.incomeLevy.value ===
      BigInt(nhiCase.expected.child_rearing_support_income_levy) &&
    nhiResult.components.child_rearing_support.perCapitaLevyBeforeReduction.value ===
      BigInt(nhiCase.expected.child_rearing_support_per_capita_levy) &&
    nhiResult.components.child_rearing_support.amount.value === BigInt(nhiCase.expected.child_rearing_support) &&
    nhiResult.components.nursing_care.amount.value === BigInt(nhiCase.expected.nursing_care) &&
    nhiResult.annualPremium.value === BigInt(nhiCase.expected.annual_premium),
  'GC-NHI-SHIBUYA-500 の区分別・年間期待値と一致する');

  const ibtCase = cases.get('GC-IBT-TYPE3-500');
  const ibtResult = businessTax.calculate({
    businessCategory: ibtCase.inputs.business_category,
    businessIncome: ibtCase.inputs.business_income,
    businessMonths: ibtCase.inputs.business_months,
  });
  assert(ibtResult.ownerDeduction.num / ibtResult.ownerDeduction.den ===
    BigInt(ibtCase.expected.owner_deduction) &&
    ibtResult.taxableBase.value === BigInt(ibtCase.expected.taxable_base) &&
    ibtResult.taxAmount.value === BigInt(ibtCase.expected.tax_amount),
    'GC-IBT-TYPE3-500 は105,000円になる');

  const npCase = cases.get('GC-NP-R8');
  const npResult = pension.calculate({
    taxYear: npCase.inputs.tax_year,
    paymentMonths: npCase.inputs.payment_months,
    includeAdditionalPremium: npCase.inputs.include_additional_premium,
  });
  assert(npResult.monthlyPremium.value === BigInt(npCase.expected.monthly_premium) &&
    npResult.totalPremium.value === BigInt(npCase.expected.total_premium),
    'GC-NP-R8 は215,040円になる');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
