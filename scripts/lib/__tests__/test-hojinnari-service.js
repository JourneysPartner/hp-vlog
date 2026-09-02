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
const familyGolden = goldenDocument.cases.find(item => item.case_id === 'GC-HJ-SPOUSE-DEP');
const familyYakuinGolden = goldenDocument.cases.find(
  item => item.case_id === 'GC-YH-SPOUSE-DEP-500K'
);
const deductionGolden = goldenDocument.cases.find(
  item => item.case_id === 'GC-HJ-DISABILITY-KYOSAI'
);
const deductionYakuinGolden = goldenDocument.cases.find(
  item => item.case_id === 'GC-YH-DISABILITY-KYOSAI-500K'
);
const deduction2Golden = goldenDocument.cases.find(
  item => item.case_id === 'GC-HJ-DEDUCTIONS2'
);
const snapshotInfo = masterSnapshot.getSnapshotInfo();
const yen = value => ({ unit: 'JPY', value: BigInt(value) });
const taxIncl = value => ({ basis: 'inclusive', amount: yen(value) });

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

function filing(kind, filed, effectiveFromPeriodStart) {
  const row = { kind, filed };
  if (effectiveFromPeriodStart) row.effectiveFromPeriodStart = effectiveFromPeriodStart;
  return row;
}

function shohizeiPeriodInput({
  taxpayerType = 'individual',
  period = { from: '2025-01-01', to: '2025-12-31' },
} = {}) {
  const isCorporation = taxpayerType === 'corporation';
  return {
    precision: 'detailed',
    taxpayerType,
    eligibility: {
      invoiceRegistration: {
        registered: 'yes',
        registeredOn: '2023-10-01',
        becameTaxableByRegistration: 'yes',
      },
      basePeriod: isCorporation
        ? { exists: false }
        : { exists: true, taxableSales: yen(9000000), lengthInMonths: 12 },
      specifiedPeriod: isCorporation
        ? {}
        : { taxableSales: yen(9000000), salaryPayments: yen(3000000) },
      filings: isCorporation
        ? [
          filing('taxable_person_election', 'no'),
          filing('simplified_election', 'no'),
        ]
        : [filing('simplified_election', 'yes', period.from)],
    },
    sales: [{
      period,
      value: {
        kind: 'detailed',
        taxable: [{ band: 'standard_10', amount: taxIncl(11000000) }],
      },
    }],
    purchases: [{
      period,
      value: {
        kind: 'detailed',
        taxableWithInvoice: [{ band: 'standard_10', amount: taxIncl(4400000) }],
        taxableWithoutInvoice: [],
      },
    }],
    simplified: { categorySelectedByUser: true, primaryCategory: 'type5' },
    specialistChecks: {},
  };
}

