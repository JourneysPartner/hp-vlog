'use strict';

const LIFE_INSURANCE_FIELDS = Object.freeze([
  Object.freeze({ key: 'lifeInsuranceNewLife', generation: 'new', category: 'life' }),
  Object.freeze({ key: 'lifeInsuranceNewNursingMedical', generation: 'new', category: 'nursing_medical' }),
  Object.freeze({ key: 'lifeInsuranceNewAnnuity', generation: 'new', category: 'annuity' }),
  Object.freeze({ key: 'lifeInsuranceOldLife', generation: 'old', category: 'life' }),
  Object.freeze({ key: 'lifeInsuranceOldAnnuity', generation: 'old', category: 'annuity' }),
]);

const EARTHQUAKE_INSURANCE_FIELDS = Object.freeze([
  Object.freeze({ key: 'earthquakeInsurancePremium', category: 'earthquake' }),
  Object.freeze({ key: 'oldLongTermInsurancePremium', category: 'old_long_term' }),
]);

function appendPhase2Deductions(target, formState, money, errors, basePath) {
  target.deductions.lifeInsurance = LIFE_INSURANCE_FIELDS.map((field, index) => ({
    generation: field.generation,
    category: field.category,
    annualPremium: money(
      formState[field.key] ?? '0',
      `${basePath}.deductions.lifeInsurance[${index}].annualPremium.value`,
      errors
    ),
  }));
  target.deductions.earthquakeInsurance = EARTHQUAKE_INSURANCE_FIELDS.map((field, index) => ({
    category: field.category,
    annualPremium: money(
      formState[field.key] ?? '0',
      `${basePath}.deductions.earthquakeInsurance[${index}].annualPremium.value`,
      errors
    ),
  }));
  target.deductions.donations = [{
    kind: 'furusato',
    amount: money(
      formState.furusatoDonation ?? '0',
      `${basePath}.deductions.donations[0].amount.value`,
      errors
    ),
  }];
  target.taxCredits = {
    housingLoan: money(
      formState.housingLoanCredit ?? '0',
      `${basePath}.taxCredits.housingLoan.value`,
      errors
    ),
  };
  return target;
}

module.exports = Object.freeze({
  LIFE_INSURANCE_FIELDS,
  EARTHQUAKE_INSURANCE_FIELDS,
  appendPhase2Deductions,
});
