'use strict';

/** 消費税シミュレーターサービス第1版の単体・受け入れテスト。 */

const fs = require('fs');
const path = require('path');
const service = require('../../../src/simulators/shohizei/index.js');
const eligibility = require('../../../src/simulators/shohizei/eligibility.js');
const masterSnapshot = require('../../../src/tax-engine/masters/snapshot.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const goldenDocument = JSON.parse(fs.readFileSync(path.join(
  REPO_ROOT, 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
), 'utf8'));
const golden = goldenDocument.cases.find(item => item.case_id === 'GC-SZ-COMPARE-R7');
const snapshotInfo = masterSnapshot.getSnapshotInfo();
const yen = value => ({ unit: 'JPY', value: BigInt(value) });
const taxIncl = value => ({ basis: 'inclusive', amount: yen(value) });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function throws(action) {
  try { action(); return false; } catch (_error) { return true; }
}

function context(period = { from: '2025-01-01', to: '2025-12-31' }, overrides = {}) {
  return {
    asOfDate: '2026-08-27',
    calculatedAt: '2026-08-27T12:00:00+09:00',
    consumptionTaxPeriod: period,
    jurisdiction: { country: 'JP' },
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
    ...overrides,
  };
}

function filing(kind, filed, effectiveFromPeriodStart) {
  const row = { kind, filed };
  if (effectiveFromPeriodStart) row.effectiveFromPeriodStart = effectiveFromPeriodStart;
  return row;
}

function detailedInput({
  period = { from: '2025-01-01', to: '2025-12-31' },
  taxpayerType = 'individual',
} = {}) {
  return {
    precision: 'detailed',
    taxpayerType,
    eligibility: {
      invoiceRegistration: {
        registered: 'yes',
        registeredOn: '2023-10-01',
        becameTaxableByRegistration: 'yes',
      },
      basePeriod: { exists: true, taxableSales: yen(9000000), lengthInMonths: 12 },
      specifiedPeriod: { taxableSales: yen(9000000), salaryPayments: yen(3000000) },
      filings: [filing('simplified_election', 'yes', period.from)],
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

function row(result, methodCode) {
  return result.breakdown && result.breakdown.data.methodResults
    .find(item => item.methodCode === methodCode);
}

function applicable(result, methodCode) {
  return result.applicableMethods.find(item => item.methodCode === methodCode);
}

function hasWarning(result, code) {
  return result.warnings.some(item => item.code === code);
}

function exemptInput() {
  const input = detailedInput();
  input.eligibility.invoiceRegistration = { registered: 'no' };
  input.eligibility.basePeriod.taxableSales = yen(8000000);
  input.eligibility.specifiedPeriod = {
    taxableSales: yen(8000000), salaryPayments: yen(2000000),
  };
  input.eligibility.filings = [
    filing('taxable_person_election', 'no'),
    filing('simplified_election', 'no'),
  ];
  return input;
}

function toWire(value) {
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toWire(child)]));
  }
  return value;
}

console.log('\n=== GC-SZ-COMPARE-R7 ===');
{
  const result = service.simulate(detailedInput(), context(), snapshotInfo);
  const expected = golden.expected;
  assert(result.resultStatus === 'complete' && result.simulatorType === 'shohizei' &&
    result.inputSchemaVersion === 'shohizei-1.0',
  'サービス共通契約とshohizei-1.0を返す');
  for (const code of ['general', 'simplified', 'twenty_percent_special']) {
    const actual = row(result, code);
    assert(actual.eligibility === expected[code].eligibility &&
      actual.taxPayable.value === BigInt(expected[code].total_tax),
    `${code} の判定と納付額がゴールデンに一致する`);
  }
  const three = row(result, 'thirty_percent_special');
  assert(three.eligibility === expected.thirty_percent_special.eligibility &&
    three.reasonCodes.includes('SZ_THREE_WARI_PERIOD_OUT_OF_SCOPE') &&
    !Object.hasOwn(three, 'taxPayable'),
  '3割特例は対象期間外で、税額を持たない');
  assert(result.breakdown.data.recommendedMethodCode === expected.recommended_method_code &&
    result.summary.comparison.value === BigInt(expected.difference_from_general),
  '2割特例を推奨し、一般課税との差額は▲400,000円');
  assert(result.assumptions.some(text => text.includes('§15')) &&
    !result.assumptions.some(text => text.includes('CT_METHOD_ELIGIBILITY_PROVIDED_BY_CALLER')),
  'サービス判定済みの前提へ差し替える');
}

