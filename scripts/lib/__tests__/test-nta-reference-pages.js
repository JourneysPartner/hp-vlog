'use strict';

/**
 * タックスアンサー未収録の国税庁資料（参考資料）のテスト。
 *   node scripts/lib/__tests__/test-nta-reference-pages.js
 *
 * 2026-08-18: 令和8年度税制改正で新設された「3割特例」は国税庁の
 * 「令和8年度 税制改正特集」で公表されているがタックスアンサーには
 * 未収録で、生成プロンプトから存在が見えなかった。
 * タックスアンサーと同等に参照させつつ、主出典（source_url）には
 * 採用させない、という扱いを検証する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const ref = require(path.join(ROOT, 'scripts/lib/nta-reference-pages'));
const { isDeniedSource, resolveSourceForTopic } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
const { isOfficialDomain } = require(path.join(ROOT, 'scripts/lib/official-sources'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const INVOICE = {
  tax_domain: 'invoice_system',
  pain_point: 'invoice-registration',
  title: 'YouTuberはインボイス登録すべき？',
  search_intent: 'インボイス 登録 判断',
};
const REF_URL = 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm';
const TAXANSWER = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm';

// ── 1. 該当トピックで参考資料が見つかる ────────────────────────
console.log('\n=== Test 1: トピック判定 ===');
{
  const pages = ref.findReferencePages(INVOICE);
  assert(pages.length === 1, `インボイス記事 → 1件（実: ${pages.length}）`);
  assert(pages[0].url === REF_URL, 'URL が令和8年度税制改正特集');
  assert(pages[0].verified_at === '2026-08-18', '原文確認日が記録されている');

  // 無関係なトピックには出さない
  assert(ref.findReferencePages({ pain_point: 'social-insurance-misconception', title: '扶養' }).length === 0,
    '社会保険記事 → 該当なし');
  assert(ref.findReferencePages({ tax_domain: 'inheritance_tax', title: '相続税の申告' }).length === 0,
    '相続記事 → 該当なし');
  assert(ref.findReferencePages({}).length === 0, '空トピック → 該当なし');
}

// ── 2. プロンプトブロックの中身 ────────────────────────────────
console.log('\n=== Test 2: プロンプトブロック ===');
{
  const block = ref.buildReferencePagesBlock(INVOICE);
  assert(block.length > 0, 'ブロックが組まれる');
  assert(/タックスアンサーと同等に参照してよい/.test(block), '「タックスアンサーと同等」と明示');
  assert(/令和9年分・令和10年分/.test(block), '3割特例の対象年分');
  assert(/法人は適用不可/.test(block), '法人は適用不可');
  assert(/売上げの消費税額×70%/.test(block), '計算式');
  assert(/いずれも1,000万円以下/.test(block), '基準期間・特定期間の要件');
  assert(/事前の届出等は不要/.test(block), '事前届出不要');
  assert(/令和8年9月30日までの日の属する課税期間/.test(block), '2割特例の期間の書き方');
  assert(/1億円（改正前10億円）/.test(block), '7・5・3割控除の1億円上限');
  assert(/主出典（frontmatter の source_url）にはしない/.test(block), '主出典にしない指示');
  assert(/タックスアンサー番号を割り当てない/.test(block), '番号を割り当てない指示');
  assert(/書かれていないこと/.test(block), '記載外を書かない指示');
  assert(ref.buildReferencePagesBlock({}) === '', '該当なしなら空文字');
}

// ── 3. 主出典には絶対に採用されない ────────────────────────────
console.log('\n=== Test 3: 主出典には採用しない ===');
{
  assert(ref.isReferenceOnlyUrl(REF_URL), '参考資料URLとして登録されている');
  assert(!ref.isReferenceOnlyUrl(TAXANSWER), 'タックスアンサーは参考資料扱いではない');
  assert(!ref.isReferenceOnlyUrl(''), '空文字は false');
  assert(!ref.isReferenceOnlyUrl(null), 'null は false');

  // tax-authority-refs 側の出典選定で弾かれる
  assert(isDeniedSource(REF_URL), '出典としては拒否される');
  assert(!isDeniedSource(TAXANSWER), '通常のタックスアンサーは拒否されない');

  // explicit 指定でも採用されない
  const r = resolveSourceForTopic({ ...INVOICE, source_provenance: 'explicit', source_url: REF_URL });
  assert(r.url !== REF_URL, `explicit 指定でも採用されない（実: ${r.url}）`);
  assert(/taxanswer/.test(r.url), '代わりにタックスアンサーが選ばれる');

  // 既存の禁止出典（インボイス制度の概要）も引き続き拒否される
  assert(isDeniedSource('https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm'),
    '既存の禁止出典も引き続き拒否');
}

// ── 4. 登録できるのは国税庁ドメインのみ ────────────────────────
console.log('\n=== Test 4: ドメイン ===');
{
  for (const [key, page] of Object.entries(ref.NTA_REFERENCE_PAGES)) {
    assert(/^https:\/\/www\.nta\.go\.jp\//.test(page.url), `${key}: nta.go.jp の https URL`);
    assert(isOfficialDomain(page.url), `${key}: 公的ドメインとして認められる`);
    assert(Array.isArray(page.notes) && page.notes.length > 0, `${key}: notes がある`);
    assert(typeof page.match === 'function', `${key}: match がある`);
  }
}

// ── 5. match が例外を投げても落ちない ──────────────────────────
console.log('\n=== Test 5: 壊れた入力 ===');
{
  assert(ref.findReferencePages(undefined).length === 0, 'undefined でも落ちない');
  assert(ref.buildReferencePagesBlock(undefined) === '', 'undefined でも空文字');
}

// -- 6. 少額減価償却資産の特例（令和8年度税制改正）--------------------
// 2026-08-18: タックスアンサー No.2100 / No.5408 が「令和7年4月1日現在法令等」の
// ままで、出典どおりに書くと「令和8年3月31日まで・30万円未満」という失効済みの
// 内容になった。参考資料として補う。
console.log('');
console.log('=== Test 6: 少額減価償却資産の特例 ===');
{
  const GAME = {
    tax_domain: 'bookkeeping_expenses',
    pain_point: 'youtube-gaming-hardware',
    title: 'ゲーム実況のゲーム機・PC・ソフト代は経費になる？減価償却の仕訳を具体例で解説',
    search_intent: 'ゲーム実況 ゲーム機 PC ソフト代 経費 減価償却',
  };
  const pages = ref.findReferencePages(GAME);
  assert(pages.length === 1, `減価償却記事 → 1件（実: ${pages.length}）`);
  assert(pages[0].key === 'small_depreciable_assets_2026', 'キーが少額減価償却資産の特例');

  const block = ref.buildReferencePagesBlock(GAME);
  assert(/40万円未満/.test(block), '40万円未満に引き上げ');
  assert(/令和8年4月1日以後に取得等/.test(block), '取得等の日で判定する境界');
  assert(/3年延長/.test(block), '適用期限3年延長');
  assert(/引き続き年300万円が上限/.test(block), '年300万円の上限は据え置き');
  assert(/所得税についても同様とする/.test(block), '個人事業者にも適用される旨');
  assert(/令和7年4月1日現在法令等/.test(block), 'タックスアンサーが未反映である注意書き');
  assert(/500人超/.test(block) && /400人超/.test(block), '対象法人の従業員数要件の変更');

  // インボイスの記事には減価償却の資料を出さない（相互に混ざらない）
  const inv = ref.findReferencePages({ tax_domain: 'invoice_system', title: 'インボイス登録すべき？' });
  assert(inv.length === 1 && inv[0].key === 'invoice_tax_reform_2026',
    'インボイス記事には invoice のエントリだけ');
  assert(ref.findReferencePages({ tax_domain: 'income_tax', pain_point: 'social-insurance-misconception', title: '扶養' }).length === 0,
    '社会保険記事には出さない');

  // 主出典には採用されない
  const { isDeniedSource } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
  assert(isDeniedSource(pages[0].url), '出典としては拒否される');
}

// -- 7. 法令解釈通達の登録 --------------------------------------------
// 2026-08-20〜21 に通達の誤りが2日続いた。
//   所基通37-14 を「按分が必要」と書いた（実際は継続適用が条件の任意の取扱い）
//   商品券の「発行」を非課税と書いた（実際は不課税。消基通6-4-5）
// タックスアンサーに書かれていない論点で、LLM が記憶で補っていた。
console.log('');
console.log('=== Test 7: 通達の登録 ===');
{
  // 商品券の記事 → 消費税法基本通達
  const gift = { title: '商品券・ギフトカードで代金を受け取ったとき', tax_domain: 'consumption_tax',
    pain_point: 'retail-gift-certificate' };
  const gp = ref.findReferencePages(gift);
  assert(gp.some(p => p.key === 'shohi_tsutatsu_bukkin_kitte'), '商品券記事 → 消基通が該当');
  const gb = ref.buildReferencePagesBlock(gift);
  assert(/資産の譲渡等の対価に該当しない/.test(gb), '6-4-5 の原文が入っている');
  assert(/不課税（課税対象外）/.test(gb), '発行は不課税と明示');
  assert(/発行の根拠に引かないこと/.test(gb), 'No.6229 を発行の根拠に引かない注意');

  // 修繕費の記事 → 所得税基本通達
  const rep = { title: '修繕費か資本的支出か？', tax_domain: 'bookkeeping_expenses',
    pain_point: 'capital-expenditure-vs-repair' };
  const rp = ref.findReferencePages(rep);
  assert(rp.some(p => p.key === 'shotoku_tsutatsu_shihonteki_shishutsu'), '修繕費記事 → 所基通が該当');
  const rb = ref.buildReferencePagesBlock(rep);
  assert(/60万円・10%の形式基準は37-13であって37-14ではない/.test(rb),
    '形式基準の条番号（37-13）を明示');
  assert(/任意の取扱い/.test(rb) && /義務ではない/.test(rb), '37-14 が任意である旨');
  assert(/按分が必要」と書かないこと/.test(rb), '「必要」と書かない注意');

  // 通達も主出典には採用しない
  const { isDeniedSource } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
  for (const p of [...gp, ...rp]) {
    assert(isDeniedSource(p.url), `${p.key}: 主出典には採用されない`);
  }

  // 無関係な記事には出さない
  assert(ref.findReferencePages({ title: '扶養と社会保険', tax_domain: 'income_tax',
    pain_point: 'social-insurance-misconception' }).length === 0, '社会保険記事には出さない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
