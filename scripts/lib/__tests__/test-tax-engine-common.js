'use strict';

/**
 * 計算エンジン共通基盤（金額・端数・マスタースナップショット）の単体テスト。
 *   node scripts/lib/__tests__/test-tax-engine-common.js
 */

const fs = require('fs');
const path = require('path');

const {
  money,
  exact,
  rate,
  area,
  moneyToExact,
  multiplyRateByMoney,
  multiplyRateByExact,
  multiplyAreaByMoney,
  addExact,
  subtractExact,
  addMoney,
  subtractMoney,
  compareExact,
  compareExactToMoney,
} = require('../../../src/tax-engine/common/money.js');
const { applyRounding } = require('../../../src/tax-engine/common/rounding.js');
const masters = require('../../../src/tax-engine/masters/snapshot.js');

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function throws(action, messagePart) {
  try {
    action();
    return false;
  } catch (error) {
    return messagePart === undefined || String(error.message).includes(messagePart);
  }
}

function isMoney(value, expected) {
  return value && value.unit === 'JPY' && value.value === expected;
}

function loadSnapshotWithOneUnapprovedRecord() {
  const snapshotPath = require.resolve('../../../src/tax-engine/masters/snapshot.js');
  const targetFile = path.normalize(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data',
    'income-tax', 'brackets-h27.json'
  ));
  const originalReadFileSync = fs.readFileSync;
  delete require.cache[snapshotPath];
  try {
    fs.readFileSync = function readWithUnapprovedRecord(file, encoding) {
      const source = originalReadFileSync.call(fs, file, encoding);
      if (path.normalize(String(file)) !== targetFile) return source;
      const document = JSON.parse(source);
      document.records[0].data_review_status = 'unverified';
      return JSON.stringify(document);
    };
    return require(snapshotPath);
  } finally {
    fs.readFileSync = originalReadFileSync;
    delete require.cache[snapshotPath];
  }
}

console.log('\n=== 検証1: 金額・率・面積の型代数 ===');
{
  const normalized = rate({ num: -20n, den: -100n });
  assert(normalized.num === 1n && normalized.den === 5n, 'Rateの分母を正にして既約化する');
  assert(throws(() => rate({ num: 1n, den: 0n }), '0'), 'Rateの分母0を拒否する');
  assert(throws(() => money({ unit: 'JPY', value: 1 }), 'bigint'), 'Moneyにnumberが紛れたら拒否する');
  assert(throws(() => exact({ unit: 'USD', num: 1n, den: 1n }), 'JPY'), 'Exactの不正な単位を拒否する');
  assert(throws(() => area({ unit: 'JPY', num: 1n, den: 1n }), 'SQM'), 'Areaの不正な単位を拒否する');

  const left = exact({ unit: 'JPY', num: 1n, den: 3n });
  const decimalApproximation = exact({ unit: 'JPY', num: 333333n, den: 1000000n });
  assert(compareExact(left, decimalApproximation) === 1, '1/3を0.333333より大きいと分数のまま比較する');
  assert(compareExactToMoney(exact({ unit: 'JPY', num: 6n, den: 3n }),
    money({ unit: 'JPY', value: 2n })) === 0, 'ExactとMoneyを通分して比較する');

  const exactSum = addExact(
    exact({ unit: 'JPY', num: 1n, den: 3n }),
    exact({ unit: 'JPY', num: 1n, den: 6n })
  );
  const exactDifference = subtractExact(exactSum, exact({ unit: 'JPY', num: 1n, den: 2n }));
  assert(compareExact(exactDifference, exact({ unit: 'JPY', num: 0n, den: 1n })) === 0,
    'Exactの加減算で途中の除算を行わない');
  assert(isMoney(addMoney(money({ unit: 'JPY', value: 10n }), money({ unit: 'JPY', value: 5n })), 15n) &&
    isMoney(subtractMoney(money({ unit: 'JPY', value: 10n }), money({ unit: 'JPY', value: 5n })), 5n),
  'Money同士だけで加減算する');
  const landValue = multiplyAreaByMoney(
    area({ unit: 'SQM', num: 3n, den: 2n }),
    money({ unit: 'JPY', value: 1000n })
  );
  assert(landValue.num === 3000n && landValue.den === 2n,
    'Area×Money（単価）はExactを返す');
}

