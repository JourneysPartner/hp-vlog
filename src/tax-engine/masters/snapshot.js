'use strict';

/**
 * 検証済み税務マスターの読取専用スナップショット。
 * JSONはモジュールのロード時だけ読み、以後のfind/findBracketはメモリ内だけを検索する。
 */

const fs = require('fs');
const path = require('path');
const { money } = require('../common/money.js');

const MASTER_DATA_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'tax-simulator',
  'masters',
  'data'
);
const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONEY_PATTERN = /^-?[0-9]+$/;
const EMPTY_RESULT = Object.freeze([]);

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

function collectRecords(node, records) {
  if (node === null || typeof node !== 'object') return;
  if (typeof node.value_key === 'string') records.push(node);
  for (const child of Object.values(node)) collectRecords(child, records);
}

const documents = [];
const recordsByValueKey = new Map();
for (const file of listJsonFiles(MASTER_DATA_DIR)) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = [];
  collectRecords(document, records);
  for (const record of records) {
    const indexed = recordsByValueKey.get(record.value_key) || [];
    indexed.push(record);
    recordsByValueKey.set(record.value_key, indexed);
  }
  documents.push(deepFreeze(document));
}
deepFreeze(documents);
for (const records of recordsByValueKey.values()) Object.freeze(records);

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

function find(valueKey, criterion) {
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
  for (const record of find(valueKey, criterion)) {
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
  return matches[0] || null;
}

module.exports = Object.freeze({ find, findBracket });
