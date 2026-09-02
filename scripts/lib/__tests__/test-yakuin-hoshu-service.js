'use strict';

/**
 * 役員報酬シミュレーターサービス第1版の合成テスト。
 *   node scripts/lib/__tests__/test-yakuin-hoshu-service.js
 */

const fs = require('fs');
const path = require('path');
const service = require('../../../src/simulators/yakuin-hoshu/index.js');
const masterSnapshot = require('../../../src/tax-engine/masters/snapshot.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const goldenDocument = JSON.parse(fs.readFileSync(path.join(
  REPO_ROOT, 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
), 'utf8'));
const golden = goldenDocument.cases.find(item => item.case_id === 'GC-YH-MODE-C-500K');
const familyGolden = goldenDocument.cases.find(
  item => item.case_id === 'GC-YH-SPOUSE-DEP-500K'
);
const deductionGolden = goldenDocument.cases.find(
  item => item.case_id === 'GC-YH-DISABILITY-KYOSAI-500K'
);
const deduction2Golden = goldenDocument.cases.find(
  item => item.case_id === 'GC-YH-DEDUCTIONS2-500K'
);
const snapshotInfo = masterSnapshot.getSnapshotInfo();
const yen = value => ({ unit: 'JPY', value: BigInt(value) });

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

function throws(action) {
  try {
    action();
    return false;
  } catch (_error) {
    return true;
  }
}

function context(overrides = {}) {
  return {
    asOfDate: '2026-08-27',
    calculatedAt: '2026-08-27T12:00:00+09:00',
    incomeTaxYear: 2025,
    residentTaxFiscalYear: 2025,
    fiscalPeriod: { from: '2025-04-01', to: '2026-03-31' },
    socialInsuranceMonths: ['2025-04'],
    jurisdiction: {
      country: 'JP',
      codeSystemVersion: '2025-01',
      asOfForCodes: '2025-04-01',
      prefectureCode: '13',
      municipalityCode: '13113',
      isDesignatedCity: false,
    },
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
    ...overrides,
  };
}

function commonInput(overrides = {}) {
  return {
    precision: 'detailed',
    officerResidenceSameAsCompany: 'yes',
    capital: yen(3000000),
    employeeCount: 0,
    healthInsurer: { kind: 'kyokai_kenpo', prefectureCode: '13' },
    officer: { ageAtYearEnd: 39 },
    specialistChecks: {},
    ...overrides,
  };
}

function plan(monthlyAmount, overrides = {}) {
  return {
    monthlySegments: [{
      period: { from: '2025-04-01', to: '2026-03-31' },
      value: { monthlyAmount: yen(monthlyAmount) },
    }],
    ...overrides,
  };
}

function modeCInput(monthlyAmount = 500000, overrides = {}) {
  return {
    mode: 'C',
    ...commonInput(),
    // 利益は CalculationContext ではなく入力型で渡す（§3-2）
    profitBeforeOfficerCompensation: yen(12000000),
    plan: plan(monthlyAmount),
    ...overrides,
  };
}

function wireMoney(value) {
  return { unit: 'JPY', value: String(value) };
}

function modeCWire() {
  return {
    mode: 'C',
    precision: 'detailed',
    officerResidenceSameAsCompany: 'yes',
    capital: wireMoney(3000000),
    employeeCount: 0,
    healthInsurer: { kind: 'kyokai_kenpo', prefectureCode: '13' },
    officer: { ageAtYearEnd: 39 },
    specialistChecks: {},
    profitBeforeOfficerCompensation: wireMoney(12000000),
    plan: {
      monthlySegments: [{
        period: { from: '2025-04-01', to: '2026-03-31' },
        value: { monthlyAmount: wireMoney(500000) },
      }],
    },
  };
}

function candidateOf(result) {
  return result.breakdown.data.candidates.find(candidate =>
    candidate.planId === result.breakdown.data.selectedPlanId
  ) || result.breakdown.data.candidates[0];
}