console.log('\n=== 令和9年の2割・3割特例の対判定 ===');
{
  const period = { from: '2027-01-01', to: '2027-12-31' };
  const input = detailedInput({ period });
  const result = service.simulate(input, context(period), snapshotInfo);
  assert(row(result, 'twenty_percent_special').eligibility === 'ineligible' &&
    row(result, 'thirty_percent_special').eligibility === 'eligible' &&
    row(result, 'thirty_percent_special').taxPayable.value === 300000n,
  '2027年は2割特例が対象外、3割特例が300,000円でeligible');

  const corporation = detailedInput({ period, taxpayerType: 'corporation' });
  const assessment = eligibility.evaluateEligibility(corporation, period);
  assert(assessment.methods.thirty_percent_special.status === 'ineligible' &&
    assessment.methods.thirty_percent_special.messages.includes(
      '法人のため3割特例の対象外です。'),
  '法人の3割特例は§15の例文メッセージ付きineligible');
}

console.log('\n=== 納税義務の判定 ===');
{
  const result = service.simulate(exemptInput(), context(), snapshotInfo);
  assert(result.resultStatus === 'complete' &&
    result.summary.title === '納税義務なし（免税事業者）' &&
    result.breakdown.data.methodResults.length === 0 &&
    result.assumptions.some(text => text.includes('登録済みとして再入力')),
  '免税事業者はcomplete・方式行なし・再入力注記になる');

  const missingSalary = exemptInput();
  missingSalary.eligibility.specifiedPeriod.taxableSales = yen(10000001);
  delete missingSalary.eligibility.specifiedPeriod.salaryPayments;
  const blocked = service.simulate(missingSalary, context(), snapshotInfo);
  assert(blocked.resultStatus === 'blocked' &&
    hasWarning(blocked, 'SZ_SPECIFIED_PERIOD_SALARY_PAYMENTS_REQUIRED'),
  '特定期間売上が免税点超で給与未入力なら質問コード付きblocked');

  const corporation = exemptInput();
  corporation.taxpayerType = 'corporation';
  corporation.eligibility.basePeriod = {
    exists: true, taxableSales: yen(13500000), lengthInMonths: 18,
  };
  const annualized = service.simulate(corporation, context(), snapshotInfo);
  assert(annualized.resultStatus === 'complete' &&
    annualized.summary.title === '納税義務なし（免税事業者）' &&
    annualized.assumptions.some(text => text.includes('18か月') && text.includes('12か月換算')),
  '法人18か月・1,350万円は年換算900万円として免税側になる');
}

console.log('\n=== 方式ごとの適用可否 ===');
{
  const overCeiling = detailedInput();
  overCeiling.eligibility.basePeriod.taxableSales = yen(50000001);
  assert(row(service.simulate(overCeiling, context(), snapshotInfo), 'simplified').eligibility ===
    'ineligible', '基準期間5,000万円超は簡易課税ineligible');

  const noElection = detailedInput();
  noElection.eligibility.filings = [filing('simplified_election', 'no')];
  const noResult = service.simulate(noElection, context(), snapshotInfo);
  assert(row(noResult, 'simplified').eligibility === 'ineligible' &&
    row(noResult, 'simplified').reasonCodes.includes('SZ_SIMPLIFIED_ELECTION_NOT_FILED'),
  '簡易課税届出なしはineligible');

  const unknownElection = detailedInput();
  unknownElection.eligibility.filings = [filing('simplified_election', 'unknown')];
  assert(row(service.simulate(unknownElection, context(), snapshotInfo), 'simplified').eligibility ===
    'unknown', '簡易課税届出unknownはunknown');

  const becameNo = detailedInput();
  becameNo.eligibility.invoiceRegistration.becameTaxableByRegistration = 'no';
  const noSpecial = service.simulate(becameNo, context(), snapshotInfo);
  assert(row(noSpecial, 'twenty_percent_special').eligibility === 'ineligible',
    '登録により課税となったのでない場合は2割特例ineligible');

  const becameUnknown = detailedInput();
  becameUnknown.eligibility.invoiceRegistration.becameTaxableByRegistration = 'unknown';
  const unknownSpecial = service.simulate(becameUnknown, context(), snapshotInfo);
  assert(row(unknownSpecial, 'twenty_percent_special').eligibility === 'unknown',
    '登録による課税化がunknownなら2割特例unknown');

  const electionFiled = detailedInput();
  electionFiled.eligibility.filings.push(
    filing('taxable_person_election', 'yes', '2025-01-01')
  );
  const specialist = service.simulate(electionFiled, context(), snapshotInfo);
  assert(row(specialist, 'twenty_percent_special').eligibility === 'blocked' &&
    row(specialist, 'twenty_percent_special').reasonCodes.includes(
      'SZ_TAXABLE_PERSON_ELECTION_SPECIALIST_CHECK'),
  '課税事業者選択届出書提出者の2割特例は専門判定blocked');
}

