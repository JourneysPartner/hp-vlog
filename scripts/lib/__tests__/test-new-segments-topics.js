'use strict';

/**
 * 新カテゴリのトピック生成テスト（Phase 4b）。
 *   node scripts/lib/__tests__/test-new-segments-topics.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { expandNewSegments } = require(path.join(ROOT, 'scripts/lib/scenario-new-segments'));
const { expandAll } = require(path.join(ROOT, 'scripts/lib/scenario-expansion'));
const { isNaturalCombination, evaluateTopicFit } = require(path.join(ROOT, 'scripts/lib/customer-relevance'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const topics = expandNewSegments();

// ── 1. 5カテゴリすべてが生成される ──────────────────────────
console.log('\n=== Test 1: 5カテゴリの生成 ===');
for (const seg of ['youtuber', 'content_seller', 'construction_solo', 'retail_store', 'wholesale']) {
  const n = topics.filter(t => t.customer_segment === seg).length;
  assert(n >= 10, `${seg} が生成される（${n} 本）`);
}

// ── 2. 本命+補強ペア・必須メタが揃う ────────────────────────
console.log('\n=== Test 2: ペアと必須メタ ===');
assert(topics.every(t => t.slug && t.source_url && t.search_intent && t.primary_question && t.pain_point),
  '全 topic に slug/source_url/search_intent/primary_question/pain_point');
assert(topics.filter(t => t.article_role === 'main').length === topics.length / 2, '本命が半数');
assert(topics.every(t => Array.isArray(t.allowed_customer_segments) && t.allowed_customer_segments.length === 1),
  '各 topic に allowed_customer_segments=[自カテゴリ]');

// ── 3. 全 topic が関連性ゲートを通る ────────────────────────
console.log('\n=== Test 3: 関連性・出典・推奨 ===');
assert(topics.every(t => isNaturalCombination(t)), '全 topic が関連性ゲートを通過');
assert(topics.every(t => evaluateTopicFit(t).source_alignment_score >= 4), '全 topic の出典一致スコア>=4');
assert(topics.every(t => evaluateTopicFit(t).decision === 'approve'), '全 topic の推奨=approve');

// ── 4. expandAll に合流し、他業種に漏れない ──────────────────
console.log('\n=== Test 4: expandAll 合流と漏れ防止 ===');
const all = expandAll();
const newSegSlugs = new Set(topics.map(t => t.slug));
const inAll = all.filter(t => newSegSlugs.has(t.slug)).length;
assert(inAll > 0, `expandAll に新カテゴリ topic が含まれる（${inAll} 本）`);
// YouTuber の AdSense 論点が他カテゴリに出ていない
const adsenseWrong = all.filter(t => t.pain_point === 'youtube-adsense-revenue' && t.customer_segment !== 'youtuber');
assert(adsenseWrong.length === 0, 'AdSense論点は youtuber 以外に出ない');
const salonWrong = all.filter(t => ['youtuber', 'wholesale', 'construction_solo'].includes(t.customer_segment) && t.pain_point === 'salon-prepayment-ticket');
assert(salonWrong.length === 0, '回数券論点は新カテゴリに出ない');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
