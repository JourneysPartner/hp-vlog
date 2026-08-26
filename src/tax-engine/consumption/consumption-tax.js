'use strict';

/**
 * 消費税の方式別税額計算（国内の通常課税期間・第1版）。
 *
 * 適用方式の判定は行わない。呼出側が method を指定し、このモジュールは
 * 指定された方式を、税率別・取引期間別の入力から割戻し計算する。
 */

const masters = require('../masters/snapshot.js');
const {
  money,
  exact,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  multiplyRateByExact,
  addExact,
  subtractExact,
  addMoney,
  compareExactToMoney,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');
const { inputMoney, masterRate } = require('../income/helpers.js');

const BASE_ROUNDING_RULE_ID = 'R-TRUNC-1000-BASE';
const STAGE_ROUNDING_RULE_ID = 'R-TRUNC-1-CT-STAGE';
const FINAL_ROUNDING_RULE_ID = 'R-TRUNC-100-TAX';
const SUPPORTED_METHODS = Object.freeze(['general', 'simplified', 'two_wari']);

function zeroMoney() {
  return money({ unit: 'JPY', value: 0n });
}

function zeroExact() {
  return moneyToExact(zeroMoney());
}

function sumMoney(values) {
  return values.reduce((total, value) => addMoney(total, value), zeroMoney());
}

function sumExact(values) {
  return values.reduce((total, value) => addExact(total, value), zeroExact());
}

function addReason(reasons, code, message, extra = {}) {
  if (reasons.some(reason => reason.code === code && reason.itemIndex === extra.itemIndex)) return;
  reasons.push({ code, message, ...extra });
}

function blockedResult(method, reasons) {
  return {
    status: 'blocked',
    resultStatus: 'blocked',
    method,
    blockedReasons: reasons,
    excludedItems: [],
    assumptions: [],
    warnings: [],
  };
}

function requiredRecord(valueKey, criterion, predicate = () => true) {
  const records = masters.find(valueKey, criterion).filter(predicate);
  if (records.length !== 1) {
    const error = new Error(`消費税マスターを一意に選べません: ${valueKey}`);
    error.code = records.length === 0 ? 'CT_MASTER_UNAVAILABLE' : 'CT_MASTER_AMBIGUOUS';
    throw error;
  }
  return records[0];
}

function assertLocalDate(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${fieldName} はYYYY-MM-DDで指定してください`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) {
    throw new RangeError(`${fieldName} は実在する日付で指定してください`);
  }
  return value;
}

function normalizePeriod(source, fieldName) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${fieldName} はfromとtoで指定してください`);
  }
  const from = assertLocalDate(source.from, `${fieldName}.from`);
  const to = assertLocalDate(source.to, `${fieldName}.to`);
  if (from > to) throw new RangeError(`${fieldName}.from はto以前で指定してください`);
  return { from, to };
}

function taxablePeriodOf(input, options) {
  return normalizePeriod(options.taxablePeriod || input.taxablePeriod, 'taxablePeriod');
}

function normalizeTaxIncl(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !['inclusive', 'exclusive'].includes(value.basis)) {
    throw new TypeError(`${fieldName} はbasisとamountを持つTaxInclで指定してください`);
  }
  const amount = inputMoney(value.amount, `${fieldName}.amount`);
  if (amount.value < 0n) throw new RangeError(`${fieldName}.amount は0円以上で指定してください`);
  return { basis: value.basis, amount };
}

function bandValueKey(band) {
  if (band === 'standard_10') return 'consumption_tax_rate_standard';
  if (band === 'reduced_8') return 'consumption_tax_rate_reduced';
  if (band === 'old_8') return null;
  throw new RangeError(`未知の消費税率区分です: ${band}`);
}

function rateRecordForBand(band, onDate) {
  const valueKey = bandValueKey(band);
  if (valueKey === null) return null;
  return requiredRecord(valueKey, { onDate });
}

