'use strict';

const { lintTitle } = require('../title-lint');
const { detectBannedInTitle } = require('../banned-phrases');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const len46 = Array.from({ length: 46 }, (_, i) => String.fromCharCode(0x3041 + (i % 80))).join('');
const len61 = Array.from({ length: 61 }, (_, i) => String.fromCharCode(0x30a1 + (i % 80))).join('');
assert(lintTitle(len46).warns.some(v => /やや長い/.test(v)), '45文字超は warn');
assert(lintTitle(len61).fails.some(v => /長すぎ/.test(v)), '60文字超は fail');
for (const suffix of ['を解説', 'について', 'まとめ']) {
  assert(lintTitle(`インボイス登録後の実務${suffix}`).fails.length > 0, `末尾「${suffix}」は fail`);
}
assert(lintTitle('青色申告で確認したい手続きのポイント').warns.some(v => /不自然パターン/.test(v)),
  '末尾「のポイント」は warn');
assert(lintTitle('本則課税と簡易課税はどちらが有利？判断の手順').fails.length === 0,
  '既存の対比ペアは通る');
assert(detectBannedInTitle('インボイス登録後の注意点を解説').some(v => v.id === 'no-empty-title-suffix'),
  'banned-phrases の title 限定ルールでも検出');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
