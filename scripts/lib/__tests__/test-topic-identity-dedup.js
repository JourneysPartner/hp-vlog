'use strict';

/**
 * 意味的重複ゲート（customer_segment × pain_point）と
 * expandTaxDomain の subcluster/slug 二重化修正のテスト。
 *   node scripts/lib/__tests__/test-topic-identity-dedup.js
 *
 * 背景: 2026-07-15 に「国内EC物販セラー × 消費税課税事業者判定」の下書き(#292/#293)が、
 *   既に7本公開済みの ec_seller × consumption-tax-judgement と実質重複したまま生成された。
 *   原因は (1) subcluster/slug の二重化 `consumption-tax-judgement-consumption-tax-judgement`
 *   により subcluster cooldown をすり抜け、(2) 選定時は title 空で類似度が 0.55 未満に沈み素通り、
 *   (3) 「segment×pain」という意味的同一性で止める仕組みが無かったこと。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  checkTopicIdentity, filterByTopicIdentity, IDENTITY_COOLDOWN_DAYS,
} = require(path.join(ROOT, 'scripts/lib/cooldown'));
const { expandTaxDomain, expandAll } = require(path.join(ROOT, 'scripts/lib/scenario-expansion'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// 固定の "現在時刻" と、既存コーパスの模擬（segment は persona から導出される）
const NOW = new Date('2026-07-15T00:00:00+09:00');
const corpus = [
  // ec_seller（domestic_ec_seller）× consumption-tax-judgement を 27 日前に公開
  {
    slug: 'tax-bookkeeping-expenses-bookkeeping-consumption-tax-judgement-guide',
    primary_persona: 'domestic_ec_seller',
    pain_point: 'consumption-tax-judgement',
    published_at: '2026-06-18T11:30:00+09:00',
  },
  // 別 segment（beauty_salon）× 同 pain は無関係
  {
    slug: 'beauty-salon-withholding-treatment-guide',
    primary_persona: 'beauty_salon_owner',
    pain_point: 'withholding-treatment',
    published_at: '2026-07-10T11:30:00+09:00',
  },
];

console.log('\n=== Test: checkTopicIdentity（segment × pain の既出判定）===');

// 今日の下書き（本命）を再現。subcluster/slug/title が違っても止まるべき。
const todayMain = {
  slug: 'tax-bookkeeping-expenses-consumption-tax-judgement-consumption-tax-judgement-guide',
  title: '', // 選定時は空
  persona: 'domestic_ec_seller',
  pain_point: 'consumption-tax-judgement',
  subcluster: 'consumption-tax-judgement-consumption-tax-judgement',
};
const hit = checkTopicIdentity(todayMain, corpus, NOW);
assert(hit && hit.level === 'identity', '既出 segment×pain（ec_seller×consumption-tax-judgement）はブロックされる');
assert(hit && hit.post === 'tax-bookkeeping-expenses-bookkeeping-consumption-tax-judgement-guide', '既出記事の slug を理由に含む');

// 別 tax_domain 由来（income_tax 軸）でも segment×pain が同じなら止まる
const todayVariant = {
  slug: 'tax-income-tax-final-return-consumption-tax-judgement-guide',
  persona: 'domestic_ec_seller',
  pain_point: 'consumption-tax-judgement',
};
assert(checkTopicIdentity(todayVariant, corpus, NOW), '税目軸を変えただけの焼き直し（同 segment×pain）も止まる');

// segment が違えば通す
const otherSeg = { persona: 'beauty_salon_owner', pain_point: 'consumption-tax-judgement' };
assert(!checkTopicIdentity(otherSeg, corpus, NOW), 'segment が違えば通す（beauty_salon×consumption-tax-judgement）');

// pain が違えば通す
const otherPain = { persona: 'domestic_ec_seller', pain_point: 'platform-fee-treatment' };
assert(!checkTopicIdentity(otherPain, corpus, NOW), 'pain が違えば通す（ec_seller×platform-fee-treatment）');

// pain_point / segment が無い候補は対象外（既存挙動を壊さない）
assert(!checkTopicIdentity({ persona: 'domestic_ec_seller' }, corpus, NOW), 'pain_point 無しは対象外');
assert(!checkTopicIdentity({ pain_point: 'consumption-tax-judgement' }, corpus, NOW), 'segment 導出不可（persona 無し）は対象外');

// window を超えた既出は通す
const oldCorpus = [{ ...corpus[0], published_at: '2025-01-01T00:00:00+09:00' }];
assert(!checkTopicIdentity(todayMain, oldCorpus, NOW), `${IDENTITY_COOLDOWN_DAYS}日より前の既出は通す`);

console.log('\n=== Test: filterByTopicIdentity ===');
const { passed: pass, blocked } = filterByTopicIdentity([todayMain, otherPain], corpus, NOW);
assert(blocked.length === 1 && pass.length === 1, '既出だけを除外し、新規テーマは残す');

console.log('\n=== Test: expandTaxDomain の subcluster/slug 二重化が解消 ===');
const taxTopics = expandTaxDomain();
const doubledSub = taxTopics.filter(t => /(^|-)consumption-tax-judgement-consumption-tax-judgement(-|$)/.test(t.subcluster || ''));
assert(doubledSub.length === 0, 'subcluster に consumption-tax-judgement の二重化が無い');
const doubledSlug = taxTopics.filter(t => /consumption-tax-judgement-consumption-tax-judgement/.test(t.slug || ''));
assert(doubledSlug.length === 0, 'slug に consumption-tax-judgement の二重化が無い');
// procedure===pain の対角は生成されない（= consumption-tax-judgement proc × 同 pain）
const diagonal = taxTopics.filter(t => t.procedure_stage === 'consumption-tax-judgement' && t.pain_point === 'consumption-tax-judgement');
assert(diagonal.length === 0, 'procedure===pain の退化トピックを生成しない');

console.log('\n=== Test: expandAll 全体でも二重化 slug が無い ===');
const all = expandAll();
const anyDoubled = all.filter(t => /([a-z-]+?)-\1(-|$)/.test((t.slug || '').replace(/-(guide|practice)$/,'')));
// 参考情報（厳密判定はしない。consumption 系のみ厳密チェック）
const anyConsumptionDoubled = all.filter(t => /consumption-tax-judgement-consumption-tax-judgement/.test(t.slug || ''));
assert(anyConsumptionDoubled.length === 0, 'expandAll 出力に consumption 二重化 slug が無い');
console.log(`  （参考）隣接重複っぽい slug: ${anyDoubled.length} 件`);

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
