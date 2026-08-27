'use strict';

const loadedSourceRegistryDocument = require('../../../data/tax-simulator/masters/sources/source-registry.json');
const {
  ALTERNATIVE_CONTROL_ASSUMPTION,
} = require('../../tax-engine/masters/snapshot.js');
const {
  calculationVersion,
  inputSchemaVersions,
  supportedProfileVersion,
} = require('./versions.js');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// 呼び出し中の外部変更に影響されない、ロード時固定の読取専用台帳とする。
const sourceRegistryDocument = deepFreeze(JSON.parse(JSON.stringify(loadedSourceRegistryDocument)));

const WARNING_MAP = Object.freeze({
  HJ_CORPORATE_RETAINED_NOT_PERSONAL: Object.freeze({
    level: 'info',
    canContinue: true,
  }),
  CT_LOCAL_TAX_STANDARD_RATES: Object.freeze({
    level: 'attention',
    userAction: '所在地の自治体税率を確認してください',
    canContinue: true,
  }),
  RT_EXEMPTION_STANDARD_AMOUNT_ESTIMATE: Object.freeze({
    level: 'attention',
    userAction: '自治体固有の非課税限度額を確認してください',
    canContinue: true,
  }),
  NHI_SELECTED_MUNICIPALITY_ESTIMATE: Object.freeze({
    level: 'attention',
    userAction: '対象自治体の国民健康保険料を確認してください',
    canContinue: true,
  }),
  CT_UNANSWERED_ADJUSTMENTS_ASSUMED_ZERO: Object.freeze({
    level: 'attention',
    userAction: '未回答の税務調整項目を確認してください',
    canContinue: true,
  }),
  IBT_MONTH_COUNT_ROUNDED_UP_INPUT: Object.freeze({
    level: 'info',
    canContinue: true,
  }),
  IT_HOUSING_LOAN_CREDIT_EXCEEDS_TAX: Object.freeze({
    level: 'info',
    canContinue: true,
  }),
  SI_COMBINED_RATE_SINGLE_ROUNDING: Object.freeze({
    level: 'info',
    canContinue: true,
  }),
  SI_AGE_MONTH_SIMPLIFIED: Object.freeze({
    level: 'attention',
    userAction: '資格取得・喪失月と年齢到達月を確認してください',
    canContinue: true,
  }),
  MASTER_SOURCE_NOT_REGISTERED: Object.freeze({
    level: 'critical',
    userAction: '出典台帳を整備してから再計算してください',
    canContinue: false,
  }),
  MASTER_RECORD_NOT_APPROVED: Object.freeze({
    level: 'critical',
    userAction: 'マスターレコードの確認工程を完了してください',
    canContinue: false,
  }),
  IHT_MASTER_UNAVAILABLE: Object.freeze({
    level: 'critical',
    userAction: '承認済みマスターを用意してから再計算してください',
    canContinue: false,
  }),
});

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name}はオブジェクトで指定してください`);
  }
}

function assertSnapshotMatch(masters, context) {
  assertObject(masters, 'masters');
  assertObject(context, 'calculationContext');
  if (masters.snapshotId !== context.masterSnapshotId ||
      masters.snapshotHash !== context.masterSnapshotHash) {
    throw new Error('マスタースナップショットと計算コンテキストが一致しません');
  }
}

function toServiceWarning(warning) {
  assertObject(warning, 'warning');
  if (typeof warning.code !== 'string' || warning.code.length === 0) {
    throw new TypeError('warning.codeは空でない文字列で指定してください');
  }
  const mapped = WARNING_MAP[warning.code];
  const defaultApplied = mapped === undefined;
  const basisText = warning.basis || warning.message;
  const result = {
    code: warning.code,
    level: mapped ? mapped.level : 'attention',
    canContinue: mapped ? mapped.canContinue : true,
  };
  if (typeof warning.fieldPath === 'string') result.fieldPath = warning.fieldPath;
  if (defaultApplied) {
    result.basis = basisText
      ? `${basisText}（未登録コードのためattention・計算継続可の既定値を適用）`
      : '未登録コードのためattention・計算継続可の既定値を適用';
  } else if (typeof basisText === 'string' && basisText.length > 0) {
    result.basis = basisText;
  }
  const userAction = warning.userAction || (mapped && mapped.userAction);
  if (typeof userAction === 'string' && userAction.length > 0) result.userAction = userAction;
  return result;
}

function authorityFromUrl(url) {
  if (typeof url !== 'string') return undefined;
  if (url.includes('nta.go.jp')) return '国税庁';
  if (url.includes('mof.go.jp')) return '財務省';
  if (url.includes('soumu.go.jp')) return '総務省';
  if (url.includes('nenkin.go.jp')) return '日本年金機構';
  if (url.includes('kyoukaikenpo.or.jp')) return '全国健康保険協会';
  if (url.includes('e-gov.go.jp')) return 'e-Gov法令検索';
  return '公的機関';
}

function sourceDocumentNumber(entry) {
  if (typeof entry.taxanswer_id === 'string') return entry.taxanswer_id;
  if (typeof entry.law_id === 'string') return entry.law_id;
  return undefined;
}

function collectSourceReferences(usedMasterRecords, registryDocument = sourceRegistryDocument) {
  const registry = registryDocument && registryDocument.sources
    ? registryDocument.sources
    : registryDocument;
  assertObject(registry, 'sourceRegistry');
  const usages = new Map();
  for (const record of usedMasterRecords) {
    for (const sourceId of record.sourceIds || []) {
      const usage = usages.get(sourceId) || { locators: new Set(), reviewStatuses: new Set() };
      const locators = record.alternativeControlRefs &&
        record.alternativeControlRefs.crossReferenceLocators;
      for (const locator of locators || []) usage.locators.add(locator);
      if (record.reviewStatus) usage.reviewStatuses.add(record.reviewStatus);
      usages.set(sourceId, usage);
    }
  }

  const sources = [];
  const missingSourceIds = [];
  for (const [sourceId, usage] of usages) {
    const entry = registry[sourceId];
    if (!entry) {
      missingSourceIds.push(sourceId);
      continue;
    }
    const source = {
      sourceId,
      authority: authorityFromUrl(entry.url),
      title: entry.label,
      url: entry.url,
      locator: [...usage.locators].join(' / '),
      reviewStatus: usage.reviewStatuses.size === 1
        ? [...usage.reviewStatuses][0]
        : 'blocked',
      kind: entry.kind,
      updateCycle: entry.update_cycle,
      coverageBasis: entry.coverage_basis,
      urlVerified: entry.url_verified,
    };
    const documentNumber = sourceDocumentNumber(entry);
    if (documentNumber !== undefined) source.documentNumber = documentNumber;
    sources.push(source);
  }
  return { sources, missingSourceIds };
}

function buildSources(usedMasterRecords, registryDocument) {
  if (!Array.isArray(usedMasterRecords)) {
    throw new TypeError('usedMasterRecordsは配列で指定してください');
  }
  return collectSourceReferences(usedMasterRecords, registryDocument).sources;
}

function appendUnique(array, value) {
  if (!array.includes(value)) array.push(value);
}

function blockedSummary(summary) {
  return { title: summary && typeof summary.title === 'string' ? summary.title : '計算を完了できませんでした' };
}

function buildSimulationResult(options) {
  assertObject(options, 'result options');
  const context = options.calculationContext || options.context;
  assertSnapshotMatch(options.masters, context);
  if (!Object.hasOwn(inputSchemaVersions, options.simulatorType)) {
    throw new Error('対応していないシミュレーター種別です');
  }

  const usedMasterRecords = options.usedMasterRecords || [];
  if (!Array.isArray(usedMasterRecords)) {
    throw new TypeError('usedMasterRecordsは配列で指定してください');
  }
  const assumptions = [...(options.assumptions || [])];
  if (usedMasterRecords.some(record =>
    record.verificationMode === 'single_primary_with_alternative_controls')) {
    appendUnique(assumptions, ALTERNATIVE_CONTROL_ASSUMPTION);
  }

  const warnings = (options.warnings || []).map(toServiceWarning);
  const { sources, missingSourceIds } = collectSourceReferences(
    usedMasterRecords,
    options.sourceRegistry || sourceRegistryDocument
  );
  if (missingSourceIds.length > 0) {
    warnings.push(toServiceWarning({
      code: 'MASTER_SOURCE_NOT_REGISTERED',
      message: `出典台帳に未登録のsourceIdがあります: ${missingSourceIds.join(', ')}`,
    }));
  }
  const unapproved = usedMasterRecords.filter(record => record.reviewStatus !== 'approved');
  if (unapproved.length > 0) {
    warnings.push(toServiceWarning({
      code: 'MASTER_RECORD_NOT_APPROVED',
      message: `未承認のマスターレコードがあります: ${unapproved.map(record => record.recordId).join(', ')}`,
    }));
  }

  let resultStatus = options.resultStatus;
  if (warnings.some(warning => warning.canContinue === false)) resultStatus = 'blocked';
  if (!['complete', 'partial', 'blocked'].includes(resultStatus)) {
    throw new Error('resultStatusが値集合外です');
  }

  const result = {
    simulatorType: options.simulatorType,
    periodLabel: options.periodLabel,
    comparisonBasis: options.comparisonBasis,
    resultStatus,
    summary: resultStatus === 'blocked' ? blockedSummary(options.summary) : options.summary,
    assumptions,
    warnings,
    sources,
    calculationVersion,
    inputSchemaVersion: inputSchemaVersions[options.simulatorType],
    supportedProfileVersion,
    calculationContext: context,
    usedMasterRecords,
    precision: options.precision,
    excludedItems: options.excludedItems || [],
  };
  if (resultStatus !== 'blocked' && Object.hasOwn(options, 'breakdown')) {
    result.breakdown = options.breakdown;
  }
  if (Object.hasOwn(options, 'applicableMethods')) {
    result.applicableMethods = options.applicableMethods;
  }
  return result;
}

module.exports = Object.freeze({
  buildSimulationResult,
  buildSources,
  toServiceWarning,
  WARNING_MAP,
});
