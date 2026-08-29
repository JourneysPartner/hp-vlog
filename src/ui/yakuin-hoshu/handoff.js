'use strict';

const HANDOFF_SCHEMA_VERSION = 'yakuin-hoshu-to-hojinnari-1.0';
const PLAN_KIND = 'constant_monthly_12';
const STANDARD_REMUNERATION_DECISION_KIND = 'regular';
const HANDOFF_PATHS = Object.freeze({
  monthlyCompensation: '$.corporate.officerCompensation.monthlySegments[0].value.monthlyAmount',
  fiscalPeriodFrom: '$.corporate.officerCompensation.monthlySegments[0].period.from',
  fiscalPeriodTo: '$.corporate.officerCompensation.monthlySegments[0].period.to',
  appointedOn: '$.corporate.officerCompensation.appointedOn',
  revision: '$.corporate.officerCompensation.revision',
  standardRemunerationDecisionKind: '$.corporate.officerCompensation.standardRemunerationDecisionKind',
  bonusPlan: '$.corporate.officerCompensation.bonusPlan',
  planKind: '$.corporate.officerCompensation.planKind',
  healthInsurerKind: '$.corporate.healthInsurer.kind',
  healthInsurerPrefectureCode: '$.corporate.healthInsurer.prefectureCode',
});

/**
 * @typedef {{path:string, label:string, value:{unit:'JPY',value:bigint}|string}} HandoffField
 * @typedef {{
 *   handoffSchemaVersion:string,
 *   sourceSimulator:'yakuin_hoshu',
 *   sourceResultStatus:'complete'|'partial',
 *   calculationContext:object,
 *   inputSchemaVersion:string,
 *   calculationVersion:string,
 *   fields:ReadonlyArray<HandoffField>,
 *   warnings:ReadonlyArray<object>,
 *   excludedItems:ReadonlyArray<object>
 * }} YakuinHoshuHandoff
 */

function field(path, label, value) {
  return Object.freeze({ path, label, value });
}

function candidateForHandoff(result) {
  const data = result.breakdown && result.breakdown.data;
  if (!data || !data.selectedPlanId || !Array.isArray(data.candidates)) return null;
  return data.candidates.find(candidate => candidate.planId === data.selectedPlanId) || null;
}

function createYakuinHoshuHandoff(result) {
  if (!result || result.simulatorType !== 'yakuin_hoshu') {
    throw new TypeError('yakuin_hoshuのSimulationResultを指定してください');
  }
  if (result.resultStatus === 'blocked') {
    throw new RangeError('blocked結果からHandoffは作成できません');
  }
  const context = result.calculationContext;
  const candidate = candidateForHandoff(result);
  if (!candidate) throw new RangeError('確定した報酬月額がない結果からHandoffは作成できません');
  if (!context || !context.fiscalPeriod || !context.jurisdiction) {
    throw new TypeError('Handoffに必要なCalculationContextがありません');
  }
  return Object.freeze({
    handoffSchemaVersion: HANDOFF_SCHEMA_VERSION,
    sourceSimulator: 'yakuin_hoshu',
    sourceResultStatus: result.resultStatus,
    calculationContext: context,
    inputSchemaVersion: result.inputSchemaVersion,
    calculationVersion: result.calculationVersion,
    fields: Object.freeze([
      field(HANDOFF_PATHS.monthlyCompensation, '役員報酬月額', candidate.monthlyCompensation),
      field(HANDOFF_PATHS.fiscalPeriodFrom, '事業年度開始日', context.fiscalPeriod.from),
      field(HANDOFF_PATHS.fiscalPeriodTo, '事業年度終了日', context.fiscalPeriod.to),
      field(HANDOFF_PATHS.appointedOn, '役員就任日', context.fiscalPeriod.from),
      field(HANDOFF_PATHS.revision, '報酬改定', 'none'),
      field(HANDOFF_PATHS.standardRemunerationDecisionKind,
        '標準報酬の決定方法', STANDARD_REMUNERATION_DECISION_KIND),
      field(HANDOFF_PATHS.bonusPlan, '賞与の有無', 'none'),
      field(HANDOFF_PATHS.planKind, '支給計画の種別', PLAN_KIND),
      field(HANDOFF_PATHS.healthInsurerKind, '健康保険者', 'kyokai_kenpo'),
      field(HANDOFF_PATHS.healthInsurerPrefectureCode,
        '健康保険の都道府県コード', context.jurisdiction.prefectureCode),
    ]),
    warnings: Object.freeze([...(result.warnings || [])]),
    excludedItems: Object.freeze([...(result.excludedItems || [])]),
  });
}

