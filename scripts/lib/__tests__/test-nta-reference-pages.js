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

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
