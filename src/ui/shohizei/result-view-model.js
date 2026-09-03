'use strict';

const { resolveQuestion } = require('./question-catalog.js');

const METHOD_LABELS = Object.freeze({
  general: '一般課税',
  simplified: '簡易課税',
  twenty_percent_special: '2割特例',
  thirty_percent_special: '3割特例',
});
const STATUS_SYMBOLS = Object.freeze({
  eligible: '○',
  ineligible: '×',
  unknown: '？',
  blocked: '—',
});
const WARNING_ORDER = Object.freeze({ critical: 0, attention: 1, info: 2 });

function moneyValue(value) {
  if (!value || value.unit !== 'JPY' || typeof value.value !== 'bigint') {
    throw new TypeError('MoneyはJPYのbigintで指定してください');
  }
  return value.value;
}

function formatYen(value) {
  const amount = moneyValue(value);
  const sign = amount < 0n ? '▲' : '';
  const absolute = (amount < 0n ? -amount : amount).toString(10);
  return `${sign}${absolute.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;
}

function formatTaxOutcome(value) {
  const amount = moneyValue(value);
  if (amount >= 0n) return formatYen(value);
  return `還付 ${formatYen({ unit: 'JPY', value: -amount })}`;
}

function warningForCode(result, code) {
  const warning = (result.warnings || []).find(item => item.code === code);
  return warning ? { code, message: warning.basis } : { code };
}

function reasonText(result, row) {
  const codes = row.reasonCodes || [];
  if (codes.length === 0) return row.eligibility === 'eligible' ? '利用可能です。' : '理由を確認できません。';
  return codes.map(code => resolveQuestion(warningForCode(result, code)).description).join(' ');
}

function eligibilityRows(result, methodResults) {
  return Object.freeze(methodResults.map(row => Object.freeze({
    methodCode: row.methodCode,
    methodName: METHOD_LABELS[row.methodCode] || row.methodCode,
    status: row.eligibility,
    symbol: STATUS_SYMBOLS[row.eligibility] || '—',
    reasonCodes: Object.freeze([...(row.reasonCodes || [])]),
    reason: reasonText(result, row),
    refundExplanation: row.refundExplanation,
  })));
}

function comparisonRows(methodResults) {
  return Object.freeze(methodResults
    .filter(row => row.eligibility === 'eligible' && row.taxPayable !== undefined)
    .map(row => Object.freeze({
      methodCode: row.methodCode,
      methodName: METHOD_LABELS[row.methodCode] || row.methodCode,
      amount: row.taxPayable,
      exactYen: moneyValue(row.taxPayable),
      isRefund: moneyValue(row.taxPayable) < 0n,
      display: formatTaxOutcome(row.taxPayable),
      refundExplanation: row.refundExplanation,
    }))
    .sort((left, right) => left.exactYen < right.exactYen ? -1 :
      left.exactYen > right.exactYen ? 1 : 0));
}

function generalDifference(result, methodResults, recommendedCode) {
  const general = methodResults.find(row => row.methodCode === 'general');
  const recommended = methodResults.find(row => row.methodCode === recommendedCode);
  if (!general || general.eligibility !== 'eligible' || general.taxPayable === undefined) {
    return Object.freeze({
      available: false,
      reason: general
        ? `一般課税の確定額を出せないため、差額を表示しません。${reasonText(result, general)}`
        : '一般課税の確定額がないため、差額を表示しません。',
    });
  }
  if (!recommended || recommended.eligibility !== 'eligible' || recommended.taxPayable === undefined) {
    return Object.freeze({ available: false, reason: '比較できる推奨方式がないため、差額を表示しません。' });
  }
  const difference = moneyValue(recommended.taxPayable) - moneyValue(general.taxPayable);
  return Object.freeze({
    available: true,
    amount: Object.freeze({ unit: 'JPY', value: difference }),
    display: formatYen({ unit: 'JPY', value: difference }),
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

function buildBlockedViewModel(result) {
  const methodResults = (result.applicableMethods || []).map(row => ({
    methodCode: row.methodCode,
    eligibility: row.status,
    reasonCodes: row.reasonCodes || [],
  }));
  const rows = eligibilityRows(result, methodResults);
  const general = methodResults.find(row => row.methodCode === 'general');
  return Object.freeze({
    ...common(result),
    heading: `試算停止（${result.periodLabel}・blocked）`,
    isExempt: false,
    eligibilityRows: rows,
    comparisonRows: Object.freeze([]),
    differenceFromGeneral: Object.freeze({
      available: false,
      reason: general
        ? `一般課税の確定額を出せないため、差額を表示しません。${reasonText(result, general)}`
        : '比較を完了できないため、一般課税との差額を表示しません。',
    }),
    simplifiedFilingGuidance: false,
    calculationRange: Object.freeze({
      calculatedCount: 0,
      targetCount: rows.length,
      excluded: rows,
    }),
    alerts: Object.freeze((result.warnings || []).map(item => resolveQuestion({
      code: item.code, message: item.basis,
    }))),
  });
}

function buildResultViewModel(result) {
  if (!result || result.simulatorType !== 'shohizei') {
    throw new TypeError('shohizeiのSimulationResultを指定してください');
  }
  if (result.resultStatus === 'blocked' && !result.breakdown) return buildBlockedViewModel(result);
  if (!result.breakdown || result.breakdown.kind !== 'shohizei') {
    throw new TypeError('結果表示に必要なshohizei内訳がありません');
  }
  const methodResults = result.breakdown.data.methodResults || [];
  if (result.resultStatus === 'complete' && methodResults.length === 0) {
    const hasExportExempt = result.breakdown.data.hasExportExempt === true;
    return Object.freeze({
      ...common(result),
      heading: `試算結果（${result.periodLabel}・complete）`,
      isExempt: true,
      exemptTitle: '納税義務なし（免税事業者）',
      exemptNotice: hasExportExempt
        ? '免税事業者は仕入税額の還付を受けられません。課税事業者を選択（インボイス登録等）した場合の還付可能性は、登録済みとして再計算してください'
        : '基準期間・特定期間の状況から、納税義務がない（免税事業者）試算です。インボイス登録した場合の比較は、登録済みとして再計算してください',
      keyResult: Object.freeze({
        label: '納税義務の判定',
        qualifier: 'この試算では',
        value: '納税義務なし（免税事業者）',
      }),
      eligibilityRows: Object.freeze([]),
      comparisonRows: Object.freeze([]),
      calculationRange: Object.freeze({ calculatedCount: 0, targetCount: 0, excluded: Object.freeze([]) }),
      simplifiedFilingGuidance: false,
    });
  }

  const rows = eligibilityRows(result, methodResults);
  const comparisons = comparisonRows(methodResults);
  const recommendedCode = result.breakdown.data.recommendedMethodCode;
  const recommendedName = METHOD_LABELS[recommendedCode];
  const recommended = comparisons.find(row => row.methodCode === recommendedCode);
  const simplified = methodResults.find(row => row.methodCode === 'simplified');
  const isRefund = Boolean(recommended && recommended.isRefund);
  const keyAmount = isRefund ? result.summary.amount : recommended && recommended.amount;
  return Object.freeze({
    ...common(result),
    heading: `試算結果（${result.periodLabel}・${result.resultStatus}）`,
    isExempt: false,
    isPartial: result.resultStatus === 'partial',
    eligibilityRows: rows,
    comparisonRows: comparisons,
    recommendedMethodCode: recommendedCode,
    keyResult: recommendedName && recommended ? Object.freeze({
      label: isRefund ? '概算還付額' : '最も納税額が少ない方式',
      qualifier: 'この試算では',
      value: isRefund ? undefined : recommendedName,
      amount: keyAmount,
      exactYen: moneyValue(keyAmount),
      display: formatYen(keyAmount),
    }) : undefined,
    conclusion: recommendedName
      ? isRefund
        ? result.summary.title
        : `今回の入力条件では、${recommendedName}が最も納税額の少ない試算となりました。`
      : undefined,
    differenceFromGeneral: generalDifference(result, methodResults, recommendedCode),
    simplifiedFilingGuidance: Boolean(simplified && simplified.eligibility === 'ineligible' &&
      (simplified.reasonCodes || []).includes('SZ_SIMPLIFIED_ELECTION_NOT_FILED')),
    simplifiedFilingNotice: '選択届出書を提出すると簡易課税を選べる可能性があります（提出期限は原則、適用したい課税期間の開始前日まで）',
    calculationRange: Object.freeze({
      calculatedCount: comparisons.length,
      targetCount: rows.length,
      excluded: Object.freeze(rows.filter(row => row.status !== 'eligible')),
    }),
  });
}

module.exports = Object.freeze({
  METHOD_LABELS,
  STATUS_SYMBOLS,
  formatYen,
  formatTaxOutcome,
  buildResultViewModel,
});
