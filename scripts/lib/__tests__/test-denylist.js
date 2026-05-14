'use strict';

/**
 * denylist / time-limited / 禁止意図検出のユニットテスト。
 *   node scripts/lib/__tests__/test-denylist.js
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..', '..');

const {
  loadDenylist, isTopicDenied, findMatchingEntry, isEntryActive,
  entryMatchesTopic, isTimeLimitedExpired, detectDenyIntent,
  buildEntriesFromContext, mergeEntries,
} = require(path.join(ROOT, 'scripts/lib/denylist.js'));

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. loadDenylist が動く ──────────────────────────────────────
console.log('\n=== Test 1: loadDenylist ===');
{
  const list = loadDenylist();
  assert(list && Array.isArray(list.entries), 'entries 配列が返る');
  assert(list.entries.length >= 1, '初期データに少なくとも1件含まれる');
  const fixedAmount = list.entries.find(e => e.value === 'fixed-amount-tax-reduction');
  assert(fixedAmount && fixedAmount.active === true, '定額減税の subcluster が active で登録されている');
}

// ── 2. isTopicDenied / findMatchingEntry ────────────────────────
console.log('\n=== Test 2: 定額減税系トピックは isTopicDenied で true ===');
{
  const denied = {
    slug: 'fixed-amount-tax-reduction-monthly-procedure',
    subcluster: 'fixed-amount-tax-reduction',
    title: '定額減税の月次減税事務｜小規模事業者が押さえる手続きと従業員への対応',
    primary_question: '定額減税で事業者は何をどう処理すればよいか？',
  };
  assert(isTopicDenied(denied), '定額減税 topic は denylist にヒット');
  const hit = findMatchingEntry(denied);
  assert(hit && hit.type === 'subcluster', 'subcluster type でヒットする');
}

// ── 3. 関係ないトピックはヒットしない ───────────────────────────
console.log('\n=== Test 3: 関係ないトピックは denylist にヒットしない ===');
{
  const other = {
    slug: 'ebay-export-consumption-tax-refund-guide',
    subcluster: 'ebay-tax-refund',
    title: 'eBay輸出の消費税還付とは？',
    primary_question: 'eBay輸出で消費税還付を受けるための条件と手順は？',
  };
  assert(!isTopicDenied(other), 'eBay topic は denylist にヒットしない');
}

// ── 4. keyword 型もヒットする ────────────────────────────────────
console.log('\n=== Test 4: keyword 型ヒット ===');
{
  const t = {
    slug: 'some-other-slug',
    title: '定額減税を踏まえた年末調整のポイント',
    search_intent: '定額減税の年末調整での扱いを知りたい',
  };
  // keyword "定額減税" にヒットするはず
  assert(isTopicDenied(t), 'title に "定額減税" を含む topic は keyword で deny');
}

// ── 5. isEntryActive: 期限切れ + active=false ───────────────────
console.log('\n=== Test 5: isEntryActive ===');
{
  const expired = { active: true, expires_at: '2020-01-01T00:00:00Z' };
  assert(!isEntryActive(expired), '期限切れは false');
  const disabled = { active: false };
  assert(!isEntryActive(disabled), 'active=false は false');
  const ok = { active: true, expires_at: '' };
  assert(isEntryActive(ok), 'active=true & 期限なしは true');
  const future = { active: true, expires_at: '2099-01-01T00:00:00Z' };
  assert(isEntryActive(future), '未来期限は true');
}

// ── 6. isTimeLimitedExpired ─────────────────────────────────────
console.log('\n=== Test 6: isTimeLimitedExpired ===');
{
  const past = { valid_to: '2024-12-31', slug: 's' };
  const r1 = isTimeLimitedExpired(past, new Date('2026-01-01'));
  assert(r1.expired === true, 'valid_to=2024-12-31 を 2026-01-01 から見たら expired');

  const historical = { historical_only: true, slug: 's' };
  const r2 = isTimeLimitedExpired(historical);
  assert(r2.expired === true, 'historical_only=true は expired');

  const active = { slug: 's' };
  const r3 = isTimeLimitedExpired(active);
  assert(r3.expired === false, '無印は expired=false');

  const futureValid = { valid_to: '2099-12-31' };
  const r4 = isTimeLimitedExpired(futureValid, new Date('2026-01-01'));
  assert(r4.expired === false, '未来 valid_to は expired=false');
}

// ── 7. detectDenyIntent ─────────────────────────────────────────
console.log('\n=== Test 7: detectDenyIntent 明示パターン ===');
{
  const intents = [
    '今後、定額減税についての記事は書かないでください',
    'もう定額減税の記事は生成しないでください',
    'このテーマは今後出さないでください',
    'これからこの論点は生成しないでください',
    'このテーマを除外してください',
    '同じテーマは今後書かないでください',
  ];
  for (const c of intents) {
    assert(detectDenyIntent(c), `禁止意図検出: "${c.slice(0, 30)}..."`);
  }
}

console.log('\n=== Test 8: detectDenyIntent 普通の改善コメントには反応しない ===');
{
  const benign = [
    '具体例をもう少し増やしてください',
    'タイトルを少し短くしてください',
    '冒頭の結論をもっと明確にしてください',
    '比較表を入れてください',
    '誤字があるので直してください',
  ];
  for (const c of benign) {
    assert(!detectDenyIntent(c), `誤検出しない: "${c}"`);
  }
}

// ── 9. buildEntriesFromContext ──────────────────────────────────
console.log('\n=== Test 9: buildEntriesFromContext ===');
{
  const meta = {
    slug: 'test-slug',
    subcluster: 'test-subcluster',
    primary_question: 'これはテスト質問？',
  };
  const entries = buildEntriesFromContext(meta, '今後このテーマは書かないでください', 'review_revise');
  assert(entries.length === 2, 'subcluster + primary_question で 2 件生成');
  assert(entries.some(e => e.type === 'subcluster' && e.value === 'test-subcluster'), 'subcluster 含む');
  assert(entries.some(e => e.type === 'primary_question'), 'primary_question 含む');
  assert(entries.every(e => e.source === 'review_revise'), 'source=review_revise');
  assert(entries.every(e => e.active === true), 'active=true');

  const slugOnly = buildEntriesFromContext({ slug: 'only-slug' }, 'cmt', 'review_skip');
  assert(slugOnly.length === 1 && slugOnly[0].type === 'slug', 'subcluster無しは slug でフォールバック');
}

// ── 10. mergeEntries 重複排除 ──────────────────────────────────
console.log('\n=== Test 10: mergeEntries 重複排除 ===');
{
  const denylist = { version: 1, entries: [{ type: 'subcluster', value: 'existing', active: true }] };
  const newEntries = [
    { type: 'subcluster', value: 'existing', active: true },  // 既存と重複
    { type: 'subcluster', value: 'NEW1', active: true },
    { type: 'keyword', value: 'foo', active: true },
  ];
  const r = mergeEntries(denylist, newEntries);
  assert(r.added === 2, '重複排除して 2 件追加');
  assert(r.denylist.entries.length === 3, '合計 3 件');
}

// ── 11. topic-selector が time-limited / denylist を除外 ─────────
console.log('\n=== Test 11: topic-selector が定額減税を除外 ===');
{
  // selector の lazy require（denylist のキャッシュを避けるため）
  delete require.cache[require.resolve(path.join(ROOT, 'scripts/lib/topic-selector.js'))];
  const { selectDailyTopics } = require(path.join(ROOT, 'scripts/lib/topic-selector.js'));
  const { TOPICS } = require(path.join(ROOT, 'scripts/topic-pool.js'));

  const result = selectDailyTopics(TOPICS, { now: new Date() });
  // 定額減税の slug が picks に含まれていないことを確認
  const denySlug = 'fixed-amount-tax-reduction-monthly-procedure';
  const hit = result.picks.some(p => p.slug === denySlug);
  assert(!hit, '定額減税は picks に含まれない');

  // explanation に time-limited / denylist のブロックステップがある
  const hasTimeLimited = result.explanation.steps.some(s => s.step === 'filter-time-limited');
  const hasDenylist    = result.explanation.steps.some(s => s.step === 'filter-denylist');
  assert(hasTimeLimited, 'filter-time-limited ステップが explanation に含まれる');
  assert(hasDenylist, 'filter-denylist ステップが explanation に含まれる');
}

// ── 12. tax-law-changes: 定額減税は getChangesForTopic から除外 ─
console.log('\n=== Test 12: tax-law-changes の定額減税が getChangesForTopic から除外 ===');
{
  delete require.cache[require.resolve(path.join(ROOT, 'scripts/lib/tax-law-changes.js'))];
  const { getChangesForTopic, CHANGES } = require(path.join(ROOT, 'scripts/lib/tax-law-changes.js'));
  // 定額減税 entry が status='expired' になっている
  const fixedAmount = CHANGES.find(c => c.key === 'fixed_amount_tax_reduction');
  assert(fixedAmount && fixedAmount.status === 'expired', '定額減税は status=expired');
  // beauty_salon_owner + income_tax の topic で取得しても、定額減税は返らない
  const refs = getChangesForTopic(
    { persona: 'beauty_salon_owner', tax_domain: 'income_tax' },
    5,
    new Date('2026-05-04'));
  assert(!refs.some(r => r.key === 'fixed_amount_tax_reduction'), '定額減税は getChangesForTopic から除外');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
