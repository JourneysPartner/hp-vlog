'use strict';

/**
 * 入力型の生成物と bigint 境界変換を検証する。
 *   node scripts/lib/__tests__/test-input-types.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { definitions, roots } = require('../input-types/definitions.js');
const {
  moneyToWire,
  moneyFromWire,
  exactToWire,
  exactFromWire,
  rateToWire,
  rateFromWire,
  areaToWire,
  areaFromWire,
} = require('../input-types/wire-converters.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SCHEMA_DIR = path.join(REPO_ROOT, 'data', 'tax-simulator', 'schemas', 'input');
const DECLARATION_FILE = path.join(
  REPO_ROOT,
  'scripts',
  'lib',
  'input-types',
  'generated',
  'input-types.d.ts'
);

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function sameValue(left, right) {
  if (typeof left === 'bigint' || typeof right === 'bigint') return left === right;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function throws(action) {
  try {
    action();
    return false;
  } catch (_error) {
    return true;
  }
}

function allPropertyObjectsAreClosed(node) {
  if (Array.isArray(node)) return node.every(allPropertyObjectsAreClosed);
  if (node === null || typeof node !== 'object') return true;
  if (node.type === 'object' && node.properties && node.additionalProperties !== false) return false;
  return Object.values(node).every(allPropertyObjectsAreClosed);
}

function localReferencesResolve(schema) {
  let resolved = true;
  function visit(node) {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) {
      const name = node.$ref.slice('#/$defs/'.length);
      if (!schema.$defs[name]) resolved = false;
    }
    Object.values(node).forEach(visit);
  }
  visit(schema);
  return resolved;
}

console.log('\n=== 検証1: Moneyの往復変換 ===');
for (const value of [0n, 1n, -1n, 9007199254740991n, 10n ** 100n]) {
  const memory = { unit: 'JPY', value };
  assert(sameValue(moneyFromWire(moneyToWire(memory)), memory), `${value}円が往復して一致する`);
}
assert(
  sameValue(moneyToWire(moneyFromWire({ unit: 'JPY', value: '-999999999999999999999' })),
    { unit: 'JPY', value: '-999999999999999999999' }),
  'MoneyWireも往復して一致する'
);

console.log('\n=== 検証2: Exactの往復変換 ===');
for (const memory of [
  { unit: 'JPY', num: 0n, den: 1n },
  { unit: 'JPY', num: -1n, den: 1n },
  { unit: 'JPY', num: 1n, den: 3n },
  { unit: 'JPY', num: 10n ** 100n, den: 10n ** 99n },
]) {
  assert(sameValue(exactFromWire(exactToWire(memory)), memory), `${memory.num}/${memory.den}円が往復して一致する`);
}
assert(
  sameValue(exactToWire(exactFromWire({ unit: 'JPY', num: '-7', den: '9' })),
    { unit: 'JPY', num: '-7', den: '9' }),
  'ExactWireも往復して一致する'
);

console.log('\n=== 検証3: Rateの往復変換 ===');
for (const memory of [
  { num: 0n, den: 1n },
  { num: -1n, den: 1n },
  { num: 1n, den: 10000n },
  { num: 10n ** 100n, den: 10n ** 99n },
]) {
  assert(sameValue(rateFromWire(rateToWire(memory)), memory), `${memory.num}/${memory.den}が往復して一致する`);
}
assert(
  sameValue(rateToWire(rateFromWire({ num: '-13', den: '17' })), { num: '-13', den: '17' }),
  'RateWireも往復して一致する'
);

console.log('\n=== 検証4: Areaの往復変換 ===');
for (const memory of [
  { unit: 'SQM', num: 0n, den: 1n },
  { unit: 'SQM', num: -1n, den: 1n },
  { unit: 'SQM', num: 33058n, den: 100n },
  { unit: 'SQM', num: 10n ** 100n, den: 10n ** 99n },
]) {
  assert(sameValue(areaFromWire(areaToWire(memory)), memory), `${memory.num}/${memory.den}平方メートルが往復して一致する`);
}
assert(
  sameValue(areaToWire(areaFromWire({ unit: 'SQM', num: '33058', den: '100' })),
    { unit: 'SQM', num: '33058', den: '100' }),
  'AreaWireも往復して一致する'
);

console.log('\n=== 検証5: Decimal境界の拒否 ===');
for (const invalid of ['1e3', '1E3', '1,000', '1.0', '', ' 1', '+1']) {
  assert(
    throws(() => moneyFromWire({ unit: 'JPY', value: invalid })),
    `MoneyWire.valueの不正表記「${invalid}」を拒否する`
  );
}
assert(throws(() => moneyFromWire({ unit: 'USD', value: '1' })), 'MoneyWireの不正な単位を拒否する');
assert(throws(() => areaFromWire({ unit: 'JPY', num: '1', den: '1' })), 'AreaWireの不正な単位を拒否する');
assert(throws(() => exactFromWire({ unit: 'JPY', num: '1', den: '0' })), 'ExactWireの分母0を拒否する');
assert(throws(() => rateFromWire({ num: '1', den: '-1' })), 'RateWireの負の分母を拒否する');
assert(throws(() => areaToWire({ unit: 'SQM', num: 1n, den: 0n })), 'Areaの分母0を拒否する');
assert(throws(() => moneyToWire({ unit: 'JPY', value: 1 })), 'numberをMoneyの値として拒否する');

console.log('\n=== 検証6: 設計書の型と単一定義 ===');
{
  const design = fs.readFileSync(
    path.join(REPO_ROOT, 'docs', 'tax-simulator', 'input-type-design.md'),
    'utf8'
  );
  const names = [...design.matchAll(/^(?:type|interface)\s+([A-Za-z][A-Za-z0-9]*)/gm)]
    .map(match => match[1]);
  const missing = [...new Set(names)].filter(name => name !== 'AreaWire' && !definitions[name]);
  assert(missing.length === 0, `設計書 §3〜§7 の名前付き型が定義元にそろう（不足: ${missing.join(', ') || 'なし'}）`);
  assert(definitions.Area && definitions.Exact && definitions.Rate, 'Area・Exact・Rateを分数型として定義している');
}

console.log('\n=== 検証7: JSON Schemaと型宣言 ===');
{
  let schemasValid = true;
  let schemasClosed = true;
  let referencesResolve = true;
  for (const root of roots) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, root.file), 'utf8'));
    schemasValid = schemasValid &&
      schema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      schema.$ref === `#/$defs/${root.name}Wire` &&
      Boolean(schema.$defs[`${root.name}Wire`]);
    schemasClosed = schemasClosed && allPropertyObjectsAreClosed(schema);
    referencesResolve = referencesResolve && localReferencesResolve(schema);
  }
  assert(schemasValid, '4シミュレーターの自己完結型Wireスキーマを読める');
  assert(referencesResolve, '4スキーマの内部参照がすべて同じファイル内で解決する');
  assert(schemasClosed, '固定プロパティを持つオブジェクトが未知のプロパティを許可しない');

  const declarations = fs.readFileSync(DECLARATION_FILE, 'utf8');
  assert(roots.every(root => declarations.includes(`export type ${root.name} =`)), '4入力型のメモリ内宣言がある');
  assert(roots.every(root => declarations.includes(`export type ${root.name}Wire =`)), '4入力型のWire宣言がある');
  assert(declarations.includes('value: bigint;'), 'メモリ内のMoneyがbigintを使う');
  assert(declarations.includes('value: Decimal;'), 'WireのMoneyがDecimalを使う');
}

console.log('\n=== 検証8: 生成物の一致 ===');
{
  const generated = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'generate-input-types.js'),
    '--check',
  ], { encoding: 'utf8' });
  assert(
    generated.status === 0,
    `生成し直して差分がない${generated.status === 0 ? '' : `（${generated.stderr.trim()}）`}`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
