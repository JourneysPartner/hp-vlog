'use strict';

/**
 * 法人成りシミュレーター第1版。
 * 税額の算式は持たず、個人向け税・保険エンジンと役員報酬サービスを合成する。
 */

const { validateInput } = require('../core/validator.js');
const { buildSimulationResult } = require('../core/result-builder.js');
const yakuinHoshu = require('../yakuin-hoshu/service.js');
const shohizei = require('../shohizei/service.js');
const income = require('../../tax-engine/income/index.js');
const residentTax = require('../../tax-engine/resident-tax/index.js');
const individualBusinessTax = require('../../tax-engine/business-tax/individual-business-tax.js');
const socialInsurance = require('../../tax-engine/social-insurance/index.js');
const snapshot = require('../../tax-engine/masters/snapshot.js');
const {
  money,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  multiplyRateByExact,
  addExact,
  addMoney,
  compareExactToMoney,
} = require('../../tax-engine/common/money.js');
const { masterRate } = require('../../tax-engine/income/helpers.js');

const MONTHS_IN_YEAR = 12;
const SUPPORTED_DEDUCTION_KEYS = new Set([
  'smallEnterpriseMutualAid',
  'lifeInsurance',
  'earthquakeInsurance',
  'donations',
]);
const CONSUMPTION_TAX_METHOD_LABELS = Object.freeze({
  general: '一般課税',
  simplified: '簡易課税',
  twenty_percent_special: '2割特例',
  thirty_percent_special: '3割特例',
});

function yen(value) {
  return money({ unit: 'JPY', value: BigInt(value) });
}

function zeroMoney() {
  return yen(0n);
}

function sumMoney(values) {
  return values.reduce((total, value) => addMoney(total, value), zeroMoney());
}

function subtractMoneyValues(left, ...rights) {
  return yen(rights.reduce((value, right) => value - right.value, left.value));
}

function uniqueMessages(items) {
  return [...new Set((items || []).map(item => typeof item === 'string' ? item : item.message)
    .filter(message => typeof message === 'string' && message.length > 0))];
}

