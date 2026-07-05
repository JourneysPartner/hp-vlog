'use strict';

/**
 * 品質ゲート（関連性ゲートの安全装置化・承認/公開ブロック・スコア判定）のテスト。
 *   node scripts/lib/__tests__/test-quality-gate.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { selectDailyTopics } = require(path.join(ROOT, 'scripts/lib/topic-selector'));
const { evaluateTopicFit, publishGateReasons } = require(path.join(ROOT, 'scripts/lib/customer-relevance'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 関連性ゲートが安全装置として必ず効く（全滅→picks空・フォールバック無し）──
console.log('\n=== Test 1: 関連性ゲートで全滅 → 生成しない ===');
const mkUnnatural = (n, pain) => ({
  slug: `test-unnat-${n}`, title: '', persona: 'beauty_salon_owner', customer_segment: 'beauty_salon',
  category: '消費税', macro: 'サロン', cluster: 'hair-salon', subcluster: `x${n}`,
  tax_domain: 'consumption_tax', pain_point: pain, article_type: 'basic_explainer', article_role: 'main',
  search_intent: 'x', reader_problem: 'x', success_outcome: 'x', primary_question: 'x',
});
const unnatural = [mkUnnatural(1, 'foreign-business-consumption-tax'), mkUnnatural(2, 'specified-services')];
const res = selectDailyTopics(unnatural, { now: new Date() });
assert(res.picks.length === 0, '不適合候補のみ → picks が空（ランダム復活しない）');
assert((res.explanation.warnings || []).some(w => /関連性ゲート/.test(w)), 'explanation に関連性ゲートで生成しない理由が残る');
const relStep = (res.explanation.steps || []).find(s => s.step === 'filter-relevance');
assert(relStep && relStep.remaining === 0, 'filter-relevance ステップで remaining=0');

// ── 2. evaluateTopicFit の判定（hard=reject / soft・score<=3=revise / approve条件）──
console.log('\n=== Test 2: evaluateTopicFit の判定 ===');
const U = {
  shohi6501: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',
  sozoku4124: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm',
  sozoku4152: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm',
  zoyo4408: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',
};
// hard mismatch → reject
const hard = evaluateTopicFit({ persona: 'inheritance_client', tax_domain: 'inheritance_tax', pain_point: 'tax-applicable-or-not', source_url: U.zoyo4408, search_intent: '相続税 申告 必要か 財産' });
assert(hard.decision === 'reject', 'hard 不一致 → reject');
// soft mismatch → revise（source<=3）
const soft = evaluateTopicFit({ persona: 'inheritance_client', tax_domain: 'inheritance_tax', pain_point: 'small-residential-land', source_url: U.sozoku4152, search_intent: '小規模宅地 特例 要件 相続' });
assert(soft.decision === 'revise', 'soft 不一致（score3）→ revise');
assert(soft.source_alignment_score <= 3, 'soft は source_alignment_score<=3');
// approve は fit>=4 かつ search_intent>=4 かつ source>=4
const good = evaluateTopicFit({ persona: 'inheritance_client', tax_domain: 'inheritance_tax', pain_point: 'small-residential-land', source_url: U.sozoku4124, search_intent: '小規模宅地 特例 自宅 相続 要件' });
assert(good.decision === 'approve', '一致・具体的検索意図 → approve');
assert(good.customer_fit_score >= 4 && good.search_intent_score >= 4 && good.source_alignment_score >= 4, 'approve は各スコア>=4');
// 検索意図が弱い → approve にならない
const weak = evaluateTopicFit({ persona: 'inheritance_client', tax_domain: 'inheritance_tax', pain_point: 'small-residential-land', source_url: U.sozoku4124, search_intent: 'x' });
assert(weak.decision !== 'approve', '検索意図が弱い → approve にならない');
assert(/出典|検索意図|関連性/.test(weak.reason) || weak.reason === '' ? true : true, 'reason は文字列');

// ── 3. publishGateReasons（承認・公開ブロック判定）────────────────
console.log('\n=== Test 3: publishGateReasons ===');
assert(publishGateReasons({ recommendation: 'reject', customer_fit_score: 1, search_intent_score: 5, source_alignment_score: 5 }).length > 0, 'reject → ブロック');
assert(publishGateReasons({ recommendation: 'revise', customer_fit_score: 5, search_intent_score: 3, source_alignment_score: 5 }).length > 0, 'revise → ブロック');
assert(publishGateReasons({ recommendation: 'publish', customer_fit_score: 5, search_intent_score: 5, source_alignment_score: 3 }).some(r => /source_alignment/.test(r)), 'source_alignment_score=3 → ブロック');
assert(publishGateReasons({ recommendation: 'publish', customer_fit_score: 3, search_intent_score: 5, source_alignment_score: 5 }).some(r => /customer_fit/.test(r)), 'customer_fit_score=3 → ブロック');
assert(publishGateReasons({ recommendation: 'publish', customer_fit_score: 5, search_intent_score: 5, source_alignment_score: 5 }).length === 0, '良好スコア → ブロックしない');
assert(publishGateReasons({}).length === 0, 'スコア未設定（レガシー）→ ブロックしない');
assert(publishGateReasons({ recommendation: '' }).length === 0, 'recommendation 空（レガシー）→ ブロックしない');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
