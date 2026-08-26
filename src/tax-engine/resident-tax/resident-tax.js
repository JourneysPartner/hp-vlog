'use strict';

/**
 * 個人住民税エンジン第1版。
 * 所得税の課税所得・所得控除額は受け取らず、前年所得から住民税用控除を組み直す。
 */

const masters = require('../masters/snapshot.js');
const { calculateSalaryIncome } = require('../income/salary-income.js');
const { calculateBusinessIncome } = require('../income/business-income.js');
const {
  zeroMoney,
  inputMoney,
  masterMoney,
  masterRate,
  sumMoney,
  minMoney,
  floorMoneyAtZero,
  floorExactAtZero,
  findRange,
  moneyToExact,
  multiplyRateByMoney,
  subtractExact,
  addMoney,
  subtractMoney,
  applyRounding,
} = require('../income/helpers.js');

const LOCAL_TAX_ROUNDING_RULE_ID = 'R-TRUNC-100-LOCAL-TAX';

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

function jurisdictionOf(input, options) {
  return options.jurisdiction || input.jurisdiction || {};
}

function preflightBlockedReasons(input, options = {}) {
  const reasons = [];
  const jurisdiction = jurisdictionOf(input, options);
  if (!jurisdiction.municipalityCode) {
    addReason(reasons, 'RT_MUNICIPALITY_CODE_REQUIRED',
      '住民税の計算にはJIS X 0402の市区町村コード5桁が必要です');
  } else if (!/^[0-9]{5}$/.test(jurisdiction.municipalityCode)) {
    throw new RangeError('municipalityCode はJIS X 0402の5桁で指定してください');
  }
  if (typeof jurisdiction.isDesignatedCity !== 'boolean') {
    addReason(reasons, 'RT_DESIGNATED_CITY_STATUS_REQUIRED',
      '市民税・県民税の内訳には政令指定都市かどうかの判定結果が必要です');
  }

  const incomeItems = input.otherIncomes || input.incomeItems || [];
  incomeItems.forEach((item, index) => {
    if (item.category === 'unknown' || item.taxationMethod === 'unknown') {
      addReason(reasons, 'RT_INCOME_CLASSIFICATION_UNKNOWN',
        '所得区分または課税方式が不明な所得は計算できません', index);
      return;
    }
    if (item.taxationMethod !== 'aggregate') {
      addReason(reasons, 'RT_SEPARATE_TAXATION_UNSUPPORTED',
        '分離課税の所得は第1版の対象外です', index);
    }
    if (item.category !== 'salary' && item.category !== 'business') {
      addReason(reasons, 'RT_INCOME_CATEGORY_UNSUPPORTED',
        `所得区分 ${item.category} は第1版の対象外です`, index);
    }
  });
  if (presentUnsupportedValue(input.separateTaxationIncome) ||
      presentUnsupportedValue(input.separateIncomes) || input.hasSeparateTaxationIncome === true) {
    addReason(reasons, 'RT_SEPARATE_TAXATION_UNSUPPORTED', '分離課税の所得は第1版の対象外です');
  }
  if (presentUnsupportedValue(input.netLossCarryforward) ||
      presentUnsupportedValue(input.lossCarryforward) ||
      presentUnsupportedValue(input.priorYearNetLoss)) {
    addReason(reasons, 'RT_NET_LOSS_CARRYFORWARD_UNSUPPORTED',
      '純損失の繰越控除は第1版の対象外です');
  }
  if (presentUnsupportedValue(input.casualtyLossCarryforward) ||
      presentUnsupportedValue(input.priorYearCasualtyLoss)) {
    addReason(reasons, 'RT_CASUALTY_LOSS_CARRYFORWARD_UNSUPPORTED',
      '雑損失の繰越控除は第1版の対象外です');
  }
  return reasons;
}

