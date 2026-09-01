'use strict';

const LABELS = Object.freeze({
  casualtyLoss: '雑損控除',
  medical: '医療費控除',
  socialInsurance: '社会保険料控除',
  smallEnterpriseMutualAid: '小規模企業共済等掛金控除',
  lifeInsurance: '生命保険料控除',
  earthquakeInsurance: '地震保険料控除',
  donations: '寄附金控除',
  widowOrSingleParent: '寡婦控除・ひとり親控除',
  workingStudent: '勤労学生控除',
  disability: '障害者控除',
  spouse: '配偶者控除',
  spouseSpecial: '配偶者特別控除',
  dependents: '扶養控除',
  basic: '基礎控除',
});

function incomeDeductionRows(ordered = []) {
  return Object.freeze(ordered.map(row => Object.freeze({
    calculationOrder: row.calculationOrder,
    code: row.code,
    label: LABELS[row.code] || row.code,
    amount: row.amount,
  })));
}

module.exports = Object.freeze({ LABELS, incomeDeductionRows });
