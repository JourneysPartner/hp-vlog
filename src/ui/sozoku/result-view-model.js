'use strict';

const { resolveQuestion } = require('./question-catalog.js');

const WARNING_ORDER = Object.freeze({ critical: 0, attention: 1, info: 2 });
const FILING_NEED_TEXT = Object.freeze({
  not_required: '正味遺産額が基礎控除以下のため、原則として相続税申告は不要の試算です',
  possibly_required: '基礎控除を超えるため、相続税申告が必要となる可能性があります',
  required_for_special_rule: '特例の利用により税額は下がりますが、特例の適用には申告が必要です（税額0円でも申告不要にはなりません）',
});
const RANGE_CATALOG = Object.freeze([
  Object.freeze({ code: 'filing_need', label: '申告要否' }),
  Object.freeze({ code: 'taxable_price', label: '課税価格' }),
  Object.freeze({ code: 'basic_deduction', label: '基礎控除' }),
  Object.freeze({ code: 'inheritance_tax_total', label: '相続税の総額' }),
  Object.freeze({ code: 'spouse_relief', label: '配偶者の税額軽減' }),
  Object.freeze({ code: 'small_residential_land', label: '小規模宅地等' }),
  Object.freeze({ code: 'gift_addback', label: '生前贈与加算・贈与税額控除' }),
]);

function moneyValue(value) {
  if (!value || value.unit !== 'JPY' || typeof value.value !== 'bigint') {
    throw new TypeError('MoneyはJPYのbigintで指定してください');
  }
  return value.value;
}

function money(value) { return Object.freeze({ unit: 'JPY', value }); }

function formatYen(value) {
  const amount = moneyValue(value);
  const sign = amount < 0n ? '▲' : '';
  const digits = (amount < 0n ? -amount : amount).toString(10);
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;
}