function calculationCriteria(input, options) {
  if (options.onDate) {
    return { income: { onDate: options.onDate }, levy: { onDate: options.onDate } };
  }
  let incomeYear = options.incomeYear ?? input.incomeYear ?? input.previousYear ?? input.taxYear;
  let fiscalYear = options.residentTaxFiscalYear ?? input.residentTaxFiscalYear;
  if (!Number.isInteger(incomeYear) && Number.isInteger(fiscalYear)) incomeYear = fiscalYear - 1;
  if (!Number.isInteger(fiscalYear) && Number.isInteger(incomeYear)) fiscalYear = incomeYear;
  if (!Number.isInteger(incomeYear) || !Number.isInteger(fiscalYear)) {
    throw new TypeError('incomeYear（前年の所得年）または onDate を指定してください');
  }
  return { income: { taxYear: incomeYear }, levy: { taxYear: fiscalYear } };
}

function conditionValue(record, subject) {
  const condition = (record.applicability_conditions || []).find(item => item.subject === subject);
  return condition && condition.value;
}

function recordForCondition(valueKey, searchCriterion, subject, value) {
  return masters.find(valueKey, searchCriterion).find(record => conditionValue(record, subject) === value);
}

function requiredRecord(valueKey, searchCriterion, predicate = () => true) {
  const record = masters.find(valueKey, searchCriterion).find(predicate);
  if (!record) {
    const error = new Error(`住民税マスターが利用できません: ${valueKey}`);
    error.code = 'RT_MASTER_UNAVAILABLE';
    throw error;
  }
  return record;
}

function multiplyMoneyByCount(amount, count) {
  return applyRounding(
    multiplyRateByMoney({ num: BigInt(count), den: 1n }, amount),
    'R-NONE'
  );
}

function otherIncomeTotals(items) {
  return {
    salary: sumMoney(items.filter(item => item.category === 'salary')
      .map((item, index) => inputMoney(item.amount, `otherIncomes[${index}].amount`))),
    business: sumMoney(items.filter(item => item.category === 'business')
      .map((item, index) => inputMoney(item.amount, `otherIncomes[${index}].amount`))),
  };
}

function calculatePreviousYearIncome(input, incomeCriterion) {
  const direct = input.previousYearTotalIncome ?? input.totalIncome;
  if (direct !== undefined) {
    const totalIncome = inputMoney(direct, 'previousYearTotalIncome');
    if (totalIncome.value < 0n) throw new RangeError('前年の合計所得金額は0円以上で指定してください');
    return {
      status: 'complete',
      salary: null,
      business: null,
      salaryIncome: zeroMoney(),
      businessIncome: totalIncome,
      totalIncome,
      grossIncomeEtc: totalIncome,
      source: 'direct_total_income',
    };
  }

  const salaryRevenueSource = input.salaryRevenue ??
    (input.salary && (input.salary.revenue ?? input.salary.annualRevenue));
  const salary = salaryRevenueSource === undefined
    ? null
    : calculateSalaryIncome(salaryRevenueSource, incomeCriterion);
  const business = input.business
    ? calculateBusinessIncome(input.business, incomeCriterion)
    : null;
  if (business && business.status === 'blocked') {
    return {
      status: 'blocked',
      blockedReasons: business.blockedReasons.map(reason => ({
        ...reason,
        code: reason.code.replace(/^IT_/, 'RT_'),
      })),
    };
  }
  const otherTotals = otherIncomeTotals(input.otherIncomes || input.incomeItems || []);
  if (otherTotals.business.value < 0n) {
    return {
      status: 'blocked',
      blockedReasons: [{
        code: 'RT_BUSINESS_LOSS_OFFSET_UNSUPPORTED',
        message: '負の事業所得があるため、損益通算を扱えません',
      }],
    };
  }
  const salaryIncome = addMoney(salary ? salary.salaryIncome : zeroMoney(), otherTotals.salary);
  const businessIncome = addMoney(business ? business.businessIncome : zeroMoney(), otherTotals.business);
  const totalIncome = sumMoney([salaryIncome, businessIncome]);
  return {
    status: 'complete',
    salary,
    business,
    salaryIncome,
    businessIncome,
    totalIncome,
    grossIncomeEtc: totalIncome,
    source: 'income_components',
  };
}

function specialStatusApplies(input) {
  const self = input.self || input.officer || {};
  const deductions = input.deductions || {};
  const hasDisability = self.disability && self.disability !== 'none';
  const isMinor = self.isMinor === true || input.isMinor === true;
  const familyStatus = deductions.widowOrSingleParent;
  return hasDisability || isMinor || familyStatus === 'widow' || familyStatus === 'single_parent';
}

