'use strict';

/** 消費税の最適方式比較シミュレーター第1版。 */

const { validateInput } = require('../core/validator.js');
const { buildSimulationResult } = require('../core/result-builder.js');
const consumptionTax = require('../../tax-engine/consumption/index.js');
const snapshot = require('../../tax-engine/masters/snapshot.js');
const { money, addMoney } = require('../../tax-engine/common/money.js');
const eligibility = require('./eligibility.js');

const ENGINE_METHOD = Object.freeze({
  general: 'general',
  simplified: 'simplified',
  twenty_percent_special: 'two_wari',
  thirty_percent_special: 'san_wari',
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

function exportExcludedItem(input) {
  const amounts = [];
  for (const segment of input.sales || []) {
    const value = segment.value || {};
    if (value.exportExempt && value.exportExempt.amount &&
        value.exportExempt.amount.value > 0n) {
      amounts.push(value.exportExempt.amount);
    }
  }
  if (amounts.length === 0) return null;
  const total = amounts.reduce((sum, amount) => addMoney(sum, amount),
    money({ unit: 'JPY', value: 0n }));
  return {
    code: 'SZ_EXPORT_REFUND_FUTURE_EXTENSION',
    label: '輸出免税売上・還付可能性',
    reason: '輸出免税を含む還付計算は将来拡張です。第1版では納付額へ0円として含めません。',
    amount: total,
    isAmountUnknown: false,
  };
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

function exemptCalculation(period, assessment) {
  return {
    resultStatus: 'complete',
    summary: { title: '納税義務なし（免税事業者）' },
    breakdown: {
      kind: 'shohizei',
      data: { period, methodResults: [] },
    },
    applicableMethods: [],
    assumptions: [
      ...(assessment.assumptions || []),
      'インボイス登録した場合の試算は、登録済みとして再入力してください。',
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
      });
      continue;
    }

    const result = consumptionTax.calculate(input, {
      method: ENGINE_METHOD[methodCode],
      taxablePeriod: period,
    });
    if (result.status !== 'complete') {
      const reasonCodes = engineReasons(result);
      methodResults.push({ methodCode, eligibility: 'blocked', reasonCodes });
      for (const blockedReason of result.blockedReasons || []) {
        warnings.push(warning(blockedReason.code || 'SZ_ENGINE_BLOCKED',
          `$.${methodCode}`, blockedReason.message || '税額計算を完了できませんでした。'));
      }
      continue;
    }

    methodResults.push({
      methodCode,
      eligibility: 'eligible',
      taxPayable: result.totalPayable,
      reasonCodes: [...methodEligibility.reasonCodes],
    });
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
    ? { title: `${recommended.methodCode}が最も納付額の少ない試算です`, amount: recommended.taxPayable }
    : { title: '消費税の比較を完了できませんでした' };
  const general = methodResults.find(row => row.methodCode === 'general' &&
    row.eligibility === 'eligible' && calculations.has('general'));
  if (recommended && general) {
    summary.comparison = money({
      unit: 'JPY', value: recommended.taxPayable.value - general.taxPayable.value,
    });
  }

  const exportItem = exportExcludedItem(input);
  const excludedItems = exportItem ? [exportItem] : [];
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
    ]),
    warnings,
    excludedItems,
  };
}

function calculate(input, context) {
  const period = taxablePeriodFrom(context);
  const exportItem = exportExcludedItem(input);
  const blockers = eligibility.globalBlockers(input, period);
  if (blockers.length > 0) {
    return blockedCalculation(blockers, exportItem ? [exportItem] : []);
  }

  const assessment = eligibility.evaluateEligibility(input, period);
  if (assessment.liability.status === 'blocked') {
    return blockedCalculation(assessment.liability.reasons,
      exportItem ? [exportItem] : []);
  }
  if (assessment.liability.status === 'exempt') {
    return exemptCalculation(period, assessment);
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
