'use strict';

/**
 * 役員報酬シミュレーター第1版。
 * 税額・保険料の算式は持たず、既存エンジンの順算結果だけを合成する。
 */

const { validateInput } = require('../core/validator.js');
const { buildSimulationResult } = require('../core/result-builder.js');
const income = require('../../tax-engine/income/index.js');
const residentTax = require('../../tax-engine/resident-tax/index.js');
const socialInsurance = require('../../tax-engine/social-insurance/index.js');
const corporate = require('../../tax-engine/corporate/index.js');
const snapshot = require('../../tax-engine/masters/snapshot.js');
const {
  money,
  moneyToExact,
  multiplyRateByExact,
  addExact,
  subtractExact,
  compareExact,
  compareExactToMoney,
} = require('../../tax-engine/common/money.js');
const { applyRounding } = require('../../tax-engine/common/rounding.js');

const MONTHS_IN_YEAR = 12n;
const OBJECTIVE_BY_CRITERION = Object.freeze({
  min_burden: 'minimize_burden',
  max_total_retained: 'maximize_combined_cash',
  max_corporate_with_floor: 'maximize_corporate_cash_with_personal_floor',
});

function yen(value) {
  return money({ unit: 'JPY', value: BigInt(value) });
}

function zeroMoney() {
  return yen(0n);
}

function scaleExact(value, multiplier) {
  return multiplyRateByExact({ num: BigInt(multiplier), den: 1n }, value);
}

function sumExact(values) {
  return values.reduce((total, value) => addExact(total, value), moneyToExact(zeroMoney()));
}

function subtractMoneyValues(left, ...rights) {
  return yen(rights.reduce((value, right) => value - right.value, left.value));
}

function displayMoney(exactValue) {
  return applyRounding(exactValue, 'R-TRUNC-1-YEN');
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
  if (!context || !masters ||
      context.masterSnapshotId !== masters.snapshotId ||
      context.masterSnapshotHash !== masters.snapshotHash) {
    throw new Error('マスタースナップショットと計算コンテキストが一致しません');
  }
}

function incomeYearFrom(context) {
  const year = context.incomeYear ?? context.incomeTaxYear ?? context.taxYear;
  if (!Number.isInteger(year)) {
    throw new TypeError('context.incomeYear、incomeTaxYear または taxYear が必要です');
  }
  return year;
}

function fiscalPeriodFrom(context) {
  if (!context.fiscalPeriod || !context.fiscalPeriod.from || !context.fiscalPeriod.to) {
    throw new TypeError('context.fiscalPeriod が必要です');
  }
  return context.fiscalPeriod;
}

function premiumMonthFrom(context) {
  if (typeof context.premiumMonth === 'string') return context.premiumMonth;
  if (Array.isArray(context.socialInsuranceMonths) && context.socialInsuranceMonths.length > 0) {
    return context.socialInsuranceMonths[0];
  }
  return fiscalPeriodFrom(context).from.slice(0, 7);
}

function profitBeforeCompensationFrom(input, context) {
  // 入力データは入力型から。CalculationContext へ流さない（§3-2）
  return input.profitBeforeOfficerCompensation;
}

