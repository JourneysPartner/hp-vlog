'use strict';

const { resolveQuestion } = require('./question-catalog.js');

const WARNING_ORDER = Object.freeze({ critical: 0, attention: 1, info: 2 });
const RANGE_CATALOG = Object.freeze([
  Object.freeze({ code: 'income_tax', label: '所得税' }),
  Object.freeze({ code: 'reconstruction_income_tax', label: '復興特別所得税' }),
  Object.freeze({ code: 'resident_tax', label: '住民税' }),
  Object.freeze({ code: 'sole_proprietor_enterprise_tax', label: '個人事業税' }),
  Object.freeze({ code: 'national_health_insurance', label: '国民健康保険料' }),
  Object.freeze({ code: 'national_pension', label: '国民年金' }),
  Object.freeze({ code: 'corporate_tax', label: '法人税' }),
  Object.freeze({ code: 'local_corporate_tax', label: '地方法人税' }),
  Object.freeze({ code: 'corporate_resident_tax', label: '法人住民税' }),
  Object.freeze({ code: 'corporate_enterprise_tax', label: '法人事業税等' }),
  Object.freeze({ code: 'social_insurance', label: '社会保険' }),
  Object.freeze({ code: 'consumption_tax', label: '消費税' }),
]);

function moneyValue(money) {
  if (!money || money.unit !== 'JPY' || typeof money.value !== 'bigint') {
    throw new TypeError('MoneyはJPYのbigintで指定してください');
  }
  return money.value;
}

function money(value) {
  return Object.freeze({ unit: 'JPY', value });
}

function formatYen(moneyObject) {
  const value = moneyValue(moneyObject);
  const sign = value < 0n ? '▲' : '';
  const digits = (value < 0n ? -value : value).toString(10);
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;
}

function formatSignedYen(moneyObject) {
  const value = moneyValue(moneyObject);
  const prefix = value > 0n ? '＋' : value < 0n ? '▲' : '';
  const absolute = money(value < 0n ? -value : value);
  return `${prefix}${formatYen(absolute)}`;
}

function formatApproxManYen(valueOrMoney) {
  const value = typeof valueOrMoney === 'bigint' ? valueOrMoney : moneyValue(valueOrMoney);
  const absolute = value < 0n ? -value : value;
  const rounded = (absolute + 5000n) / 10000n;
  return `約${rounded.toLocaleString('ja-JP')}万円`;
}

function amountCell(value) {
  if (value === undefined) return Object.freeze({ kind: 'omitted', display: '―' });
  return Object.freeze({ kind: 'amount', amount: value, exactYen: moneyValue(value), display: formatYen(value) });
}

function sumMoney(values) {
  return money(values.reduce((total, item) => total + moneyValue(item), 0n));
}

function burdenTotal(scenario, excludeEmployer) {
  const entries = Object.entries(scenario.burdens || {}).filter(([key, value]) =>
    value !== undefined && (!excludeEmployer || key !== 'socialInsuranceEmployer'));
  return sumMoney(entries.map(([, value]) => value));
}

function conclusion(summaryAmount) {
  const exactAmount = moneyValue(summaryAmount);
  const approximate = formatApproxManYen(exactAmount);
  if (exactAmount > 0n) {
    return Object.freeze({
      direction: 'corporation', exactAmount, approximate,
      text: `本シミュレーションの入力条件では、法人化した場合のほうが年間 ${approximate} 手残りが増える試算となりました。`,
    });
  }
  if (exactAmount < 0n) {
    return Object.freeze({
      direction: 'sole_proprietor', exactAmount, approximate,
      text: `本シミュレーションの入力条件では、個人事業のままのほうが年間 ${approximate} 手残りが増える試算となりました。`,
    });
  }
  return Object.freeze({
    direction: 'nearly_equal', exactAmount, approximate,
    text: '本シミュレーションの入力条件では、法人化後と個人事業の手残りはほぼ同等となる試算でした。',
  });
}

function comparisonRows(data) {
  const sole = data.soleProprietor;
  const corporation = data.corporation;
  // 帰属の異なる2つのサービス出力は、税計算をせず表示用合計だけを作る。
  const corporationCombined = sumMoney([
    corporation.personalDisposableCash,
    corporation.corporateRetainedCash,
  ]);
  return Object.freeze([
    ['income_tax', '所得税', sole.burdens.incomeTax, corporation.burdens.incomeTax],
    ['resident_tax', '住民税', sole.burdens.residentTax, corporation.burdens.residentTax],
    ['sole_proprietor_enterprise_tax', '個人事業税', sole.burdens.soleProprietorEnterpriseTax, undefined],
    ['corporate_taxes', '法人税等', undefined, corporation.burdens.corporateTaxes],
    ['social_insurance_employee', '本人社会保険', sole.burdens.socialInsuranceEmployee, corporation.burdens.socialInsuranceEmployee],
    ['social_insurance_employer', '会社社会保険', undefined, corporation.burdens.socialInsuranceEmployer],
    ['personal_disposable_cash', '個人手取り', sole.personalDisposableCash, corporation.personalDisposableCash],
    ['corporate_retained_cash', '法人税引後利益', undefined, corporation.corporateRetainedCash],
    ['combined_cash', '法人＋個人手残り', sole.personalDisposableCash, corporationCombined],
  ].map(([code, label, soleValue, corporateValue]) => Object.freeze({
    code,
    label,
    soleProprietor: amountCell(soleValue),
    corporation: amountCell(corporateValue),
    isEmployerSocialInsuranceDetailOnly: code === 'social_insurance_employer',
    note: code === 'social_insurance_employer'
      ? '内訳表示のみ。法人税引後利益へ反映済みのため合計へ再加算しません。'
      : undefined,
  })));
}

