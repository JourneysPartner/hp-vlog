'use strict';

/**
 * 所得税エンジン第1版。
 * 合計所得金額・総所得金額等・課税総所得金額を別々の変数で保持する。
 */

const masters = require('../masters/snapshot.js');
const { calculateSalaryIncome } = require('./salary-income.js');
const { calculateBusinessIncome } = require('./business-income.js');
const { calculateIncomeDeductions } = require('./income-deductions.js');
const {
  zeroMoney,
  inputMoney,
  masterMoney,
  masterRate,
  sumMoney,
  criterion,
  findRange,
  floorMoneyAtZero,
  moneyToExact,
  multiplyRateByMoney,
  subtractExact,
  addMoney,
  subtractMoney,
  applyRounding,
} = require('./helpers.js');

function addReason(reasons, code, message, itemIndex) {
  if (reasons.some(reason => reason.code === code && reason.itemIndex === itemIndex)) return;
  const reason = { code, message };
  if (itemIndex !== undefined) reason.itemIndex = itemIndex;
  reasons.push(reason);
}

function presentUnsupportedValue(value) {
  if (value === undefined || value === null || value === false || value === 'no') return false;
  if (value && value.unit === 'JPY') return inputMoney(value).value !== 0n;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function preflightBlockedReasons(input) {
  const reasons = [];
  const incomeItems = input.otherIncomes || input.incomeItems || [];
  incomeItems.forEach((item, index) => {
    if (item.category === 'unknown' || item.taxationMethod === 'unknown') {
      addReason(reasons, 'IT_INCOME_CLASSIFICATION_UNKNOWN',
        '所得区分または課税方式が不明な所得は計算できません', index);
      return;
    }
    if (item.taxationMethod !== 'aggregate') {
      addReason(reasons, 'IT_SEPARATE_TAXATION_UNSUPPORTED',
        '分離課税の所得は第1版の対象外です', index);
    }
    if (item.category !== 'salary' && item.category !== 'business') {
      addReason(reasons, 'IT_INCOME_CATEGORY_UNSUPPORTED',
        `所得区分 ${item.category} は第1版の対象外です`, index);
    }
  });

  if (presentUnsupportedValue(input.separateTaxationIncome) ||
      presentUnsupportedValue(input.separateIncomes) || input.hasSeparateTaxationIncome === true) {
    addReason(reasons, 'IT_SEPARATE_TAXATION_UNSUPPORTED', '分離課税の所得は第1版の対象外です');
  }
  if (presentUnsupportedValue(input.netLossCarryforward) ||
      presentUnsupportedValue(input.lossCarryforward) ||
      presentUnsupportedValue(input.priorYearNetLoss)) {
    addReason(reasons, 'IT_NET_LOSS_CARRYFORWARD_UNSUPPORTED', '純損失の繰越控除は第1版の対象外です');
  }
  if (presentUnsupportedValue(input.casualtyLossCarryforward) ||
      presentUnsupportedValue(input.priorYearCasualtyLoss)) {
    addReason(reasons, 'IT_CASUALTY_LOSS_CARRYFORWARD_UNSUPPORTED', '雑損失の繰越控除は第1版の対象外です');
  }
  const otherCredits = input.taxCredits && input.taxCredits.other;
  if (Array.isArray(otherCredits) && otherCredits.length > 0) {
    addReason(reasons, 'IT_TAX_CREDIT_UNSUPPORTED', '住宅ローン控除以外の税額控除は第1版の対象外です');
  }
  return reasons;
}

function calculateIncomeTax(taxableTotalIncomeInput, taxCredits = {}, options = {}) {
  const taxableTotalIncome = inputMoney(taxableTotalIncomeInput, 'taxableTotalIncome');
  if (taxableTotalIncome.value < 0n) {
    throw new RangeError('taxableTotalIncome は0円以上で指定してください');
  }
  const searchCriterion = criterion(options);
  let calculatedIncomeTax = zeroMoney();
  if (taxableTotalIncome.value > 0n) {
    const record = findRange(
      masters.find('income_tax_brackets', searchCriterion),
      taxableTotalIncome,
      'bracket_lower_inclusive'
    );
    if (!record) throw new Error(`所得税速算表に該当行がありません: ${taxableTotalIncome.value}`);
    const beforeRounding = subtractExact(
      multiplyRateByMoney(masterRate(record.rate), taxableTotalIncome),
      moneyToExact(masterMoney(record.quick_deduction))
    );
    calculatedIncomeTax = applyRounding(beforeRounding, 'R-NONE');
  }

  const warnings = [];
  const housingLoanCredit = inputMoney(
    taxCredits.housingLoan ?? taxCredits.housingLoanCredit,
    'taxCredits.housingLoan'
  );
  if (housingLoanCredit.value < 0n) throw new RangeError('住宅ローン控除は0円以上で指定してください');
  const baseIncomeTax = floorMoneyAtZero(subtractMoney(calculatedIncomeTax, housingLoanCredit));
  const appliedHousingLoanCredit = subtractMoney(calculatedIncomeTax, baseIncomeTax);
  if (housingLoanCredit.value > calculatedIncomeTax.value) {
    warnings.push({
      code: 'IT_HOUSING_LOAN_CREDIT_EXCEEDS_TAX',
      message: '住宅ローン控除を所得税から引き切れないため、基準所得税額を0円で止めました',
      unappliedAmount: subtractMoney(housingLoanCredit, appliedHousingLoanCredit),
    });
  }

  const reconstructionRecord = masters.find('reconstruction_income_surtax', searchCriterion)[0];
  if (!reconstructionRecord) throw new Error('復興特別所得税マスターが利用できません');
  const reconstructionIncomeTax = applyRounding(
    multiplyRateByMoney(masterRate(reconstructionRecord.rate), baseIncomeTax),
    reconstructionRecord.rounding_rule_id
  );
  const totalIncomeTax = addMoney(baseIncomeTax, reconstructionIncomeTax);
  const payableIncomeTax = applyRounding(moneyToExact(totalIncomeTax), 'R-TRUNC-100-TAX');

  return {
    status: 'complete',
    blockedReasons: [],
    warnings,
    taxableTotalIncome,
    calculatedIncomeTax,
    housingLoanCredit,
    appliedHousingLoanCredit,
    baseIncomeTax,
    reconstructionIncomeTax,
    totalIncomeTax,
    payableIncomeTax,
  };
}

function otherIncomeTotals(items) {
  return {
    salary: sumMoney(items.filter(item => item.category === 'salary')
      .map((item, index) => inputMoney(item.amount, `otherIncomes[${index}].amount`))),
    business: sumMoney(items.filter(item => item.category === 'business')
      .map((item, index) => inputMoney(item.amount, `otherIncomes[${index}].amount`))),
  };
}

function calculate(input, options = {}) {
  const effectiveOptions = options.onDate || Number.isInteger(options.taxYear)
    ? options
    : { ...options, taxYear: input.taxYear };
  // criterion を先に検証し、年度未指定で現在年を暗黙採用しない。
  criterion(effectiveOptions);
  const blockedReasons = preflightBlockedReasons(input);
  if (blockedReasons.length > 0) {
    return { status: 'blocked', blockedReasons, warnings: [] };
  }

  const salaryRevenueSource = input.salaryRevenue ??
    (input.salary && (input.salary.revenue ?? input.salary.annualRevenue));
  const salaryResult = salaryRevenueSource === undefined
    ? {
      salaryRevenue: zeroMoney(),
      salaryIncomeDeduction: zeroMoney(),
      salaryIncome: zeroMoney(),
      calculationMethod: 'none',
      bandLower: null,
    }
    : calculateSalaryIncome(salaryRevenueSource, effectiveOptions);

  const businessInput = input.business;
  const businessResult = businessInput
    ? calculateBusinessIncome({
      ...businessInput,
      blueReturnTier: businessInput.blueReturnTier ?? input.blueReturnTier,
      blueReturn: businessInput.blueReturn || input.blueReturn,
    }, effectiveOptions)
    : {
      status: 'complete',
      blockedReasons: [],
      revenue: zeroMoney(),
      expenses: zeroMoney(),
      incomeBeforeBlueDeduction: zeroMoney(),
      blueReturnSpecialDeduction: zeroMoney(),
      businessIncome: zeroMoney(),
    };
  if (businessResult.status === 'blocked') {
    return { status: 'blocked', blockedReasons: businessResult.blockedReasons, warnings: [] };
  }

  const incomeItems = input.otherIncomes || input.incomeItems || [];
  const otherTotals = otherIncomeTotals(incomeItems);
  if (otherTotals.business.value < 0n) {
    return {
      status: 'blocked',
      blockedReasons: [{
        code: 'IT_BUSINESS_LOSS_OFFSET_UNSUPPORTED',
        message: '負の事業所得があるため、損益通算を扱えません',
      }],
      warnings: [],
    };
  }
  const salaryIncome = addMoney(salaryResult.salaryIncome, otherTotals.salary);
  const businessIncome = addMoney(businessResult.businessIncome, otherTotals.business);

  // 第1版は分離課税なしのため同値だが、変数と返却フィールドを統合しない。
  const totalIncome = sumMoney([salaryIncome, businessIncome]);
  const grossIncomeEtc = sumMoney([salaryIncome, businessIncome]);
  const deductionResult = calculateIncomeDeductions({
    totalIncome,
    grossIncomeEtc,
    deductions: input.deductions,
    spouse: input.spouse,
    dependents: input.dependents,
    self: input.self || input.officer,
  }, effectiveOptions);
  if (deductionResult.status === 'blocked') {
    return { status: 'blocked', blockedReasons: deductionResult.blockedReasons, warnings: [] };
  }

  const taxableTotalIncomeBeforeRounding = floorMoneyAtZero(
    subtractMoney(grossIncomeEtc, deductionResult.totalDeduction)
  );
  const taxableTotalIncome = applyRounding(
    moneyToExact(taxableTotalIncomeBeforeRounding),
    'R-TRUNC-1000-BASE'
  );
  const taxResult = calculateIncomeTax(
    taxableTotalIncome,
    input.taxCredits || {},
    effectiveOptions
  );

  return {
    status: 'complete',
    blockedReasons: [],
    warnings: taxResult.warnings,
    salary: salaryResult,
    business: businessResult,
    salaryIncome,
    businessIncome,
    totalIncome,
    grossIncomeEtc,
    incomeDeductions: deductionResult.deductions,
    orderedIncomeDeductions: deductionResult.orderedDeductions,
    totalIncomeDeductions: deductionResult.totalDeduction,
    taxableTotalIncomeBeforeRounding,
    taxableTotalIncome,
    calculatedIncomeTax: taxResult.calculatedIncomeTax,
    housingLoanCredit: taxResult.housingLoanCredit,
    appliedHousingLoanCredit: taxResult.appliedHousingLoanCredit,
    baseIncomeTax: taxResult.baseIncomeTax,
    reconstructionIncomeTax: taxResult.reconstructionIncomeTax,
    totalIncomeTax: taxResult.totalIncomeTax,
    payableIncomeTax: taxResult.payableIncomeTax,
    deductionDetails: {
      dependents: deductionResult.dependentRows,
      lifeInsurance: deductionResult.lifeInsuranceRows,
      earthquakeInsurance: deductionResult.earthquakeInsuranceRows,
    },
  };
}

module.exports = {
  calculate,
  calculateIncomeTax,
  preflightBlockedReasons,
};
