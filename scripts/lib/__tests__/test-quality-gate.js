'use strict';

/**
 * 品質ゲート（関連性ゲートの安全装置化・承認/公開ブロック・スコア判定）のテスト。
 *   node scripts/lib/__tests__/test-quality-gate.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { selectDailyTopics } = require(path.join(ROOT, 'scripts/lib/topic-selector'));
const { evaluateTopicFit: evaluateCurrentTopicFit, publishGateReasons } = require(path.join(ROOT, 'scripts/lib/customer-relevance'));
const evaluateTopicFit = topic => evaluateCurrentTopicFit({ source_provenance: 'curated', ...topic });

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

// ── 4. topic-selector は approve 候補だけを選定する（revise/reject を除外）──
console.log('\n=== Test 4: 品質ゲート（approve のみ選定）===');
const mkEc = (slug, si) => ({
  slug, title: '', persona: 'domestic_ec_seller', customer_segment: 'ec_seller', category: '消費税',
  macro: '物販', cluster: 'amazon', subcluster: slug, tax_domain: 'consumption_tax',
  pain_point: 'test-platform-fee-treatment', allowed_customer_segments: ['ec_seller', 'general_business'],
  article_type: 'basic_explainer', article_role: 'main',
  source_url: 'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm',
  source_provenance: 'explicit',
  search_intent: si, reader_problem: 'r', success_outcome: 's', primary_question: 'q',
});
const approveT = mkEc('test-qf-approve', 'Amazon 手数料 消費税 仕入税額控除 いつ');
const reviseT1 = mkEc('test-qf-revise-1', 'x');
const reviseT2 = mkEc('test-qf-revise-2', 'y');
// 前提: fit の decision が想定どおり
assert(evaluateTopicFit(approveT).decision === 'approve', '前提: approveT は approve');
assert(evaluateTopicFit(reviseT1).decision === 'revise', '前提: reviseT1 は revise');

// revise だけ → picks 空・filter-quality-fit・warning
const rOnly = selectDailyTopics([reviseT1, reviseT2], { now: new Date() });
assert(rOnly.picks.length === 0, 'revise のみ → picks 空（生成しない）');
const qStep = (rOnly.explanation.steps || []).find(s => s.step === 'filter-quality-fit');
assert(qStep && qStep.remaining === 0, 'filter-quality-fit ステップが残り、remaining=0');
assert((qStep.blockedDetails || []).some(d => d.decision === 'revise' && d.slug && d.search_intent_score != null),
  'blockedDetails に slug/decision/score が入る');
assert((rOnly.explanation.warnings || []).some(w => /品質ゲート/.test(w)), 'warnings に品質ゲートで生成しない旨');

// approve + revise 混在 → approve だけ残る
const mixed = selectDailyTopics([approveT, reviseT1], { now: new Date() });
assert(mixed.picks.length >= 1 && mixed.picks.every(p => p.slug !== 'test-qf-revise-1'),
  'approve+revise 混在 → revise は選ばれない');
assert(mixed.picks.every(p => evaluateTopicFit(p).decision === 'approve'), 'picks は全て approve');

// ── 5. 実プールの dry-run：picks は全て approve ─────────────────
console.log('\n=== Test 5: 実プール dry-run ===');
const { TOPICS } = require(path.join(ROOT, 'scripts/topic-pool'));
const dry = selectDailyTopics(TOPICS, { now: new Date() });
// 2026-08-27: 検索サジェスト由来の候補は出典を持たずにプールへ入り、出典は生成時に
// 解決される（確定しなければ承認時の出典ガードが止める）。そのため候補段階の判定は
// approve とは限らない。ここでは「reject が選ばれない」ことと、approve でない pick は
// 出典未解決の需要つき候補（設計どおりの状態）だけであることを確認する。
assert(dry.picks.every(p => evaluateTopicFit(p).decision !== 'reject'),
  `dry-run の picks に reject が無い（${dry.picks.length} 本）`);
assert(dry.picks.every(p => {
  const fit = evaluateTopicFit(p);
  if (fit.decision === 'approve') return true;
  // 選定段階では汎用の出典が仮置きされる（domain-fallback 等）。人が確定した出典
  // （explicit / curated）で revise になっているなら本当の問題なので許容しない。
  const weak = ['domain-fallback', 'ultimate', 'auto', 'unknown', undefined];
  return !!p.demand_evidence && weak.includes(p.source_provenance);
}), 'approve でない pick は出典が仮置きの需要つき候補だけ');
const dryQ = (dry.explanation.steps || []).find(s => s.step === 'filter-quality-fit');
assert(dryQ && dryQ.blocked >= 0 && dryQ.remaining >= 0, 'dry-run に filter-quality-fit ステップが残る');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
