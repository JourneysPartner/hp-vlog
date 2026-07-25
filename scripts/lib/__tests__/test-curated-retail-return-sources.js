'use strict';

/**
 * 値引き・返品・割戻し・商品券の論点を curated 化した恒久対策のテスト。
 *   node scripts/lib/__tests__/test-curated-retail-return-sources.js
 *
 * 背景: 2026-07-25 の retail_store × retail-point-discount が NEEDS_SOURCE_REVIEW で
 *   出典未確定（保留）となり、承認できなかった。売上値引き・返品・割戻しは
 *   No.6359（売上げに係る対価の返還等）、商品券は No.6229 が正本なので curated 化した。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const refs = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
const { checkSourceAlignment } = require(path.join(ROOT, 'scripts/lib/source-alignment'));
const { evaluateSourceGuard } = require(path.join(ROOT, 'scripts/lib/source-guard'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); passed++; }
  else      { console.error(`  FAIL ${label}`); failed++; }
}

const EXPECT = {
  'retail-point-discount': '6359',
  'retail-return-handling': '6359',
  'wholesale-return-rebate': '6359',
  'wholesale-apparel-return': '6359',
  'retail-gift-certificate': '6229',
};

console.log('\n=== Test: 値引き/返品/割戻し/商品券 の curated 出典 ===');
for (const [pain, no] of Object.entries(EXPECT)) {
  const src = refs.resolveSourceForTopic({ pain_point: pain, tax_domain: 'invoice_system' });
  assert(src.provenance === 'curated', `${pain}: provenance=curated`);
  assert(new RegExp(`shohi/${no}\\.htm$`).test(src.url), `${pain}: 出典 No.${no}`);
}

console.log('\n=== Test: NEEDS_SOURCE_REVIEW から除外・content系は残す ===');
assert(!refs.NEEDS_SOURCE_REVIEW.has('retail-point-discount'), 'retail-point-discount は保留対象から外れた');
assert(!refs.NEEDS_SOURCE_REVIEW.has('retail-gift-certificate'), 'retail-gift-certificate は保留対象から外れた');
assert(refs.NEEDS_SOURCE_REVIEW.has('content-digital-consumption-tax'), 'content-digital-consumption-tax は保留のまま（別途要出典）');

console.log('\n=== Test: 出典一致ゲート・承認ゲートを通る ===');
const topic = { pain_point: 'retail-point-discount', tax_domain: 'invoice_system',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6359.htm', source_provenance: 'curated' };
const sa = checkSourceAlignment(topic);
assert(sa.aligned && sa.score === 5 && sa.needs_source_review === false, 'alignment: curated+6359 は aligned score5');
const draft = { ...topic, source_guard_version: 1, review_status: 'draft' };
assert(evaluateSourceGuard(draft, { stage: 'approve' }).allowed === true, '承認ゲート: 通る（保留されない）');
// 誤出典（6501）に書き換えたら承認で弾く
const wrong = { ...draft, source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm' };
assert(evaluateSourceGuard(wrong, { stage: 'approve' }).blocked === true, '承認ゲート: 誤出典(6501)はブロック');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
