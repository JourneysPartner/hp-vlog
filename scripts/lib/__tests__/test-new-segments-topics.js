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
const { resolveSourceForTopic } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const topics = expandNewSegments().map(topic => {
  const source = resolveSourceForTopic(topic);
  return {
    ...topic,
    source_url: source.url,
    source_title: source.title,
    source_provenance: source.provenance,
    source_confidence: source.confidence,
  };
});

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

// ── 3. 関連性・出典・推奨 ─────────────────────────────────────
// 出典を個別確定できた topic は approve（score=5）、確定できない論点
// （NEEDS_SOURCE_REVIEW）は汎用フォールバックで approve にせず revise。
const { DEFAULT_SOURCE_BY_PAIN, NEEDS_SOURCE_REVIEW } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
console.log('\n=== Test 3: 関連性・出典・推奨 ===');
assert(topics.every(t => isNaturalCombination(t)), '全 topic が関連性ゲートを通過');
// 新カテゴリの全 pain は「個別出典登録済み」または「明示的に要確認(NEEDS_SOURCE_REVIEW)」
const pains = [...new Set(topics.map(t => t.pain_point))];
assert(pains.every(p => DEFAULT_SOURCE_BY_PAIN[p] || NEEDS_SOURCE_REVIEW.has(p)),
  '全 pain が DEFAULT_SOURCE_BY_PAIN 登録済み or NEEDS_SOURCE_REVIEW（汎用フォールバックの放置なし）');
// approve の topic は個別出典（byPain）に基づく（tax_domain 汎用フォールバックではない）
const approveTopics = topics.filter(t => evaluateTopicFit(t).decision === 'approve');
assert(approveTopics.every(t => DEFAULT_SOURCE_BY_PAIN[t.pain_point] && evaluateTopicFit(t).source_alignment_score === 5),
  'approve は pain 個別出典に一致（score=5）している');
// NEEDS_SOURCE_REVIEW の pain は approve にならない
assert(topics.filter(t => NEEDS_SOURCE_REVIEW.has(t.pain_point)).every(t => evaluateTopicFit(t).decision !== 'approve'),
  'NEEDS_SOURCE_REVIEW の論点は approve にならない');
// ユーザー指摘の4例: 汎用フォールバックのまま approve にしないこと。
// 当初はこの4例すべて出典が未確定で、approve にならないことを確認していた。
// その後 3例は原文を確認して個別出典を確定し、対応表に登録した。
//   retail-gift-certificate → No.6229 商品券やプリペイドカードなど
//   wholesale-return-rebate → No.6359 値引き、返品、割戻しなどを行った場合の税額の調整
//   content-course-bundle   → No.6165 前受金や前払金などがあるとき（2026-08-24）
// 確定済みのものは approve になるのが正しい。検証したいのは
// 「汎用フォールバックのまま approve にしない」ことなので、そちらを確認する。
const eatin = topics.find(t => t.pain_point === 'retail-food-eatin');
assert(evaluateTopicFit(eatin).decision === 'approve' && !/6501/.test(eatin.source_url),
  'retail-food-eatin は軽減税率の個別出典で approve（6501汎用ではない）');
for (const p of ['retail-gift-certificate', 'content-course-bundle', 'wholesale-return-rebate']) {
  const t = topics.find(x => x.pain_point === p);
  const fit = evaluateTopicFit(t);
  if (NEEDS_SOURCE_REVIEW.has(p)) {
    assert(fit.decision !== 'approve', `${p} は出典が未確定なので approve にならない`);
  } else {
    assert(fit.decision === 'approve' && fit.source_alignment_score === 5,
      `${p} は個別出典が確定済みなので approve（出典一致スコア5）`);
    assert(!!DEFAULT_SOURCE_BY_PAIN[p], `${p} は対応表に登録されている`);
  }
}

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

// ── 5. YouTuber の AI 拡張（サブ業種×テーマ×ステージの掛け合わせ）─────
console.log('\n=== Test 5: YouTuber 掛け合わせ拡張 ===');
const yt = topics.filter(t => t.customer_segment === 'youtuber');
assert(yt.length >= 40, `YouTuber が掛け合わせで増える（${yt.length} 本 >= 40）`);
assert(yt.every(t => evaluateTopicFit(t).decision === 'approve'), 'YouTuber は全て approve（不自然/低スコアは無い）');
// ジャンル特化テーマが該当ジャンルにだけ出る
const gamingOnly = yt.filter(t => t.pain_point === 'youtube-gaming-hardware');
assert(gamingOnly.length > 0 && gamingOnly.every(t => t.sub_segment === 'gaming'), 'ゲーム機材テーマは gaming ジャンルのみ');
// 開業ステージで掛け合わされている
const stageVariants = yt.filter(t => t.pain_point === 'youtube-tax-return-need' && t.article_role === 'main');
assert(new Set(stageVariants.map(t => t.business_stage)).size >= 3, '確定申告テーマが副業/専業/法人化で展開される');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