function reciprocalGrossRate(record) {
  const combined = masterRate(record.combined_rate);
  return rate({ num: combined.den, den: combined.den + combined.num });
}

function nationalTaxFromInclusiveRate(record) {
  const combined = masterRate(record.combined_rate);
  const national = masterRate(record.national_rate);
  return rate({
    num: national.num * combined.den,
    den: national.den * (combined.den + combined.num),
  });
}

function taxableBaseExact(amountExact, basis, rateRecord) {
  return basis === 'inclusive'
    ? multiplyRateByExact(reciprocalGrossRate(rateRecord), amountExact)
    : exact(amountExact);
}

function purchaseTaxExact(amount, rateRecord) {
  const taxIncl = normalizeTaxIncl(amount, 'purchase.amount');
  const taxRate = taxIncl.basis === 'inclusive'
    ? nationalTaxFromInclusiveRate(rateRecord)
    : masterRate(rateRecord.national_rate);
  return multiplyRateByMoney(taxRate, taxIncl.amount);
}

function hasPositiveTaxIncl(value) {
  return value !== undefined && value !== null &&
    normalizeTaxIncl(value, 'excluded.amount').amount.value > 0n;
}

function salesEntries(input, reasons) {
  const entries = [];
  for (let segmentIndex = 0; segmentIndex < (input.sales || []).length; segmentIndex++) {
    const segment = input.sales[segmentIndex];
    normalizePeriod(segment.period, `sales[${segmentIndex}].period`);
    const value = segment.value;
    if (!value || !['simple', 'detailed'].includes(value.kind)) {
      throw new TypeError(`sales[${segmentIndex}].value.kind が不正です`);
    }
    if (hasPositiveTaxIncl(value.exportExempt)) {
      addReason(reasons, 'CT_EXPORT_REFUND_UNSUPPORTED',
        '輸出免税売上を含む還付計算は第1版では計算できません');
    }
    if (value.kind === 'detailed') {
      if ((value.returnsAndDiscounts || []).some(item => hasPositiveTaxIncl(item.amount))) {
        addReason(reasons, 'CT_SALES_RETURNS_UNSUPPORTED',
          '売上返品・値引きは第1版では計算できません');
      }
      if ((value.badDebts || []).some(item => hasPositiveTaxIncl(item.amount))) {
        addReason(reasons, 'CT_BAD_DEBTS_UNSUPPORTED',
          '貸倒れは第1版では計算できません');
      }
      for (const item of value.taxable || []) {
        if (item.band === 'old_8') {
          addReason(reasons, 'CT_OLD_TAX_RATE_UNSUPPORTED',
            '旧税率の取引は第1版では計算できません');
          continue;
        }
        const taxIncl = normalizeTaxIncl(item.amount, 'sales.taxable.amount');
        entries.push({
          band: item.band,
          basis: taxIncl.basis,
          amountExact: moneyToExact(taxIncl.amount),
        });
      }
      continue;
    }

    const total = normalizeTaxIncl(value.taxableTotal, 'sales.taxableTotal');
    const standardRatio = rate({
      num: BigInt(value.standardRatio.num), den: BigInt(value.standardRatio.den),
    });
    const reducedRatio = rate({
      num: BigInt(value.reducedRatio.num), den: BigInt(value.reducedRatio.den),
    });
    if (standardRatio.num * reducedRatio.den + reducedRatio.num * standardRatio.den !==
        standardRatio.den * reducedRatio.den) {
      throw new RangeError('standardRatio と reducedRatio の合計は1にしてください');
    }
    entries.push({
      band: 'standard_10', basis: total.basis,
      amountExact: multiplyRateByMoney(standardRatio, total.amount),
    }, {
      band: 'reduced_8', basis: total.basis,
      amountExact: multiplyRateByMoney(reducedRatio, total.amount),
    });
  }
  if (entries.length === 0) {
    addReason(reasons, 'CT_TAXABLE_SALES_REQUIRED', '税率別の課税売上を入力してください');
  }
  return entries;
}

