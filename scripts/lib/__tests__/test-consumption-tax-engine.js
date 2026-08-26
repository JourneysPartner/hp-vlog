'use strict';

/** 消費税方式別計算エンジン（第1版）の単体・受け入れテスト。 */

const fs = require('fs');
const path = require('path');
const engine = require('../../../src/tax-engine/consumption/consumption-tax.js');
const { applyRounding } = require('../../../src/tax-engine/common/rounding.js');

const yen = value => ({ unit: 'JPY', value: BigInt(value) });
const taxIncl = (value, basis = 'inclusive') => ({ basis, amount: yen(value) });
const amount = value => value && value.value;
const PERIOD_2025 = { from: '2025-01-01', to: '2025-12-31' };
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function detailedInput({
  period = PERIOD_2025,
  sales = [{ band: 'standard_10', amount: taxIncl(11000000) }],
  withInvoice = [],
  withoutInvoice = [],
  purchasePeriod = period,
  simplified = { categorySelectedByUser: true, primaryCategory: 'type5' },
  salesExtras = {},
  inputExtras = {},
} = {}) {
  return {
    taxablePeriod: period,
    sales: [{
      period,
      value: { kind: 'detailed', taxable: sales, ...salesExtras },
    }],
    purchases: [{
      period: purchasePeriod,
      value: {
        kind: 'detailed',
        taxableWithInvoice: withInvoice,
        taxableWithoutInvoice: withoutInvoice,
      },
    }],
    simplified,
    specialistChecks: {},
    ...inputExtras,
  };
}

console.log('\n=== ゴールデンケース: 一般課税・簡易課税 ===');
{
  const document = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases',
    'official-examples.json'
  ), 'utf8'));
  const byId = new Map(document.cases.map(item => [item.case_id, item]));
  const simplified = byId.get('GC-CT-SIMPLIFIED-T5');
  const simplifiedResult = engine.calculate(detailedInput(), {
    method: 'simplified', businessType: simplified.inputs.business_type,
  });
  assert(simplifiedResult.status === 'complete' &&
    amount(simplifiedResult.nationalTax) === BigInt(simplified.expected.national_tax) &&
    amount(simplifiedResult.localConsumptionTax.amount) === BigInt(simplified.expected.local_tax) &&
    amount(simplifiedResult.totalPayable) === BigInt(simplified.expected.total_tax),
  'GC-CT-SIMPLIFIED-T5: 国税390,000円＋地方110,000円＝500,000円');

  const general = byId.get('GC-CT-GENERAL-FULL');
  const generalResult = engine.calculate(detailedInput({
    withInvoice: [{ band: 'standard_10', amount: taxIncl(6600000) }],
  }), { method: 'general' });
  assert(generalResult.status === 'complete' &&
    amount(generalResult.nationalTax) === BigInt(general.expected.national_tax) &&
    amount(generalResult.localConsumptionTax.amount) === BigInt(general.expected.local_tax) &&
    amount(generalResult.totalPayable) === BigInt(general.expected.total_tax),
  'GC-CT-GENERAL-FULL: 国税312,000円＋地方88,000円＝400,000円');
}

console.log('\n=== 税率別計算と課税標準の1,000円未満切捨て ===');
{
  const result = engine.calculate(detailedInput({
    sales: [
      { band: 'standard_10', amount: taxIncl(11000000) },
      { band: 'reduced_8', amount: taxIncl(10800000) },
    ],
  }), { method: 'general' });
  const standard = result.salesTax.bands.find(row => row.band === 'standard_10');
  const reduced = result.salesTax.bands.find(row => row.band === 'reduced_8');
  assert(amount(standard.taxableBase) === 10000000n && amount(standard.nationalTax) === 780000n,
    '標準10%は課税標準1,000万円・国税78万円');
  assert(amount(reduced.taxableBase) === 10000000n && amount(reduced.nationalTax) === 624000n,
    '軽減8%は課税標準1,000万円・国税62.4万円として別計算');
}
{
  const result = engine.calculate(detailedInput({
    sales: [
      { band: 'standard_10', amount: taxIncl(1100999) },
      { band: 'reduced_8', amount: taxIncl(1080999) },
    ],
  }), { method: 'general' });
  assert(result.salesTax.bands.every(row => amount(row.taxableBase) === 1000000n),
    '端数入り税込額は標準・軽減それぞれで課税標準を1,000円未満切捨て');
}

