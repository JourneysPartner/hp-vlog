'use strict';

/**
 * 法人課税5点セットの計算エンジン（中小法人・第1版）。
 *
 * §10 の順序を崩さないため、会計利益への申告調整、繰越欠損金、
 * 課税標準、各税目を別々の段階として返す。法人事業税等は当期の
 * 会計利益へ戻さず、平年度比較の税額としてだけ表示する。
 */

const masters = require('../masters/snapshot.js');
const {
  zeroMoney,
  inputMoney,
  masterMoney,
  masterRate,
  sumMoney,
  sumExact,
  minMoney,
  maxMoney,
  floorMoneyAtZero,
  moneyToExact,
  multiplyRateByMoney,
  addMoney,
  subtractMoney,
  applyRounding,
} = require('../income/helpers.js');

const NATIONAL_TAX_ROUNDING_RULE_ID = 'R-TRUNC-100-TAX';
const LOCAL_TAX_ROUNDING_RULE_ID = 'R-TRUNC-100-LOCAL-TAX';
const NO_ROUNDING_RULE_ID = 'R-NONE';

// 入力型設計書の列挙と同じ集合。欠けた回答を0円扱いにする場合の検知にも使う。
const ADJUSTMENT_CODES = Object.freeze([
  'entertainment',
  'donation',
  'depreciation',
  'allowance',
  'taxes_and_dues',
  'officer_salary',
  'dividend_received',
  'other',
]);

function addReason(reasons, code, message, extra = {}) {
  if (reasons.some(reason => reason.code === code && reason.itemIndex === extra.itemIndex)) return;
  reasons.push({ code, message, ...extra });
}

function blockedResult(blockedReasons, assumptions = [], warnings = []) {
  return {
    status: 'blocked',
    resultStatus: 'blocked',
    blockedReasons,
    excludedItems: [],
    assumptions,
    warnings,
  };
}

function requiredRecords(valueKey, criterion, predicate = () => true) {
  const records = masters.find(valueKey, criterion).filter(predicate);
  if (records.length === 0) {
    const error = new Error(`法人税マスターが利用できません: ${valueKey}`);
    error.code = 'CT_MASTER_UNAVAILABLE';
    throw error;
  }
  return records;
}

function requiredRecord(valueKey, criterion, predicate = () => true) {
  const records = requiredRecords(valueKey, criterion, predicate);
  if (records.length !== 1) {
    const error = new Error(`法人税マスターを一意に選べません: ${valueKey}`);
    error.code = 'CT_MASTER_AMBIGUOUS';
    throw error;
  }
  return records[0];
}