function blockedReason(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function supportedProfileReasons(input, context) {
  const reasons = [];
  if (input.healthInsurer.kind !== 'kyokai_kenpo') {
    reasons.push(blockedReason(
      'YH_HEALTH_INSURER_UNSUPPORTED',
      '$.healthInsurer',
      '第1版は協会けんぽだけに対応しています'
    ));
  }
  if (!Number.isInteger(input.officer.ageAtYearEnd)) {
    reasons.push(blockedReason('YH_OFFICER_AGE_REQUIRED', '$.officer.ageAtYearEnd',
      '社会保険料の計算には役員の年齢が必要です'));
  }
  if (input.officer.isNonResident === true) {
    reasons.push(blockedReason('YH_NON_RESIDENT_UNSUPPORTED', '$.officer.isNonResident',
      '非居住者は第1版の対象外です'));
  }
  if (input.deductions && Object.keys(input.deductions)
    .some(key => key !== 'smallEnterpriseMutualAid')) {
    reasons.push(blockedReason('YH_DEDUCTIONS_UNSUPPORTED', '$.deductions',
      '生命保険料控除等の各種控除は第1弾の対象外です'));
  }
  if (input.taxCredits !== undefined) {
    reasons.push(blockedReason('YH_TAX_CREDITS_UNSUPPORTED', '$.taxCredits',
      '住宅ローン控除等の税額控除は第1弾の対象外です'));
  }
  if (input.officerResidenceSameAsCompany !== 'yes') {
    reasons.push(blockedReason('YH_RESIDENCE_JURISDICTION_UNCONFIRMED',
      '$.officerResidenceSameAsCompany', '役員住所と法人所在地が同一であることを確認してください'));
  }
  if (!context.jurisdiction || !context.jurisdiction.municipalityCode ||
      typeof context.jurisdiction.isDesignatedCity !== 'boolean') {
    reasons.push(blockedReason('YH_RESIDENT_TAX_JURISDICTION_REQUIRED',
      '$.calculationContext.jurisdiction', '市区町村コードと指定都市判定が必要です'));
  }
  for (const [key, value] of Object.entries(input.specialistChecks || {})) {
    if (value !== 'yes') continue;
    const lower = key.toLowerCase();
    let code = 'YH_SPECIALIST_PROFILE_UNSUPPORTED';
    if (/employee|兼務/.test(lower)) code = 'YH_EMPLOYEE_OFFICER_UNSUPPORTED';
    else if (/part.?time|non.?full|非常勤/.test(lower)) code = 'YH_PART_TIME_OFFICER_UNSUPPORTED';
    else if (/multiple|複数/.test(lower)) code = 'YH_MULTIPLE_OFFICERS_UNSUPPORTED';
    reasons.push(blockedReason(code, `$.specialistChecks.${key}`,
      '該当する役員プロフィールは第1版の対象外です'));
  }
  if (profitBeforeCompensationFrom(input, context) === undefined) {
    reasons.push(blockedReason('YH_PROFIT_BEFORE_COMPENSATION_REQUIRED',
      '$.profitBeforeOfficerCompensation', '役員報酬控除前利益が必要です'));
  }
  return reasons;
}

function planReasons(plan, context, fieldPath = '$.plan') {
  const reasons = [];
  if (!plan || !Array.isArray(plan.monthlySegments) || plan.monthlySegments.length !== 1) {
    reasons.push(blockedReason('YH_CONSTANT_MONTHLY_PLAN_REQUIRED', `${fieldPath}.monthlySegments`,
      '第1版は12か月同額の支給計画だけに対応しています'));
    return reasons;
  }
  const period = fiscalPeriodFrom(context);
  const segment = plan.monthlySegments[0];
  if (!segment.period || segment.period.from !== period.from || segment.period.to !== period.to) {
    reasons.push(blockedReason('YH_MIDYEAR_CHANGE_UNSUPPORTED', `${fieldPath}.monthlySegments`,
      '期中改定または12か月未満の支給計画は第1版の対象外です'));
  }
  if (Array.isArray(plan.revisions) && plan.revisions.length > 0) {
    reasons.push(blockedReason('YH_MIDYEAR_CHANGE_UNSUPPORTED', `${fieldPath}.revisions`,
      '期中改定は第1版の対象外です'));
  }
  if (Array.isArray(plan.bonuses) && plan.bonuses.length > 0) {
    reasons.push(blockedReason('YH_BONUS_UNSUPPORTED', `${fieldPath}.bonuses`,
      '賞与・事前確定届出給与は第1版の対象外です'));
  }
  if (plan.appointedOn && plan.appointedOn !== period.from) {
    reasons.push(blockedReason('YH_APPOINTED_MIDYEAR_UNSUPPORTED', `${fieldPath}.appointedOn`,
      '事業年度途中の就任は第1版の対象外です'));
  }
  return reasons;
}

function modeReasons(input, context) {
  const reasons = supportedProfileReasons(input, context);
  const period = fiscalPeriodFrom(context);
  if (input.appointedOn && input.appointedOn !== period.from) {
    reasons.push(blockedReason('YH_APPOINTED_MIDYEAR_UNSUPPORTED', '$.appointedOn',
      '事業年度途中の就任は第1版の対象外です'));
  }
  if (input.mode === 'C') reasons.push(...planReasons(input.plan, context));
  if (input.mode === 'A' && Array.isArray(input.bonusPlan) && input.bonusPlan.length > 0) {
    reasons.push(blockedReason('YH_BONUS_UNSUPPORTED', '$.bonusPlan',
      '賞与・事前確定届出給与は第1版の対象外です'));
  }
  if (input.mode === 'B' && Array.isArray(input.assumedBonusPlan) &&
      input.assumedBonusPlan.length > 0) {
    reasons.push(blockedReason('YH_BONUS_UNSUPPORTED', '$.assumedBonusPlan',
      '賞与・事前確定届出給与は第1版の対象外です'));
  }
  return reasons;
}

function engineBlockedReasons(result, prefix, fieldPath) {
  if (result.status !== 'blocked') return [];
  return (result.blockedReasons || []).map(reason => ({
    code: reason.code || `${prefix}_BLOCKED`,
    fieldPath,
    message: reason.message || `${prefix}の計算を完了できませんでした`,
  }));
}

function compensationPlan(monthlyAmount, context) {
  return {
    monthlySegments: [{
      period: { ...fiscalPeriodFrom(context) },
      value: { monthlyAmount },
    }],
  };
}

function socialInsuranceTotals(monthlyPremium) {
  const employeeMonthly = yen(
    monthlyPremium.healthInsurance.employee.value + monthlyPremium.employeesPension.employee.value
  );
  const employerMonthly = sumExact([
    monthlyPremium.healthInsurance.employer,
    monthlyPremium.employeesPension.employer,
    monthlyPremium.childSupportLevy.employer,
  ]);
  return {
    employeeAnnual: yen(employeeMonthly.value * MONTHS_IN_YEAR),
    employerAnnualExact: scaleExact(employerMonthly, MONTHS_IN_YEAR),
    healthEmployeeAnnual: yen(monthlyPremium.healthInsurance.employee.value * MONTHS_IN_YEAR),
    pensionEmployeeAnnual: yen(monthlyPremium.employeesPension.employee.value * MONTHS_IN_YEAR),
    healthEmployerAnnualExact: scaleExact(monthlyPremium.healthInsurance.employer, MONTHS_IN_YEAR),
    pensionEmployerAnnualExact: scaleExact(monthlyPremium.employeesPension.employer, MONTHS_IN_YEAR),
    childSupportEmployerAnnualExact: scaleExact(
      monthlyPremium.childSupportLevy.employer, MONTHS_IN_YEAR
    ),
  };
}

function individualEngineInput(input, annualCompensation, employeeAnnual) {
  return {
    salaryRevenue: annualCompensation,
    officer: input.officer,
    spouse: input.spouse,
    dependents: input.dependents || [],
    otherIncomes: input.otherIncomes || [],
    deductions: {
      ...(input.deductions || {}),
      socialInsurance: { kind: 'total', annualTotal: employeeAnnual },
    },
    taxCredits: input.taxCredits,
  };
}

function calculateForward(input, context, monthlyAmount) {
  const incomeYear = incomeYearFrom(context);
  const premiumMonth = premiumMonthFrom(context);
  const annualCompensation = yen(monthlyAmount.value * MONTHS_IN_YEAR);
  const premium = socialInsurance.calculateMonthlyPremium({
    premiumMonth,
    prefectureCode: input.healthInsurer.prefectureCode,
    insurerType: 'kyokai_kenpo',
    age: input.officer.ageAtYearEnd,
    monthlyRemuneration: monthlyAmount,
  });
  const blocked = engineBlockedReasons(premium, 'SI', '$.healthInsurer');
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };

  const insurance = socialInsuranceTotals(premium);
  const individualInput = individualEngineInput(input, annualCompensation, insurance.employeeAnnual);
  const incomeTaxResult = income.incomeTax.calculate(individualInput, { taxYear: incomeYear });
  blocked.push(...engineBlockedReasons(incomeTaxResult, 'IT', '$'));
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };

  const residentTaxResult = residentTax.calculate(individualInput, {
    incomeYear,
    residentTaxFiscalYear: context.residentTaxFiscalYear ?? incomeYear,
    jurisdiction: context.jurisdiction,
  });
  blocked.push(...engineBlockedReasons(residentTaxResult, 'RT', '$.calculationContext.jurisdiction'));
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };

  const personalNetCash = subtractMoneyValues(
    annualCompensation,
    insurance.employeeAnnual,
    incomeTaxResult.payableIncomeTax,
    residentTaxResult.annualTaxTotal
  );

  const profitBefore = money(profitBeforeCompensationFrom(input, context));
  const corporateIncomeExact = subtractExact(
    subtractExact(moneyToExact(profitBefore), moneyToExact(annualCompensation)),
    insurance.employerAnnualExact
  );
  // 法人税エンジンはMoneyを受けるため、法定の法人課税標準段階でのみ1,000円未満を落とす。
  // corporateIncomeExact 自体は以後も保持し、税引後利益と最適化には分数のまま使う。
  const corporateTaxBase = applyRounding(corporateIncomeExact, 'R-TRUNC-1000-BASE');
  const corporateTaxResult = corporate.calculate({
    entityType: 'domestic_ordinary',
    comparisonBasis: 'steady_state',
    capital: input.capital,
    employeeCount: input.employeeCount ?? 0,
    accountingProfitBeforeTax: corporateTaxBase,
    fiscalPeriod: fiscalPeriodFrom(context),
    enterpriseTaxReducedRateEligible: true,
    taxAdjustments: { items: [], treatUnansweredAsZero: true },
  });
  blocked.push(...engineBlockedReasons(corporateTaxResult, 'CT', '$'));
  if (blocked.length > 0) return { status: 'blocked', blockedReasons: blocked };

  const corporateTaxes = corporateTaxResult.totalTax;
  const corporateRetainedExact = subtractExact(
    corporateIncomeExact,
    moneyToExact(corporateTaxes)
  );
  const combinedCashExact = addExact(moneyToExact(personalNetCash), corporateRetainedExact);
  const totalBurdenExact = sumExact([
    moneyToExact(insurance.employeeAnnual),
    insurance.employerAnnualExact,
    moneyToExact(incomeTaxResult.payableIncomeTax),
    moneyToExact(residentTaxResult.annualTaxTotal),
    moneyToExact(corporateTaxes),
  ]);
  const planId = `monthly-${monthlyAmount.value}`;
  const candidate = {
    planId,
    monthlyCompensation: monthlyAmount,
    annualCompensation,
    personalNetCash,
    corporateRetainedCash: displayMoney(corporateRetainedExact),
    totalTaxAndInsurance: displayMoney(totalBurdenExact),
    deductibleStatus: 'eligible',
    salaryIncome: incomeTaxResult.salary.salaryIncome,
    incomeTaxBasicDeduction: incomeTaxResult.incomeDeductions.basic,
    orderedIncomeDeductions: incomeTaxResult.orderedIncomeDeductions,
    totalIncomeDeductions: incomeTaxResult.totalIncomeDeductions,
    incomeTaxTaxableIncome: incomeTaxResult.taxableTotalIncome,
    socialInsuranceEmployee: insurance.employeeAnnual,
    healthInsuranceEmployee: insurance.healthEmployeeAnnual,
    employeesPensionEmployee: insurance.pensionEmployeeAnnual,
    incomeTax: incomeTaxResult.payableIncomeTax,
    residentTax: residentTaxResult.annualTaxTotal,
    residentTaxTaxableIncome: residentTaxResult.taxableTotalIncome,
    residentTaxOrderedIncomeDeductions: residentTaxResult.orderedIncomeDeductions,
    residentTaxTotalIncomeDeductions: residentTaxResult.totalIncomeDeductions,
    residentTaxAdjustmentDeduction: yen(
      residentTaxResult.municipalAdjustmentDeduction.value +
        residentTaxResult.prefecturalAdjustmentDeduction.value
    ),
    socialInsuranceEmployer: displayMoney(insurance.employerAnnualExact),
    socialInsuranceEmployerExact: insurance.employerAnnualExact,
    healthInsuranceEmployerExact: insurance.healthEmployerAnnualExact,
    employeesPensionEmployerExact: insurance.pensionEmployerAnnualExact,
    childSupportLevyEmployerExact: insurance.childSupportEmployerAnnualExact,
    corporateIncome: displayMoney(corporateIncomeExact),
    corporateIncomeExact,
    corporateTaxes,
    corporateTaxDetails: {
      corporateTax: corporateTaxResult.corporateTax.amount,
      localCorporateTax: corporateTaxResult.localCorporateTax.amount,
      prefecturalInhabitantIncomeLevy:
        corporateTaxResult.corporateInhabitantTax.prefecturalIncomeLevy,
      municipalInhabitantIncomeLevy:
        corporateTaxResult.corporateInhabitantTax.municipalIncomeLevy,
      inhabitantPerCapitaLevy:
        corporateTaxResult.corporateInhabitantTax.perCapitaLevyTotal,
      enterpriseTax: corporateTaxResult.enterpriseTax.amount,
      specialEnterpriseTax: corporateTaxResult.specialEnterpriseTax.amount,
    },
    corporateRetainedCashExact: corporateRetainedExact,
    combinedCash: displayMoney(combinedCashExact),
    combinedCashExact,
    totalTaxAndInsuranceExact: totalBurdenExact,
  };
  return {
    status: 'complete',
    candidate,
    assumptions: [
      ...uniqueMessages(residentTaxResult.assumptions),
      ...uniqueMessages(corporateTaxResult.assumptions),
    ],
    warnings: [
      ...(incomeTaxResult.warnings || []),
      ...(residentTaxResult.warnings || []),
      ...(corporateTaxResult.warnings || []),
    ],
    excludedItems: corporateTaxResult.excludedItems || [],
  };
}

