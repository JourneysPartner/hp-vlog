'use strict';

const DEPENDENT_BANDS = Object.freeze([
  Object.freeze({
    key: 'dependents16To18',
    label: '16〜18歳',
    ageAtYearEnd: 17,
    relation: 'child',
    livesTogether: true,
  }),
  Object.freeze({
    key: 'dependents19To22',
    label: '19〜22歳（特定扶養）',
    ageAtYearEnd: 20,
    relation: 'child',
    livesTogether: true,
  }),
  Object.freeze({
    key: 'dependents23To69',
    label: '23〜69歳',
    ageAtYearEnd: 40,
    relation: 'child',
    livesTogether: true,
  }),
  Object.freeze({
    key: 'dependents70PlusCohabiting',
    label: '70歳以上・同居の親等',
    ageAtYearEnd: 71,
    relation: 'parent',
    livesTogether: true,
  }),
  Object.freeze({
    key: 'dependents70PlusSeparate',
    label: '70歳以上・別居',
    ageAtYearEnd: 71,
    relation: 'parent',
    livesTogether: false,
  }),
]);

function dependentCount(value) {
  const text = String(value ?? '').trim();
  if (text === '') return 0;
  if (!/^\d+$/.test(text)) return null;
  const count = Number(text);
  return Number.isSafeInteger(count) ? count : null;
}

const DISABILITY_FIELDS = Object.freeze([
  Object.freeze({ key: 'dependentDisabilityGeneral', label: '一般障害者', category: 'general' }),
  Object.freeze({ key: 'dependentDisabilitySpecial', label: '特別障害者', category: 'special' }),
  Object.freeze({
    key: 'dependentDisabilitySpecialCohabiting',
    label: '特別障害者（同居）',
    category: 'special_cohabiting',
  }),
]);

function appendFamilyFacts(target, formState, {
  money,
  errors,
  issue,
  spousePath,
  dependentsPath,
  codePrefix,
}) {
  if (formState.spouseExists === 'yes') {
    target.spouse = {
      exists: true,
      totalIncome: money(formState.spouseTotalIncome,
        `${spousePath}.totalIncome.value`, errors),
      disability: formState.spouseDisability || 'none',
      ...(formState.spouseAge70OrOver === true ? { ageAtYearEnd: 71 } : {}),
    };
  }

  const dependents = [];
  for (const band of DEPENDENT_BANDS) {
    const count = dependentCount(formState[band.key]);
    if (count === null) {
      errors.push(issue(
        `${codePrefix}_DEPENDENT_COUNT_INVALID`,
        `${dependentsPath}.${band.key}`,
        `${band.label}の人数を0以上の整数で入力してください`
      ));
      continue;
    }
    for (let index = 0; index < count; index++) {
      dependents.push({
        id: `${band.key}-${index + 1}`,
        ageAtYearEnd: band.ageAtYearEnd,
        relation: band.relation,
        livesTogether: band.livesTogether,
        totalIncome: { unit: 'JPY', value: '0' },
      });
    }
  }

  const disabilityCounts = new Map();
  for (const field of DISABILITY_FIELDS) {
    const count = dependentCount(formState[field.key]);
    if (count === null) {
      errors.push(issue(
        `${codePrefix}_DEPENDENT_DISABILITY_COUNT_INVALID`,
        `${dependentsPath}.${field.key}`,
        `うち${field.label}の人数を0以上の整数で入力してください`
      ));
      disabilityCounts.set(field.category, 0);
    } else {
      disabilityCounts.set(field.category, count);
    }
  }
  const cohabitingSpecial = disabilityCounts.get('special_cohabiting');
  const cohabitingDependents = dependents.filter(dependent => dependent.livesTogether === true);
  if (cohabitingSpecial > cohabitingDependents.length) {
    errors.push(issue(
      `${codePrefix}_COHABITING_SPECIAL_DISABILITY_EXCEEDS_COHABITING_DEPENDENTS`,
      `${dependentsPath}.dependentDisabilitySpecialCohabiting`,
      '特別障害者（同居）の人数は同居している扶養親族の人数以下にしてください'
    ));
  }
  const disabilityTotal = [...disabilityCounts.values()].reduce((sum, count) => sum + count, 0);
  if (disabilityTotal > dependents.length) {
    errors.push(issue(
      `${codePrefix}_DEPENDENT_DISABILITY_TOTAL_EXCEEDS_DEPENDENTS`,
      `${dependentsPath}.dependentDisabilityGeneral`,
      '障害のある方の合計人数は扶養親族の合計人数以下にしてください'
    ));
  }

  const assigned = new Set();
  for (const dependent of cohabitingDependents.slice(0, cohabitingSpecial)) {
    dependent.disability = 'special_cohabiting';
    assigned.add(dependent);
  }
  const remaining = dependents.filter(dependent => !assigned.has(dependent));
  let offset = 0;
  for (const category of ['special', 'general']) {
    const count = disabilityCounts.get(category);
    for (const dependent of remaining.slice(offset, offset + count)) dependent.disability = category;
    offset += count;
  }
  if (dependents.length > 0) target.dependents = dependents;
  return target;
}

module.exports = Object.freeze({
  DEPENDENT_BANDS,
  DISABILITY_FIELDS,
  dependentCount,
  appendFamilyFacts,
});
