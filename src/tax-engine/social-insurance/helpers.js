'use strict';

const masters = require('../masters/snapshot.js');
const {
  money,
  exact,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  subtractExact,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');

const EMPLOYEE_SHARE_ROUNDING_RULE_ID = 'R-SHARE-EMPLOYEE-PAYROLL';
const ZERO_MONEY = Object.freeze({ unit: 'JPY', value: 0n });

function inputMoney(value, fieldName, defaultValue) {
  if ((value === undefined || value === null) && defaultValue !== undefined) {
    return money({ unit: 'JPY', value: BigInt(defaultValue) });
  }
  if (typeof value === 'bigint') return money({ unit: 'JPY', value });
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    return money({ unit: 'JPY', value: BigInt(value) });
  }
  if (value && value.unit === 'JPY' && typeof value.value === 'string' && /^-?[0-9]+$/.test(value.value)) {
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

function addRates(values) {
  return values.reduce((total, value) => rate({
    num: total.num * value.den + value.num * total.den,
    den: total.den * value.den,
  }), rate({ num: 0n, den: 1n }));
}

function splitPremium(base, combinedRate) {
  const total = multiplyRateByMoney(combinedRate, base);
  const employeeBeforeRounding = exact({ unit: 'JPY', num: total.num, den: total.den * 2n });
  const employee = applyRounding(employeeBeforeRounding, EMPLOYEE_SHARE_ROUNDING_RULE_ID);
  return {
    total,
    employee,
    employer: subtractExact(total, moneyToExact(employee)),
    employeeBeforeRounding,
    employeeShareRoundingRuleId: EMPLOYEE_SHARE_ROUNDING_RULE_ID,
  };
}

function employerOnlyPremium(base, contributionRate) {
  const total = multiplyRateByMoney(contributionRate, base);
  return {
    total,
    employee: money(ZERO_MONEY),
    employer: total,
  };
}

function parsePremiumMonth(value) {
  if (typeof value !== 'string') throw new TypeError('premiumMonth は YYYY-MM で指定してください');
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new RangeError('premiumMonth は実在する YYYY-MM で指定してください');
  }
  return { premiumMonth: value, onDate: `${value}-01` };
}

function assertAge(value) {
  if (!Number.isInteger(value) || value < 0 || value > 150) {
    throw new RangeError('age は0以上150以下の整数で指定してください');
  }
  return value;
}

function isNursingCareApplicable(age) {
  return age >= 40 && age < 65;
}

function findOne(valueKey, onDate, predicate = () => true) {
  const rows = masters.find(valueKey, { onDate }).filter(predicate);
  if (rows.length > 1) throw new Error(`${valueKey} の適用レコードが重複しています`);
  return rows[0] || null;
}

function blocked(code, message) {
  return { code, message };
}

function resolveInsurer(input) {
  const insurerType = input.insurerType ?? 'kyokai_kenpo';
  if (insurerType !== 'kyokai_kenpo') {
    return {
      blockedReason: blocked(
        'SI_INSURER_UNSUPPORTED',
        '第1版は協会けんぽのみ対応しており、健保組合等の保険者独自料率・端数特約は計算できません'
      ),
    };
  }
  return { insurerType };
}

function resolvePrefecture(input, onDate) {
  const raw = input.prefectureCode ?? input.prefecture;
  if (raw === undefined || raw === null || raw === '') {
    return { blockedReason: blocked('SI_PREFECTURE_REQUIRED', '都道府県が指定されていません') };
  }
  let prefectureCode = String(raw);
  if (/^[0-9]{1,2}$/.test(prefectureCode)) prefectureCode = prefectureCode.padStart(2, '0');
  const rows = masters.find('health_insurance_rate_total', { onDate });
  const byCode = rows.find(row => row.jurisdiction.prefectureCode === prefectureCode);
  const byName = rows.find(row => row.prefecture_name === prefectureCode);
  const record = byCode || byName || null;
  if (!record) {
    return {
      blockedReason: blocked(
        'SI_HEALTH_INSURANCE_RATE_MISSING',
        `都道府県または対象月の協会けんぽ健康保険料率がマスターにありません: ${raw}`
      ),
    };
  }
  return { prefectureCode: record.jurisdiction.prefectureCode, record };
}

function loadRateContext(input) {
  const { premiumMonth, onDate } = parsePremiumMonth(input.premiumMonth);
  const age = assertAge(input.age);
  const reasons = [];
  const insurer = resolveInsurer(input);
  if (insurer.blockedReason) reasons.push(insurer.blockedReason);
  const prefecture = resolvePrefecture(input, onDate);
  if (prefecture.blockedReason) reasons.push(prefecture.blockedReason);

  const pensionRecord = findOne('employees_pension_rate_total', onDate);
  if (!pensionRecord) {
    reasons.push(blocked('SI_EMPLOYEES_PENSION_RATE_MISSING', '対象月の厚生年金保険料率がマスターにありません'));
  }
  const nursingCareApplicable = isNursingCareApplicable(age);
  const nursingCareRecord = nursingCareApplicable
    ? findOne('nursing_care_insurance_rate_total', onDate)
    : null;
  if (nursingCareApplicable && !nursingCareRecord) {
    reasons.push(blocked(
      'SI_NURSING_CARE_RATE_MISSING',
      '介護保険の対象年齢ですが、対象月の介護保険料率がマスターにありません'
    ));
  }
  const supportRecord = findOne('child_rearing_support_rate', onDate);
  const childLevyRecord = findOne('child_support_levy_rate', onDate);
  if (!childLevyRecord) {
    reasons.push(blocked('SI_CHILD_SUPPORT_LEVY_RATE_MISSING', '対象月の子ども・子育て拠出金率がマスターにありません'));
  }

  return {
    status: reasons.length === 0 ? 'complete' : 'blocked',
    blockedReasons: reasons,
    premiumMonth,
    onDate,
    age,
    insurerType: insurer.insurerType,
    prefectureCode: prefecture.prefectureCode,
    healthRecord: prefecture.record,
    pensionRecord,
    nursingCareApplicable,
    nursingCareRecord,
    supportRecord,
    childLevyRecord,
  };
}

function healthCombinedRate(context) {
  const rates = [masterRate(context.healthRecord.rate)];
  if (context.nursingCareRecord) rates.push(masterRate(context.nursingCareRecord.rate));
  if (context.supportRecord) rates.push(masterRate(context.supportRecord.rate));
  return addRates(rates);
}

function resultNotes() {
  return [
    {
      code: 'SI_COMBINED_RATE_SINGLE_ROUNDING',
      message: '健康保険・介護保険・子ども・子育て支援金は率を合算してから労使折半し、本人負担だけを1回丸めています',
    },
    {
      code: 'SI_AGE_MONTH_SIMPLIFIED',
      message: '介護保険の該当判定は入力された年齢のみで行い、年齢到達月の細目は第1版では扱いません',
    },
  ];
}

module.exports = {
  EMPLOYEE_SHARE_ROUNDING_RULE_ID,
  inputMoney,
  masterMoney,
  masterRate,
  addRates,
  splitPremium,
  employerOnlyPremium,
  parsePremiumMonth,
  findOne,
  blocked,
  loadRateContext,
  healthCombinedRate,
  resultNotes,
  multiplyRateByMoney,
  applyRounding,
};
