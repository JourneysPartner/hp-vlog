'use strict';

/**
 * 相続の格子（life_stage × procedure_stage）の同一視と、生成後の重複判定の部品のテスト。
 *   node scripts/lib/__tests__/test-scenario-identity-and-postgen-dedup.js
 *
 * 背景（2026-09-08）: 「身内が亡くなったら最初に何をする？」が 4/18・8/13・8/22 の記事と
 *   重複したまま生成された。pain_point が空の格子論点は subcluster の文字列で照合していたため
 *   隣のセルを別論点と見なし、選定時の AI 判定は企画（狭い）しか見ていなかった。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { checkTopicIdentity, lifeStagePhase } = require(path.join(ROOT, 'scripts/lib/cooldown'));
const dedup = require(path.join(ROOT, 'scripts/lib/ai-dedup'));
const { buildMessage } = require(path.join(ROOT, 'netlify/functions/lib/notify/message'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  OK ${label}`); passed++; }
  else      { console.error(`  NG ${label}`); failed++; }
}
const NOW = new Date('2026-09-08T00:06:00+09:00');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();

console.log('=== 格子の同一視: 逝去後の段階が違っても同じ手続きなら同一論点 ===');

assert(lifeStagePhase('critical-immediate') === 'after-death' && lifeStagePhase('within-4months') === 'after-death',
  '逝去後の 4 段階は同じ大区分');
assert(lifeStagePhase('pre-planning') === 'before-death' && lifeStagePhase('after-filing') === 'after-filing',
  '生前と申告後は別の大区分');
assert(lifeStagePhase('unknown-stage') === null, '未知の段階は大区分なし');

const post = {
  slug: 'inheritance-critical-immediate-initial-immediate-guide', file: '2026-09-06-x.md',
  primary_persona: 'inheritance_client', category: '相続', customer_segment: 'inheritance_gift',
  life_stage: 'critical-immediate', procedure_stage: 'initial-immediate', pain_point: '',
  subcluster: 'critical-immediate-initial-immediate', published_at: daysAgo(2),
};
const neighbour = {
  slug: 'inheritance-within-7days-initial-immediate-guide', persona: 'inheritance_client', category: '相続',
  customer_segment: 'inheritance_gift', life_stage: 'within-7days', procedure_stage: 'initial-immediate',
  pain_point: '', subcluster: 'within-7days-initial-immediate',
};
const hit = checkTopicIdentity(neighbour, [post], NOW);
assert(hit && hit.level === 'identity', '7日以内 × 初動 は 逝去直後 × 初動 と同一論点として止まる');

const prePlanning = { ...neighbour, slug: 'x', life_stage: 'pre-planning', procedure_stage: 'document-collection', subcluster: 'a' };
const afterDeathDocs = { ...post, slug: 'y', life_stage: 'within-4months', procedure_stage: 'document-collection', subcluster: 'b' };
assert(checkTopicIdentity(prePlanning, [afterDeathDocs], NOW) === null,
  '生前の書類収集は逝去後の書類収集とは別論点（大区分が違う）');

const otherProc = { ...neighbour, slug: 'z', procedure_stage: 'bank-procedure', subcluster: 'c' };
assert(checkTopicIdentity(otherProc, [post], NOW) === null,
  '同じ時期でも手続きが違えば別論点（初動 vs 銀行手続き）');

const withPain = { ...neighbour, slug: 'p', pain_point: 'consumption-tax-judgement' };
assert((checkTopicIdentity(withPain, [{ ...post, pain_point: 'consumption-tax-judgement' }], NOW) || {}).level === 'identity',
  'pain_point がある候補は従来どおり pain_point で照合');

const noStage = { ...neighbour, slug: 'q', life_stage: '', procedure_stage: '', subcluster: 'critical-immediate-initial-immediate' };
assert((checkTopicIdentity(noStage, [post], NOW) || {}).level === 'identity',
  '段階を持たない候補は従来どおり subcluster で照合');

console.log('');
console.log('=== 生成後の重複判定の部品 ===');

const block = dedup.buildGeneratedArticleBlock({
  slug: 's', title: '身内が亡くなったら最初に何をする？', summary: '逝去直後は死亡届から。相続税は10か月以内。',
  headings: ['逝去直後7日以内にやること', '相続手続きの全体像と期限', '準確定申告'], persona: 'inheritance_client', category: '相続',
});
assert(block.includes('title: 身内が亡くなったら') && block.includes('summary:') && block.includes('  - 相続手続きの全体像と期限'),
  'タイトル・要約・見出しをまとめて LLM に渡す');

const parsed = [{ slug: 's', duplicate: true, similar_to: 'e', reason: 'r' }];
dedup.applyDeterministicGuard(parsed, [{ slug: 's', persona: 'inheritance_client', article_type: 'comparison_decision' }],
  [{ slug: 'e', primary_persona: 'inheritance_client', article_type: 'comparison_decision' }]);
assert(parsed[0].duplicate === true, '同 persona・同 type の重複判定は維持される');

const parsed2 = [{ slug: 's', duplicate: true, similar_to: 'e', reason: 'r' }];
dedup.applyDeterministicGuard(parsed2, [{ slug: 's', persona: 'a', pain_point: 'x' }], [{ slug: 'e', primary_persona: 'b', pain_point: 'x' }]);
assert(parsed2[0].duplicate === true, 'pain_point が同じなら persona 違いでも重複のまま（既存の決め事）');

console.log('');
console.log('=== 0 本の日の通知 ===');
const m = buildMessage('daily_draft_none', { title: '2026-09-08 の記事生成', comment: '生成後の重複判定で取り下げ', prUrl: 'https://x/1' });
assert(/作られませんでした/.test(m.subject) && /0 本/.test(m.body) && /取り下げ/.test(m.body), '0 本の理由付きで知らせる');
assert(!/失敗しました/.test(m.subject), '失敗通知とは区別される');

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
