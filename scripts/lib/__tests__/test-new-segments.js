'use strict';

/**
 * 新カテゴリ（YouTuber / コンテンツ販売 / 1人親方 / 小売 / 卸売）の
 * 関連性ゲート・reject/approve マトリクスのテスト（Phase 4a）。
 *   node scripts/lib/__tests__/test-new-segments.js
 *
 * 実際のトピック生成は Phase 4b。ここでは taxonomy と関連性ルールを検証する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  CUSTOMER_SEGMENTS, deriveSegment, isNaturalCombination,
} = require(path.join(ROOT, 'scripts/lib/customer-relevance'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// t(): customer_segment を明示したトピックを作る
const t = (customer_segment, pain_point, extra = {}) => ({ customer_segment, pain_point, ...extra });

// ── 1. 新カテゴリが登録されている ───────────────────────────
console.log('\n=== Test 1: 新カテゴリの登録 ===');
for (const seg of ['youtuber', 'content_seller', 'construction_solo', 'retail_store', 'wholesale']) {
  assert(!!CUSTOMER_SEGMENTS[seg], `${seg} が CUSTOMER_SEGMENTS に登録`);
}
assert(deriveSegment({ persona: 'youtuber' }).customer_segment === 'youtuber', 'persona youtuber → segment');
assert(deriveSegment({ macro: '建設' }).customer_segment === 'construction_solo', 'macro 建設 → construction_solo');

// ── 2. reject されるべき（業種違い・カテゴリ違い）───────────────
console.log('\n=== Test 2: reject されるべき ===');
const rejectCases = [
  ['youtuber × 回数券(サロン)',           t('youtuber', 'salon-prepayment-ticket')],
  ['construction_solo × YouTube会員',      t('construction_solo', 'youtube-membership')],
  ['construction_solo × AdSense収益',      t('construction_solo', 'youtube-adsense-revenue')],
  ['retail_store × YouTube会員',           t('retail_store', 'youtube-membership')],
  ['wholesale × スーパーチャット',          t('wholesale', 'youtube-superchat')],
  ['creator × 卸売売掛金',                  t('creator', 'wholesale-accounts-receivable')],
  ['content_seller × 建設人工代',           t('content_seller', 'construction-labor-cost')],
  ['retail_store × 海外アーティスト',        t('retail_store', 'specified-services', { tax_domain: 'consumption_tax', allowed_customer_segments: ['general_business'] })],
  ['youtuber × 相続税',                     t('youtuber', 'tax-applicable-or-not', { tax_domain: 'inheritance_tax' })],
  ['inheritance_gift × インボイス',          t('inheritance_gift', 'invoice-judgement', { tax_domain: 'invoice_system' })],
  ['inheritance_gift × EC在庫',              t('inheritance_gift', 'ec-inventory-fba-fbm', { tax_domain: 'consumption_tax' })],
];
for (const [label, topic] of rejectCases) {
  assert(!isNaturalCombination(topic), label);
}

// ── 3. approve されるべき（その業種の実務）──────────────────────
console.log('\n=== Test 3: approve されるべき ===');
const approveCases = [
  ['youtuber × AdSense収益',        t('youtuber', 'youtube-adsense-revenue')],
  ['youtuber × 機材費',              t('youtuber', 'youtube-equipment-expense')],
  ['youtuber × スーパーチャット',     t('youtuber', 'youtube-superchat')],
  ['content_seller × note収益',      t('content_seller', 'content-note-revenue')],
  ['content_seller × オンライン講座', t('content_seller', 'content-online-course')],
  ['construction_solo × 人工代',      t('construction_solo', 'construction-labor-cost')],
  ['construction_solo × 材料費',      t('construction_solo', 'construction-material-cost')],
  ['retail_store × レジ売上',         t('retail_store', 'retail-register-sales')],
  ['retail_store × 軽減税率',         t('retail_store', 'retail-reduced-tax-rate')],
  ['wholesale × 売掛金',              t('wholesale', 'wholesale-accounts-receivable')],
  ['wholesale × 在庫評価',            t('wholesale', 'wholesale-inventory-valuation')],
  // 汎用論点（インボイス等）は新カテゴリでも自然
  ['construction_solo × インボイス',  t('construction_solo', 'invoice-judgement', { tax_domain: 'invoice_system' })],
  ['content_seller × プラットフォーム手数料', t('content_seller', 'platform-fee-treatment', { tax_domain: 'consumption_tax' })],
];
for (const [label, topic] of approveCases) {
  assert(isNaturalCombination(topic), label);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
