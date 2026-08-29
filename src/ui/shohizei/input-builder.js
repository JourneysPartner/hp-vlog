'use strict';

const { CONSUMPTION_TAX_PERIOD } = require('./context-builder.js');

class ShohizeiInputBuildError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('\n'));
    this.name = 'ShohizeiInputBuildError';
    this.errors = Object.freeze(errors.map(item => Object.freeze({ ...item })));
    this.code = this.errors[0] && this.errors[0].code;
  }
}

function issue(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function money(value, fieldPath, errors) {
  const text = typeof value === 'bigint' ? value.toString(10) : String(value ?? '');
  if (!/^\d+$/.test(text)) {
    errors.push(issue('SZ_UI_MONEY_REQUIRED', fieldPath, '金額を円単位で入力してください'));
    return { unit: 'JPY', value: '0' };
  }
  return { unit: 'JPY', value: text };
}

function taxIncl(value, basis, fieldPath, errors) {
  if (!['inclusive', 'exclusive'].includes(basis)) {
    errors.push(issue('SZ_UI_TAX_BASIS_REQUIRED', `${fieldPath}.basis`,
      '税込または税抜を選択してください'));
  }
  return {
    basis: ['inclusive', 'exclusive'].includes(basis) ? basis : 'inclusive',
    amount: money(value, `${fieldPath}.amount.value`, errors),
  };
}

function triState(value, fieldPath, errors, label) {
  if (!['yes', 'no', 'unknown'].includes(value)) {
    errors.push(issue('SZ_UI_SELECTION_REQUIRED', fieldPath, `${label}を選択してください`));
    return 'unknown';
  }
  return value;
}

// specialistChecksは「専門確認が必要か」のフラグなので、わからないも確認要として送る。
function specialistCheck(value, fieldPath, errors, label) {
  const selected = triState(value, fieldPath, errors, label);
  return selected === 'unknown' ? 'yes' : selected;
}

function optionalDate(value, fieldPath, errors) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    errors.push(issue('SZ_UI_DATE_INVALID', fieldPath, '日付をYYYY-MM-DDで入力してください'));
    return undefined;
  }
  return text;
}

function filing(kind, status, effectiveYear, fieldPath, errors) {
  const filed = triState(status, fieldPath, errors, '届出状況');
  const result = { kind, filed };
  if (filed === 'yes') {
    const year = String(effectiveYear ?? '');
    if (!/^\d{4}$/.test(year)) {
      errors.push(issue('SZ_UI_EFFECTIVE_YEAR_REQUIRED', fieldPath,
        '届出の効力開始年を4桁で入力してください'));
    } else {
      result.effectiveFromPeriodStart = `${year}-01-01`;
    }
  }
  return result;
}

function eligibility(formState, errors) {
  const registered = triState(formState.invoiceRegistered,
    '$.eligibility.invoiceRegistration.registered', errors, 'インボイス登録状況');
  const invoiceRegistration = { registered };
  if (registered === 'yes') {
    const registeredOn = optionalDate(formState.invoiceRegisteredOn,
      '$.eligibility.invoiceRegistration.registeredOn', errors);
    if (registeredOn) invoiceRegistration.registeredOn = registeredOn;
    invoiceRegistration.becameTaxableByRegistration = triState(
      formState.becameTaxableByRegistration,
      '$.eligibility.invoiceRegistration.becameTaxableByRegistration', errors,
      '登録を機に課税事業者になったか');
  }

  const basePeriod = { exists: formState.basePeriodExists !== false };
  if (basePeriod.exists) {
    basePeriod.taxableSales = money(formState.basePeriodTaxableSales,
      '$.eligibility.basePeriod.taxableSales.value', errors);
    if (formState.taxpayerType === 'corporation') {
      const months = Number(formState.basePeriodLengthInMonths);
      if (!Number.isInteger(months) || months <= 0) {
        errors.push(issue('SZ_BASE_PERIOD_LENGTH_REQUIRED',
          '$.eligibility.basePeriod.lengthInMonths', '法人は基準期間の月数を入力してください'));
      } else basePeriod.lengthInMonths = months;
    }
  }

  return {
    invoiceRegistration,
    basePeriod,
    specifiedPeriod: {
      taxableSales: money(formState.specifiedPeriodTaxableSales,
        '$.eligibility.specifiedPeriod.taxableSales.value', errors),
      salaryPayments: money(formState.specifiedPeriodSalaryPayments,
        '$.eligibility.specifiedPeriod.salaryPayments.value', errors),
    },
    filings: [
      filing('simplified_election', formState.simplifiedElectionStatus,
        formState.simplifiedElectionEffectiveYear, '$.eligibility.filings.simplified_election', errors),
      filing('taxable_person_election', formState.taxablePersonElectionStatus,
        formState.taxablePersonElectionEffectiveYear, '$.eligibility.filings.taxable_person_election', errors),
    ],
    newCompany: {
      isNewlyEstablished: triState(formState.isNewlyEstablished,
        '$.eligibility.newCompany.isNewlyEstablished', errors, '新設法人への該当'),
      isSpecifiedNewlyEstablished: triState(formState.isSpecifiedNewlyEstablished,
        '$.eligibility.newCompany.isSpecifiedNewlyEstablished', errors, '特定新設法人への該当'),
    },
    events: {
      inheritance: triState(formState.inheritance,
        '$.eligibility.events.inheritance', errors, '相続への該当'),
      merger: triState(formState.merger,
        '$.eligibility.events.merger', errors, '合併への該当'),
      corporateSplit: triState(formState.corporateSplit,
        '$.eligibility.events.corporateSplit', errors, '会社分割への該当'),
      highValueAssetAcquisition: triState(formState.highValueAssetAcquisition,
        '$.eligibility.events.highValueAssetAcquisition', errors, '高額特定資産の取得への該当'),
      adjustableFixedAssetAcquisition: triState(formState.adjustableFixedAssetAcquisition,
        '$.eligibility.events.adjustableFixedAssetAcquisition', errors, '調整対象固定資産の取得への該当'),
    },
    taxablePeriodShortened: triState(formState.taxablePeriodShortened,
      '$.eligibility.taxablePeriodShortened', errors, '課税期間短縮への該当'),
  };
}

