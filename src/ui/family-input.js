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
  if (dependents.length > 0) target.dependents = dependents;
  return target;
}

module.exports = Object.freeze({
  DEPENDENT_BANDS,
  dependentCount,
  appendFamilyFacts,
});
