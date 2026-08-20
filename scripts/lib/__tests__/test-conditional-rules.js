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

// ── 4. 社会保険の被扶養者の収入判定ルール ─────────────────────────
// 2026-08-17: 記事に「経費がいくらあっても収入は200万円とカウントされ、
// 130万円の基準を超えてしまいます」と書かれていた。日本年金機構の原文には
// 「自営業者についての収入額は、当該事業遂行のための必要経費を控除した額と
// なります」と明記されており、誤りだった（ユーザー指摘で発覚）。
console.log('\n=== Test 4: 社会保険の被扶養者の収入判定 ===');
{
  const si = {
    pain_point: 'social-insurance-misconception',
    tax_domain: 'income_tax',
    customer_segment: 'influencer_creator',
    title: '税の扶養と社会保険の扶養は別物？',
    search_intent: '社会保険の扶養 130万円',
  };
  const rules = st.selectConditionalRules(si);
  const rule = rules.find(r => /被扶養者認定における「収入」/.test(r));
  assert(!!rule, '社会保険テーマ → ルールが注入される');
  assert(/当該事業遂行のための必要経費を控除した額/.test(rule || ''),
    '年金機構の原文（必要経費を控除した額）が含まれる');
  assert(/経費がいくらあっても総収入でカウントされる/.test(rule || ''),
    '誤った表現が禁止例として明示されている');
  assert(/社会保険では必要経費を差し引けない/.test(rule || ''),
    '「経費を差し引けない」も禁止例に含まれる');
  assert(/保険者/.test(rule || '') && /確認/.test(rule || ''),
    '最終判断は保険者であり確認を案内する指示がある');
  assert(/半分未満/.test(rule || ''), '「かつ被保険者の収入の半分未満」の条件が含まれる');
  assert(/国税庁の出典を根拠にしないこと/.test(rule || ''),
    '国税庁を根拠にしない指示がある（所管が厚労省・年金機構のため）');
  assert(/nenkin\.go\.jp/.test(rule || '') && /mhlw\.go\.jp/.test(rule || ''),
    '年金機構・厚労省の URL が根拠として示される');

  // 無関係なトピックには注入されない
  assert(!st.selectConditionalRules(ebay).some(r => /被扶養者認定における「収入」/.test(r)),
    'eBay記事 → 社会保険ルールは非注入');
  assert(!st.selectConditionalRules(inh).some(r => /被扶養者認定における「収入」/.test(r)),
    '相続記事 → 社会保険ルールは非注入');

  // builder 経由でも dynamicSystem に載る（キャッシュ側には載らない）
  const irSi = builder.buildGenerationPrompt({
    topic: { ...si, slug: 'si-x', category: '所得税', persona: 'influencer_creator', macro: '一般事業者' },
    persona: { label: 'インフルエンサー' }, cta: 'C',
    articleType: 'basic_explainer', articleRole: 'main', now: '2026-08-17T00:00:00Z',
  });
  assert(irSi.dynamicSystem.includes('当該事業遂行のための必要経費を控除した額'),
    '社会保険記事: dynamicSystem に注入される');
  assert(!irSi.staticSystem.includes('当該事業遂行のための必要経費を控除した額'),
    '社会保険記事: staticSystem（キャッシュ）には入らない');
}

// -- 5. 2割特例の終了と3割特例の創設（令和8年度税制改正）--------------
// 2026-08-18: 「2割特例が終わったあとは簡易課税への移行も選択肢」とだけ書いた
// 記事が生成された。個人事業者は令和9年分・令和10年分に3割特例が使える。
console.log('');
console.log('=== Test 5: 3割特例ルール ===');
{
  const inv = {
    tax_domain: 'invoice_system',
    pain_point: 'youtube-invoice',
    title: 'YouTuberはインボイス登録すべき？',
    customer_segment: 'youtuber',
    search_intent: 'インボイス 登録 判断',
  };
  const rules = st.selectConditionalRules(inv);
  const rule = rules.find(r => /3割特例（令和8年度税制改正で新設）/.test(r));
  assert(!!rule, 'インボイス記事 → 3割特例ルールが注入される');
  assert(/令和9年分・令和10年分/.test(rule || ''), '対象年分が令和9年分・令和10年分');
  assert(/法人は適用不可/.test(rule || ''), '法人は適用不可と明示');
  assert(/売上税額の3割/.test(rule || ''), '納付税額は売上税額の3割');
  assert(/いずれも1,000万円以下/.test(rule || ''), '基準期間と特定期間がいずれも1,000万円以下');
  assert(/事前の届出は不要/.test(rule || ''), '事前届出は不要と明示');
  assert(/令和8年9月30日までの日の属する課税期間/.test(rule || ''),
    '2割特例の期間は「日の属する課税期間」で書かせる');
  assert(/2割特例が終わったあとは簡易課税か本則課税のどちらかになる/.test(rule || ''),
    '旧スケジュールの言い回しが禁止例に入っている');
  assert(/invoice-review/.test(rule || ''), '国税庁の令和8年度税制改正特集が根拠として示される');

  // 経過措置ルール側に 1億円 の見直しが入っていること
  const rt = rules.find(r => /免税事業者からの仕入経過措置/.test(r));
  assert(!!rt, '経過措置ルールも同時に注入される');
  assert(/1億円/.test(rt || '') && /改正前10億円/.test(rt || ''),
    '7・5・3割控除の1億円上限（改正前10億円）が入っている');

  // 無関係なトピックには注入されない
  assert(!st.selectConditionalRules(inh).some(r => /3割特例（令和8年度税制改正で新設）/.test(r)),
    '相続記事 → 3割特例ルールは非注入');
  const si = { pain_point: 'social-insurance-misconception', tax_domain: 'income_tax', title: '扶養' };
  assert(!st.selectConditionalRules(si).some(r => /3割特例（令和8年度税制改正で新設）/.test(r)),
    '社会保険記事 → 3割特例ルールは非注入');

  // builder 経由では dynamicSystem 側（キャッシュ対象外）
  const irInv = builder.buildGenerationPrompt({
    topic: { ...inv, slug: 'inv-x', category: '消費税', persona: 'youtuber', macro: 'インフルエンサー' },
    persona: { label: 'YouTuber' }, cta: 'C',
    articleType: 'basic_explainer', articleRole: 'main', now: '2026-08-18T00:00:00Z',
  });
  assert(irInv.dynamicSystem.includes('令和9年分・令和10年分'),
    'インボイス記事: dynamicSystem に注入される');
  assert(!irInv.staticSystem.includes('令和9年分・令和10年分'),
    'インボイス記事: staticSystem（キャッシュ）には入らない');
}