function sameLivelihoodSpouseCount(input) {
  const spouse = input.spouse;
  if (!spouse || spouse.exists === false) return 0;
  if (spouse.isSameLivelihood === false || spouse.isSameLivelihoodSpouse === false) return 0;
  return 1;
}

function dependentCountForExemption(input) {
  // 施行令47条の3の人数には、所得控除額が0円となる16歳未満の扶養親族も含める。
  return (input.dependents || []).filter(dependent =>
    dependent.countsForResidentTaxExemption !== false && dependent.isDependent !== false
  ).length;
}

function calculateExemption(input, totalIncome, searchCriterion) {
  const welfareRecord = requiredRecord('resident_tax_exemption_attribute', searchCriterion,
    record => record.exemption_category === 'welfare_recipient');
  const specialRecord = requiredRecord('resident_tax_exemption_attribute', searchCriterion,
    record => record.exemption_category === 'special_status');
  const self = input.self || input.officer || {};
  if (self.receivesWelfare === true || self.isWelfareRecipient === true ||
      input.receivesWelfare === true) {
    return {
      isExempt: true,
      reason: welfareRecord.exemption_category,
      threshold: null,
      usesStandardThreshold: false,
    };
  }
  const specialIncomeCap = masterMoney(specialRecord.income_upper_inclusive);
  if (specialStatusApplies(input) && totalIncome.value <= specialIncomeCap.value) {
    return {
      isExempt: true,
      reason: specialRecord.exemption_category,
      threshold: specialIncomeCap,
      usesStandardThreshold: false,
    };
  }

  const base = masterMoney(requiredRecord(
    'resident_tax_per_capita_exemption_base', searchCriterion
  ).threshold_amount);
  const flat = masterMoney(requiredRecord(
    'resident_tax_per_capita_exemption_flat', searchCriterion
  ).threshold_amount);
  const addition = masterMoney(requiredRecord(
    'resident_tax_per_capita_exemption_addition', searchCriterion
  ).threshold_amount);
  const spouseCount = sameLivelihoodSpouseCount(input);
  const dependentCount = dependentCountForExemption(input);
  const relativeCount = spouseCount + dependentCount;
  const personCount = relativeCount + 1;
  const threshold = sumMoney([
    multiplyMoneyByCount(base, personCount),
    flat,
    relativeCount > 0 ? addition : zeroMoney(),
  ]);
  return {
    isExempt: totalIncome.value <= threshold.value,
    reason: totalIncome.value <= threshold.value ? 'per_capita_threshold_standard' : null,
    threshold,
    usesStandardThreshold: true,
    personCount,
    sameLivelihoodSpouseCount: spouseCount,
    dependentCount,
  };
}

function socialInsuranceAmount(input) {
  if (!input) return zeroMoney();
  if (input.unit === 'JPY') return inputMoney(input, 'socialInsurance');
  if (input.kind === 'total') return inputMoney(input.annualTotal, 'socialInsurance.annualTotal');
  if (input.kind === 'itemized') {
    return sumMoney(['nationalHealthInsurance', 'nationalPension', 'nationalPensionFund',
      'employeeShareOfSocialInsurance', 'other']
      .map(key => inputMoney(input[key], `socialInsurance.${key}`)));
  }
  return inputMoney(input.annualAmount, 'socialInsurance.annualAmount');
}

function disabilityCategory(person) {
  if (!person || !person.disability || person.disability === 'none') return null;
  return person.disability === 'special_cohabiting' ? 'cohabiting_special' : person.disability;
}

function personalDeductionRecord(valueKey, searchCriterion, subject, value) {
  return requiredRecord(valueKey, searchCriterion, record =>
    subject === undefined || conditionValue(record, subject) === value
  );
}

function adjustmentDifferenceRecord(searchCriterion, suffix, taxpayerIncome) {
  const candidates = masters.find('resident_tax_adjustment_difference', searchCriterion)
    .filter(record => record.record_id.endsWith(suffix));
  if (candidates.length === 0) return null;
  if (candidates.some(record => record.income_lower_inclusive)) {
    return findRange(candidates, taxpayerIncome, 'income_lower_inclusive');
  }
  if (candidates.length > 1) throw new Error(`人的控除差マスターが重複しています: ${suffix}`);
  return candidates[0];
}