function calculateSalesTax(input, taxablePeriod, reasons) {
  const entries = salesEntries(input, reasons);
  const bands = [];
  for (const band of ['standard_10', 'reduced_8']) {
    const rateRecord = rateRecordForBand(band, taxablePeriod.to);
    const matching = entries.filter(item => item.band === band);
    const taxableBaseBeforeRounding = sumExact(matching.map(item =>
      taxableBaseExact(item.amountExact, item.basis, rateRecord)));
    const taxableBase = applyRounding(taxableBaseBeforeRounding, BASE_ROUNDING_RULE_ID);
    const nationalTaxBeforeRounding = multiplyRateByMoney(
      masterRate(rateRecord.national_rate), taxableBase
    );
    const nationalTax = applyRounding(nationalTaxBeforeRounding, STAGE_ROUNDING_RULE_ID);
    bands.push({
      band,
      rateRecordId: rateRecord.record_id,
      combinedRate: masterRate(rateRecord.combined_rate),
      nationalRate: masterRate(rateRecord.national_rate),
      taxableBaseBeforeRounding,
      taxableBase,
      nationalTaxBeforeRounding,
      nationalTax,
    });
  }
  return {
    bands,
    taxableBaseTotal: sumMoney(bands.map(item => item.taxableBase)),
    nationalTaxTotal: sumMoney(bands.map(item => item.nationalTax)),
  };
}

function invoiceTransitionRecord(period, transactionDate, itemIndex, reasons) {
  if (transactionDate) {
    assertLocalDate(transactionDate, `taxableWithoutInvoice[${itemIndex}].transactionDate`);
    const matches = masters.find('invoice_transition_deduction_rate', { onDate: transactionDate });
    if (matches.length === 1) return matches[0];
    addReason(reasons, 'CT_INVOICE_TRANSITION_RATE_UNAVAILABLE',
      '取引日のインボイス経過措置割合を選べません', { itemIndex });
    return null;
  }
  const from = masters.find('invoice_transition_deduction_rate', { onDate: period.from });
  const to = masters.find('invoice_transition_deduction_rate', { onDate: period.to });
  if (from.length === 1 && to.length === 1 && from[0].record_id === to[0].record_id) return from[0];
  addReason(reasons, 'CT_INVOICE_PERIOD_SPLIT_REQUIRED',
    '経過措置割合の変更日をまたぐ仕入は期間別に分けて入力してください', { itemIndex });
  return null;
}

function checkCounterpartyCap(item, taxablePeriod, itemIndex, reasons) {
  // 将来も有効な単一レコードを取得し、適用開始日はレコード自身から判定する。
  const cap = requiredRecord('invoice_counterparty_annual_cap', { onDate: '9999-12-31' });
  if (taxablePeriod.from < cap.applies_to_period_start_from) return;
  if (!item.counterpartyId || item.counterpartyAnnualTotal === undefined ||
      item.hasRequiredRecords !== 'yes') {
    addReason(reasons, 'CT_INVOICE_COUNTERPARTY_CAP_INPUT_REQUIRED',
      '相手先別上限と帳簿保存要件を確認できないため計算できません', { itemIndex });
    return;
  }
  const annualTotal = normalizeTaxIncl(item.counterpartyAnnualTotal,
    `taxableWithoutInvoice[${itemIndex}].counterpartyAnnualTotal`);
  const capAmount = inputMoney(cap.counterparty_annual_cap_amount,
    'invoice_counterparty_cap.counterparty_annual_cap_amount');
  if (annualTotal.amount.value > capAmount.value) {
    addReason(reasons, 'CT_INVOICE_COUNTERPARTY_CAP_EXCEEDED',
      '相手先別上限の超過部分を取引別に特定できないため計算できません', { itemIndex });
  }
}