function uniqueWarnings(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = `${item.code}\u0000${item.fieldPath || ''}\u0000${item.message || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertSnapshotMatch(context, masters) {
  if (!context || !masters || context.masterSnapshotId !== masters.snapshotId ||
      context.masterSnapshotHash !== masters.snapshotHash) {
    throw new Error('マスタースナップショットと計算コンテキストが一致しません');
  }
}

function incomeYearFrom(context) {
  const year = context.incomeTaxYear ?? context.incomeYear ?? context.taxYear;
  if (!Number.isInteger(year)) {
    throw new TypeError('context.incomeTaxYear、incomeYear または taxYear が必要です');
  }
  return year;
}

function fiscalPeriodFrom(context) {
  if (!context.fiscalPeriod || !context.fiscalPeriod.from || !context.fiscalPeriod.to) {
    throw new TypeError('context.fiscalPeriod が必要です');
  }
  return context.fiscalPeriod;
}

function deriveIndividualConsumptionTaxContext(context) {
  return {
    ...context,
    consumptionTaxPeriod: calendarYearPeriod(incomeYearFrom(context)),
  };
}

function deriveCorporateConsumptionTaxContext(context) {
  return {
    ...context,
    consumptionTaxPeriod: fiscalPeriodFrom(context),
  };
}

function blockedReason(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function hasEntries(value) {
  return value && typeof value === 'object' && Object.keys(value).length > 0;
}

function hasUnsupportedDeductions(value) {
  if (!hasEntries(value)) return false;
  if (Object.keys(value).some(key => !SUPPORTED_DEDUCTION_KEYS.has(key))) return true;
  return (value.donations || []).some(item => item.kind !== 'furusato');
}

function hasUnsupportedTaxCredits(value) {
  if (!hasEntries(value)) return false;
  return Object.keys(value).some(key => key !== 'housingLoan') ||
    (Array.isArray(value.other) && value.other.length > 0);
}

function hasUnsupportedCorporateDeductions(value) {
  return hasEntries(value) && Object.keys(value).some(key => key !== 'smallEnterpriseMutualAid');
}

function isOneSegmentFor(segments, period) {
  return Array.isArray(segments) && segments.length === 1 && segments[0].period &&
    segments[0].period.from === period.from && segments[0].period.to === period.to;
}

function calendarYearPeriod(year) {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function isTwelveMonthPeriod(period) {
  const match = period && /^(\d{4})-(\d{2})-(\d{2})$/.exec(period.from || '');
  if (!match || typeof period.to !== 'string') return false;
  const nextYear = new Date(Date.UTC(Number(match[1]) + 1, Number(match[2]) - 1, Number(match[3])));
  nextYear.setUTCDate(nextYear.getUTCDate() - 1);
  return period.to === nextYear.toISOString().slice(0, 10);
}

function translatePlanReasons(reasons) {
  return reasons.map(reason => ({ ...reason, code: reason.code.replace(/^YH_/, 'HJ_') }));
}

function supportedProfileReasons(input, context) {
  const reasons = [];
  const individual = input.individual || {};
  const business = individual.business || {};
  const corporate = input.corporate || {};
  const incomeYear = incomeYearFrom(context);
  const calendarPeriod = calendarYearPeriod(incomeYear);
  const fiscalPeriod = fiscalPeriodFrom(context);

  if (input.comparisonBasis === 'transition_year') {
    reasons.push(blockedReason('HJ_TRANSITION_YEAR_UNSUPPORTED', '$.comparisonBasis',
      '第1版は平年度比較だけに対応しています'));
  }
  if (individual.residentTaxBasis === 'actual_year') {
    reasons.push(blockedReason('HJ_ACTUAL_RESIDENT_TAX_BASIS_UNSUPPORTED',
      '$.individual.residentTaxBasis', '第1版は住民税の平年度比較だけに対応しています'));
  }
  if (!isTwelveMonthPeriod(fiscalPeriod)) {
    reasons.push(blockedReason('HJ_CORPORATE_TWELVE_MONTH_PERIOD_REQUIRED',
      '$.calculationContext.fiscalPeriod', '第1版は12か月の法人事業年度だけに対応しています'));
  }
  if (!isOneSegmentFor(business.revenue, calendarPeriod)) {
    reasons.push(blockedReason('HJ_INDIVIDUAL_REVENUE_FULL_YEAR_REQUIRED',
      '$.individual.business.revenue',
      `${incomeYear}年の暦年全体を覆う売上1セグメントを入力してください`));
  }
  if (!isOneSegmentFor(business.expenses, calendarPeriod)) {
    reasons.push(blockedReason('HJ_INDIVIDUAL_EXPENSES_FULL_YEAR_REQUIRED',
      '$.individual.business.expenses',
      `${incomeYear}年の暦年全体を覆う経費1セグメントを入力してください`));
  }
  if (business.periodFacts &&
      (business.periodFacts.openedOn !== undefined || business.periodFacts.closedOn !== undefined)) {
    reasons.push(blockedReason('HJ_BUSINESS_OPEN_CLOSE_DATE_UNSUPPORTED',
      '$.individual.business.periodFacts', '第1版は開廃業のない通年営業だけに対応しています'));
  }
  if (business.expensesExcludeSocialInsuranceAndMutualAid !== 'yes') {
    reasons.push(blockedReason('HJ_EXPENSES_EXCLUSION_CONFIRMATION_REQUIRED',
      '$.individual.business.expensesExcludeSocialInsuranceAndMutualAid',
      '国保・国民年金・共済掛金を必要経費と所得控除へ二重計上しないため、経費に含まないことを確認してください'));
  }
  if (!individual.blueReturn || individual.blueReturn.status === 'unknown') {
    reasons.push(blockedReason('HJ_BLUE_RETURN_STATUS_UNKNOWN', '$.individual.blueReturn.status',
      '青色申告か白色申告かを選択してください'));
  } else if (individual.blueReturn.status === 'blue' &&
      individual.blueReturn.specialDeductionCategory === undefined) {
    reasons.push(blockedReason('HJ_BLUE_RETURN_DEDUCTION_CATEGORY_REQUIRED',
      '$.individual.blueReturn.specialDeductionCategory',
      '要件を確認せず最大額を適用しないため、青色申告特別控除の区分を選択してください'));
  }
  if (business.businessTaxCategory === undefined) {
    reasons.push(blockedReason('HJ_BUSINESS_TAX_CATEGORY_REQUIRED',
      '$.individual.business.businessTaxCategory', '個人事業税の業種区分を選択してください'));
  } else if (business.businessTaxCategory === 'unknown') {
    reasons.push(blockedReason('HJ_BUSINESS_TAX_CATEGORY_UNKNOWN',
      '$.individual.business.businessTaxCategory',
      '個人事業税を0円扱いにすると比較が歪むため、法定業種の区分を確認してください'));
  }
  if (!individual.nationalHealthInsurance ||
      individual.nationalHealthInsurance.kind === 'unknown') {
    reasons.push(blockedReason('HJ_NHI_SELECTION_REQUIRED',
      '$.individual.nationalHealthInsurance', '国民健康保険料を実額にするか概算にするか選択してください'));
  }
  if (!individual.nationalPension || individual.nationalPension.kind === 'unknown') {
    reasons.push(blockedReason('HJ_NATIONAL_PENSION_SELECTION_REQUIRED',
      '$.individual.nationalPension', '国民年金保険料の実額・標準額・免除のいずれかを選択してください'));
  } else if (individual.nationalPension.kind === 'standard' &&
      individual.nationalPension.months !== MONTHS_IN_YEAR) {
    reasons.push(blockedReason('HJ_NATIONAL_PENSION_FULL_YEAR_REQUIRED',
      '$.individual.nationalPension.months', '第1版の標準保険料計算は12か月分だけに対応しています'));
  }

  const comparisonDistortion =
    '法人化側と個人事業側の両方へ同じ条件を反映できず比較が歪むため、第1版では計算できません';
  if (Array.isArray(individual.otherIncomes) && individual.otherIncomes.length > 0) {
    reasons.push(blockedReason('HJ_OTHER_INCOMES_UNSUPPORTED', '$.individual.otherIncomes',
      comparisonDistortion));
  }
  if (hasUnsupportedDeductions(individual.deductions)) {
    reasons.push(blockedReason('HJ_DEDUCTIONS_UNSUPPORTED', '$.individual.deductions',
      comparisonDistortion));
  }
  if (hasUnsupportedTaxCredits(individual.taxCredits)) {
    reasons.push(blockedReason('HJ_TAX_CREDITS_UNSUPPORTED', '$.individual.taxCredits',
      comparisonDistortion));
  }
  if (!individual.self || !Number.isInteger(individual.self.ageAtYearEnd)) {
    reasons.push(blockedReason('HJ_SELF_AGE_REQUIRED', '$.individual.self.ageAtYearEnd',
      '税・社会保険の計算には本人の年末年齢が必要です'));
  }
  if (individual.self && individual.self.isNonResident === true) {
    reasons.push(blockedReason('HJ_NON_RESIDENT_UNSUPPORTED', '$.individual.self.isNonResident',
      '非居住者は第1版の対象外です'));
  }

  if (!isOneSegmentFor(corporate.revenue, fiscalPeriod)) {
    reasons.push(blockedReason('HJ_CORPORATE_REVENUE_FULL_PERIOD_REQUIRED',
      '$.corporate.revenue', '法人事業年度全体を覆う売上1セグメントを入力してください'));
  }
  if (!isOneSegmentFor(corporate.expenses, fiscalPeriod)) {
    reasons.push(blockedReason('HJ_CORPORATE_EXPENSES_FULL_PERIOD_REQUIRED',
      '$.corporate.expenses', '法人事業年度全体を覆う経費1セグメントを入力してください'));
  }
  if ((corporate.employeeCount ?? 0) > 0) {
    reasons.push(blockedReason('HJ_EMPLOYEES_UNSUPPORTED', '$.corporate.employeeCount',
      '従業員がいる法人は第1版の対象外です'));
  }
  if (hasUnsupportedCorporateDeductions(corporate.deductions)) {
    reasons.push(blockedReason('HJ_DEDUCTIONS_UNSUPPORTED', '$.corporate.deductions',
      comparisonDistortion));
  }
  if (corporate.spouseOfficer && corporate.spouseOfficer.isOfficer === true) {
    reasons.push(blockedReason('HJ_SPOUSE_OFFICER_UNSUPPORTED', '$.corporate.spouseOfficer',
      '配偶者役員がいる法人は第1版の対象外です'));
  }
  if (!corporate.healthInsurer || corporate.healthInsurer.kind !== 'kyokai_kenpo') {
    reasons.push(blockedReason('HJ_HEALTH_INSURER_UNSUPPORTED', '$.corporate.healthInsurer',
      '第1版は協会けんぽだけに対応しています'));
  }
  reasons.push(...translatePlanReasons(
    yakuinHoshu.planReasons(corporate.officerCompensation, context,
      '$.corporate.officerCompensation')
  ));
  if (corporate.lossCarryforward && Array.isArray(corporate.lossCarryforward.losses) &&
      corporate.lossCarryforward.losses.length > 0) {
    reasons.push(blockedReason('HJ_LOSS_CARRYFORWARD_UNSUPPORTED',
      '$.corporate.lossCarryforward.losses', '繰越欠損金がある法人は第1版の対象外です'));
  }
  const adjustmentItems = corporate.taxAdjustments && corporate.taxAdjustments.items;
  if (Array.isArray(adjustmentItems) && adjustmentItems.some(item =>
    item.applies === 'yes' || item.applies === 'unknown')) {
    reasons.push(blockedReason('HJ_TAX_ADJUSTMENTS_UNSUPPORTED',
      '$.corporate.taxAdjustments.items',
      '申告調整の適用あり・未確認の項目がある場合は第1版では計算できません'));
  }
  for (const [key, value] of Object.entries(input.specialistChecks || {})) {
    if (value === 'yes') {
      reasons.push(blockedReason('HJ_SPECIALIST_PROFILE_UNSUPPORTED',
        `$.specialistChecks.${key}`, '該当する専門確認項目は第1版の対象外です'));
    }
  }
  return reasons;
}

function engineBlockedReasons(result, prefix, fieldPath) {
  if (!result || result.status !== 'blocked') return [];
  return (result.blockedReasons || []).map(reason => ({
    code: reason.code && reason.code.startsWith('HJ_')
      ? reason.code
      : `HJ_${prefix}_${reason.code || 'BLOCKED'}`,
    fieldPath,
    message: reason.message || `${prefix}の計算を完了できませんでした`,
  }));
}

function blueReturnTier(blueReturn) {
  return blueReturn.status === 'white' ? 'white' : blueReturn.specialDeductionCategory;
}

function calculateNationalHealthInsurance(individual, context) {
  const selection = individual.nationalHealthInsurance;
  if (selection.kind === 'actual') {
    return {
      status: 'complete',
      annualPremium: selection.annualAmount,
      assumptions: ['国民健康保険料は入力された年間実額を使用しています。'],
      warnings: [],
    };
  }
  const business = individual.business;
  const preliminaryIncome = income.business.calculate({
    revenue: business.revenue[0].value,
    expenses: business.expenses[0].value,
    blueReturnTier: blueReturnTier(individual.blueReturn),
  }, { taxYear: incomeYearFrom(context) });
  if (preliminaryIncome.status === 'blocked') return preliminaryIncome;
  const fiscalYear = incomeYearFrom(context) + 1;
  const result = socialInsurance.calculateNhiPremium({
    municipalityCode: context.jurisdiction && context.jurisdiction.municipalityCode,
    taxYear: fiscalYear,
    previousYearTotalIncome: preliminaryIncome.businessIncome,
    insuredAges: [individual.self.ageAtYearEnd],
  });
  return {
    ...result,
    assumptions: [
      `平年度では${incomeYearFrom(context)}年分の所得に基づく${fiscalYear}年度賦課額として国民健康保険料を概算しています。`,
      ...uniqueMessages(result.notes),
    ],
    warnings: result.status === 'complete' ? result.notes || [] : [],
  };
}

function calculateNationalPension(individual, context) {
  const selection = individual.nationalPension;
  if (selection.kind === 'actual') {
    return {
      status: 'complete',
      annualPremium: selection.annualAmount,
      assumptions: ['国民年金保険料は入力された年間実額を使用しています。'],
    };
  }
  if (selection.kind === 'exempted') {
    return {
      status: 'complete',
      annualPremium: zeroMoney(),
      assumptions: ['国民年金は免除を選択しているため、保険料を0円として計算しています。'],
    };
  }
  const result = socialInsurance.calculateNationalPension({
    taxYear: incomeYearFrom(context),
    paymentMonths: selection.months,
    includeAdditionalPremium: selection.hasAdditionalPremium === true,
  });
  return {
    ...result,
    assumptions: result.status === 'complete' ? [
      `${incomeYearFrom(context)}年度の国民年金月額を${selection.months}か月分使用しています。暦年と保険年度がずれる場合があります。`,
    ] : [],
  };
}

function individualEngineInput(individual, nationalHealthInsurance, nationalPension) {
  return {
    business: {
      revenue: individual.business.revenue[0].value,
      expenses: individual.business.expenses[0].value,
      blueReturnTier: blueReturnTier(individual.blueReturn),
    },
    deductions: {
      ...(individual.deductions || {}),
      socialInsurance: {
        kind: 'itemized',
        nationalHealthInsurance,
        nationalPension,
      },
    },
    self: individual.self,
    spouse: individual.spouse,
    dependents: individual.dependents || [],
    taxCredits: individual.taxCredits,
  };
}

function calculateSoleProprietor(input, context) {
  const individual = input.individual;
  const nhi = calculateNationalHealthInsurance(individual, context);
  let blocked = engineBlockedReasons(nhi, 'NHI', '$.individual.nationalHealthInsurance');
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };
  const pension = calculateNationalPension(individual, context);
  blocked = engineBlockedReasons(pension, 'NATIONAL_PENSION', '$.individual.nationalPension');
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };

  const engineInput = individualEngineInput(individual, nhi.annualPremium, pension.annualPremium);
  const incomeTaxResult = income.incomeTax.calculate(engineInput, {
    taxYear: incomeYearFrom(context),
  });
  blocked = engineBlockedReasons(incomeTaxResult, 'INCOME_TAX', '$.individual');
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };
  const residentTaxResult = residentTax.calculate({
    ...engineInput,
    incomeTaxTaxableTotalIncome: incomeTaxResult.taxableTotalIncome,
    unappliedHousingLoanCredit: yen(
      incomeTaxResult.housingLoanCredit.value - incomeTaxResult.appliedHousingLoanCredit.value
    ),
  }, {
    incomeYear: incomeYearFrom(context),
    residentTaxFiscalYear: context.residentTaxFiscalYear ?? incomeYearFrom(context),
    jurisdiction: context.jurisdiction,
  });
  blocked = engineBlockedReasons(residentTaxResult, 'RESIDENT_TAX', '$.individual');
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };
  const beforeBlueDeduction = incomeTaxResult.business.incomeBeforeBlueDeduction;
  const businessTaxResult = individualBusinessTax.calculate({
    businessCategory: individual.business.businessTaxCategory,
    businessIncome: beforeBlueDeduction,
    businessMonths: MONTHS_IN_YEAR,
  }, { onDate: `${incomeYearFrom(context)}-12-31` });
  // asOfDate は根拠確認日であり課税年の適用日ではない。事業税マスターは所得年の末日で引く（§3-1）
  blocked = engineBlockedReasons(businessTaxResult, 'BUSINESS_TAX',
    '$.individual.business.businessTaxCategory');
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };

  const revenue = individual.business.revenue[0].value;
  const expenses = individual.business.expenses[0].value;
  const socialInsuranceEmployee = sumMoney([nhi.annualPremium, pension.annualPremium]);
  const burdens = {
    incomeTax: incomeTaxResult.payableIncomeTax,
    residentTax: residentTaxResult.annualTaxTotal,
    soleProprietorEnterpriseTax: businessTaxResult.taxAmount,
    socialInsuranceEmployee,
  };
  const personalDisposableCash = subtractMoneyValues(
    revenue, expenses, burdens.incomeTax, burdens.residentTax,
    burdens.soleProprietorEnterpriseTax, nhi.annualPremium, pension.annualPremium
  );
  return {
    status: 'complete',
    scenario: {
      scenario: 'sole_proprietor',
      personalDisposableCash,
      burdens,
      orderedIncomeDeductions: incomeTaxResult.orderedIncomeDeductions,
      totalIncomeDeductions: incomeTaxResult.totalIncomeDeductions,
      incomeTaxTaxableIncome: incomeTaxResult.taxableTotalIncome,
      incomeTaxCalculatedAmount: incomeTaxResult.calculatedIncomeTax,
      housingLoanCredit: incomeTaxResult.housingLoanCredit,
      appliedHousingLoanCredit: incomeTaxResult.appliedHousingLoanCredit,
      residentTaxTotalIncomeDeductions: residentTaxResult.totalIncomeDeductions,
      residentTaxTaxableIncome: residentTaxResult.taxableTotalIncome,
      residentTaxAdjustmentDeduction: yen(
        residentTaxResult.municipalAdjustmentDeduction.value +
          residentTaxResult.prefecturalAdjustmentDeduction.value
      ),
      residentTaxPrefecturalIncomeLevy: residentTaxResult.prefecturalIncomeLevy,
      residentTaxMunicipalIncomeLevy: residentTaxResult.municipalIncomeLevy,
      residentTaxDonationCredit: residentTaxResult.donationCredit,
      residentTaxHousingLoanCredit: residentTaxResult.housingLoanCredit,
    },
    assumptions: [
      ...(nhi.assumptions || []),
      ...(pension.assumptions || []),
      ...uniqueMessages(residentTaxResult.assumptions),
      ...uniqueMessages(businessTaxResult.notes),
      '個人事業税は必要経費に算入していません。自己参照を避ける第1版の扱いで、個人側の税額がやや大きめ（法人化有利方向）に出ます。',
      '所得税は復興特別所得税を含む納付額であり、復興特別所得税を別建てにしていません。',
    ],
    warnings: [
      ...(nhi.warnings || []),
      ...(incomeTaxResult.warnings || []),
      ...(residentTaxResult.warnings || []),
      ...(businessTaxResult.notes || []),
    ],
  };
}

function calculateCorporation(input, context) {
  const corporate = input.corporate;
  const profitBeforeOfficerCompensation = subtractMoneyValues(
    corporate.revenue[0].value,
    corporate.expenses[0].value
  );
  const forwardInput = {
    capital: corporate.capital,
    employeeCount: corporate.employeeCount ?? 0,
    healthInsurer: corporate.healthInsurer,
    officer: input.individual.self,
    spouse: input.individual.spouse,
    dependents: input.individual.dependents || [],
    deductions: {
      ...(corporate.deductions || {}),
      lifeInsurance: (input.individual.deductions || {}).lifeInsurance,
      earthquakeInsurance: (input.individual.deductions || {}).earthquakeInsurance,
      donations: (input.individual.deductions || {}).donations,
    },
    taxCredits: input.individual.taxCredits,
    specialistChecks: {},
    profitBeforeOfficerCompensation,
    plan: corporate.officerCompensation,
  };
  const monthlyAmount = corporate.officerCompensation.monthlySegments[0].value.monthlyAmount;
  const forward = yakuinHoshu.calculateForward(forwardInput, context, monthlyAmount);
  if (forward.status === 'blocked') {
    return {
      status: 'blocked',
      blockedReasons: (forward.blockedReasons || []).map(reason => ({
        ...reason,
        code: reason.code.replace(/^[A-Z]+_/, 'HJ_CORPORATION_'),
      })),
    };
  }
  const candidate = forward.candidate;
  const scenario = {
    scenario: 'corporation',
    personalDisposableCash: candidate.personalNetCash,
    corporateRetainedCash: candidate.corporateRetainedCash,
    burdens: {
      incomeTax: candidate.incomeTax,
      residentTax: candidate.residentTax,
      socialInsuranceEmployee: candidate.socialInsuranceEmployee,
      socialInsuranceEmployer: candidate.socialInsuranceEmployer,
      corporateTaxes: candidate.corporateTaxes,
    },
    orderedIncomeDeductions: candidate.orderedIncomeDeductions,
    totalIncomeDeductions: candidate.totalIncomeDeductions,
    incomeTaxTaxableIncome: candidate.incomeTaxTaxableIncome,
    incomeTaxCalculatedAmount: candidate.incomeTaxCalculatedAmount,
    housingLoanCredit: candidate.housingLoanCredit,
    appliedHousingLoanCredit: candidate.appliedHousingLoanCredit,
    residentTaxTotalIncomeDeductions: candidate.residentTaxTotalIncomeDeductions,
    residentTaxTaxableIncome: candidate.residentTaxTaxableIncome,
    residentTaxAdjustmentDeduction: candidate.residentTaxAdjustmentDeduction,
    residentTaxPrefecturalIncomeLevy: candidate.residentTaxPrefecturalIncomeLevy,
    residentTaxMunicipalIncomeLevy: candidate.residentTaxMunicipalIncomeLevy,
    residentTaxDonationCredit: candidate.residentTaxDonationCredit,
    residentTaxHousingLoanCredit: candidate.residentTaxHousingLoanCredit,
  };
  const costs = input.setupAndMaintenanceCosts;
  if (costs && ['annualAccountingFee', 'annualLaborConsultantFee', 'otherAnnualCost']
    .some(key => costs[key] !== undefined)) {
    scenario.setupAndMaintenanceCosts = sumMoney([
      costs.annualAccountingFee || zeroMoney(),
      costs.annualLaborConsultantFee || zeroMoney(),
      costs.otherAnnualCost || zeroMoney(),
    ]);
  }
  return {
    status: 'complete',
    scenario,
    assumptions: forward.assumptions || [],
    warnings: forward.warnings || [],
    excludedItems: forward.excludedItems || [],
  };
}

function rateRecordForSalesBand(band, onDate) {
  const valueKey = {
    standard_10: 'consumption_tax_rate_standard',
    reduced_8: 'consumption_tax_rate_reduced',
  }[band];
  if (!valueKey) return null;
  const records = snapshot.find(valueKey, { onDate });
  if (records.length !== 1) return null;
  return records[0];
}

function taxExclusiveExact(taxIncl, band, onDate) {
  if (!taxIncl || !taxIncl.amount) return null;
  if (taxIncl.basis === 'exclusive') return moneyToExact(taxIncl.amount);
  if (taxIncl.basis !== 'inclusive') return null;
  const record = rateRecordForSalesBand(band, onDate);
  if (!record) return null;
  const combined = masterRate(record.combined_rate);
  return multiplyRateByMoney(rate({
    num: combined.den,
    den: combined.den + combined.num,
  }), taxIncl.amount);
}

function taxableSalesTotalExact(input, context) {
  let total = moneyToExact(zeroMoney());
  const onDate = context.consumptionTaxPeriod.to;
  for (const segment of input.sales || []) {
    const value = segment.value || {};
    if (value.kind === 'detailed') {
      for (const item of value.taxable || []) {
        const amount = taxExclusiveExact(item.amount, item.band, onDate);
        if (!amount) return null;
        total = addExact(total, amount);
      }
      continue;
    }
    if (value.kind !== 'simple' || !value.taxableTotal) return null;
    for (const [band, ratioValue] of [
      ['standard_10', value.standardRatio],
      ['reduced_8', value.reducedRatio],
    ]) {
      if (!ratioValue) return null;
      const allocated = multiplyRateByMoney(rate({
        num: BigInt(ratioValue.num), den: BigInt(ratioValue.den),
      }), value.taxableTotal.amount);
      if (value.taxableTotal.basis === 'exclusive') {
        total = addExact(total, allocated);
        continue;
      }
      if (value.taxableTotal.basis !== 'inclusive') return null;
      const record = rateRecordForSalesBand(band, onDate);
      if (!record) return null;
      const combined = masterRate(record.combined_rate);
      total = addExact(total, multiplyRateByExact(rate({
        num: combined.den,
        den: combined.den + combined.num,
      }), allocated));
    }
  }
  return total;
}

function scopedShohizeiWarnings(calculation, inputPath) {
  return (calculation.warnings || []).map(item => {
    const suffix = typeof item.fieldPath === 'string'
      ? item.fieldPath.replace(/^\$/, '')
      : '';
    return {
      ...item,
      fieldPath: `${inputPath}${suffix}`,
    };
  });
}

function shohizeiOutcome(calculation) {
  const data = calculation.breakdown && calculation.breakdown.kind === 'shohizei'
    ? calculation.breakdown.data
    : null;
  if (calculation.resultStatus !== 'complete' || !data || !Array.isArray(data.methodResults)) {
    return { kind: 'unresolved' };
  }
  if (data.methodResults.length === 0) return { kind: 'exempt' };
  const methodCode = data.recommendedMethodCode;
  const recommended = data.methodResults.find(item => item.methodCode === methodCode);
  if (!methodCode || !recommended || recommended.eligibility !== 'eligible' ||
      !recommended.taxPayable) {
    return { kind: 'unresolved' };
  }
  return { kind: 'payable', methodCode, taxPayable: recommended.taxPayable };
}

function salesReconciliationWarning(side, shohizeiInput, shohizeiContext, hojinnariRevenue) {
  const taxableSales = taxableSalesTotalExact(shohizeiInput, shohizeiContext);
  if (taxableSales === null || compareExactToMoney(taxableSales, hojinnariRevenue) === 0) {
    return null;
  }
  const isIndividual = side === 'individual';
  return {
    code: 'HJ_CONSUMPTION_TAX_SALES_MISMATCH',
    fieldPath: isIndividual
      ? '$.consumptionTax.individualPeriodInput.sales'
      : '$.consumptionTax.corporatePeriodInput.sales',
    message: `②${isIndividual ? '個人期間' : '法人期間'}入力の課税売上合計（税込入力は税抜換算後・全税率帯合算）と①の${isIndividual ? '個人事業' : '法人'}売上が一致しません。①の売上の経理方式（税込経理・税抜経理）によっては差異が出ます。`,
  };
}

function methodLabel(methodCode) {
  return `${CONSUMPTION_TAX_METHOD_LABELS[methodCode] || methodCode}（${methodCode}）`;
}

function applyConsumptionTax(input, context, masters, soleScenario, corporateScenario) {
  if (input.consumptionTax.include !== true) {
    return {
      resolved: true,
      soleScenario,
      corporateScenario,
      assumptions: [],
      warnings: [],
      excludedItems: [],
    };
  }

  const individualContext = deriveIndividualConsumptionTaxContext(context);
  const corporateContext = deriveCorporateConsumptionTaxContext(context);
  const individualCalculation = shohizei.calculateWithoutRecordTracking(
    input.consumptionTax.individualPeriodInput, individualContext, masters
  );
  const corporateCalculation = shohizei.calculateWithoutRecordTracking(
    input.consumptionTax.corporatePeriodInput, corporateContext, masters
  );
  const individualOutcome = shohizeiOutcome(individualCalculation);
  const corporateOutcome = shohizeiOutcome(corporateCalculation);
  const warnings = [
    ...scopedShohizeiWarnings(individualCalculation,
      '$.consumptionTax.individualPeriodInput'),
    ...scopedShohizeiWarnings(corporateCalculation,
      '$.consumptionTax.corporatePeriodInput'),
  ];
  const individualMismatch = salesReconciliationWarning(
    'individual', input.consumptionTax.individualPeriodInput, individualContext,
    input.individual.business.revenue[0].value
  );
  const corporateMismatch = salesReconciliationWarning(
    'corporate', input.consumptionTax.corporatePeriodInput, corporateContext,
    input.corporate.revenue[0].value
  );
  if (individualMismatch) warnings.push(individualMismatch);
  if (corporateMismatch) warnings.push(corporateMismatch);

  if (individualOutcome.kind === 'unresolved' || corporateOutcome.kind === 'unresolved') {
    return {
      resolved: false,
      soleScenario,
      corporateScenario,
      assumptions: [],
      warnings,
      excludedItems: [{
        code: 'HJ_CONSUMPTION_TAX_METHOD_UNDETERMINED_BY_SHOHIZEI',
        label: '消費税',
        reason: `②の判定結果（個人側=${individualCalculation.resultStatus}、法人側=${corporateCalculation.resultStatus}）がcompleteかつ推奨方式確定の条件を満たさないため、消費税を比較から除外しました`,
        isAmountUnknown: true,
      }],
    };
  }

  const appliedSole = {
    ...soleScenario,
    burdens: { ...soleScenario.burdens },
  };
  const appliedCorporate = {
    ...corporateScenario,
    burdens: { ...corporateScenario.burdens },
  };
  const assumptions = [];
  if (individualOutcome.kind === 'payable') {
    appliedSole.burdens.consumptionTax = individualOutcome.taxPayable;
    appliedSole.personalDisposableCash = subtractMoneyValues(
      appliedSole.personalDisposableCash, individualOutcome.taxPayable
    );
  } else {
    assumptions.push('個人側は免税事業者のため消費税の納税義務なし。');
  }
  if (corporateOutcome.kind === 'payable') {
    appliedCorporate.burdens.consumptionTax = corporateOutcome.taxPayable;
    appliedCorporate.corporateRetainedCash = subtractMoneyValues(
      appliedCorporate.corporateRetainedCash, corporateOutcome.taxPayable
    );
  } else {
    assumptions.push('法人側は免税事業者のため消費税の納税義務なし。');
  }

  const methodParts = [];
  if (individualOutcome.kind === 'payable') {
    methodParts.push(`個人側＝${methodLabel(individualOutcome.methodCode)}`);
  }
  if (corporateOutcome.kind === 'payable') {
    methodParts.push(`法人側＝${methodLabel(corporateOutcome.methodCode)}`);
  }
  if (methodParts.length > 0) {
    assumptions.push(
      `消費税は${methodParts.join('・')}（それぞれ②の判定による推奨方式）の試算額を使用しています。`
    );
  }
  assumptions.push(
    '税抜経理を前提とし、控除対象外消費税額等は①の所得・経費へ反映せず、消費税の納付額は損金へ影響させず手取り・留保からのみ控除しています。'
  );

  return {
    resolved: true,
    soleScenario: appliedSole,
    corporateScenario: appliedCorporate,
    assumptions,
    warnings,
    excludedItems: [],
  };
}

function partialItems(input, consumptionTaxResult) {
  const excludedItems = [];
  if (input.corporate.locationSameAsResidence !== 'yes') {
    excludedItems.push({
      code: 'HJ_CORPORATE_LOCATION_LOCAL_RATES_EXCLUDED',
      label: '法人所在地の自治体独自の税率は反映していない',
      reason: '法人所在地が個人の住所地と同一でない、または未確認のため、標準税率による概算です',
      isAmountUnknown: true,
    });
  }
  if (input.consumptionTax.include !== true) {
    excludedItems.push({
      code: 'HJ_CONSUMPTION_TAX_OUT_OF_COMPARISON',
      label: '消費税：比較対象外',
      reason: '消費税を比較に含めない選択です',
      isAmountUnknown: true,
    });
  }
  excludedItems.push(...(consumptionTaxResult.excludedItems || []));
  return excludedItems;
}

function baseAssumptions(input, context) {
  const assumptions = [
    '平年度比較です。同じ所得・役員報酬が続く定常状態を前提としています。',
    '個人側の国保・国民年金は必要経費へ含めず、社会保険料控除だけに反映しています。',
    '配偶者・扶養親族ご自身の国民健康保険料・国民年金保険料（世帯分）は含めていません。法人化後の被扶養者・第3号被保険者の扱いの差も未反映です。',
    '小規模企業共済・iDeCoの掛金そのものは支出として差し引いていません（積み立てた資産はご本人に残るため）。税負担の軽減効果だけを反映しています',
    'ふるさと納税は確定申告を前提に計算し、ワンストップ特例は使用していません。',
  ];
  const adjustments = input.corporate.taxAdjustments;
  if (!adjustments || !Array.isArray(adjustments.items) ||
      adjustments.items.every(item => item.applies === 'no')) {
    assumptions.push('申告調整はないものとして計算しています。');
  }
  if (input.setupAndMaintenanceCosts &&
      input.setupAndMaintenanceCosts.incorporationCost !== undefined) {
    assumptions.push('設立一時費用は平年度比較に含めていません。');
  }
  assumptions.push(
    `所得税は${incomeYearFrom(context)}年分、法人側の社会保険は事業年度の料率・等級を使用しています。暦年と保険年度がずれる場合があります。`
  );
  return assumptions;
}

function blockedCalculation(reasons) {
  return {
    resultStatus: 'blocked',
    summary: { title: '第1版の対応範囲外または入力不足のため計算できません' },
    assumptions: [],
    warnings: reasons.map(reason => ({
      code: reason.code,
      fieldPath: reason.fieldPath,
      message: reason.message,
    })),
    excludedItems: [],
  };
}

function calculate(input, context, masters) {
  const reasons = supportedProfileReasons(input, context);
  if (reasons.length > 0) return blockedCalculation(reasons);

  const soleProprietor = calculateSoleProprietor(input, context);
  if (soleProprietor.status === 'blocked') return blockedCalculation(soleProprietor.blockedReasons);
  const corporation = calculateCorporation(input, context);
  if (corporation.status === 'blocked') return blockedCalculation(corporation.blockedReasons);
  const consumptionTaxResult = applyConsumptionTax(
    input, context, masters, soleProprietor.scenario, corporation.scenario
  );
  const soleScenario = consumptionTaxResult.soleScenario;
  const corporateScenario = consumptionTaxResult.corporateScenario;

  const personalDisposableDifference = subtractMoneyValues(
    corporateScenario.personalDisposableCash,
    soleScenario.personalDisposableCash
  );
  const corporateCombinedCash = sumMoney([
    corporateScenario.personalDisposableCash,
    corporateScenario.corporateRetainedCash,
  ]);
  const combinedReferenceDifference = subtractMoneyValues(
    corporateCombinedCash,
    soleScenario.personalDisposableCash
  );
  const excludedItems = [
    ...partialItems(input, consumptionTaxResult),
    ...(corporation.excludedItems || []),
  ];
  const isPartial = input.corporate.locationSameAsResidence !== 'yes' ||
    (input.consumptionTax.include === true && !consumptionTaxResult.resolved);
  return {
    resultStatus: isPartial ? 'partial' : 'complete',
    summary: {
      title: '法人＋個人手残りによる参考差額（帰属の異なる資金を合算した参考指標）',
      amount: combinedReferenceDifference,
    },
    breakdown: {
      kind: 'hojinnari',
      data: {
        soleProprietor: soleScenario,
        corporation: corporateScenario,
        personalDisposableDifference,
        combinedReferenceDifference,
      },
    },
    assumptions: [
      ...soleProprietor.assumptions,
      ...corporation.assumptions,
      ...consumptionTaxResult.assumptions,
    ],
    warnings: uniqueWarnings([
      ...soleProprietor.warnings,
      ...corporation.warnings,
      ...consumptionTaxResult.warnings,
      {
        code: 'HJ_CORPORATE_RETAINED_NOT_PERSONAL',
        message: '法人内部に残る資金は社長個人が自由に使える資金ではありません。',
      },
    ]),
    excludedItems,
  };
}

function validate(wireInput) {
  return validateInput('hojinnari', wireInput);
}

function simulate(input, context, masters) {
  assertSnapshotMatch(context, masters);
  snapshot.beginRecordTracking();
  let calculation;
  let usedMasterRecords;
  try {
    calculation = calculate(input, context, masters);
    usedMasterRecords = snapshot.endRecordTracking();
  } catch (error) {
    snapshot.endRecordTracking();
    throw error;
  }
  return buildSimulationResult({
    simulatorType: 'hojinnari',
    periodLabel: `${incomeYearFrom(context)}年分（平年度）`,
    comparisonBasis: input.comparisonBasis,
    resultStatus: calculation.resultStatus,
    summary: calculation.summary,
    breakdown: calculation.breakdown,
    assumptions: uniqueMessages([
      ...baseAssumptions(input, context),
      ...(calculation.assumptions || []),
    ]),
    warnings: calculation.warnings,
    masters,
    calculationContext: context,
    usedMasterRecords,
    precision: input.precision,
    excludedItems: calculation.excludedItems,
  });
}

module.exports = Object.freeze({
  validate,
  simulate,
  deriveIndividualConsumptionTaxContext,
  deriveCorporateConsumptionTaxContext,
});
