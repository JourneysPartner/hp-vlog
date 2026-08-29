'use strict';

const YEAR_PERIOD = Object.freeze({ from: '2025-01-01', to: '2025-12-31' });

class HojinnariInputBuildError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('\n'));
    this.name = 'HojinnariInputBuildError';
    this.errors = Object.freeze(errors.map(item => Object.freeze({ ...item })));
    this.code = this.errors[0] && this.errors[0].code;
  }
}

function issue(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function money(value, fieldPath, errors) {
  const text = typeof value === 'bigint' ? value.toString(10) : String(value ?? '');
  if (!/^\d+$/.test(text)) {
    errors.push(issue('HJ_UI_MONEY_REQUIRED', fieldPath, '金額を円単位で入力してください'));
    return { unit: 'JPY', value: '0' };
  }
  return { unit: 'JPY', value: text };
}

function segment(value, period, fieldPath, errors) {
  return { period: { ...period }, value: money(value, fieldPath, errors) };
}

function blueReturn(value) {
  if (value === 'white') return { status: 'white' };
  if (value === 'unknown' || value === undefined || value === '') return { status: 'unknown' };
  const allowed = ['e_tax_650k', 'bookkeeping_550k', 'simple_100k', 'none'];
  return allowed.includes(value)
    ? { status: 'blue', specialDeductionCategory: value }
    : { status: 'unknown' };
}

function nationalHealthInsurance(formState, errors) {
  const kind = formState.nationalHealthInsuranceKind;
  if (formState.municipalityKey === 'other' && kind !== 'actual') {
    errors.push(issue(
      'HJ_UI_NHI_ACTUAL_REQUIRED_FOR_OTHER_MUNICIPALITY',
      '$.individual.nationalHealthInsurance',
      'お住まいの自治体の料率は未登録のため、実際の年間保険料の入力をお願いします'
    ));
  }
  if (kind === 'actual') {
    return {
      kind: 'actual',
      annualAmount: money(formState.nationalHealthInsuranceActual,
        '$.individual.nationalHealthInsurance.annualAmount.value', errors),
    };
  }
  if (kind === 'estimate' || kind === 'estimate_accepted') return { kind: 'estimate_accepted' };
  return { kind: 'unknown' };
}

function nationalPension(formState, errors) {
  if (formState.nationalPensionKind === 'actual') {
    return {
      kind: 'actual',
      annualAmount: money(formState.nationalPensionActual,
        '$.individual.nationalPension.annualAmount.value', errors),
    };
  }
  if (formState.nationalPensionKind === 'standard') return { kind: 'standard', months: 12 };
  if (formState.nationalPensionKind === 'exempted') return { kind: 'exempted' };
  return { kind: 'unknown' };
}

function buildHojinnariInput(formState, context) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  if (!context || !context.fiscalPeriod || !context.jurisdiction) {
    throw new TypeError('CalculationContextが必要です');
  }
  const errors = [];
  if (formState.expensesConfirmed !== true &&
      formState.expensesExcludeSocialInsuranceAndMutualAid !== 'yes') {
    errors.push(issue(
      'HJ_EXPENSES_EXCLUSION_CONFIRMATION_REQUIRED',
      '$.individual.business.expensesExcludeSocialInsuranceAndMutualAid',
      '経費に国民健康保険料・国民年金・小規模企業共済等の掛金を含めていないことを確認してください'
    ));
  }

  const individualRevenue = formState.revenue;
  const individualExpenses = formState.expenses;
  const corporateSame = formState.corporateSameAsIndividual !== false;
  const corporateRevenue = corporateSame ? individualRevenue : formState.corporateRevenue;
  const corporateExpenses = corporateSame ? individualExpenses : formState.corporateExpenses;
  const age = Number(formState.ageAtYearEnd);
  if (!Number.isInteger(age) || age < 0) {
    errors.push(issue('HJ_SELF_AGE_REQUIRED', '$.individual.self.ageAtYearEnd',
      '年末時点の年齢を整数で入力してください'));
  }

  const input = {
    precision: 'simple',
    comparisonBasis: 'steady_state',
    individual: {
      business: {
        revenue: [segment(individualRevenue, YEAR_PERIOD,
          '$.individual.business.revenue[0].value.value', errors)],
        expenses: [segment(individualExpenses, YEAR_PERIOD,
          '$.individual.business.expenses[0].value.value', errors)],
        periodFacts: {},
        expensesExcludeSocialInsuranceAndMutualAid: formState.expensesConfirmed === true ||
          formState.expensesExcludeSocialInsuranceAndMutualAid === 'yes' ? 'yes' : 'no',
        businessTaxCategory: formState.businessTaxCategory,
      },
      blueReturn: blueReturn(formState.blueReturn),
      self: { ageAtYearEnd: Number.isInteger(age) ? age : 0, disability: 'none' },
      residentTaxBasis: 'steady_state',
      nationalHealthInsurance: nationalHealthInsurance(formState, errors),
      nationalPension: nationalPension(formState, errors),
    },
    corporate: {
      locationSameAsResidence: formState.locationSameAsResidence,
      capital: money(formState.capital, '$.corporate.capital.value', errors),
      employeeCount: 0,
      spouseOfficer: { isOfficer: false },
      officerCompensation: {
        monthlySegments: [{
          period: { ...context.fiscalPeriod },
          value: {
            monthlyAmount: money(formState.officerCompensationMonthly,
              '$.corporate.officerCompensation.monthlySegments[0].value.monthlyAmount.value', errors),
          },
        }],
      },
      healthInsurer: {
        kind: 'kyokai_kenpo',
        prefectureCode: context.jurisdiction.prefectureCode,
      },
      revenue: [segment(corporateRevenue, context.fiscalPeriod,
        '$.corporate.revenue[0].value.value', errors)],
      expenses: [segment(corporateExpenses, context.fiscalPeriod,
        '$.corporate.expenses[0].value.value', errors)],
    },
    consumptionTax: { include: false },
    specialistChecks: {},
  };

  if (errors.length > 0) throw new HojinnariInputBuildError(errors);
  return input;
}

module.exports = Object.freeze({
  HojinnariInputBuildError,
  buildHojinnariInput,
});
