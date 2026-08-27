'use strict';

/**
 * 法人成りシミュレーターサービス第1版の合成テスト。
 *   node scripts/lib/__tests__/test-hojinnari-service.js
 */

const fs = require('fs');
const path = require('path');
const service = require('../../../src/simulators/hojinnari/index.js');
const masterSnapshot = require('../../../src/tax-engine/masters/snapshot.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const goldenDocument = JSON.parse(fs.readFileSync(path.join(
  REPO_ROOT, 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
), 'utf8'));
const golden = goldenDocument.cases.find(item => item.case_id === 'GC-HJ-STEADY-1200');
const yakuinGolden = goldenDocument.cases.find(item => item.case_id === 'GC-YH-MODE-C-500K');
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

function periodSegment(from, to, amount) {
  return { period: { from, to }, value: yen(amount) };
}

function plan(monthlyAmount = 500000) {
  return {
    monthlySegments: [{
      period: { from: '2025-04-01', to: '2026-03-31' },
      value: { monthlyAmount: yen(monthlyAmount) },
    }],
  };
}

function goldenInput() {
  return {
    precision: 'detailed',
    comparisonBasis: 'steady_state',
    individual: {
      business: {
        revenue: [periodSegment('2025-01-01', '2025-12-31', 20000000)],
        expenses: [periodSegment('2025-01-01', '2025-12-31', 8000000)],
        periodFacts: {},
        expensesExcludeSocialInsuranceAndMutualAid: 'yes',
        businessTaxCategory: 'type3_standard',
      },
      blueReturn: { status: 'blue', specialDeductionCategory: 'e_tax_650k' },
      self: { ageAtYearEnd: 39, disability: 'none' },
      residentTaxBasis: 'steady_state',
      nationalHealthInsurance: { kind: 'estimate_accepted' },
      nationalPension: { kind: 'standard', months: 12 },
    },
    corporate: {
      locationSameAsResidence: 'yes',
      capital: yen(3000000),
      employeeCount: 0,
      officerCompensation: plan(),
      healthInsurer: { kind: 'kyokai_kenpo', prefectureCode: '13' },
      revenue: [periodSegment('2025-04-01', '2026-03-31', 20000000)],
      expenses: [periodSegment('2025-04-01', '2026-03-31', 8000000)],
    },
    consumptionTax: { include: false },
    specialistChecks: {},
  };
}

function wireMoney(value) {
  return { unit: 'JPY', value: String(value) };
}

function goldenWire() {
  const input = goldenInput();
  function convert(value) {
    if (typeof value === 'bigint') return String(value);
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, convert(child)]));
    }
    return value;
  }
  return convert(input);
}

function warningCode(result, code) {
  return result.warnings.some(warning => warning.code === code);
}

function moneyFields(scenario) {
  return Object.fromEntries(Object.entries(scenario.burdens)
    .map(([key, value]) => [key, value.value]));
}

function assertBlocked(input, code, label) {
  const result = service.simulate(input, context(), snapshotInfo);
  assert(result.resultStatus === 'blocked' && warningCode(result, code) &&
    !Object.hasOwn(result, 'breakdown'), `${label}は理由コード ${code} 付き blocked になる`);
}

console.log('\n=== GC-HJ-STEADY-1200 ===');
const complete = service.simulate(goldenInput(), context(), snapshotInfo);
const expected = golden.expected;
const sole = complete.breakdown.data.soleProprietor;
const corporation = complete.breakdown.data.corporation;

assert(sole.personalDisposableCash.value === BigInt(expected.sole_personal_disposable_cash),
  '個人事業側の個人手取りが7,731,680円になる');
assert(sole.burdens.incomeTax.value === BigInt(expected.sole_income_tax) &&
  sole.burdens.residentTax.value === BigInt(expected.sole_resident_tax) &&
  sole.burdens.soleProprietorEnterpriseTax.value ===
    BigInt(expected.sole_proprietor_enterprise_tax) &&
  sole.burdens.socialInsuranceEmployee.value ===
    BigInt(expected.sole_social_insurance_deduction),
'個人事業側の所得税・住民税・個人事業税・社会保険がゴールデンと一致する');
assert(corporation.personalDisposableCash.value ===
  BigInt(expected.corporation_personal_disposable_cash) &&
  corporation.corporateRetainedCash.value === BigInt(expected.corporate_retained_cash),
'法人化側の個人手取りと税引後利益がゴールデンと一致する');
assert(corporation.burdens.incomeTax.value === BigInt(expected.corporation_income_tax) &&
  corporation.burdens.residentTax.value === BigInt(expected.corporation_resident_tax) &&
  corporation.burdens.socialInsuranceEmployee.value ===
    BigInt(expected.corporation_social_insurance_employee) &&
  corporation.burdens.socialInsuranceEmployer.value ===
    BigInt(expected.corporation_social_insurance_employer) &&
  corporation.burdens.corporateTaxes.value === BigInt(expected.corporate_taxes),
'法人化側の4負担項目がゴールデンと一致する');
assert(complete.breakdown.data.personalDisposableDifference.value ===
  BigInt(expected.personal_disposable_difference) &&
  complete.breakdown.data.combinedReferenceDifference.value ===
    BigInt(expected.combined_reference_difference) &&
  complete.summary.amount.value === BigInt(expected.combined_reference_difference),
'個人手取り差・参考差額・summaryがゴールデンと一致する');

