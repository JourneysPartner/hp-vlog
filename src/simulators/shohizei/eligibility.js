'use strict';

/**
 * 消費税シミュレーター STEP1 の適用可否判定。
 * 税額は計算せず、入力事実と承認済みマスターだけから方式の候補を決める。
 */

const snapshot = require('../../tax-engine/masters/snapshot.js');

const MONTHS_IN_YEAR = 12n;
const METHOD_CODES = Object.freeze([
  'general',
  'simplified',
  'twenty_percent_special',
  'thirty_percent_special',
]);

function decision(status, reasonCodes, messages) {
  return { status, reasonCodes, messages };
}

function reason(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function uniqueReasons(reasons) {
  const seen = new Set();
  return reasons.filter(item => {
    const key = `${item.code}\u0000${item.fieldPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requiredMaster(valueKey, onDate) {
  const records = snapshot.find(valueKey, { onDate });
  if (records.length !== 1) return null;
  return records[0];
}

function masterAmount(record) {
  return record === null ? null : BigInt(record.threshold_amount.value);
}

function periodInside(segment, taxablePeriod) {
  return segment && segment.period &&
    segment.period.from >= taxablePeriod.from && segment.period.to <= taxablePeriod.to;
}

function globalBlockers(input, taxablePeriod) {
  const reasons = [];
  for (const [key, value] of Object.entries(input.specialistChecks || {})) {
    if (value === 'yes') {
      reasons.push(reason('SZ_SPECIALIST_CHECK_UNSUPPORTED', `$.specialistChecks.${key}`,
        'このシミュレーターだけでは正確な判定ができない可能性があります。'));
    }
  }

  const eligibility = input.eligibility || {};
  if (eligibility.taxablePeriodShortened === 'yes' ||
      eligibility.taxablePeriodShortened === 'unknown') {
    reasons.push(reason('SZ_TAXABLE_PERIOD_SHORTENED_UNSUPPORTED',
      '$.eligibility.taxablePeriodShortened', '課税期間の短縮は第1版の対象外です。'));
  }

  for (const key of ['isNewlyEstablished', 'isSpecifiedNewlyEstablished']) {
    const value = eligibility.newCompany && eligibility.newCompany[key];
    if (value === 'yes' || value === 'unknown') {
      reasons.push(reason('SZ_NEW_COMPANY_EXEMPTION_UNSUPPORTED',
        `$.eligibility.newCompany.${key}`,
        '新設法人・特定新設法人に関する特殊な免税点判定は専門確認が必要です。'));
    }
  }

  const eventLabels = Object.freeze({
    inheritance: '相続',
    merger: '合併',
    corporateSplit: '会社分割',
    highValueAssetAcquisition: '高額特定資産の取得',
    adjustableFixedAssetAcquisition: '調整対象固定資産の取得',
  });
  for (const [key, label] of Object.entries(eventLabels)) {
    const value = eligibility.events && eligibility.events[key];
    if (value === 'yes' || value === 'unknown') {
      reasons.push(reason('SZ_SPECIAL_EVENT_UNSUPPORTED', `$.eligibility.events.${key}`,
        `${label}に該当する可能性があるため専門確認が必要です。`));
    }
  }

  for (const collection of ['sales', 'purchases']) {
    for (let index = 0; index < (input[collection] || []).length; index++) {
      if (!periodInside(input[collection][index], taxablePeriod)) {
        reasons.push(reason('SZ_SEGMENT_OUTSIDE_TAXABLE_PERIOD',
          `$.${collection}[${index}].period`,
          '売上・仕入のセグメント期間を課税期間の内側に収めてください。'));
      }
    }
  }
  return uniqueReasons(reasons);
}

function annualizedBasePeriod(input) {
  const base = input.eligibility && input.eligibility.basePeriod;
  if (!base) {
    return { status: 'unknown', reasons: [reason('SZ_BASE_PERIOD_REQUIRED',
      '$.eligibility.basePeriod', '基準期間の有無と課税売上高を入力してください。')] };
  }
  if (base.exists === false) {
    return { status: 'known', numerator: 0n, denominator: 1n, assumptions: [
      '基準期間がないため、基準期間による強制課税はないものとして判定しました。',
    ] };
  }
  if (!base.taxableSales || typeof base.taxableSales.value !== 'bigint') {
    return { status: 'unknown', reasons: [reason('SZ_BASE_PERIOD_TAXABLE_SALES_REQUIRED',
      '$.eligibility.basePeriod.taxableSales', '基準期間の課税売上高を入力してください。')] };
  }

  if (input.taxpayerType !== 'corporation') {
    return {
      status: 'known', numerator: base.taxableSales.value, denominator: 1n, assumptions: [],
    };
  }
  if (!Number.isInteger(base.lengthInMonths) || base.lengthInMonths <= 0) {
    return { status: 'unknown', reasons: [reason('SZ_BASE_PERIOD_LENGTH_REQUIRED',
      '$.eligibility.basePeriod.lengthInMonths',
      '法人は基準期間の月数を入力してください。')] };
  }
  const months = BigInt(base.lengthInMonths);
  if (months === MONTHS_IN_YEAR) {
    return {
      status: 'known', numerator: base.taxableSales.value, denominator: 1n, assumptions: [],
    };
  }
  return {
    status: 'known',
    numerator: base.taxableSales.value * MONTHS_IN_YEAR,
    denominator: months,
    assumptions: [
      `法人の基準期間が${base.lengthInMonths}か月のため、課税売上高を12か月換算して免税点・簡易課税上限を判定しました。`,
    ],
  };
}

function compareBase(base, amount) {
  if (base.status !== 'known') return null;
  const right = amount * base.denominator;
  if (base.numerator < right) return -1;
  if (base.numerator > right) return 1;
  return 0;
}

function filingRows(input, kind) {
  return ((input.eligibility && input.eligibility.filings) || [])
    .filter(item => item.kind === kind);
}

function taxableElectionState(input, periodStart) {
  const rows = filingRows(input, 'taxable_person_election');
  if (rows.some(row => row.filed === 'yes' &&
      typeof row.effectiveFromPeriodStart === 'string' &&
      row.effectiveFromPeriodStart <= periodStart)) {
    return { forced: true, safe: false, reasons: [] };
  }
  const reasons = [];
  if (rows.length === 0) {
    reasons.push(reason('SZ_TAXABLE_PERSON_ELECTION_STATUS_REQUIRED',
      '$.eligibility.filings', '課税事業者選択届出書の提出状況を入力してください。'));
  }
  if (rows.some(row => row.filed === 'unknown')) {
    reasons.push(reason('SZ_TAXABLE_PERSON_ELECTION_STATUS_REQUIRED',
      '$.eligibility.filings', '課税事業者選択届出書を提出したか確認してください。'));
  }
  if (rows.some(row => row.filed === 'yes' &&
      typeof row.effectiveFromPeriodStart !== 'string')) {
    reasons.push(reason('SZ_TAXABLE_PERSON_ELECTION_EFFECTIVE_DATE_REQUIRED',
      '$.eligibility.filings', '課税事業者選択届出書の効力が生じる課税期間を入力してください。'));
  }
  return { forced: false, safe: reasons.length === 0, reasons };
}

function specifiedPeriodState(input, exemptionThreshold) {
  const specified = input.eligibility && input.eligibility.specifiedPeriod;
  const sales = specified && specified.taxableSales;
  const salary = specified && specified.salaryPayments;
  const salesKnown = sales && typeof sales.value === 'bigint';
  const salaryKnown = salary && typeof salary.value === 'bigint';

  if (salesKnown && sales.value <= exemptionThreshold) {
    return { forced: false, safe: true, reasons: [], assumptions: [
      '特定期間の課税売上高が免税点以下であるため、特定期間による強制課税はないものと判定しました。',
    ] };
  }
  if (salaryKnown && salary.value <= exemptionThreshold) {
    return { forced: false, safe: true, reasons: [], assumptions: [
      '特定期間の給与等支払額が免税点以下であるため、特定期間による強制課税はないものと判定しました。',
    ] };
  }
  if (salesKnown && salaryKnown) {
    return { forced: true, safe: false, reasons: [], assumptions: [
      '特定期間の課税売上高と給与等支払額がともに免税点を超えるため、課税事業者と判定しました。',
    ] };
  }

  const reasons = [];
  if (!salesKnown) {
    reasons.push(reason('SZ_SPECIFIED_PERIOD_TAXABLE_SALES_REQUIRED',
      '$.eligibility.specifiedPeriod.taxableSales',
      '特定期間の課税売上高を入力してください。'));
  }
  if (!salaryKnown) {
    reasons.push(reason('SZ_SPECIFIED_PERIOD_SALARY_PAYMENTS_REQUIRED',
      '$.eligibility.specifiedPeriod.salaryPayments',
      '特定期間の給与等支払額を入力してください。'));
  }
  return { forced: false, safe: false, reasons, assumptions: [] };
}

function determineTaxLiability(input, taxablePeriod) {
  const registration = input.eligibility && input.eligibility.invoiceRegistration;
  if (!registration || registration.registered === 'unknown') {
    return { status: 'blocked', reasons: [reason('SZ_INVOICE_REGISTRATION_STATUS_REQUIRED',
      '$.eligibility.invoiceRegistration.registered',
      'インボイス登録の有無を選択してください。')], assumptions: [] };
  }
  if (registration.registered === 'yes') {
    return { status: 'taxable', reasons: [], assumptions: [
      'インボイス登録済みのため課税事業者として判定しました。',
    ], basePeriod: annualizedBasePeriod(input) };
  }

  const thresholdRecord = requiredMaster('taxable_sales_exemption_threshold', taxablePeriod.to);
  if (thresholdRecord === null) {
    return { status: 'blocked', reasons: [reason('SZ_EXEMPTION_THRESHOLD_MASTER_BLOCKED',
      '$.eligibility', '免税点の承認済みマスターを一意に選べません。')], assumptions: [] };
  }
  const threshold = masterAmount(thresholdRecord);
  const base = annualizedBasePeriod(input);
  const baseForced = compareBase(base, threshold) === 1;
  const baseSafe = base.status === 'known' && !baseForced;
  const specified = specifiedPeriodState(input, threshold);
  const election = taxableElectionState(input, taxablePeriod.from);
  const assumptions = [
    ...(base.assumptions || []),
    ...(specified.assumptions || []),
  ];

  if (baseForced) {
    assumptions.push('基準期間の課税売上高が免税点を超えるため課税事業者と判定しました。');
  }
  if (baseForced || specified.forced || election.forced) {
    if (election.forced) {
      assumptions.push('課税事業者選択届出書の効力が課税期間に及ぶため課税事業者と判定しました。');
    }
    return { status: 'taxable', reasons: [], assumptions, basePeriod: base };
  }
  if (baseSafe && specified.safe && election.safe) {
    return { status: 'exempt', reasons: [], assumptions, basePeriod: base };
  }
  return {
    status: 'blocked',
    reasons: uniqueReasons([
      ...(base.status === 'unknown' ? base.reasons : []),
      ...(!specified.safe ? specified.reasons : []),
      ...(!election.safe ? election.reasons : []),
    ]),
    assumptions,
    basePeriod: base,
  };
}

function masterBlockedDecision(code, message) {
  return decision('blocked', [code], [message]);
}

function simplifiedDecision(input, taxablePeriod, base, ceilingRecord) {
  if (ceilingRecord === null) {
    return masterBlockedDecision('SZ_SIMPLIFIED_CEILING_MASTER_BLOCKED',
      '簡易課税上限の承認済みマスターを一意に選べません。');
  }
  if (base.status !== 'known') {
    return decision('unknown', base.reasons.map(item => item.code),
      base.reasons.map(item => item.message));
  }
  if (compareBase(base, masterAmount(ceilingRecord)) === 1) {
    return decision('ineligible', ['SZ_SIMPLIFIED_BASE_PERIOD_OVER_CEILING'],
      ['基準期間の課税売上高が簡易課税の適用上限を超えています。']);
  }

  const cancellations = filingRows(input, 'simplified_election_cancel');
  if (cancellations.some(row => row.filed === 'yes' &&
      typeof row.effectiveFromPeriodStart === 'string' &&
      row.effectiveFromPeriodStart <= taxablePeriod.from)) {
    return decision('ineligible', ['SZ_SIMPLIFIED_ELECTION_CANCELLED'],
      ['簡易課税制度選択不適用届出書の効力がこの課税期間に及びます。']);
  }
  if (cancellations.some(row => row.filed === 'unknown' ||
      (row.filed === 'yes' && typeof row.effectiveFromPeriodStart !== 'string'))) {
    return decision('unknown', ['SZ_SIMPLIFIED_ELECTION_CANCEL_STATUS_UNKNOWN'],
      ['簡易課税制度選択不適用届出書の状況と効力発生日を確認してください。']);
  }

  const elections = filingRows(input, 'simplified_election');
  if (elections.some(row => row.filed === 'yes' &&
      typeof row.effectiveFromPeriodStart === 'string' &&
      row.effectiveFromPeriodStart <= taxablePeriod.from)) {
    return decision('eligible', ['SZ_SIMPLIFIED_REQUIREMENTS_MET'],
      ['基準期間の売上要件と簡易課税選択届出を確認しました。']);
  }
  if (elections.length === 0 || elections.some(row => row.filed === 'unknown') ||
      elections.some(row => row.filed === 'yes' &&
        typeof row.effectiveFromPeriodStart !== 'string')) {
    return decision('unknown', ['SZ_SIMPLIFIED_ELECTION_STATUS_UNKNOWN'],
      ['簡易課税選択届出書の提出状況と効力発生日を確認してください。']);
  }
  if (elections.some(row => row.filed === 'yes')) {
    return decision('ineligible', ['SZ_SIMPLIFIED_ELECTION_NOT_EFFECTIVE'],
      ['簡易課税選択届出書の効力がこの課税期間の開始時点で生じていません。']);
  }
  return decision('ineligible', ['SZ_SIMPLIFIED_ELECTION_NOT_FILED'], [
    '簡易課税選択届出書が未提出です。一般の届出期限は課税期間開始日の前日ですが、2割特例適用後には届出時期の特例があります。第1版は期限そのものの個別判定を行いません。',
  ]);
}

function specialRecord(taxablePeriod, recordId) {
  return snapshot.find('small_business_special_deduction', {
    periodIntersects: taxablePeriod,
  }).find(record => record.record_id === recordId) || null;
}

function specialDecision(input, taxablePeriod, base, thresholdRecord, kind) {
  const isThree = kind === 'three';
  const recordId = isThree ? 'CT-SPECIAL-3WARI' : 'CT-SPECIAL-2WARI';
  const periodCode = isThree
    ? 'SZ_THREE_WARI_PERIOD_OUT_OF_SCOPE'
    : 'SZ_TWO_WARI_PERIOD_OUT_OF_SCOPE';
  const record = specialRecord(taxablePeriod, recordId);
  if (record === null) {
    return decision('ineligible', [periodCode], ['対象課税期間ではありません。']);
  }
  if (isThree && input.taxpayerType === 'corporation') {
    return decision('ineligible', ['SZ_THREE_WARI_CORPORATION_INELIGIBLE'],
      ['法人のため3割特例の対象外です。']);
  }
  if (thresholdRecord === null) {
    return masterBlockedDecision('SZ_EXEMPTION_THRESHOLD_MASTER_BLOCKED',
      '免税点の承認済みマスターを一意に選べません。');
  }
  if (base.status === 'known' && compareBase(base, masterAmount(thresholdRecord)) === 1) {
    return decision('ineligible', ['SZ_SPECIAL_BASE_PERIOD_OVER_THRESHOLD'],
      ['基準期間の課税売上高が免税点を超えるため特例の対象外です。']);
  }

  const became = input.eligibility.invoiceRegistration.becameTaxableByRegistration;
  if (became === 'no') {
    return decision('ineligible', ['SZ_NOT_TAXABLE_BY_INVOICE_REGISTRATION'],
      ['インボイス登録を機に免税事業者から課税事業者になった場合に該当しません。']);
  }
  if (filingRows(input, 'taxable_person_election').some(row => row.filed === 'yes')) {
    return decision('blocked', ['SZ_TAXABLE_PERSON_ELECTION_SPECIALIST_CHECK'],
      ['課税事業者選択届出書提出者の特例適用可否は個別確認が必要です。']);
  }
  if (base.status !== 'known') {
    return decision('unknown', base.reasons.map(item => item.code),
      base.reasons.map(item => item.message));
  }
  if (became !== 'yes') {
    return decision('unknown', ['SZ_BECAME_TAXABLE_BY_REGISTRATION_UNKNOWN'],
      ['インボイス登録を機に免税事業者から課税事業者になったか入力してください。']);
  }
  return decision('eligible', [isThree
    ? 'SZ_THREE_WARI_REQUIREMENTS_MET'
    : 'SZ_TWO_WARI_REQUIREMENTS_MET'],
  [isThree ? '3割特例の適用要件を確認しました。' : '2割特例の適用要件を確認しました。']);
}

function evaluateMethods(input, taxablePeriod, liability) {
  const base = liability.basePeriod || annualizedBasePeriod(input);
  const threshold = requiredMaster('taxable_sales_exemption_threshold', taxablePeriod.to);
  const ceiling = requiredMaster('simplified_taxation_ceiling', taxablePeriod.to);
  return {
    general: decision('eligible', ['SZ_GENERAL_TAXABLE_PERSON'],
      ['課税事業者のため一般課税を利用できます。']),
    simplified: simplifiedDecision(input, taxablePeriod, base, ceiling),
    twenty_percent_special: specialDecision(
      input, taxablePeriod, base, threshold, 'two'
    ),
    thirty_percent_special: specialDecision(
      input, taxablePeriod, base, threshold, 'three'
    ),
  };
}

function evaluateEligibility(input, taxablePeriod) {
  const liability = determineTaxLiability(input, taxablePeriod);
  if (liability.status !== 'taxable') {
    return { liability, methods: null, assumptions: liability.assumptions || [] };
  }
  return {
    liability,
    methods: evaluateMethods(input, taxablePeriod, liability),
    assumptions: liability.assumptions || [],
  };
}

module.exports = Object.freeze({
  METHOD_CODES,
  globalBlockers,
  determineTaxLiability,
  evaluateMethods,
  evaluateEligibility,
});
