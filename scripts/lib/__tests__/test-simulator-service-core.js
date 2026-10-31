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


console.log('\n=== R8: 施行前・導出値の注記 ===');
const pendingCode = 'MASTER_PENDING_LAW_APPLIED';
const derivedCode = 'MASTER_DERIVED_VALUE_APPLIED';
const effectiveRecord = { ...trackedRecords[0], legalStatus: 'effective' };
const pendingRecord = { ...effectiveRecord, legalStatus: 'enacted' };
const makeResult = (records, overrides = {}) => buildSimulationResult({
  ...baseOptions, warnings: [], usedMasterRecords: records, ...overrides,
});
for (const count of [1, 2]) {
  const actual = makeResult(Array.from({ length: count }, () => pendingRecord));
  const notices = actual.warnings.filter(w => w.code === pendingCode);
  assert(actual.resultStatus === 'partial' && notices.length === 1 &&
    notices[0].basis.includes('施行前・概算') && notices[0].level === 'attention' &&
    notices[0].canContinue === true &&
    notices[0].userAction === '申告や判断に使う前に、施行後の取扱いをご確認ください',
    count + '件のenactedから注記1件とpartialを返す');
}
assert(makeResult([pendingRecord], { resultStatus: 'partial' }).resultStatus === 'partial' &&
  makeResult([pendingRecord], { resultStatus: 'partial' }).warnings.some(w => w.code === pendingCode),
  'partialは注記を付けてpartialを保つ');
for (const overrides of [
  { resultStatus: 'blocked' },
  { usedMasterRecords: [{ ...pendingRecord, reviewStatus: 'pending' }] },
  { usedMasterRecords: [{ ...pendingRecord, sourceIds: ['NOT-IN-REGISTRY'] }] },
]) {
  const actual = makeResult([pendingRecord], overrides);
  assert(actual.resultStatus === 'blocked' && !actual.warnings.some(w => w.code === pendingCode ||
    w.code === derivedCode) && !Object.hasOwn(actual, 'breakdown'),
    '停止理由がある結果に概算注記や内訳を加えない');
}
for (const status of ['complete', 'partial']) {
  const actual = makeResult([effectiveRecord], { resultStatus: status });
  assert(actual.resultStatus === status && actual.warnings.length === 0,
    'effectiveだけなら' + status + 'と警告を変えない');
}
const derived = makeResult([
  { ...effectiveRecord, valueCertainty: 'derived', warningText: '導出の確認文' },
  { ...effectiveRecord, valueCertainty: 'derived', warningText: '導出の確認文' },
  { ...effectiveRecord, valueCertainty: 'derived', warningText: null },
  { ...effectiveRecord, requiresResultWarning: true, warningText: '別の確認文' },
  { ...effectiveRecord, requiresResultWarning: true, warningText: null },
]);
assert(derived.resultStatus === 'partial' && derived.warnings.length === 3 &&
  derived.warnings.every(w => w.code === derivedCode && w.level === 'attention' &&
    w.canContinue === true && w.userAction === '法令で確定した値をご確認ください') &&
  derived.warnings.some(w => w.basis === '導出の確認文') &&
  derived.warnings.some(w => w.basis === '別の確認文') &&
  derived.warnings.some(w => w.basis === '概算：この結果には、法令の本文に明記が無く計算で導いた値を使っています。'),
  '導出値・警告必須の記録は文ごとに重複を除き、未指定時は共通文にする');
assert(makeResult([{ ...effectiveRecord, requiresResultWarning: true }]).resultStatus === 'partial',
  '導出値でなくても警告必須の記録ならpartialにする');
assert(!makeResult([{ ...pendingRecord, valueCertainty: 'derived' }], { resultStatus: 'blocked' })
  .warnings.some(w => w.code === pendingCode || w.code === derivedCode),
  'blockedでは施行前・導出値の両方の注記を付けない');

console.log('\n=== R8: peekと追跡項目 ===');
snapshot.beginRecordTracking();
const peeked = snapshot.peek('casualty_loss_scope', { onDate: '2026-08-01' });
assert(snapshot.endRecordTracking().length === 0, 'peekの参照は使用記録に載らない');
snapshot.beginRecordTracking();
const found = snapshot.find('casualty_loss_scope', { onDate: '2026-08-01' });
const foundReferences = snapshot.endRecordTracking();
assert(require('util').isDeepStrictEqual(peeked, found) && foundReferences.length === 1,
  'peekとfindの中身は同じでfindだけが使用記録に載る');
assert(foundReferences[0].valueCertainty === (found[0].value_certainty ?? null) &&
  foundReferences[0].requiresResultWarning === (found[0].requires_result_warning === true) &&
  foundReferences[0].warningText === (typeof found[0]._warning_text === 'string' ? found[0]._warning_text : null),
  '既存の記録でも追跡3項目の既定値を保持する');