function monthlySearchValues(low, high, step) {
  const values = [];
  for (let value = low.value; value <= high.value; value += step.value) values.push(yen(value));
  return values;
}

function searchBounds(input, context) {
  const step = yen(input.searchStep);
  const low = input.searchLowerBound ?? input.previousMonthlyAmount ?? context.searchLowerBound ?? step;
  let high = input.searchUpperBound ?? context.searchUpperBound;
  if (high === undefined && input.mode === 'B') {
    const profit = money(profitBeforeCompensationFrom(input, context));
    high = yen((profit.value / MONTHS_IN_YEAR / step.value) * step.value);
  }
  if (high === undefined) return { blockedReason: blockedReason(
    'YH_SEARCH_UPPER_BOUND_REQUIRED', '$.searchUpperBound',
    '探索上限を入力してください。第1版は固定の既定上限を持ちません'
  ) };
  const checkedLow = money(low);
  const checkedHigh = money(high);
  if (checkedLow.value < 0n || checkedHigh.value < checkedLow.value ||
      checkedLow.value % step.value !== 0n || checkedHigh.value % step.value !== 0n) {
    return { blockedReason: blockedReason('YH_SEARCH_RANGE_INVALID', '$.searchUpperBound',
      '探索範囲は刻みの整数倍で、下限以下ではない上限を指定してください') };
  }
  return { low: checkedLow, high: checkedHigh, step };
}

