'use strict';

const { buildContextMetadata } = require('../context-builder.js');

const SUPPORTED_YEARS = Object.freeze([2025, 2026]);
const DEFAULT_YEAR = 2026;

function consumptionTaxPeriodFor(year) {
  if (!SUPPORTED_YEARS.includes(year)) throw new RangeError('課税期間は2025年か2026年で指定してください');
  return Object.freeze({ from: `${year}-01-01`, to: `${year}-12-31` });
}

const INVOICE_TRANSITION_CHANGE_DATE = '2026-10-01';

function invoiceTransitionSplit(period) {
  if (!(period.from < INVOICE_TRANSITION_CHANGE_DATE && INVOICE_TRANSITION_CHANGE_DATE <= period.to)) {
    return null;
  }
  return { beforeDate: '2026-09-30', afterDate: INVOICE_TRANSITION_CHANGE_DATE };
}

function buildCalculationContext(formState, snapshotInfo, calculatedAt) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  const year = formState.consumptionTaxYear === undefined
    ? DEFAULT_YEAR
    : Number(formState.consumptionTaxYear);
  return {
    ...buildContextMetadata(snapshotInfo, calculatedAt),
    consumptionTaxPeriod: { ...consumptionTaxPeriodFor(year) },
    jurisdiction: { country: 'JP' },
  };
}

module.exports = Object.freeze({
  SUPPORTED_YEARS,
  DEFAULT_YEAR,
  consumptionTaxPeriodFor,
  INVOICE_TRANSITION_CHANGE_DATE,
  invoiceTransitionSplit,
  buildCalculationContext,
});
