'use strict';

/**
 * 論点別・条件付きルールの注入テスト（Phase 2）。
 *   node scripts/lib/__tests__/test-conditional-rules.js
 *
 * 旧来 STATIC_RULES に全記事共通で入っていた「よくある法的論点の誤記」
 * （特定期間 / 所得税速算表 / インボイス経過措置 / 国外プラットフォーム手数料）
 * を、該当する記事にだけ dynamicSystem へ注入することを検証する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const st = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));
const builder = require(path.join(ROOT, 'scripts/lib/article-prompt-builder'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. STATIC_RULES から論点別ルールが外れている ────────────────
console.log('\n=== Test 1: STATIC_RULES は共通ルールのみ ===');
assert(!st.STATIC_RULES.includes('T1700150104215'), 'STATIC_RULES に eBay登録番号を含まない');
assert(!st.STATIC_RULES.includes('特定期間'), 'STATIC_RULES に特定期間ルールを含まない');
assert(!st.STATIC_RULES.includes('リバースチャージ'), 'STATIC_RULES にリバースチャージを含まない');
// 共通ルールは残っている
for (const kw of ['最上位ルール', 'SEO', '文体', '禁止事項', '出典', '免責']) {
  assert(st.STATIC_RULES.includes(kw), `STATIC_RULES に共通「${kw}」は残る`);
}

// ── 2. selectConditionalRules の該当判定 ────────────────────────
console.log('\n=== Test 2: 論点別ルールの該当判定 ===');
const ebay = { pain_point: 'platform-fee-treatment', cluster: 'ebay', tax_domain: 'consumption_tax', search_intent: 'eBay手数料の消費税' };
const ebayRules = st.selectConditionalRules(ebay);
assert(ebayRules.some(r => r.includes('T1700150104215')), 'eBay手数料記事 → 国外プラットフォーム手数料ルール注入');

const salon = { pain_point: 'salon-prepayment-ticket', tax_domain: 'consumption_tax', search_intent: 'エステ 回数券 売上 計上' };
assert(st.selectConditionalRules(salon).length === 0, 'サロン回数券記事 → 論点別ルールなし（漏れ込み無し）');

const inheritance = { pain_point: 'inheritance-tax-return', tax_domain: 'inheritance_tax', search_intent: '相続税 申告 必要か' };
// 相続記事には事業者向けルール（eBay/特定期間/経過措置/速算表）は注入されない
// （相続専用の構成ルールは注入されてよい）。
assert(!st.selectConditionalRules(inheritance).some(r => /T1700150104215|特定期間|経過措置|速算表/.test(r)),
  '相続記事 → 事業者向けルールは注入されない');

const invoice = { pain_point: 'invoice-judgement', tax_domain: 'invoice_system', search_intent: 'インボイス 登録 すべきか' };
const invRules = st.selectConditionalRules(invoice);
assert(invRules.some(r => r.includes('経過措置')), 'インボイス記事 → 経過措置ルール注入');
// 令和8年度税制改正の新スケジュール（80→70→50→30→0）を注入し、旧スケジュールを使わない
assert(invRules.some(r => /2026年10月1日〜2028年9月30日:\s*<strong>70%控除/.test(r)), '経過措置ルール: 2026.10〜2028.9=70%（改正後）を明記');
assert(invRules.some(r => r.includes('2031年10月1日以降: 控除不可')), '経過措置ルール: 2031.10以降=0%（延長後の終了）を明記');
assert(!invRules.some(r => /2026年10月1日〜2029年9月30日:\s*仕入税額相当額の50%/.test(r)), '経過措置ルール: 旧「2026.10〜2029.9=50%」を含まない');

const houjinnari = { pain_point: 'incorporation-threshold', tax_domain: 'income_tax', search_intent: '法人成り 所得税率 逆転' };
const hnRules = st.selectConditionalRules(houjinnari);
assert(hnRules.some(r => r.includes('特定期間')), '法人成り記事 → 特定期間ルール注入');
assert(hnRules.some(r => r.includes('速算表')), '法人成り記事 → 所得税速算表ルール注入');

// 相続贈与記事 → 相続構成ルール（仕訳例を作らない）注入。事業者記事には非注入
const inh = { pain_point: 'tax-applicable-or-not', tax_domain: 'inheritance_tax', customer_segment: 'inheritance_gift', search_intent: '相続税 申告 必要か' };
assert(st.selectConditionalRules(inh).some(r => r.includes('「仕訳例」は作らない')), '相続記事 → 相続構成ルール注入');
assert(!st.selectConditionalRules(ebay).some(r => r.includes('「仕訳例」は作らない')), 'eBay記事 → 相続構成ルールは非注入');
assert(st.STATIC_RULES.includes('記事構成テンプレート'), 'STATIC_RULES に記事構成テンプレート');
assert(st.STATIC_RULES.includes('読者の検索語起点'), 'STATIC_RULES にタイトル検索語起点ルール');

// 源泉徴収（204条）の対象範囲ルール: 外注費/源泉の記事に注入。無関係には非注入
const outsource = { pain_point: 'youtube-editing-outsource', tax_domain: 'withholding', title: '動画編集を外注したときの仕訳と源泉徴収はどうする？' };
const wsRules = st.selectConditionalRules(outsource);
assert(wsRules.some(r => r.includes('源泉徴収（所得税法204条）の対象範囲')), '外注費・源泉記事 → 源泉スコープルール注入');
assert(wsRules.some(r => r.includes('列挙された報酬・料金に限られる')), '源泉ルール: 204条は列挙報酬に限る旨を含む');
assert(wsRules.some(r => /動画編集・映像制作[\s\S]*源泉徴収は不要/.test(r)), '源泉ルール: 動画編集の外注費は原則不要を明記');
assert(wsRules.some(r => r.includes('支払者が法人だから源泉徴収が必要')), '源泉ルール: 「法人だから要」を誤りとして警告');
assert(!st.selectConditionalRules(inh).some(r => r.includes('源泉徴収（所得税法204条）の対象範囲')), '相続記事 → 源泉スコープルールは非注入');

// ── 3. builder が dynamicSystem にだけ注入する ──────────────────
console.log('\n=== Test 3: builder の注入先は dynamicSystem（非キャッシュ）===');
const persona = { label: 'eBay輸出セラー' };
const irEbay = builder.buildGenerationPrompt({
  topic: { ...ebay, slug: 'ebay-x', category: '消費税', persona: 'ebay_export_seller', macro: '物販' },
  persona, cta: 'C', articleType: 'basic_explainer', articleRole: 'main', now: '2026-07-04T00:00:00Z',
});
assert(irEbay.dynamicSystem.includes('T1700150104215'), 'eBay記事: dynamicSystem に注入される');
assert(!irEbay.staticSystem.includes('T1700150104215'), 'eBay記事: staticSystem（キャッシュ）には入らない');

const irSalon = builder.buildGenerationPrompt({
  topic: { ...salon, slug: 'salon-x', category: '消費税', persona: 'beauty_salon_owner', macro: 'サロン' },
  persona: { label: '美容サロンオーナー' }, cta: 'C', articleType: 'basic_explainer', articleRole: 'main', now: '2026-07-04T00:00:00Z',
});
assert(!irSalon.dynamicSystem.includes('T1700150104215'), 'サロン記事: eBayルールが注入されない');
assert(!irSalon.dynamicSystem.includes('リバースチャージ'), 'サロン記事: リバースチャージが注入されない');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
