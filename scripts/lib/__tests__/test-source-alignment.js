'use strict';

/**
 * 出典一致ゲートのテスト（Phase 3）。
 *   node scripts/lib/__tests__/test-source-alignment.js
 *
 * 「税目が近いだけ」の出典を主出典にした記事を検出する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { checkSourceAlignment, sourceFamily } = require(path.join(ROOT, 'scripts/lib/source-alignment'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const U = {
  sozoku4152: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm', // 相続税の計算(基礎控除)
  sozoku4124: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm', // 小規模宅地
  sozoku4205: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4205.htm', // 相続税の申告と納税
  zoyo4408:   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',   // 贈与税の計算
  zoyo4508:   'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4508.htm',   // 住宅取得資金贈与
  shohi6501:  'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',  // 納税義務の免除
  cross:      'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm',      // 国境を越えた役務
  invoice:    'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
};

// ── 1. sourceFamily ─────────────────────────────────────────
console.log('\n=== Test 1: sourceFamily ===');
assert(sourceFamily(U.sozoku4152) === 'sozoku', 'sozoku 判定');
assert(sourceFamily(U.zoyo4408) === 'zoyo', 'zoyo 判定');
assert(sourceFamily(U.cross) === 'shohi', 'cross(国境を越えた役務)=shohi 判定');
assert(sourceFamily(U.invoice) === 'shohi', 'invoice特設=shohi 判定');

// ── 2. reject（税目カテゴリ不一致 = hard）───────────────────────
console.log('\n=== Test 2: 税目カテゴリ不一致（hard）===');
// 相続税申告要否の記事に贈与税ページ
let r = checkSourceAlignment({ pain_point: 'tax-applicable-or-not', tax_domain: 'inheritance_tax', source_url: U.zoyo4408 });
assert(r.severity === 'hard' && !r.aligned, '相続税申告要否 × 贈与税ページ → hard 不一致');
// 住宅取得資金贈与の記事に相続税申告期限ページ
r = checkSourceAlignment({ pain_point: 'housing-fund-gift', tax_domain: 'inheritance_tax', source_url: U.sozoku4205 });
assert(r.severity === 'hard' && !r.aligned, '住宅取得資金贈与 × 相続申告期限ページ → hard 不一致');
// リバースチャージ記事に相続税ページ
r = checkSourceAlignment({ pain_point: 'foreign-business-consumption-tax', tax_domain: 'consumption_tax', source_url: U.sozoku4152 });
assert(r.severity === 'hard' && !r.aligned, 'リバースチャージ × 相続税ページ → hard 不一致');
// インボイス記事に相続税ページ
r = checkSourceAlignment({ pain_point: 'invoice-judgement', tax_domain: 'invoice_system', source_url: U.sozoku4152 });
assert(r.severity === 'hard' && !r.aligned, 'インボイス × 相続税ページ → hard 不一致');

// ── 3. 同カテゴリだが主論点と別ページ（soft）───────────────────
console.log('\n=== Test 3: 同カテゴリ・別ページ（soft）===');
// 小規模宅地の記事に基礎控除ページ（どちらも sozoku）
r = checkSourceAlignment({ pain_point: 'small-residential-land', tax_domain: 'inheritance_tax', source_url: U.sozoku4152 });
assert(r.severity === 'soft' && !r.aligned, '小規模宅地 × 基礎控除ページ → soft 不一致');
// リバースチャージ記事に納税義務免除ページ（どちらも shohi）
r = checkSourceAlignment({ pain_point: 'foreign-business-consumption-tax', tax_domain: 'consumption_tax', source_url: U.shohi6501 });
assert(r.severity === 'soft' && !r.aligned, 'リバースチャージ × 納税義務免除ページ → soft 不一致');
// インボイス記事に消費税一般（納税義務免除）ページ
r = checkSourceAlignment({ pain_point: 'invoice-judgement', tax_domain: 'invoice_system', source_url: U.shohi6501 });
assert(r.severity === 'soft' && !r.aligned, 'インボイス × 消費税一般ページ → soft 不一致');

// ── 4. approve（一致）────────────────────────────────────────
console.log('\n=== Test 4: 一致 ===');
r = checkSourceAlignment({ pain_point: 'small-residential-land', tax_domain: 'inheritance_tax', source_url: U.sozoku4124 });
assert(r.aligned && r.score === 5, '小規模宅地 × 小規模宅地ページ → 一致');
r = checkSourceAlignment({ pain_point: 'housing-fund-gift', tax_domain: 'inheritance_tax', source_url: U.zoyo4508 });
assert(r.aligned && r.score === 5, '住宅取得資金贈与 × 住宅取得資金贈与ページ → 一致');
r = checkSourceAlignment({ pain_point: 'foreign-business-consumption-tax', tax_domain: 'consumption_tax', source_url: U.cross });
assert(r.aligned && r.score === 5, 'リバースチャージ × 国境を越えた役務ページ → 一致');

// ── 5. 出典未設定 ────────────────────────────────────────────
console.log('\n=== Test 5: 出典未設定 ===');
r = checkSourceAlignment({ pain_point: 'small-residential-land', tax_domain: 'inheritance_tax', source_url: '' });
assert(!r.aligned && r.severity === 'soft', '出典未設定 → soft');

// ── 6. evaluateTopicFit への反映 ────────────────────────────
console.log('\n=== Test 6: evaluateTopicFit の source_alignment_score ===');
const { evaluateTopicFit } = require(path.join(ROOT, 'scripts/lib/customer-relevance'));
const good = evaluateTopicFit({ persona: 'inheritance_client', pain_point: 'small-residential-land', tax_domain: 'inheritance_tax', source_url: U.sozoku4124, search_intent: '小規模宅地 特例 要件' });
assert(good.source_alignment_score === 5, '一致記事は source_alignment_score=5');
const bad = evaluateTopicFit({ persona: 'inheritance_client', pain_point: 'tax-applicable-or-not', tax_domain: 'inheritance_tax', source_url: U.zoyo4408, search_intent: '相続税 申告 必要か' });
assert(bad.source_alignment_score === 1, 'カテゴリ不一致は source_alignment_score=1');
assert(bad.decision === 'reject', 'カテゴリ不一致（hard）は decision=reject');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