console.log('\n=== ④ GC-YH-MODE-C-500K との相互検証 ===');
const yh = yakuinGolden.expected;
assert(corporation.personalDisposableCash.value === BigInt(yh.personal_net_cash) &&
  corporation.corporateRetainedCash.value === BigInt(yh.corporate_retained_cash) &&
  corporation.burdens.incomeTax.value === BigInt(yh.income_tax) &&
  corporation.burdens.residentTax.value === BigInt(yh.resident_tax) &&
  corporation.burdens.socialInsuranceEmployee.value === BigInt(yh.social_insurance_employee) &&
  corporation.burdens.socialInsuranceEmployer.value === BigInt(yh.social_insurance_employer) &&
  corporation.burdens.corporateTaxes.value === BigInt(yh.corporate_taxes_total),
'法人化側の全出力値が④のゴールデン期待値と一致する');

console.log('\n=== 負担合計と検算恒等式 ===');
const soleBurdenTotal = Object.values(moneyFields(sole))
  .reduce((total, value) => total + value, 0n);
const corporationBurdenTotal = Object.entries(moneyFields(corporation))
  .filter(([key]) => key !== 'socialInsuranceEmployer')
  .reduce((total, [, value]) => total + value, 0n);
assert(soleBurdenTotal === BigInt(expected.sole_burden_total),
  '個人事業側の負担合計が4,268,320円になる');
assert(corporationBurdenTotal ===
  BigInt(expected.corporation_burden_total_excluding_employer_social_insurance),
'法人化側の負担合計は会社負担社会保険を再加算せず2,593,200円になる');
assert(12000000n - soleBurdenTotal === sole.personalDisposableCash.value,
  '12,000,000－個人事業側負担合計＝個人手取り');
assert(12000000n - corporationBurdenTotal -
  corporation.burdens.socialInsuranceEmployer.value ===
  corporation.personalDisposableCash.value + corporation.corporateRetainedCash.value,
'12,000,000－法人化側負担合計－会社社会保険＝法人＋個人手残り');

console.log('\n=== SimulationResult の共通契約 ===');
assert(complete.simulatorType === 'hojinnari' && complete.resultStatus === 'complete' &&
  complete.comparisonBasis === 'steady_state' && complete.inputSchemaVersion === 'hojinnari-1.0',
'hojinnari・complete・steady_state・hojinnari-1.0を返す');
assert(complete.usedMasterRecords.length > 0 && complete.usedMasterRecords.some(record =>
  record.recordId.startsWith('NHI-RATE-13113-')),
'usedMasterRecordsに渋谷区の令和8年度NHI料率を含む');
assert(complete.sources.length > 0, 'sourcesが空でない');
assert(complete.assumptions.some(text => text.includes('平年度')) &&
  complete.assumptions.some(text => text.includes('国民健康保険料を概算')) &&
  complete.assumptions.some(text => text.includes('個人事業税は必要経費に算入していません')),
'assumptionsに平年度・国保概算・個人事業税非算入を明示する');
assert(complete.excludedItems.some(item =>
  item.code === 'HJ_CONSUMPTION_TAX_OUT_OF_COMPARISON' &&
  item.label === '消費税：比較対象外'),
'消費税OFFでも比較対象外のExcludedItemを返す');
assert(complete.warnings.some(warning => warning.level === 'info' &&
  warning.canContinue === true &&
  warning.basis === '法人内部に残る資金は社長個人が自由に使える資金ではありません。'),
'法人留保に関する指定文言をinfo警告で返す');

console.log('\n=== partial と入力分岐 ===');
const consumptionInput = goldenInput();
consumptionInput.consumptionTax = {
  include: true,
  individualPeriodInput: {},
  corporatePeriodInput: {},
};
const consumptionPartial = service.simulate(consumptionInput, context(), snapshotInfo);
assert(consumptionPartial.resultStatus === 'partial' &&
  consumptionPartial.excludedItems.some(item =>
    item.code === 'HJ_CONSUMPTION_TAX_SERVICE_UNAVAILABLE'),
'消費税ONは専用理由コードの除外項目付きpartialになる');

