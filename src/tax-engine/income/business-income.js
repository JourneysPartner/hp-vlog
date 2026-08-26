'use strict';

/** 事業所得。青色申告特別控除は控除前所得を限度に充当する。 */

const masters = require('../masters/snapshot.js');
const {
  zeroMoney,
  inputMoney,
  masterMoney,
  minMoney,
  criterion,
  subtractMoney,
} = require('./helpers.js');

const BLUE_TIER_ALIASES = Object.freeze({
  e_tax_650k: '650k',
  bookkeeping_550k: '550k',
  simple_100k: '100k',
  '650k': '650k',
  '550k': '550k',
  '100k': '100k',
  none: null,
  white: null,
});

function requestedBlueTier(input) {
  const raw = input.blueReturnTier ?? input.specialDeductionCategory ??
    (input.blueReturn && input.blueReturn.specialDeductionCategory);
  if (raw === undefined || raw === null) return null;
  if (!Object.hasOwn(BLUE_TIER_ALIASES, raw)) throw new RangeError(`未知の青色申告区分です: ${raw}`);
  return BLUE_TIER_ALIASES[raw];
}

function calculateBusinessIncome(input, options = {}) {
  const revenue = inputMoney(input.revenue, 'business.revenue');
  const expenses = inputMoney(input.expenses, 'business.expenses');
  if (revenue.value < 0n || expenses.value < 0n) {
    throw new RangeError('事業収入・必要経費は0円以上で指定してください');
  }
  const incomeBeforeBlueDeduction = subtractMoney(revenue, expenses);
  if (incomeBeforeBlueDeduction.value < 0n) {
    return {
      status: 'blocked',
      blockedReasons: [{
        code: 'IT_BUSINESS_LOSS_OFFSET_UNSUPPORTED',
        message: '事業所得が負となるため、損益通算を扱えません',
      }],
      revenue,
      expenses,
      incomeBeforeBlueDeduction,
      blueReturnSpecialDeduction: zeroMoney(),
      businessIncome: incomeBeforeBlueDeduction,
    };
  }

  const tier = requestedBlueTier(input);
  let blueReturnSpecialDeduction = zeroMoney();
  if (tier !== null) {
    const records = masters.find('blue_return_special_deduction', criterion(options));
    const record = records.find(candidate => candidate.applicability_conditions.some(condition =>
      condition.subject === 'blue_return_tier' && condition.operator === 'eq' && condition.value === tier
    ));
    if (!record) throw new Error(`青色申告特別控除マスターに区分がありません: ${tier}`);
    blueReturnSpecialDeduction = minMoney(
      incomeBeforeBlueDeduction,
      masterMoney(record.deduction_amount)
    );
  }

  return {
    status: 'complete',
    blockedReasons: [],
    revenue,
    expenses,
    incomeBeforeBlueDeduction,
    blueReturnSpecialDeduction,
    businessIncome: subtractMoney(incomeBeforeBlueDeduction, blueReturnSpecialDeduction),
  };
}

module.exports = {
  calculate: calculateBusinessIncome,
  calculateBusinessIncome,
};
