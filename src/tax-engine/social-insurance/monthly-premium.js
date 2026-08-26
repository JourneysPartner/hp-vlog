'use strict';

const { determineStandardRemuneration } = require('./standard-remuneration.js');
const {
  masterRate,
  splitPremium,
  employerOnlyPremium,
  loadRateContext,
  healthCombinedRate,
  resultNotes,
} = require('./helpers.js');

function calculateMonthlyPremium(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input はオブジェクトで指定してください');
  }
  const context = loadRateContext(input);
  const remunerationInput = input.monthlyRemuneration ?? input.remuneration;
  const standard = determineStandardRemuneration(remunerationInput, { onDate: context.onDate });
  const blockedReasons = [...context.blockedReasons, ...standard.blockedReasons];
  if (blockedReasons.length > 0) {
    return {
      status: 'blocked',
      blockedReasons,
      premiumMonth: context.premiumMonth,
      standardRemuneration: standard,
    };
  }

  const combinedRate = healthCombinedRate(context);
  const healthInsurance = {
    ...splitPremium(standard.healthInsurance.standardRemuneration, combinedRate),
    combinedRate,
    rateComponents: {
      healthInsurance: masterRate(context.healthRecord.rate),
      nursingCare: context.nursingCareRecord ? masterRate(context.nursingCareRecord.rate) : null,
      childRearingSupport: context.supportRecord ? masterRate(context.supportRecord.rate) : null,
    },
  };
  const employeesPension = {
    ...splitPremium(
      standard.employeesPension.standardRemuneration,
      masterRate(context.pensionRecord.rate)
    ),
    rate: masterRate(context.pensionRecord.rate),
  };
  const childSupportLevy = {
    // 拠出金の基礎は厚生年金側の標準報酬月額とする。
    ...employerOnlyPremium(
      standard.employeesPension.standardRemuneration,
      masterRate(context.childLevyRecord.rate)
    ),
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
    standardRemuneration: standard,
    healthInsurance,
    employeesPension,
    childSupportLevy,
    notes: [...standard.notes, ...resultNotes()],
  };
}

module.exports = {
  calculate: calculateMonthlyPremium,
  calculateMonthlyPremium,
};
