'use strict';

const {
  WORD_COUNT_RANGE,
  WORD_COUNT_RANGE_BY_INTENT,
  rangeFor,
  maxTokensFor,
  wordCountGuideFor,
} = require('../article-prompt-static');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== rangeFor ===');
assert(rangeFor({ articleType: 'basic_explainer', intentType: 'answer', articleRole: 'main' }) === WORD_COUNT_RANGE_BY_INTENT.answer,
  'main + intent は意図別レンジ');
assert(rangeFor({ articleType: 'basic_explainer' }) === WORD_COUNT_RANGE.basic_explainer,
  'intent 無しは記事タイプ別レンジ');
assert(rangeFor({ articleType: 'edge_case', intentType: 'guide', articleRole: 'support' }) === WORD_COUNT_RANGE.edge_case,
  'support は intent があっても従来レンジ');
assert(rangeFor({ articleType: 'unknown' }) === WORD_COUNT_RANGE.edge_case,
  '未知タイプは edge_case にフォールバック');

console.log('\n=== maxTokensFor ===');
assert(maxTokensFor('basic_explainer') === maxTokensFor({ articleType: 'basic_explainer' }),
  '文字列とオブジェクトの従来形が一致');
assert(maxTokensFor({ articleType: 'basic_explainer', intentType: 'answer', articleRole: 'main' })
  < maxTokensFor({ articleType: 'basic_explainer', intentType: 'guide', articleRole: 'main' }),
  'answer は guide より小さい出力枠');

console.log('\n=== wordCountGuideFor ===');
const guide = wordCountGuideFor({ articleType: 'basic_explainer', intentType: 'answer', articleRole: 'main' });
assert(/\d+〜\d+文字/.test(guide), '指示文に数値レンジが入る');
assert(wordCountGuideFor({ articleType: 'edge_case', intentType: 'guide', articleRole: 'support' })
  === wordCountGuideFor({ articleType: 'edge_case' }), 'support の指示文は従来値');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
