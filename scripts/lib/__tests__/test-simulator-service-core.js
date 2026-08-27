'use strict';

/**
 * シミュレーターサービス共通基盤の受け入れテスト。
 *   node scripts/lib/__tests__/test-simulator-service-core.js
 */

const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'src', 'tax-engine', 'masters', 'snapshot.js');
const VALIDATOR_PATH = path.join(REPO_ROOT, 'src', 'simulators', 'core', 'validator.js');
const RESULT_BUILDER_PATH = path.join(REPO_ROOT, 'src', 'simulators', 'core', 'result-builder.js');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function throws(action) {
  try {
    action();
    return false;
  } catch (_error) {
    return true;
  }
}

function money(value) {
  return { unit: 'JPY', value: String(value) };
}

function minimalHojinnariInput() {
  return {
    precision: 'simple',
    comparisonBasis: 'steady_state',
    individual: {
      business: {
        revenue: [{
          period: { from: '2026-01-01', to: '2026-12-31' },
          value: money(12000000),
        }],
        expenses: [],
        periodFacts: {},
      },
      blueReturn: { status: 'unknown' },
      self: {},
      residentTaxBasis: 'steady_state',
    },
    corporate: {
      locationSameAsResidence: 'unknown',
      capital: money(1000000),
      officerCompensation: { monthlySegments: [] },
      healthInsurer: { kind: 'unknown' },
      revenue: [],
      expenses: [],
    },
    consumptionTax: { include: false },
    specialistChecks: {},
  };
}

console.log('\n=== 検証1: スナップショット識別 ===');
const firstSnapshot = require(SNAPSHOT_PATH);
const firstInfo = firstSnapshot.getSnapshotInfo();
delete require.cache[require.resolve(SNAPSHOT_PATH)];
const snapshot = require(SNAPSHOT_PATH);
const secondInfo = snapshot.getSnapshotInfo();
assert(firstInfo.snapshotHash === secondInfo.snapshotHash, '2回ロードしてもsnapshotHashが一致する');
assert(firstInfo.snapshotId === secondInfo.snapshotId, '2回ロードしてもsnapshotIdが一致する');
assert(/^tax-masters-[0-9a-f]{16}$/.test(secondInfo.snapshotId), 'snapshotIdがハッシュ由来の形式である');
assert(/^\d{4}-\d{2}-\d{2}$/.test(secondInfo.legalStatusAsOf), 'legalStatusAsOfがLocalDate形式である');
const entries = [
  { path: 'data/z.json', content: Buffer.from('z') },
  { path: 'data/a.json', content: Buffer.from('a') },
];
const reordered = [...entries].reverse();
const changed = [entries[0], { path: 'data/a.json', content: Buffer.from('b') }];
assert(
  snapshot.computeSnapshotHash(entries) === snapshot.computeSnapshotHash(reordered),
  'ハッシュが入力の列挙順に依存しない'
);
assert(
  snapshot.computeSnapshotHash(entries) !== snapshot.computeSnapshotHash(changed),
  '内容を1バイト変えるとハッシュが変わる'
);

console.log('\n=== 検証2: 使用レコード追跡 ===');
snapshot.beginRecordTracking();
snapshot.find('casualty_loss_scope', { onDate: '2026-08-01' });
snapshot.find('national_pension_monthly_premium', { onDate: '2026-08-01' });
snapshot.find('casualty_loss_scope', { onDate: '2026-08-01' });
const trackedRecords = snapshot.endRecordTracking();
assert(trackedRecords.length === 2, 'findで引いた2レコードを重複なしで収集する');
assert(
  trackedRecords.every(record =>
    record.verificationMode === 'single_primary_with_alternative_controls' &&
    record.alternativeControlRefs.officialExampleCaseIds.length === 0),
  'v1の代替統制と公式計算例未登録を明示する'
);
snapshot.beginRecordTracking();
assert(throws(() => snapshot.beginRecordTracking()), '追跡の入れ子開始を例外にする');
snapshot.endRecordTracking();
snapshot.find('casualty_loss_scope', { onDate: '2026-08-01' });
snapshot.beginRecordTracking();
assert(snapshot.endRecordTracking().length === 0, '追跡外のfindを収集しない');
snapshot.beginRecordTracking();
const bracket = snapshot.findBracket(
  'basic_deduction_table',
  { unit: 'JPY', value: 500000n },
  { taxYear: 2026 }
);
const bracketRecords = snapshot.endRecordTracking();
assert(
  bracketRecords.length === 1 && bracketRecords[0].recordId === bracket.record_id,
  'findBracketは候補全体でなく返した1レコードだけを収集する'
);

console.log('\n=== 検証3: Wire入力の実行時検証 ===');
const { validateInput } = require(VALIDATOR_PATH);
const valid = validateInput('hojinnari', minimalHojinnariInput());
assert(valid.ok, '正しいHojinnariInputの最小形がokになる');
assert(
  valid.ok && typeof valid.value.individual.business.revenue[0].value.value === 'bigint',
  'ok時にMoneyのvalueがbigintへ変換される'
);
assert(
  valid.ok && !Object.hasOwn(valid.value.corporate, 'employeeCount'),
  '省略可能フィールドの欠損をそのまま通す'
);

const unknownProperty = minimalHojinnariInput();
unknownProperty.unexpected = true;
const unknownResult = validateInput('hojinnari', unknownProperty);
assert(
  !unknownResult.ok && unknownResult.errors.some(error => error.code === 'unknown_property'),
  '未知のプロパティを拒否する'
);