function evaluateCandidates(input, context, bounds) {
  const candidates = [];
  const assumptions = [];
  const warnings = [];
  const excludedItems = [];
  for (const monthlyAmount of monthlySearchValues(bounds.low, bounds.high, bounds.step)) {
    const result = calculateForward(input, context, monthlyAmount);
    if (result.status === 'blocked') return result;
    candidates.push(result.candidate);
    assumptions.push(...result.assumptions);
    warnings.push(...result.warnings);
    excludedItems.push(...result.excludedItems);
  }
  return {
    status: 'complete',
    candidates,
    assumptions: uniqueMessages(assumptions),
    warnings: uniqueWarnings(warnings),
    excludedItems,
  };
}

function compareCandidate(left, right, criterion) {
  if (criterion === 'min_burden') {
    return compareExact(right.totalTaxAndInsuranceExact, left.totalTaxAndInsuranceExact);
  }
  if (criterion === 'max_corporate_with_floor') {
    return compareExact(left.corporateRetainedCashExact, right.corporateRetainedCashExact);
  }
  return compareExact(left.combinedCashExact, right.combinedCashExact);
}

function eligibleForFloors(candidate, constraints = {}) {
  if (constraints.minPersonalNetIncome &&
      candidate.personalNetCash.value < constraints.minPersonalNetIncome.value) return false;
  if (constraints.minCorporateRetained &&
      compareExactToMoney(candidate.corporateRetainedCashExact,
        constraints.minCorporateRetained) < 0) return false;
  if (constraints.officerCompensationCeilingByResolution &&
      candidate.monthlyCompensation.value >
        constraints.officerCompensationCeilingByResolution.value) return false;
  return true;
}