const differentLocationInput = goldenInput();
differentLocationInput.corporate.locationSameAsResidence = 'no';
const differentLocation = service.simulate(differentLocationInput, context(), snapshotInfo);
assert(differentLocation.resultStatus === 'partial' &&
  differentLocation.excludedItems.some(item =>
    item.code === 'HJ_CORPORATE_LOCATION_LOCAL_RATES_EXCLUDED'),
'法人所在地が異なる場合は自治体独自税率の除外項目付きpartialになる');
assert(JSON.stringify(moneyFields(differentLocation.breakdown.data.soleProprietor),
  (_key, value) => typeof value === 'bigint' ? String(value) : value) ===
  JSON.stringify(moneyFields(sole), (_key, value) => typeof value === 'bigint' ? String(value) : value) &&
  JSON.stringify(moneyFields(differentLocation.breakdown.data.corporation),
    (_key, value) => typeof value === 'bigint' ? String(value) : value) ===
  JSON.stringify(moneyFields(corporation),
    (_key, value) => typeof value === 'bigint' ? String(value) : value),
'法人所在地noでも計算数値はyesと同一になる');

const actualNhiInput = goldenInput();
actualNhiInput.individual.nationalHealthInsurance = {
  kind: 'actual', annualAmount: yen(960000),
};
const actualNhi = service.simulate(actualNhiInput, context(), snapshotInfo);
assert(actualNhi.resultStatus === 'complete' &&
  actualNhi.breakdown.data.soleProprietor.personalDisposableCash.value ===
    sole.personalDisposableCash.value &&
  JSON.stringify(moneyFields(actualNhi.breakdown.data.soleProprietor),
    (_key, value) => typeof value === 'bigint' ? String(value) : value) ===
  JSON.stringify(moneyFields(sole), (_key, value) => typeof value === 'bigint' ? String(value) : value),
'国保実額960,000円は概算パスと全結果が一致する');

const unregisteredNhiInput = goldenInput();
const unregisteredNhi = service.simulate(unregisteredNhiInput, context({
  jurisdiction: { ...context().jurisdiction, municipalityCode: '99999' },
}), snapshotInfo);
assert(unregisteredNhi.resultStatus === 'blocked' &&
  warningCode(unregisteredNhi, 'HJ_NHI_NHI_MUNICIPAL_RATE_NOT_REGISTERED'),
'国保概算で登録外自治体を指定すると理由コード付きblockedになる');

const whiteInput = goldenInput();
whiteInput.individual.blueReturn = { status: 'white' };
const white = service.simulate(whiteInput, context(), snapshotInfo);
assert(white.resultStatus === 'complete' &&
  white.breakdown.data.soleProprietor.personalDisposableCash.value <
    sole.personalDisposableCash.value,
'白色申告は青色控除0円の計算としてcompleteになる');

const notListedInput = goldenInput();
notListedInput.individual.business.businessTaxCategory = 'not_listed';
const notListed = service.simulate(notListedInput, context(), snapshotInfo);
assert(notListed.resultStatus === 'complete' &&
  notListed.breakdown.data.soleProprietor.burdens.soleProprietorEnterpriseTax.value === 0n,
'法定業種外は個人事業税0円でcompleteになる');

const costsInput = goldenInput();
costsInput.setupAndMaintenanceCosts = {
  incorporationCost: yen(250000),
  annualAccountingFee: yen(300000),
  annualLaborConsultantFee: yen(120000),
  otherAnnualCost: yen(30000),
};
const withCosts = service.simulate(costsInput, context(), snapshotInfo);
assert(withCosts.breakdown.data.corporation.setupAndMaintenanceCosts.value === 450000n &&
  withCosts.assumptions.some(text => text.includes('設立一時費用は平年度比較に含めていません')),
'年間維持費を合算し、設立一時費用を含めない前提を表示する');

