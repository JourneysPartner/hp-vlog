'use strict';

/**
 * 質疑応答事例パーサのテスト
 *   node scripts/lib/__tests__/test-shitsugi-parser.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const parser = require(path.join(ROOT, 'scripts/lib/nta-parsers/shitsugi'));
const index = require(path.join(ROOT, 'scripts/lib/nta-index/shitsugi-index'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── フィクスチャ：実 HTML を模した最小構造 ─────────────────────
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="ja"><head><title>会社員が行う建物の貸付けの取扱い｜国税庁</title></head><body>
<div id="bodyArea">
<ol class="breadcrumb"><li>ホーム</li><li>質疑応答事例</li></ol>
<div class="page-header"><h1>会社員が行う建物の貸付けの取扱い</h1></div>
<h2>【照会要旨】</h2>
<p>会社員が行う建物の貸付けは、課税の対象となるのでしょうか。</p>
<h2>【回答要旨】</h2>
<p>消費税の課税対象となる取引は、国内において事業者が事業として対価を得て行う資産の譲渡等ですから、会社員が行う建物の貸付けであっても、反復、継続、独立して行われるものであり、課税対象となります。</p>
<p>なお、住宅の貸付けである場合は、非課税となります。</p>
<h2>【関係法令通達】</h2>
<p>消費税法第2条第1項第8号、消費税法基本通達5-1-1</p>
<p class="red"><strong>注記<br>令和7年8月1日現在の法令・通達等に基づいて作成しています。<br>この質疑事例は...</strong></p>
</div></body></html>`;

// ── 1. extractTitle ─────────────────────────────────────────
console.log('\n=== Test 1: extractTitle ===');
{
  const taxanswer = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));
  const body = taxanswer.extractBodyArea(FIXTURE_HTML);
  const title = parser.extractTitle(body);
  assert(title === '会社員が行う建物の貸付けの取扱い', `タイトル抽出 (実: ${title})`);
}

// ── 2. extractByLabel ────────────────────────────────────────
console.log('\n=== Test 2: extractByLabel ===');
{
  const taxanswer = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));
  const body = taxanswer.extractBodyArea(FIXTURE_HTML);
  const shokai = parser.extractByLabel(body, '【照会要旨】');
  assert(shokai && shokai.includes('課税の対象'), `照会要旨 抽出`);
  const kaitou = parser.extractByLabel(body, '【回答要旨】');
  assert(kaitou && kaitou.includes('課税対象となります'), `回答要旨 抽出`);
  assert(kaitou && kaitou.includes('住宅の貸付けである場合は、非課税'),
    `回答要旨 に複数段落含む`);
}

// ── 3. extractKankeiHourei ───────────────────────────────────
console.log('\n=== Test 3: extractKankeiHourei ===');
{
  const taxanswer = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));
  const body = taxanswer.extractBodyArea(FIXTURE_HTML);
  const hourei = parser.extractKankeiHourei(body);
  assert(hourei && hourei.includes('消費税法第2条'), `関係法令通達 抽出`);
}

// ── 4. extractLawVersion ─────────────────────────────────────
console.log('\n=== Test 4: extractLawVersion ===');
{
  const taxanswer = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));
  const body = taxanswer.extractBodyArea(FIXTURE_HTML);
  const lv = parser.extractLawVersion(body);
  assert(lv && /令和7年8月1日現在/.test(lv), `law_version 抽出 (実: ${lv})`);
}

// ── 5. parseShitsugiHtml ─────────────────────────────────────
console.log('\n=== Test 5: parseShitsugiHtml ===');
{
  const url = 'https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm';
  const entry = parser.parseShitsugiHtml(FIXTURE_HTML, url);
  assert(entry.id === '01', `id=01`);
  assert(entry.section === '02', `section=02`);
  assert(entry.type === 'shitsugi', `type=shitsugi`);
  assert(entry.tax_category === '消費税', `tax_category=消費税`);
  assert(entry.tax_category_code === 'shohi', `tax_category_code=shohi`);
  assert(entry.title === '会社員が行う建物の貸付けの取扱い', `title 抽出`);
  assert(entry.shokai_yoshi && entry.shokai_yoshi.includes('課税の対象'),
    `shokai_yoshi 抽出`);
  assert(entry.kaitou_yoshi && entry.kaitou_yoshi.includes('課税対象となります'),
    `kaitou_yoshi 抽出`);
  assert(entry.kankei_hourei && entry.kankei_hourei.includes('消費税法第2条'),
    `kankei_hourei 抽出`);
  assert(entry.law_version && /令和7年8月1日現在/.test(entry.law_version),
    `law_version 抽出`);
  assert(entry.body_combined && entry.body_combined.length > 50,
    `body_combined 結合本文あり`);
  assert(entry.char_count_body > 0, `char_count_body > 0`);
}

// ── 6. カテゴリ判定 ──────────────────────────────────────────
console.log('\n=== Test 6: カテゴリ判定 ===');
{
  assert(parser.isIncludedCategory('shohi'), `shohi は対象`);
  assert(parser.isIncludedCategory('sozoku'), `sozoku（相続・贈与）は対象`);
  assert(parser.isIncludedCategory('hyoka'), `hyoka（財産評価）は対象`);
  assert(!parser.isIncludedCategory('inshi'), `inshi（印紙）は対象外`);
  assert(parser.isExcludedCategory('inshi'), `inshi はスコープ外`);
  assert(parser.isExcludedCategory('hotei'), `hotei はスコープ外`);
  assert(parser.isExcludedCategory('shinki'), `shinki はスコープ外`);
}

// ── 7. parseShitsugiCategoryIndex ────────────────────────────
console.log('\n=== Test 7: parseShitsugiCategoryIndex ===');
{
  const indexHtml = `<html><body>
    <a href="/law/shitsugi/shohi/02/01.htm">会社員が行う建物の貸付け</a>
    <a href="/law/shitsugi/shohi/02/42.htm">会社員が設置した太陽光発電</a>
    <a href="/law/shitsugi/shohi/04/05.htm">仕入税額控除の調整</a>
    <a href="/law/shitsugi/shohi/02/01.htm">重複</a>
    <a href="/law/shitsugi/sozoku/01/01.htm">違うカテゴリは抽出されない</a>
  </body></html>`;
  const entries = index.parseShitsugiCategoryIndex(indexHtml, 'shohi');
  assert(entries.length === 3, `shohi カテゴリのみ重複除外で 3 件 (実: ${entries.length})`);
  assert(entries[0].id === '01' && entries[0].section === '02', `1 件目: section=02, id=01`);
  assert(entries[1].id === '42' && entries[1].section === '02', `2 件目: section=02, id=42`);
  assert(entries[2].id === '05' && entries[2].section === '04', `3 件目: section=04, id=05`);
  assert(entries.every(e => e.category === 'shohi'), `全て shohi`);
  assert(!entries.some(e => e.category === 'sozoku'),
    `sozoku は category=shohi 指定で取得されない`);
}

// ── 8. エラーケース ──────────────────────────────────────────
console.log('\n=== Test 8: エラーケース ===');
{
  try {
    parser.parseShitsugiHtml('<html><body>no bodyArea</body></html>',
      'https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm');
    assert(false, 'bodyArea なしはエラー');
  } catch (e) {
    assert(/bodyArea/.test(e.message), `bodyArea エラーメッセージ`);
  }

  // 不正な URL 形式
  try {
    parser.parseShitsugiHtml(FIXTURE_HTML, 'https://example.com/bad-url');
    assert(false, '不正 URL はエラー');
  } catch (e) {
    assert(/URL/.test(e.message), `URL 形式エラーメッセージ`);
  }
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
