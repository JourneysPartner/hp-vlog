'use strict';

/** 法人課税5点セット（中小法人・第1版）の単体・受け入れテスト。 */

const fs = require('fs');
const path = require('path');
const engine = require('../../../src/tax-engine/corporate/corporate-tax.js');

const yen = value => ({ unit: 'JPY', value: BigInt(value) });
const amount = value => value && value.value;
const PERIOD = { from: '2025-04-01', to: '2026-03-31' };
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function baseInput(profit, overrides = {}) {
  return {
    entityType: 'domestic_ordinary',
    comparisonBasis: 'steady_state',
    capital: yen(3000000),
    employeeCount: 5,
    accountingProfitBeforeTax: yen(profit),
    fiscalPeriod: PERIOD,
    enterpriseTaxReducedRateEligible: true,
    taxAdjustments: { items: [], treatUnansweredAsZero: true },
    ...overrides,
  };
}

console.log('\n=== 法人税エンジン: GC-CORP-FULL-600 ===');
{
  const document = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases',
    'official-examples.json'
  ), 'utf8'));
  const golden = document.cases.find(item => item.case_id === 'GC-CORP-FULL-600');
  const result = engine.calculate(baseInput(golden.inputs.accounting_profit_before_tax));
  assert(result.status === 'complete', '対応プロフィールはcomplete');
  assert(amount(result.corporateTax.amount) === BigInt(golden.expected.corporate_tax),
    '法人税900,000円');
  assert(amount(result.localCorporateTax.amount) === BigInt(golden.expected.local_corporate_tax),
    '地方法人税92,700円');
  assert(amount(result.corporateInhabitantTax.prefecturalIncomeLevy) ===
    BigInt(golden.expected.inhabitant_tax_prefectural_income_levy) &&
    amount(result.corporateInhabitantTax.municipalIncomeLevy) ===
    BigInt(golden.expected.inhabitant_tax_municipal_income_levy),
  '法人税割は県9,000円・市54,000円を別々に計算');
  assert(amount(result.corporateInhabitantTax.perCapitaLevyTotal) ===
    BigInt(golden.expected.inhabitant_tax_per_capita_total), '均等割70,000円');
  assert(amount(result.enterpriseTax.amount) === BigInt(golden.expected.enterprise_tax),
    '事業税246,000円');
  assert(amount(result.specialEnterpriseTax.amount) ===
    BigInt(golden.expected.special_enterprise_tax),
  '特別法人事業税91,020円を100円未満切捨てして91,000円');
  assert(amount(result.specialEnterpriseTax.beforeFinalRounding) === 91020n,
    '特別法人事業税の丸め前91,020円も段階別に保持する');
  assert(amount(result.totalTax) === BigInt(golden.expected.total_tax), '合計1,462,700円');
}

console.log('\n=== 法人税: 800万円境界と10億円超 ===');
{
  const result = engine.calculate(baseInput(10000000));
  assert(amount(result.corporateTax.amount) === 1664000n,
    '所得1,000万円は800万円×15%＋200万円×23.2%＝1,664,000円');
  assert(result.corporateTax.brackets.length === 2 &&
    amount(result.corporateTax.brackets[0].taxablePortion) === 8000000n &&
    amount(result.corporateTax.brackets[1].taxablePortion) === 2000000n,
  '800万円の上下を区分計算する');
}
{
  const result = engine.calculate(baseInput(1000001000));
  assert(result.corporateTax.brackets[0].recordId === 'CORP-R7-SME-LOW-HIGHEARNER' &&
    result.corporateTax.brackets[0].rate.num * 100n ===
      17n * result.corporateTax.brackets[0].rate.den,
  '所得10億円超の事業年度は800万円以下部分の17%レコードを選ぶ');
}

console.log('\n=== 法人事業税: 3段階と特別法人事業税の丸め ===');
{
  const result = engine.calculate(baseInput(10000000));
  assert(result.enterpriseTax.brackets.length === 3 &&
    result.enterpriseTax.brackets.map(row => amount(row.taxablePortion)).join(',') ===
      '4000000,4000000,2000000', '400万・800万の両境界を通る3区分');
  assert(amount(result.enterpriseTax.amount) === 492000n,
    '400万×3.5%＋400万×5.3%＋200万×7.0%＝492,000円');
}

