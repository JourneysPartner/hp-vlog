'use strict';

/**
 * 消費税の割戻し計算を、読者の認識に合わせて国税・地方税の合算税率で書かせる静的ルールを検証する。
 *   node scripts/lib/__tests__/test-consumption-tax-rate-notation.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { STATIC_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== Test 1: 税率表記ルールが全記事共通の静的ルールに入る ===');
assert(STATIC_RULES.includes('【消費税の割戻し計算は国税・地方税を合算した税率で書く】'),
  '新しい税率表記ルールの見出しを含む');

console.log('\n=== Test 2: 書かせたい式（✓ の例）が残っている ===');
assert(STATIC_RULES.includes('10／110'), '標準税率の式（10／110）を含む');
assert(STATIC_RULES.includes('8／108'), '軽減税率の式（8／108）を含む');

console.log('\n=== Test 3: 書かせたくない式（❌ の例）が残っている ===');
assert(STATIC_RULES.includes('7.8／110'), '国税分のみの式（7.8／110）を ❌ 例として含む');
assert(STATIC_RULES.includes('6.24／108'), '国税分のみの式（6.24／108）を ❌ 例として含む');

console.log('\n=== Test 4: 積上げ計算の係数を本文に出さない指示が入る ===');
assert(STATIC_RULES.includes('100分の78'),
  '国税分を取り出す係数（100分の78）への言及を含む');
assert(STATIC_RULES.includes('積み上げた金額'),
  '係数の代わりに書かせる表現（積み上げた金額）を含む');

console.log('\n=== Test 5: 既存ルールを壊していない ===');
assert(STATIC_RULES.includes('【読者が使う数字だけを書く（制度の内訳を持ち込まない）】'),
  '既存の「読者が使う数字だけを書く」ブロックを含む');
assert(STATIC_RULES.includes('消費税率 10%（軽減 8%）'),
  'L1 の「消費税率 10%（軽減 8%）」を含む');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
