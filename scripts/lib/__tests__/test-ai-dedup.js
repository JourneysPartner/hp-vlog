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

  // ── Test 7: pain_point 一致なら persona/type 違いでもオーバーライドしない ──
  // 2026-08-15 の事故の再現。自販機特例の記事が persona 違いを理由に
  // 非重複へ上書きされ、前日とほぼ同内容の記事が生成された。
  console.log('\n=== Test 7: pain_point 一致は persona/type 違いでも重複を維持 ===');
  {
    const corpus = [{
      slug: 'deepdive-influencer_creator-vending-machine-special-guide',
      title: '自動販売機特例とは？',
      primary_persona: 'influencer_creator',
      article_type: 'basic_explainer',
      pain_point: 'vending-machine-special',
      category: '消費税',
    }];
    const picks = [{
      slug: 'deepdive-domestic_ec_seller-vending-machine-special-practice',
      title: '自販機・コインパーキングの売上は？',
      persona: 'domestic_ec_seller',      // persona 違い
      article_type: 'edge_case',           // type も違い
      pain_point: 'vending-machine-special', // ただし論点は同一
      category: '消費税',
    }];
    mockAuxReturn = JSON.stringify([{
      slug: picks[0].slug, duplicate: true,
      similar_to: corpus[0].slug, reason: '同じ自販機特例',
    }]);
    const r7 = await checkDuplicatesWithAI(picks, corpus);
    assert(r7.skipped === false, 'skipped=false');
    assert(r7.results[0].duplicate === true,
      'pain_point 一致なら persona/type が違っても重複のまま（オーバーライドされない）');
    assert(!/override/.test(r7.results[0].reason || ''),
      'reason がオーバーライドで書き換えられていない');
  }

  // ── Test 8: pain_point が違えば従来どおり persona ガードが効く ──
  console.log('\n=== Test 8: pain_point 相違なら persona ガードは従来どおり ===');
  {
    const corpus = [{
      slug: 'a-guide', title: '簡易課税の事業区分',
      primary_persona: 'beauty_salon_owner', article_type: 'basic_explainer',
      pain_point: 'simplified-tax-business-category', category: '消費税',
    }];
    const picks = [{
      slug: 'b-guide', title: '高額特定資産の3年縛り',
      persona: 'domestic_ec_seller', article_type: 'basic_explainer',
      pain_point: 'high-value-asset-3year-restriction', category: '消費税',
    }];
    mockAuxReturn = JSON.stringify([{
      slug: 'b-guide', duplicate: true, similar_to: 'a-guide', reason: 'どちらも消費税',
    }]);
    const r8 = await checkDuplicatesWithAI(picks, corpus);
    assert(r8.results[0].duplicate === false,
      'pain_point が違えば persona 不一致で非重複にオーバーライドされる');
    assert(/override/.test(r8.results[0].reason || ''),
      'reason にオーバーライドの記録が残る');
  }

  // ── Test 9: コーパス要約に pain_point が載る ──
  console.log('\n=== Test 9: コーパス要約に pain が含まれる ===');
  {
    const { buildCorpusSummary } = require(path.join(ROOT, 'scripts/lib/ai-dedup'));
    const summary = buildCorpusSummary([
      { slug: 'y', title: 'u', primary_persona: 'influencer_creator',
        category: '消費税', pain_point: 'vending-machine-special' },
    ]);
    assert(/pain:vending-machine-special/.test(summary),
      'LLM に渡すコーパス要約に既存記事の pain_point が含まれる');
    assert(/persona:influencer_creator/.test(summary),
      'persona も従来どおり含まれる');
  }

  console.log(`\n=== 結果 ===`);
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  if (failed > 0) process.exit(1);
})();
