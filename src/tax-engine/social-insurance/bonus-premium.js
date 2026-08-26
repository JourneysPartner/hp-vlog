'use strict';

const {
  inputMoney,
  masterMoney,
  masterRate,
  splitPremium,
  employerOnlyPremium,
  loadRateContext,
  healthCombinedRate,
  resultNotes,
  findOne,
  blocked,
  applyRounding,
} = require('./helpers.js');
const { moneyToExact, subtractMoney, addMoney } = require('../common/money.js');

function minMoney(left, right) {
  return left.value <= right.value ? left : right;
}

function floorAtZero(value) {
  return value.value < 0n ? inputMoney(0n, 'zero') : value;
}

function calculateBonusPremium(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input はオブジェクトで指定してください');
  }
  const context = loadRateContext(input);
  const bonusAmount = inputMoney(input.bonusAmount ?? input.paymentAmount, 'bonusAmount');
  if (bonusAmount.value < 0n) throw new RangeError('bonusAmount は0円以上で指定してください');
  const cumulativeBefore = inputMoney(
    input.healthInsuranceCumulativeBefore ??
      input.healthInsuranceBonusCumulativeBefore ??
      input.healthBonusCumulativeBefore,
    'healthInsuranceCumulativeBefore',
    0n
  );
  if (cumulativeBefore.value < 0n) {
    throw new RangeError('healthInsuranceCumulativeBefore は0円以上で指定してください');
  }

  const healthCapRecord = findOne('health_insurance_bonus_cap', context.onDate);
  const pensionCapRecord = findOne('employees_pension_bonus_cap', context.onDate);
  const blockedReasons = [...context.blockedReasons];
  if (!healthCapRecord) {
    blockedReasons.push(blocked('SI_HEALTH_BONUS_CAP_MISSING', '対象月の健康保険の賞与上限がマスターにありません'));
  }
  if (!pensionCapRecord) {
    blockedReasons.push(blocked('SI_PENSION_BONUS_CAP_MISSING', '対象月の厚生年金の賞与上限がマスターにありません'));
  }
  if (blockedReasons.length > 0) {
    return { status: 'blocked', blockedReasons, premiumMonth: context.premiumMonth, bonusAmount };
  }

  const beforeCap = applyRounding(moneyToExact(bonusAmount), healthCapRecord.rounding_rule_id);
  const healthCap = masterMoney(healthCapRecord.fixed_amount);
  const pensionCap = masterMoney(pensionCapRecord.fixed_amount);
  const healthRemaining = floorAtZero(subtractMoney(healthCap, cumulativeBefore));
  const healthStandardBonus = minMoney(beforeCap, healthRemaining);
  const pensionStandardBonus = minMoney(beforeCap, pensionCap);
  const combinedRate = healthCombinedRate(context);
  const healthInsurance = {
    ...splitPremium(healthStandardBonus, combinedRate),
    combinedRate,
    rateComponents: {
      healthInsurance: masterRate(context.healthRecord.rate),
      nursingCare: context.nursingCareRecord ? masterRate(context.nursingCareRecord.rate) : null,
      childRearingSupport: context.supportRecord ? masterRate(context.supportRecord.rate) : null,
    },
  };
  const employeesPension = {
    ...splitPremium(pensionStandardBonus, masterRate(context.pensionRecord.rate)),
    rate: masterRate(context.pensionRecord.rate),
  };
  const childSupportLevy = {
    // 拠出金の基礎は厚生年金側（1回150万円上限）の標準賞与額とする。
    ...employerOnlyPremium(pensionStandardBonus, masterRate(context.childLevyRecord.rate)),
    rate: masterRate(context.childLevyRecord.rate),
  };

  return {
    status: 'complete',
    blockedReasons: [],
    premiumMonth: context.premiumMonth,
    prefectureCode: context.prefectureCode,
    age: context.age,
    insurerType: context.insurerType,
    nursingCareApplicable: context.nursingCareApplicable,
    childRearingSupportApplicable: context.supportRecord !== null,
    bonusAmount,
    standardBonus: {
      beforeCap,
      healthInsurance: healthStandardBonus,
      employeesPension: pensionStandardBonus,
      healthInsuranceCumulativeBefore: cumulativeBefore,
      healthInsuranceCumulativeAfter: addMoney(cumulativeBefore, healthStandardBonus),
      healthInsuranceAnnualCap: healthCap,
      employeesPensionPerPaymentCap: pensionCap,
      roundingRuleId: healthCapRecord.rounding_rule_id,
    },
    healthInsurance,
    employeesPension,
    childSupportLevy,
    notes: resultNotes(),
  };
}

module.exports = {
  calculate: calculateBonusPremium,
  calculateBonusPremium,
};