console.log('\n=== MODE C: GC-YH-MODE-C-500K ===');
const modeC = service.simulate(modeCInput(), context(), snapshotInfo);
const candidate = candidateOf(modeC);
const expected = golden.expected;
const expectedFields = {
  salaryIncome: 'salary_income',
  incomeTaxBasicDeduction: 'income_tax_basic_deduction',
  incomeTaxTaxableIncome: 'income_tax_taxable_income',
  socialInsuranceEmployee: 'social_insurance_employee',
  incomeTax: 'income_tax',
  residentTax: 'resident_tax',
  residentTaxTaxableIncome: 'resident_tax_taxable_income',
  residentTaxAdjustmentDeduction: 'resident_tax_adjustment_deduction',
  personalNetCash: 'personal_net_cash',
  socialInsuranceEmployer: 'social_insurance_employer',
  corporateIncome: 'corporate_income',
  corporateTaxes: 'corporate_taxes_total',
  corporateRetainedCash: 'corporate_retained_cash',
  combinedCash: 'combined_cash',
};
for (const [actualField, expectedField] of Object.entries(expectedFields)) {
  assert(candidate[actualField].value === BigInt(expected[expectedField]),
    `${actualField} がゴールデン期待値 ${expected[expectedField]} 円と一致する`);
}
assert(candidate.healthInsuranceEmployee.value === BigInt(expected.health_insurance_employee) &&
  candidate.employeesPensionEmployee.value === BigInt(expected.employees_pension_employee),
'本人社会保険の健保・厚年内訳が一致する');
assert(candidate.healthInsuranceEmployerExact.num / candidate.healthInsuranceEmployerExact.den ===
  BigInt(expected.health_insurance_employer) &&
  candidate.employeesPensionEmployerExact.num / candidate.employeesPensionEmployerExact.den ===
  BigInt(expected.employees_pension_employer) &&
  candidate.childSupportLevyEmployerExact.num /
    candidate.childSupportLevyEmployerExact.den ===
    BigInt(expected.child_support_levy_employer),
'会社負担社会保険の健保・厚年・拠出金内訳が一致する');
assert(Object.entries({
  corporateTax: 'corporate_tax',
  localCorporateTax: 'local_corporate_tax',
  prefecturalInhabitantIncomeLevy: 'inhabitant_tax_prefectural_income_levy',
  municipalInhabitantIncomeLevy: 'inhabitant_tax_municipal_income_levy',
  inhabitantPerCapitaLevy: 'inhabitant_tax_per_capita_total',
  enterpriseTax: 'enterprise_tax',
  specialEnterpriseTax: 'special_enterprise_tax',
}).every(([actualField, expectedField]) =>
  candidate.corporateTaxDetails[actualField].value === BigInt(expected[expectedField])),
'法人税等7内訳がゴールデン期待値と一致する');
assert(candidate.corporateIncome.value === 12000000n - 6000000n - 867900n,
'会社負担社会保険867,900円を法人所得から控除している');