function selectBest(input, candidates) {
  const eligible = candidates.filter(candidate =>
    input.optimizationCriterion !== 'max_corporate_with_floor' ||
      eligibleForFloors(candidate, input.constraints)
  ).filter(candidate => !input.constraints ||
    !input.constraints.officerCompensationCeilingByResolution ||
    candidate.monthlyCompensation.value <=
      input.constraints.officerCompensationCeilingByResolution.value);
  if (eligible.length === 0) return { selected: null, tied: [] };
  let selected = eligible[0];
  let tied = [selected];
  for (const candidate of eligible.slice(1)) {
    const comparison = compareCandidate(candidate, selected, input.optimizationCriterion);
    if (comparison > 0) {
      selected = candidate;
      tied = [candidate];
    } else if (comparison === 0) {
      tied.push(candidate);
    }
  }
  return { selected, tied };
}

function baseAssumptions(context) {
  const incomeYear = incomeYearFrom(context);
  const premiumMonth = premiumMonthFrom(context);
  return [
    '平年度比較です。住民税は同じ所得が続く前提で、当年所得から平年度の年税額を計算しています。',
    `所得税は${incomeYear}年分、社会保険は${premiumMonth}分の料率・等級を12か月同額として使用しています。暦年と社会保険年度（保険年度）がずれる場合があります。`,
    '国内普通法人・常勤役員1名・事業年度開始時に決めた12か月同額の定期給与を前提としています。',
    '申告調整と繰越欠損金はなく、法人地方税は既存法人税エンジンの標準税率で計算しています。',
    '小規模企業共済・iDeCoの掛金そのものは支出として差し引いていません（積み立てた資産はご本人に残るため）。税負担の軽減効果だけを反映しています',
  ];
}

