'use strict';

const masters = require('../masters/snapshot.js');
const { inputMoney, masterMoney, blocked } = require('./helpers.js');

/**
 * 呼び出し側が資格取得時決定・定時決定・随時改定を済ませ、その月に適用する報酬月額を渡す。
 * この関数は決定時期を自動判定せず、健康保険と厚生年金の等級表を別々に引く。
 */
function determineStandardRemuneration(remunerationValue, options = {}) {
  const remuneration = inputMoney(remunerationValue, 'remuneration');
  if (remuneration.value < 0n) throw new RangeError('remuneration は0円以上で指定してください');
  const criterion = { onDate: options.onDate ?? '9999-12-31' };
  const healthRow = masters.findBracket(
    'health_insurance_standard_remuneration_grades', remuneration, criterion
  );
  const pensionRow = masters.findBracket(
    'employees_pension_standard_remuneration_grades', remuneration, criterion
  );
  const blockedReasons = [];
  if (!healthRow) {
    blockedReasons.push(blocked(
      'SI_HEALTH_STANDARD_REMUNERATION_GRADE_MISSING',
      '報酬月額に対応する健康保険の標準報酬月額等級がマスターにありません'
    ));
  }
  if (!pensionRow) {
    blockedReasons.push(blocked(
      'SI_PENSION_STANDARD_REMUNERATION_GRADE_MISSING',
      '報酬月額に対応する厚生年金の標準報酬月額等級がマスターにありません'
    ));
  }
  if (blockedReasons.length > 0) return { status: 'blocked', blockedReasons, remuneration };

  return {
    status: 'complete',
    blockedReasons: [],
    remuneration,
    healthInsurance: {
      grade: healthRow.grade,
      standardRemuneration: masterMoney(healthRow.monthly_standard),
      masterRecordId: healthRow.record_id,
    },
    employeesPension: {
      grade: pensionRow.grade,
      standardRemuneration: masterMoney(pensionRow.monthly_standard),
      masterRecordId: pensionRow.record_id,
    },
    notes: [{
      code: 'SI_STANDARD_REMUNERATION_TIMING_INPUT_RESPONSIBILITY',
      message: '資格取得時決定・定時決定・随時改定の時期判定は行わず、入力をその月に適用する報酬月額として扱います',
    }],
  };
}

module.exports = {
  determine: determineStandardRemuneration,
  determineStandardRemuneration,
};
