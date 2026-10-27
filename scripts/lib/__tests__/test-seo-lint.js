'use strict';

const { lintSeo } = require('../seo-lint');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
const has = (r, code, kind = 'warns') => r[kind].some(v => v === code || v.startsWith(`${code}:`));

console.log('\n=== target_query 無し ===');
{
  const r = lintSeo({ title: '', summary: '', body: '' });
  assert(r.fails.length === 0 && r.warns.length === 0, '検索語が無ければ空');
}

console.log('\n=== title ===');
{
  let r = lintSeo({ target_query: '塗料 勘定科目', title: '塗料の処理を確認するための十分な長さのタイトルです', summary: '塗料の結論です', body: '塗料です。\n\n## 塗料の扱い' });
  assert(has(r, 'title_missing_query', 'fails'), '主検索語の一部が無いと fail');
  r = lintSeo({ target_query: '検索語', title: `${'あ'.repeat(43)}検索語`, summary: '検索語の結論です', body: '検索語です。\n\n## 検索語' });
  assert(has(r, 'title_too_long', 'fails'), '45文字超は fail');
  r = lintSeo({ target_query: '検索語', title: '検索語の短い題名', summary: '検索語の結論です', body: '検索語です。\n\n## 検索語' });
  assert(has(r, 'title_too_short'), '28文字未満は warn');
  const at15 = lintSeo({ target_query: '検索語', title: `${'あ'.repeat(15)}検索語${'い'.repeat(10)}`, summary: '検索語の結論です', body: '検索語。\n\n## 検索語' });
  const at16 = lintSeo({ target_query: '検索語', title: `${'あ'.repeat(16)}検索語${'い'.repeat(9)}`, summary: '検索語の結論です', body: '検索語。\n\n## 検索語' });
  assert(!has(at15, 'title_query_late') && has(at16, 'title_query_late'), '開始位置15は許容、16は warn');
}

console.log('\n=== summary / lead / headings ===');
{
  const at60 = lintSeo({ target_query: '対象語', title: `対象語${'題'.repeat(25)}`, summary: `${'あ'.repeat(57)}対象語`, body: '対象語です。\n\n## 対象語\n\n### 副検索 語句' });
  const after60 = lintSeo({ target_query: '対象語', title: `対象語${'題'.repeat(25)}`, summary: `${'あ'.repeat(60)}対象語`, body: '対象語です。\n\n## 対象語' });
  assert(!has(at60, 'summary_missing_query', 'fails') && has(after60, 'summary_missing_query', 'fails'),
    '先頭60文字の境界を判定');
  assert(has(lintSeo({ target_query: '対象語', title: `対象語${'題'.repeat(25)}`, summary: `対象語${'長'.repeat(118)}`, body: '対象語。\n\n## 対象語' }), 'summary_too_long'),
    'summary 120文字超は warn');
  assert(has(lintSeo({ target_query: '対象語', title: `対象語${'題'.repeat(25)}`, summary: '対象語の結論', body: '導入です。\n\n## 対象語' }), 'lead_missing_query'),
    'リードに検索語が無いと warn');
  assert(has(lintSeo({ target_query: '対象語', title: `対象語${'題'.repeat(25)}`, summary: '対象語の結論', body: '対象語です。\n\n## 別見出し' }), 'h2_missing_query'),
    'h2に検索語が無いと warn');
  const secondary = lintSeo({ target_query: '対象語', secondary_queries: ['別角度 疑問', '副検索 語句'], title: `対象語${'題'.repeat(25)}`, summary: '対象語の結論', body: '対象語です。\n\n## 対象語\n\n### 副検索の語句' });
  assert(secondary.warns.filter(v => v.startsWith('secondary_not_covered:')).length === 1,
    '未カバーの副検索語ごとに warn');
  assert(!has(at60, 'lead_missing_query') && !has(at60, 'h2_missing_query'),
    'リードとh2に検索語があれば warn しない');
}

console.log('\n=== stuffing / 英字大小 ===');
{
  const stuffed = lintSeo({ target_query: '塗料 勘定科目', title: `塗料の勘定科目${'題'.repeat(20)}`, summary: '塗料の勘定科目の結論', body: '塗料の勘定科目。\n\n塗料の勘定科目。\n\n## 塗料の勘定科目' });
  assert(has(stuffed, 'keyword_stuffing'), '全トークンを含む段落が60%超なら warn');
  const exact60 = lintSeo({ target_query: '塗料 勘定科目', title: `塗料の勘定科目${'題'.repeat(20)}`, summary: '塗料の勘定科目の結論', body: '塗料の勘定科目。\n\n塗料の勘定科目。\n\n塗料の勘定科目。\n\n別の段落。\n\n別の段落。\n\n## 塗料の勘定科目' });
  assert(!has(exact60, 'keyword_stuffing'), '段落の60%ちょうどは warn しない');
  const ascii = lintSeo({ target_query: 'eBay TAX', title: `EBAY tax${' title'.repeat(5)}`, summary: 'ebay TAX の結論', body: 'Ebay taxです。\n\n## EBAY TAX' });
  assert(!has(ascii, 'title_missing_query', 'fails'), '英字は大文字小文字を区別しない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