function transactions(formState, errors) {
  const salesValue = {
    kind: 'detailed',
    taxable: [
      { band: 'standard_10', amount: taxIncl(formState.salesStandard10,
        formState.salesStandard10Basis, '$.sales[0].value.taxable[0].amount', errors) },
      { band: 'reduced_8', amount: taxIncl(formState.salesReduced8,
        formState.salesReduced8Basis, '$.sales[0].value.taxable[1].amount', errors) },
    ],
    exportExempt: taxIncl(formState.salesExportExempt,
      formState.salesExportExemptBasis, '$.sales[0].value.exportExempt', errors),
  };
  const purchaseValue = {
    kind: 'detailed',
    taxableWithInvoice: [
      { band: 'standard_10', amount: taxIncl(formState.purchasesWithInvoiceStandard10,
        formState.purchasesWithInvoiceStandard10Basis,
        '$.purchases[0].value.taxableWithInvoice[0].amount', errors) },
      { band: 'reduced_8', amount: taxIncl(formState.purchasesWithInvoiceReduced8,
        formState.purchasesWithInvoiceReduced8Basis,
        '$.purchases[0].value.taxableWithInvoice[1].amount', errors) },
    ],
    taxableWithoutInvoice: [],
  };
  if (formState.hasPurchasesWithoutInvoice === 'yes') {
    purchaseValue.taxableWithoutInvoice.push({
      band: formState.purchasesWithoutInvoiceBand || 'standard_10',
      amount: taxIncl(formState.purchasesWithoutInvoice,
        formState.purchasesWithoutInvoiceBasis,
        '$.purchases[0].value.taxableWithoutInvoice[0].amount', errors),
      counterpartyAnnualTotal: taxIncl(formState.purchasesWithoutInvoiceAnnualTotal,
        'inclusive', '$.purchases[0].value.taxableWithoutInvoice[0].counterpartyAnnualTotal', errors),
      hasRequiredRecords: triState(formState.purchasesWithoutInvoiceRecords,
        '$.purchases[0].value.taxableWithoutInvoice[0].hasRequiredRecords', errors,
        '帳簿と請求書の保存状況'),
    });
  } else if (formState.hasPurchasesWithoutInvoice !== 'no') {
    errors.push(issue('SZ_UI_SELECTION_REQUIRED', '$.purchases[0].value.taxableWithoutInvoice',
      'インボイスなし仕入の有無を選択してください'));
  }
  return {
    sales: [{ period: { ...CONSUMPTION_TAX_PERIOD }, value: salesValue }],
    purchases: [{ period: { ...CONSUMPTION_TAX_PERIOD }, value: purchaseValue }],
  };
}

function buildShohizeiInput(formState, options = {}) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  const errors = [];
  if (!['individual', 'corporation'].includes(formState.taxpayerType)) {
    errors.push(issue('SZ_UI_TAXPAYER_TYPE_REQUIRED', '$.taxpayerType',
      '事業者の区分を選択してください'));
  }
  const input = {
    precision: 'simple',
    taxpayerType: ['individual', 'corporation'].includes(formState.taxpayerType)
      ? formState.taxpayerType : 'individual',
    eligibility: eligibility(formState, errors),
    sales: [],
    purchases: [],
    specialistChecks: {
      reverseCharge: specialistCheck(formState.reverseCharge,
        '$.specialistChecks.reverseCharge', errors, 'リバースチャージへの該当'),
      specificTaxablePurchase: specialistCheck(formState.specificTaxablePurchase,
        '$.specialistChecks.specificTaxablePurchase', errors, '特定課税仕入れへの該当'),
      complexTaxableSalesRatio: specialistCheck(formState.complexTaxableSalesRatio,
        '$.specialistChecks.complexTaxableSalesRatio', errors, '複雑な課税売上割合への該当'),
    },
  };
  if (!options.emptyTransactions) Object.assign(input, transactions(formState, errors));
  if (formState.simplifiedElectionStatus === 'yes') {
    input.simplified = { categorySelectedByUser: true };
    if (formState.simplifiedCategory) input.simplified.primaryCategory = formState.simplifiedCategory;
    else if (!options.emptyTransactions) errors.push(issue('SZ_UI_SIMPLIFIED_CATEGORY_REQUIRED',
      '$.simplified.primaryCategory', '簡易課税の事業区分を選択してください'));
  }
  if (errors.length > 0) throw new ShohizeiInputBuildError(errors);
  return input;
}

module.exports = Object.freeze({
  ShohizeiInputBuildError,
  buildShohizeiInput,
});
