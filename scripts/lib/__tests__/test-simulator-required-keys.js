'use strict';

/** 依存表の任意値を空にしても、最小入力の主要計算が止まらず結果も変わらないことを確かめる。 */
const fs = require('fs');
const path = require('path');
const snapshotPath = require.resolve('../../../src/tax-engine/masters/snapshot.js');
const real = require(snapshotPath);
const originalExports = require.cache[snapshotPath].exports;
const originalCache = new Map(Object.entries(require.cache));
const originalChildren = new Map([...originalCache].map(([id, entry]) => [id, entry.children.slice()]));
const dependencies = JSON.parse(fs.readFileSync(path.join(__dirname,
  '../../../data/tax-simulator/masters/simulator-dependencies.json'), 'utf8')).simulators;
const snapshotInfo = real.getSnapshotInfo();
const yen = value => ({ unit: 'JPY', value: BigInt(value) });
let omittedKey = null;
let accessed = new Set();
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
function wrap(method) {
  return (key, ...args) => {
    accessed.add(key);
    return key === omittedKey ? (method === 'findBracket' ? null : []) : real[method](key, ...args);
  };
}
const period = { from: '2025-01-01', to: '2025-12-31' };
const corporatePeriod = { from: '2025-04-01', to: '2026-03-31' };
const segment = (dates, value) => ({ period: dates, value: yen(value) });
const plan = () => ({ monthlySegments: [{ period: corporatePeriod,
  value: { monthlyAmount: yen(500000) } }] });
function incomeContext() {
  return {
    asOfDate: '2026-08-27', calculatedAt: '2026-08-27T12:00:00+09:00',
    incomeTaxYear: 2025, residentTaxFiscalYear: 2025, fiscalPeriod: corporatePeriod,
    socialInsuranceMonths: ['2025-04'],
    jurisdiction: { country: 'JP', codeSystemVersion: '2025-01', asOfForCodes: '2025-04-01',
      prefectureCode: '13', municipalityCode: '13113', isDesignatedCity: false },
    masterSnapshotId: snapshotInfo.snapshotId, masterSnapshotHash: snapshotInfo.snapshotHash,
  };
}
function hojinnariInput() {
  // goldenInput と同じ形。白色申告と年金の実額で、任意の控除・標準年金を引かない。
  return {
    precision: 'detailed', comparisonBasis: 'steady_state',
    individual: {
      business: {
        revenue: [segment(period, 20000000)], expenses: [segment(period, 8000000)],
        periodFacts: {}, expensesExcludeSocialInsuranceAndMutualAid: 'yes',
        businessTaxCategory: 'type3_standard',
      },
      blueReturn: { status: 'white' }, self: { ageAtYearEnd: 39, disability: 'none' },
      residentTaxBasis: 'steady_state', nationalHealthInsurance: { kind: 'estimate_accepted' },
      nationalPension: { kind: 'actual', annualAmount: yen(210120) },
    },
    corporate: {
      locationSameAsResidence: 'yes', capital: yen(3000000), employeeCount: 0,
      officerCompensation: plan(), healthInsurer: { kind: 'kyokai_kenpo', prefectureCode: '13' },
      revenue: [segment(corporatePeriod, 20000000)], expenses: [segment(corporatePeriod, 8000000)],
    },
    consumptionTax: { include: false }, specialistChecks: {},
  };
}
function yakuinInput() {
  return {
    mode: 'C', precision: 'detailed', officerResidenceSameAsCompany: 'yes',
    capital: yen(3000000), employeeCount: 0,
    healthInsurer: { kind: 'kyokai_kenpo', prefectureCode: '13' },
    officer: { ageAtYearEnd: 39 }, specialistChecks: {},
    profitBeforeOfficerCompensation: yen(12000000), plan: plan(),
  };
}
function shohizeiInput() {
  const taxIncl = value => ({ basis: 'inclusive', amount: yen(value) });
  return {
    precision: 'detailed', taxpayerType: 'individual',
    eligibility: {
      invoiceRegistration: { registered: 'yes', registeredOn: '2023-10-01',
        becameTaxableByRegistration: 'yes' },
      basePeriod: { exists: true, taxableSales: yen(9000000), lengthInMonths: 12 },
      specifiedPeriod: { taxableSales: yen(9000000), salaryPayments: yen(3000000) },
      filings: [{ kind: 'simplified_election', filed: 'yes', effectiveFromPeriodStart: period.from }],
    },
    sales: [{ period, value: { kind: 'detailed',
      taxable: [{ band: 'standard_10', amount: taxIncl(11000000) }] } }],
    purchases: [{ period, value: { kind: 'detailed',
      taxableWithInvoice: [{ band: 'standard_10', amount: taxIncl(4400000) }],
      taxableWithoutInvoice: [] } }],
    simplified: { categorySelectedByUser: true, primaryCategory: 'type5' }, specialistChecks: {},
  };
}
function hojinnariConsumptionInput(twentyPercentEligible) {
  const input = hojinnariInput();
  const individual = shohizeiInput();
  const corporate = shohizeiInput();
  corporate.taxpayerType = 'corporation';
  corporate.eligibility.basePeriod = { exists: false };
  corporate.eligibility.specifiedPeriod = {};
  corporate.eligibility.filings = [
    { kind: 'taxable_person_election', filed: 'no' },
    { kind: 'simplified_election', filed: 'no' },
  ];
  for (const rows of [corporate.sales, corporate.purchases]) {
    for (const row of rows) row.period = corporatePeriod;
  }
  // consumptionTaxIncludedInput と同じ期間入力。2割特例不可の組では登録起因の課税ではない。
  if (!twentyPercentEligible) {
    individual.eligibility.invoiceRegistration.becameTaxableByRegistration = 'no';
    corporate.eligibility.invoiceRegistration.becameTaxableByRegistration = 'no';
  }
  input.consumptionTax = {
    include: true, individualPeriodInput: individual, corporatePeriodInput: corporate,
  };
  return input;
}
function consumptionTaxExcluded(result) {
  return (result.excludedItems || []).some(item =>
    item.code === 'HJ_CONSUMPTION_TAX_METHOD_UNDETERMINED_BY_SHOHIZEI');
}
function sozokuInput() {
  return {
    level: 1, precision: 'simple', decedent: { residencyStatus: 'domestic_resident' },
    heirs: [{ id: 'spouse', relation: 'spouse', isAlive: true, residencyStatus: 'domestic_resident' }],
    assets: { cash: yen(1000) }, debts: [], specialistChecks: {},
  };
}
function standaloneContext(values) {
  return { asOfDate: '2026-08-28', calculatedAt: '2026-08-28T12:00:00+09:00',
    jurisdiction: { country: 'JP' }, masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash, ...values };
}
function completed(result) {
  // 国保の概算などによる partial は完了した計算。blocked や結果なしは失敗。
  return ['complete', 'partial'].includes(result.resultStatus) && !!result.breakdown?.data;
}

