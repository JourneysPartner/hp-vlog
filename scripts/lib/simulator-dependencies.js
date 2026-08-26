'use strict';

/**
 * シミュレーター別のマスター依存表を読み、整合性と公開可否を判定する。
 *
 * 形式検証と公開ゲートが別々に依存表を解釈すると、片方だけ修正されたときに
 * 未承認レコードが公開をすり抜ける。このファイルを唯一の解釈箇所にする。
 */

const fs = require('fs');
const path = require('path');

const SIMULATOR_TYPES = ['hojinnari', 'shohizei', 'sozoku', 'yakuin_hoshu'];
const SIMULATOR_LABELS = {
  hojinnari: '法人成り',
  shohizei: '消費税',
  sozoku: '相続税',
  yakuin_hoshu: '役員報酬',
};

function dependencyPath(mastersDir) {
  return path.join(mastersDir, 'simulator-dependencies.json');
}

function loadSimulatorDependencies(mastersDir) {
  const filePath = dependencyPath(mastersDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(`シミュレーター依存表が見つかりません: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`シミュレーター依存表を読めません: ${e.message}`);
  }
}

/**
 * 根拠ごとにまとめた value_keys を平らな集合へ直す。
 * 根拠が空だと依存を追加した理由を後から追えないため、形式エラーにする。
 */
function flattenDependencyGroups(groups, location, errors) {
  const keys = [];
  if (!Array.isArray(groups)) {
    errors.push(`${location} は配列で記載してください`);
    return keys;
  }
  for (const [index, group] of groups.entries()) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      errors.push(`${location}[${index}] は根拠と value_keys を持つオブジェクトにしてください`);
      continue;
    }
    if (typeof group._basis !== 'string' || group._basis.trim() === '') {
      errors.push(`${location}[${index}] に依存の根拠（_basis）がありません`);
    }
    if (!Array.isArray(group.value_keys)) {
      errors.push(`${location}[${index}].value_keys は配列で記載してください`);
      continue;
    }
    for (const valueKey of group.value_keys) {
      if (typeof valueKey !== 'string' || !/^[a-z][a-z0-9_]*$/.test(valueKey)) {
        errors.push(`${location}[${index}] の value_key が不正です → ${JSON.stringify(valueKey)}`);
        continue;
      }
      keys.push(valueKey);
    }
  }
  return keys;
}

/**
 * マスター実体と依存表を突き合わせる。
 * 未分類は、設計判断なしに勝手に振り分けないため警告として返す。
 * 依存表だけにあるキーは綴り間違いでも公開停止漏れになるためエラーとする。
 */
function inspectSimulatorDependencies(records, table) {
  const errors = [];
  const warnings = [];
  const simulators = table && table.simulators;
  const dependenciesBySimulator = {};

  if (!simulators || typeof simulators !== 'object' || Array.isArray(simulators)) {
    errors.push('依存表に simulators がありません');
  }

  for (const simulatorType of SIMULATOR_TYPES) {
    const entry = simulators && simulators[simulatorType];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`依存表に ${simulatorType} がありません`);
      dependenciesBySimulator[simulatorType] = { required: [], optional: [] };
      continue;
    }

    const required = flattenDependencyGroups(
      entry.required,
      `simulators.${simulatorType}.required`,
      errors
    );
    const optional = flattenDependencyGroups(
      entry.optional,
      `simulators.${simulatorType}.optional`,
      errors
    );
    const seen = new Set();
    for (const valueKey of [...required, ...optional]) {
      if (seen.has(valueKey)) {
        errors.push(`${simulatorType} で value_key "${valueKey}" が重複しています`);
      }
      seen.add(valueKey);
    }
    dependenciesBySimulator[simulatorType] = { required, optional };
  }

  if (simulators && typeof simulators === 'object' && !Array.isArray(simulators)) {
    for (const simulatorType of Object.keys(simulators)) {
      if (!SIMULATOR_TYPES.includes(simulatorType)) {
        errors.push(`仕様書 §7 に無いシミュレーター識別子です → "${simulatorType}"`);
      }
    }
  }

  const masterValueKeys = new Set();
  for (const item of records) {
    const record = item.record || item.rec || item;
    if (record && typeof record.value_key === 'string') masterValueKeys.add(record.value_key);
  }

  const classifiedValueKeys = new Set();
  for (const dependency of Object.values(dependenciesBySimulator)) {
    for (const valueKey of [...dependency.required, ...dependency.optional]) {
      classifiedValueKeys.add(valueKey);
    }
  }

  const missingValueKeys = [...classifiedValueKeys]
    .filter(valueKey => !masterValueKeys.has(valueKey))
    .sort();
  for (const valueKey of missingValueKeys) {
    errors.push(`依存表の value_key "${valueKey}" がマスターに存在しません`);
  }

  const unclassifiedValueKeys = [...masterValueKeys]
    .filter(valueKey => !classifiedValueKeys.has(valueKey))
    .sort();
  if (unclassifiedValueKeys.length > 0) {
    warnings.push(
      `どのシミュレーターにも未分類の value_key ${unclassifiedValueKeys.length} 件: ` +
      unclassifiedValueKeys.join(', ')
    );
  }

  return {
    errors,
    warnings,
    dependenciesBySimulator,
    masterValueKeys,
    classifiedValueKeys,
    missingValueKeys,
    unclassifiedValueKeys,
  };
}

function reviewState(record) {
  if (record.data_review_status === 'blocked') return 'blocked';
  if (record.data_review_status !== 'approved') return 'notApproved';
  return 'approved';
}

/**
 * 必須の未承認・確認待ちだけを公開停止条件にする。
 * 任意依存は、該当入力を使わない計算まで止めないため警告件数として分ける。
 */
function evaluateSimulatorGates(records, inspection) {
  const byValueKey = new Map();
  for (const item of records) {
    const record = item.record || item.rec || item;
    if (!record || typeof record.value_key !== 'string') continue;
    if (!byValueKey.has(record.value_key)) byValueKey.set(record.value_key, []);
    byValueKey.get(record.value_key).push(record);
  }

  const result = {};
  for (const simulatorType of SIMULATOR_TYPES) {
    const dependency = inspection.dependenciesBySimulator[simulatorType] || { required: [], optional: [] };
    const gate = {
      simulatorType,
      label: SIMULATOR_LABELS[simulatorType],
      publishable: true,
      required: { blocked: [], notApproved: [], missingValueKeys: [] },
      optional: { blocked: [], notApproved: [], missingValueKeys: [] },
    };

    for (const necessity of ['required', 'optional']) {
      for (const valueKey of dependency[necessity]) {
        const matching = byValueKey.get(valueKey) || [];
        if (matching.length === 0) {
          gate[necessity].missingValueKeys.push(valueKey);
          continue;
        }
        for (const record of matching) {
          const state = reviewState(record);
          if (state === 'approved') continue;
          gate[necessity][state].push({
            record_id: record.record_id,
            value_key: valueKey,
            status: record.data_review_status || '(未設定)',
          });
        }
      }
    }

    gate.publishable =
      gate.required.blocked.length === 0 &&
      gate.required.notApproved.length === 0 &&
      gate.required.missingValueKeys.length === 0;
    result[simulatorType] = gate;
  }
  return result;
}

module.exports = {
  SIMULATOR_TYPES,
  SIMULATOR_LABELS,
  dependencyPath,
  loadSimulatorDependencies,
  inspectSimulatorDependencies,
  evaluateSimulatorGates,
};
