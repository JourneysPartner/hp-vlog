'use strict';

/** 消費税の最適方式比較シミュレーター第1版。 */

const { validateInput } = require('../core/validator.js');
const { buildSimulationResult } = require('../core/result-builder.js');
const consumptionTax = require('../../tax-engine/consumption/index.js');
const snapshot = require('../../tax-engine/masters/snapshot.js');
const { money } = require('../../tax-engine/common/money.js');
const eligibility = require('./eligibility.js');

const ENGINE_METHOD = Object.freeze({
  general: 'general',
  simplified: 'simplified',
  twenty_percent_special: 'two_wari',
  thirty_percent_special: 'san_wari',
});

const REFUND_EXPLANATIONS = Object.freeze({
  general: '実額の仕入税額控除のため、控除不足額は還付の対象になります。',
  simplified: 'みなし仕入率で売上税額から控除額を算出するため、還付は生じません。',
  twenty_percent_special: '売上税額の2割を納付する方式のため、還付は生じません。',
  thirty_percent_special: '売上税額の3割を納付する方式のため、還付は生じません。',
});

function assertSnapshotMatch(context, masters) {
  if (!context || !masters || context.masterSnapshotId !== masters.snapshotId ||
      context.masterSnapshotHash !== masters.snapshotHash) {
    throw new Error('マスタースナップショットと計算コンテキストが一致しません');
  }
}

function taxablePeriodFrom(context) {
  const period = context && context.consumptionTaxPeriod;
  if (!period || typeof period.from !== 'string' || typeof period.to !== 'string') {
    throw new TypeError('context.consumptionTaxPeriod が必要です');
  }
  return period;
}

function uniqueMessages(items) {
  return [...new Set((items || []).map(item =>
    typeof item === 'string' ? item : item.message
  ).filter(item => typeof item === 'string' && item.length > 0))];
}

