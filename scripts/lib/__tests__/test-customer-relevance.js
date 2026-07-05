'use strict';

/**
 * 顧客カテゴリ関連性ゲートのテスト。
 *   node scripts/lib/__tests__/test-customer-relevance.js
 *
 * Phase 1 で扱う既存カテゴリ（ec_seller / beauty_salon / creator /
 * general_business / inheritance_gift）の reject / approve を検証する。
 * 新カテゴリ（youtuber / content_seller / construction_solo / retail_store /
 * wholesale）のケースは Phase 4 で追加する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  deriveSegment, isNaturalCombination, evaluateTopicFit,
} = require(path.join(ROOT, 'scripts/lib/customer-relevance'));
const { expandAll } = require(path.join(ROOT, 'scripts/lib/scenario-expansion'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. deriveSegment ────────────────────────────────────────
console.log('\n=== Test 1: deriveSegment ===');
assert(deriveSegment({ persona: 'beauty_salon_owner' }).customer_segment === 'beauty_salon', 'persona→segment (salon)');
assert(deriveSegment({ persona: 'domestic_ec_seller' }).customer_segment === 'ec_seller', 'persona→segment (ec)');
assert(deriveSegment({ persona: 'ebay_export_seller' }).customer_segment === 'ec_seller', 'persona→segment (ebay=ec)');
assert(deriveSegment({ persona: 'influencer_creator' }).customer_segment === 'creator', 'persona→segment (creator)');
assert(deriveSegment({ persona: 'inheritance_client' }).customer_segment === 'inheritance_gift', 'persona→segment (inheritance)');
assert(deriveSegment({ persona: 'general_individual_proprietor' }).customer_segment === 'general_business', 'persona→segment (general)');
assert(deriveSegment({ macro: 'サロン' }).customer_segment === 'beauty_salon', 'macro fallback (サロン)');
assert(deriveSegment({ customer_segment: 'ec_seller' }).customer_segment === 'ec_seller', 'explicit customer_segment 優先');

// ── 2. reject されるべき（既存カテゴリ）───────────────────────
console.log('\n=== Test 2: reject されるべき ===');
// allowed_customer_segments 経由（deep-dive 生成スタイル）
assert(!isNaturalCombination({ customer_segment: 'beauty_salon', pain_point: 'specified-services', allowed_customer_segments: ['general_business'] }), 'beauty_salon × 特定役務(海外アーティスト)');
// REJECT_MATRIX 経由（allowed 未設定の curated スタイル）
assert(!isNaturalCombination({ persona: 'beauty_salon_owner', pain_point: 'foreign-business-consumption-tax', tax_domain: 'consumption_tax' }), 'beauty_salon × 国外事業者一般');
assert(!isNaturalCombination({ persona: 'beauty_salon_owner', pain_point: 'import-tax-refund-detail', tax_domain: 'consumption_tax' }), 'beauty_salon × 輸入消費税還付');
assert(!isNaturalCombination({ persona: 'beauty_salon_owner', pain_point: 'customs-duty-treatment' }), 'beauty_salon × 関税');
assert(!isNaturalCombination({ persona: 'influencer_creator', pain_point: 'salon-prepayment-ticket' }), 'creator × 回数券(サロン論点)');
assert(!isNaturalCombination({ persona: 'domestic_ec_seller', pain_point: 'creator-royalty-income' }), 'ec_seller × クリエイター印税');
// 事業者 ⇔ 相続 の税目分離
assert(!isNaturalCombination({ persona: 'inheritance_client', tax_domain: 'consumption_tax', pain_point: 'invoice-judgement' }), '相続 × 消費税/インボイス');
assert(!isNaturalCombination({ persona: 'inheritance_client', tax_domain: 'bookkeeping_expenses' }), '相続 × 帳簿経費');
assert(!isNaturalCombination({ persona: 'domestic_ec_seller', tax_domain: 'inheritance_tax' }), 'ec_seller × 相続税');
assert(!isNaturalCombination({ persona: 'beauty_salon_owner', tax_domain: 'inheritance_tax' }), 'beauty_salon × 相続税');

// ── 3. approve されるべき（既存カテゴリ）──────────────────────
console.log('\n=== Test 3: approve されるべき ===');
assert(isNaturalCombination({ persona: 'beauty_salon_owner', pain_point: 'salon-prepayment-ticket', tax_domain: 'consumption_tax' }), 'beauty_salon × 回数券');
assert(isNaturalCombination({ persona: 'beauty_salon_owner', pain_point: 'salon-product-service-distinction' }), 'beauty_salon × 店販商品');
assert(isNaturalCombination({ customer_segment: 'beauty_salon', pain_point: 'b2b-electronic-services', allowed_customer_segments: ['ec_seller', 'creator', 'beauty_salon', 'general_business'] }), 'beauty_salon × 海外広告/SaaS(許可)');
assert(isNaturalCombination({ customer_segment: 'ec_seller', pain_point: 'foreign-business-consumption-tax', allowed_customer_segments: ['ec_seller', 'general_business'] }), 'ec_seller × 国外事業者');
assert(isNaturalCombination({ persona: 'domestic_ec_seller', pain_point: 'ec-inventory-fba-fbm' }), 'ec_seller × EC在庫');
assert(isNaturalCombination({ persona: 'influencer_creator', pain_point: 'influencer-pr-product-revenue' }), 'creator × PR商品');
assert(isNaturalCombination({ persona: 'inheritance_client', tax_domain: 'inheritance_tax', pain_point: 'inheritance-tax-return' }), '相続 × 相続税');
assert(isNaturalCombination({ persona: 'general_individual_proprietor', tax_domain: 'income_tax' }), 'general × 所得税');

// ── 4. evaluateTopicFit ─────────────────────────────────────
console.log('\n=== Test 4: evaluateTopicFit ===');
const rej = evaluateTopicFit({ persona: 'beauty_salon_owner', pain_point: 'foreign-business-consumption-tax', tax_domain: 'consumption_tax', search_intent: '国外事業者からの仕入れの消費税を知りたい' });
assert(rej.decision === 'reject', '不自然な組合せは decision=reject');
assert(rej.customer_fit_score <= 2, '不自然な組合せは customer_fit_score<=2');
const ok = evaluateTopicFit({ customer_segment: 'beauty_salon', persona: 'beauty_salon_owner', pain_point: 'salon-prepayment-ticket', tax_domain: 'consumption_tax', allowed_customer_segments: ['beauty_salon'], search_intent: 'エステ 回数券 売上 計上 タイミング', source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm' });
assert(ok.decision === 'approve', '自然な組合せ（出典一致・具体的検索意図）は decision=approve');
assert(ok.customer_fit_score === 5, '許可カテゴリ一致は customer_fit_score=5');

// ── 5. 統合: expandAll に不自然な組合せが残らない ─────────────
console.log('\n=== Test 5: expandAll 統合 ===');
const all = expandAll();
const badPains = ['specified-services', 'foreign-business-consumption-tax', 'import-tax-refund-detail', 'customs-duty-treatment'];
const salonBad = all.filter(t => t.customer_segment === 'beauty_salon' && badPains.includes(t.pain_point));
assert(salonBad.length === 0, `beauty_salon × 海外/輸入系 が 0 件（実際: ${salonBad.length}）`);
const inhBad = all.filter(t => t.customer_segment === 'inheritance_gift' && ['consumption_tax', 'invoice_system', 'bookkeeping_expenses', 'withholding'].includes(t.tax_domain));
assert(inhBad.length === 0, `相続 × 事業者税目 が 0 件（実際: ${inhBad.length}）`);
const specified = all.filter(t => t.pain_point === 'specified-services');
const specifiedSegs = [...new Set(specified.map(t => t.customer_segment))];
assert(specifiedSegs.every(s => s === 'general_business'), `特定役務は general_business のみ（実際: ${specifiedSegs.join(',')}）`);
// 正当な組合せは残っている
const salonGood = all.filter(t => t.customer_segment === 'beauty_salon' && t.pain_point === 'salon-prepayment-ticket');
assert(salonGood.length > 0, 'beauty_salon × 回数券 は残っている');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
