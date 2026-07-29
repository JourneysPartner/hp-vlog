'use strict';

/**
 * 未マージ下書きを重複検知に含める恒久対策のテスト。
 *   node scripts/lib/__tests__/test-pending-drafts-dedup.js
 *
 * 背景: 2026-07-28 と 07-29 で同一トピック（準確定申告ペア）が完全重複した。
 *   原因は (1) 重複検知が main の content/posts しか見ず、未マージ下書きが対象外
 *   だったこと、(2) 相続系は pain_point が空で意味的ゲートが不発だったこと。
 *   本テストは両方の恒久対策を検証する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { selectDailyTopics } = require(path.join(ROOT, 'scripts/lib/topic-selector'));
const { checkTopicIdentity } = require(path.join(ROOT, 'scripts/lib/cooldown'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); passed++; }
  else      { console.error(`  FAIL ${label}`); failed++; }
}

// ── 1. extraCorpus（未マージ下書き）で同一slugが除外される ──
console.log('\n=== Test: extraCorpus の未マージ下書き slug を除外 ===');
const SLUG = 'zzz-pending-dedup-fixture-guide';
const topic = {
  slug: SLUG, title: 'テスト固定', category: '所得税',
  primary_persona: 'inheritance_client', customer_segment: 'inheritance_gift',
  cluster: 'inheritance', subcluster: 'zzz-pending-dedup-fixture',
  tax_domain: 'inheritance_tax', pain_point: '',
};
const pendingPost = {
  slug: SLUG, title: 'テスト固定', customer_segment: 'inheritance_gift',
  cluster: 'inheritance', subcluster: 'zzz-pending-dedup-fixture',
  pain_point: '', file: '2026-07-28-zzz-pending-dedup-fixture-guide.md',
  created_at: '2026-07-28T00:00:00.000Z', review_status: 'draft',
};
const now = new Date('2026-07-29T00:00:00+09:00');

// extraCorpus 無し: 候補として残る（＝重複検知の網に掛からない旧挙動）
const withoutPending = selectDailyTopics([topic], { now });
const corpusStep0 = withoutPending.explanation.steps.find(s => s.step === 'corpus');
assert((corpusStep0.pending || 0) === 0, 'extraCorpus 無しでは pending=0');

// extraCorpus 有り: 既存slug除外で候補から消える
const withPending = selectDailyTopics([topic], { now, extraCorpus: [pendingPost] });
const corpusStep1 = withPending.explanation.steps.find(s => s.step === 'corpus');
const slugStep = withPending.explanation.steps.find(s => s.step === 'filter-existing-slugs');
assert(corpusStep1.pending === 1, 'extraCorpus 有りで pending=1 がコーパスに加算される');
assert(slugStep.excluded >= 1, '未マージ下書きと同一slugが既存slug除外で弾かれる');
assert(!withPending.picks.some(p => p.slug === SLUG), 'picks に重複トピックが含まれない');

// ── 2. 意味的ゲート: pain_point 空でも subcluster×segment で既出検知 ──
console.log('\n=== Test: pain_point 空の論点は subcluster で意味的重複を検知 ===');
const inhCand = {
  customer_segment: 'inheritance_gift', pain_point: '',
  subcluster: 'within-4months-quasi-final-return', cluster: 'inheritance', slug: 'new-guide',
};
const inhCorpus = [{
  slug: '2026-07-28-quasi-guide', customer_segment: 'inheritance_gift', pain_point: '',
  subcluster: 'within-4months-quasi-final-return',
  file: '2026-07-28-quasi-guide.md', created_at: '2026-07-28T00:00:00.000Z',
}];
const hit = checkTopicIdentity(inhCand, inhCorpus, now);
assert(hit && hit.level === 'identity', 'pain空でも subcluster×segment 一致で既出扱い');
assert(hit && /subcluster/.test(hit.reason), '理由に subcluster が示される');

// 別 subcluster なら検知しない
const inhOther = { ...inhCand, subcluster: 'estate-tax-basic' };
assert(checkTopicIdentity(inhOther, inhCorpus, now) === null, '別 subcluster は既出扱いにしない');

// ── 3. 従来の pain_point ベース判定は不変（回帰） ──
console.log('\n=== Test: pain_point ありは従来どおり pain_point で判定 ===');
const painCand = { customer_segment: 'beauty_salon', pain_point: 'family-employment', subcluster: 'growth-family-employment', slug: 'a' };
const painCorpus = [{ slug: '2026-07-20-b', customer_segment: 'beauty_salon', pain_point: 'family-employment', subcluster: 'growth-family-employment', file: '2026-07-20-b.md', created_at: '2026-07-20T00:00:00.000Z' }];
const painHit = checkTopicIdentity(painCand, painCorpus, now);
assert(painHit && /pain_point/.test(painHit.reason), 'pain_point ありは pain_point キーで判定');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