function warning(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function warningsForMethods(methods) {
  const warnings = [];
  for (const [methodCode, row] of Object.entries(methods || {})) {
    if (row.status !== 'unknown' && row.status !== 'blocked') continue;
    for (let index = 0; index < row.reasonCodes.length; index++) {
      warnings.push(warning(row.reasonCodes[index], `$.eligibility.${methodCode}`,
        row.messages[index] || row.messages[0] || '方式の適用可否を確定できません。'));
    }
  }
  return warnings;
}

function hasExportExempt(input) {
  return (input.sales || []).some(segment => {
    const exportExempt = segment.value && segment.value.exportExempt;
    return exportExempt && exportExempt.amount && exportExempt.amount.value > 0n;
  });
}

function blockedCalculation(reasons, excludedItems = []) {
  return {
    resultStatus: 'blocked',
    summary: { title: '消費税の比較を完了できませんでした' },
    assumptions: [],
    warnings: reasons,
    excludedItems,
    applicableMethods: [],
  };
}

function exemptCalculation(input, period, assessment) {
  const exportExempt = hasExportExempt(input);
  return {
    resultStatus: 'complete',
    summary: { title: '納税義務なし（免税事業者）' },
    breakdown: {
      kind: 'shohizei',
      data: { period, methodResults: [], hasExportExempt: exportExempt },
    },
    applicableMethods: [],
    assumptions: [
      ...(assessment.assumptions || []),
      'インボイス登録した場合の試算は、登録済みとして再入力してください。',
      ...(exportExempt ? [
        '免税事業者は仕入税額の還付を受けられません。課税事業者を選択（インボイス登録等）した場合の還付可能性は、登録済みとして再計算してください。',
      ] : []),
    ],
    warnings: [],
    excludedItems: [],
  };
}

function engineReasons(result) {
  return (result.blockedReasons || []).map(item => item.code || 'SZ_ENGINE_BLOCKED');
}

function compareCalculation(input, period, assessment) {
  const methodResults = [];
  const calculations = new Map();
  const assumptions = [...(assessment.assumptions || [])];
  const warnings = warningsForMethods(assessment.methods);
  const initiallyEligible = eligibility.METHOD_CODES.filter(code =>
    assessment.methods[code].status === 'eligible');

  for (const methodCode of eligibility.METHOD_CODES) {
    const methodEligibility = assessment.methods[methodCode];
    if (methodEligibility.status !== 'eligible') {
      methodResults.push({
        methodCode,
        eligibility: methodEligibility.status,
        reasonCodes: [...methodEligibility.reasonCodes],
        refundExplanation: REFUND_EXPLANATIONS[methodCode],
      });
      continue;
    }

    const result = consumptionTax.calculate(input, {
      method: ENGINE_METHOD[methodCode],
      taxablePeriod: period,
    });
    if (result.status !== 'complete') {
      const reasonCodes = engineReasons(result);
      methodResults.push({
        methodCode,
        eligibility: 'blocked',
        reasonCodes,
        refundExplanation: REFUND_EXPLANATIONS[methodCode],
      });
      for (const blockedReason of result.blockedReasons || []) {
        warnings.push(warning(blockedReason.code || 'SZ_ENGINE_BLOCKED',
          `$.${methodCode}`, blockedReason.message || '税額計算を完了できませんでした。'));
      }
      continue;
    }

    const methodResult = {
      methodCode,
      eligibility: 'eligible',
      taxPayable: result.totalPayable,
      reasonCodes: [...methodEligibility.reasonCodes],
      refundExplanation: REFUND_EXPLANATIONS[methodCode],
    };
    if (result.refund) methodResult.refund = result.refund;
    methodResults.push(methodResult);
    calculations.set(methodCode, result);
    assumptions.push(...(result.assumptions || [])
      .filter(item => item.code !== 'CT_METHOD_ELIGIBILITY_PROVIDED_BY_CALLER'));
  }

  const comparable = methodResults.filter(row => row.eligibility === 'eligible' &&
    calculations.get(row.methodCode) && calculations.get(row.methodCode).status === 'complete')
    .sort((left, right) => left.taxPayable.value < right.taxPayable.value ? -1 :
      left.taxPayable.value > right.taxPayable.value ? 1 : 0);
  const recommended = comparable[0];
  const completeCount = calculations.size;
  const resultStatus = completeCount === 0 ? 'blocked' :
    completeCount === initiallyEligible.length ? 'complete' : 'partial';

  const data = { period, methodResults };
  if (recommended) data.recommendedMethodCode = recommended.methodCode;
  const summary = recommended
    ? recommended.taxPayable.value < 0n
      ? {
          title: '一般課税で概算還付が見込める試算です',
          amount: money({ unit: 'JPY', value: -recommended.taxPayable.value }),
          isRefund: true,
        }
      : { title: `${recommended.methodCode}が最も納付額の少ない試算です`, amount: recommended.taxPayable }
    : { title: '消費税の比較を完了できませんでした' };
  const general = methodResults.find(row => row.methodCode === 'general' &&
    row.eligibility === 'eligible' && calculations.has('general'));
  if (recommended && general) {
    summary.comparison = money({
      unit: 'JPY', value: recommended.taxPayable.value - general.taxPayable.value,
    });
  }

  return {
    resultStatus,
    summary,
    breakdown: { kind: 'shohizei', data },
    applicableMethods: methodResults.map(row => ({
      methodCode: row.methodCode,
      status: row.eligibility,
      reasonCodes: [...row.reasonCodes],
      sourceIds: [],
    })),
    assumptions: uniqueMessages([
      ...assumptions,
      '適用可否は §15 の判定によります（届出期限の個別判定は行っていません）。',
      '還付額は概算です。実際の還付申告では税務署の審査・還付加算金等があり、金額・時期が異なる場合があります。',
    ]),
    warnings,
    excludedItems: [],
  };
}

function calculate(input, context) {
  const period = taxablePeriodFrom(context);
  const blockers = eligibility.globalBlockers(input, period);
  if (blockers.length > 0) {
    return blockedCalculation(blockers);
  }

  const assessment = eligibility.evaluateEligibility(input, period);
  if (assessment.liability.status === 'blocked') {
    return blockedCalculation(assessment.liability.reasons);
  }
  if (assessment.liability.status === 'exempt') {
    return exemptCalculation(input, period, assessment);
  }
  return compareCalculation(input, period, assessment);
}

function validate(wireInput) {
  return validateInput('shohizei', wireInput);
}

/**
 * 別シミュレーターの追跡セッション内から呼ぶための内部入口。
 * 呼出元がマスターレコード追跡の開始・終了を一元管理する。
 */
function calculateWithoutRecordTracking(input, context, masters) {
  assertSnapshotMatch(context, masters);
  return calculate(input, context);
}

function simulate(input, context, masters) {
  assertSnapshotMatch(context, masters);
  snapshot.beginRecordTracking();
  let calculation;
  let usedMasterRecords;
  try {
    calculation = calculate(input, context);
    usedMasterRecords = snapshot.endRecordTracking();
  } catch (error) {
    snapshot.endRecordTracking();
    throw error;
  }

  return buildSimulationResult({
    simulatorType: 'shohizei',
    periodLabel: `${taxablePeriodFrom(context).from}～${taxablePeriodFrom(context).to}`,
    comparisonBasis: 'steady_state',
    resultStatus: calculation.resultStatus,
    summary: calculation.summary,
    breakdown: calculation.breakdown,
    assumptions: calculation.assumptions,
    warnings: calculation.warnings,
    applicableMethods: calculation.applicableMethods,
    masters,
    calculationContext: context,
    usedMasterRecords,
    precision: input.precision,
    excludedItems: calculation.excludedItems,
  });
}

module.exports = Object.freeze({ validate, simulate, calculateWithoutRecordTracking });