function calculationAmounts(result) {
  return JSON.stringify({ summary: result.summary, data: result.breakdown?.data },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}

try {
  // exports は凍結済みなので新しい物にし、必ずサービスを読む前に差し替える。
  require.cache[snapshotPath].exports = Object.assign({}, real, {
    find: wrap('find'), peek: wrap('peek'), findBracket: wrap('findBracket'),
  });
  const cases = [
    ['hojinnari', hojinnariInput, incomeContext],
    ['hojinnari', () => hojinnariConsumptionInput(true), incomeContext, '消費税あり・2割特例可'],
    ['hojinnari', () => hojinnariConsumptionInput(false), incomeContext, '消費税あり・2割特例不可'],
    ['yakuin_hoshu', yakuinInput, incomeContext],
    ['shohizei', shohizeiInput, () => standaloneContext({ consumptionTaxPeriod: period })],
    ['sozoku', sozokuInput, () => standaloneContext({ inheritanceOpenDate: '2025-06-01' })],
  ];
  for (const [name, makeInput, makeContext, consumptionCase] of cases) {
    console.log(`\n=== ${name}${consumptionCase ? `（${consumptionCase}）` : ''}: 必須・任意と実計算の照合 ===`);
    const service = require(`../../../src/simulators/${name === 'yakuin_hoshu' ? 'yakuin-hoshu' : name}/index.js`);
    const run = () => service.simulate(makeInput(), makeContext(), snapshotInfo);
    omittedKey = null;
    accessed = new Set();
    let baseline;
    try { baseline = run(); }
    catch (error) { assert(false, `${name}: 基準計算: ${error.message.split('\n')[0]}`); continue; }
    assert(completed(baseline), `${name}: 差し替えなしで計算が完了する (${baseline.resultStatus})`);
    const used = new Set(accessed);
    if (consumptionCase) {
      const data = baseline.breakdown?.data;
      assert(!consumptionTaxExcluded(baseline) &&
        data?.soleProprietor?.burdens?.consumptionTax?.value === (consumptionCase.endsWith('不可') ? 500000n : 200000n) &&
        data?.corporation?.burdens?.consumptionTax?.value === (consumptionCase.endsWith('不可') ? 600000n : 200000n),
        `${name}（${consumptionCase}）: 基準計算で両側の消費税が確定し、2割特例の可否を区別する`);
    }
    const required = new Set(dependencies[name].required.flatMap(group => group.value_keys));
    const optional = new Set(dependencies[name].optional.flatMap(group => group.value_keys));
    const missing = [...used].filter(key => !required.has(key) && !optional.has(key));
    assert(missing.length === 0, `${name}: 未登録の参照は0件 (${missing.join(', ')})`);
    if (name === 'hojinnari') {
      assert(![...used].some(key => key === 'blue_return_special_deduction' || key.startsWith('national_pension_')),
        '①: 白色申告・年金実額で除外一覧なしに検証できる');
    }
    const targets = [...used].filter(key => optional.has(key)).sort();
    console.log(`  参照${used.size}件、任意の欠損試験${targets.length}件`);
    for (const key of targets) {
      omittedKey = key;
      accessed = new Set();
      try {
        const result = run();
        assert(accessed.has(key) && completed(result),
          `${name}: ${key} が空でも例外・blockedなし (${result.resultStatus})`);
        assert(calculationAmounts(result) === calculationAmounts(baseline) ||
          (!!consumptionCase && consumptionTaxExcluded(result)),
          `${name}: ${key} が空でも基準計算と一致するか、消費税ありの組では所定のコードで消費税を除外する`);
      } catch (error) {
        assert(false, `${name}: ${key}: ${error.message.split('\n')[0]}`);
      }
    }
  }
} finally {
  require.cache[snapshotPath].exports = originalExports;
  for (const id of Object.keys(require.cache)) if (!originalCache.has(id)) delete require.cache[id];
  for (const [id, entry] of originalCache) { entry.children = originalChildren.get(id); require.cache[id] = entry; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;