function calculatePurchaseTax(input, taxablePeriod, reasons) {
  const exactByBand = new Map([
    ['standard_10', []],
    ['reduced_8', []],
  ]);
  const transitionDetails = [];
  for (let segmentIndex = 0; segmentIndex < (input.purchases || []).length; segmentIndex++) {
    const segment = input.purchases[segmentIndex];
    const period = normalizePeriod(segment.period, `purchases[${segmentIndex}].period`);
    const value = segment.value;
    if (!value || value.kind !== 'detailed') {
      addReason(reasons, 'CT_GENERAL_DETAILED_PURCHASES_REQUIRED',
        '一般課税は税率・インボイス有無別の詳細仕入入力が必要です');
      continue;
    }
    if ((value.returns || []).some(item => hasPositiveTaxIncl(item.amount))) {
      addReason(reasons, 'CT_PURCHASE_RETURNS_UNSUPPORTED',
        '仕入返品は第1版では計算できません');
    }
    for (const item of value.taxableWithInvoice || []) {
      if (item.band === 'old_8') {
        addReason(reasons, 'CT_OLD_TAX_RATE_UNSUPPORTED',
          '旧税率の取引は第1版では計算できません');
        continue;
      }
      const rateRecord = rateRecordForBand(item.band, period.to);
      exactByBand.get(item.band).push(purchaseTaxExact(item.amount, rateRecord));
    }
    for (let itemIndex = 0; itemIndex < (value.taxableWithoutInvoice || []).length; itemIndex++) {
      const item = value.taxableWithoutInvoice[itemIndex];
      if (item.band === 'old_8') {
        addReason(reasons, 'CT_OLD_TAX_RATE_UNSUPPORTED',
          '旧税率の取引は第1版では計算できません');
        continue;
      }
      checkCounterpartyCap(item, taxablePeriod, itemIndex, reasons);
      const transition = invoiceTransitionRecord(period, item.transactionDate, itemIndex, reasons);
      if (!transition) continue;
      const rateRecord = rateRecordForBand(item.band, item.transactionDate || period.to);
      const beforeTransition = purchaseTaxExact(item.amount, rateRecord);
      const afterTransition = multiplyRateByExact(
        masterRate(transition.deductible_rate), beforeTransition
      );
      exactByBand.get(item.band).push(afterTransition);
      transitionDetails.push({
        band: item.band,
        transactionPeriod: period,
        transactionDate: item.transactionDate || null,
        transitionRecordId: transition.record_id,
        deductibleRate: masterRate(transition.deductible_rate),
        taxBeforeTransition: beforeTransition,
        deductibleTax: afterTransition,
      });
    }
  }
  const bands = ['standard_10', 'reduced_8'].map(band => {
    const deductibleTaxBeforeRounding = sumExact(exactByBand.get(band));
    return {
      band,
      deductibleTaxBeforeRounding,
      deductibleTax: applyRounding(deductibleTaxBeforeRounding, STAGE_ROUNDING_RULE_ID),
    };
  });
  return {
    bands,
    transitionDetails,
    deductibleTaxTotal: sumMoney(bands.map(item => item.deductibleTax)),
  };
}

function localBurdenRate(onDate) {
  const standard = rateRecordForBand('standard_10', onDate);
  const national = masterRate(standard.national_rate);
  const local = masterRate(standard.local_rate);
  return rate({ num: local.num * national.den, den: local.den * national.num });
}

