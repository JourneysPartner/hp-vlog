'use strict';

/**
 * 質疑応答事例候補の自動一次選別（triage）テスト。
 *   node scripts/lib/__tests__/test-candidate-triage.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { triageCandidate, applyTriage } = require(path.join(ROOT, 'scripts/lib/candidate-triage'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const mk = (o) => Object.assign({
  shitsugi_title: '', tax_category: '消費税', score: 70,
  score_breakdown: { persona_match: 25, search_need: 15, freshness: 10, judgment_ambiguity: 6, taxanswer_support: 20 },
  proposed: { persona: 'domestic_ec_seller', macro: '物販' },
}, o);

// ── 1. auto_decision の閾値 ─────────────────────────────────
console.log('\n=== Test 1: 閾値判定 ===');
assert(triageCandidate(mk({ score: 90 })).auto_decision === 'recommend', '85+ → recommend');
assert(triageCandidate(mk({ score: 70 })).auto_decision === 'review', '55〜84 → review');
assert(triageCandidate(mk({ score: 40, score_breakdown: {} })).auto_decision === 'reject', '54- → reject');

// ── 2. 対象外（特殊論点）は score に関わらず reject ──────────
console.log('\n=== Test 2: 対象外の自動除外 ===');
const oos = [
  '連結納税の適用における欠損金の取扱い',
  '組織再編成に係る適格分割の判定',
  '公益社団法人の収益事業の判定',
  'デリバティブ取引に係る有価証券の評価',
  '移転価格税制における独立企業間価格',
];
for (const title of oos) {
  const t = triageCandidate(mk({ score: 95, shitsugi_title: title }));
  assert(t.auto_decision === 'reject' && /対象外/.test(t.auto_reasons.join('')), `対象外→reject: ${title.slice(0, 12)}…`);
}
// 個人向けの一般的な論点は reject にしない
assert(triageCandidate(mk({ score: 88, shitsugi_title: '事業用資産の減価償却の取扱い' })).auto_decision === 'recommend', '一般論点は reject にしない');

// ── 3. target_segments / article_potential ──────────────────
console.log('\n=== Test 3: 対象カテゴリ・ポテンシャル ===');
assert(triageCandidate(mk({ proposed: { persona: 'beauty_salon_owner', macro: 'サロン' } })).target_segments.includes('beauty_salon'), 'persona→target_segments(サロン)');
assert(triageCandidate(mk({ tax_category: '相続', proposed: {} })).target_segments.includes('inheritance_gift'), '税目(相続)→inheritance_gift');
assert(triageCandidate(mk({ score: 90 })).article_potential === 'high', 'score90 → high');
assert(triageCandidate(mk({ score: 70 })).article_potential === 'medium', 'score70 → medium');
assert(triageCandidate(mk({ score: 50, score_breakdown: {} })).article_potential === 'low', 'score50 → low');

// ── 4. applyTriage は手動編集を変更しない ───────────────────
console.log('\n=== Test 4: 手動編集の非破壊 ===');
const cands = [
  mk({ shitsugi_url: 'u1', score: 90, adopted: true }),
  mk({ shitsugi_url: 'u2', score: 40, score_breakdown: {}, rejected: true, rejection_note: 'メモ' }),
];
const counts = applyTriage(cands);
assert(cands[0].adopted === true, 'adopted=true を保持');
assert(cands[1].rejected === true && cands[1].rejection_note === 'メモ', 'rejected/note を保持');
assert(cands[0].auto_decision && cands[1].auto_decision, 'auto_decision が付与される');
assert(typeof counts.recommend === 'number' && typeof counts.review === 'number' && typeof counts.reject === 'number', '件数集計が返る');

// ── 5. 実データが triage 済みで手動フラグが生きている ────────
console.log('\n=== Test 5: 実データの整合 ===');
try {
  const data = require(path.join(ROOT, 'data/nta-shitsugi-topics-candidate.json'));
  const arr = data.candidates || [];
  assert(arr.length > 0, '候補データがある');
  assert(arr.every(c => ['recommend', 'review', 'reject'].includes(c.auto_decision)), '全候補に auto_decision が付与済み');
  assert(arr.some(c => c.adopted === true), '既存 adopted=true が保持されている');
} catch (e) {
  assert(false, '実データ読込: ' + e.message);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
