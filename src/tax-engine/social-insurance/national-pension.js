'use strict';

/** 国民年金保険料（第1号被保険者）の定額計算。 */

const masters = require('../masters/snapshot.js');
const {
  money,
  rate,
  multiplyRateByMoney,
  addMoney,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');

function zeroMoney() {
  return money({ unit: 'JPY', value: 0n });
}

function masterMoney(value) {
  return money({ unit: value.unit, value: BigInt(value.value) });
}

function oneOrNull(records, label) {
  if (records.length > 1) throw new Error(`${label}の適用レコードが重複しています`);
  return records[0] || null;
}

function optionIsRequested(value) {
  return value !== undefined && value !== null && value !== false &&
    value !== 'none' && value !== 'no';
}

function unsupportedReasons(input) {
  const reasons = [];
  if (optionIsRequested(input.prepaymentDiscount ?? input.prepayment)) {
    reasons.push({
      code: 'NP_PREPAYMENT_DISCOUNT_UNSUPPORTED',
      message: '前納割引は第1版の対象外です',
    });
  }
  if (optionIsRequested(input.exemption ?? input.premiumExemption)) {
    reasons.push({ code: 'NP_EXEMPTION_UNSUPPORTED', message: '保険料免除は第1版の対象外です' });
  }
  if (optionIsRequested(input.deferral ?? input.paymentDeferral)) {
    reasons.push({ code: 'NP_DEFERRAL_UNSUPPORTED', message: '納付猶予は第1版の対象外です' });
  }
  return reasons;
}

function multiplyMonthlyPremium(monthlyPremium, months, roundingRuleId) {
  return applyRounding(
    multiplyRateByMoney(rate({ num: BigInt(months), den: 1n }), monthlyPremium),
    roundingRuleId
  );
}

function calculateNationalPension(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input はオブジェクトで指定してください');
  }
  const taxYear = input.taxYear ?? input.fiscalYear ?? input.year;
  if (!Number.isInteger(taxYear) || taxYear < 1 || taxYear > 9999) {
    throw new RangeError('taxYear は1から9999までの整数で指定してください');
  }
  const paymentMonths = input.paymentMonths ?? input.months ?? input.payment_months ?? 12;
  if (!Number.isInteger(paymentMonths) || paymentMonths < 0 || paymentMonths > 12) {
    throw new RangeError('paymentMonths は0から12までの整数で指定してください');
  }
  const includeAdditionalPremium = input.includeAdditionalPremium ??
    input.additionalPremium ?? input.include_additional_premium ?? false;
  if (typeof includeAdditionalPremium !== 'boolean') {
    throw new TypeError('includeAdditionalPremium はbooleanで指定してください');
  }

  const blockedReasons = unsupportedReasons(input);
  if (blockedReasons.length > 0) {
    return { status: 'blocked', blockedReasons, taxYear, paymentMonths };
  }

  // 「年度」は4月始まりなので、暦年検索ではなく年度初日時点のレコードを選ぶ。
  const criterion = { onDate: `${String(taxYear).padStart(4, '0')}-04-01` };
  const premiumRecord = oneOrNull(
    masters.find('national_pension_monthly_premium', criterion),
    '国民年金月額保険料'
  );
  const additionalRecord = includeAdditionalPremium
    ? oneOrNull(
      masters.find('national_pension_additional_premium', criterion),
      '国民年金付加保険料'
    )
    : null;
  const missing = [];
  if (!premiumRecord) {
    missing.push({
      code: 'NP_MONTHLY_PREMIUM_MISSING',
      message: '対象年度の国民年金月額保険料がマスターにありません',
    });
  }
  if (includeAdditionalPremium && !additionalRecord) {
    missing.push({
      code: 'NP_ADDITIONAL_PREMIUM_MISSING',
      message: '対象年度の国民年金付加保険料がマスターにありません',
    });
  }
  if (missing.length > 0) return { status: 'blocked', blockedReasons: missing, taxYear, paymentMonths };

  const monthlyPremium = masterMoney(premiumRecord.fixed_amount);
  const basePremium = multiplyMonthlyPremium(
    monthlyPremium, paymentMonths, premiumRecord.rounding_rule_id
  );
  const additionalMonthlyPremium = additionalRecord
    ? masterMoney(additionalRecord.fixed_amount)
    : zeroMoney();
  const additionalPremium = additionalRecord
    ? multiplyMonthlyPremium(
      additionalMonthlyPremium, paymentMonths, additionalRecord.rounding_rule_id
    )
    : zeroMoney();
  const totalPremium = addMoney(basePremium, additionalPremium);
  return {
    status: 'complete',
    blockedReasons: [],
    taxYear,
    paymentMonths,
    includeAdditionalPremium,
    monthlyPremium,
    basePremium,
    additionalMonthlyPremium,
    additionalPremium,
    totalPremium,
    annualPremium: totalPremium,
  };
}

module.exports = {
  calculate: calculateNationalPension,
  calculateNationalPension,
};
