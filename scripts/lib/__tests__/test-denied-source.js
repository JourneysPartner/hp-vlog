'use strict';

/**
 * 使用禁止の出典（制度の入口ページ等）が採用されないことのテスト。
 *
 * 背景: 2026-08-16、インボイス制度の「概要ページ」を出典にした記事で、
 * プラットフォーム課税の対象（国外事業者限定）を誤った記述が出た。
 * 概要ページには論点の記載がないため、LLM が記憶で補ってしまう。
 */

const {
  resolveSourceForTopic, isDeniedSource, DENIED_SOURCE_URLS,
  DEFAULT_SOURCE_BY_PAIN, DEFAULT_SOURCE_BY_TAX_DOMAIN, REFS,
} = require('../tax-authority-refs');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

const ABOUT = 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm';

console.log('=== Test 1: 禁止判定 ===');
ok(isDeniedSource(ABOUT), 'インボイス制度の概要ページは禁止');
ok(!isDeniedSource('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm'), 'No.6498 は許可');
ok(!isDeniedSource(''), '空文字は禁止扱いにしない');
ok(!isDeniedSource(null), 'null は禁止扱いにしない');
ok(DENIED_SOURCE_URLS.size >= 1, '禁止リストが空でない');

console.log('\n=== Test 2: explicit 指定でも弾く ===');
{
  const r = resolveSourceForTopic({
    source_provenance: 'explicit', source_url: ABOUT, source_title: '概要',
    pain_point: 'content-invoice', tax_domain: 'invoice_system',
  });
  ok(r.url !== ABOUT, 'explicit でも概要ページは採用されない');
  ok(/6498/.test(r.url), '代わりに No.6498 が選ばれる');
}

console.log('\n=== Test 3: マッピングに残っていない ===');
{
  const badPains = Object.entries(DEFAULT_SOURCE_BY_PAIN)
    .filter(([, v]) => isDeniedSource(v && v.url)).map(([k]) => k);
  ok(badPains.length === 0, `DEFAULT_SOURCE_BY_PAIN に禁止出典なし${badPains.length ? ': ' + badPains.join(',') : ''}`);

  const badDomains = Object.entries(DEFAULT_SOURCE_BY_TAX_DOMAIN)
    .filter(([, v]) => isDeniedSource(v && v.url)).map(([k]) => k);
  ok(badDomains.length === 0, `DEFAULT_SOURCE_BY_TAX_DOMAIN に禁止出典なし${badDomains.length ? ': ' + badDomains.join(',') : ''}`);

  const badRefs = Object.entries(REFS)
    .flatMap(([k, arr]) => (arr || []).filter(r => isDeniedSource(r && r.url)).map(() => k));
  ok(badRefs.length === 0, `REFS に禁止出典なし${badRefs.length ? ': ' + badRefs.join(',') : ''}`);
}

console.log('\n=== Test 4: インボイス系 pain の解決先 ===');
for (const p of ['invoice-judgement', 'youtube-invoice', 'content-invoice',
                 'construction-invoice', 'retail-invoice', 'wholesale-invoice']) {
  const r = resolveSourceForTopic({ pain_point: p, tax_domain: 'invoice_system' });
  ok(!isDeniedSource(r.url) && /taxanswer/.test(r.url),
    `${p} → タックスアンサー (${(r.url.match(/(\d{4})\.htm/) || [])[1] || '?'})`);
}

console.log(`\n=== 結果 ===\nPASS: ${pass} / FAIL: ${fail}`);
if (fail > 0) process.exit(1);
