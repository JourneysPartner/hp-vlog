'use strict';

const RESOLUTION_TYPES = Object.freeze({
  INPUT: 'input',
  APPRAISAL: 'appraisal',
  CONSULTATION: 'consultation',
  INFORMATION: 'information',
});

function entry(heading, description, resolutionType = RESOLUTION_TYPES.CONSULTATION, fieldPath) {
  return Object.freeze({ heading, description, resolutionType, fieldPath });
}

const INPUT = RESOLUTION_TYPES.INPUT;
const APPRAISAL = RESOLUTION_TYPES.APPRAISAL;
const CONSULTATION = RESOLUTION_TYPES.CONSULTATION;
const INFORMATION = RESOLUTION_TYPES.INFORMATION;
const DEFINITIONS = {
  IHT_ADOPTED_SURCHARGE_ASSUMPTION: ['養子の税額加算を確認してください', '養子の税法上の取扱いに前提が含まれます。', CONSULTATION],
  IHT_ADOPTION_ANTI_ABUSE_NOT_ASSESSED: ['養子の判定が必要です', '養子の税法上の算入制限は個別確認が必要です。', CONSULTATION],
  IHT_ADOPTION_FACTS_REQUIRED: ['養子の状況を確認してください', '特別養子や配偶者の連れ子養子等は専門判定が必要です。', CONSULTATION],
  IHT_DIRECT_APPRAISAL_REQUIRED: ['不動産の評価額が必要です', '税額計算には相続税評価額を直接入力してください。', APPRAISAL],
  IHT_DISABILITY_AGE_REQUIRED: ['障害者控除の確認が必要です', '障害者控除は第1版UIの対象外です。', CONSULTATION],
  IHT_DISABILITY_CREDIT_OVERFLOW_NOT_TRANSFERRED: ['障害者控除の控除不足があります', '扶養義務者への控除不足額の移転は対応範囲外です。', CONSULTATION],
  IHT_DISQUALIFICATION_EXCLUSION_UNSUPPORTED: ['相続欠格・廃除の確認が必要です', 'この条件は簡易試算の対応範囲外です。', CONSULTATION],
  IHT_DISQUALIFICATION_STATUS_UNKNOWN: ['相続欠格・廃除を確認してください', '状況が不明なため専門確認が必要です。', CONSULTATION],
  IHT_ENGINE_BLOCKED: ['相続税を計算できません', '入力条件では相続税計算を完了できませんでした。', CONSULTATION],
  IHT_FOREIGN_PROPERTY: ['国外財産の確認が必要です', '国外財産は第1版の対応範囲外です。', CONSULTATION],
  IHT_FOREIGN_TAX_CREDIT_UNSUPPORTED: ['外国税額控除の確認が必要です', '外国税額控除は第1版の対応範囲外です。', CONSULTATION],
  IHT_GIFT_ADDBACK_AMOUNT_INVALID: ['生前贈与の金額を確認してください', '贈与時の価額と贈与税額は0円以上で入力してください。', INPUT],
  IHT_GIFT_ADDBACK_DATE_INVALID: ['贈与日を確認してください', '有効な贈与日を入力してください。', INPUT],
  IHT_GIFT_ADDBACK_RECIPIENT_INVALID: ['生前贈与の受贈者を確認してください', '受贈者は入力済みの相続人から選択してください。', INPUT],
  IHT_GIFT_ADDBACK_ZERO_SHARE: ['取得割合0%の相続人へ生前贈与を加算しました', '税額が過大となる安全側で加算しています。財産を取得しない人は本来加算対象外のため確認してください。', INFORMATION],
  IHT_HEIRS_REQUIRED: ['相続人を入力してください', '法定相続人を確定できる回答が必要です。', INPUT, '$.heirs'],
  IHT_INPUT_REQUIRED: ['入力内容を確認してください', '相続税計算に必要な入力が不足しています。', INPUT],
  IHT_MASTER_UNAVAILABLE: ['計算根拠を確認できません', '必要な承認済み税務マスターが利用できません。', INFORMATION],
  IHT_MINOR_AGE_REQUIRED: ['未成年者控除の確認が必要です', '未成年者控除は第1版UIの対象外です。', CONSULTATION],
  IHT_MINOR_CREDIT_OVERFLOW_NOT_TRANSFERRED: ['未成年者控除の控除不足があります', '扶養義務者への控除不足額の移転は対応範囲外です。', CONSULTATION],
  IHT_MULTIPLE_SPOUSES: ['配偶者の入力を確認してください', '配偶者を1人に確定できないため計算できません。', CONSULTATION],
  IHT_NO_STATUTORY_HEIR: ['法定相続人を確定できません', '入力を確認するか、専門家へご相談ください。', CONSULTATION],
  IHT_NON_RESIDENT: ['海外居住の確認が必要です', '被相続人または相続人が海外居住の場合は専門家へご相談ください。', CONSULTATION],
  IHT_ON_DATE_REQUIRED: ['相続開始日を確認できません', '相続開始日を確認してください。', INPUT],
  IHT_RENOUNCER_ACQUIRED_PROPERTY: ['相続放棄の判定が必要です', '相続放棄者が取得した財産は個別判定が必要です。', CONSULTATION],
  IHT_RENUNCIATION_STATUS_UNKNOWN: ['相続放棄の状況を確認してください', '状況が不明なため専門確認が必要です。', CONSULTATION],
  IHT_SETTLEMENT_TAXATION_UNSUPPORTED: ['相続時精算課税の確認が必要です', '相続時精算課税の適用財産がある場合は専門家へご相談ください。', CONSULTATION],
  IHT_SMALL_RESIDENTIAL_LAND_UNSUPPORTED: ['小規模宅地等の確認が必要です', '第1版で対応する特定居住用宅地等以外は専門判定が必要です。', CONSULTATION],
  IHT_SPOUSE_RELIEF_NOT_APPLIED_UNDIVIDED: ['未分割のため配偶者の税額軽減なしで計算しました', '未分割では配偶者の税額軽減を適用できません。', INFORMATION],
  IHT_SUBSTITUTED_SUCCESSION_UNSUPPORTED: ['代襲相続の確認が必要です', '代襲相続は第1版の対応範囲外です。', CONSULTATION],
  IHT_SUCCESSIVE_INHERITANCE_CREDIT_UNSUPPORTED: ['相次相続控除の確認が必要です', '相次相続控除は第1版の対応範囲外です。', CONSULTATION],
  SOZOKU_BENEFICIARY_HEIR_REQUIRED: ['受取人を選択してください', '相続人が受け取る保険金・退職金は、受取人となる相続人を指定してください。', INPUT],
  SOZOKU_DEBT_BEARER_REQUIRED: ['債務の負担者を選択してください', '債務・葬式費用を実際に負担する相続人を指定してください。', INPUT],
  SOZOKU_DEBT_BEARER_UNKNOWN: ['債務の負担者を確認してください', '選択した負担者が相続人入力にありません。', INPUT],
  SOZOKU_DIVISION_HEIR_DUPLICATE: ['取得割合の重複を解消してください', '同じ相続人の割合が複数入力されています。', INPUT],
  SOZOKU_DIVISION_HEIR_UNKNOWN: ['取得者を確認してください', '取得割合の相続人が相続人入力にありません。', INPUT],
  SOZOKU_DIVISION_SHARE_INVALID: ['取得割合を確認してください', '取得割合は0%以上で入力してください。', INPUT],
  SOZOKU_DIVISION_SHARE_TOTAL_INVALID: ['取得割合の合計を100%にしてください', 'すべての相続人の取得割合を合計して100%にしてください。', INPUT],
  SOZOKU_HEIR_ID_DUPLICATE: ['相続人の入力を確認してください', '相続人を識別できないため計算できません。', INPUT],
  SOZOKU_LEASEHOLD_RENTED_REQUIRES_APPRAISAL: ['借地・貸家等の評価が必要です', '借地権・貸家建付地等は評価額の直接入力または専門判定が必要です。', APPRAISAL],
  SOZOKU_LEVEL2_DIRECT_APPRAISAL_REQUIRED: ['相続税評価額を入力してください', 'LEVEL 2では路線価×面積等の概算を使わず、不動産の相続税評価額を直接入力してください。', APPRAISAL],
  SOZOKU_MULTIPLIER_AREA_REQUIRES_APPRAISAL: ['倍率地域の評価が必要です', '倍率地域は評価額の直接入力または専門判定が必要です。', APPRAISAL],
  SOZOKU_OWNERSHIP_SHARE_CONFIRMATION_REQUIRED: ['共有持分反映済みの評価額が必要です', '持分を反映した相続税評価額を直接入力してください。', APPRAISAL],
  SOZOKU_REAL_ESTATE_AREA_INVALID: ['土地面積を確認してください', '土地面積は0より大きい値で入力してください。', INPUT],
  SOZOKU_SCREENING_REAL_ESTATE_ESTIMATE: ['不動産は概算評価です', '路線価×面積等の概算は実際の相続税評価額と異なる場合があります。', INFORMATION],
  SOZOKU_SECONDARY_HEIRS_REQUIRED: ['二次相続の相続人を入力してください', '二次相続の想定相続人は1人以上で入力してください。', INPUT],
  SOZOKU_SMALL_RESIDENTIAL_LAND_SIMPLIFIED_APPLIED: ['小規模宅地等を簡易適用しました', '確認済みの入力に基づく簡易判定です。最終的な適用可否は申告前に確認してください。', INFORMATION],
  SOZOKU_SMALL_RESIDENTIAL_LAND_SPECIALIST_REVIEW: ['小規模宅地等を適用せず計算しました', '適用できる可能性があります。要件の確認は専門家へご相談ください。', CONSULTATION],
  SOZOKU_SPECIALIST_CHECK_REQUIRED: ['個別の専門判定が必要です', '代襲相続・放棄・国外財産等の条件は専門家へご相談ください。', CONSULTATION],
  SOZOKU_SPOUSE_ACQUISITION_MISMATCH: ['配偶者の取得額を確認してください', '配偶者の取得額と取得割合からの算出額が一致しません。', INPUT],
  SOZOKU_SPOUSE_RELIEF_NOT_APPLIED_LATE_DIVISION: ['申告期限後の分割のため軽減なしで計算しました', '申告期限後の分割または時期不明のため、配偶者の税額軽減を適用していません。', INFORMATION],
};

const QUESTION_CATALOG = Object.freeze(Object.fromEntries(Object.entries(DEFINITIONS)
  .map(([code, value]) => [code, entry(value[0], value[1], value[2], value[3])])));
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
    resolutionType: CONSULTATION,
    isFallback: true,
  });
}

module.exports = Object.freeze({
  RESOLUTION_TYPES,
  QUESTION_CATALOG,
  SPEC_REASON_CODES,
  resolveQuestion,
});
