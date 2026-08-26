'use strict';

/**
 * シミュレーター別マスター依存表と公開ゲートのテスト。
 *   node scripts/lib/__tests__/test-simulator-dependencies.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  SIMULATOR_TYPES,
  loadSimulatorDependencies,
  inspectSimulatorDependencies,
  evaluateSimulatorGates,
} = require(path.join(__dirname, '..', 'simulator-dependencies.js'));

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const MASTERS_DIR = path.join(REPO_ROOT, 'data', 'tax-simulator', 'masters');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

function collectRecords(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) collectRecords(item, acc);
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.record_id === 'string') {
    acc.push(node);
    return acc;
  }
  for (const value of Object.values(node)) collectRecords(value, acc);
  return acc;
}

function listJsonFiles(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    if (fs.statSync(filePath).isDirectory()) files.push(...listJsonFiles(filePath));
    else if (name.endsWith('.json')) files.push(filePath);
  }
  return files;
}

function emptySimulator() {
  return { required: [], optional: [] };
}

function group(valueKeys) {
  return [{ _basis: 'テスト用の根拠', value_keys: valueKeys }];
}

function minimalTable() {
  return {
    simulators: {
      hojinnari: emptySimulator(),
      shohizei: emptySimulator(),
      sozoku: emptySimulator(),
      yakuin_hoshu: emptySimulator(),
    },
  };
}

const realTable = loadSimulatorDependencies(MASTERS_DIR);
const realRecords = [];
for (const filePath of listJsonFiles(path.join(MASTERS_DIR, 'data'))) {
  collectRecords(JSON.parse(fs.readFileSync(filePath, 'utf8')), realRecords);
}

console.log('\n=== 検証1: 4シミュレーターの値集合 ===');
{
  const actual = Object.keys(realTable.simulators).sort();
  assert(actual.length === 4, `依存表に4シミュレーターがある（実: ${actual.length}）`);
  assert(
    SIMULATOR_TYPES.every(simulatorType => actual.includes(simulatorType)),
    '仕様書 §7 のシミュレーター識別子がすべてそろっている'
  );
}

console.log('\n=== 検証2: 対応年の宣言は全シミュレーターで必須 ===');
{
  const taxYearKeys = ['supported_tax_year', 'tax_period_basis', 'era_definition'];
  for (const simulatorType of SIMULATOR_TYPES) {
    const required = new Set(
      realTable.simulators[simulatorType].required.flatMap(dependency => dependency.value_keys)
    );
    assert(
      taxYearKeys.every(valueKey => required.has(valueKey)),
      `${simulatorType} は対応年・期間・元号の3キーを必須とする`
    );
  }
}

console.log('\n=== 検証3: 未分類 value_key の検出 ===');
{
  const table = minimalTable();
  table.simulators.hojinnari.required = group(['classified_key']);
  const inspection = inspectSimulatorDependencies([
    { record_id: 'A', value_key: 'classified_key', data_review_status: 'approved' },
    { record_id: 'B', value_key: 'unclassified_key', data_review_status: 'approved' },
  ], table);
  assert(
    inspection.unclassifiedValueKeys.length === 1 &&
      inspection.unclassifiedValueKeys[0] === 'unclassified_key',
    'どの依存表にも無い value_key を未分類として検出する'
  );
  assert(inspection.warnings.length === 1, '未分類を警告として返す');
}

console.log('\n=== 検証4: マスターに無い value_key の検出 ===');
{
  const table = JSON.parse(JSON.stringify(realTable));
  table.simulators.sozoku.required[0].value_keys.push('not_existing_value_key');
  const inspection = inspectSimulatorDependencies(realRecords, table);
  assert(
    inspection.missingValueKeys.includes('not_existing_value_key'),
    '依存表にだけある value_key を検出する'
  );
  assert(
    inspection.errors.some(error => error.includes('not_existing_value_key')),
    '依存表にだけある value_key を形式エラーとして返す'
  );
}

console.log('\n=== 検証5: シミュレーター別ゲートの独立判定 ===');
{
  const table = minimalTable();
  table.simulators.shohizei.required = group(['consumption_required']);
  table.simulators.sozoku.required = group(['inheritance_required']);
  table.simulators.sozoku.optional = group(['inheritance_optional']);
  const records = [
    { record_id: 'CT-1', value_key: 'consumption_required', data_review_status: 'unverified' },
    { record_id: 'IHT-1', value_key: 'inheritance_required', data_review_status: 'approved' },
    { record_id: 'IHT-2', value_key: 'inheritance_optional', data_review_status: 'unverified' },
  ];
  const inspection = inspectSimulatorDependencies(records, table);
  const gates = evaluateSimulatorGates(records, inspection);
  assert(gates.shohizei.publishable === false, '消費税の必須未承認で消費税だけ公開不可になる');
  assert(gates.sozoku.publishable === true, '無関係な相続税のゲートは公開可能のままになる');
  assert(
    gates.sozoku.optional.notApproved.length === 1,
    '相続税の任意依存にある未承認は警告対象に留まり、公開を止めない'
  );
  assert(
    records.some(record => record.data_review_status !== 'approved'),
    '同じデータに対する従来の全体ゲートは未承認を検出する'
  );
}

console.log('\n=== 検証6: コマンドのゲート指定 ===');
{
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-gate-'));
  try {
    fs.mkdirSync(path.join(fixtureDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(fixtureDir, 'sources'), { recursive: true });

    const table = minimalTable();
    table.simulators.shohizei.required = group(['consumption_required']);
    table.simulators.sozoku.required = group(['inheritance_required']);
    fs.writeFileSync(
      path.join(fixtureDir, 'simulator-dependencies.json'),
      JSON.stringify(table),
      'utf8'
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'data', 'records.json'),
      JSON.stringify({ records: [
        { record_id: 'CT-1', value_key: 'consumption_required', data_review_status: 'unverified' },
        { record_id: 'IHT-1', value_key: 'inheritance_required', data_review_status: 'approved' },
      ] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'sources', 'source-registry.json'),
      JSON.stringify({ sources: {} }),
      'utf8'
    );

    const script = path.join(REPO_ROOT, 'scripts', 'check-master-freshness.js');
    const run = (gate) => spawnSync(process.execPath, [script, gate], {
      env: { ...process.env, MASTERS_DIR: fixtureDir },
      encoding: 'utf8',
    });
    assert(run('--gate=sozoku').status === 0, '相続税指定の公開ゲートは通過する');
    assert(run('--gate=shohizei').status === 1, '消費税指定の公開ゲートだけ停止する');
    assert(run('--gate').status === 1, '指定なしの全体ゲートは従来どおり停止する');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