function annualRange(bounds) {
  return {
    low: yen(bounds.low.value * MONTHS_IN_YEAR),
    high: yen(bounds.high.value * MONTHS_IN_YEAR),
  };
}

function calculateModeC(input, context) {
  const monthlyAmount = input.plan.monthlySegments[0].value.monthlyAmount;
  const forward = calculateForward(input, context, monthlyAmount);
  if (forward.status === 'blocked') return forward;
  return {
    resultStatus: 'complete',
    summary: {
      title: '役員報酬から年間手残りを計算しました',
      amount: monthlyAmount,
      comparison: forward.candidate.combinedCash,
    },
    breakdown: {
      kind: 'yakuin_hoshu',
      data: {
        objective: 'maximize_combined_cash',
        selectedPlanId: forward.candidate.planId,
        candidates: [forward.candidate],
        searchRange: {
          low: forward.candidate.annualCompensation,
          high: forward.candidate.annualCompensation,
        },
      },
    },
    assumptions: forward.assumptions,
    warnings: forward.warnings,
    excludedItems: forward.excludedItems,
  };
}

function calculateModeA(input, context) {
  const bounds = searchBounds(input, context);
  if (bounds.blockedReason) return { status: 'blocked', blockedReasons: [bounds.blockedReason] };
  const evaluated = evaluateCandidates(input, context, bounds);
  if (evaluated.status === 'blocked') return evaluated;
  const selection = selectBest(input, evaluated.candidates);
  if (!selection.selected) {
    return { status: 'blocked', blockedReasons: [blockedReason(
      'YH_NO_CANDIDATE_MEETS_CONSTRAINTS', '$.constraints',
      '入力した下限制約を満たす候補が探索範囲にありません'
    )] };
  }
  const nearUpperBound = selection.selected.monthlyCompensation.value === bounds.high.value;
  const warnings = [...evaluated.warnings];
  if (nearUpperBound) warnings.push({
    code: 'YH_SEARCH_UPPER_BOUND_NEAR',
    fieldPath: '$.searchUpperBound',
    message: '最良候補が探索上限にあるため、探索範囲内の暫定候補として表示します',
  });
  if (selection.tied.length > 1) warnings.push({
    code: 'YH_OPTIMUM_TIED',
    fieldPath: '$.optimizationCriterion',
    message: '最良値が同額の候補が複数あります',
  });
  return {
    resultStatus: 'complete',
    summary: {
      title: nearUpperBound
        ? '探索上限付近の暫定候補です'
        : '指定した基準で最良の役員報酬候補です',
      amount: selection.selected.monthlyCompensation,
      comparison: input.optimizationCriterion === 'min_burden'
        ? selection.selected.totalTaxAndInsurance
        : input.optimizationCriterion === 'max_corporate_with_floor'
          ? selection.selected.corporateRetainedCash
          : selection.selected.combinedCash,
    },
    breakdown: {
      kind: 'yakuin_hoshu',
      data: {
        objective: OBJECTIVE_BY_CRITERION[input.optimizationCriterion],
        ...(nearUpperBound ? { provisionalPlanId: selection.selected.planId } :
          { selectedPlanId: selection.selected.planId }),
        candidates: evaluated.candidates,
        searchRange: annualRange(bounds),
        searchMonthlyRange: { low: bounds.low, high: bounds.high },
        nearUpperBound,
      },
    },
    assumptions: [
      ...evaluated.assumptions,
      ...(input.optimizationCriterion === 'max_total_retained' ? [
        '基準Bは法人留保と個人可処分所得を同価値とみなします。将来の個人移転課税、退職金、配当、資金繰り、借入契約、年金給付は含みません。',
      ] : []),
    ],
    warnings,
    excludedItems: evaluated.excludedItems,
  };
}

