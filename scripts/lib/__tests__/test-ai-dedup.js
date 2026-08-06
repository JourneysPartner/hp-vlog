'use strict';

/**
 * AI重複判定モジュール (ai-dedup.js) のユニットテスト。
 *   node scripts/lib/__tests__/test-ai-dedup.js
 *
 * aux-model の generateAux をモックし、LLM呼び出しなしで
 * JSON解析・フォールバック動作を検証する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); passed++; }
  else { console.error(`  ✗ FAIL ${label}`); failed++; }
}

// ── generateAux をモック ──
let mockAuxReturn = null;
const origModule = require.resolve(path.join(ROOT, 'scripts/lib/aux-model'));
require.cache[origModule] = {
  id: origModule,
  filename: origModule,
  loaded: true,
  exports: {
    generateAux: async () => mockAuxReturn,
    canUseAux: () => mockAuxReturn !== null,
    auxEnabled: () => mockAuxReturn !== null,
  },
};

const { checkDuplicatesWithAI } = require(path.join(ROOT, 'scripts/lib/ai-dedup'));

const CORPUS = [
  { slug: 'ebay-seller-income-tax-guide', title: 'eBay輸出の所得税ガイド', primary_question: 'eBay売上の所得税はどう申告する？', category: '所得税' },
  { slug: 'consumption-tax-basic-guide', title: '消費税の基本解説', primary_question: '消費税の仕組みは？', category: '消費税' },
];

const PICKS = [
  { slug: 'ebay-seller-income-tax-practice', title: '', search_intent: 'eBay輸出の所得税で失敗しやすいポイント', persona: 'cross_border_ec', category: '所得税', pain_point: 'income-tax', business_stage: 'growth', article_type: 'misconception_fix' },
  { slug: 'inheritance-basic-guide', title: '相続税の基本', search_intent: '相続税の基礎を知りたい', persona: 'family_asset', category: '相続税', pain_point: 'inheritance', business_stage: '', article_type: 'basic_explainer' },
];

(async () => {
  // ── Test 1: aux未有効 → skipped ──
  console.log('\n=== Test 1: aux未有効 → skipped ===');
  mockAuxReturn = null;
  const r1 = await checkDuplicatesWithAI(PICKS, CORPUS);
  assert(r1.skipped === true, 'aux未有効ならskipped=true');
  assert(r1.results.length === 0, 'results は空');

  // ── Test 2: LLMが重複を検出 ──
  console.log('\n=== Test 2: LLMが重複を検出 ===');
  mockAuxReturn = JSON.stringify([
    { slug: 'ebay-seller-income-tax-practice', duplicate: true, similar_to: 'ebay-seller-income-tax-guide', reason: '同じeBay所得税テーマ' },
    { slug: 'inheritance-basic-guide', duplicate: false, similar_to: null, reason: '既存に相続税記事なし' },
  ]);
  const r2 = await checkDuplicatesWithAI(PICKS, CORPUS);
  assert(r2.skipped === false, 'skipped=false');
  assert(r2.results.length === 2, '2件の結果');
  assert(r2.results[0].duplicate === true, '1件目は重複');
  assert(r2.results[0].similar_to === 'ebay-seller-income-tax-guide', '重複先slug');
  assert(r2.results[1].duplicate === false, '2件目は非重複');

  // ── Test 3: LLMが重複なしと判定 ──
  console.log('\n=== Test 3: LLMが重複なしと判定 ===');
  mockAuxReturn = JSON.stringify([
    { slug: 'ebay-seller-income-tax-practice', duplicate: false, similar_to: null, reason: 'practice記事は別角度' },
    { slug: 'inheritance-basic-guide', duplicate: false, similar_to: null, reason: '既存に相続税記事なし' },
  ]);
  const r3 = await checkDuplicatesWithAI(PICKS, CORPUS);
  assert(r3.skipped === false, 'skipped=false');
  const dup3 = r3.results.filter(r => r.duplicate);
  assert(dup3.length === 0, '重複なし');

  // ── Test 4: LLMが不正なJSON → skipped ──
  console.log('\n=== Test 4: 不正なJSON → skipped ===');
  mockAuxReturn = 'This is not JSON at all';
  const r4 = await checkDuplicatesWithAI(PICKS, CORPUS);
  assert(r4.skipped === true, '不正JSON → skipped=true');
  assert(r4.parseError === true, 'parseError=true');

  // ── Test 5: LLMがJSON+余計なテキスト → 正常解析 ──
  console.log('\n=== Test 5: JSON+余計なテキスト → 正常解析 ===');
  mockAuxReturn = 'Here is the result:\n' + JSON.stringify([
    { slug: 'ebay-seller-income-tax-practice', duplicate: false, similar_to: null, reason: '非重複' },
  ]);
  const r5 = await checkDuplicatesWithAI(PICKS, CORPUS);
  assert(r5.skipped === false, '余計なテキスト付きでも解析成功');
  assert(r5.results.length === 1, '1件の結果');

  // ── Test 6: picks が空 → skipped ──
  console.log('\n=== Test 6: picks が空 → skipped ===');
  const r6 = await checkDuplicatesWithAI([], CORPUS);
  assert(r6.skipped === true, '空picks → skipped');

  console.log(`\n=== 結果 ===`);
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  if (failed > 0) process.exit(1);
})();