function spouseIncomeMatches(record, spouseIncome) {
  return (record.applicability_conditions || [])
    .filter(condition => condition.subject === 'spouse_total_income')
    .every(condition => {
      const boundary = masterMoney(condition.value);
      if (condition.operator === 'gte') return spouseIncome.value >= boundary.value;
      if (condition.operator === 'lte') return spouseIncome.value <= boundary.value;
      throw new Error(`未対応の配偶者所得条件です: ${condition.operator}`);
    });
}

function calculateSpouseDeduction(totalIncome, spouse, searchCriterion) {
  if (!spouse || spouse.exists === false || spouse.totalIncome === undefined) return null;
  const category = Number.isInteger(spouse.ageAtYearEnd) && spouse.ageAtYearEnd >= 70
    ? 'elderly'
    : 'general';
  const wantsSpecial = spouse.claimsSpouseSpecialDeduction === true ||
    spouse.deductionType === 'special';
  if (wantsSpecial) {
    const spouseIncome = inputMoney(spouse.totalIncome, 'spouse.totalIncome');
    const records = masters.find('resident_tax_deduction_spouse_special', searchCriterion)
      .filter(record => spouseIncomeMatches(record, spouseIncome));
    if (records.length === 0) return null;
    const record = findRange(records, totalIncome, 'income_lower_inclusive');
    return record ? { kind: 'spouseSpecial', category: record.deduction_category,
      amount: masterMoney(record.deduction_amount), differenceSuffix: null } : null;
  }
  const records = masters.find('resident_tax_deduction_spouse', searchCriterion)
    .filter(record => conditionValue(record, 'spouse_category') === category);
  const record = findRange(records, totalIncome, 'income_lower_inclusive');
  return record ? {
    kind: 'spouse',
    category,
    amount: masterMoney(record.deduction_amount),
    differenceSuffix: `SPOUSE-${record.record_id.match(/-T[1-4]-/)[0].slice(1, 3)}-${category.toUpperCase()}`,
  } : null;
}

function calculateDependentRows(dependents, searchCriterion) {
  const rows = [];
  const blockedReasons = [];
  for (const dependent of dependents) {
    if (dependent.claimsDependentDeduction === true &&
        dependent.claimsSpecificRelativeSpecialDeduction === true) {
      blockedReasons.push({
        code: 'RT_DEPENDENT_SPECIFIC_RELATIVE_OVERLAP',
        message: '同じ親族に扶養控除と特定親族特別控除を重複適用できません',
        personId: dependent.id,
      });
      continue;
    }
    const age = dependent.ageAtYearEnd;
    if (!Number.isInteger(age) || age < 16) {
      rows.push({ id: dependent.id, kind: 'dependent', category: 'under_16',
        amount: zeroMoney(), differenceSuffix: null });
      continue;
    }
    if (dependent.claimsSpecificRelativeSpecialDeduction === true) {
      const income = inputMoney(dependent.totalIncome, `${dependent.id || 'dependent'}.totalIncome`);
      const record = findRange(
        masters.find('resident_tax_deduction_specific_relative_special', searchCriterion),
        income,
        'income_lower_inclusive'
      );
      rows.push({ id: dependent.id, kind: 'specificRelativeSpecial',
        category: 'specific_relative_special',
        amount: record ? masterMoney(record.deduction_amount) : zeroMoney(), differenceSuffix: null });
      continue;
    }
    let category = 'general';
    if (age >= 19 && age < 23) category = 'specific';
    else if (age >= 70) {
      const directAscendant = dependent.relation === 'parent' || dependent.relation === 'grandparent';
      category = directAscendant && dependent.livesTogether === true
        ? 'elderly_cohabiting'
        : 'elderly_not_cohabiting';
    }
    const record = personalDeductionRecord(
      'resident_tax_deduction_dependent', searchCriterion, 'dependent_category', category
    );
    rows.push({ id: dependent.id, kind: 'dependent', category,
      amount: masterMoney(record.deduction_amount),
      differenceSuffix: `DEPENDENT-${category.replace('not_cohabiting', 'ELDERLY')
        .replace('elderly_cohabiting', 'ELDERLY-COHABITING').toUpperCase()}` });
  }
  return { rows, blockedReasons };
}

