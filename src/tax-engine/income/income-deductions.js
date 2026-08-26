'use strict';

/**
 * 所得控除。判定基準の合計所得金額と、足切り基準の総所得金額等を混同しない。
 */

const masters = require('../masters/snapshot.js');
const {
  zeroMoney,
  inputMoney,
  masterMoney,
  sumMoney,
  minMoney,
  maxMoney,
  criterion,
  findRange,
  calculateTierAmount,
  applyRateToMoney,
  addMoney,
  subtractMoney,
  subtractMoneyFloorZero,
} = require('./helpers.js');

const LIFE_CATEGORIES = Object.freeze(['life', 'nursing_medical', 'annuity']);

function categoryCondition(record, subject) {
  const condition = (record.applicability_conditions || []).find(item => item.subject === subject);
  return condition && condition.value;
}

function deductionAmountRecord(valueKey, searchCriterion, predicate = () => true) {
  const record = masters.find(valueKey, searchCriterion).find(predicate);
  if (!record) throw new Error(`所得控除マスターが利用できません: ${valueKey}`);
  return masterMoney(record.deduction_amount);
}

function calculateBasicDeduction(totalIncome, options = {}) {
  const checkedIncome = inputMoney(totalIncome, 'totalIncome');
  const records = masters.find('basic_deduction_table', criterion(options));
  const record = findRange(records, checkedIncome, 'income_lower_inclusive');
  if (!record) throw new Error(`基礎控除表に該当行がありません: ${checkedIncome.value}`);
  return masterMoney(record.deduction_amount);
}

function calculateSpouseDeduction(totalIncome, spouse, options = {}) {
  if (!spouse || spouse.exists === false || spouse.totalIncome === undefined) return zeroMoney();
  const taxpayerTotalIncome = inputMoney(totalIncome, 'totalIncome');
  const spouseTotalIncome = inputMoney(spouse.totalIncome, 'spouse.totalIncome');
  const searchCriterion = criterion(options);
  const specialRecords = masters.find('income_deduction_spouse_special', searchCriterion);
  const firstSpecialLower = specialRecords
    .flatMap(record => record.applicability_conditions || [])
    .filter(condition => condition.subject === 'spouse_total_income' && condition.operator === 'gte')
    .map(condition => masterMoney(condition.value))
    .reduce((lowest, value) => value.value < lowest.value ? value : lowest);
  const spouseDeductionCeiling = inputMoney(firstSpecialLower.value - 1n);
  if (spouseTotalIncome.value > spouseDeductionCeiling.value) return zeroMoney();

  const spouseCategory = Number.isInteger(spouse.ageAtYearEnd) && spouse.ageAtYearEnd >= 70
    ? 'elderly'
    : 'general';
  const records = masters.find('income_deduction_spouse', searchCriterion).filter(record =>
    categoryCondition(record, 'spouse_category') === spouseCategory
  );
  const record = findRange(records, taxpayerTotalIncome, 'income_lower_inclusive');
  return record ? masterMoney(record.deduction_amount) : zeroMoney();
}

function spouseIncomeMatches(record, spouseTotalIncome) {
  return (record.applicability_conditions || []).filter(condition =>
    condition.subject === 'spouse_total_income'
  ).every(condition => {
    const boundary = masterMoney(condition.value);
    if (condition.operator === 'gte') return spouseTotalIncome.value >= boundary.value;
    if (condition.operator === 'lte') return spouseTotalIncome.value <= boundary.value;
    throw new Error(`未対応の配偶者所得条件です: ${condition.operator}`);
  });
}

function calculateSpouseSpecialDeduction(totalIncome, spouse, options = {}) {
  if (!spouse || spouse.exists === false || spouse.totalIncome === undefined) return zeroMoney();
  const taxpayerTotalIncome = inputMoney(totalIncome, 'totalIncome');
  const spouseTotalIncome = inputMoney(spouse.totalIncome, 'spouse.totalIncome');
  const records = masters.find('income_deduction_spouse_special', criterion(options)).filter(record =>
    spouseIncomeMatches(record, spouseTotalIncome)
  );
  if (records.length === 0) return zeroMoney();
  const record = findRange(records, taxpayerTotalIncome, 'income_lower_inclusive');
  return record ? masterMoney(record.deduction_amount) : zeroMoney();
}

