'use strict';

/**
 * タックスアンサーパーサのテスト
 *   node scripts/lib/__tests__/test-taxanswer-parser.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const parser = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));
const index = require(path.join(ROOT, 'scripts/lib/nta-index/taxanswer-index'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── フィクスチャ：No.6501 を模した最小限の HTML ────────────────
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="ja"><head><title>No.6501 納税義務の免除｜国税庁</title></head><body>
<div id="bodyArea">
<ol class="breadcrumb"><li><a href="/">ホーム</a></li><li>タックスアンサー</li></ol>
<div class="page-header"><h1><span class="active">N</span>o.6501 納税義務の免除</h1></div>
<p>[令和7年4月1日現在法令等]</p>
<h2>対象税目</h2>
<p>消費税</p>
<h2>概要</h2>
<h3>消費税の納税義務の免除</h3>
<p>事業者は、国内において行った課税資産の譲渡等について消費税を納める義務がありますが、その課税期間の基準期間における課税売上高が1,000万円以下である場合には、原則として、納税義務が免除されます。</p>
<h2>根拠法令等</h2>
<p>消費税法第9条、第9条の2</p>
</div></body></html>`;

// ── 1. extractBodyArea ────────────────────────────────────────
console.log('\n=== Test 1: extractBodyArea ===');
{
  const body = parser.extractBodyArea(FIXTURE_HTML);
  assert(body.length > 0, 'bodyArea を抽出');
  assert(body.includes('対象税目'), 'h2 を含む');
  assert(!body.includes('<head>'), 'head は含まない');
}

// ── 2. extractTitle ──────────────────────────────────────────
console.log('\n=== Test 2: extractTitle ===');
{
  const body = parser.extractBodyArea(FIXTURE_HTML);
  const { id, title, titleFull } = parser.extractTitle(body);
  assert(id === '6501', `id=6501 (実: ${id})`);
  assert(title === '納税義務の免除', `title="納税義務の免除" (実: ${title})`);
  assert(titleFull && titleFull.includes('No.6501'), `titleFull に "No.6501" 含む`);
}

// ── 3. extractLawVersion ─────────────────────────────────────
console.log('\n=== Test 3: extractLawVersion ===');
{
  const body = parser.extractBodyArea(FIXTURE_HTML);
  const lv = parser.extractLawVersion(body);
  assert(lv === '令和7年4月1日現在法令等', `law_version 抽出 (実: ${lv})`);
}

// ── 4. extractSections ───────────────────────────────────────
console.log('\n=== Test 4: extractSections ===');
{
  const body = parser.extractBodyArea(FIXTURE_HTML);
  const sections = parser.extractSections(body);
  assert(sections['対象税目'] === '消費税', `対象税目="消費税" (実: ${sections['対象税目']})`);
  assert(sections['概要'] && sections['概要'].includes('1,000万円以下'),
    `概要に "1,000万円以下" 含む`);
  assert(sections['根拠法令等'] && sections['根拠法令等'].includes('第9条'),
    `根拠法令等 に "第9条" 含む`);
}

// ── 5. parseTaxAnswerHtml（核心関数） ──────────────────────────
console.log('\n=== Test 5: parseTaxAnswerHtml ===');
{
  const url = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm';
  const entry = parser.parseTaxAnswerHtml(FIXTURE_HTML, url);
  assert(entry.id === '6501', `id=6501`);
  assert(entry.type === 'taxanswer', `type=taxanswer`);
  assert(entry.tax_category === '消費税', `tax_category=消費税`);
  assert(entry.tax_category_code === 'shohi', `tax_category_code=shohi`);
  assert(entry.url === url, `url 保持`);
  assert(entry.title === '納税義務の免除', `title 抽出`);
  assert(entry.law_version === '令和7年4月1日現在法令等', `law_version 抽出`);
  assert(typeof entry.sections === 'object' && Object.keys(entry.sections).length >= 3,
    `sections に複数エントリ`);
  assert(typeof entry.body === 'string' && entry.body.length > 50, `body 本文あり`);
  assert(entry.char_count_body > 0, `char_count_body > 0`);
}

// ── 6. isIncludedCategory / isExcludedCategory ───────────────
console.log('\n=== Test 6: カテゴリ判定 ===');
{
  assert(parser.isIncludedCategory('shohi'), `shohi は対象`);
  assert(parser.isIncludedCategory('sozoku'), `sozoku は対象`);
  assert(!parser.isIncludedCategory('inshi'), `inshi は対象外`);
  assert(parser.isExcludedCategory('inshi'), `inshi はスコープ外`);
  assert(parser.isExcludedCategory('hotei'), `hotei はスコープ外`);
}

// ── 7. parseTaxAnswerIndex（HTML から URL 抽出） ─────────────────
console.log('\n=== Test 7: parseTaxAnswerIndex ===');
{
  const indexHtml = `<html><body>
    <a href="/taxes/shiraberu/taxanswer/shohi/6501.htm" target="_blank">No.6501　納税義務の免除</a>
    <a href="/taxes/shiraberu/taxanswer/sozoku/4101.htm">No.4101　相続税の概要</a>
    <a href="/taxes/shiraberu/taxanswer/inshi/7100.htm">No.7100　印紙税の対象</a>
    <a href="/taxes/shiraberu/taxanswer/shohi/6501.htm">重複 No.6501</a>
  </body></html>`;
  const entries = index.parseTaxAnswerIndex(indexHtml);
  assert(entries.length === 2, `inshi 除外 + 重複除去で 2 件 (実: ${entries.length})`);
  assert(entries.some(e => e.id === '6501' && e.category === 'shohi'), `shohi/6501 含む`);
  assert(entries.some(e => e.id === '4101' && e.category === 'sozoku'), `sozoku/4101 含む`);
  assert(!entries.some(e => e.category === 'inshi'), `inshi 含まない`);

  // category filter
  const filtered = index.parseTaxAnswerIndex(indexHtml, { categories: ['shohi'] });
  assert(filtered.length === 1 && filtered[0].id === '6501', `categories=shohi で絞り込み OK`);

  // maxEntries
  const limited = index.parseTaxAnswerIndex(indexHtml, { maxEntries: 1 });
  assert(limited.length === 1, `maxEntries=1 で 1 件`);
}

// ── 8. parseTaxAnswerHtml: bodyArea 欠如時のエラー ───────────────
console.log('\n=== Test 8: エラーケース ===');
{
  try {
    parser.parseTaxAnswerHtml('<html><body>no bodyArea</body></html>', 'http://x/y/1.htm');
    assert(false, 'bodyArea 無しはエラーをスロー');
  } catch (e) {
    assert(/bodyArea/.test(e.message), `bodyArea 関連のエラーメッセージ`);
  }
}

// ── 9. stripHtmlTags: インラインタグは空白なし ─────────────────
console.log('\n=== Test 9: stripHtmlTags inline tags ===');
{
  // span は空白なしで除去（CJK 文字間にスペースを入れない）
  assert(parser.stripHtmlTags('<span class="active">山</span>林の伐採') === '山林の伐採',
    '<span> 除去で空白挿入なし');
  assert(parser.stripHtmlTags('<a href="#">税理士</a>に相談') === '税理士に相談',
    '<a> 除去で空白挿入なし');
  assert(parser.stripHtmlTags('<strong>重要</strong>です') === '重要です',
    '<strong> 除去で空白挿入なし');
  assert(parser.stripHtmlTags('<em>強調</em>テキスト') === '強調テキスト',
    '<em> 除去で空白挿入なし');
  // ブロック系タグは空白を残す
  assert(parser.stripHtmlTags('<p>段落1</p><p>段落2</p>').trim().replace(/\s+/g, ' ') === '段落1 段落2',
    '<p> はブロック系で空白挿入');
}

// ── 10. collapseCjkSpaces ────────────────────────────────────
console.log('\n=== Test 10: collapseCjkSpaces ===');
{
  // 山林の伐採事例の問題（インラインタグ strip 由来、修正後はこのケース自体は発生しないが、念のため CJK 間 collapse でカバー）
  assert(parser.collapseCjkSpaces('山 林の伐採') === '山林の伐採',
    'CJK 一文字 + space + CJK → 削る');
  // 国税庁 HTML の改行が CJK 間に入るケース
  assert(parser.collapseCjkSpaces('第１項 の「収用等のあつた日」') === '第１項の「収用等のあつた日」',
    '空白で区切られた CJK は連結');
  // 連続スペース
  assert(parser.collapseCjkSpaces('租税  特別  措置法') === '租税特別措置法',
    '複数スペースも処理');
  // 3 連続 CJK 区切り
  assert(parser.collapseCjkSpaces('山 林 の 伐採') === '山林の伐採',
    '3 連続スペースも処理');
  // 英字 - CJK 境界はスペース保持
  assert(parser.collapseCjkSpaces('Amazon の販売') === 'Amazon の販売',
    '英字-CJK 境界はスペース保持');
  // CJK - 英字境界もスペース保持
  assert(parser.collapseCjkSpaces('販売 Amazon') === '販売 Amazon',
    'CJK-英字境界はスペース保持');
  // 数字 - CJK もスペース保持（"1,000 万円" などの財務表記）
  assert(parser.collapseCjkSpaces('1,000 万円') === '1,000 万円',
    '数字-CJK 境界はスペース保持');
  // 空文字 / null セーフ
  assert(parser.collapseCjkSpaces('') === '', '空文字 OK');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