const invalidKind = minimalHojinnariInput();
invalidKind.corporate.healthInsurer = { kind: 'invalid' };
const invalidKindResult = validateInput('hojinnari', invalidKind);
assert(
  !invalidKindResult.ok && invalidKindResult.errors.some(error => error.code === 'invalid_discriminator'),
  '判別可能ユニオンの不正なkindを拒否する'
);

const exponentMoney = minimalHojinnariInput();
exponentMoney.corporate.capital.value = '1e3';
const exponentResult = validateInput('hojinnari', exponentMoney);
assert(
  !exponentResult.ok && exponentResult.errors.some(error =>
    error.fieldPath === '$.corporate.capital.value'),
  'MoneyWireの指数表記を拒否する'
);

const reversedRange = minimalHojinnariInput();
reversedRange.individual.business.revenue[0].period = {
  from: '2026-12-31',
  to: '2026-01-01',
};
assert(
  !validateInput('hojinnari', reversedRange).ok,
  'DateRangeのfromがtoより後なら拒否する'
);

const overlappingSegments = minimalHojinnariInput();
overlappingSegments.individual.business.revenue.push({
  period: { from: '2026-12-31', to: '2027-01-31' },
  value: money(1),
});
const overlapResult = validateInput('hojinnari', overlappingSegments);
assert(
  !overlapResult.ok && overlapResult.errors.some(error => error.code === 'period_segment_overlap'),
  'PeriodSegmentの閉区間の重なりを拒否する'
);

const unorderedSegments = minimalHojinnariInput();
unorderedSegments.individual.business.revenue.push({
  period: { from: '2025-01-01', to: '2025-12-31' },
  value: money(1),
});
const orderResult = validateInput('hojinnari', unorderedSegments);
assert(
  !orderResult.ok && orderResult.errors.some(error => error.code === 'period_segment_order'),
  'PeriodSegmentの並び順違反を拒否する'
);

console.log('\n=== 検証4: 結果の組み立て ===');
const {
  buildSimulationResult,
  toServiceWarning,
} = require(RESULT_BUILDER_PATH);
const context = {
  asOfDate: secondInfo.legalStatusAsOf,
  calculatedAt: '2026-08-27T12:00:00+09:00',
  fiscalPeriod: { from: '2026-04-01', to: '2027-03-31' },
  jurisdiction: {
    country: 'JP',
    codeSystemVersion: '2026-01',
    asOfForCodes: '2026-04-01',
  },
  masterSnapshotId: secondInfo.snapshotId,
  masterSnapshotHash: secondInfo.snapshotHash,
};
const baseOptions = {
  simulatorType: 'hojinnari',
  periodLabel: '2026年度',
  comparisonBasis: 'steady_state',
  resultStatus: 'complete',
  summary: { title: '試算結果', amount: { unit: 'JPY', value: 100n } },
  assumptions: [],
  warnings: [{ code: 'CT_LOCAL_TAX_STANDARD_RATES', message: '標準税率で概算しました' }],
  masters: secondInfo,
  calculationContext: context,
  usedMasterRecords: [trackedRecords[0]],
  precision: 'simple',
  excludedItems: [],
  breakdown: { kind: 'hojinnari', data: {} },
};
assert(
  throws(() => buildSimulationResult({
    ...baseOptions,
    masters: { ...secondInfo, snapshotHash: '0'.repeat(64) },
  })),
  'スナップショット不一致を例外にする'
);

const result = buildSimulationResult(baseOptions);
assert(
  result.calculationVersion === 'calc-2026.08.1' &&
    result.inputSchemaVersion === 'hojinnari-1.0' &&
    result.supportedProfileVersion === 'initial-1',
  '結果へ共通定義の3つの版番号を載せる'
);
assert(
  result.warnings[0].level === 'attention' && result.warnings[0].canContinue === true &&
    result.warnings[0].basis === '標準税率で概算しました',
  'エンジン警告を§61の形へ変換する'
);
assert(
  result.sources.length === 1 && result.sources[0].sourceId === trackedRecords[0].sourceIds[0] &&
    typeof result.sources[0].title === 'string' && typeof result.sources[0].url === 'string',
  '使用レコードのsourceIdsから出典台帳を引く'
);
assert(
  result.assumptions.includes(snapshot.ALTERNATIVE_CONTROL_ASSUMPTION),
  'v1の代替統制の逸脱をassumptionsへ加える'
);
const unknownWarning = toServiceWarning({ code: 'FUTURE_UNKNOWN', message: '将来追加された警告' });
assert(
  unknownWarning.level === 'attention' && unknownWarning.canContinue === true &&
    unknownWarning.basis.includes('既定値を適用'),
  '未知の警告コードへ既定を適用した事実を記録する'
);

const missingSourceResult = buildSimulationResult({
  ...baseOptions,
  warnings: [],
  usedMasterRecords: [{
    ...trackedRecords[0],
    sourceIds: ['NOT-IN-REGISTRY'],
  }],
});
assert(
  missingSourceResult.resultStatus === 'blocked' &&
    missingSourceResult.warnings.some(warning => warning.code === 'MASTER_SOURCE_NOT_REGISTERED') &&
    !Object.hasOwn(missingSourceResult.summary, 'amount'),
  '想定内の出典不足は例外でなくblockedにする'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