function finalize(method, taxablePeriod, salesTax, credit, details = {}) {
  const nationalTaxBeforeFinalRounding = subtractExact(
    moneyToExact(salesTax.nationalTaxTotal), moneyToExact(credit)
  );
  const nationalTax = applyRounding(nationalTaxBeforeFinalRounding, FINAL_ROUNDING_RULE_ID);
  const localRate = localBurdenRate(taxablePeriod.to);
  // 地方消費税の基礎は、必ず100円未満切捨て後の国税とする。
  const localTaxBeforeRounding = multiplyRateByMoney(localRate, nationalTax);
  const localTax = applyRounding(localTaxBeforeRounding, FINAL_ROUNDING_RULE_ID);
  const totalPayable = addMoney(nationalTax, localTax);
  return {
    status: 'complete',
    resultStatus: 'complete',
    supportedProfileVersion: 'consumption-tax-domestic-v1',
    method,
    taxablePeriod,
    blockedReasons: [],
    excludedItems: [],
    assumptions: [{
      code: 'CT_METHOD_ELIGIBILITY_PROVIDED_BY_CALLER',
      message: '方式の適用可否は呼出側で判定済みとして税額だけを計算しています',
    }],
    warnings: [],
    salesTax,
    credit,
    nationalTaxBeforeFinalRounding,
    nationalTax,
    localConsumptionTax: {
      baseNationalTax: nationalTax,
      rate: localRate,
      beforeRounding: localTaxBeforeRounding,
      amount: localTax,
    },
    totalPayable,
    calculationOrder: Object.freeze([
      'taxable_base_by_rate',
      'national_sales_tax_by_rate',
      'deductible_or_special_credit',
      'national_tax_final_rounding',
      'local_tax_from_rounded_national_tax',
    ]),
    ...details,
  };
}

function commonBlockedReasons(input, options, method) {
  const reasons = [];
  const calculationType = options.calculationType || input.calculationType || 'back_calculation';
  if (calculationType !== 'back_calculation') {
    addReason(reasons, 'CT_STACK_UP_CALCULATION_UNSUPPORTED',
      '積上げ計算は第1版では計算できません');
  }
  if (input.eligibility && input.eligibility.taxablePeriodShortened === 'yes') {
    addReason(reasons, 'CT_SHORTENED_TAXABLE_PERIOD_UNSUPPORTED',
      '課税期間の短縮は第1版では計算できません');
  }
  const checks = input.specialistChecks || {};
  if (checks.exportRefund === 'yes') {
    addReason(reasons, 'CT_EXPORT_REFUND_UNSUPPORTED',
      '輸出還付の詳細計算は第1版では計算できません');
  }
  if (checks.badDebt === 'yes') {
    addReason(reasons, 'CT_BAD_DEBTS_UNSUPPORTED', '貸倒れは第1版では計算できません');
  }
  if (checks.returns === 'yes') {
    addReason(reasons, 'CT_RETURNS_UNSUPPORTED', '返還等は第1版では計算できません');
  }
  if (method === 'general') {
    const deductionMethod = options.deductionMethod ||
      (input.general && input.general.deductionMethod) || 'full';
    if (deductionMethod !== 'full') {
      addReason(reasons, 'CT_GENERAL_DEDUCTION_METHOD_UNSUPPORTED',
        '個別対応方式・一括比例配分方式は第1版では計算できません');
    }
    if (options.fullDeductionEligible === false ||
        (input.general && input.general.fullDeductionEligible === false)) {
      addReason(reasons, 'CT_GENERAL_FULL_DEDUCTION_INELIGIBLE',
        '全額控除の要件を満たさない一般課税は第1版では計算できません');
    }
    if ((input.sales || []).some(segment => segment.value && segment.value.kind === 'simple')) {
      addReason(reasons, 'CT_GENERAL_DETAILED_SALES_REQUIRED',
        '一般課税は税率別の詳細売上入力が必要です');
    }
  }
  return reasons;
}

function calculateGeneral(input, taxablePeriod, salesTax, reasons) {
  const salesBaseBeforeRounding = sumExact(salesTax.bands.map(item =>
    item.taxableBaseBeforeRounding));
  // 全額控除の金額要件（消費税法30条2項）。5億円はマスターから引く（§3-1）。
  const fullDeductionCap = requiredRecord('full_deduction_taxable_sales_cap',
    { onDate: taxablePeriod.to });
  const fullDeductionCapAmount = money({
    unit: fullDeductionCap.threshold_amount.unit,
    value: BigInt(fullDeductionCap.threshold_amount.value),
  });
  if (compareExactToMoney(salesBaseBeforeRounding, fullDeductionCapAmount) > 0) {
    addReason(reasons, 'CT_GENERAL_TAXABLE_SALES_OVER_500M',
      '課税売上高5億円超は全額控除の対象外となるため第1版では計算できません');
  }
  const purchaseTax = calculatePurchaseTax(input, taxablePeriod, reasons);
  if (reasons.length > 0) return blockedResult('general', reasons);
  return finalize('general', taxablePeriod, salesTax, purchaseTax.deductibleTaxTotal, {
    purchaseTax,
  });
}