// 実ファイルは変えず、ロード時データの差替えで将来の導出値の追跡も確認する。
const sourcePath = require.resolve('../../../src/tax-engine/masters/data-source.js');
const savedSource = require.cache[sourcePath].exports;
const savedSnapshot = require.cache[SNAPSHOT_PATH];
try {
  const fixture = {
    ...found[0], value_certainty: 'derived', requires_result_warning: true,
    _warning_text: '追跡した導出値の注記',
  };
  require.cache[sourcePath].exports = { ...savedSource,
    getMasterDocuments: () => [{ content: JSON.stringify(fixture) }],
  };
  delete require.cache[SNAPSHOT_PATH];
  const fixtureSnapshot = require(SNAPSHOT_PATH);
  fixtureSnapshot.beginRecordTracking();
  fixtureSnapshot.find(fixture.value_key, { onDate: '2026-08-01' });
  const fixtureResult = makeResult(fixtureSnapshot.endRecordTracking());
  assert(fixtureResult.usedMasterRecords[0].valueCertainty === 'derived' &&
    fixtureResult.usedMasterRecords[0].requiresResultWarning === true &&
    fixtureResult.usedMasterRecords[0].warningText === fixture._warning_text &&
    fixtureResult.warnings.some(w => w.code === derivedCode && w.basis === fixture._warning_text),
    '追跡3項目が結果のusedMasterRecordsと導出値警告まで届く');
} finally {
  require.cache[sourcePath].exports = savedSource;
  require.cache[SNAPSHOT_PATH] = savedSnapshot;
}

console.log('\n=== R8: 対応年の判定 ===');
const supportPath = require.resolve('../../../src/simulators/core/supported-year.js');
const support = require(supportPath);
snapshot.beginRecordTracking();
for (const year of [2025, 2026, 2024, 2027, 2028]) {
  const reasons = support.unsupportedIncomeYearReasons(year, '$.incomeTaxYear');
  assert([2025, 2026].includes(year) ? reasons.length === 0 :
    reasons.length === 1 && reasons[0].code === 'SIM_TAX_YEAR_UNSUPPORTED' &&
    reasons[0].fieldPath === '$.incomeTaxYear' &&
    reasons[0].message === year + '年の計算にはまだ対応していません。前年の値では計算しません。',
    '所得税対応年 ' + year);
}
for (const year of [2025, 2026, 2027, 2024, 2028]) {
  const reasons = support.unsupportedConsumptionPeriodReasons({
    from: year + '-01-01', to: year + '-12-31',
  }, '$.period');
  assert(reasons.length === ([2025, 2026, 2027].includes(year) ? 0 : 1),
    '消費税対応年 ' + year);
}
const crossYear = support.unsupportedConsumptionPeriodReasons(
  { from: '2027-07-01', to: '2028-06-30' }, '$.period');
assert(crossYear.length === 1 && crossYear[0].message.startsWith('2028年') &&
  crossYear[0].fieldPath === '$.period', '期またぎは未対応の2028年だけを止める');
const multipleYears = support.unsupportedConsumptionPeriodReasons(
  { from: '2024-07-01', to: '2028-06-30' }, '$.period');
assert(multipleYears.length === 2 && multipleYears[0].message.startsWith('2024年') &&
  multipleYears[1].message.startsWith('2028年'), '期間の両端と途中の全暦年を確かめる');
assert(snapshot.endRecordTracking().length === 0, '対応年の判定を使用記録に載せない');
const savedSupport = require.cache[supportPath];
const supportedYearFixture = snapshot.peek('supported_tax_year', { taxYear: 2025 })[0];
try {
  for (const { label, records, peekCount } of [
    { label: '未承認', records: [{ ...supportedYearFixture, data_review_status: 'unverified' }], peekCount: 0 },
    { label: '欠損', records: [], peekCount: 0 },
    { label: '未知状態', records: [{ ...supportedYearFixture, support_status: 'unknown' }], peekCount: 1 },
    { label: '別年', records: [{ ...supportedYearFixture, tax_year: 2026 }], peekCount: 1 },
    { label: '重複', records: [supportedYearFixture,
      { ...supportedYearFixture, record_id: supportedYearFixture.record_id + '-DUPLICATE' }], peekCount: 2 },
  ]) {
    // peekは差し替えず、ロード時データを使って承認状態も判定する。
    require.cache[sourcePath].exports = { ...savedSource,
      getMasterDocuments: () => [{ content: JSON.stringify({ records }) }],
    };
    delete require.cache[SNAPSHOT_PATH];
    const fixtureSnapshot = require(SNAPSHOT_PATH);
    assert(fixtureSnapshot.peek('supported_tax_year', { taxYear: 2025 }).length === peekCount,
      label + 'の対応年レコードを本物のpeekで選別する');
    delete require.cache[supportPath];
    const reasons = require(supportPath).unsupportedIncomeYearReasons(2025, '$.year');
    assert(reasons.length === 1 && reasons[0].code === 'SIM_TAX_YEAR_UNSUPPORTED',
      label + 'の対応年判定は停止する');
  }
} finally {
  require.cache[sourcePath].exports = savedSource;
  require.cache[SNAPSHOT_PATH] = savedSnapshot;
  require.cache[supportPath] = savedSupport;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
