'use strict';

/**
 * 検証済み税務マスターの読取専用スナップショット。
 * JSONはモジュールのロード時だけ読み、以後のfind/findBracketはメモリ内だけを検索する。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { money } = require('../common/money.js');

const MASTER_ROOT_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'tax-simulator',
  'masters'
);
const MASTER_DATA_DIR = path.join(MASTER_ROOT_DIR, 'data');
const DEPENDENCIES_FILE = path.join(MASTER_ROOT_DIR, 'simulator-dependencies.json');
const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONEY_PATTERN = /^-?[0-9]+$/;
const EMPTY_RESULT = Object.freeze([]);

/**
 * v1では公式計算例ケースIDをマスターに保持していないため、§50-1-18(c)を完全には
 * 満たさない。追跡結果ではverificationModeを単一一次資料＋代替統制とし、
 * officialExampleCaseIdsを空配列で明示する。この仮置きを結果の前提にも必ず載せる。
 */
const ALTERNATIVE_CONTROL_ASSUMPTION =
  '使用マスターの代替統制には公式様式・公的計算例のケースIDが未登録です（v1の明示的な逸脱）。';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function listJsonFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(target);
  }
  return files.sort();
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files.sort();
}

function normalizedSnapshotPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

/**
 * 相対パスと生バイト列を長さ付きで連結し、列挙順に依存しないSHA-256を返す。
 * テストから実ファイルを書き換えず決定性を確認できるよう、入力列を引数に取る。
 */
function computeSnapshotHash(files) {
  if (!Array.isArray(files)) throw new TypeError('filesは配列で指定してください');
  const normalized = files.map((file, index) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError(`files[${index}]はオブジェクトで指定してください`);
    }
    if (typeof file.path !== 'string' || file.path.length === 0) {
      throw new TypeError(`files[${index}].pathは空でない文字列で指定してください`);
    }
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');
    return { path: normalizedSnapshotPath(file.path), content };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const hash = crypto.createHash('sha256');
  for (const file of normalized) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    hash.update(Buffer.from(`${pathBytes.length}:`, 'utf8'));
    hash.update(pathBytes);
    hash.update(Buffer.from(`:${file.content.length}:`, 'utf8'));
    hash.update(file.content);
  }
  return hash.digest('hex');
}

function collectRecords(node, records) {
  if (node === null || typeof node !== 'object') return;
  if (typeof node.value_key === 'string') records.push(node);
  for (const child of Object.values(node)) collectRecords(child, records);
}

const documents = [];
const recordsByValueKey = new Map();
let legalStatusAsOf = null;
for (const file of listJsonFiles(MASTER_DATA_DIR)) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = [];
  collectRecords(document, records);
  for (const record of records) {
    if (typeof record.as_of_date === 'string' &&
        (legalStatusAsOf === null || record.as_of_date > legalStatusAsOf)) {
      legalStatusAsOf = record.as_of_date;
    }
    const indexed = recordsByValueKey.get(record.value_key) || [];
    indexed.push(record);
    recordsByValueKey.set(record.value_key, indexed);
  }
  documents.push(deepFreeze(document));
}
deepFreeze(documents);
for (const records of recordsByValueKey.values()) Object.freeze(records);

const snapshotFiles = [
  ...listFiles(MASTER_DATA_DIR),
  DEPENDENCIES_FILE,
].map(file => ({
  path: normalizedSnapshotPath(path.relative(MASTER_ROOT_DIR, file)),
  content: fs.readFileSync(file),
}));
const snapshotHash = computeSnapshotHash(snapshotFiles);
// v1のlegalStatusAsOfは、全マスターレコードのas_of_dateの最大値と定義する。
const snapshotInfo = Object.freeze({
  snapshotId: `tax-masters-${snapshotHash.slice(0, 16)}`,
  snapshotHash,
  legalStatusAsOf,
});
let activeRecordTracking = null;

function getSnapshotInfo() {
  return snapshotInfo;
}

function beginRecordTracking() {
  if (activeRecordTracking !== null) {
    throw new Error('使用マスターレコードの追跡は多重に開始できません');
  }
  activeRecordTracking = new Map();
  return Object.freeze({});
}

function trackedRecordReference(record) {
  const sourceIds = typeof record.source_document_id === 'string'
    ? [record.source_document_id]
    : [];
  return deepFreeze({
    masterName: record.master_name,
    recordId: record.record_id,
    reviewStatus: record.data_review_status,
    sourceIds,
    legalStatus: record.legal_status,
    verificationMode: 'single_primary_with_alternative_controls',
    alternativeControlRefs: {
      crossReferenceLocators: typeof record.source_locator === 'string'
        ? [record.source_locator]
        : [],
      officialExampleCaseIds: [],
      approvedBy: record.verified_by,
      approvedAt: record.verified_at,
    },
  });
}

function trackRecords(records) {
  if (activeRecordTracking === null) return;
  for (const record of records) {
    const reference = trackedRecordReference(record);
    const key = `${reference.masterName}\u0000${reference.recordId}`;
    if (!activeRecordTracking.has(key)) activeRecordTracking.set(key, reference);
  }
}