console.log('\n=== 全体を止める第1版対象外条件 ===');
{
  const cases = [
    ['SZ_TAXABLE_PERIOD_SHORTENED_UNSUPPORTED', input => {
      input.eligibility.taxablePeriodShortened = 'unknown';
    }],
    ['SZ_NEW_COMPANY_EXEMPTION_UNSUPPORTED', input => {
      input.eligibility.newCompany = { isNewlyEstablished: 'yes' };
    }],
    ['SZ_SPECIAL_EVENT_UNSUPPORTED', input => {
      input.eligibility.events = { inheritance: 'unknown' };
    }],
    ['SZ_SPECIAL_EVENT_UNSUPPORTED', input => {
      input.eligibility.events = { merger: 'yes' };
    }],
    ['SZ_SPECIALIST_CHECK_UNSUPPORTED', input => {
      input.specialistChecks.reverseCharge = 'yes';
    }],
    ['SZ_SEGMENT_OUTSIDE_TAXABLE_PERIOD', input => {
      input.sales[0].period.from = '2024-12-31';
    }],
  ];
  for (const [code, mutate] of cases) {
    const input = detailedInput();
    mutate(input);
    const result = service.simulate(input, context(), snapshotInfo);
    assert(result.resultStatus === 'blocked' && hasWarning(result, code),
      `${code} で全体blocked`);
  }
}

console.log('\n=== エンジンの第1版制約を方式行へ引き継ぐ ===');
{
  const period = { from: '2027-01-01', to: '2027-12-31' };
  const exported = detailedInput({ period, taxpayerType: 'corporation' });
  exported.eligibility.filings = [filing('simplified_election', 'no')];
  exported.sales[0].value.exportExempt = taxIncl(1100000);
  const exportResult = service.simulate(exported, context(period), snapshotInfo);
  assert(exportResult.resultStatus === 'blocked' &&
    applicable(exportResult, 'general').status === 'blocked' &&
    applicable(exportResult, 'general').reasonCodes.includes('CT_EXPORT_REFUND_UNSUPPORTED') &&
    exportResult.excludedItems.some(item => item.code === 'SZ_EXPORT_REFUND_FUTURE_EXTENSION'),
  '輸出免税は一般課税行をblockedへ落とし、将来拡張のExcludedItemを返す');

  const simple = detailedInput();
  simple.purchases[0].value = {
    kind: 'simple', taxableTotal: taxIncl(4400000),
    hasPurchasesFromNonRegistered: 'no',
  };
  const simpleResult = service.simulate(simple, context(), snapshotInfo);
  assert(simpleResult.resultStatus === 'partial' &&
    row(simpleResult, 'general').eligibility === 'blocked' &&
    row(simpleResult, 'general').reasonCodes.includes('CT_GENERAL_DETAILED_PURCHASES_REQUIRED'),
  'simple仕入では一般課税がcompleteにならず、他方式だけでpartial');
}

console.log('\n=== 不変条件とvalidate ===');
{
  assert(throws(() => service.simulate(detailedInput(), context(undefined, {
    masterSnapshotHash: '0'.repeat(64),
  }), snapshotInfo)), 'スナップショット不一致は例外になる');

  const valid = service.validate(toWire(detailedInput()));
  assert(valid.ok && typeof valid.value.eligibility.basePeriod.taxableSales.value === 'bigint',
    '正しい最小WireをokとしてMoneyをbigintへ変換する');
  const invalidWire = toWire(detailedInput());
  invalidWire.eligibility.basePeriod.taxableSales.value = '1e3';
  const invalid = service.validate(invalidWire);
  assert(!invalid.ok && invalid.errors.some(error =>
    error.fieldPath === '$.eligibility.basePeriod.taxableSales.value'),
  'Moneyの指数表記1e3をok:falseで拒否する');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