function samePeriod(left, right) {
  return Boolean(left && right && left.from === right.from && left.to === right.to);
}

function sameJurisdiction(left, right) {
  const keys = [
    'country', 'codeSystemVersion', 'asOfForCodes', 'prefectureCode',
    'municipalityCode', 'isDesignatedCity',
  ];
  return Boolean(left && right && keys.every(key => left[key] === right[key]));
}

function fieldValue(handoff, path) {
  const found = handoff.fields.find(item => item.path === path);
  return found && found.value;
}

function reject(formState, reason) {
  return Object.freeze({
    accepted: false,
    reason,
    message: '条件が変わったため引き継げませんでした。もう一度④で計算してください',
    formState: Object.freeze({ ...formState }),
  });
}

function acceptYakuinHoshuHandoff(handoff, formState, expectedContext) {
  if (!formState || typeof formState !== 'object') throw new TypeError('①のフォーム状態が必要です');
  if (!expectedContext || !expectedContext.fiscalPeriod || !expectedContext.jurisdiction) {
    throw new TypeError('①のCalculationContextが必要です');
  }
  if (!handoff || handoff.handoffSchemaVersion !== HANDOFF_SCHEMA_VERSION ||
      handoff.sourceSimulator !== 'yakuin_hoshu' || handoff.sourceResultStatus === 'blocked' ||
      !Array.isArray(handoff.fields)) return reject(formState, 'handoff_contract_mismatch');
  const context = handoff.calculationContext;
  if (!context || context.masterSnapshotId !== expectedContext.masterSnapshotId) {
    return reject(formState, 'master_snapshot_id_mismatch');
  }
  if (context.masterSnapshotHash !== expectedContext.masterSnapshotHash) {
    return reject(formState, 'master_snapshot_hash_mismatch');
  }
  if (!samePeriod(context.fiscalPeriod, expectedContext.fiscalPeriod)) {
    return reject(formState, 'fiscal_period_mismatch');
  }
  if (!sameJurisdiction(context.jurisdiction, expectedContext.jurisdiction)) {
    return reject(formState, 'jurisdiction_mismatch');
  }
  if (fieldValue(handoff, HANDOFF_PATHS.healthInsurerKind) !== 'kyokai_kenpo' ||
      fieldValue(handoff, HANDOFF_PATHS.healthInsurerPrefectureCode) !==
        expectedContext.jurisdiction.prefectureCode) {
    return reject(formState, 'health_insurer_mismatch');
  }
  if (fieldValue(handoff, HANDOFF_PATHS.fiscalPeriodFrom) !== expectedContext.fiscalPeriod.from ||
      fieldValue(handoff, HANDOFF_PATHS.fiscalPeriodTo) !== expectedContext.fiscalPeriod.to) {
    return reject(formState, 'handoff_period_fields_mismatch');
  }
  if (fieldValue(handoff, HANDOFF_PATHS.standardRemunerationDecisionKind) !==
        STANDARD_REMUNERATION_DECISION_KIND ||
      fieldValue(handoff, HANDOFF_PATHS.bonusPlan) !== 'none' ||
      fieldValue(handoff, HANDOFF_PATHS.planKind) !== PLAN_KIND ||
      fieldValue(handoff, HANDOFF_PATHS.revision) !== 'none') {
    return reject(formState, 'compensation_plan_mismatch');
  }
  const monthly = fieldValue(handoff, HANDOFF_PATHS.monthlyCompensation);
  if (!monthly || monthly.unit !== 'JPY' || typeof monthly.value !== 'bigint') {
    return reject(formState, 'monthly_compensation_invalid');
  }
  return Object.freeze({
    accepted: true,
    reason: null,
    message: '④の結果から引き継ぎました',
    formState: Object.freeze({
      ...formState,
      officerCompensationMonthly: monthly.value.toString(10),
    }),
    sourceResultStatus: handoff.sourceResultStatus,
  });
}

module.exports = Object.freeze({
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_PATHS,
  createYakuinHoshuHandoff,
  acceptYakuinHoshuHandoff,
});