function simplifiedCategory(input, options, reasons) {
  const categories = [];
  if (options.businessType !== undefined) categories.push(Number(options.businessType));
  if (input.simplified && input.simplified.primaryCategory) {
    const match = /^type([1-6])$/.exec(input.simplified.primaryCategory);
    if (match) categories.push(Number(match[1]));
    else addReason(reasons, 'CT_SIMPLIFIED_CATEGORY_UNCLASSIFIABLE',
      '事業区分不能売上は第1版では計算できません');
  }
  for (const segment of input.sales || []) {
    const value = segment.value || {};
    if (value.primaryCategory) {
      const match = /^type([1-6])$/.exec(value.primaryCategory);
      if (match) categories.push(Number(match[1]));
    }
    for (const row of value.simplifiedCategoryBreakdown || []) {
      if (normalizeTaxIncl(row.amount, 'simplifiedCategoryBreakdown.amount').amount.value === 0n) {
        continue;
      }
      const match = /^type([1-6])$/.exec(row.category);
      if (match) categories.push(Number(match[1]));
      else addReason(reasons, 'CT_SIMPLIFIED_CATEGORY_UNCLASSIFIABLE',
        '事業区分不能売上は第1版では計算できません');
    }
  }
  const unique = [...new Set(categories)];
  if (unique.length === 0) {
    addReason(reasons, 'CT_SIMPLIFIED_CATEGORY_REQUIRED',
      '簡易課税の事業区分を1つ指定してください');
    return null;
  }
  if (unique.length > 1) {
    addReason(reasons, 'CT_SIMPLIFIED_MULTIPLE_CATEGORIES_UNSUPPORTED',
      '複数事業区分の特例計算は第1版では計算できません');
    return null;
  }
  return unique[0];
}

function calculateSimplified(input, options, taxablePeriod, salesTax, reasons) {
  const businessType = simplifiedCategory(input, options, reasons);
  if (reasons.length > 0) return blockedResult('simplified', reasons);
  const deemedRecord = requiredRecord('simplified_deemed_purchase_rates',
    { onDate: taxablePeriod.to }, record => record.business_type === businessType);
  const deemedPurchaseTaxBeforeRounding = multiplyRateByMoney(
    masterRate(deemedRecord.deemed_purchase_rate), salesTax.nationalTaxTotal
  );
  const deemedPurchaseTax = applyRounding(
    deemedPurchaseTaxBeforeRounding, STAGE_ROUNDING_RULE_ID
  );
  return finalize('simplified', taxablePeriod, salesTax, deemedPurchaseTax, {
    businessType,
    deemedPurchaseRate: masterRate(deemedRecord.deemed_purchase_rate),
    deemedPurchaseTaxBeforeRounding,
    deemedPurchaseTax,
  });
}

function twoWariRecord(taxablePeriod, reasons) {
  const records = masters.find('small_business_special_deduction', {
    periodIntersects: taxablePeriod,
  }).filter(record => record.record_id === 'CT-SPECIAL-2WARI');
  if (records.length !== 1) {
    addReason(reasons, 'CT_TWO_WARI_PERIOD_OUT_OF_SCOPE',
      '課税期間は2割特例の対象期間と交差しません');
    return null;
  }
  return records[0];
}