function consumptionTaxIncludedInput() {
  const input = goldenInput();
  input.consumptionTax = {
    include: true,
    individualPeriodInput: shohizeiPeriodInput(),
    corporatePeriodInput: shohizeiPeriodInput({
      taxpayerType: 'corporation',
      period: { from: '2025-04-01', to: '2026-03-31' },
    }),
  };
  return input;
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

console.log('\n=== ②消費税サービスとの接続 ===');
const sourceContext = context();
const derivedIndividual = service.deriveIndividualConsumptionTaxContext(sourceContext);
const derivedCorporate = service.deriveCorporateConsumptionTaxContext(sourceContext);
assert(derivedIndividual.consumptionTaxPeriod.from === '2025-01-01' &&
  derivedIndividual.consumptionTaxPeriod.to === '2025-12-31' &&
  derivedCorporate.consumptionTaxPeriod === sourceContext.fiscalPeriod,
'個人側は所得税年の暦年、法人側はfiscalPeriodから消費税課税期間を派生する');
assert([
  'masterSnapshotId', 'masterSnapshotHash', 'asOfDate', 'calculatedAt', 'jurisdiction',
].every(key => derivedIndividual[key] === sourceContext[key]) &&
  ['masterSnapshotId', 'masterSnapshotHash', 'asOfDate', 'calculatedAt', 'jurisdiction']
    .every(key => derivedCorporate[key] === sourceContext[key]),
'派生コンテキストはスナップショット・日時・jurisdictionを元の値から引き継ぐ');

const consumptionConnected = service.simulate(
  consumptionTaxIncludedInput(), context(), snapshotInfo
);
const connectedSole = consumptionConnected.breakdown.data.soleProprietor;
const connectedCorporation = consumptionConnected.breakdown.data.corporation;
assert(consumptionConnected.resultStatus === 'complete' &&
  connectedSole.burdens.consumptionTax.value === 200000n &&
  connectedCorporation.burdens.consumptionTax.value === 200000n,
'個人・法人とも②の2割特例の納付額200,000円を採用してcompleteになる');
assert(connectedSole.personalDisposableCash.value === 7531680n &&
  connectedCorporation.corporateRetainedCash.value === 3685600n,
'消費税を個人手取りと法人留保からだけ控除する');
assert(consumptionConnected.breakdown.data.combinedReferenceDifference.value ===
  (4653300n + 3685600n) - 7531680n &&
  consumptionConnected.breakdown.data.combinedReferenceDifference.value === 807220n &&
  consumptionConnected.breakdown.data.personalDisposableDifference.value ===
    4653300n - 7531680n,
'(4,653,300＋3,685,600)－7,531,680＝807,220円で、両側同額控除なら参考差額は不変');
assert(consumptionConnected.assumptions.some(text =>
  text.includes('2割特例') && text.includes('twenty_percent_special') &&
  text.includes('②の判定による推奨方式')) &&
  consumptionConnected.assumptions.some(text =>
    text.includes('税抜経理') && text.includes('損金へ影響させず') &&
    text.includes('控除対象外消費税額等')),
'assumptionsに推奨方式と税抜経理・二重計上禁止の前提を明示する');
assert(consumptionConnected.warnings.some(warning =>
  warning.code === 'HJ_CONSUMPTION_TAX_SALES_MISMATCH' && warning.canContinue === true &&
  warning.basis.includes('①の売上の経理方式')),
'①の2,000万円と②の税抜換算後1,000万円が不一致なら継続可能な警告を返す');
assert(consumptionConnected.usedMasterRecords.some(record =>
  record.recordId === 'CT-SPECIAL-2WARI'),
'①の単一追跡セッションで②が使用した2割特例マスターも収集する');

const salesMatchedInput = consumptionTaxIncludedInput();
for (const side of ['individualPeriodInput', 'corporatePeriodInput']) {
  salesMatchedInput.consumptionTax[side].sales[0].value.taxable[0].amount = {
    basis: 'exclusive', amount: yen(20000000),
  };
}
const salesMatched = service.simulate(salesMatchedInput, context(), snapshotInfo);
assert(!warningCode(salesMatched, 'HJ_CONSUMPTION_TAX_SALES_MISMATCH'),
'②両期間の税抜課税売上が①の各売上と一致すれば不突合警告を返さない');

const consumptionBlockedInput = consumptionTaxIncludedInput();
consumptionBlockedInput.consumptionTax.individualPeriodInput.sales[0].value.exportExempt =
  taxIncl(1100000);
const consumptionBlocked = service.simulate(consumptionBlockedInput, context(), snapshotInfo);
assert(consumptionBlocked.resultStatus === 'partial' &&
  !Object.hasOwn(consumptionBlocked.breakdown.data.soleProprietor.burdens, 'consumptionTax') &&
  !Object.hasOwn(consumptionBlocked.breakdown.data.corporation.burdens, 'consumptionTax') &&
  consumptionBlocked.excludedItems.some(item =>
    item.code === 'HJ_CONSUMPTION_TAX_METHOD_UNDETERMINED_BY_SHOHIZEI') &&
  !consumptionBlocked.excludedItems.some(item =>
    item.code === 'HJ_CONSUMPTION_TAX_SERVICE_UNAVAILABLE'),
'②がblockedなら消費税だけを新理由コードの除外項目へ落としてpartialにする');

const individualExemptInput = consumptionTaxIncludedInput();
const exemptIndividual = individualExemptInput.consumptionTax.individualPeriodInput;
exemptIndividual.eligibility.invoiceRegistration = { registered: 'no' };
exemptIndividual.eligibility.basePeriod = {
  exists: true, taxableSales: yen(8000000), lengthInMonths: 12,
};
exemptIndividual.eligibility.specifiedPeriod = {
  taxableSales: yen(8000000), salaryPayments: yen(2000000),
};
exemptIndividual.eligibility.filings = [
  filing('taxable_person_election', 'no'),
  filing('simplified_election', 'no'),
];
const individualExempt = service.simulate(individualExemptInput, context(), snapshotInfo);
assert(individualExempt.resultStatus === 'complete' &&
  !Object.hasOwn(individualExempt.breakdown.data.soleProprietor.burdens, 'consumptionTax') &&
  individualExempt.breakdown.data.corporation.burdens.consumptionTax.value === 200000n &&
  individualExempt.breakdown.data.corporation.corporateRetainedCash.value === 3685600n &&
  individualExempt.assumptions.some(text =>
    text.includes('個人側は免税事業者のため消費税の納税義務なし')),
'②で個人側が免税ならconsumptionTaxを省略し、法人側だけ控除して免税前提を表示する');

console.log('\n=== partial と入力分岐 ===');

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

console.log('\n=== GC-HJ-SPOUSE-DEP ===');
const familyInput = goldenInput();
familyInput.individual.self.ageAtYearEnd = 45;
familyInput.individual.spouse = { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) };
familyInput.individual.dependents = [
  { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
  { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
];
const familyResult = service.simulate(familyInput, context(), snapshotInfo);
const familySole = familyResult.breakdown.data.soleProprietor;
const familyCorporation = familyResult.breakdown.data.corporation;
const familyExpected = familyGolden.expected;
const familySoleDeductions = new Map(
  familySole.orderedIncomeDeductions.map(row => [row.code, row.amount.value])
);
const familyCorporationDeductions = new Map(
  familyCorporation.orderedIncomeDeductions.map(row => [row.code, row.amount.value])
);
assert(familySoleDeductions.get('spouse') === BigInt(familyExpected.sole_spouse_deduction) &&
  familyCorporationDeductions.get('spouse') ===
    BigInt(familyExpected.corporation_spouse_deduction),
'同じ配偶者を個人側と④へ渡し、配偶者控除を個人0円・法人化38万円で固定する');
assert(familySoleDeductions.get('dependents') ===
    BigInt(familyExpected.sole_dependent_deduction) &&
  familyCorporationDeductions.get('dependents') ===
    BigInt(familyExpected.corporation_dependent_deduction),
'同じ扶養親族を個人側と法人化側へ渡し、扶養控除101万円で固定する');
assert(familySole.incomeTaxTaxableIncome.value ===
    BigInt(familyExpected.sole_income_tax_taxable_income) &&
  familySole.burdens.incomeTax.value === BigInt(familyExpected.sole_income_tax) &&
  familySole.residentTaxAdjustmentDeduction.value ===
    BigInt(familyExpected.sole_resident_tax_adjustment_deduction) &&
  familySole.burdens.residentTax.value === BigInt(familyExpected.sole_resident_tax) &&
  familySole.burdens.soleProprietorEnterpriseTax.value ===
    BigInt(familyExpected.sole_proprietor_enterprise_tax) &&
  familySole.burdens.socialInsuranceEmployee.value === 1340120n &&
  familySole.personalDisposableCash.value ===
    BigInt(familyExpected.sole_personal_disposable_cash),
'家族ケースの個人側全指定項目がゴールデン期待値と一致する');
assert(familyCorporation.personalDisposableCash.value ===
    BigInt(familyExpected.corporation_personal_disposable_cash) &&
  familyCorporation.corporateRetainedCash.value ===
    BigInt(familyExpected.corporate_retained_cash) &&
  familyCorporation.burdens.incomeTax.value ===
    BigInt(familyExpected.corporation_income_tax) &&
  familyCorporation.burdens.residentTax.value ===
    BigInt(familyExpected.corporation_resident_tax) &&
  familyCorporation.burdens.socialInsuranceEmployee.value ===
    BigInt(familyExpected.corporation_social_insurance_employee) &&
  familyCorporation.burdens.socialInsuranceEmployer.value ===
    BigInt(familyExpected.corporation_social_insurance_employer) &&
  familyCorporation.burdens.corporateTaxes.value === BigInt(familyExpected.corporate_taxes),
'家族ケースの法人化側が④家族ゴールデンの全主要項目と一致する');
assert(familyCorporation.personalDisposableCash.value ===
    BigInt(familyYakuinGolden.expected.personal_net_cash) &&
  familyCorporation.corporateRetainedCash.value ===
    BigInt(familyYakuinGolden.expected.corporate_retained_cash) &&
  familyResult.breakdown.data.combinedReferenceDifference.value ===
    BigInt(familyExpected.combined_reference_difference),
'法人化側が④ゴールデンと一致し、差額が＋708,520円になる');
assert(12000000n - (1327600n + 882300n + 455000n + 1340120n) ===
    familySole.personalDisposableCash.value,
'個人 12,000,000−(1,327,600＋882,300＋455,000＋1,340,120)＝7,994,980');
assert(12000000n - (71200n + 181000n + 894000n + 1234700n) - 915600n ===
    familyCorporation.personalDisposableCash.value + familyCorporation.corporateRetainedCash.value,
'法人化 12,000,000−(71,200＋181,000＋894,000＋1,234,700)−915,600＝8,703,500');
assert(familyResult.assumptions.some(text =>
  text.includes('配偶者・扶養親族ご自身の国民健康保険料') &&
  text.includes('第3号被保険者')),
'配偶者・扶養親族ご自身の世帯社会保険料と法人化後の差を未反映と明示する');

const allBandsInput = goldenInput();
allBandsInput.individual.dependents = [
  { id: 'age-17', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
  { id: 'age-20', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
  { id: 'age-40', ageAtYearEnd: 40, relation: 'child', totalIncome: yen(0) },
  { id: 'age-71-cohabiting', ageAtYearEnd: 71, relation: 'parent', livesTogether: true,
    totalIncome: yen(0) },
  { id: 'age-71-separate', ageAtYearEnd: 71, relation: 'parent', livesTogether: false,
    totalIncome: yen(0) },
];
const allBands = service.simulate(allBandsInput, context(), snapshotInfo);
const allBandsDeduction = allBands.breakdown.data.soleProprietor.orderedIncomeDeductions
  .find(row => row.code === 'dependents').amount.value;
assert(allBandsDeduction === 2450000n,
'扶養5区分各1人は38＋63＋38＋58＋48＝245万円（19〜22歳は代表年齢20歳）');

console.log('\n=== GC-HJ-DISABILITY-KYOSAI ===');
const deductionInput = goldenInput();
deductionInput.individual.self = { ageAtYearEnd: 45, disability: 'general' };
deductionInput.individual.spouse = { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) };
deductionInput.individual.dependents = [
  { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
  { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
];
deductionInput.individual.deductions = { smallEnterpriseMutualAid: yen(840000) };
deductionInput.corporate.deductions = { smallEnterpriseMutualAid: yen(276000) };
const deductionResult = service.simulate(deductionInput, context(), snapshotInfo);
const deductionSole = deductionResult.breakdown.data.soleProprietor;
const deductionCorporation = deductionResult.breakdown.data.corporation;
const deductionExpected = deductionGolden.expected;
const deductionSoleRows = new Map(deductionSole.orderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
const deductionCorporationRows = new Map(deductionCorporation.orderedIncomeDeductions
  .map(row => [row.code, row.amount.value]));
assert(deductionSole.totalIncomeDeductions.value ===
    BigInt(deductionExpected.sole_income_tax_total_deductions) &&
  deductionSoleRows.get('socialInsurance') === 1340120n &&
  deductionSoleRows.get('spouse') === 0n && deductionSoleRows.get('dependents') === 1010000n &&
  deductionSoleRows.get('disability') === 270000n &&
  deductionSoleRows.get('smallEnterpriseMutualAid') === 840000n &&
  deductionSoleRows.get('basic') === 580000n,
'個人側の所得控除計4,040,120円と6内訳が指定期待値に一致する');
assert(deductionCorporation.totalIncomeDeductions.value ===
    BigInt(deductionExpected.corporation_income_tax_total_deductions) &&
  deductionCorporationRows.get('disability') === 270000n &&
  deductionCorporationRows.get('smallEnterpriseMutualAid') === 276000n,
'法人化側には本人一般障害27万円と法人化後掛金27.6万円だけを反映する');
assert(deductionSoleRows.get('smallEnterpriseMutualAid') !==
    deductionCorporationRows.get('smallEnterpriseMutualAid') &&
  deductionCorporationRows.get('smallEnterpriseMutualAid') !== 840000n,
'個人側84万円を法人化後へ流用しない対称性破りを検知する');
assert(deductionSole.incomeTaxTaxableIncome.value ===
    BigInt(deductionExpected.sole_income_tax_taxable_income) &&
  deductionSole.burdens.incomeTax.value === BigInt(deductionExpected.sole_income_tax) &&
  deductionSole.residentTaxAdjustmentDeduction.value ===
    BigInt(deductionExpected.sole_resident_tax_adjustment_deduction) &&
  deductionSole.burdens.residentTax.value === BigInt(deductionExpected.sole_resident_tax) &&
  deductionSole.burdens.soleProprietorEnterpriseTax.value ===
    BigInt(deductionExpected.sole_proprietor_enterprise_tax) &&
  deductionSole.personalDisposableCash.value ===
    BigInt(deductionExpected.sole_personal_disposable_cash),
'障害・掛金ケースの個人側全指定項目がゴールデン期待値と一致する');
assert(deductionCorporation.incomeTaxTaxableIncome.value ===
    BigInt(deductionExpected.corporation_income_tax_taxable_income) &&
  deductionCorporation.burdens.incomeTax.value ===
    BigInt(deductionExpected.corporation_income_tax) &&
  deductionCorporation.residentTaxAdjustmentDeduction.value ===
    BigInt(deductionExpected.corporation_resident_tax_adjustment_deduction) &&
  deductionCorporation.burdens.residentTax.value ===
    BigInt(deductionExpected.corporation_resident_tax) &&
  deductionCorporation.burdens.socialInsuranceEmployee.value ===
    BigInt(deductionExpected.corporation_social_insurance_employee) &&
  deductionCorporation.burdens.socialInsuranceEmployer.value ===
    BigInt(deductionExpected.corporation_social_insurance_employer) &&
  deductionCorporation.burdens.corporateTaxes.value === BigInt(deductionExpected.corporate_taxes) &&
  deductionCorporation.personalDisposableCash.value ===
    BigInt(deductionExpected.corporation_personal_disposable_cash) &&
  deductionCorporation.corporateRetainedCash.value ===
    BigInt(deductionExpected.corporate_retained_cash),
'障害・掛金ケースの法人化側全指定項目がゴールデン期待値と一致する');
assert(deductionCorporation.personalDisposableCash.value ===
    BigInt(deductionYakuinGolden.expected.personal_net_cash) &&
  deductionCorporation.corporateRetainedCash.value ===
    BigInt(deductionYakuinGolden.expected.corporate_retained_cash) &&
  deductionResult.breakdown.data.combinedReferenceDifference.value ===
    BigInt(deductionExpected.combined_reference_difference),
'法人化側が④障害・掛金ゴールデンと全項目一致し、差額が＋419,820円になる');
assert(12000000n - (1067000n + 772300n + 455000n + 1340120n) ===
    deductionSole.personalDisposableCash.value,
'個人 12,000,000−(1,067,000＋772,300＋455,000＋1,340,120)＝8,365,580');
assert(12000000n - (43300n + 127000n + 894000n + 1234700n) - 915600n ===
    deductionCorporation.personalDisposableCash.value +
      deductionCorporation.corporateRetainedCash.value,
'法人化 12,000,000−(43,300＋127,000＋894,000＋1,234,700)−915,600＝8,785,400');
assert(deductionResult.assumptions.some(text =>
  text.includes('掛金そのものは支出として差し引いていません')),
'①でも掛金そのものを支出控除しない前提を表示する');

console.log('\n=== GC-HJ-DEDUCTIONS2 ===');
const deduction2Input = goldenInput();
deduction2Input.individual.self = { ageAtYearEnd: 45, disability: 'general' };
deduction2Input.individual.spouse = { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) };
deduction2Input.individual.dependents = [
  { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
  { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
];
deduction2Input.individual.deductions = {
  smallEnterpriseMutualAid: yen(840000),
  lifeInsurance: [
    { generation: 'new', category: 'life', annualPremium: yen(120000) },
    { generation: 'new', category: 'nursing_medical', annualPremium: yen(80000) },
  ],
  earthquakeInsurance: [{ category: 'earthquake', annualPremium: yen(50000) }],
  donations: [{ kind: 'furusato', amount: yen(20000) }],
};
deduction2Input.individual.taxCredits = { housingLoan: yen(100000) };
deduction2Input.corporate.deductions = { smallEnterpriseMutualAid: yen(276000) };
const deduction2Result = service.simulate(deduction2Input, context(), snapshotInfo);
const deduction2Sole = deduction2Result.breakdown.data.soleProprietor;
const deduction2Corporation = deduction2Result.breakdown.data.corporation;
const deduction2Expected = deduction2Golden.expected;
for (const [actualField, expectedField] of Object.entries({
  totalIncomeDeductions: 'sole_income_tax_total_deductions',
  incomeTaxTaxableIncome: 'sole_income_tax_taxable_income',
  incomeTaxCalculatedAmount: 'sole_income_tax_calculated_amount',
  residentTaxTotalIncomeDeductions: 'sole_resident_tax_total_deductions',
  residentTaxTaxableIncome: 'sole_resident_tax_taxable_income',
  residentTaxAdjustmentDeduction: 'sole_resident_tax_adjustment_deduction',
  residentTaxPrefecturalIncomeLevy: 'sole_resident_tax_prefectural_income_levy',
  residentTaxMunicipalIncomeLevy: 'sole_resident_tax_municipal_income_levy',
  personalDisposableCash: 'sole_personal_disposable_cash',
})) {
  assert(deduction2Sole[actualField].value === BigInt(deduction2Expected[expectedField]),
    `控除第2弾の個人側${actualField}が指定期待値${deduction2Expected[expectedField]}円と一致する`);
}
assert(deduction2Sole.burdens.incomeTax.value === BigInt(deduction2Expected.sole_income_tax) &&
  deduction2Sole.burdens.residentTax.value === BigInt(deduction2Expected.sole_resident_tax),
'控除第2弾の個人側所得税930,100円・住民税750,300円を固定する');
assert(deduction2Sole.residentTaxDonationCredit.basis.value === 7328000n &&
  deduction2Sole.residentTaxDonationCredit.specialRate.num === 67n &&
  deduction2Sole.residentTaxDonationCredit.specialRate.den === 100n &&
  deduction2Sole.residentTaxDonationCredit.special.value === 12060n,
'個人側の特例控除は条文表67%帯で12,060円にする');
assert(deduction2Sole.appliedHousingLoanCredit.value === 100000n &&
  deduction2Sole.residentTaxHousingLoanCredit.amount.value === 0n,
'個人側は住宅ローン控除10万円を所得税で引き切り住民税へ回さない');
assert(deduction2Corporation.burdens.incomeTax.value === 0n &&
  deduction2Corporation.burdens.residentTax.value === 66600n &&
  deduction2Corporation.residentTaxHousingLoanCredit.amount.value === 35100n &&
  deduction2Corporation.personalDisposableCash.value +
    deduction2Corporation.corporateRetainedCash.value === 8889100n,
'法人化側は④控除第2弾と一致し、住民税ローン控除35,100円・手残り8,889,100円になる');
assert(deduction2Result.breakdown.data.combinedReferenceDifference.value === 364620n,
'①の差額を＋364,620円で固定する');
assert(12000000n - (930100n + 750300n + 455000n + 1340120n) ===
  deduction2Sole.personalDisposableCash.value,
'個人 12,000,000−(930,100＋750,300＋455,000＋1,340,120)＝8,524,480');
assert(12000000n - (0n + 66600n + 894000n + 1234700n) - 915600n ===
  deduction2Corporation.personalDisposableCash.value +
    deduction2Corporation.corporateRetainedCash.value,
'法人化 12,000,000−(0＋66,600＋894,000＋1,234,700)−915,600＝8,889,100');
assert(deduction2Result.assumptions.some(text => text.includes('ワンストップ特例は使用していません')),
'①のassumptionsに確定申告前提・ワンストップ不使用を明示する');

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
  ['HJ_OTHER_INCOMES_UNSUPPORTED', 'その他所得入力', input => {
    input.individual.otherIncomes = [{
      category: 'business', taxationMethod: 'aggregate', amount: yen(1),
    }];
  }],
  ['HJ_DEDUCTIONS_UNSUPPORTED', '医療費控除入力', input => {
    input.individual.deductions = { medical: { mode: 'medical', paidAmount: yen(1) } };
  }],
  ['HJ_TAX_CREDITS_UNSUPPORTED', 'その他税額控除入力', input => {
    input.individual.taxCredits = { other: [{ code: 'other', amount: yen(1) }] };
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
