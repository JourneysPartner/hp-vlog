'use strict';

const RESOLUTION_TYPES = Object.freeze({
  INPUT: 'input',
  CONFIRMATION: 'confirmation',
  CONSULTATION: 'consultation',
  INFORMATION: 'information',
});

function entry(heading, description, resolutionType = RESOLUTION_TYPES.CONFIRMATION, fieldPath) {
  return Object.freeze({ heading, description, resolutionType, fieldPath });
}

const DEFINITIONS = {
  SZ_BASE_PERIOD_LENGTH_REQUIRED: ['基準期間の月数を確認してください', '法人は基準期間の月数を入力してください。', 'input'],
  SZ_BASE_PERIOD_REQUIRED: ['基準期間を確認してください', '基準期間の有無と課税売上高を入力してください。', 'input'],
  SZ_BASE_PERIOD_TAXABLE_SALES_REQUIRED: ['基準期間の売上を確認してください', '基準期間の課税売上高を入力してください。', 'input'],
  SZ_BECAME_TAXABLE_BY_REGISTRATION_UNKNOWN: ['インボイス登録時の状況を確認してください', 'インボイス登録を機に免税事業者から課税事業者になったか入力してください。', 'input'],
  SZ_ENGINE_BLOCKED: ['税額を確定できません', '入力条件では税額計算を完了できませんでした。', 'consultation'],
  SZ_EXEMPTION_THRESHOLD_MASTER_BLOCKED: ['免税点を確認できません', '免税点の承認済みマスターを一意に選べません。', 'consultation'],
  SZ_GENERAL_TAXABLE_PERSON: ['一般課税を利用できます', '課税事業者のため一般課税を利用できます。', 'information'],
  SZ_INVOICE_REGISTRATION_STATUS_REQUIRED: ['インボイス登録を確認してください', 'インボイス登録の有無を選択してください。', 'input'],
  SZ_NEW_COMPANY_EXEMPTION_UNSUPPORTED: ['新設法人の判定は専門確認が必要です', '新設法人・特定新設法人に関する特殊な免税点判定は専門確認が必要です。', 'consultation'],
  SZ_NOT_TAXABLE_BY_INVOICE_REGISTRATION: ['特例の対象外です', 'インボイス登録を機に免税事業者から課税事業者になった場合に該当しません。', 'information'],
  SZ_SEGMENT_OUTSIDE_TAXABLE_PERIOD: ['入力期間を確認してください', '売上・仕入の期間を課税期間の内側に収めてください。', 'input'],
  SZ_SIMPLIFIED_BASE_PERIOD_OVER_CEILING: ['簡易課税の対象外です', '基準期間の課税売上高が簡易課税の適用上限を超えています。', 'information'],
  SZ_SIMPLIFIED_CEILING_MASTER_BLOCKED: ['簡易課税上限を確認できません', '簡易課税上限の承認済みマスターを一意に選べません。', 'consultation'],
  SZ_SIMPLIFIED_ELECTION_CANCEL_STATUS_UNKNOWN: ['不適用届出を確認してください', '簡易課税制度選択不適用届出書の状況と効力発生日を確認してください。', 'input'],
  SZ_SIMPLIFIED_ELECTION_CANCELLED: ['簡易課税の対象外です', '簡易課税制度選択不適用届出書の効力がこの課税期間に及びます。', 'information'],
  SZ_SIMPLIFIED_ELECTION_NOT_EFFECTIVE: ['簡易課税の対象外です', '簡易課税選択届出書の効力がこの課税期間の開始時点で生じていません。', 'information'],
  SZ_SIMPLIFIED_ELECTION_NOT_FILED: ['簡易課税の届出が未提出です', '簡易課税選択届出書が未提出です。', 'information'],
  SZ_SIMPLIFIED_ELECTION_STATUS_UNKNOWN: ['簡易課税の届出を確認してください', '簡易課税選択届出書の提出状況と効力発生日を確認してください。', 'input'],
  SZ_SIMPLIFIED_REQUIREMENTS_MET: ['簡易課税を利用できます', '基準期間の売上要件と簡易課税選択届出を確認しました。', 'information'],
  SZ_SPECIAL_BASE_PERIOD_OVER_THRESHOLD: ['特例の対象外です', '基準期間の課税売上高が免税点を超えるため特例の対象外です。', 'information'],
  SZ_SPECIAL_EVENT_UNSUPPORTED: ['専門判定が必要です', '相続・合併・会社分割・高額な資産の取得等に該当する可能性があるため専門確認が必要です。', 'consultation'],
  SZ_SPECIALIST_CHECK_UNSUPPORTED: ['専門判定が必要です', 'この条件はシミュレーターの対応範囲外です。', 'consultation'],
  SZ_SPECIFIED_PERIOD_SALARY_PAYMENTS_REQUIRED: ['特定期間の給与を確認してください', '特定期間の給与等支払額を入力してください。', 'input'],
  SZ_SPECIFIED_PERIOD_TAXABLE_SALES_REQUIRED: ['特定期間の売上を確認してください', '特定期間の課税売上高を入力してください。', 'input'],
  SZ_TAXABLE_PERIOD_SHORTENED_UNSUPPORTED: ['課税期間短縮は専門判定です', '課税期間の短縮は第1版の対象外です。', 'consultation'],
  SZ_TAXABLE_PERSON_ELECTION_EFFECTIVE_DATE_REQUIRED: ['課税事業者選択届出を確認してください', '課税事業者選択届出書の効力が生じる課税期間を入力してください。', 'input'],
  SZ_TAXABLE_PERSON_ELECTION_SPECIALIST_CHECK: ['特例の専門判定が必要です', '課税事業者選択届出書提出者の特例適用可否は個別確認が必要です。', 'consultation'],
  SZ_TAXABLE_PERSON_ELECTION_STATUS_REQUIRED: ['課税事業者選択届出を確認してください', '課税事業者選択届出書の提出状況を入力してください。', 'input'],
  SZ_THREE_WARI_CORPORATION_INELIGIBLE: ['3割特例の対象外です', '法人のため3割特例の対象外です。', 'information'],
  SZ_THREE_WARI_PERIOD_OUT_OF_SCOPE: ['3割特例の対象外です', '対象課税期間ではありません。', 'information'],
  SZ_THREE_WARI_REQUIREMENTS_MET: ['3割特例を利用できます', '3割特例の適用要件を確認しました。', 'information'],
  SZ_TWO_WARI_PERIOD_OUT_OF_SCOPE: ['2割特例の対象外です', '対象課税期間ではありません。', 'information'],
  SZ_TWO_WARI_REQUIREMENTS_MET: ['2割特例を利用できます', '2割特例の適用要件を確認しました。', 'information'],
};

const QUESTION_CATALOG = Object.freeze(Object.fromEntries(Object.entries(DEFINITIONS)
  .map(([code, values]) => [code, entry(values[0], values[1], values[2], values[3])])));
const SPEC_REASON_CODES = Object.freeze(Object.keys(QUESTION_CATALOG));

function resolveQuestion(reason) {
  const value = typeof reason === 'string' ? { code: reason } : (reason || {});
  const code = value.code || 'UNKNOWN';
  const catalogEntry = QUESTION_CATALOG[code];
  if (catalogEntry) return Object.freeze({ code, ...catalogEntry, isFallback: false });
  return Object.freeze({
    code,
    heading: 'この条件は個別の確認が必要です',
    description: value.message || value.basis || '計算を続行できない条件があります。',
    resolutionType: RESOLUTION_TYPES.CONSULTATION,
    isFallback: true,
  });
}

module.exports = Object.freeze({
  RESOLUTION_TYPES,
  QUESTION_CATALOG,
  SPEC_REASON_CODES,
  resolveQuestion,
});