function dependentRecord(category, searchCriterion) {
  return masters.find('income_deduction_dependent', searchCriterion).find(record =>
    categoryCondition(record, 'dependent_category') === category
  );
}

function specificRelativeIncomeCeiling(searchCriterion) {
  const records = masters.find('income_deduction_specific_relative_special', searchCriterion);
  const zeroTier = records.find(record => record.calculation_order === 0);
  if (!zeroTier) throw new Error('特定親族特別控除の所得要件を取得できません');
  return masterMoney(zeroTier.income_upper_inclusive);
}

function claimsBothDependentDeductions(dependent) {
  return dependent.claimsDependentDeduction === true &&
    dependent.claimsSpecificRelativeSpecialDeduction === true;
}

function calculateDependentDeductions(dependents = [], options = {}) {
  const searchCriterion = criterion(options);
  const dependentIncomeCeiling = specificRelativeIncomeCeiling(searchCriterion);
  const blockedReasons = [];
  const rows = [];

  for (const dependent of dependents) {
    const id = dependent.id;
    if (claimsBothDependentDeductions(dependent)) {
      blockedReasons.push({
        code: 'IT_DEPENDENT_SPECIFIC_RELATIVE_OVERLAP',
        message: '同じ親族に扶養控除と特定親族特別控除を重複適用できません',
        personId: id,
      });
      continue;
    }
    const age = dependent.ageAtYearEnd;
    if (!Number.isInteger(age) || age < 16) {
      rows.push({ id, kind: 'dependent', category: 'under_16', amount: zeroMoney() });
      continue;
    }
    const relativeIncome = inputMoney(dependent.totalIncome, `${id || 'dependent'}.totalIncome`);

    if (age >= 19 && age < 23 && relativeIncome.value > dependentIncomeCeiling.value) {
      const record = findRange(
        masters.find('income_deduction_specific_relative_special', searchCriterion),
        relativeIncome,
        'income_lower_inclusive'
      );
      rows.push({
        id,
        kind: 'specific_relative_special',
        category: 'specific_relative_special',
        amount: record ? masterMoney(record.deduction_amount) : zeroMoney(),
      });
      continue;
    }
    if (relativeIncome.value > dependentIncomeCeiling.value) {
      rows.push({ id, kind: 'dependent', category: 'income_over_limit', amount: zeroMoney() });
      continue;
    }

    let category = 'general';
    if (age >= 19 && age < 23) category = 'specific';
    else if (age >= 70) {
      const isDirectAscendant = dependent.relation === 'parent' || dependent.relation === 'grandparent';
      category = isDirectAscendant && dependent.livesTogether === true
        ? 'elderly_cohabiting'
        : 'elderly_not_cohabiting';
    }
    const record = dependentRecord(category, searchCriterion);
    if (!record) throw new Error(`扶養控除マスターに区分がありません: ${category}`);
    rows.push({ id, kind: 'dependent', category, amount: masterMoney(record.deduction_amount) });
  }

  return {
    status: blockedReasons.length > 0 ? 'blocked' : 'complete',
    blockedReasons,
    rows,
    total: sumMoney(rows.map(row => row.amount)),
  };
}

function premiumTotal(premiums, generation, category) {
  return sumMoney(premiums.filter(item => item.generation === generation && item.category === category)
    .map(item => inputMoney(item.annualPremium, 'lifeInsurance.annualPremium')));
}

function tierDeduction(valueKey, premium, searchCriterion) {
  const records = masters.find(valueKey, searchCriterion);
  const record = findRange(records, premium, 'premium_lower_inclusive');
  if (!record) throw new Error(`保険料控除表に該当行がありません: ${valueKey}`);
  return calculateTierAmount(premium, record);
}

function fixedTierCap(valueKey, searchCriterion) {
  const fixed = masters.find(valueKey, searchCriterion)
    .filter(record => record.deduction_type === 'fixed')
    .map(record => masterMoney(record.fixed_amount));
  if (fixed.length === 0) throw new Error(`保険料控除の上限を取得できません: ${valueKey}`);
  return fixed.reduce((highest, value) => maxMoney(highest, value));
}