function calculationRange(result) {
  const consumptionExcluded = (result.excludedItems || []).some(item =>
    item.code === 'HJ_CONSUMPTION_TAX_OUT_OF_COMPARISON');
  const isNhiEstimate = (result.assumptions || []).some(text =>
    text.includes('国民健康保険料を概算'));
  const isNhiActual = (result.assumptions || []).some(text =>
    text.includes('国民健康保険料は入力された年間実額'));
  const directInput = [];
  const defaults = [];
  const estimates = [];
  const excluded = [];
  for (const item of RANGE_CATALOG) {
    if (item.code === 'consumption_tax' && consumptionExcluded) excluded.push(item);
    else if (item.code === 'national_health_insurance' && isNhiEstimate) estimates.push(item);
    else if (item.code === 'national_health_insurance' && isNhiActual) directInput.push(item);
    else defaults.push(item);
  }
  return Object.freeze({
    calculatedCount: RANGE_CATALOG.length - excluded.length,
    targetCount: RANGE_CATALOG.length,
    directInput: Object.freeze(directInput),
    defaults: Object.freeze(defaults),
    estimates: Object.freeze(estimates),
    excluded: Object.freeze(excluded),
    catalog: RANGE_CATALOG,
  });
}

function sortedWarnings(warnings) {
  return Object.freeze([...(warnings || [])].sort((left, right) =>
    (WARNING_ORDER[left.level] ?? 99) - (WARNING_ORDER[right.level] ?? 99)));
}

function grounds(result) {
  const context = result.calculationContext || {};
  return Object.freeze({
    calculationVersion: result.calculationVersion,
    masterSnapshotId: context.masterSnapshotId,
    legalStatusAsOf: context.asOfDate,
    sources: Object.freeze([...(result.sources || [])]),
  });
}

function buildBlockedViewModel(result) {
  const alerts = Object.freeze((result.warnings || []).map(resolveQuestion));
  return Object.freeze({
    resultStatus: 'blocked',
    periodLabel: result.periodLabel,
    heading: `試算停止（${result.periodLabel}・blocked）`,
    alerts,
    assumptions: Object.freeze([...(result.assumptions || [])]),
    warnings: sortedWarnings(result.warnings),
    excludedItems: Object.freeze([...(result.excludedItems || [])]),
    grounds: grounds(result),
  });
}

function buildResultViewModel(result) {
  if (!result || result.simulatorType !== 'hojinnari') {
    throw new TypeError('hojinnariのSimulationResultを指定してください');
  }
  if (result.resultStatus === 'blocked') return buildBlockedViewModel(result);
  if (!result.breakdown || result.breakdown.kind !== 'hojinnari' || !result.summary.amount) {
    throw new TypeError('結果表示に必要なhojinnari内訳がありません');
  }
  const data = result.breakdown.data;
  const soleBurden = burdenTotal(data.soleProprietor, false);
  const corporationBurden = burdenTotal(data.corporation, true);
  const partial = result.resultStatus === 'partial';
  return Object.freeze({
    resultStatus: result.resultStatus,
    periodLabel: result.periodLabel,
    heading: `試算結果（${result.calculationContext.incomeTaxYear}年分・平年度比較・${result.resultStatus}）`,
    isPartial: partial,
    partialNotice: partial ? '概算の前提が含まれます' : undefined,
    conclusion: conclusion(result.summary.amount),
    comparisonRows: comparisonRows(data),
    pairedFigures: Object.freeze({
      solePersonalDisposableCash: data.soleProprietor.personalDisposableCash,
      corporationPersonalDisposableCash: data.corporation.personalDisposableCash,
      corporateRetainedCash: data.corporation.corporateRetainedCash,
      taxAndInsuranceBurden: Object.freeze({
        soleProprietor: soleBurden,
        corporation: corporationBurden,
        employerSocialInsuranceExcludedFromCorporationTotal: true,
      }),
    }),
    corporateRetainedWarning: '法人内部に残る資金は社長個人が自由に使える資金ではありません。',
    setupAndMaintenanceCostsNotice: data.corporation.setupAndMaintenanceCosts === undefined
      ? '法人設立・維持費用（登記・税理士報酬等）は含まれていません'
      : undefined,
    consumptionTaxBadge: '消費税：比較対象外',
    calculationRange: calculationRange(result),
    warnings: sortedWarnings(result.warnings),
    assumptions: Object.freeze([...(result.assumptions || [])]),
    excludedItems: Object.freeze([...(result.excludedItems || [])]),
    grounds: grounds(result),
  });
}

module.exports = Object.freeze({
  RANGE_CATALOG,
  formatYen,
  formatSignedYen,
  formatApproxManYen,
  buildResultViewModel,
});
