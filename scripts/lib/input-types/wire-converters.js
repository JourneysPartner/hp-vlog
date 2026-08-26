'use strict';

/**
 * bigint を含む値と Wire 形式の境界変換。
 * 外部との受け渡しで行う十進文字列変換は、このモジュールだけに置く。
 */

const INTEGER_DECIMAL_PATTERN = /^-?[0-9]+$/;

function assertObject(value, typeName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${typeName}はオブジェクトで指定してください`);
  }
}

function bigintToDecimal(value, fieldName) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${fieldName}はbigintで指定してください`);
  }
  return value.toString(10);
}

function decimalToBigint(value, fieldName) {
  if (typeof value !== 'string' || !INTEGER_DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${fieldName}は指数表記・桁区切り・小数点を含まない十進文字列で指定してください`);
  }
  return BigInt(value);
}

function assertPositiveDenominator(denominator, typeName) {
  if (denominator <= 0n) throw new RangeError(`${typeName}.denは正の整数で指定してください`);
}

function moneyToWire(value) {
  assertObject(value, 'Money');
  if (value.unit !== 'JPY') throw new TypeError('Money.unitはJPYで指定してください');
  return { unit: 'JPY', value: bigintToDecimal(value.value, 'Money.value') };
}

function moneyFromWire(value) {
  assertObject(value, 'MoneyWire');
  if (value.unit !== 'JPY') throw new TypeError('MoneyWire.unitはJPYで指定してください');
  return { unit: 'JPY', value: decimalToBigint(value.value, 'MoneyWire.value') };
}

function exactToWire(value) {
  assertObject(value, 'Exact');
  if (value.unit !== 'JPY') throw new TypeError('Exact.unitはJPYで指定してください');
  const den = decimalToBigint(bigintToDecimal(value.den, 'Exact.den'), 'Exact.den');
  assertPositiveDenominator(den, 'Exact');
  return {
    unit: 'JPY',
    num: bigintToDecimal(value.num, 'Exact.num'),
    den: bigintToDecimal(value.den, 'Exact.den'),
  };
}

function exactFromWire(value) {
  assertObject(value, 'ExactWire');
  if (value.unit !== 'JPY') throw new TypeError('ExactWire.unitはJPYで指定してください');
  const den = decimalToBigint(value.den, 'ExactWire.den');
  assertPositiveDenominator(den, 'ExactWire');
  return {
    unit: 'JPY',
    num: decimalToBigint(value.num, 'ExactWire.num'),
    den,
  };
}

function rateToWire(value) {
  assertObject(value, 'Rate');
  const den = decimalToBigint(bigintToDecimal(value.den, 'Rate.den'), 'Rate.den');
  assertPositiveDenominator(den, 'Rate');
  return {
    num: bigintToDecimal(value.num, 'Rate.num'),
    den: bigintToDecimal(value.den, 'Rate.den'),
  };
}

function rateFromWire(value) {
  assertObject(value, 'RateWire');
  const den = decimalToBigint(value.den, 'RateWire.den');
  assertPositiveDenominator(den, 'RateWire');
  return { num: decimalToBigint(value.num, 'RateWire.num'), den };
}

function areaToWire(value) {
  assertObject(value, 'Area');
  if (value.unit !== 'SQM') throw new TypeError('Area.unitはSQMで指定してください');
  const den = decimalToBigint(bigintToDecimal(value.den, 'Area.den'), 'Area.den');
  assertPositiveDenominator(den, 'Area');
  return {
    unit: 'SQM',
    num: bigintToDecimal(value.num, 'Area.num'),
    den: bigintToDecimal(value.den, 'Area.den'),
  };
}

function areaFromWire(value) {
  assertObject(value, 'AreaWire');
  if (value.unit !== 'SQM') throw new TypeError('AreaWire.unitはSQMで指定してください');
  const den = decimalToBigint(value.den, 'AreaWire.den');
  assertPositiveDenominator(den, 'AreaWire');
  return {
    unit: 'SQM',
    num: decimalToBigint(value.num, 'AreaWire.num'),
    den,
  };
}

module.exports = {
  moneyToWire,
  moneyFromWire,
  exactToWire,
  exactFromWire,
  rateToWire,
  rateFromWire,
  areaToWire,
  areaFromWire,
};