function calculateModeB(input, context) {
  const bounds = searchBounds(input, context);
  if (bounds.blockedReason) return { status: 'blocked', blockedReasons: [bounds.blockedReason] };
  const evaluated = evaluateCandidates(input, context, bounds);
  if (evaluated.status === 'blocked') return evaluated;
  const desiredAnnual = yen(input.desiredMonthlyNetIncome.value * MONTHS_IN_YEAR);
  const selected = evaluated.candidates.find(candidate =>
    candidate.personalNetCash.value >= desiredAnnual.value
  );
  if (!selected) {
    return {
      resultStatus: 'partial',
      summary: {
        title: '希望手取りを満たす報酬額は探索範囲内にありません',
        range: {
          low: bounds.low,
          high: bounds.high,
          causeFieldPaths: ['$.searchUpperBound'],
          basisSourceIds: [],
        },
      },
      breakdown: {
        kind: 'yakuin_hoshu',
        data: {
          objective: 'maximize_combined_cash',
          candidates: evaluated.candidates,
          searchRange: annualRange(bounds),
          searchMonthlyRange: { low: bounds.low, high: bounds.high },
        },
      },
      assumptions: evaluated.assumptions,
      warnings: [...evaluated.warnings, {
        code: 'YH_DESIRED_NET_OUTSIDE_SEARCH_RANGE',
        fieldPath: '$.searchUpperBound',
        message: '探索上限を広げて再計算してください',
      }],
      excludedItems: evaluated.excludedItems,
    };
  }
  // 逆算の結論額を順算し直し、探索時の手取りと一致することを不変条件として固定する。
  const verification = calculateForward(input, context, selected.monthlyCompensation);
  if (verification.status !== 'complete' ||
      verification.candidate.personalNetCash.value !== selected.personalNetCash.value ||
      verification.candidate.personalNetCash.value < desiredAnnual.value) {
    throw new Error('手取り逆算結果の順算検証に失敗しました');
  }
  return {
    resultStatus: 'complete',
    summary: {
      title: '希望手取りを満たす最小の役員報酬月額です',
      amount: selected.monthlyCompensation,
      comparison: selected.personalNetCash,
    },
    breakdown: {
      kind: 'yakuin_hoshu',
      data: {
        objective: 'maximize_combined_cash',
        selectedPlanId: selected.planId,
        candidates: evaluated.candidates,
        searchRange: annualRange(bounds),
        searchMonthlyRange: { low: bounds.low, high: bounds.high },
        desiredAnnualNetIncome: desiredAnnual,
        inverseVerifiedByForwardCalculation: true,
      },
    },
    assumptions: evaluated.assumptions,
    warnings: evaluated.warnings,
    excludedItems: evaluated.excludedItems,
  };
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

function validate(wireInput) {
  return validateInput('yakuin_hoshu', wireInput);
}

function simulate(input, context, masters) {
  assertSnapshotMatch(context, masters);
  snapshot.beginRecordTracking();
  let calculation;
  let usedMasterRecords;
  try {
    const reasons = modeReasons(input, context);
    if (reasons.length > 0) {
      calculation = blockedCalculation(reasons);
    } else if (input.mode === 'A') {
      calculation = calculateModeA(input, context);
    } else if (input.mode === 'B') {
      calculation = calculateModeB(input, context);
    } else if (input.mode === 'C') {
      calculation = calculateModeC(input, context);
    } else {
      calculation = blockedCalculation([blockedReason(
        'YH_MODE_UNSUPPORTED', '$.mode', '対応していない計算モードです'
      )]);
    }
    if (calculation.status === 'blocked') {
      calculation = blockedCalculation(calculation.blockedReasons);
    }
    usedMasterRecords = snapshot.endRecordTracking();
  } catch (error) {
    snapshot.endRecordTracking();
    throw error;
  }

  return buildSimulationResult({
    simulatorType: 'yakuin_hoshu',
    periodLabel: `${fiscalPeriodFrom(context).from}～${fiscalPeriodFrom(context).to}`,
    comparisonBasis: 'steady_state',
    resultStatus: calculation.resultStatus,
    summary: calculation.summary,
    breakdown: calculation.breakdown,
    assumptions: [...baseAssumptions(context), ...(calculation.assumptions || [])],
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
  calculateForward,
  planReasons,
});