// -- 6. 少額減価償却資産の特例ルール ---------------------------------
console.log('');
console.log('=== Test 6: 少額減価償却資産の特例ルール ===');
{
  const game = {
    tax_domain: 'bookkeeping_expenses',
    pain_point: 'youtube-gaming-hardware',
    title: 'ゲーム実況のゲーム機・PC・ソフト代は経費になる？減価償却の仕訳を具体例で解説',
    search_intent: 'ゲーム実況 ゲーム機 PC ソフト代 経費 減価償却',
    customer_segment: 'youtuber',
  };
  const rules = st.selectConditionalRules(game);
  const rule = rules.find(r => /少額減価償却資産の特例（令和8年度税制改正/.test(r));
  assert(!!rule, '減価償却記事 → ルールが注入される');
  assert(/令和8年3月31日までに取得したものが対象/.test(rule || ''),
    '古い記載が禁止例として明示されている');
  assert(/令和8年4月1日以後に取得等/.test(rule || '') && /40万円未満/.test(rule || ''),
    '改正後の基準が示される');
  assert(/取得等をする日/.test(rule || ''), '取得等の日で判定する旨');
  assert(/3年延長/.test(rule || ''), '適用期限3年延長');
  assert(/300万円/.test(rule || ''), '年間上限300万円');
  assert(/青色申告/.test(rule || ''), '青色申告が要件である旨');
  assert(/一括償却資産/.test(rule || ''), '変わらない部分（一括償却資産）も示す');
  assert(/令和7年4月1日現在法令等/.test(rule || ''), 'タックスアンサー未反映の注意');

  assert(!st.selectConditionalRules(inh).some(r => /少額減価償却資産の特例（令和8年度/.test(r)),
    '相続記事 → 非注入');
  assert(!st.selectConditionalRules(ebay).some(r => /少額減価償却資産の特例（令和8年度/.test(r)),
    'eBay記事 → 非注入');
}

// -- 7. 扶養に入れる所得ライン（令和8年度税制改正）----------------------
console.log('');
console.log('=== Test 7: 扶養の所得ラインのルール ===');
{
  const fuyou = { title: '扶養から外れる？社会保険と税の違い', tax_domain: 'income_tax',
    pain_point: 'social-insurance-misconception', search_intent: '扶養 130万円 配偶者控除' };
  const rule = st.selectConditionalRules(fuyou).find(r => /扶養に入れる所得ライン/.test(r));
  assert(!!rule, '扶養の記事 → ルールが注入される');
  assert(/令和8年分以後　<strong>62万円以下<\/strong>/.test(rule || '')
    || /令和8年分以後/.test(rule || '') && /62万円以下/.test(rule || ''),
    '令和8年分以後は62万円以下');
  assert(/令和7年分　　　<strong>58万円以下/.test(rule || '') || /令和7年分/.test(rule || ''),
    '令和7年分は58万円以下（年分ごとに書き分けさせる）');
  assert(/令和7年分以後は58万円/.test(rule || ''), '古い言い方が禁止例に入っている');
  assert(/69万円/.test(rule || ''), '給与所得控除の最低保障額の変更も示す');
  assert(/推測で書かないこと/.test(rule || ''), '配偶者特別控除は推測で書かない');
  assert(/社会保険の被扶養者（130万円）はこの改正と無関係/.test(rule || ''),
    '社会保険と混同しない注意がある');

  assert(!st.selectConditionalRules(ebay).some(r => /扶養に入れる所得ライン/.test(r)),
    'eBay記事 → 非注入');
  assert(!st.selectConditionalRules(inh).some(r => /扶養に入れる所得ライン/.test(r)),
    '相続記事 → 非注入');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