function insuranceInputPresent(items) {
  return Array.isArray(items) && items.some(item =>
    inputMoney(item.annualPremium, 'annualPremium').value > 0n
  );
}

function calculateResidentDeductions(input, totalIncome, searchCriterion) {
  const deductions = input.deductions || {};
  const warnings = [];
  const assumptions = [];
  const dependentResult = calculateDependentRows(input.dependents || [], searchCriterion);
  if (dependentResult.blockedReasons.length > 0) {
    return { status: 'blocked', blockedReasons: dependentResult.blockedReasons };
  }

  const basicRecord = requiredRecord('resident_tax_basic_deduction_table', searchCriterion,
    record => {
      if (!record.income_lower_inclusive) return false;
      const lower = masterMoney(record.income_lower_inclusive);
      const upper = record.income_upper_inclusive === null
        ? null
        : masterMoney(record.income_upper_inclusive);
      return totalIncome.value >= lower.value && (upper === null || totalIncome.value <= upper.value);
    });
  const basic = masterMoney(basicRecord.deduction_amount);
  const spouseRow = calculateSpouseDeduction(totalIncome, input.spouse, searchCriterion);
  const people = [input.self || input.officer, input.spouse, ...(input.dependents || [])];
  const disabilityRows = people.map((person, index) => ({ person, index,
    category: disabilityCategory(person) })).filter(row => row.category).map(row => {
    const record = personalDeductionRecord(
      'resident_tax_deduction_disability', searchCriterion, 'disability_category', row.category
    );
    return { personId: row.person.id, category: row.category,
      amount: masterMoney(record.deduction_amount),
      differenceSuffix: `DISABILITY-${row.category.replace('cohabiting_special', 'COHABITING').toUpperCase()}` };
  });
  const familyStatus = deductions.widowOrSingleParent;
  const widowOrSingleParent = familyStatus === 'widow'
    ? masterMoney(personalDeductionRecord('resident_tax_deduction_widow', searchCriterion).deduction_amount)
    : familyStatus === 'single_parent'
      ? masterMoney(personalDeductionRecord(
        'resident_tax_deduction_single_parent', searchCriterion
      ).deduction_amount)
      : zeroMoney();
  const workingStudent = deductions.isWorkingStudent
    ? masterMoney(personalDeductionRecord(
      'resident_tax_deduction_working_student', searchCriterion
    ).deduction_amount)
    : zeroMoney();

  const lifePresent = insuranceInputPresent(deductions.lifeInsurance);
  const earthquakePresent = insuranceInputPresent(deductions.earthquakeInsurance);
  if (lifePresent) {
    warnings.push({
      code: 'RT_LIFE_INSURANCE_DEDUCTION_UNREGISTERED',
      message: '住民税側の生命保険料控除表が未登録のため、当該控除は反映していません',
    });
    assumptions.push({
      code: 'RT_LIFE_INSURANCE_DEDUCTION_EXCLUDED',
      message: '生命保険料控除は所得税の控除額で代用せず、住民税マスター登録まで計算対象外としました',
    });
  }
  if (earthquakePresent) {
    warnings.push({
      code: 'RT_EARTHQUAKE_INSURANCE_DEDUCTION_UNREGISTERED',
      message: '住民税側の地震保険料控除表が未登録のため、当該控除は反映していません',
    });
    assumptions.push({
      code: 'RT_EARTHQUAKE_INSURANCE_DEDUCTION_EXCLUDED',
      message: '地震保険料控除は所得税の控除額で代用せず、住民税マスター登録まで計算対象外としました',
    });
  }

  const ordered = [
    ['socialInsurance', socialInsuranceAmount(deductions.socialInsurance)],
    ['smallEnterpriseMutualAid', inputMoney(
      deductions.smallEnterpriseMutualAid, 'smallEnterpriseMutualAid'
    )],
    ['widowOrSingleParent', widowOrSingleParent],
    ['workingStudent', workingStudent],
    ['disability', sumMoney(disabilityRows.map(row => row.amount))],
    ['spouse', spouseRow && spouseRow.kind === 'spouse' ? spouseRow.amount : zeroMoney()],
    ['spouseSpecial', spouseRow && spouseRow.kind === 'spouseSpecial' ? spouseRow.amount : zeroMoney()],
    ['specificRelativeSpecial', sumMoney(dependentResult.rows
      .filter(row => row.kind === 'specificRelativeSpecial').map(row => row.amount))],
    ['dependents', sumMoney(dependentResult.rows
      .filter(row => row.kind === 'dependent').map(row => row.amount))],
    ['basic', basic],
  ];
  return {
    status: 'complete',
    warnings,
    assumptions,
    deductions: {
      ...Object.fromEntries(ordered),
      lifeInsurance: lifePresent ? null : zeroMoney(),
      earthquakeInsurance: earthquakePresent ? null : zeroMoney(),
    },
    orderedDeductions: ordered.map(([code, amount], index) =>
      ({ calculationOrder: index + 1, code, amount })),
    totalDeduction: sumMoney(ordered.map(([, amount]) => amount)),
    spouseRow,
    dependentRows: dependentResult.rows,
    disabilityRows,
    familyStatus,
    workingStudentApplied: workingStudent.value > 0n,
  };
}