console.log('\n=== 検証2: truncateの10規則と境界 ===');
const truncateRules = [
  ['R-TRUNC-1000-BASE', 1000n],
  ['R-TRUNC-100-TAX', 100n],
  ['R-TRUNC-1000-LOCAL-BASE', 1000n],
  ['R-TRUNC-100-LOCAL-TAX', 100n],
  ['R-TRUNC-1-YEN', 1n],
  ['R-TRUNC-1000-BONUS', 1000n],
  ['R-TRUNC-1000-IHT-BASE', 1000n],
  ['R-TRUNC-1000-IHT-LEGAL-SHARE', 1000n],
  ['R-TRUNC-100-IHT-FINAL', 100n],
  ['R-TRUNC-1-CT-STAGE', 1n],
];
for (const [ruleId, unit] of truncateRules) {
  const atBoundary = applyRounding(exact({ unit: 'JPY', num: unit, den: 1n }), ruleId);
  const aboveBoundary = applyRounding(exact({ unit: 'JPY', num: unit + 1n, den: 1n }), ruleId);
  const belowBoundary = applyRounding(exact({ unit: 'JPY', num: unit - 1n, den: 1n }), ruleId);
  const zero = applyRounding(exact({ unit: 'JPY', num: 0n, den: 1n }), ruleId);
  const negative = applyRounding(exact({ unit: 'JPY', num: -(unit + 1n), den: 1n }), ruleId);
  assert(
    atBoundary.value === unit && aboveBoundary.value === (unit === 1n ? 2n : unit) &&
      belowBoundary.value === 0n && zero.value === 0n &&
      negative.value === (unit === 1n ? -2n : -unit),
    `${ruleId}: 単位の倍数・±1円・0・負数を0方向へ切り捨てる`
  );
}
assert(applyRounding(exact({ unit: 'JPY', num: -1n, den: 2n }), 'R-TRUNC-1-YEN').value === 0n,
  'truncateは負の小数円も負の無限大方向ではなく0方向へ切り捨てる');

console.log('\n=== 検証3: 残る3規則と異常系 ===');
assert(
  applyRounding(exact({ unit: 'JPY', num: 1000n, den: 1n }), 'R-NONE').value === 1000n &&
    applyRounding(exact({ unit: 'JPY', num: 1001n, den: 1n }), 'R-NONE').value === 1001n &&
    applyRounding(exact({ unit: 'JPY', num: 999n, den: 1n }), 'R-NONE').value === 999n &&
    applyRounding(exact({ unit: 'JPY', num: 0n, den: 1n }), 'R-NONE').value === 0n &&
    applyRounding(exact({ unit: 'JPY', num: -1001n, den: 1n }), 'R-NONE').value === -1001n,
  'R-NONEは単位の倍数・±1円・0・負数を変更しない'
);
assert(throws(() => applyRounding(
  exact({ unit: 'JPY', num: 1n, den: 2n }), 'R-NONE'), '整数でないExact'),
'R-NONEは端数付きExactを拒否する');
assert(
  applyRounding(exact({ unit: 'JPY', num: 1n, den: 1n }), 'R-ROUND-HALF-UP-1').value === 1n &&
    applyRounding(exact({ unit: 'JPY', num: 2n, den: 1n }), 'R-ROUND-HALF-UP-1').value === 2n &&
    applyRounding(exact({ unit: 'JPY', num: 0n, den: 1n }), 'R-ROUND-HALF-UP-1').value === 0n &&
    applyRounding(exact({ unit: 'JPY', num: -2n, den: 1n }), 'R-ROUND-HALF-UP-1').value === -2n &&
    applyRounding(exact({ unit: 'JPY', num: 1n, den: 2n }), 'R-ROUND-HALF-UP-1').value === 1n &&
    applyRounding(exact({ unit: 'JPY', num: -1n, den: 2n }), 'R-ROUND-HALF-UP-1').value === -1n &&
    applyRounding(exact({ unit: 'JPY', num: 49n, den: 100n }), 'R-ROUND-HALF-UP-1').value === 0n,
  'R-ROUND-HALF-UP-1は整数境界・0・負数と正負の0.5ちょうどを正しく丸める'
);
assert(throws(() => applyRounding(
  exact({ unit: 'JPY', num: 1n, den: 2n }), 'R-SHARE-REMAINDER'), '保険者別の規則'),
'R-SHARE-REMAINDERは保険者別規則なしで適用しない');
assert(throws(() => applyRounding(
  exact({ unit: 'JPY', num: 1n, den: 1n }), 'R-UNKNOWN'), '未知'),
'未知のrounding_rule_idを拒否する');
assert(throws(() => applyRounding(
  exact({ unit: 'JPY', num: 1n, den: 1n }), null), '未決定'),
'nullのrounding_rule_idを拒否する');
assert(throws(() => applyRounding(
  exact({ unit: 'JPY', num: 1n, den: 1n }), undefined), '未決定'),
'undefinedのrounding_rule_idを拒否する');
assert(throws(() => applyRounding(money({ unit: 'JPY', value: 1n }), 'R-NONE'), 'Exact.num'),
'Moneyを丸め関数へ再投入できない');