function calculateTwoWari(input, taxablePeriod, salesTax, reasons) {
  const specialRecord = twoWariRecord(taxablePeriod, reasons);
  if (!specialRecord || reasons.length > 0) return blockedResult('two_wari', reasons);
  const specialDeductionBeforeRounding = multiplyRateByMoney(
    masterRate(specialRecord.special_deduction_rate), salesTax.nationalTaxTotal
  );
  const specialDeduction = applyRounding(
    specialDeductionBeforeRounding, specialRecord.rounding_rule_id
  );
  return finalize('two_wari', taxablePeriod, salesTax, specialDeduction, {
    specialRecordId: specialRecord.record_id,
    specialDeductionRate: masterRate(specialRecord.special_deduction_rate),
    resultingBurdenRate: masterRate(specialRecord.resulting_burden_rate),
    specialDeductionBeforeRounding,
    specialDeduction,
  });
}

function calculate(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input はオブジェクトで指定してください');
  }
  const method = options.method || input.method;
  if (!SUPPORTED_METHODS.includes(method)) {
    throw new RangeError(`method は ${SUPPORTED_METHODS.join(', ')} から指定してください`);
  }
  const taxablePeriod = taxablePeriodOf(input, options);
  const reasons = commonBlockedReasons(input, options, method);
  try {
    const salesTax = calculateSalesTax(input, taxablePeriod, reasons);
    if (reasons.length > 0) return blockedResult(method, reasons);
    if (method === 'general') {
      return calculateGeneral(input, taxablePeriod, salesTax, reasons);
    }
    if (method === 'simplified') {
      return calculateSimplified(input, options, taxablePeriod, salesTax, reasons);
    }
    return calculateTwoWari(input, taxablePeriod, salesTax, reasons);
  } catch (error) {
    if (!['CT_MASTER_UNAVAILABLE', 'CT_MASTER_AMBIGUOUS'].includes(error.code)) throw error;
    return blockedResult(method, [{ code: error.code, message: error.message }]);
  }
}

/** 既存ゴールデンケースの「売上税額70万円」をエンジン経由で照合する入口。 */
function calculateTwoWariFromSalesTax(salesTaxAfterReturns, taxablePeriod) {
  const period = normalizePeriod(taxablePeriod, 'taxablePeriod');
  const reasons = [];
  const specialRecord = twoWariRecord(period, reasons);
  if (!specialRecord) return blockedResult('two_wari', reasons);
  const salesTax = inputMoney(salesTaxAfterReturns, 'salesTaxAfterReturns');
  const specialDeduction = applyRounding(
    multiplyRateByMoney(masterRate(specialRecord.special_deduction_rate), salesTax),
    specialRecord.rounding_rule_id
  );
  return {
    status: 'complete',
    specialRecordId: specialRecord.record_id,
    salesTax,
    specialDeduction,
    nationalTaxBeforeFinalRounding: subtractExact(
      moneyToExact(salesTax), moneyToExact(specialDeduction)
    ),
    nationalTax: applyRounding(subtractExact(
      moneyToExact(salesTax), moneyToExact(specialDeduction)
    ), FINAL_ROUNDING_RULE_ID),
  };
}

function compareMethods(input, options = {}) {
  const requested = options.methods || input.availableMethods || SUPPORTED_METHODS;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new TypeError('methods は1件以上の方式名の配列で指定してください');
  }
  const methods = [...new Set(requested)];
  for (const method of methods) {
    if (!SUPPORTED_METHODS.includes(method)) throw new RangeError(`未知の方式です: ${method}`);
  }
  const results = methods.map(method => calculate(input, { ...options, method }));
  const comparable = results.filter(result => result.status === 'complete')
    .map(result => ({ method: result.method, totalPayable: result.totalPayable }))
    .sort((left, right) => left.totalPayable.value < right.totalPayable.value ? -1 :
      left.totalPayable.value > right.totalPayable.value ? 1 : 0);
  return {
    status: comparable.length === results.length ? 'complete' :
      comparable.length > 0 ? 'partial' : 'blocked',
    requestedMethods: methods,
    results,
    comparable,
    minimum: comparable[0] || null,
  };
}

module.exports = {
  calculate,
  compareMethods,
  calculateTwoWariFromSalesTax,
};