console.log('\n=== 赤字でも均等割 ===');
{
  const result = engine.calculate(baseInput(0));
  assert(amount(result.corporateTax.amount) === 0n &&
    amount(result.localCorporateTax.amount) === 0n &&
    amount(result.corporateInhabitantTax.incomeLevyTotal) === 0n,
  '所得連動の法人税グループは0円');
  assert(amount(result.corporateInhabitantTax.perCapitaLevyTotal) === 70000n &&
    amount(result.totalTax) === 70000n, '課税所得0でも均等割70,000円を返す');
}

console.log('\n=== 移行年度の均等割月割 ===');
{
  const result = engine.calculate(baseInput(2542200, {
    comparisonBasis: 'transition_year',
    capital: yen(1000000),
    employeeCount: 0,
    fiscalPeriod: { from: '2025-07-01', to: '2025-12-31' },
  }));
  assert(result.status === 'complete' && result.comparisonBasis === 'transition_year',
    '6か月の初事業年度をtransition_yearとして計算する');
  assert(amount(result.corporateInhabitantTax.prefecturalPerCapitaLevy) === 10000n &&
    amount(result.corporateInhabitantTax.municipalPerCapitaLevy) === 25000n &&
    amount(result.corporateInhabitantTax.perCapitaLevyTotal) === 35000n,
  '都2万円・区5万円を別々に6/12月割して合計35,000円');
}
{
  const result = engine.calculate(baseInput(2542200, {
    comparisonBasis: 'transition_year',
    capital: yen(1000000),
    employeeCount: 0,
    fiscalPeriod: { from: '2025-07-15', to: '2025-12-31' },
  }));
  assert(result.corporateInhabitantTax.perCapitaProrationMonths === 5 &&
    amount(result.corporateInhabitantTax.prefecturalPerCapitaLevy) === 8300n &&
    amount(result.corporateInhabitantTax.municipalPerCapitaLevy) === 20800n &&
    amount(result.corporateInhabitantTax.perCapitaLevyTotal) === 29100n,
  '7月15日設立は端数月を切り捨て、5か月・都8,300円＋区20,800円＝29,100円');
}

console.log('\n=== 繰越欠損金: 国税と地方税を混同しない ===');
{
  const result = engine.calculate(baseInput(6000000, {
    lossCarryforward: {
      hasBlueReturnForLossYears: 'yes',
      losses: [{ fiscalYearStartedOn: '2024-04-01', amount: yen(7000000) }],
    },
  }));
  assert(result.status === 'partial' && amount(result.lossCarryforward.deductionAmount) === 6000000n &&
    amount(result.taxableIncome) === 0n, '青色の前期欠損700万円から所得600万円を控除');
  assert(amount(result.corporateTax.amount) === 0n && amount(result.localCorporateTax.amount) === 0n &&
    amount(result.corporateInhabitantTax.incomeLevyTotal) === 0n,
  '法人税・地方法人税・法人税割は0円');
  assert(amount(result.corporateInhabitantTax.perCapitaLevyTotal) === 70000n,
    '欠損控除後も均等割70,000円');
  assert(result.enterpriseTax === null && result.specialEnterpriseTax === null &&
    result.excludedItems.map(item => item.code).join(',') ===
      'enterprise_tax_income,special_enterprise_tax',
  '事業税系は独自の欠損金規定が未登録なので除外してpartial');
}
{
  const result = engine.calculate(baseInput(6000000, {
    lossCarryforward: {
      hasBlueReturnForLossYears: 'yes',
      losses: [
        { fiscalYearStartedOn: '2023-04-01', amount: yen(4000000) },
        { fiscalYearStartedOn: '2022-04-01', amount: yen(4000000) },
      ],
    },
  }));
  const allocations = result.lossCarryforward.allocations;
  assert(allocations[0].fiscalYearStartedOn === '2022-04-01' &&
    amount(allocations[0].usedAmount) === 4000000n &&
    allocations[1].fiscalYearStartedOn === '2023-04-01' &&
    amount(allocations[1].usedAmount) === 2000000n &&
    amount(allocations[1].remainingAmount) === 2000000n,
  '入力順に依存せず古い事業年度から充当する');
}
{
  const result = engine.calculate(baseInput(6000000, {
    lossCarryforward: {
      hasBlueReturnForLossYears: 'no',
      losses: [{ fiscalYearStartedOn: '2024-04-01', amount: yen(7000000) }],
    },
  }));
  assert(amount(result.lossCarryforward.deductionAmount) === 0n &&
    amount(result.taxableIncome) === 6000000n &&
    result.warnings.some(warning => warning.code === 'CT_LOSS_BLUE_RETURN_REQUIREMENT_NOT_MET'),
  '青色要件が無ければ欠損金を控除しない');
}