function calculateLifeInsuranceDeduction(premiums = [], options = {}) {
  const searchCriterion = criterion(options);
  if (premiums.some(item => item.generation === 'old' && item.category === 'nursing_medical')) {
    throw new RangeError('旧契約に介護医療保険料区分はありません');
  }
  const newCategoryCap = fixedTierCap('life_insurance_deduction_new', searchCriterion);
  const overallCap = sumMoney(LIFE_CATEGORIES.map(() => newCategoryCap));
  const rows = LIFE_CATEGORIES.map(category => {
    const newPremium = premiumTotal(premiums, 'new', category);
    const oldPremium = category === 'nursing_medical'
      ? zeroMoney()
      : premiumTotal(premiums, 'old', category);
    const newDeduction = tierDeduction('life_insurance_deduction_new', newPremium, searchCriterion);
    const oldDeduction = category === 'nursing_medical'
      ? zeroMoney()
      : tierDeduction('life_insurance_deduction_old', oldPremium, searchCriterion);
    const combinedUnderNewCap = minMoney(addMoney(newDeduction, oldDeduction), newCategoryCap);
    return {
      category,
      newPremium,
      oldPremium,
      newDeduction,
      oldDeduction,
      amount: maxMoney(oldDeduction, combinedUnderNewCap),
    };
  });
  return {
    rows,
    overallCap,
    amount: minMoney(sumMoney(rows.map(row => row.amount)), overallCap),
  };
}

function calculateEarthquakeInsuranceDeduction(premiums = [], options = {}) {
  const searchCriterion = criterion(options);
  const records = masters.find('earthquake_insurance_deduction', searchCriterion);
  const normalized = premiums.map(item => ({
    category: item.category === 'old_long_term' ? 'long_term_casualty' : item.category,
    annualPremium: inputMoney(item.annualPremium, 'earthquakeInsurance.annualPremium'),
  }));
  const categories = ['earthquake', 'long_term_casualty'];
  const rows = categories.map(category => {
    const premium = sumMoney(normalized.filter(item => item.category === category)
      .map(item => item.annualPremium));
    const categoryRecords = records.filter(record => categoryCondition(record, 'insurance_category') === category);
    const record = findRange(categoryRecords, premium, 'premium_lower_inclusive');
    if (!record) throw new Error(`地震保険料控除表に該当行がありません: ${category}`);
    return { category, premium, amount: calculateTierAmount(premium, record) };
  });
  const overallCap = fixedTierCap('earthquake_insurance_deduction', searchCriterion);
  return { rows, overallCap, amount: minMoney(sumMoney(rows.map(row => row.amount)), overallCap) };
}

function medicalInputs(deductions) {
  const inputs = [];
  if (deductions.medical) {
    if (Array.isArray(deductions.medical)) inputs.push(...deductions.medical);
    else inputs.push(deductions.medical);
  }
  if (deductions.selfMedication) inputs.push({ ...deductions.selfMedication, mode: 'self_medication' });
  return inputs;
}

function hasMedicalConflict(deductions = {}) {
  return new Set(medicalInputs(deductions).map(item => item.mode || 'medical')).size > 1;
}

function calculateMedicalDeduction(deductions, grossIncomeEtc, options = {}) {
  const inputs = medicalInputs(deductions);
  if (inputs.length === 0) return zeroMoney();
  if (hasMedicalConflict(deductions)) return zeroMoney();
  const item = inputs[0];
  const mode = item.mode || 'medical';
  const paid = inputMoney(item.paidAmount, 'medical.paidAmount');
  const reimbursement = inputMoney(item.insuranceReimbursement, 'medical.insuranceReimbursement');
  const netPaid = subtractMoneyFloorZero(paid, reimbursement);
  const searchCriterion = criterion(options);

  if (mode === 'self_medication') {
    const floor = masterMoney(masters.find('self_medication_deduction_floor', searchCriterion)[0].threshold_amount);
    const cap = masterMoney(masters.find('self_medication_deduction_cap', searchCriterion)[0].threshold_amount);
    return minMoney(subtractMoneyFloorZero(netPaid, floor), cap);
  }

  const grossIncome = inputMoney(grossIncomeEtc, 'grossIncomeEtc');
  const floorRecords = masters.find('medical_expense_deduction_floor', searchCriterion);
  const fixedFloorRecord = floorRecords.find(record => record.threshold_amount);
  const rateFloorRecord = floorRecords.find(record => record.rate);
  const fixedFloor = masterMoney(fixedFloorRecord.threshold_amount);
  const rateFloor = applyRateToMoney(grossIncome, rateFloorRecord.rate, rateFloorRecord.rounding_rule_id);
  const floor = minMoney(fixedFloor, rateFloor);
  const cap = masterMoney(masters.find('medical_expense_deduction_cap', searchCriterion)[0].threshold_amount);
  return minMoney(subtractMoneyFloorZero(netPaid, floor), cap);
}