function adjustmentDifference(deductionResult, totalIncome, searchCriterion) {
  const applied = [];
  const warnings = [];
  function add(suffix, code, count = 1) {
    const record = adjustmentDifferenceRecord(searchCriterion, suffix, totalIncome);
    if (!record) {
      warnings.push({
        code: 'RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED',
        message: `${code}に対応する人的控除差が未登録のため、調整控除の基礎へ含めていません`,
        deductionCode: code,
      });
      return;
    }
    const amount = multiplyMoneyByCount(masterMoney(record.deduction_amount), count);
    applied.push({ code, masterRecordId: record.record_id, amount });
  }

  add('BASIC', 'basic');
  for (const row of deductionResult.disabilityRows) add(row.differenceSuffix, 'disability');
  if (deductionResult.familyStatus === 'widow') add('WIDOW', 'widow');
  if (deductionResult.familyStatus === 'single_parent') add('SINGLE-PARENT', 'singleParent');
  if (deductionResult.workingStudentApplied) add('WORKING-STUDENT', 'workingStudent');
  if (deductionResult.spouseRow) {
    if (deductionResult.spouseRow.differenceSuffix) {
      add(deductionResult.spouseRow.differenceSuffix, deductionResult.spouseRow.kind);
    } else if (deductionResult.spouseRow.amount.value > 0n) {
      warnings.push({
        code: 'RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED',
        message: '配偶者特別控除に対応する人的控除差が未登録のため、調整控除の基礎へ含めていません',
        deductionCode: 'spouseSpecial',
      });
    }
  }
  for (const row of deductionResult.dependentRows) {
    if (row.differenceSuffix && row.amount.value > 0n) add(row.differenceSuffix, row.kind);
    else if (row.kind === 'specificRelativeSpecial' && row.amount.value > 0n) {
      warnings.push({
        code: 'RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED',
        message: '特定親族特別控除に対応する人的控除差が未登録のため、調整控除の基礎へ含めていません',
        deductionCode: 'specificRelativeSpecial',
      });
    }
  }
  return { amount: sumMoney(applied.map(row => row.amount)), applied, warnings };
}

function designatedRecord(valueKey, searchCriterion, isDesignatedCity) {
  return requiredRecord(valueKey, searchCriterion, record =>
    conditionValue(record, 'is_designated_city') === isDesignatedCity
  );
}

function zeroTaxResult(base) {
  const zero = zeroMoney();
  return {
    ...base,
    taxableTotalIncomeBeforeRounding: zero,
    taxableTotalIncome: zero,
    adjustmentDifference: zero,
    adjustmentBase: zero,
    municipalIncomeLevyBeforeAdjustment: zero,
    prefecturalIncomeLevyBeforeAdjustment: zero,
    municipalAdjustmentDeduction: zero,
    prefecturalAdjustmentDeduction: zero,
    municipalIncomeLevy: zero,
    prefecturalIncomeLevy: zero,
    municipalPerCapitaLevy: zero,
    prefecturalPerCapitaLevy: zero,
    forestEnvironmentTax: zero,
    municipalTax: zero,
    prefecturalTax: zero,
    incomeLevyTotal: zero,
    perCapitaLevyTotal: zero,
    annualTaxTotal: zero,
    totalTax: zero,
  };
}

