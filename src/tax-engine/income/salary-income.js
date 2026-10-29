'use strict';

/**
 * 給与所得。660万円未満は所得税法別表第五、以上は給与所得控除表を使う。
 */

const masters = require('../masters/snapshot.js');
const {
  inputMoney,
  masterMoney,
  masterRate,
  criterion,
  findRange,
  moneyToExact,
  multiplyRateByMoney,
  addExact,
  subtractExact,
  subtractMoney,
  applyRounding,
} = require('./helpers.js');

function calculateDeductionFromTable(salaryRevenue, valueKey, searchCriterion) {
  const records = masters.find(valueKey, searchCriterion);
  const record = findRange(records, salaryRevenue, 'revenue_lower_inclusive');
  if (!record) throw new Error(`給与所得控除表に該当行がありません: ${salaryRevenue.value}`);

  if (record.deduction_type === 'fixed') {
    return { exactDeduction: moneyToExact(masterMoney(record.fixed_amount)), record };
  }
  if (record.deduction_type !== 'formula') {
    throw new Error(`未対応の給与所得控除方式です: ${record.deduction_type}`);
  }
  const exactDeduction = addExact(
    multiplyRateByMoney(masterRate(record.rate), salaryRevenue),
    moneyToExact(masterMoney(record.rate_addition))
  );
  return { exactDeduction, record };
}

function calculateFromAppendix5(salaryRevenue, searchCriterion) {
  const records = masters.find('salary_income_after_deduction_appendix5', searchCriterion);
  const record = findRange(records, salaryRevenue, 'revenue_lower_inclusive');
  if (!record) throw new Error(`別表第五に該当行がありません: ${salaryRevenue.value}`);

  if (record.method === 'fixed_result') {
    return { salaryIncome: masterMoney(record.fixed_result), record };
  }
  if (record.method === 'subtract_fixed') {
    return { salaryIncome: subtractMoney(salaryRevenue, masterMoney(record.subtract_amount)), record };
  }
  if (record.method === 'rate_minus_fixed') {
    const exactIncome = subtractExact(
      multiplyRateByMoney(masterRate(record.rate), salaryRevenue),
      moneyToExact(masterMoney(record.subtract_amount))
    );
    return { salaryIncome: applyRounding(exactIncome, record.rounding_rule_id), record };
  }
  if (record.method === 'floor_to_band_then_deduction_table') {
    const bandStep = masterMoney(record.band_step);
    const bandLower = inputMoney(
      (salaryRevenue.value / bandStep.value) * bandStep.value,
      'salaryRevenue'
    );
    const { exactDeduction, record: deductionRecord } = calculateDeductionFromTable(
      bandLower,
      record.deduction_table_value_key,
      searchCriterion
    );
    return {
      salaryIncome: applyRounding(
        subtractExact(moneyToExact(bandLower), exactDeduction),
        deductionRecord.rounding_rule_id
      ),
      record,
      bandLower,
    };
  }
  throw new Error(`未対応の別表第五計算方式です: ${record.method}`);
}

function calculateSalaryIncome(revenue, options = {}) {
  const salaryRevenue = inputMoney(revenue, 'salaryRevenue');
  if (salaryRevenue.value < 0n) throw new RangeError('salaryRevenue は0円以上で指定してください');
  const searchCriterion = criterion(options);
  const appendixRecords = masters.find('salary_income_after_deduction_appendix5', searchCriterion);
  const bandRule = appendixRecords.find(record => record.method === 'floor_to_band_then_deduction_table');
  if (!bandRule) throw new Error('別表第五の帯規則が利用できません');
  const tableBoundary = masterMoney(bandRule.revenue_upper_inclusive).value + 1n;

  if (salaryRevenue.value < tableBoundary) {
    const appendix = calculateFromAppendix5(salaryRevenue, searchCriterion);
    return {
      salaryRevenue,
      salaryIncomeDeduction: subtractMoney(salaryRevenue, appendix.salaryIncome),
      salaryIncome: appendix.salaryIncome,
      calculationMethod: 'appendix5',
      bandLower: appendix.bandLower || null,
      masterRecordId: appendix.record.record_id,
    };
  }

  const { exactDeduction, record } = calculateDeductionFromTable(
    salaryRevenue,
    'salary_income_deduction_table',
    searchCriterion
  );
  // 給与所得の金額を計算してから1円未満を切り捨てる（国税庁『年末調整のしかた』
  // 電子計算機等による年末調整（注）2、所得税法別表第五の備考、
  // 確定申告の手引きの給与所得金額の計算表）。
  // 給与所得控除額を先に切り捨てると給与所得が1円多くなる（台帳 C-12）。
  const salaryIncome = applyRounding(
    subtractExact(moneyToExact(salaryRevenue), exactDeduction),
    record.rounding_rule_id
  );
  return {
    salaryRevenue,
    salaryIncomeDeduction: subtractMoney(salaryRevenue, salaryIncome),
    salaryIncome,
    calculationMethod: 'deduction_table',
    bandLower: null,
  };
}

function calculateSalaryIncomeDeduction(revenue, options = {}) {
  return calculateSalaryIncome(revenue, options).salaryIncomeDeduction;
}

module.exports = {
  calculate: calculateSalaryIncome,
  calculateSalaryIncome,
  calculateSalaryIncomeDeduction,
};
