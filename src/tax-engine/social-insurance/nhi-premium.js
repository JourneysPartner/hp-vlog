'use strict';

/**
 * 国民健康保険料の市町村別概算（第1版）。
 * 前年所得は世帯合算の1額を受け取り、所得割は世帯の賦課基準額に対して計算する。
 */

const masters = require('../masters/snapshot.js');
const {
  money,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  addMoney,
  subtractMoney,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');

function zeroMoney() {
  return money({ unit: 'JPY', value: 0n });
}

function inputMoney(value, fieldName) {
  if (typeof value === 'bigint') return money({ unit: 'JPY', value });
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (value && value.unit === 'JPY' && typeof value.value === 'string' && /^[0-9]+$/.test(value.value)) {
    return money({ unit: 'JPY', value: BigInt(value.value) });
  }
  try {
    return money(value);
  } catch (error) {
    error.message = `${fieldName}: ${error.message}`;
    throw error;
  }
}

function masterMoney(value) {
  return money({ unit: value.unit, value: BigInt(value.value) });
}

function masterRate(value) {
  return rate({ num: BigInt(value.num), den: BigInt(value.den) });
}

function sumMoney(values) {
  return values.reduce((total, value) => addMoney(total, value), zeroMoney());
}

function floorAtZero(value) {
  return value.value < 0n ? zeroMoney() : value;
}

function minMoney(left, right) {
  return left.value <= right.value ? left : right;
}

function multiplyMoneyByCount(value, count) {
  return applyRounding(
    multiplyRateByMoney(rate({ num: BigInt(count), den: 1n }), value),
    'R-NONE'
  );
}

function blocked(code, message, details = {}) {
  return { code, message, ...details };
}

function readInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input はオブジェクトで指定してください');
  }
  const municipalityCode = String(input.municipalityCode ?? input.municipality_code ?? '');
  if (!/^[0-9]{5}$/.test(municipalityCode)) {
    throw new RangeError('municipalityCode はJIS X 0402の5桁で指定してください');
  }
  const taxYear = input.taxYear ?? input.fiscalYear ?? input.year;
  if (!Number.isInteger(taxYear) || taxYear < 1 || taxYear > 9999) {
    throw new RangeError('taxYear は1から9999までの整数で指定してください');
  }
  const totalIncome = inputMoney(
    input.previousYearTotalIncome ?? input.totalIncome ?? input.previous_year_total_income,
    'previousYearTotalIncome'
  );
  if (totalIncome.value < 0n) throw new RangeError('previousYearTotalIncome は0円以上で指定してください');

  const rawAges = input.insuredAges ?? input.ages ??
    (input.age === undefined ? undefined : [input.age]);
  if (!Array.isArray(rawAges) || rawAges.length === 0) {
    throw new TypeError('insuredAges は各被保険者の年齢を1件以上指定してください');
  }
  const insuredAges = rawAges.map((age, index) => {
    if (!Number.isInteger(age) || age < 0 || age > 150) {
      throw new RangeError(`insuredAges[${index}] は0以上150以下の整数で指定してください`);
    }
    return age;
  });
  const insuredCount = input.insuredCount ?? input.insured_count ?? insuredAges.length;
  if (!Number.isInteger(insuredCount) || insuredCount < 1) {
    throw new RangeError('insuredCount は1以上の整数で指定してください');
  }
  if (insuredCount !== insuredAges.length) {
    throw new RangeError('insuredCount と insuredAges の件数を一致させてください');
  }
  return { municipalityCode, taxYear, totalIncome, insuredAges, insuredCount };
}

function uniqueRecord(records, label, predicate = () => true) {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(`${label}の適用レコードが重複しています`);
  return matches[0] || null;
}

function reductionContext(totalIncome, insuredCount, criterion) {
  const baseRecord = uniqueRecord(
    masters.find('national_health_insurance_reduction_base_amount', criterion),
    '国保軽減基準額'
  );
  const tierRecords = masters.find('national_health_insurance_reduction_rate', criterion)
    .slice().sort((left, right) => left.calculation_order - right.calculation_order);
  if (!baseRecord || tierRecords.length === 0) return null;

  const baseAmount = masterMoney(baseRecord.base_amount);
  for (const record of tierRecords) {
    const addition = multiplyMoneyByCount(masterMoney(record.per_insured_addition), insuredCount);
    const threshold = addMoney(baseAmount, addition);
    if (totalIncome.value <= threshold.value) {
      return {
        tier: record.reduction_tier,
        reductionRate: masterRate(record.reduction_rate),
        threshold,
      };
    }
  }
  return { tier: null, reductionRate: rate({ num: 0n, den: 1n }), threshold: null };
}

function reducedFixedAmount(amount, reductionRate, roundingRuleId) {
  const retainedRate = rate({
    num: reductionRate.den - reductionRate.num,
    den: reductionRate.den,
  });
  return applyRounding(multiplyRateByMoney(retainedRate, amount), roundingRuleId);
}