function calculateCasualtyLossDeduction(deductions, grossIncomeEtc, options = {}) {
  const source = deductions.casualtyLossDetails || deductions.casualtyLoss;
  if (!source) return zeroMoney();
  const netLoss = source.unit === 'JPY'
    ? inputMoney(source, 'casualtyLoss')
    : inputMoney(source.netLossAmount ?? source.lossAfterReimbursement, 'casualtyLoss.netLossAmount');
  const disasterExpenses = source.unit === 'JPY'
    ? inputMoney(deductions.disasterRelatedExpenses, 'disasterRelatedExpenses')
    : inputMoney(source.disasterRelatedExpenses, 'casualtyLoss.disasterRelatedExpenses');
  const searchCriterion = criterion(options);
  const ratioRecord = masters.find('casualty_loss_income_floor_rate', searchCriterion)[0];
  const disasterRecord = masters.find('casualty_loss_disaster_expense_floor', searchCriterion)[0];
  const incomeFloor = applyRateToMoney(
    inputMoney(grossIncomeEtc, 'grossIncomeEtc'),
    ratioRecord.rate,
    ratioRecord.rounding_rule_id
  );
  const disasterFloor = masterMoney(disasterRecord.threshold_amount);
  return maxMoney(
    subtractMoneyFloorZero(netLoss, incomeFloor),
    subtractMoneyFloorZero(disasterExpenses, disasterFloor)
  );
}

function calculateDonationDeduction(donations = [], grossIncomeEtc, options = {}) {
  const totalDonations = sumMoney(donations.map(item =>
    inputMoney(item.amount === undefined ? item : item.amount, 'donations.amount')
  ));
  const searchCriterion = criterion(options);
  const incomeCapRecord = masters.find('donation_deduction_income_cap_rate', searchCriterion)
    .find(record => record.tax_or_insurance_type === 'income_tax');
  const floorRecord = masters.find('donation_deduction_floor', searchCriterion)
    .find(record => record.tax_or_insurance_type === 'income_tax');
  const incomeCap = applyRateToMoney(
    inputMoney(grossIncomeEtc, 'grossIncomeEtc'),
    incomeCapRecord.rate,
    incomeCapRecord.rounding_rule_id
  );
  return subtractMoneyFloorZero(
    minMoney(totalDonations, incomeCap),
    masterMoney(floorRecord.threshold_amount)
  );
}

function socialInsuranceAmount(input) {
  if (!input) return zeroMoney();
  if (input.unit === 'JPY') return inputMoney(input, 'socialInsurance');
  if (input.kind === 'total') return inputMoney(input.annualTotal, 'socialInsurance.annualTotal');
  if (input.kind === 'itemized') {
    return sumMoney(['nationalHealthInsurance', 'nationalPension', 'nationalPensionFund',
      'employeeShareOfSocialInsurance', 'other'].map(key => inputMoney(input[key], `socialInsurance.${key}`)));
  }
  return inputMoney(input.annualAmount, 'socialInsurance.annualAmount');
}

function disabilityAmount(person, searchCriterion) {
  if (!person || !person.disability || person.disability === 'none') return zeroMoney();
  const category = person.disability === 'special_cohabiting' ? 'cohabiting_special' : person.disability;
  return deductionAmountRecord('income_deduction_disability', searchCriterion, record =>
    categoryCondition(record, 'disability_category') === category
  );
}