console.log('\n=== インボイスなし仕入の経過措置は取引日で切替 ===');
{
  const period = { from: '2026-01-01', to: '2026-12-31' };
  const input = detailedInput({ period, withInvoice: [], withoutInvoice: [] });
  input.purchases = [
    {
      period: { from: '2026-01-15', to: '2026-01-15' },
      value: {
        kind: 'detailed', taxableWithInvoice: [],
        taxableWithoutInvoice: [{ band: 'standard_10', amount: taxIncl(1100000) }],
      },
    },
    {
      period: { from: '2026-10-15', to: '2026-10-15' },
      value: {
        kind: 'detailed', taxableWithInvoice: [],
        taxableWithoutInvoice: [{ band: 'standard_10', amount: taxIncl(1100000) }],
      },
    },
  ];
  const result = engine.calculate(input, { method: 'general' });
  const rates = result.purchaseTax.transitionDetails.map(row =>
    `${row.deductibleRate.num}/${row.deductibleRate.den}`);
  assert(rates.join(',') === '4/5,7/10', '2026年1月は80%、10月は70%を取引期間で選ぶ');
  assert(amount(result.purchaseTax.deductibleTaxTotal) === 117000n,
    '78,000円×80%＋78,000円×70%＝控除117,000円');
}
{
  const period = { from: '2026-01-01', to: '2026-12-31' };
  const blocked = engine.calculate(detailedInput({
    period,
    purchasePeriod: period,
    withoutInvoice: [{ band: 'standard_10', amount: taxIncl(1100000) }],
  }), { method: 'general' });
  assert(blocked.status === 'blocked' && blocked.blockedReasons.some(reason =>
    reason.code === 'CT_INVOICE_PERIOD_SPLIT_REQUIRED'),
  '80%→70%の変更日をまたぐ年額入力は按分せずblocked');
}

console.log('\n=== 2割特例の課税期間交差判定 ===');
{
  const earlyFiscalYear = engine.calculate(detailedInput({
    period: { from: '2023-04-01', to: '2024-03-31' },
  }), { method: 'two_wari' });
  const r8 = engine.calculate(detailedInput({
    period: { from: '2026-01-01', to: '2026-12-31' },
  }), { method: 'two_wari' });
  const r9 = engine.calculate(detailedInput({
    period: { from: '2027-01-01', to: '2027-12-31' },
  }), { method: 'two_wari' });
  assert(earlyFiscalYear.status === 'complete',
    '2023年4月開始の事業年度は10月1日を含むため対象（開始日だけの判定を防ぐ）');
  assert(r8.status === 'complete',
    '個人の令和8年分は9月30日を含むため対象（終了日だけの判定を防ぐ）');
  assert(r9.status === 'blocked' && r9.blockedReasons.some(reason =>
    reason.code === 'CT_TWO_WARI_PERIOD_OUT_OF_SCOPE'), '個人の令和9年分は対象外');
}

console.log('\n=== 同じ売上入力による3方式比較 ===');
{
  const comparison = engine.compareMethods(detailedInput(), {
    methods: ['general', 'simplified', 'two_wari'],
  });
  assert(comparison.results.every(result => result.salesTax.nationalTaxTotal.value === 780000n),
    '3方式すべてが同じ売上税額780,000円を使用');
  assert(comparison.minimum.method === 'two_wari' &&
    comparison.comparable.map(row => row.method).join(',') === 'two_wari,simplified,general',
  '一般780,000円・簡易500,000円・2割200,000円の順で2割が最小');
}

console.log('\n=== 地方消費税は切捨て後の国税を基礎にする ===');
{
  const result = engine.calculate(detailedInput({
    sales: [{ band: 'standard_10', amount: taxIncl(11000) }],
    withInvoice: [{ band: 'standard_10', amount: taxIncl(9542) }],
  }), { method: 'general' });
  const correctOneYenStage = applyRounding(
    result.localConsumptionTax.beforeRounding, 'R-TRUNC-1-CT-STAGE'
  );
  const wrongNumerator = result.nationalTaxBeforeFinalRounding.num *
    result.localConsumptionTax.rate.num;
  const wrongDenominator = result.nationalTaxBeforeFinalRounding.den *
    result.localConsumptionTax.rate.den;
  const wrongOneYenStage = wrongNumerator / wrongDenominator;
  assert(amount(result.nationalTax) === 100n &&
    amount(result.localConsumptionTax.baseNationalTax) === 100n,
  '差引国税104円を100円へ切捨てた後の100円が地方税の基礎');
  assert(wrongOneYenStage - amount(correctOneYenStage) === 1n,
    '順序を逆にした円単位中間値は29円となり、正しい28円より1円ずれる');
}

console.log('\n=== 第1版の対応外入力は理由コード付きblocked ===');
{
  const multiple = detailedInput({
    salesExtras: {
      simplifiedCategoryBreakdown: [
        { category: 'type2', band: 'standard_10', amount: taxIncl(8000000) },
        { category: 'type5', band: 'standard_10', amount: taxIncl(3000000) },
      ],
    },
  });
  const cases = [
    [engine.calculate(multiple, { method: 'simplified' }),
      'CT_SIMPLIFIED_MULTIPLE_CATEGORIES_UNSUPPORTED', '複数事業区分'],
    [engine.calculate(detailedInput({ inputExtras: { calculationType: 'stack_up' } }),
      { method: 'general' }), 'CT_STACK_UP_CALCULATION_UNSUPPORTED', '積上げ計算'],
    [engine.calculate(detailedInput({
      sales: [{ band: 'old_8', amount: taxIncl(10800000) }],
    }), { method: 'general' }), 'CT_OLD_TAX_RATE_UNSUPPORTED', '旧税率'],
    [engine.calculate(detailedInput({
      sales: [{ band: 'standard_10', amount: taxIncl(550001100) }],
    }), { method: 'general' }), 'CT_GENERAL_TAXABLE_SALES_OVER_500M', '課税売上5億円超'],
  ];
  for (const [result, code, label] of cases) {
    assert(result.status === 'blocked' && result.blockedReasons.some(reason => reason.code === code),
      `${label}は${code}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
