'use strict';

const snapshot = require('../../tax-engine/masters/snapshot.js');

const UNSUPPORTED_TAX_YEAR_CODE = 'SIM_TAX_YEAR_UNSUPPORTED';
const INCOME_TAX_STATUSES = Object.freeze(['supported', 'supported_with_pending_law']);
const CONSUMPTION_TAX_STATUSES = Object.freeze([...INCOME_TAX_STATUSES, 'partial']);

function isSupported(year, statuses) {
  const records = snapshot.peek('supported_tax_year', { taxYear: year })
    .filter(record => record.tax_year === year);
  return records.length === 1 && statuses.includes(records[0].support_status);
}

function unsupportedReason(year, fieldPath) {
  return {
    code: UNSUPPORTED_TAX_YEAR_CODE,
    fieldPath,
    message: year + '年の計算にはまだ対応していません。前年の値では計算しません。',
  };
}

function unsupportedIncomeYearReasons(year, fieldPath) {
  return isSupported(year, INCOME_TAX_STATUSES) ? [] : [unsupportedReason(year, fieldPath)];
}

function unsupportedConsumptionPeriodReasons(period, fieldPath) {
  const reasons = [];
  const lastYear = Number(period.to.slice(0, 4));
  for (let year = Number(period.from.slice(0, 4)); year <= lastYear; year++) {
    if (!isSupported(year, CONSUMPTION_TAX_STATUSES)) reasons.push(unsupportedReason(year, fieldPath));
  }
  return reasons;
}

module.exports = Object.freeze({
  unsupportedIncomeYearReasons,
  unsupportedConsumptionPeriodReasons,
});
