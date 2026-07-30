'use strict';

/**
 * 通知メッセージ組み立て（netlify/functions/lib/notify/message.js）のテスト。
 *   node scripts/lib/__tests__/test-notify-message.js
 *
 * 主眼: 差し戻し再生成の通知が「対応版ができました（regenerated）」と
 *   「自動反映できませんでした（regenerate_not_applied）」で明確に区別されること。
 *   本文が変わっていないのに完了通知が出る誤通知（2026-07-30）の再発防止。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { buildMessage } = require(path.join(ROOT, 'netlify/functions/lib/notify/message.js'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== Test: regenerated（成功）===');
{
  const m = buildMessage('regenerated', { title: 'T', reviewUrl: 'https://x/review?file=a&ref=b', comment: 'c' });
  assert(/差し戻し対応版ができました/.test(m.subject), 'subject が「対応版ができました」');
  assert(/再生成しました/.test(m.body), 'body が完了を示す');
}

console.log('\n=== Test: regenerate_not_applied（自動反映失敗）===');
{
  const m = buildMessage('regenerate_not_applied', { title: 'T', reviewUrl: 'https://x/review?file=a&ref=b', comment: 'c' });
  assert(/自動反映できませんでした/.test(m.subject), 'subject が「自動反映できませんでした」');
  assert(/要手動対応/.test(m.subject), 'subject に「要手動対応」');
  assert(/変更されていない|一部/.test(m.body), 'body が未反映/一部反映を明示');
  assert(/手動で修正/.test(m.body), 'body が手動対応を促す');
  assert(!/対応版ができました/.test(m.subject), '誤って「対応版ができました」と言わない');
  assert(m.body.includes('https://x/review?file=a&ref=b'), 'レビューURL（ref付き）を含む');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
