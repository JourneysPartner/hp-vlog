'use strict';

/**
 * 条文原文の添付を保ったまま、条番号の本文印字だけを抑える静的ルールを検証する。
 *   node scripts/lib/__tests__/test-law-citation-rule.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { STATIC_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));
const { buildLawProvisionBlock } = require(path.join(ROOT, 'scripts/lib/law-sources'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== Test 1: 条番号ルールが全記事共通の静的ルールに入る ===');
assert(STATIC_RULES.includes('【条番号は読者が使うときだけ書く】'),
  '新しい条番号ルールの見出しを含む');
assert(STATIC_RULES.includes('民法第915条'), '書いてよい例（民法第915条）を含む');
assert(STATIC_RULES.includes('戸籍法第86条'), '書かない例（戸籍法第86条）を含む');

console.log('\n=== Test 2: 既存の数字ルールを残す ===');
assert(STATIC_RULES.includes('【読者が使う数字だけを書く（制度の内訳を持ち込まない）】'),
  '既存の「読者が使う数字だけを書く」ブロックを含む');

console.log('\n=== Test 3: 条文原文側の捏造防止ガードを残す ===');
// 空配列ではブロック自体が生成されないため、最小の条文データで実際の戻り値を確認する。
const lawBlock = buildLawProvisionBlock([{
  law: '民法',
  num: '915',
  caption: '相続の承認又は放棄をすべき期間',
  law_num: '明治二十九年法律第八十九号',
  amended: '2026-04-01',
  text: '相続人は、自己のために相続の開始があったことを知った時から三箇月以内に判断する。',
}]);
assert(lawBlock.includes('ここに無い条番号を書かない'),
  'buildLawProvisionBlock の捏造防止文言を含む');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
