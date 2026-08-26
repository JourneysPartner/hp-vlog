'use strict';

const {
  money,
  exact,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  addExact,
  subtractExact,
  addMoney,
  subtractMoney,
  compareExact,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');

function zeroMoney() {
  return money({ unit: 'JPY', value: 0n });
}

function zeroExact() {
  return moneyToExact(zeroMoney());
}

function inputMoney(value, fieldName = 'amount') {
  if (value === undefined || value === null) return zeroMoney();
  if (typeof value === 'bigint') return money({ unit: 'JPY', value });
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (typeof value === 'object' && value.unit === 'JPY' && typeof value.value === 'string') {
    return money({ unit: 'JPY', value: BigInt(value.value) });
  }
  try {
    return money(value);
  } catch (error) {
    error.message = `${fieldName}: ${error.message}`;
    throw error;
  }
}

function masterMoney(value) {
  return money({ unit: value.unit, value: BigInt(value.value) });
}

function masterRate(value) {
  return rate({ num: BigInt(value.num), den: BigInt(value.den) });
}

function sumMoney(values) {
  return values.reduce((total, value) => addMoney(total, value), zeroMoney());
}

function sumExact(values) {
  return values.reduce((total, value) => addExact(total, value), zeroExact());
}

function minMoney(left, right) {
  return left.value <= right.value ? left : right;
}

function maxMoney(left, right) {
  return left.value >= right.value ? left : right;
}

function floorMoneyAtZero(value) {
  return value.value < 0n ? zeroMoney() : value;
}

function floorExactAtZero(value) {
  return compareExact(value, zeroExact()) < 0 ? zeroExact() : exact(value);
}

function criterion(options = {}) {
  if (typeof options === 'number') return { taxYear: options };
  if (typeof options === 'string') return { onDate: options };
  if (options.onDate) return { onDate: options.onDate };
  if (Number.isInteger(options.taxYear)) return { taxYear: options.taxYear };
  throw new TypeError('taxYear または onDate を指定してください');
}

function inMoneyRange(value, record, lowerKey) {
  const upperKey = lowerKey.replace(/_lower_inclusive$/, '_upper_inclusive');
  const lower = masterMoney(record[lowerKey]);
  const upper = record[upperKey] === null ? null : masterMoney(record[upperKey]);
  return value.value >= lower.value && (upper === null || value.value <= upper.value);
}

function findRange(records, value, lowerKey) {
  const matches = records.filter(record => inMoneyRange(value, record, lowerKey));
  if (matches.length > 1) throw new Error(`段階表が重複しています: ${lowerKey}`);
  return matches[0] || null;
}

function calculateTierAmount(base, record) {
  if (record.deduction_type === 'full_amount') return base;
  if (record.deduction_type === 'fixed') return masterMoney(record.fixed_amount);
  if (record.deduction_type !== 'formula') {
    throw new Error(`未対応の段階表計算です: ${record.deduction_type}`);
  }
  const beforeRounding = addExact(
    multiplyRateByMoney(masterRate(record.rate), base),
    moneyToExact(masterMoney(record.rate_addition))
  );
  return applyRounding(beforeRounding, record.rounding_rule_id);
}

function applyRateToMoney(base, rateValue, roundingRuleId) {
  return applyRounding(multiplyRateByMoney(masterRate(rateValue), base), roundingRuleId);
}

function subtractMoneyFloorZero(left, right) {
  return floorMoneyAtZero(subtractMoney(left, right));
}

module.exports = {
  zeroMoney,
  zeroExact,
  inputMoney,
  masterMoney,
  masterRate,
  sumMoney,
  sumExact,
  minMoney,
  maxMoney,
  floorMoneyAtZero,
  floorExactAtZero,
  criterion,
  inMoneyRange,
  findRange,
  calculateTierAmount,
  applyRateToMoney,
  subtractMoneyFloorZero,
  moneyToExact,
  multiplyRateByMoney,
  addExact,
  subtractExact,
  addMoney,
  subtractMoney,
  compareExact,
  applyRounding,
};
