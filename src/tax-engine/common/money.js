'use strict';

/**
 * 税額計算で使う金額・率・面積の型代数（仕様書 §3-3）。
 *
 * このディレクトリは既存コードに合わせてCommonJSで提供する。
 * ブラウザ配布時のES Modules化・バンドル方法は、配布基盤を決める段階まで保留する。
 * ExactからMoneyへの変換はrounding.jsだけが担い、このモジュールには置かない。
 */

function assertObject(value, typeName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${typeName}はオブジェクトで指定してください`);
  }
}

function assertBigint(value, fieldName) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${fieldName}はbigintで指定してください`);
  }
}

function assertPositiveDenominator(denominator, typeName) {
  if (denominator <= 0n) {
    throw new RangeError(`${typeName}.denは正の整数で指定してください`);
  }
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(left, right) {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function money(value) {
  assertObject(value, 'Money');
  if (value.unit !== 'JPY') throw new TypeError('Money.unitはJPYで指定してください');
  assertBigint(value.value, 'Money.value');
  return { unit: 'JPY', value: value.value };
}

function exact(value) {
  assertObject(value, 'Exact');
  if (value.unit !== 'JPY') throw new TypeError('Exact.unitはJPYで指定してください');
  assertBigint(value.num, 'Exact.num');
  assertBigint(value.den, 'Exact.den');
  assertPositiveDenominator(value.den, 'Exact');
  return { unit: 'JPY', num: value.num, den: value.den };
}

function rate(value) {
  assertObject(value, 'Rate');
  assertBigint(value.num, 'Rate.num');
  assertBigint(value.den, 'Rate.den');
  if (value.den === 0n) throw new RangeError('Rate.denに0は指定できません');

  // Rateだけは仕様どおり、分母を正にそろえて既約化する。
  const sign = value.den < 0n ? -1n : 1n;
  const numerator = value.num * sign;
  const denominator = value.den * sign;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { num: numerator / divisor, den: denominator / divisor };
}

function area(value) {
  assertObject(value, 'Area');
  if (value.unit !== 'SQM') throw new TypeError('Area.unitはSQMで指定してください');
  assertBigint(value.num, 'Area.num');
  assertBigint(value.den, 'Area.den');
  assertPositiveDenominator(value.den, 'Area');
  return { unit: 'SQM', num: value.num, den: value.den };
}

function moneyToExact(value) {
  const checked = money(value);
  return { unit: 'JPY', num: checked.value, den: 1n };
}

function multiplyRateByMoney(rateValue, moneyValue) {
  const checkedRate = rate(rateValue);
  const checkedMoney = money(moneyValue);
  return {
    unit: 'JPY',
    num: checkedRate.num * checkedMoney.value,
    den: checkedRate.den,
  };
}

function multiplyAreaByMoney(areaValue, unitPrice) {
  const checkedArea = area(areaValue);
  const checkedPrice = money(unitPrice);
  return {
    unit: 'JPY',
    num: checkedArea.num * checkedPrice.value,
    den: checkedArea.den,
  };
}

function addExact(left, right) {
  const a = exact(left);
  const b = exact(right);
  return {
    unit: 'JPY',
    num: a.num * b.den + b.num * a.den,
    den: a.den * b.den,
  };
}

function subtractExact(left, right) {
  const a = exact(left);
  const b = exact(right);
  return {
    unit: 'JPY',
    num: a.num * b.den - b.num * a.den,
    den: a.den * b.den,
  };
}

function addMoney(left, right) {
  const a = money(left);
  const b = money(right);
  return { unit: 'JPY', value: a.value + b.value };
}

function subtractMoney(left, right) {
  const a = money(left);
  const b = money(right);
  return { unit: 'JPY', value: a.value - b.value };
}

function compareExact(left, right) {
  const a = exact(left);
  const b = exact(right);
  const difference = a.num * b.den - b.num * a.den;
  if (difference < 0n) return -1;
  if (difference > 0n) return 1;
  return 0;
}

function compareExactToMoney(exactValue, moneyValue) {
  return compareExact(exactValue, moneyToExact(moneyValue));
}

module.exports = {
  money,
  exact,
  rate,
  area,
  moneyToExact,
  multiplyRateByMoney,
  multiplyAreaByMoney,
  addExact,
  subtractExact,
  addMoney,
  subtractMoney,
  compareExact,
  compareExactToMoney,
};