function parseLocalDate(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${fieldName} はYYYY-MM-DDで指定してください`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) {
    throw new RangeError(`${fieldName} は実在する日付で指定してください`);
  }
  return date;
}

function formatLocalDate(date) {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function endOfTwelveMonthPeriod(from) {
  const start = parseLocalDate(from, 'fiscalPeriod.from');
  const anniversary = new Date(Date.UTC(
    start.getUTCFullYear() + 1,
    start.getUTCMonth(),
    start.getUTCDate()
  ));
  // 2月29日の翌年はDateが3月1日へ正規化するため、1日前が2月28日になる。
  anniversary.setUTCDate(anniversary.getUTCDate() - 1);
  return formatLocalDate(anniversary);
}

function normalizeFiscalPeriod(input, options) {
  const source = options.fiscalPeriod || input.fiscalPeriod || input.businessPeriod;
  if (source) {
    const from = source.from || source.startedOn;
    const to = source.to || source.endedOn;
    parseLocalDate(from, 'fiscalPeriod.from');
    parseLocalDate(to, 'fiscalPeriod.to');
    if (from > to) throw new RangeError('fiscalPeriod.from は to 以前で指定してください');
    return { from, to, isTwelveMonths: to === endOfTwelveMonthPeriod(from) };
  }
  const months = options.fiscalYearMonths ?? options.businessYearMonths ??
    input.fiscalYearMonths ?? input.businessYearMonths ?? input.fiscalPeriodMonths;
  const from = options.onDate || input.fiscalYearStartedOn || input.periodStartedOn;
  if (months !== undefined || from !== undefined) {
    return { from, to: null, isTwelveMonths: months === 12 };
  }
  return null;
}

function isPresentUnsupported(value) {
  if (value === undefined || value === null || value === false || value === 'no') return false;
  if (value && value.unit === 'JPY') return inputMoney(value).value !== 0n;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function preflightBlockedReasons(input, options = {}) {
  const reasons = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [{ code: 'CT_INPUT_REQUIRED', message: '法人税計算の入力が必要です' }];
  }

  const period = normalizeFiscalPeriod(input, options);
  if (!period || !period.from) {
    addReason(reasons, 'CT_FISCAL_PERIOD_REQUIRED', '事業年度または事業年度開始日と月数が必要です');
  } else if (!period.isTwelveMonths) {
    addReason(reasons, 'CT_SHORT_FISCAL_PERIOD_UNSUPPORTED',
      '12か月未満を含む12か月以外の事業年度は第1版の対象外です');
  }

  const officePrefectureCount = input.officePrefectureCount ?? input.prefecturesWithOffices;
  if (input.enterpriseTaxReducedRateEligible === false ||
      input.hasOfficesInThreeOrMorePrefectures === true ||
      (Number.isInteger(officePrefectureCount) && officePrefectureCount >= 3)) {
    addReason(reasons, 'CT_ENTERPRISE_REDUCED_RATE_INELIGIBLE',
      '3以上の都道府県に事務所等がある軽減税率不適用法人は第1版の対象外です');
  }
  if (input.isWhollyOwnedByLargeCorporation === true ||
      input.ownedByLargeCorporation === true || input.largeCorporationCompleteControl === true) {
    addReason(reasons, 'CT_LARGE_CORPORATION_CONTROL_UNSUPPORTED',
      '大法人による完全支配関係がある法人は第1版の対象外です');
  }
  if (input.isGroupReliefCorporation === true || input.isConsolidatedTaxGroupMember === true ||
      input.isTaxConsolidationCorporation === true) {
    addReason(reasons, 'CT_GROUP_RELIEF_UNSUPPORTED', '通算法人は第1版の対象外です');
  }
  if (isPresentUnsupported(input.lossCarrybackRefund) ||
      isPresentUnsupported(input.carrybackRefund) || input.applyLossCarryback === true) {
    addReason(reasons, 'CT_LOSS_CARRYBACK_UNSUPPORTED', '欠損金の繰戻し還付は第1版の対象外です');
  }
  if (input.isDomestic === false ||
      (input.entityType && !['ordinary', 'domestic_ordinary'].includes(input.entityType))) {
    addReason(reasons, 'CT_ENTITY_TYPE_UNSUPPORTED', '国内普通法人以外は第1版の対象外です');
  }
  if (input.comparisonBasis && input.comparisonBasis !== 'steady_state') {
    addReason(reasons, 'CT_TRANSITION_YEAR_UNSUPPORTED', '移行年度比較は第1版の対象外です');
  }
  if (isPresentUnsupported(input.taxCredits) || isPresentUnsupported(input.corporateTaxCredits)) {
    addReason(reasons, 'CT_TAX_CREDITS_UNSUPPORTED', '法人税の税額控除は第1版の対象外です');
  }
  return reasons;
}

function conditionMatches(record, values) {
  return (record.applicability_conditions || []).every(condition => {
    const actual = values[condition.subject];
    const expected = condition.value && condition.value.unit === 'JPY'
      ? masterMoney(condition.value).value
      : condition.value;
    const compared = actual && actual.unit === 'JPY' ? actual.value : actual;
    if (condition.operator === 'eq') return compared === expected;
    if (condition.operator === 'lte') return compared <= expected;
    if (condition.operator === 'lt') return compared < expected;
    if (condition.operator === 'gte') return compared >= expected;
    if (condition.operator === 'gt') return compared > expected;
    if (condition.operator === 'in') return Array.isArray(expected) && expected.includes(compared);
    return false;
  });
}

function progressivePortion(base, record) {
  const lower = masterMoney(record.income_lower_inclusive).value;
  const upper = record.income_upper_inclusive === null
    ? null
    : masterMoney(record.income_upper_inclusive).value;
  // 段階表は1円単位の閉区間なので、400万1円以上の段の基点は400万円となる。
  const threshold = lower === 0n ? 0n : lower - 1n;
  const capped = upper === null || base.value <= upper ? base.value : upper;
  return inputMoney(capped > threshold ? capped - threshold : 0n);
}

function calculateProgressiveTax(base, records, finalRoundingRuleId, conditionValues = {}) {
  const selected = records
    .filter(record => conditionMatches(record, conditionValues))
    .sort((left, right) => left.calculation_order - right.calculation_order);
  let coveredThrough = 0n;
  for (const record of selected) {
    const lower = masterMoney(record.income_lower_inclusive).value;
    const threshold = lower === 0n ? 0n : lower - 1n;
    if (threshold > coveredThrough && base.value > coveredThrough) {
      const error = new Error('段階税率マスターに課税標準を覆わない区間があります');
      error.code = 'CT_MASTER_UNAVAILABLE';
      throw error;
    }
    if (record.income_upper_inclusive === null) {
      coveredThrough = base.value;
      break;
    }
    const upper = masterMoney(record.income_upper_inclusive).value;
    if (upper > coveredThrough) coveredThrough = upper;
    if (coveredThrough >= base.value) break;
  }
  if (base.value > coveredThrough) {
    const error = new Error('段階税率マスターが課税標準の上限まで登録されていません');
    error.code = 'CT_MASTER_UNAVAILABLE';
    throw error;
  }
  const details = selected.map(record => {
    const portion = progressivePortion(base, record);
    const taxExact = multiplyRateByMoney(masterRate(record.rate), portion);
    return {
      recordId: record.record_id,
      taxablePortion: portion,
      rate: masterRate(record.rate),
      taxBeforeFinalRounding: applyRounding(taxExact, NO_ROUNDING_RULE_ID),
      taxExact,
    };
  }).filter(detail => detail.taxablePortion.value > 0n);
  const taxBeforeFinalRounding = sumExact(details.map(detail => detail.taxExact));
  return {
    details: details.map(({ taxExact, ...detail }) => detail),
    taxBeforeFinalRounding: applyRounding(taxBeforeFinalRounding, NO_ROUNDING_RULE_ID),
    tax: applyRounding(taxBeforeFinalRounding, finalRoundingRuleId),
  };
}

function entertainmentSource(input, entertainmentItem) {
  if (input.entertainmentExpenses || input.entertainmentExpense) {
    return input.entertainmentExpenses || input.entertainmentExpense;
  }
  if (!entertainmentItem) return null;
  if (entertainmentItem.entertainmentExpenses || entertainmentItem.details) {
    return entertainmentItem.entertainmentExpenses || entertainmentItem.details;
  }
  if (entertainmentItem.totalAmount !== undefined ||
      entertainmentItem.expenditureAmount !== undefined ||
      entertainmentItem.perPersonDiningExclusionAmount !== undefined) {
    return entertainmentItem;
  }
  // direction付きのamountは支出額でなく、利用者が確定した申告調整額として扱う。
  return entertainmentItem.direction === undefined ? entertainmentItem : null;
}

function calculateEntertainmentAdjustment(source, criterion) {
  const fixedRecord = requiredRecord('entertainment_expense_fixed_deduction_limit', criterion);
  const diningRecord = requiredRecord(
    'entertainment_expense_dining_deductible_rate', criterion,
    record => conditionMatches(record, { capital_amount_tier: '100m_or_less' })
  );
  const exclusionRecord = requiredRecord('entertainment_expense_per_person_exclusion', criterion);
  const totalSource = source.totalAmount ?? source.expenditureAmount ?? source.amount;
  if (totalSource === undefined) {
    return { blockedReason: {
      code: 'CT_ENTERTAINMENT_AMOUNT_REQUIRED',
      message: '交際費等がある場合は支出額が必要です',
    } };
  }
  const totalAmount = inputMoney(totalSource, 'entertainmentExpenses.totalAmount');
  const excludedAmount = inputMoney(
    source.perPersonDiningExclusionAmount ?? source.excludedDiningAmount,
    'entertainmentExpenses.perPersonDiningExclusionAmount'
  );
  if (totalAmount.value < 0n || excludedAmount.value < 0n ||
      excludedAmount.value > totalAmount.value) {
    throw new RangeError('交際費等と1人当たり基準以下の飲食費は0円以上で、除外額は支出額以下にしてください');
  }
  const entertainmentAmount = subtractMoney(totalAmount, excludedAmount);
  const fixedLimit = masterMoney(fixedRecord.annual_limit_amount);
  const fixedDeductible = minMoney(entertainmentAmount, fixedLimit);
  const diningSource = source.qualifyingDiningAmount ?? source.businessDiningAmount ??
    source.entertainmentDiningAmount;
  let diningDeductible = null;
  let selectionCanBeDetermined = true;
  if (diningSource !== undefined) {
    const qualifyingDiningAmount = inputMoney(
      diningSource, 'entertainmentExpenses.qualifyingDiningAmount'
    );
    if (qualifyingDiningAmount.value < 0n || qualifyingDiningAmount.value > entertainmentAmount.value) {
      throw new RangeError('接待飲食費は0円以上かつ除外後の交際費等以下にしてください');
    }
    diningDeductible = applyRounding(
      multiplyRateByMoney(masterRate(diningRecord.rate), qualifyingDiningAmount),
      diningRecord.rounding_rule_id
    );
  } else {
    // 接待飲食費が最大でも定額控除を上回らない範囲なら、区分未入力でも結論は変わらない。
    const maximumDiningDeductible = applyRounding(
      multiplyRateByMoney(masterRate(diningRecord.rate), entertainmentAmount),
      diningRecord.rounding_rule_id
    );
    if (fixedDeductible.value >= maximumDiningDeductible.value) {
      diningDeductible = zeroMoney();
    } else {
      selectionCanBeDetermined = false;
    }
  }
  if (!selectionCanBeDetermined) {
    return { blockedReason: {
      code: 'CT_ENTERTAINMENT_DINING_CLASSIFICATION_REQUIRED',
      message: '有利な損金算入基準を選ぶため、接待飲食費の区分額が必要です',
    } };
  }
  const deductibleAmount = maxMoney(fixedDeductible, diningDeductible);
  const selectedMethod = fixedDeductible.value >= diningDeductible.value
    ? 'fixed_deduction'
    : 'dining_50_percent';
  return {
    totalAmount,
    perPersonDiningExclusionAmount: excludedAmount,
    perPersonThreshold: masterMoney(exclusionRecord.threshold_amount),
    entertainmentAmount,
    fixedDeductible,
    diningDeductible,
    selectedMethod,
    deductibleAmount,
    nonDeductibleAmount: subtractMoney(entertainmentAmount, deductibleAmount),
  };
}

function calculateAdjustments(input, criterion) {
  const assumptions = [];
  const reasons = [];
  const source = input.taxAdjustments || input.adjustments;
  const items = source && Array.isArray(source.items)
    ? source.items
    : Array.isArray(source) ? source : [];
  const treatUnansweredAsZero = source === undefined || source.treatUnansweredAsZero === true;
  const itemByCode = new Map();
  items.forEach((item, index) => {
    if (!ADJUSTMENT_CODES.includes(item.code)) {
      addReason(reasons, 'CT_ADJUSTMENT_CODE_UNKNOWN', `未対応の申告調整コードです: ${item.code}`, {
        itemIndex: index,
      });
    } else if (itemByCode.has(item.code)) {
      addReason(reasons, 'CT_ADJUSTMENT_DUPLICATE', `申告調整 ${item.code} が重複しています`, {
        itemIndex: index,
      });
    } else {
      itemByCode.set(item.code, { item, index });
    }
  });

  const entertainmentItem = itemByCode.get('entertainment');
  const entertainmentDetails = entertainmentSource(input, entertainmentItem && entertainmentItem.item);
  const additions = [];
  const subtractions = [];
  let entertainment = null;

  for (const code of ADJUSTMENT_CODES) {
    const entry = itemByCode.get(code);
    const item = entry && entry.item;
    const hasDetails = code === 'entertainment' && entertainmentDetails &&
      (entertainmentDetails.totalAmount !== undefined ||
       entertainmentDetails.expenditureAmount !== undefined || entertainmentDetails.amount !== undefined);
    if (!item && !hasDetails) {
      if (!treatUnansweredAsZero) {
        addReason(reasons, 'CT_ADJUSTMENT_UNANSWERED',
          `申告調整 ${code} の該当有無が未回答です`);
      }
      continue;
    }
    const applies = hasDetails ? 'yes' : item.applies;
    if (applies === 'unknown' || applies === undefined) {
      addReason(reasons, 'CT_ADJUSTMENT_APPLICABILITY_UNKNOWN',
        `申告調整 ${code} の該当有無が不明です`, { itemIndex: entry && entry.index });
      continue;
    }
    if (applies === 'no' || applies === false) continue;
    if (applies !== 'yes' && applies !== true) {
      addReason(reasons, 'CT_ADJUSTMENT_APPLICABILITY_UNKNOWN',
        `申告調整 ${code} の該当有無が不明です`, { itemIndex: entry && entry.index });
      continue;
    }

    if (code === 'entertainment') {
      if (entertainmentDetails) {
        entertainment = calculateEntertainmentAdjustment(entertainmentDetails, criterion);
        if (entertainment.blockedReason) reasons.push(entertainment.blockedReason);
        else additions.push(entertainment.nonDeductibleAmount);
      } else if (item.amount !== undefined && ['add', 'subtract'].includes(item.direction)) {
        const amount = inputMoney(item.amount, `taxAdjustments.items[${entry.index}].amount`);
        if (amount.value < 0n) throw new RangeError('申告調整額は0円以上で指定してください');
        entertainment = {
          calculationMethod: 'input_adjustment_amount',
          nonDeductibleAmount: item.direction === 'add' ? amount : zeroMoney(),
        };
        (item.direction === 'add' ? additions : subtractions).push(amount);
      } else {
        addReason(reasons, item.amount === undefined
          ? 'CT_ENTERTAINMENT_AMOUNT_REQUIRED'
          : 'CT_ADJUSTMENT_DIRECTION_REQUIRED',
        item.amount === undefined
          ? '交際費等がある場合は支出額または確定した申告調整額が必要です'
          : '確定した交際費の申告調整額には加算・減算区分が必要です',
        { itemIndex: entry.index });
      }
      continue;
    }
    if (item.amount === undefined) {
      addReason(reasons, 'CT_ADJUSTMENT_AMOUNT_REQUIRED',
        `申告調整 ${code} が該当する場合は金額が必要です`, { itemIndex: entry.index });
      continue;
    }
    const amount = inputMoney(item.amount, `taxAdjustments.items[${entry.index}].amount`);
    if (amount.value < 0n) throw new RangeError('申告調整額は0円以上で指定してください');
    if (item.direction === 'add') additions.push(amount);
    else if (item.direction === 'subtract') subtractions.push(amount);
    else addReason(reasons, 'CT_ADJUSTMENT_DIRECTION_REQUIRED',
      `申告調整 ${code} の加算・減算区分が必要です`, { itemIndex: entry.index });
  }

  if (treatUnansweredAsZero && ADJUSTMENT_CODES.some(code => {
    if (itemByCode.has(code)) return false;
    return !(code === 'entertainment' && entertainmentDetails);
  })) {
    assumptions.push({
      code: 'CT_UNANSWERED_ADJUSTMENTS_ASSUMED_ZERO',
      message: '未回答の申告調整は0円として計算しています',
    });
  }
  return {
    blockedReasons: reasons,
    assumptions,
    additions,
    subtractions,
    additionTotal: sumMoney(additions),
    subtractionTotal: sumMoney(subtractions),
    entertainment,
  };
}

function subtractYears(dateText, years) {
  const date = parseLocalDate(dateText, 'fiscalPeriod.from');
  const targetYear = date.getUTCFullYear() - years;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const result = new Date(Date.UTC(targetYear, month, day));
  if (result.getUTCMonth() !== month) result.setUTCDate(0);
  return formatLocalDate(result);
}

function calculateLossCarryforward(input, incomeAmount, criterion, fiscalPeriod) {
  const source = input.lossCarryforward || {};
  const losses = source.losses || input.carryforwardLosses || [];
  const normalized = losses.map((loss, index) => ({
    originalIndex: index,
    fiscalYearStartedOn: loss.fiscalYearStartedOn || loss.periodStartedOn,
    amount: inputMoney(loss.amount, `lossCarryforward.losses[${index}].amount`),
  }));
  normalized.forEach(loss => {
    parseLocalDate(loss.fiscalYearStartedOn, 'lossCarryforward.losses[].fiscalYearStartedOn');
    if (loss.amount.value < 0n) throw new RangeError('繰越欠損金額は0円以上で指定してください');
  });
  const hasLossInput = normalized.some(loss => loss.amount.value > 0n);
  if (!hasLossInput) {
    return {
      hasLossInput: false,
      blueReturnRequirementMet: null,
      deductionLimit: zeroMoney(),
      deductionAmount: zeroMoney(),
      allocations: normalized.map(loss => ({ ...loss, usedAmount: zeroMoney(), remainingAmount: loss.amount })),
      expiredLosses: [],
      warnings: [],
    };
  }

  const periodRecord = requiredRecord('loss_carryforward_period', criterion);
  const limitRecord = requiredRecord(
    'loss_carryforward_deduction_limit', criterion, record => record.entity_type === 'sme'
  );
  const blueRecord = requiredRecord('loss_carryforward_blue_return_requirement', criterion);
  const oldestEligibleStart = subtractYears(fiscalPeriod.from, periodRecord.carryforward_years);
  const sorted = normalized.slice().sort((left, right) =>
    left.fiscalYearStartedOn.localeCompare(right.fiscalYearStartedOn));
  const eligible = sorted.filter(loss => loss.fiscalYearStartedOn >= oldestEligibleStart &&
    loss.fiscalYearStartedOn < fiscalPeriod.from);
  const expiredLosses = sorted.filter(loss => !eligible.includes(loss));
  const blueValue = source.hasBlueReturnForLossYears ?? input.hasBlueReturnForLossYears;
  const blueReturnRequirementMet = blueRecord.requires_blue_return
    ? blueValue === true || blueValue === 'yes'
    : true;
  const positiveIncome = floorMoneyAtZero(incomeAmount);
  const deductionLimit = applyRounding(
    multiplyRateByMoney(masterRate(limitRecord.deduction_limit_rate), positiveIncome),
    limitRecord.rounding_rule_id
  );
  let remainingLimit = blueReturnRequirementMet ? deductionLimit.value : 0n;
  const allocations = sorted.map(loss => {
    const canUse = eligible.includes(loss) ? loss.amount.value : 0n;
    const used = canUse < remainingLimit ? canUse : remainingLimit;
    remainingLimit -= used;
    return {
      originalIndex: loss.originalIndex,
      fiscalYearStartedOn: loss.fiscalYearStartedOn,
      amount: loss.amount,
      usedAmount: inputMoney(used),
      remainingAmount: inputMoney(loss.amount.value - used),
      eligibility: eligible.includes(loss) ? 'eligible' : 'expired_or_future',
    };
  });
  const deductionAmount = sumMoney(allocations.map(allocation => allocation.usedAmount));
  const warnings = [];
  if (!blueReturnRequirementMet) {
    warnings.push({
      code: 'CT_LOSS_BLUE_RETURN_REQUIREMENT_NOT_MET',
      message: '青色申告等の要件を確認できないため、繰越欠損金は控除していません',
    });
  }
  return {
    hasLossInput,
    blueReturnRequirementMet,
    carryforwardYears: periodRecord.carryforward_years,
    oldestEligibleStart,
    deductionLimit,
    deductionAmount,
    allocations,
    expiredLosses,
    warnings,
  };
}

function perCapitaAmounts(record, capital, employeeCount) {
  const matches = record.per_capita_amounts.filter(row => {
    const capitalLower = BigInt(row.capital_lower);
    const capitalUpper = row.capital_upper === null ? null : BigInt(row.capital_upper);
    const employeeUpper = row.employee_upper === null ? null : row.employee_upper;
    return capital.value >= capitalLower && (capitalUpper === null || capital.value <= capitalUpper) &&
      employeeCount >= row.employee_lower && (employeeUpper === null || employeeCount <= employeeUpper);
  });
  if (matches.length !== 1) {
    const error = new Error('資本金・従業員数に対応する法人住民税均等割を選べません');
    error.code = 'CT_PER_CAPITA_BRACKET_UNAVAILABLE';
    throw error;
  }
  return {
    municipal: masterMoney(matches[0].municipal_amount),
    prefectural: masterMoney(matches[0].prefectural_amount),
    record: matches[0],
  };
}

function calculate(input, options = {}) {
  let initialReasons;
  try {
    initialReasons = preflightBlockedReasons(input, options);
  } catch (error) {
    throw error;
  }
  if (initialReasons.length > 0) return blockedResult(initialReasons);

  const fiscalPeriod = normalizeFiscalPeriod(input, options);
  const criterion = { onDate: options.onDate || fiscalPeriod.from };
  const assumptions = [];
  const warnings = [];
  try {
    const perCapitaRecord = requiredRecord('corporate_inhabitant_per_capita', criterion);
    const capitalSource = input.capital ?? input.capitalAmount;
    const profitSource = input.accountingProfitBeforeTax ?? input.preTaxAccountingProfit ??
      input.accountingProfit ?? input.income;
    const employeeCount = input.employeeCount;
    const reasons = [];
    if (capitalSource === undefined) {
      addReason(reasons, 'CT_CAPITAL_REQUIRED', '資本金が必要です');
    }
    if (profitSource === undefined) {
      addReason(reasons, 'CT_ACCOUNTING_PROFIT_REQUIRED', '会計上の税引前利益が必要です');
    }
    if (!Number.isInteger(employeeCount) || employeeCount < 0) {
      addReason(reasons, 'CT_EMPLOYEE_COUNT_REQUIRED', '従業員数は0以上の整数で指定してください');
    }
    if (reasons.length > 0) return blockedResult(reasons);

    const capital = inputMoney(capitalSource, 'capital');
    const accountingProfitBeforeTax = inputMoney(profitSource, 'accountingProfitBeforeTax');
    if (capital.value < 0n) throw new RangeError('資本金は0円以上で指定してください');
    const supportedCapitalUpper = perCapitaRecord.per_capita_amounts.reduce((maximum, row) => {
      if (row.capital_upper === null) return maximum;
      const upper = BigInt(row.capital_upper);
      return upper > maximum ? upper : maximum;
    }, 0n);
    if (capital.value > supportedCapitalUpper) {
      return blockedResult([{
        code: 'CT_CAPITAL_OVER_SME_LIMIT',
        message: '資本金1億円超は外形標準課税の対象となるため第1版では計算できません',
      }]);
    }

    const adjustmentResult = calculateAdjustments(input, criterion);
    assumptions.push(...adjustmentResult.assumptions);
    if (adjustmentResult.blockedReasons.length > 0) {
      return blockedResult(adjustmentResult.blockedReasons, assumptions);
    }
    const incomeAmount = subtractMoney(
      addMoney(accountingProfitBeforeTax, adjustmentResult.additionTotal),
      adjustmentResult.subtractionTotal
    );

    const lossResult = calculateLossCarryforward(input, incomeAmount, criterion, fiscalPeriod);
    warnings.push(...lossResult.warnings);
    const taxableIncomeBeforeRounding = floorMoneyAtZero(
      subtractMoney(incomeAmount, lossResult.deductionAmount)
    );
    const corporateBracketRecords = requiredRecords('corporate_tax_sme_brackets', criterion);
    const taxableIncome = applyRounding(
      moneyToExact(taxableIncomeBeforeRounding), corporateBracketRecords[0].rounding_rule_id
    );

    const corporateTaxResult = calculateProgressiveTax(
      taxableIncome,
      corporateBracketRecords,
      NATIONAL_TAX_ROUNDING_RULE_ID,
      { total_annual_income: incomeAmount }
    );
    const corporateTax = corporateTaxResult.tax;

    const localCorporateRecord = requiredRecord('local_corporate_tax_rate', criterion);
    const localCorporateTaxBase = applyRounding(
      moneyToExact(corporateTax), localCorporateRecord.rounding_rule_id
    );
    const localCorporateTax = applyRounding(
      multiplyRateByMoney(masterRate(localCorporateRecord.rate), localCorporateTaxBase),
      NATIONAL_TAX_ROUNDING_RULE_ID
    );

    const municipalRateRecord = requiredRecord(
      'corporate_inhabitant_income_rate_municipal', criterion
    );
    const prefecturalRateRecord = requiredRecord(
      'corporate_inhabitant_income_rate_prefectural', criterion
    );
    const corporateTaxLevyBase = applyRounding(
      moneyToExact(corporateTax), municipalRateRecord.rounding_rule_id
    );
    const municipalIncomeLevy = applyRounding(
      multiplyRateByMoney(masterRate(municipalRateRecord.rate), corporateTaxLevyBase),
      LOCAL_TAX_ROUNDING_RULE_ID
    );
    const prefecturalIncomeLevy = applyRounding(
      multiplyRateByMoney(masterRate(prefecturalRateRecord.rate), corporateTaxLevyBase),
      LOCAL_TAX_ROUNDING_RULE_ID
    );
    const perCapita = perCapitaAmounts(perCapitaRecord, capital, employeeCount);
    const incomeLevyTotal = sumMoney([municipalIncomeLevy, prefecturalIncomeLevy]);
    const perCapitaLevyTotal = sumMoney([perCapita.municipal, perCapita.prefectural]);
    const corporateInhabitantTax = sumMoney([incomeLevyTotal, perCapitaLevyTotal]);

    let enterpriseTax = null;
    let specialEnterpriseTax = null;
    let enterpriseTaxDetails = [];
    let enterpriseTaxBase = null;
    let specialEnterpriseTaxBase = null;
    let specialEnterpriseTaxBeforeFinalRounding = null;
    const excludedItems = [];
    if (lossResult.hasLossInput) {
      excludedItems.push({
        code: 'enterprise_tax_income',
        taxType: 'enterprise_tax',
        reason: '法人事業税独自の繰越欠損金規定が未登録のため計算対象外です',
      }, {
        code: 'special_enterprise_tax',
        taxType: 'special_enterprise_tax',
        reason: '基準法人所得割額を確定できないため計算対象外です',
      });
    } else {
      const enterpriseRecords = requiredRecords('enterprise_tax_income_brackets', criterion);
      enterpriseTaxBase = applyRounding(
        moneyToExact(taxableIncomeBeforeRounding), enterpriseRecords[0].rounding_rule_id
      );
      const enterpriseResult = calculateProgressiveTax(
        enterpriseTaxBase, enterpriseRecords, LOCAL_TAX_ROUNDING_RULE_ID
      );
      enterpriseTax = enterpriseResult.tax;
      enterpriseTaxDetails = enterpriseResult.details;
      const specialRecord = requiredRecord('special_enterprise_tax_rate', criterion);
      specialEnterpriseTaxBase = enterpriseTax;
      const specialEnterpriseTaxExact = multiplyRateByMoney(
        masterRate(specialRecord.rate), specialEnterpriseTaxBase
      );
      specialEnterpriseTaxBeforeFinalRounding = applyRounding(
        specialEnterpriseTaxExact, NO_ROUNDING_RULE_ID
      );
      specialEnterpriseTax = applyRounding(
        specialEnterpriseTaxExact,
        LOCAL_TAX_ROUNDING_RULE_ID
      );
    }

    assumptions.push({
      code: 'CT_LOCAL_TAX_STANDARD_RATES',
      message: '法人地方税は標準税率による概算です。',
    }, {
      code: 'CT_INHABITANT_TAX_BASE_BEFORE_CREDITS',
      message: '法人住民税の法人税割は、税額控除前の算出法人税額を1,000円未満切り捨てた額を課税標準としています',
    }, {
      code: 'CT_STEADY_STATE_ENTERPRISE_TAX_TIMING',
      message: '法人事業税・特別法人事業税は当期の損金へ算入せず、平年度比較の当期税額として表示しています',
    });

    const knownTaxTotal = sumMoney([
      corporateTax,
      localCorporateTax,
      corporateInhabitantTax,
      enterpriseTax || zeroMoney(),
      specialEnterpriseTax || zeroMoney(),
    ]);
    const status = excludedItems.length > 0 ? 'partial' : 'complete';
    return {
      status,
      resultStatus: status,
      supportedProfileVersion: 'corporate-sme-v1',
      comparisonBasis: 'steady_state',
      localTaxRateSource: {
        standardRate: 'registered',
        excessRate: 'missing',
      },
      blockedReasons: [],
      excludedItems,
      assumptions,
      warnings,
      fiscalPeriod,
      capital,
      employeeCount,
      accountingProfitBeforeTax,
      adjustments: {
        additions: adjustmentResult.additions,
        subtractions: adjustmentResult.subtractions,
        additionTotal: adjustmentResult.additionTotal,
        subtractionTotal: adjustmentResult.subtractionTotal,
        entertainment: adjustmentResult.entertainment,
      },
      incomeAmount,
      lossCarryforward: lossResult,
      taxableIncomeBeforeRounding,
      taxableIncome,
      corporateTax: {
        taxableBase: taxableIncome,
        brackets: corporateTaxResult.details,
        beforeFinalRounding: corporateTaxResult.taxBeforeFinalRounding,
        amount: corporateTax,
      },
      localCorporateTax: {
        baseCorporateTax: localCorporateTaxBase,
        amount: localCorporateTax,
      },
      corporateInhabitantTax: {
        corporateTaxLevyBase,
        prefecturalIncomeLevy,
        municipalIncomeLevy,
        incomeLevyTotal,
        prefecturalPerCapitaLevy: perCapita.prefectural,
        municipalPerCapitaLevy: perCapita.municipal,
        perCapitaLevyTotal,
        amount: corporateInhabitantTax,
      },
      enterpriseTax: enterpriseTax === null ? null : {
        taxableBase: enterpriseTaxBase,
        brackets: enterpriseTaxDetails,
        amount: enterpriseTax,
      },
      specialEnterpriseTax: specialEnterpriseTax === null ? null : {
        baseEnterpriseIncomeLevy: specialEnterpriseTaxBase,
        beforeFinalRounding: specialEnterpriseTaxBeforeFinalRounding,
        amount: specialEnterpriseTax,
      },
      taxes: Object.freeze({
        corporateTax,
        localCorporateTax,
        corporateInhabitantTax,
        enterpriseTax,
        specialEnterpriseTax,
      }),
      knownTaxTotal,
      totalTax: knownTaxTotal,
      calculationOrder: Object.freeze([
        'accounting_profit_before_tax',
        'tax_adjustments',
        'income_amount',
        'loss_carryforward_deduction',
        'taxable_income',
        'corporate_tax',
        'local_corporate_tax',
        'corporate_inhabitant_tax',
        'enterprise_tax',
        'special_enterprise_tax',
      ]),
    };
  } catch (error) {
    if (!['CT_MASTER_UNAVAILABLE', 'CT_MASTER_AMBIGUOUS',
      'CT_PER_CAPITA_BRACKET_UNAVAILABLE'].includes(error.code)) throw error;
    return blockedResult([{ code: error.code, message: error.message }], assumptions, warnings);
  }
}

module.exports = {
  calculate,
  preflightBlockedReasons,
  calculateAdjustments,
  calculateEntertainmentAdjustment,
  calculateLossCarryforward,
  calculateProgressiveTax,
};
