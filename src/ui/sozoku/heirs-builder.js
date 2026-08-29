'use strict';

class SozokuHeirsBuildError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('\n'));
    this.name = 'SozokuHeirsBuildError';
    this.errors = Object.freeze(errors.map(item => Object.freeze({ ...item })));
    this.code = this.errors[0] && this.errors[0].code;
  }
}

function issue(code, fieldPath, message) {
  return Object.freeze({ code, fieldPath, message });
}

function selectedYesOrUnknown(value) {
  return value === true || value === 'yes' || value === 'unknown' ||
    value === '該当' || value === '不明' || value === 'ある' || value === 'わからない';
}

function nonNegativeCount(value, fieldPath, label, errors) {
  const text = value === undefined || value === null || value === '' ? '0' : String(value);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    errors.push(issue('SOZOKU_UI_HEIR_COUNT_INVALID', fieldPath,
      `${label}は0人以上の整数で入力してください`));
    return 0;
  }
  return Number(text);
}

function specialistCheckEntries(formState) {
  const checks = {
    deceasedDescendant: formState.deceasedDescendant ?? formState.hasDeceasedChildOrSibling,
    renunciation: formState.renunciation ?? formState.hasRenunciation,
    specialOrStepchildAdoption: formState.specialOrStepchildAdoption ??
      formState.hasSpecialOrStepchildAdoption,
    overseasResident: formState.overseasResident ?? formState.hasOverseasResident,
    ...(formState.heirSpecialistChecks || {}),
  };
  if (formState.specialistCheck !== undefined) checks.summary = formState.specialistCheck;
  if (formState.heirComplexity !== undefined) checks.summary = formState.heirComplexity;
  return Object.entries(checks);
}

function heir(id, relation) {
  return Object.freeze({
    id,
    relation,
    isAlive: true,
    residencyStatus: 'domestic_resident',
  });
}

/** STEP 1の回答から、税法判定を含まない単純な相続人配列を組み立てる。 */
function buildHeirs(formState) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('相続人の回答はオブジェクトで指定してください');
  }
  const errors = [];
  const specialist = specialistCheckEntries(formState)
    .filter(([, value]) => selectedYesOrUnknown(value));
  if (specialist.length > 0) {
    errors.push(issue('SOZOKU_UI_SPECIALIST_REVIEW_REQUIRED', '$.heirSpecialistChecks',
      '代襲相続・相続放棄・特別養子等・海外居住の確認が必要なため、この簡易試算では判定できません。専門家へご相談ください'));
  }

  const spouseValue = formState.hasSpouse ?? formState.spouse;
  if (![true, false, 'yes', 'no'].includes(spouseValue)) {
    errors.push(issue('SOZOKU_UI_SPOUSE_SELECTION_REQUIRED', '$.hasSpouse',
      '配偶者の有無を選択してください'));
  }
  const childCount = nonNegativeCount(
    formState.childCount ?? formState.naturalChildCount ?? formState.children,
    '$.childCount', '実子の人数', errors
  );
  const adoptedChildCount = nonNegativeCount(
    formState.adoptedChildCount ?? formState.adoptedChildren,
    '$.adoptedChildCount', '養子の人数', errors
  );
  const totalChildren = childCount + adoptedChildCount;
  const parentCount = totalChildren === 0 ? nonNegativeCount(
    formState.parentCount ?? formState.parents,
    '$.parentCount', 'ご両親・祖父母の人数', errors
  ) : 0;
  const siblingCount = totalChildren === 0 && parentCount === 0 ? nonNegativeCount(
    formState.siblingCount ?? formState.siblings,
    '$.siblingCount', '兄弟姉妹の人数', errors
  ) : 0;

  if (errors.length > 0) throw new SozokuHeirsBuildError(errors);

  const result = [];
  if (spouseValue === true || spouseValue === 'yes') result.push(heir('spouse', 'spouse'));
  for (let index = 1; index <= childCount; index++) result.push(heir(`child-${index}`, 'child'));
  for (let index = 1; index <= adoptedChildCount; index++) {
    result.push(heir(`adopted-child-${index}`, 'adopted_child'));
  }
  for (let index = 1; index <= parentCount; index++) result.push(heir(`parent-${index}`, 'parent'));
  for (let index = 1; index <= siblingCount; index++) {
    result.push(heir(`sibling-${index}`, 'sibling_full'));
  }
  return Object.freeze(result);
}

module.exports = Object.freeze({
  SozokuHeirsBuildError,
  buildHeirs,
  buildSozokuHeirs: buildHeirs,
});