function calculateIncomeDeductions(input, options = {}) {
  const searchCriterion = criterion(options);
  const totalIncome = inputMoney(input.totalIncome, 'totalIncome');
  const grossIncomeEtc = inputMoney(input.grossIncomeEtc, 'grossIncomeEtc');
  const deductions = input.deductions || {};
  const blockedReasons = [];
  if (hasMedicalConflict(deductions)) {
    blockedReasons.push({
      code: 'IT_MEDICAL_DEDUCTION_ELECTION_CONFLICT',
      message: '医療費控除とセルフメディケーション税制は選択制であり、併用できません',
    });
  }
  const dependentResult = calculateDependentDeductions(input.dependents || [], options);
  blockedReasons.push(...dependentResult.blockedReasons);
  if (blockedReasons.length > 0) {
    return { status: 'blocked', blockedReasons, deductions: {}, totalDeduction: zeroMoney() };
  }

  const spouseDeduction = calculateSpouseDeduction(totalIncome, input.spouse, options);
  const spouseSpecialDeduction = spouseDeduction.value > 0n
    ? zeroMoney()
    : calculateSpouseSpecialDeduction(totalIncome, input.spouse, options);
  const lifeInsurance = calculateLifeInsuranceDeduction(deductions.lifeInsurance || [], options);
  const earthquakeInsurance = calculateEarthquakeInsuranceDeduction(
    deductions.earthquakeInsurance || [],
    options
  );
  const disabilityPeople = [input.self, input.spouse, ...(input.dependents || [])];
  const disability = sumMoney(disabilityPeople.map(person => disabilityAmount(person, searchCriterion)));
  const widowOrSingleParent = deductions.widowOrSingleParent === 'widow'
    ? deductionAmountRecord('income_deduction_widow', searchCriterion)
    : deductions.widowOrSingleParent === 'single_parent'
      ? deductionAmountRecord('income_deduction_single_parent', searchCriterion)
      : zeroMoney();
  const workingStudent = deductions.isWorkingStudent
    ? deductionAmountRecord('income_deduction_working_student', searchCriterion)
    : zeroMoney();

  // 雑損控除を必ず先頭に置く。返却順も計算順を表す。
  const ordered = [
    ['casualtyLoss', calculateCasualtyLossDeduction(deductions, grossIncomeEtc, options)],
    ['medical', calculateMedicalDeduction(deductions, grossIncomeEtc, options)],
    ['socialInsurance', socialInsuranceAmount(deductions.socialInsurance)],
    ['smallEnterpriseMutualAid', inputMoney(deductions.smallEnterpriseMutualAid, 'smallEnterpriseMutualAid')],
    ['lifeInsurance', lifeInsurance.amount],
    ['earthquakeInsurance', earthquakeInsurance.amount],
    ['donations', calculateDonationDeduction(deductions.donations || [], grossIncomeEtc, options)],
    ['widowOrSingleParent', widowOrSingleParent],
    ['workingStudent', workingStudent],
    ['disability', disability],
    ['spouse', spouseDeduction],
    ['spouseSpecial', spouseSpecialDeduction],
    ['dependents', dependentResult.total],
    ['basic', calculateBasicDeduction(totalIncome, options)],
  ];
  const deductionBreakdown = Object.fromEntries(ordered);
  return {
    status: 'complete',
    blockedReasons: [],
    deductions: deductionBreakdown,
    orderedDeductions: ordered.map(([code, amount], index) => ({ calculationOrder: index + 1, code, amount })),
    totalDeduction: sumMoney(ordered.map(([, amount]) => amount)),
    dependentRows: dependentResult.rows,
    lifeInsuranceRows: lifeInsurance.rows,
    earthquakeInsuranceRows: earthquakeInsurance.rows,
  };
}

module.exports = {
  calculate: calculateIncomeDeductions,
  calculateIncomeDeductions,
  calculateBasicDeduction,
  calculateSpouseDeduction,
  calculateSpouseSpecialDeduction,
  calculateDependentDeductions,
  calculateLifeInsuranceDeduction,
  calculateEarthquakeInsuranceDeduction,
  calculateMedicalDeduction,
  calculateCasualtyLossDeduction,
  calculateDonationDeduction,
  hasMedicalConflict,
};
