'use strict';

/** 個人事業税（標準税率）の計算。 */

const masters = require('../masters/snapshot.js');
const {
  money,
  exact,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  subtractExact,
  compareExact,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');

const SUPPORTED_CATEGORIES = new Set([
  'type1', 'type2', 'type3_standard', 'type3_reduced', 'not_listed', 'unknown',
]);
const DEFAULT_MASTER_DATE = '2026-08-27';

function zeroMoney() {
  return money({ unit: 'JPY', value: 0n });
}

function inputMoney(value, fieldName) {
  if (typeof value === 'bigint') return money({ unit: 'JPY', value });
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (value && value.unit === 'JPY' && typeof value.value === 'string' && /^[0-9]+$/.test(value.value)) {
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

function one(records, label, predicate = () => true) {
  const matches = records.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label}の適用レコードを一意に決められません`);
  return matches[0];
}

function floorExactAtZero(value) {
  const zero = moneyToExact(zeroMoney());
  return compareExact(value, zero) < 0 ? zero : exact(value);
}

function readInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input はオブジェクトで指定してください');
  }
  const businessCategory = input.businessCategory ?? input.category ?? input.business_category;
  if (!SUPPORTED_CATEGORIES.has(businessCategory)) {
    throw new RangeError(`未知の業種区分です: ${businessCategory}`);
  }

  // 入口では、青色申告特別控除を引く前の個人事業税用所得かを呼出側で確認すること。
  // 所得税の事業所得（控除後）を渡すと課税標準が変わるため、そのまま流用してはいけない。
  const businessIncome = inputMoney(
    input.businessIncome ?? input.income ?? input.business_income,
    'businessIncome'
  );
  if (businessIncome.value < 0n) throw new RangeError('businessIncome は0円以上で指定してください');
  const businessMonths = input.businessMonths ?? input.months ?? input.business_months;
  if (!Number.isInteger(businessMonths) || businessMonths < 1 || businessMonths > 12) {
    throw new RangeError('businessMonths は1から12までの整数で指定してください');
  }
  return { businessCategory, businessIncome, businessMonths };
}

function calculateIndividualBusinessTax(input, options = {}) {
  const values = readInput(input);
  if (values.businessCategory === 'unknown') {
    return {
      status: 'blocked',
      blockedReasons: [{
        code: 'IBT_BUSINESS_CATEGORY_UNKNOWN',
        message: '業種が法定業種に該当するか判定できません。0円扱いにすると法人成りの損得が逆転しうるため計算を停止します',
      }],
      businessCategory: values.businessCategory,
    };
  }
  if (values.businessCategory === 'not_listed') {
    const zero = zeroMoney();
    return {
      status: 'complete',
      blockedReasons: [],
      businessCategory: values.businessCategory,
      businessIncome: values.businessIncome,
      businessMonths: values.businessMonths,
      taxableBase: zero,
      taxAmount: zero,
      amount: zero,
      notes: [{
        code: 'IBT_NOT_STATUTORY_BUSINESS',
        message: '法定業種外として選択されているため、個人事業税は課税されません',
      }, {
        code: 'IBT_MONTH_COUNT_ROUNDED_UP_INPUT',
        message: '事業月数は1月未満の端数を1月へ切り上げた後の月数を受け取る前提です',
      }],
    };
  }

  const criterion = { onDate: options.onDate ?? input.onDate ?? DEFAULT_MASTER_DATE };
  const ownerRecord = one(
    masters.find('individual_business_tax_owner_deduction', criterion),
    '個人事業税の事業主控除'
  );
  const annualOwnerDeduction = masterMoney(ownerRecord.deduction_amount);
  const ownerDeductionBeforeRounding = multiplyRateByMoney(
    rate({ num: BigInt(values.businessMonths), den: 12n }), annualOwnerDeduction
  );
  const ownerDeductionRounded = applyRounding(ownerDeductionBeforeRounding, 'R-TRUNC-1-YEN');
  // ownerDeduction は既存 API の Exact 契約を維持する。端数処理後なので分母は常に 1。
  const ownerDeduction = moneyToExact(ownerDeductionRounded);

  const rateRecord = one(
    masters.find('individual_business_tax_rate', criterion),
    `個人事業税率 ${values.businessCategory}`,
    record => record.business_category === values.businessCategory
  );
  const taxableBaseBeforeRounding = floorExactAtZero(subtractExact(
    moneyToExact(values.businessIncome), ownerDeduction
  ));
  const taxableBase = applyRounding(taxableBaseBeforeRounding, rateRecord.rounding_rule_id);
  const taxAmount = applyRounding(
    multiplyRateByMoney(masterRate(rateRecord.rate), taxableBase),
    'R-TRUNC-100-LOCAL-TAX'
  );
  return {
    status: 'complete',
    blockedReasons: [],
    businessCategory: values.businessCategory,
    businessCategoryLabel: rateRecord.business_category_label,
    businessIncome: values.businessIncome,
    businessMonths: values.businessMonths,
    annualOwnerDeduction,
    ownerDeductionBeforeRounding,
    ownerDeduction,
    ownerDeductionRounded,
    taxableBaseBeforeRounding,
    taxableBase,
    rate: masterRate(rateRecord.rate),
    taxAmount,
    amount: taxAmount,
    notes: [{
      code: 'IBT_INCOME_BEFORE_BLUE_RETURN_DEDUCTION',
      message: '事業の所得は青色申告特別控除を引く前の個人事業税用所得を使う前提です',
    }, {
      code: 'IBT_MONTH_COUNT_ROUNDED_UP_INPUT',
      message: '事業月数は1月未満の端数を1月へ切り上げた後の月数を受け取る前提です',
    }],
  };
}

module.exports = {
  calculate: calculateIndividualBusinessTax,
  calculateIndividualBusinessTax,
};
