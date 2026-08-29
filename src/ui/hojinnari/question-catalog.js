'use strict';

const RESOLUTION_TYPES = Object.freeze({
  REDISPLAY_SELECTION: 'redisplay_selection',
  ACTUAL_AMOUNT: 'actual_amount',
  CONSULTATION: 'consultation',
});

function entry(heading, description, resolutionType, fieldPath) {
  return Object.freeze({ heading, description, resolutionType, fieldPath });
}

const BLUE_RETURN = entry(
  '青色申告の控除区分を確認してください',
  '青色申告の控除区分が確認できないため計算を止めました。確定申告書の控えの「青色申告特別控除額」をご確認ください',
  RESOLUTION_TYPES.REDISPLAY_SELECTION,
  '$.individual.blueReturn'
);
const BUSINESS_TAX = entry(
  '個人事業税の業種区分を確認してください',
  '個人事業税の業種区分が確認できないため計算を止めました。都道府県税事務所の納税通知書で確認できます',
  RESOLUTION_TYPES.REDISPLAY_SELECTION,
  '$.individual.business.businessTaxCategory'
);
const NHI_SELECTION = entry(
  '国民健康保険料の入力方法を選んでください',
  '実額を入力するか、登録済み自治体の料率で概算するかを選択してください',
  RESOLUTION_TYPES.REDISPLAY_SELECTION,
  '$.individual.nationalHealthInsurance'
);
const PENSION_SELECTION = entry(
  '国民年金の納付状況を選んでください',
  '通常どおり納付、実額入力、免除のいずれかを選択してください',
  RESOLUTION_TYPES.REDISPLAY_SELECTION,
  '$.individual.nationalPension'
);
const NHI_ACTUAL = entry(
  '国民健康保険料の実額が必要です',
  'お住まいの自治体の料率は未登録のため、実際の年間保険料の入力をお願いします',
  RESOLUTION_TYPES.ACTUAL_AMOUNT,
  '$.individual.nationalHealthInsurance.annualAmount'
);
const LOSS = entry(
  '赤字事業の比較は対応準備中です',
  '事業所得が赤字となるため、このシミュレーターでは比較できません（損益通算は対応準備中）',
  RESOLUTION_TYPES.CONSULTATION
);
const UNSUPPORTED = entry(
  '対応範囲外の条件です',
  'この条件はシミュレーターの対応範囲外です',
  RESOLUTION_TYPES.CONSULTATION
);

const QUESTION_CATALOG = Object.freeze({
  HJ_BLUE_RETURN_STATUS_UNKNOWN: BLUE_RETURN,
  HJ_BLUE_RETURN_DEDUCTION_CATEGORY_REQUIRED: BLUE_RETURN,
  HJ_BUSINESS_TAX_CATEGORY_REQUIRED: BUSINESS_TAX,
  HJ_BUSINESS_TAX_CATEGORY_UNKNOWN: BUSINESS_TAX,
  HJ_NHI_SELECTION_REQUIRED: NHI_SELECTION,
  HJ_NATIONAL_PENSION_SELECTION_REQUIRED: PENSION_SELECTION,
  HJ_NHI_NHI_MUNICIPAL_RATE_NOT_REGISTERED: NHI_ACTUAL,
  HJ_UI_NHI_ACTUAL_REQUIRED_FOR_OTHER_MUNICIPALITY: NHI_ACTUAL,
  IT_BUSINESS_LOSS_OFFSET_UNSUPPORTED: LOSS,
  HJ_INCOME_TAX_IT_BUSINESS_LOSS_OFFSET_UNSUPPORTED: LOSS,
  HJ_SPECIALIST_PROFILE_UNSUPPORTED: UNSUPPORTED,
});

const SPEC_REASON_CODES = Object.freeze([
  'HJ_BLUE_RETURN_STATUS_UNKNOWN',
  'HJ_BLUE_RETURN_DEDUCTION_CATEGORY_REQUIRED',
  'HJ_BUSINESS_TAX_CATEGORY_REQUIRED',
  'HJ_BUSINESS_TAX_CATEGORY_UNKNOWN',
  'HJ_NHI_SELECTION_REQUIRED',
  'HJ_NATIONAL_PENSION_SELECTION_REQUIRED',
  'HJ_NHI_NHI_MUNICIPAL_RATE_NOT_REGISTERED',
  'IT_BUSINESS_LOSS_OFFSET_UNSUPPORTED',
  'HJ_SPECIALIST_PROFILE_UNSUPPORTED',
]);

function resolveQuestion(reason) {
  const value = typeof reason === 'string' ? { code: reason } : (reason || {});
  const code = value.code || 'UNKNOWN';
  const catalogEntry = QUESTION_CATALOG[code];
  if (catalogEntry) return Object.freeze({ code, ...catalogEntry, isFallback: false });
  const original = value.message || value.basis || '計算を続行できない条件があります';
  return Object.freeze({
    code,
    heading: 'この条件は個別の確認が必要です',
    description: original,
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
