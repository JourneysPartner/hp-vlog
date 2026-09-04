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

// ── 日次生成の失敗を必ず知らせる（2026-08-28/29）──────────────
// 記事の生成自体は成功していたのにバリデーションでジョブが落ち、下書きが
// 作られないまま2日間気づかれなかった。失敗も未実行も通知で拾えるようにした。
console.log('');
console.log('=== 日次生成の失敗通知 ===');
{
  const m = buildMessage('daily_draft_failed', {
    title: '2026-08-29 の記事生成',
    comment: 'GitHub Actions のジョブが失敗しました。下書きは作られていません。',
    prUrl: 'https://github.com/owner/repo/actions/runs/123',
  });
  assert(/失敗/.test(m.subject), '件名で失敗と分かる');
  assert(/下書きが作られていません/.test(m.body), '下書きが無いことが本文で分かる');
  assert(m.body.includes('actions/runs/123'), '実行ログへの導線がある');
  assert(/確認してください/.test(m.body), '次に何をすべきかが書かれている');

  // 実行されなかった場合（朝の点検から）も同じ形式で送れる
  const notRun = buildMessage('daily_draft_failed', {
    title: '2026-08-30 の記事生成',
    comment: '直近24時間に成功した記事生成がありません（実行されていない可能性があります）。',
    prUrl: 'https://github.com/owner/repo/actions/workflows/daily-draft.yml',
  });
  assert(/実行されていない可能性/.test(notRun.body), '未実行のケースも同じ形式で通知できる');

  // 任意項目が無くても壊れない
  const bare = buildMessage('daily_draft_failed', { title: 'x' });
  assert(bare.subject && bare.body && !/undefined/.test(bare.body),
    '状況やログURLが無くても本文が壊れない');
}
// ── 2本揃わなかった日を知らせる（2026-09-04）──────────────────
// cooldown が候補を削りすぎて本命記事1本しか作れなかったが、ジョブは成功で
// 終わるため「補強記事が無い」ことに誰も気づけなかった。
console.log('');
console.log('=== 下書きが1本だけの日の通知 ===');
{
  const m = buildMessage('daily_draft_partial', {
    title: '2026-09-04 の記事生成',
    comment: '同じ需要の証拠が2件になり代替候補がないため、低優先度側を取り下げ',
    prUrl: 'https://github.com/owner/repo/actions/runs/456',
  });
  assert(/1本だけ|補強記事なし/.test(m.subject), '件名で2本揃わなかったと分かる');
  assert(/2本揃いませんでした/.test(m.body), '本文で状況が分かる');
  assert(/低優先度側を取り下げ/.test(m.body), '選定側の理由がそのまま載る');
  assert(m.body.includes('actions/runs/456'), '実行ログへの導線がある');
  assert(/レビューは通常どおり/.test(m.body), '生成できた1本は普通に扱えると分かる');

  // 失敗通知とは別物であること（1本は作られている）
  assert(!/下書きが作られていません/.test(m.body), '失敗通知と混同されない');

  // 理由やログURLが取れなくても壊れない
  const bare = buildMessage('daily_draft_partial', {});
  assert(bare.subject && bare.body && !/undefined/.test(bare.body),
    '理由やログURLが無くても本文が壊れない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
