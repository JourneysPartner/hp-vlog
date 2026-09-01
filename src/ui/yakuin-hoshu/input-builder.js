'use strict';

const { appendFamilyFacts } = require('../family-input.js');

class YakuinHoshuInputBuildError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('\n'));
    this.name = 'YakuinHoshuInputBuildError';
    this.errors = Object.freeze(errors.map(item => Object.freeze({ ...item })));
    this.code = this.errors[0] && this.errors[0].code;
  }
}

const MODES = Object.freeze(['A', 'B', 'C']);
const SEARCH_STEPS = Object.freeze(['10000', '50000']);
const CRITERIA = Object.freeze([
  'min_burden',
  'max_total_retained',
  'max_corporate_with_floor',
]);

function issue(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function money(value, fieldPath, errors) {
  const text = typeof value === 'bigint' ? value.toString(10) : String(value ?? '');
  if (!/^\d+$/.test(text)) {
    errors.push(issue('YH_UI_MONEY_REQUIRED', fieldPath, '金額を円単位の整数で入力してください'));
    return { unit: 'JPY', value: '0' };
  }
  return { unit: 'JPY', value: text };
}

function requireEnum(value, allowed, fieldPath, label, errors) {
  if (!allowed.includes(value)) {
    errors.push(issue('YH_UI_SELECTION_REQUIRED', fieldPath, `${label}を選択してください`));
  }
}

function commonInput(formState, context, errors) {
  const age = Number(formState.ageAtYearEnd);
  if (!Number.isInteger(age) || age < 0) {
    errors.push(issue('YH_UI_AGE_REQUIRED', '$.officer.ageAtYearEnd',
      '役員の年齢を0以上の整数で入力してください'));
  }
  const input = {
    precision: 'detailed',
    officerResidenceSameAsCompany: 'yes',
    capital: money(formState.capital, '$.capital.value', errors),
    employeeCount: 0,
    healthInsurer: {
      kind: 'kyokai_kenpo',
      prefectureCode: context.jurisdiction.prefectureCode,
    },
    officer: { ageAtYearEnd: Number.isInteger(age) ? age : 0 },
    specialistChecks: {},
    appointedOn: context.fiscalPeriod.from,
    standardRemunerationDecisionKind: 'regular',
  };
  return appendFamilyFacts(input, formState, {
    money,
    errors,
    issue,
    spousePath: '$.spouse',
    dependentsPath: '$.dependents',
    codePrefix: 'YH_UI',
  });
}

function buildModeA(formState, errors) {
  requireEnum(formState.searchStep, SEARCH_STEPS, '$.searchStep', '探索の刻み', errors);
  requireEnum(formState.optimizationCriterion, CRITERIA,
    '$.optimizationCriterion', '最適化基準', errors);
  const input = {
    profitBeforeOfficerCompensation: money(formState.profitBeforeOfficerCompensation,
      '$.profitBeforeOfficerCompensation.value', errors),
    // サービスと入力スキーマが探索下限として受ける第1版のフィールド。
    previousMonthlyAmount: money(formState.searchLowerBound,
      '$.previousMonthlyAmount.value', errors),
    searchUpperBound: money(formState.searchUpperBound,
      '$.searchUpperBound.value', errors),
    searchStep: formState.searchStep,
    optimizationCriterion: formState.optimizationCriterion,
  };
  if (formState.optimizationCriterion === 'max_corporate_with_floor') {
    input.constraints = {
      // 名前は年額にも読めるが、④サービスの契約どおりUIの月額値を変換せず渡す。
      minPersonalNetIncome: money(formState.minPersonalNetIncome,
        '$.constraints.minPersonalNetIncome.value', errors),
      minCorporateRetained: money(formState.minCorporateRetained,
        '$.constraints.minCorporateRetained.value', errors),
    };
  }
  return input;
}

function buildModeB(formState, errors) {
  requireEnum(formState.searchStep, SEARCH_STEPS, '$.searchStep', '探索の刻み', errors);
  return {
    desiredMonthlyNetIncome: money(formState.desiredMonthlyNetIncome,
      '$.desiredMonthlyNetIncome.value', errors),
    searchStep: formState.searchStep,
    profitBeforeOfficerCompensation: money(formState.profitBeforeOfficerCompensation,
      '$.profitBeforeOfficerCompensation.value', errors),
  };
}

function buildModeC(formState, context, errors) {
  return {
    profitBeforeOfficerCompensation: money(formState.profitBeforeOfficerCompensation,
      '$.profitBeforeOfficerCompensation.value', errors),
    plan: {
      monthlySegments: [{
        period: { ...context.fiscalPeriod },
        value: {
          monthlyAmount: money(formState.monthlyCompensation,
            '$.plan.monthlySegments[0].value.monthlyAmount.value', errors),
        },
      }],
    },
  };
}

function buildYakuinHoshuInput(formState, context) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  if (!context || !context.fiscalPeriod || !context.jurisdiction) {
    throw new TypeError('CalculationContextが必要です');
  }
  const errors = [];
  requireEnum(formState.mode, MODES, '$.mode', '計算モード', errors);
  const input = {
    mode: formState.mode,
    ...commonInput(formState, context, errors),
  };
  if (formState.mode === 'A') Object.assign(input, buildModeA(formState, errors));
  if (formState.mode === 'B') Object.assign(input, buildModeB(formState, errors));
  if (formState.mode === 'C') Object.assign(input, buildModeC(formState, context, errors));
  if (errors.length > 0) throw new YakuinHoshuInputBuildError(errors);
  return input;
}

module.exports = Object.freeze({
  MODES,
  SEARCH_STEPS,
  CRITERIA,
  YakuinHoshuInputBuildError,
  buildYakuinHoshuInput,
});