console.log('\n=== 交際費の損金不算入 ===');
{
  const result = engine.calculate(baseInput(6000000, {
    entertainmentExpenses: {
      totalAmount: yen(9000000),
      perPersonDiningExclusionAmount: yen(600000),
    },
  }));
  const entertainment = result.adjustments.entertainment;
  assert(amount(entertainment.entertainmentAmount) === 8400000n &&
    entertainment.selectedMethod === 'fixed_deduction' &&
    amount(entertainment.nonDeductibleAmount) === 400000n,
  '900万円−1万円以下飲食60万円−定額控除800万円＝不算入40万円');
  assert(amount(result.incomeAmount) === 6400000n, '不算入40万円を所得へ加算する');
}

console.log('\n=== 対象外プロフィールは blocked ===');
{
  const cases = [
    [baseInput(6000000, { capital: yen(100000001) }), 'CT_CAPITAL_OVER_SME_LIMIT', '資本金1億円超'],
    [baseInput(6000000, { fiscalPeriod: { from: '2025-04-01', to: '2026-02-28' } }),
      'CT_SHORT_FISCAL_PERIOD_UNSUPPORTED', '事業年度11か月'],
    [baseInput(6000000, { officePrefectureCount: 3 }),
      'CT_ENTERPRISE_REDUCED_RATE_INELIGIBLE', '3都道府県で軽減税率不適用'],
    [baseInput(6000000, { applyLossCarryback: true }),
      'CT_LOSS_CARRYBACK_UNSUPPORTED', '繰戻し還付'],
  ];
  for (const [input, code, label] of cases) {
    const result = engine.calculate(input);
    assert(result.status === 'blocked' && result.blockedReasons.some(reason => reason.code === code),
      `${label}は理由コード付きblocked`);
  }
}

console.log('\n=== 課税標準・各税額の端数処理 ===');
{
  const result = engine.calculate(baseInput(6001234));
  assert(amount(result.taxableIncomeBeforeRounding) === 6001234n &&
    amount(result.taxableIncome) === 6001000n, '課税所得6,001,234円を6,001,000円へ切捨て');
  assert(amount(result.corporateTax.beforeFinalRounding) === 900150n &&
    amount(result.corporateTax.amount) === 900100n, '法人税900,150円を900,100円へ切捨て');
  assert(amount(result.localCorporateTax.baseCorporateTax) === 900000n &&
    amount(result.localCorporateTax.amount) === 92700n,
  '地方法人税の基準法人税額で1,000円未満を切捨て');
  assert(amount(result.corporateInhabitantTax.corporateTaxLevyBase) === 900000n &&
    amount(result.corporateInhabitantTax.prefecturalIncomeLevy) === 9000n &&
    amount(result.corporateInhabitantTax.municipalIncomeLevy) === 54000n,
  '法人税割は県・市それぞれの税額で100円未満を切捨て');
  assert(amount(result.enterpriseTax.amount) === 246000n &&
    amount(result.specialEnterpriseTax.amount) === 91000n,
  '事業税と特別法人事業税も各段階の端数規則を適用');
}

console.log('\n=== 未対応の申告調整 ===');
{
  const blocked = engine.calculate(baseInput(6000000, {
    taxAdjustments: {
      items: [{ code: 'donation', applies: 'yes' }],
      treatUnansweredAsZero: true,
    },
  }));
  const reflected = engine.calculate(baseInput(6000000, {
    taxAdjustments: {
      items: [{ code: 'donation', applies: 'yes', amount: yen(100000), direction: 'add' }],
      treatUnansweredAsZero: true,
    },
  }));
  assert(blocked.status === 'blocked' &&
    blocked.blockedReasons.some(reason => reason.code === 'CT_ADJUSTMENT_AMOUNT_REQUIRED'),
  '該当あり・金額不明の調整はblocked');
  assert(amount(reflected.incomeAmount) === 6100000n,
    '未対応項目でも金額と加減算区分があれば所得へ反映');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