console.log('\n=== MODE C: GC-YH-SPOUSE-DEP-500K ===');
const familyModeC = service.simulate(modeCInput(500000, {
  officer: { ageAtYearEnd: 45 },
  spouse: { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) },
  dependents: [
    { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
    { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
  ],
}), context(), snapshotInfo);
const familyCandidate = candidateOf(familyModeC);
const familyExpected = familyGolden.expected;
const familyFields = {
  salaryIncome: 'salary_income',
  totalIncomeDeductions: 'income_tax_total_deductions',
  incomeTaxTaxableIncome: 'income_tax_taxable_income',
  socialInsuranceEmployee: 'social_insurance_employee',
  incomeTax: 'income_tax',
  residentTaxAdjustmentDeduction: 'resident_tax_adjustment_deduction',
  residentTax: 'resident_tax',
  personalNetCash: 'personal_net_cash',
  socialInsuranceEmployer: 'social_insurance_employer',
  corporateIncome: 'corporate_income',
  corporateTaxes: 'corporate_taxes_total',
  corporateRetainedCash: 'corporate_retained_cash',
  combinedCash: 'combined_cash',
};
for (const [actualField, expectedField] of Object.entries(familyFields)) {
  assert(familyCandidate[actualField].value === BigInt(familyExpected[expectedField]),
    `家族ケースの${actualField}が指定期待値${familyExpected[expectedField]}円と一致する`);
}
const familyDeductions = new Map(
  familyCandidate.orderedIncomeDeductions.map(row => [row.code, row.amount.value])
);
assert(familyDeductions.get('socialInsurance') === 894000n &&
  familyDeductions.get('spouse') === 380000n &&
  familyDeductions.get('dependents') === 1010000n &&
  familyDeductions.get('basic') === 680000n,
'所得控除計296.4万円の社保・配偶者・扶養・基礎の内訳が一致する');
assert(Object.entries({
  corporateTax: 'corporate_tax',
  localCorporateTax: 'local_corporate_tax',
  prefecturalInhabitantIncomeLevy: 'inhabitant_tax_prefectural_income_levy',
  municipalInhabitantIncomeLevy: 'inhabitant_tax_municipal_income_levy',
  inhabitantPerCapitaLevy: 'inhabitant_tax_per_capita_total',
  enterpriseTax: 'enterprise_tax',
  specialEnterpriseTax: 'special_enterprise_tax',
}).every(([actualField, expectedField]) =>
  familyCandidate.corporateTaxDetails[actualField].value === BigInt(familyExpected[expectedField])),
'家族ケースの法人税等7内訳が指定期待値と一致する');

// 手計算確認: 令和7年分マスターは配偶者所得95万円以下・本人所得900万円以下を
// 配偶者特別控除38万円の帯としている（95万1円から36万円）。
const spouseSpecial = service.simulate(modeCInput(500000, {
  officer: { ageAtYearEnd: 45 },
  spouse: { exists: true, totalIncome: yen(950000) },
}), context(), snapshotInfo);
const spouseSpecialRows = new Map(candidateOf(spouseSpecial).orderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
assert(spouseSpecialRows.get('spouse') === 0n &&
  spouseSpecialRows.get('spouseSpecial') === 380000n,
'配偶者所得95万円は配偶者控除0円・配偶者特別控除38万円になる');

console.log('\n=== MODE C: GC-YH-DISABILITY-KYOSAI-500K ===');
const deductionModeC = service.simulate(modeCInput(500000, {
  officer: { ageAtYearEnd: 45, disability: 'general' },
  spouse: { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) },
  dependents: [
    { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
    { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
  ],
  deductions: { smallEnterpriseMutualAid: yen(276000) },
}), context(), snapshotInfo);
const deductionCandidate = candidateOf(deductionModeC);
const deductionExpected = deductionGolden.expected;
for (const [actualField, expectedField] of Object.entries({
  salaryIncome: 'salary_income',
  totalIncomeDeductions: 'income_tax_total_deductions',
  incomeTaxTaxableIncome: 'income_tax_taxable_income',
  incomeTax: 'income_tax',
  residentTaxAdjustmentDeduction: 'resident_tax_adjustment_deduction',
  residentTax: 'resident_tax',
  personalNetCash: 'personal_net_cash',
  socialInsuranceEmployer: 'social_insurance_employer',
  corporateIncome: 'corporate_income',
  corporateTaxes: 'corporate_taxes_total',
  corporateRetainedCash: 'corporate_retained_cash',
  combinedCash: 'combined_cash',
})) {
  assert(deductionCandidate[actualField].value === BigInt(deductionExpected[expectedField]),
    `障害・掛金ケースの${actualField}が指定期待値${deductionExpected[expectedField]}円と一致する`);
}
const deductionRows = new Map(deductionCandidate.orderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
assert(deductionRows.get('socialInsurance') === 894000n &&
  deductionRows.get('spouse') === 380000n && deductionRows.get('dependents') === 1010000n &&
  deductionRows.get('disability') === 270000n &&
  deductionRows.get('smallEnterpriseMutualAid') === 276000n &&
  deductionRows.get('basic') === 680000n,
'所得控除計351万円の社保・配偶者・扶養・障害者・掛金・基礎の内訳が一致する');
assert(6000000n - 894000n - 43300n - 127000n === deductionCandidate.personalNetCash.value &&
  deductionCandidate.combinedCash.value ===
    deductionCandidate.personalNetCash.value + deductionCandidate.corporateRetainedCash.value,
'掛金を手取りから差し引かず、個人手取りと法人留保の合計が8,785,400円になる');
assert(deductionModeC.assumptions.some(text => text.includes('掛金そのものは支出として差し引いていません')),
'掛金そのものを支出控除しない前提を表示する');

const cohabitingSpouse = service.simulate(modeCInput(500000, {
  officer: { ageAtYearEnd: 45, disability: 'none' },
  spouse: {
    exists: true, ageAtYearEnd: 40, totalIncome: yen(0), disability: 'special_cohabiting',
  },
}), context(), snapshotInfo);
const cohabitingCandidate = candidateOf(cohabitingSpouse);
const cohabitingIncomeRows = new Map(cohabitingCandidate.orderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
const cohabitingResidentRows = new Map(cohabitingCandidate.residentTaxOrderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
assert(cohabitingIncomeRows.get('disability') === 750000n &&
  cohabitingResidentRows.get('disability') === 530000n,
'配偶者の特別（同居）を所得税75万円・住民税53万円として両エンジンへ渡す');

console.log('\n=== MODE C: GC-YH-DEDUCTIONS2-500K ===');
const phase2Deductions = {
  smallEnterpriseMutualAid: yen(276000),
  lifeInsurance: [
    { generation: 'new', category: 'life', annualPremium: yen(120000) },
    { generation: 'new', category: 'nursing_medical', annualPremium: yen(80000) },
  ],
  earthquakeInsurance: [{ category: 'earthquake', annualPremium: yen(50000) }],
  donations: [{ kind: 'furusato', amount: yen(20000) }],
};
const deduction2Result = service.simulate(modeCInput(500000, {
  officer: { ageAtYearEnd: 45, disability: 'general' },
  spouse: { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) },
  dependents: [
    { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
    { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
  ],
  deductions: phase2Deductions,
  taxCredits: { housingLoan: yen(100000) },
}), context(), snapshotInfo);
const deduction2Candidate = candidateOf(deduction2Result);
const deduction2Expected = deduction2Golden.expected;
for (const [actualField, expectedField] of Object.entries({
  totalIncomeDeductions: 'income_tax_total_deductions',
  incomeTaxTaxableIncome: 'income_tax_taxable_income',
  incomeTaxCalculatedAmount: 'income_tax_calculated_amount',
  incomeTax: 'income_tax',
  residentTaxTaxableIncome: 'resident_tax_taxable_income',
  residentTaxAdjustmentDeduction: 'resident_tax_adjustment_deduction',
  residentTaxPrefecturalIncomeLevy: 'resident_tax_prefectural_income_levy',
  residentTaxMunicipalIncomeLevy: 'resident_tax_municipal_income_levy',
  residentTax: 'resident_tax',
  personalNetCash: 'personal_net_cash',
  corporateTaxes: 'corporate_taxes_total',
  corporateRetainedCash: 'corporate_retained_cash',
  combinedCash: 'combined_cash',
})) {
  assert(deduction2Candidate[actualField].value === BigInt(deduction2Expected[expectedField]),
    `控除第2弾の${actualField}が指定期待値${deduction2Expected[expectedField]}円と一致する`);
}
const deduction2Rows = new Map(deduction2Candidate.orderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
const deduction2ResidentRows = new Map(deduction2Candidate.residentTaxOrderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
assert(deduction2Rows.get('lifeInsurance') + deduction2Rows.get('earthquakeInsurance') === 130000n &&
  deduction2Rows.get('donations') === 18000n,
'所得税の生保・地震13万円、寄附金1.8万円を固定する');
assert(deduction2ResidentRows.get('lifeInsurance') +
  deduction2ResidentRows.get('earthquakeInsurance') === 81000n,
'住民税の生保・地震控除8.1万円を固定する');
assert(deduction2Candidate.housingLoanCredit.value -
  deduction2Candidate.appliedHousingLoanCredit.value === 64900n &&
  deduction2Candidate.residentTaxHousingLoanCredit.amount.value === 35100n,
'所得税で引き切れない64,900円を住民税へ渡し、5%基数35,100円で止める');
assert(deduction2Candidate.residentTaxDonationCredit.specialRate.num === 17n &&
  deduction2Candidate.residentTaxDonationCredit.specialRate.den === 20n &&
  deduction2Candidate.residentTaxDonationCredit.special.value === 15300n,
'特例控除率は条文表の85%を使い15,300円にする');
assert(6000000n - 894000n - 0n - 66600n === deduction2Candidate.personalNetCash.value &&
  deduction2Candidate.combinedCash.value === 8889100n,
'法人化側の恒等式と手残り8,889,100円を固定する');
assert(deduction2Result.assumptions.some(text => text.includes('ワンストップ特例は使用していません')),
'④のassumptionsに確定申告前提・ワンストップ不使用を明示する');

const overCapInput = modeCInput(500000, {
  officer: { ageAtYearEnd: 45, disability: 'general' },
  spouse: { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) },
  dependents: [
    { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
    { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
  ],
  deductions: {
    ...phase2Deductions,
    donations: [{ kind: 'furusato', amount: yen(52000) }],
  },
  taxCredits: { housingLoan: yen(100000) },
});
const overCap = service.simulate(overCapInput, context(), snapshotInfo);
assert(candidateOf(overCap).residentTaxDonationCredit.special.value === 22780n &&
  overCap.warnings.some(warning => warning.code === 'RT_FURUSATO_SPECIAL_CREDIT_CAP_REACHED'),
'寄附52,000円は特例22,780円で頭打ちになり警告を表示する');

console.log('\n=== SimulationResult の共通契約 ===');
assert(modeC.simulatorType === 'yakuin_hoshu' && modeC.resultStatus === 'complete' &&
  modeC.comparisonBasis === 'steady_state',
'simulatorType・complete・steady_state を返す');
assert(modeC.usedMasterRecords.length > 0, 'usedMasterRecords が空でない');
assert(modeC.sources.length > 0 && modeC.sources.every(source =>
  typeof source.title === 'string' && typeof source.url === 'string'),
'使用マスターの sourceIds から出典台帳を引いている');
assert(modeC.assumptions.some(text => text.includes('平年度')) &&
  modeC.assumptions.some(text => text.includes('保険年度')),
'平年度と保険年度・暦年のずれを assumptions に明示する');

console.log('\n=== MODE A: 40万～60万円を1万円刻みで探索 ===');
const modeAInput = {
  mode: 'A',
  ...commonInput(),
  profitBeforeOfficerCompensation: yen(12000000),
  previousMonthlyAmount: yen(400000),
  searchUpperBound: yen(600000),
  searchStep: '10000',
  optimizationCriterion: 'max_total_retained',
};
const modeA = service.simulate(modeAInput, context(), snapshotInfo);
const selectedA = candidateOf(modeA);
assert(modeA.breakdown.data.candidates.length === 21, '候補が21件ある');
const maximum = modeA.breakdown.data.candidates.reduce((value, row) =>
  row.combinedCash.value > value ? row.combinedCash.value : value, -1n);
assert(modeA.breakdown.data.candidates.filter(row => row.combinedCash.value === maximum).length === 1 &&
  selectedA.combinedCash.value === maximum,
'基準Bの最大候補が一意に決まる');
const selectedModeC = service.simulate(modeCInput(Number(selectedA.monthlyCompensation.value)),
  context(), snapshotInfo);
const selectedModeCCandidate = candidateOf(selectedModeC);
assert(['personalNetCash', 'corporateRetainedCash', 'combinedCash', 'totalTaxAndInsurance']
  .every(field => selectedA[field].value === selectedModeCCandidate[field].value),
'MODE A の最適候補が同じ月額の MODE C 単発結果と一致する');
assert(modeA.assumptions.some(text => text.includes('同価値')),
'基準Bの法人留保と個人可処分所得を同価値とみなす仮定を表示する');

console.log('\n=== MODE A: 探索上限付近 ===');
const upperResult = service.simulate({
  ...modeAInput,
  searchUpperBound: yen(420000),
}, context(), snapshotInfo);
assert(upperResult.breakdown.data.nearUpperBound === true &&
  !Object.hasOwn(upperResult.breakdown.data, 'selectedPlanId') &&
  upperResult.breakdown.data.provisionalPlanId === 'monthly-420000' &&
  upperResult.warnings.some(warning => warning.code === 'YH_SEARCH_UPPER_BOUND_NEAR'),
'上限が最良のとき上限付近フラグを立て、確定最適の selectedPlanId を返さない');

console.log('\n=== MODE B: 希望手取りから順算探索 ===');
const modeB = service.simulate({
  mode: 'B',
  ...commonInput(),
  desiredMonthlyNetIncome: yen(387775),
  searchStep: '10000',
  // 法人側も合成するため利益を入力型で渡す（§3-2）
  profitBeforeOfficerCompensation: yen(12000000),
}, context(), snapshotInfo);
assert(modeB.summary.amount.value === 500000n &&
  modeB.breakdown.data.inverseVerifiedByForwardCalculation === true,
'月387,775円の手取りを満たす最小報酬月額が50万円になる');
const inverseModeC = service.simulate(modeCInput(Number(modeB.summary.amount.value)),
  context(), snapshotInfo);
assert(candidateOf(inverseModeC).personalNetCash.value === 387775n * 12n,
'逆算した報酬をMODE Cで順算し直すと希望年額手取りに一致する');

console.log('\n=== 不変条件と blocked ===');
assert(throws(() => service.simulate(modeCInput(), context({
  masterSnapshotHash: '0'.repeat(64),
}), snapshotInfo)), 'スナップショット不一致は例外になる');
const blockedCases = [
  [modeCInput(500000, { plan: plan(500000, {
    bonuses: [{ payOn: '2025-12-25', amount: yen(100000), hasFiling: 'yes' }],
  }) }), 'YH_BONUS_UNSUPPORTED', '賞与'],
  [modeCInput(500000, { plan: plan(500000, {
    revisions: [{ effectiveOn: '2025-10-01', reason: 'ordinary',
      newMonthlyAmount: yen(550000) }],
  }) }), 'YH_MIDYEAR_CHANGE_UNSUPPORTED', '期中改定'],
  [modeCInput(500000, {
    healthInsurer: { kind: 'kenpo_kumiai', insurerCode: 'TEST' },
  }), 'YH_HEALTH_INSURER_UNSUPPORTED', '健保組合'],
  [modeCInput(500000, {
    deductions: { medical: { mode: 'medical', paidAmount: yen(1) } },
  }), 'YH_DEDUCTIONS_UNSUPPORTED', '医療費控除'],
  [modeCInput(500000, {
    deductions: { donations: [{ kind: 'other', amount: yen(1) }] },
  }), 'YH_DEDUCTIONS_UNSUPPORTED', 'ふるさと納税以外の寄附金控除'],
  [modeCInput(500000, {
    taxCredits: { other: [{ code: 'other', amount: yen(1) }] },
  }), 'YH_TAX_CREDITS_UNSUPPORTED', 'その他税額控除'],
];
for (const [input, code, label] of blockedCases) {
  const result = service.simulate(input, context(), snapshotInfo);
  assert(result.resultStatus === 'blocked' &&
    result.warnings.some(warning => warning.code === code) &&
    !Object.hasOwn(result, 'breakdown'),
  `${label}は理由コード付き blocked になる`);
}

console.log('\n=== validate: Wire入力 ===');
const validWire = service.validate(modeCWire());
assert(validWire.ok && typeof validWire.value.capital.value === 'bigint',
'正しいWire入力をcore validatorで計算用Moneyへ変換する');
const familyWire = modeCWire();
familyWire.spouse = { exists: true, totalIncome: wireMoney(0) };
familyWire.dependents = [{
  id: 'specific-1', ageAtYearEnd: 20, relation: 'child', livesTogether: true,
  totalIncome: wireMoney(0),
}];
const familyValidation = service.validate(familyWire);
assert(familyValidation.ok && familyValidation.value.spouse.totalIncome.value === 0n &&
  familyValidation.value.dependents[0].ageAtYearEnd === 20,
'④Wireのspouse/dependentsを検証して計算用入力へ通す');
const deductionWire = modeCWire();
deductionWire.deductions = { smallEnterpriseMutualAid: wireMoney(276000) };
assert(service.validate(deductionWire).ok,
  '④Wireのdeductionsは小規模企業共済等掛金控除を受け付ける');
deductionWire.deductions.lifeInsurance = [{
  generation: 'new', category: 'life', annualPremium: wireMoney(120000),
}];
deductionWire.deductions.earthquakeInsurance = [{
  category: 'earthquake', annualPremium: wireMoney(50000),
}];
deductionWire.deductions.donations = [{ kind: 'furusato', amount: wireMoney(20000) }];
deductionWire.taxCredits = { housingLoan: wireMoney(100000) };
assert(service.validate(deductionWire).ok,
  '④Wireの生保・地震・ふるさと納税・住宅ローン控除を型段階で受け付ける');
familyWire.spouse.unknownProperty = true;
assert(!service.validate(familyWire).ok,
'④Wireのspouse内の未知プロパティは引き続き拒否する');
const invalidWire = modeCWire();
invalidWire.capital.value = '1e3';
const invalidResult = service.validate(invalidWire);
assert(!invalidResult.ok && invalidResult.errors.some(error =>
  error.fieldPath === '$.capital.value'),
'指数表記のMoney Wireを ok:false で拒否する');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