function amount(value) {
  return Object.freeze({ value, exactYen: moneyValue(value), display: formatYen(value) });
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

function common(result) {
  return {
    resultStatus: result.resultStatus,
    periodLabel: result.periodLabel,
    warnings: sortedWarnings(result.warnings),
    assumptions: Object.freeze([...(result.assumptions || [])]),
    excludedItems: Object.freeze([...(result.excludedItems || [])]),
    grounds: grounds(result),
  };
}

function heirLabel(heirId, index, labels) {
  if (labels && labels[heirId]) return labels[heirId];
  if (heirId === 'spouse') return '配偶者';
  let match = /^child-(\d+)$/.exec(heirId);
  if (match) return `お子さま${match[1]}`;
  match = /^adopted-child-(\d+)$/.exec(heirId);
  if (match) return `養子${match[1]}`;
  match = /^parent-(\d+)$/.exec(heirId);
  if (match) return `ご両親・祖父母${match[1]}`;
  match = /^sibling-(\d+)$/.exec(heirId);
  if (match) return `兄弟姉妹${match[1]}`;
  return `相続人${index + 1}`;
}

function hasWarning(result, code) {
  return (result.warnings || []).some(item => item.code === code);
}

function giftAddbackViewModel(value) {
  const details = value || { gifts: [], perRecipient: [], totalAddback: money(0n),
    totalExtraDeduction: money(0n), periodStartDate: null, threeYearStartDate: null };
  const recipientIds = details.perRecipient.map(row => row.recipientHeirId);
  const labelFor = heirId => heirLabel(heirId, Math.max(0, recipientIds.indexOf(heirId)));
  return Object.freeze({
    periodStartDate: details.periodStartDate,
    threeYearStartDate: details.threeYearStartDate,
    totalAddback: amount(details.totalAddback),
    totalExtraDeduction: amount(details.totalExtraDeduction),
    gifts: Object.freeze(details.gifts.map(gift => Object.freeze({
      giftedOn: gift.giftedOn,
      recipientHeirId: gift.recipientHeirId,
      recipientLabel: labelFor(gift.recipientHeirId),
      amount: amount(gift.amount),
      giftTaxPaid: amount(gift.giftTaxPaid),
      addbackAmount: amount(gift.addbackAmount),
      extraDeductionApplied: amount(gift.extraDeductionApplied),
      isInAddbackPeriod: gift.isInAddbackPeriod,
      periodClassification: gift.periodClassification,
      statusText: gift.isInAddbackPeriod
        ? gift.periodClassification === 'extended_period' && gift.extraDeductionApplied.value > 0n
          ? `延長期間の100万円控除を${formatYen(gift.extraDeductionApplied)}適用し、${formatYen(gift.addbackAmount)}を加算`
          : `加算対象（加算額 ${formatYen(gift.addbackAmount)}）`
        : '期間外のため加算されません',
    }))),
    perRecipient: Object.freeze(details.perRecipient.map(recipient => Object.freeze({
      recipientHeirId: recipient.recipientHeirId,
      recipientLabel: labelFor(recipient.recipientHeirId),
      addbackAmount: amount(recipient.addbackAmount),
      extraDeductionApplied: amount(recipient.extraDeductionApplied),
      giftTaxCreditApplied: amount(recipient.giftTaxCreditApplied),
    }))),
  });
}

function calculationRange(level, result) {
  const excluded = level === 1
    ? RANGE_CATALOG.filter(item => ['inheritance_tax_total', 'spouse_relief'].includes(item.code))
    : [];
  return Object.freeze({
    calculatedCount: RANGE_CATALOG.length - excluded.length,
    targetCount: RANGE_CATALOG.length,
    excluded: Object.freeze(excluded),
    catalog: RANGE_CATALOG,
    screeningEstimateUsed: hasWarning(result, 'SOZOKU_SCREENING_REAL_ESTATE_ESTIMATE'),
  });
}

function secondaryInheritanceViewModel(value) {
  if (!value) return undefined;
  const maximum = value.scenarios.reduce((largest, row) =>
    row.combinedTaxTotal.value > largest ? row.combinedTaxTotal.value : largest, 0n);
  const scenarios = Object.freeze(value.scenarios.map(row => Object.freeze({
    spouseAcquisitionPercent: row.spouseAcquisitionPercent,
    spouseAcquisitionLabel: `${row.spouseAcquisitionPercent}%`,
    primaryPayableTotal: amount(row.primaryPayableTotal),
    spousePrimaryPayable: amount(row.spousePrimaryPayable),
    secondaryEstate: amount(row.secondaryEstate),
    secondaryTaxTotal: amount(row.secondaryTaxTotal),
    combinedTaxTotal: amount(row.combinedTaxTotal),
    isMinimum: row.spouseAcquisitionPercent === value.minimumSpouseAcquisitionPercent,
    barPercent: maximum === 0n ? 0 : Number(row.combinedTaxTotal.value * 10000n / maximum) / 100,
  })));
  let premiseNote = '現在の財産額がそのまま二次相続時まで続くと仮定した概算です。';
  if (value.yearsUntilSecondary !== undefined) {
    const living = value.annualLivingCost || money(0n);
    const change = value.annualAssetChangeRate || { num: 0n, den: 100n };
    const rateText = change.num > 0n ? `+${change.num}%` : change.num < 0n
      ? `▲${-change.num}%` : '0%';
    premiseNote = `現在の財産額から、二次相続まで${value.yearsUntilSecondary}年、年間生活費${formatYen(living)}、年間増減率${rateText}を逐年反映した概算です。`;
  }
  return Object.freeze({
    scenarios,
    minimumSpouseAcquisitionPercent: value.minimumSpouseAcquisitionPercent,
    minimumCombinedTaxTotal: amount(value.minimumCombinedTaxTotal),
    keyResult: Object.freeze({
      label: '合計税額が最小になる配偶者の取得割合',
      qualifier: 'この試算では',
      value: `${value.minimumSpouseAcquisitionPercent}%`,
      amount: value.minimumCombinedTaxTotal,
      exactYen: value.minimumCombinedTaxTotal.value,
      display: formatYen(value.minimumCombinedTaxTotal),
    }),
    notes: Object.freeze([
      premiseNote,
      '各割合は遺産分割の可能性・遺留分・換価性を保証しません。',
      ...(value.successiveInheritanceCreditPossible
        ? ['相次相続控除により二次相続税が下がる可能性があります。'] : []),
    ]),
    successiveInheritanceCreditPossible: value.successiveInheritanceCreditPossible,
  });
}

function buildBlockedViewModel(result) {
  return Object.freeze({
    ...common(result),
    heading: `試算停止（${result.periodLabel}・blocked）`,
    alerts: Object.freeze((result.warnings || []).map(resolveQuestion)),
  });
}

function buildSozokuResultViewModel(result, options = {}) {
  if (!result || result.simulatorType !== 'sozoku') {
    throw new TypeError('sozokuのSimulationResultを指定してください');
  }
  if (result.resultStatus === 'blocked') return buildBlockedViewModel(result);
  if (!result.breakdown || result.breakdown.kind !== 'sozoku') {
    throw new TypeError('結果表示に必要なsozoku内訳がありません');
  }
  const data = result.breakdown.data;
  const filingText = FILING_NEED_TEXT[data.filingNeed];
  if (!filingText) throw new RangeError('filingNeedが値集合外です');
  const level = data.secondaryInheritance ? 3 :
    data.allocations && data.allocations.length > 0 ? 2 : 1;
  const base = {
    ...common(result),
    level,
    heading: `試算結果（LEVEL ${level}・${result.periodLabel}・${result.resultStatus}）`,
    filingNeed: data.filingNeed,
    conclusion: Object.freeze({ code: data.filingNeed, text: filingText }),
    keyResult: Object.freeze({
      label: '申告要否',
      qualifier: 'この試算では',
      value: filingText,
    }),
    taxablePriceTotal: amount(data.taxablePriceTotal),
    basicDeduction: amount(data.basicDeduction),
    screeningEstimateUsed: hasWarning(result, 'SOZOKU_SCREENING_REAL_ESTATE_ESTIMATE'),
    screeningWarning: hasWarning(result, 'SOZOKU_SCREENING_REAL_ESTATE_ESTIMATE')
      ? '不動産に路線価×面積等の概算を含みます。実際の相続税評価額とは異なる場合があります。'
      : undefined,
    calculationRange: calculationRange(level, result),
    defaultDivisionAssumption: (result.assumptions || []).find(text =>
      text.includes('法定相続分で仮計算')),
    smallResidentialLandPossibility: Boolean(options.smallResidentialLandPossibility) ||
      hasWarning(result, 'SOZOKU_SMALL_RESIDENTIAL_LAND_SPECIALIST_REVIEW'),
    giftAddback: giftAddbackViewModel(data.giftAddback),
  };
  if (level === 1) return Object.freeze(base);

  const allocationRows = Object.freeze(data.allocations.map((row, index) => Object.freeze({
    heirId: row.heirId,
    label: heirLabel(row.heirId, index, options.heirLabels),
    acquiredAmount: amount(row.acquiredAmount),
    taxBeforeCredits: amount(row.allocatedTaxBeforeCredits),
    credits: amount(row.credits),
    creditDetails: Object.freeze({
      giftTax: amount(row.creditDetails.giftTax),
      spouseRelief: amount(row.creditDetails.spouseRelief),
      minor: amount(row.creditDetails.minor),
      disability: amount(row.creditDetails.disability),
    }),
    finalTax: amount(row.finalTax),
  })));
  const spouse = allocationRows.find(row => row.heirId === 'spouse');
  const payable = result.summary && result.summary.amount
    ? result.summary.amount
    : money(allocationRows.reduce((total, row) => total + row.finalTax.exactYen, 0n));
  const smallLandApplied = hasWarning(result, 'SOZOKU_SMALL_RESIDENTIAL_LAND_SIMPLIFIED_APPLIED');
  const giftDetails = data.giftAddback || { totalAddback: money(0n) };
  const derivedReduction = moneyValue(data.grossEstate) + moneyValue(giftDetails.totalAddback) -
    moneyValue(data.nonTaxableAmounts) - moneyValue(data.deductibleDebtsAndFuneralCosts) -
    moneyValue(data.taxablePriceTotal);
  return Object.freeze({
    ...base,
    totalInheritanceTax: amount(data.totalInheritanceTax),
    totalPayableTax: amount(payable),
    keyResult: Object.freeze({
      label: '納付税額の合計',
      qualifier: 'この試算では',
      amount: payable,
      exactYen: moneyValue(payable),
      display: formatYen(payable),
    }),
    allocations: allocationRows,
    spouseRelief: spouse ? Object.freeze({
      before: spouse.taxBeforeCredits,
      after: spouse.finalTax,
      reduction: spouse.creditDetails.spouseRelief,
      applied: spouse.creditDetails.spouseRelief.exactYen > 0n,
    }) : undefined,
    secondaryAvailable: Boolean(spouse),
    smallResidentialLand: Object.freeze({
      applied: smallLandApplied,
      reduction: amount(money(smallLandApplied && derivedReduction > 0n ? derivedReduction : 0n)),
      appliedArea: options.smallResidentialLandArea,
      possibility: base.smallResidentialLandPossibility,
    }),
    undividedWarning: hasWarning(result, 'IHT_SPOUSE_RELIEF_NOT_APPLIED_UNDIVIDED') ||
      hasWarning(result, 'SOZOKU_SPOUSE_RELIEF_NOT_APPLIED_LATE_DIVISION')
      ? '未分割または申告期限後の分割のため、配偶者の税額軽減なしで計算しています。'
      : undefined,
    secondaryInheritance: secondaryInheritanceViewModel(data.secondaryInheritance),
  });
}

module.exports = Object.freeze({
  FILING_NEED_TEXT,
  RANGE_CATALOG,
  formatYen,
  buildSozokuResultViewModel,
  buildResultViewModel: buildSozokuResultViewModel,
});