function calculate(input, options = {}) {
  const blockedReasons = preflightBlockedReasons(input, options);
  if (blockedReasons.length > 0) {
    return { status: 'blocked', blockedReasons, warnings: [], assumptions: [] };
  }
  const criteria = calculationCriteria(input, options);
  const incomeResult = calculatePreviousYearIncome(input, criteria.income);
  if (incomeResult.status === 'blocked') {
    return { status: 'blocked', blockedReasons: incomeResult.blockedReasons,
      warnings: [], assumptions: [] };
  }

  const assumptions = [{
    code: 'RT_INCOME_LEVY_EXEMPTION_THRESHOLD_UNREGISTERED',
    message: '所得割の非課税限度額（地方税法附則3条の3）は未登録のため、均等割が課税となる低所得帯では所得割が過大となる場合があります',
  }];

  try {
    const exemption = calculateExemption(input, incomeResult.totalIncome, criteria.income);
    if (exemption.usesStandardThreshold) {
      assumptions.push({
        code: 'RT_PER_CAPITA_EXEMPTION_STANDARD_AMOUNT',
        message: '均等割の非課税限度額は自治体固有額ではなく、級地で下がりうる標準額（上限）を使用しています',
      });
    }
    if (exemption.isExempt) {
      const warnings = exemption.reason === 'per_capita_threshold_standard'
        ? [{
          code: 'RT_EXEMPTION_STANDARD_AMOUNT_ESTIMATE',
          message: '均等割・所得割・森林環境税の非課税判定は標準額による概算です',
        }]
        : [];
      // 均等割の所得限度額は所得割の限度額より低いため、ここで均等割が
      // 非課税なら所得割も非課税となる安全側の包含関係が成立する。
      return zeroTaxResult({
        status: 'complete',
        blockedReasons: [],
        warnings,
        assumptions,
        ...incomeResult,
        exemption,
        incomeDeductions: {},
        orderedIncomeDeductions: [],
        totalIncomeDeductions: zeroMoney(),
      });
    }

    const deductionResult = calculateResidentDeductions(
      input, incomeResult.totalIncome, criteria.income
    );
    if (deductionResult.status === 'blocked') {
      return { status: 'blocked', blockedReasons: deductionResult.blockedReasons,
        warnings: [], assumptions };
    }
    const taxableBeforeRounding = floorMoneyAtZero(
      subtractMoney(incomeResult.grossIncomeEtc, deductionResult.totalDeduction)
    );
    const incomeRateRecord = designatedRecord(
      'resident_tax_income_rate', criteria.levy,
      jurisdictionOf(input, options).isDesignatedCity
    );
    const taxableTotalIncome = applyRounding(
      moneyToExact(taxableBeforeRounding), incomeRateRecord.rounding_rule_id
    );
    const difference = adjustmentDifference(
      deductionResult, incomeResult.totalIncome, criteria.income
    );
    const adjustmentRecord = designatedRecord(
      'resident_tax_adjustment_deduction_rate', criteria.levy,
      jurisdictionOf(input, options).isDesignatedCity
    );
    const threshold = masterMoney(adjustmentRecord.threshold_taxable_income);
    const minimumBase = masterMoney(adjustmentRecord.minimum_base_amount);
    const eligibilityCap = masterMoney(adjustmentRecord.eligibility_income_cap);
    let adjustmentBase = zeroMoney();
    if (taxableTotalIncome.value > 0n && incomeResult.totalIncome.value <= eligibilityCap.value) {
      adjustmentBase = taxableTotalIncome.value <= threshold.value
        ? minMoney(difference.amount, taxableTotalIncome)
        : floorMoneyAtZero(subtractMoney(
          difference.amount,
          subtractMoney(taxableTotalIncome, threshold)
        ));
      if (taxableTotalIncome.value > threshold.value && adjustmentBase.value < minimumBase.value) {
        adjustmentBase = minimumBase;
      }
    }

    const municipalRate = masterRate(incomeRateRecord.municipal_rate);
    const prefecturalRate = masterRate(incomeRateRecord.prefectural_rate);
    const municipalAdjustmentRate = masterRate(adjustmentRecord.municipal_rate);
    const prefecturalAdjustmentRate = masterRate(adjustmentRecord.prefectural_rate);
    const municipalGrossExact = multiplyRateByMoney(municipalRate, taxableTotalIncome);
    const prefecturalGrossExact = multiplyRateByMoney(prefecturalRate, taxableTotalIncome);
    const municipalAdjustmentExact = multiplyRateByMoney(
      municipalAdjustmentRate, adjustmentBase
    );
    const prefecturalAdjustmentExact = multiplyRateByMoney(
      prefecturalAdjustmentRate, adjustmentBase
    );
    const municipalIncomeLevy = applyRounding(
      floorExactAtZero(subtractExact(municipalGrossExact, municipalAdjustmentExact)),
      LOCAL_TAX_ROUNDING_RULE_ID
    );
    const prefecturalIncomeLevy = applyRounding(
      floorExactAtZero(subtractExact(prefecturalGrossExact, prefecturalAdjustmentExact)),
      LOCAL_TAX_ROUNDING_RULE_ID
    );
    const municipalPerCapitaLevy = masterMoney(requiredRecord(
      'resident_tax_per_capita_municipal', criteria.levy
    ).amount);
    const prefecturalPerCapitaLevy = masterMoney(requiredRecord(
      'resident_tax_per_capita_prefectural', criteria.levy
    ).amount);
    const forestEnvironmentTax = masterMoney(requiredRecord(
      'forest_environment_tax', criteria.levy
    ).amount);
    const municipalTax = addMoney(municipalIncomeLevy, municipalPerCapitaLevy);
    const prefecturalTax = addMoney(prefecturalIncomeLevy, prefecturalPerCapitaLevy);
    const incomeLevyTotal = addMoney(municipalIncomeLevy, prefecturalIncomeLevy);
    const perCapitaLevyTotal = addMoney(municipalPerCapitaLevy, prefecturalPerCapitaLevy);
    const annualTaxTotal = sumMoney([municipalTax, prefecturalTax, forestEnvironmentTax]);

    return {
      status: 'complete',
      blockedReasons: [],
      warnings: [...deductionResult.warnings, ...difference.warnings],
      assumptions: [...assumptions, ...deductionResult.assumptions],
      ...incomeResult,
      exemption,
      incomeDeductions: deductionResult.deductions,
      orderedIncomeDeductions: deductionResult.orderedDeductions,
      totalIncomeDeductions: deductionResult.totalDeduction,
      deductionDetails: {
        spouse: deductionResult.spouseRow,
        dependents: deductionResult.dependentRows,
        disabilities: deductionResult.disabilityRows,
      },
      taxableTotalIncomeBeforeRounding: taxableBeforeRounding,
      taxableTotalIncome,
      adjustmentDifference: difference.amount,
      adjustmentDifferenceDetails: difference.applied,
      adjustmentBase,
      municipalIncomeLevyBeforeAdjustment: applyRounding(municipalGrossExact, 'R-NONE'),
      prefecturalIncomeLevyBeforeAdjustment: applyRounding(prefecturalGrossExact, 'R-NONE'),
      municipalAdjustmentDeduction: applyRounding(municipalAdjustmentExact, 'R-NONE'),
      prefecturalAdjustmentDeduction: applyRounding(prefecturalAdjustmentExact, 'R-NONE'),
      municipalIncomeLevy,
      prefecturalIncomeLevy,
      municipalPerCapitaLevy,
      prefecturalPerCapitaLevy,
      forestEnvironmentTax,
      municipalTax,
      prefecturalTax,
      incomeLevyTotal,
      perCapitaLevyTotal,
      annualTaxTotal,
      totalTax: annualTaxTotal,
    };
  } catch (error) {
    if (error.code !== 'RT_MASTER_UNAVAILABLE') throw error;
    return {
      status: 'blocked',
      blockedReasons: [{ code: error.code, message: error.message }],
      warnings: [],
      assumptions,
    };
  }
}

module.exports = {
  calculate,
  preflightBlockedReasons,
  calculateExemption,
};