console.log('\n=== 対応範囲外のblocked ===');
const blockedCases = [
  ['HJ_BLUE_RETURN_STATUS_UNKNOWN', '青色申告区分unknown', input => {
    input.individual.blueReturn = { status: 'unknown' };
  }],
  ['HJ_BLUE_RETURN_DEDUCTION_CATEGORY_REQUIRED', '青色申告で控除区分未指定', input => {
    input.individual.blueReturn = { status: 'blue' };
  }],
  ['HJ_BUSINESS_TAX_CATEGORY_UNKNOWN', '個人事業税区分unknown', input => {
    input.individual.business.businessTaxCategory = 'unknown';
  }],
  ['HJ_SPOUSE_UNSUPPORTED', '配偶者入力', input => {
    input.individual.spouse = { exists: true };
  }],
  ['HJ_DEPENDENTS_UNSUPPORTED', '扶養入力', input => {
    input.individual.dependents = [{ id: 'child-1', relation: 'child' }];
  }],
  ['HJ_OTHER_INCOMES_UNSUPPORTED', 'その他所得入力', input => {
    input.individual.otherIncomes = [{
      category: 'business', taxationMethod: 'aggregate', amount: yen(1),
    }];
  }],
  ['HJ_DEDUCTIONS_UNSUPPORTED', '所得控除入力', input => {
    input.individual.deductions = { smallEnterpriseMutualAid: yen(1) };
  }],
  ['HJ_TAX_CREDITS_UNSUPPORTED', '税額控除入力', input => {
    input.individual.taxCredits = { housingLoan: yen(1) };
  }],
  ['HJ_EMPLOYEES_UNSUPPORTED', '従業員1人', input => {
    input.corporate.employeeCount = 1;
  }],
  ['HJ_SPOUSE_OFFICER_UNSUPPORTED', '配偶者役員', input => {
    input.corporate.spouseOfficer = { isOfficer: true };
  }],
  ['HJ_LOSS_CARRYFORWARD_UNSUPPORTED', '繰越欠損金', input => {
    input.corporate.lossCarryforward = {
      losses: [{ fiscalYearStartedOn: '2024-04-01', amount: yen(1) }],
    };
  }],
  ['HJ_TAX_ADJUSTMENTS_UNSUPPORTED', '申告調整applies:yes', input => {
    input.corporate.taxAdjustments = {
      items: [{ code: 'entertainment', applies: 'yes', amount: yen(1), direction: 'add' }],
    };
  }],
  ['HJ_TAX_ADJUSTMENTS_UNSUPPORTED', '申告調整applies:unknown', input => {
    input.corporate.taxAdjustments = {
      items: [{ code: 'entertainment', applies: 'unknown' }],
    };
  }],
  ['HJ_TRANSITION_YEAR_UNSUPPORTED', 'transition_year', input => {
    input.comparisonBasis = 'transition_year';
  }],
  ['HJ_ACTUAL_RESIDENT_TAX_BASIS_UNSUPPORTED', '住民税actual_year', input => {
    input.individual.residentTaxBasis = 'actual_year';
  }],
  ['HJ_EXPENSES_EXCLUSION_CONFIRMATION_REQUIRED', '社会保険等を除く確認no', input => {
    input.individual.business.expensesExcludeSocialInsuranceAndMutualAid = 'no';
  }],
  ['HJ_SELF_AGE_REQUIRED', '年齢未入力', input => {
    delete input.individual.self.ageAtYearEnd;
  }],
  ['HJ_DISABILITY_UNSUPPORTED', '障害者控除あり', input => {
    input.individual.self.disability = 'general';
  }],
  ['HJ_NON_RESIDENT_UNSUPPORTED', '非居住者', input => {
    input.individual.self.isNonResident = true;
  }],
  ['HJ_HEALTH_INSURER_UNSUPPORTED', '協会けんぽ以外', input => {
    input.corporate.healthInsurer = { kind: 'kenpo_kumiai', insurerCode: 'TEST' };
  }],
  ['HJ_MIDYEAR_CHANGE_UNSUPPORTED', '役員報酬の期中改定', input => {
    input.corporate.officerCompensation.revisions = [{
      effectiveOn: '2025-10-01', reason: 'ordinary', newMonthlyAmount: yen(550000),
    }];
  }],
  ['HJ_BUSINESS_OPEN_CLOSE_DATE_UNSUPPORTED', '個人事業の開業日入力', input => {
    input.individual.business.periodFacts.openedOn = '2025-01-01';
  }],
  ['HJ_INDIVIDUAL_REVENUE_FULL_YEAR_REQUIRED', '個人売上が暦年全体でない', input => {
    input.individual.business.revenue[0].period.to = '2025-11-30';
  }],
  ['HJ_CORPORATE_EXPENSES_FULL_PERIOD_REQUIRED', '法人経費が事業年度全体でない', input => {
    input.corporate.expenses[0].period.to = '2026-02-28';
  }],
];
for (const [code, label, mutate] of blockedCases) {
  const input = goldenInput();
  mutate(input);
  assertBlocked(input, code, label);
}

console.log('\n=== 不変条件とvalidate ===');
assert(throws(() => service.simulate(goldenInput(), context({
  masterSnapshotHash: '0'.repeat(64),
}), snapshotInfo)), 'スナップショット不一致はblockedでなく例外になる');

const validWire = service.validate(goldenWire());
assert(validWire.ok && typeof validWire.value.corporate.capital.value === 'bigint',
  '正しい最小WireをokとしてMoneyをbigintへ変換する');
const invalidWire = goldenWire();
invalidWire.corporate.capital = wireMoney('1e3');
const invalidValidation = service.validate(invalidWire);
assert(!invalidValidation.ok && invalidValidation.errors.some(error =>
  error.fieldPath === '$.corporate.capital.value'),
'Moneyの指数表記1e3をok:falseで拒否する');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