function endRecordTracking() {
  if (activeRecordTracking === null) {
    throw new Error('使用マスターレコードの追跡が開始されていません');
  }
  const tracked = Object.freeze([...activeRecordTracking.values()]);
  activeRecordTracking = null;
  return tracked;
}

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name}はオブジェクトで指定してください`);
  }
}

function isLeapYear(year) {
  return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
}

function assertLocalDate(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name}はYYYY-MM-DDで指定してください`);
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new TypeError(`${name}はYYYY-MM-DDで指定してください`);
  const year = BigInt(match[1]);
  const day = BigInt(match[3]);
  const daysByMonth = {
    '01': 31n, '02': isLeapYear(year) ? 29n : 28n, '03': 31n, '04': 30n,
    '05': 31n, '06': 30n, '07': 31n, '08': 31n, '09': 30n, '10': 31n,
    '11': 30n, '12': 31n,
  };
  const lastDay = daysByMonth[match[2]];
  if (lastDay === undefined || day < 1n || day > lastDay) {
    throw new RangeError(`${name}は実在する日付で指定してください`);
  }
  return value;
}

function normalizeCriterion(criterion) {
  assertObject(criterion, '検索基準');
  const supported = ['onDate', 'taxYear', 'periodIntersects'];
  const specified = supported.filter(key => Object.hasOwn(criterion, key));
  const unknown = Object.keys(criterion).filter(key => !supported.includes(key));
  if (specified.length !== 1 || unknown.length > 0) {
    throw new TypeError('検索基準はonDate、taxYear、periodIntersectsのいずれか1つだけを指定してください');
  }

  if (specified[0] === 'onDate') {
    return { kind: 'onDate', onDate: assertLocalDate(criterion.onDate, 'onDate') };
  }
  if (specified[0] === 'taxYear') {
    if (!Number.isInteger(criterion.taxYear) || criterion.taxYear < 1 || criterion.taxYear > 9999) {
      throw new TypeError('taxYearは1から9999までの整数で指定してください');
    }
    const year = String(criterion.taxYear).padStart(4, '0');
    return { kind: 'taxYear', from: `${year}-01-01`, to: `${year}-12-31` };
  }

  assertObject(criterion.periodIntersects, 'periodIntersects');
  const keys = Object.keys(criterion.periodIntersects);
  if (keys.length !== 2 || !keys.includes('from') || !keys.includes('to')) {
    throw new TypeError('periodIntersectsはfromとtoだけを指定してください');
  }
  const from = assertLocalDate(criterion.periodIntersects.from, 'periodIntersects.from');
  const to = assertLocalDate(criterion.periodIntersects.to, 'periodIntersects.to');
  if (from > to) throw new RangeError('periodIntersects.fromはto以前を指定してください');
  return { kind: 'periodIntersects', from, to };
}

function matchesCriterion(record, criterion) {
  const effectiveTo = record.effective_to === null ? '9999-12-31' : record.effective_to;
  if (criterion.kind === 'onDate') {
    return record.effective_from <= criterion.onDate && effectiveTo >= criterion.onDate;
  }
  if (criterion.kind === 'taxYear') {
    return criterion.to >= record.effective_from && criterion.from <= effectiveTo;
  }
  return record.period_match_rule === 'taxable_period_intersects' &&
    criterion.to >= record.effective_from && criterion.from <= effectiveTo;
}

function findRecords(valueKey, criterion) {
  if (typeof valueKey !== 'string' || valueKey.length === 0) {
    throw new TypeError('valueKeyは空でない文字列で指定してください');
  }
  const normalized = normalizeCriterion(criterion);
  const indexed = recordsByValueKey.get(valueKey);
  if (!indexed) return EMPTY_RESULT;
  const approved = indexed.filter(record =>
    record.data_review_status === 'approved' && matchesCriterion(record, normalized));
  return approved.length === 0 ? EMPTY_RESULT : Object.freeze(approved);
}

function find(valueKey, criterion) {
  const records = findRecords(valueKey, criterion);
  trackRecords(records);
  return records;
}

function masterMoneyValue(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.unit !== 'JPY' || typeof value.value !== 'string' || !MONEY_PATTERN.test(value.value)) {
    throw new TypeError(`マスターの${fieldName}がMoneyWire形式ではありません`);
  }
  return BigInt(value.value);
}

function findBracket(valueKey, amount, criterion) {
  const checkedAmount = money(amount);
  const matches = [];
  for (const record of findRecords(valueKey, criterion)) {
    const lowerKeys = Object.keys(record).filter(key => key.endsWith('_lower_inclusive'));
    if (lowerKeys.length === 0) continue;
    if (lowerKeys.length !== 1) {
      throw new Error(`段階表${record.record_id}の下限フィールドを一意に決められません`);
    }
    const lowerKey = lowerKeys[0];
    const upperKey = lowerKey.replace(/_lower_inclusive$/, '_upper_inclusive');
    if (!Object.hasOwn(record, upperKey)) {
      throw new Error(`段階表${record.record_id}に${upperKey}がありません`);
    }
    const lower = masterMoneyValue(record[lowerKey], lowerKey);
    const upper = record[upperKey] === null ? null : masterMoneyValue(record[upperKey], upperKey);
    if (checkedAmount.value >= lower && (upper === null || checkedAmount.value <= upper)) {
      matches.push(record);
    }
  }
  if (matches.length > 1) {
    throw new Error(`段階表${valueKey}で金額に該当する承認済みレコードが重複しています`);
  }
  const matched = matches[0] || null;
  if (matched !== null) trackRecords([matched]);
  return matched;
}

module.exports = Object.freeze({
  find,
  findBracket,
  getSnapshotInfo,
  beginRecordTracking,
  endRecordTracking,
  computeSnapshotHash,
  ALTERNATIVE_CONTROL_ASSUMPTION,
});
