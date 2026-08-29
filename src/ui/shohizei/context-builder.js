'use strict';

const { buildContextMetadata } = require('../context-builder.js');

const SUPPORTED_YEAR = 2025;
const CONSUMPTION_TAX_PERIOD = Object.freeze({
  from: '2025-01-01',
  to: '2025-12-31',
});

function buildCalculationContext(formState, snapshotInfo, calculatedAt) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  const year = formState.consumptionTaxYear === undefined
    ? SUPPORTED_YEAR
    : Number(formState.consumptionTaxYear);
  if (year !== SUPPORTED_YEAR) throw new RangeError('第1版の課税期間は2025年だけです');
  return {
    ...buildContextMetadata(snapshotInfo, calculatedAt),
    consumptionTaxPeriod: { ...CONSUMPTION_TAX_PERIOD },
    jurisdiction: { country: 'JP' },
  };
}

module.exports = Object.freeze({
  SUPPORTED_YEAR,
  CONSUMPTION_TAX_PERIOD,
  buildCalculationContext,
});