function calculateComponent(record, assessmentBase, personCount, reduction) {
  if (personCount === 0) {
    const zero = zeroMoney();
    return {
      component: record.levy_component,
      incomeLevy: zero,
      perCapitaLevyBeforeReduction: zero,
      perHouseholdLevyBeforeReduction: zero,
      fixedLevyBeforeReduction: zero,
      fixedLevyAfterReduction: zero,
      beforeCap: zero,
      cap: masterMoney(record.cap_amount),
      amount: zero,
      capped: false,
    };
  }

  const incomeLevy = applyRounding(
    multiplyRateByMoney(masterRate(record.income_rate), assessmentBase),
    record.rounding_rule_id
  );
  const perCapitaLevyBeforeReduction = multiplyMoneyByCount(
    masterMoney(record.per_capita_amount), personCount
  );
  const perHouseholdLevyBeforeReduction = record.per_household_amount === null
    ? zeroMoney()
    : masterMoney(record.per_household_amount);
  const fixedLevyBeforeReduction = addMoney(
    perCapitaLevyBeforeReduction,
    perHouseholdLevyBeforeReduction
  );
  const fixedLevyAfterReduction = reducedFixedAmount(
    fixedLevyBeforeReduction,
    reduction.reductionRate,
    record.rounding_rule_id
  );
  const beforeCap = addMoney(incomeLevy, fixedLevyAfterReduction);
  const cap = masterMoney(record.cap_amount);
  const amount = minMoney(beforeCap, cap);
  return {
    component: record.levy_component,
    incomeRate: masterRate(record.income_rate),
    incomeLevy,
    personCount,
    perCapitaLevyBeforeReduction,
    perHouseholdLevyBeforeReduction,
    fixedLevyBeforeReduction,
    fixedLevyAfterReduction,
    beforeCap,
    cap,
    amount,
    capped: beforeCap.value > cap.value,
  };
}

function calculateNhiPremium(input) {
  const values = readInput(input);
  const criterion = { onDate: `${String(values.taxYear).padStart(4, '0')}-04-01` };
  const municipalRecords = masters.find('national_health_insurance_municipal_rate', criterion)
    .filter(record => record.jurisdiction.municipalityCode === values.municipalityCode)
    .slice().sort((left, right) => left.calculation_order - right.calculation_order);

  if (municipalRecords.length === 0) {
    return {
      status: 'blocked',
      blockedReasons: [blocked(
        'NHI_MUNICIPAL_RATE_NOT_REGISTERED',
        `指定した市町村・年度の国民健康保険料率が登録されていません: ${values.municipalityCode}`,
        { municipalityCode: values.municipalityCode, taxYear: values.taxYear }
      )],
    };
  }
  if (municipalRecords.length !== 4) {
    throw new Error(`国保料率の4区分がそろっていません: ${values.municipalityCode}`);
  }

  const baseRecord = uniqueRecord(
    masters.find('national_health_insurance_reduction_base_amount', criterion),
    '国保基礎控除'
  );
  const reduction = reductionContext(values.totalIncome, values.insuredCount, criterion);
  if (!baseRecord || !reduction) {
    return {
      status: 'blocked',
      blockedReasons: [blocked(
        'NHI_NATIONAL_RULE_MISSING',
        '対象年度の国保基礎控除または軽減判定基準がマスターにありません'
      )],
    };
  }

  const basicDeduction = masterMoney(baseRecord.base_amount);
  const assessmentBase = floorAtZero(subtractMoney(values.totalIncome, basicDeduction));
  const nursingCareInsuredCount = values.insuredAges.filter(age => age >= 40 && age < 65).length;
  const components = {};
  for (const record of municipalRecords) {
    const personCount = record.levy_component === 'nursing_care'
      ? nursingCareInsuredCount
      : values.insuredCount;
    components[record.levy_component] = calculateComponent(
      record, assessmentBase, personCount, reduction
    );
  }

  const annualPremium = sumMoney(Object.values(components).map(component => component.amount));
  return {
    status: 'complete',
    blockedReasons: [],
    municipalityCode: values.municipalityCode,
    municipalityLabel: municipalRecords[0].municipality_label,
    taxYear: values.taxYear,
    previousYearTotalIncome: values.totalIncome,
    basicDeduction,
    assessmentBase,
    insuredCount: values.insuredCount,
    insuredAges: values.insuredAges.slice(),
    nursingCareInsuredCount,
    reduction,
    components,
    annualPremium,
    totalPremium: annualPremium,
    notes: [{
      code: 'NHI_SELECTED_MUNICIPALITY_ESTIMATE',
      message: '選んだ自治体の料率による概算です。実際の年間国民健康保険料が分かる場合は実額を優先してください',
    }, {
      code: 'NHI_HOUSEHOLD_INCOME_V1',
      message: '第1版は入力した世帯合算所得を所得割の基礎とし、介護分は40歳以上65歳未満の被保険者が1人以上いる場合に同じ基礎額を用います',
    }],
  };
}

module.exports = {
  calculate: calculateNhiPremium,
  calculateNhiPremium,
};