console.log('\n=== 検証4: 除算は最後に1回 ===');
{
  const intermediate = multiplyRateByMoney(
    rate({ num: 23n, den: 100n }),
    money({ unit: 'JPY', value: 7000000n })
  );
  assert(intermediate.unit === 'JPY' && intermediate.num === 161000000n && intermediate.den === 100n &&
    !Object.hasOwn(intermediate, 'value'), '700万円×23%はMoneyへ戻さずExactの分数で保持する');
  assert(isMoney(applyRounding(intermediate, 'R-TRUNC-1-YEN'), 1610000n),
    '端数規則を適用した時点で初めてExactをMoneyへ確定する');
}

console.log('\n=== 検証5: マスタースナップショット ===');
{
  const incomeTaxRows = masters.find('income_tax_brackets', { taxYear: 2025 });
  assert(incomeTaxRows.length === 7 && incomeTaxRows.every(row =>
    row.data_review_status === 'approved' && typeof row.legal_status === 'string'),
  'findは承認済みレコードだけを返し、legal_statusを残す');
  const snapshotWithUnapproved = loadSnapshotWithOneUnapprovedRecord();
  const filteredRows = snapshotWithUnapproved.find('income_tax_brackets', { taxYear: 2025 });
  assert(filteredRows.length === 6 &&
    !filteredRows.some(row => row.record_id === 'IT-H27-BRACKET-01'),
  '未承認レコードを要求しても返さず、承認済みだけを返す');
  assert(Object.isFrozen(incomeTaxRows) && incomeTaxRows.every(Object.isFrozen),
    '検索結果の配列とロード済みJSONレコードを凍結している');
  assert(masters.find('存在しないvalue_key', { onDate: '2025-01-01' }).length === 0,
    '該当レコードが無いときは空配列を返す');

  const fiscalPeriod = masters.find('small_business_special_deduction', {
    periodIntersects: { from: '2023-04-01', to: '2024-03-31' },
  });
  assert(fiscalPeriod.length === 1 && fiscalPeriod[0].record_id === 'CT-SPECIAL-2WARI',
    '2割特例は2023-04-01〜2024-03-31との期間交差で見つかる');
  const calendarPeriod = masters.find('small_business_special_deduction', {
    periodIntersects: { from: '2026-01-01', to: '2026-12-31' },
  });
  assert(calendarPeriod.length === 1 && calendarPeriod[0].record_id === 'CT-SPECIAL-2WARI',
    '2割特例は終期後に終了する2026年課税期間も期間交差で見つかる');

  const topBracket = masters.findBracket(
    'income_tax_brackets',
    money({ unit: 'JPY', value: 50000000n }),
    { taxYear: 2025 }
  );
  assert(topBracket && topBracket.record_id === 'IT-H27-BRACKET-07' &&
    topBracket.bracket_upper_inclusive === null, 'findBracketは上限nullを「以上」の帯として扱う');
  assert(masters.findBracket(
    'income_tax_brackets',
    money({ unit: 'JPY', value: 999n }),
    { taxYear: 2025 }
  ) === null, '該当帯が無いときはnullを返す');
  assert(throws(() => masters.find('income_tax_brackets', {
    onDate: '2025-01-01', taxYear: 2025,
  }), 'いずれか1つ'), '検索基準を複数指定したら拒否する');
}

console.log('\n=== Rate × Exact（消費税エンジンで必要になり追加された演算） ===');
{
  // 税込11,000,000×100/110（Exact）に 7.8% を掛ける。分数のまま閉じること。
  // 率は既約化されるため表現は検査せず、交差乗算の同値性で「途中で丸めていない」ことを固定する。
  const base = multiplyRateByMoney(rate({ num: 100n, den: 110n }),
    money({ unit: 'JPY', value: 11000000n }));
  const tax = multiplyRateByExact(rate({ num: 78n, den: 1000n }), base);
  assert(compareExact(tax, { unit: 'JPY', num: 780000n, den: 1n }) === 0,
    '11,000,000×100/110×78/1000 ＝ 780,000円（通分比較）');
  // 中間値が割り切れない入力でも厳密に等しいこと（丸めていれば必ずずれる）
  const base2 = multiplyRateByMoney(rate({ num: 100n, den: 110n }),
    money({ unit: 'JPY', value: 11000001n }));
  const tax2 = multiplyRateByExact(rate({ num: 78n, den: 1000n }), base2);
  assert(compareExact(tax2,
    { unit: 'JPY', num: 11000001n * 100n * 78n, den: 110n * 1000n }) === 0,
    '割り切れない中間値でも分数のまま厳密に等しい（途中で丸めていない）');
  let threw = false;
  try { multiplyRateByExact(rate({ num: 1n, den: 0n }), base); } catch (e) { threw = true; }
  assert(threw, '分母0の率は構築時に拒否される');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
