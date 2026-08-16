'use strict';

/**
 * 出典本文をプロンプトへ添付する仕組みのテスト。
 *
 * 背景: タイトルとURLだけを渡していたため、LLM が出典を読まずに記憶で書き、
 * 読んでいない文書を引用する事故が続いた（2026-08-16）。
 * ここでは「過去に誤った3件の記事について、誤りを正す原文が実際に
 * プロンプトへ入るか」を回帰テストとして固定する。
 */

const { loadSourceBody, buildSourceBodyBlock, parseTaxanswerUrl } = require('../nta-source-body');
const { getRefsForTopic } = require('../tax-authority-refs');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

const U = n => `https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/${n}.htm`;

console.log('=== Test 1: URL のパース ===');
ok(parseTaxanswerUrl(U('6459')).no === '6459', 'taxanswer の番号を取り出せる');
ok(parseTaxanswerUrl(U('6459')).section === 'shohi', 'セクションを取り出せる');
ok(parseTaxanswerUrl('https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm') === null,
  'パンフレット等は対象外（null）');
ok(parseTaxanswerUrl('') === null, '空文字は null');
ok(parseTaxanswerUrl(null) === null, 'null は null');

console.log('\n=== Test 2: 本文の取得 ===');
{
  const s = loadSourceBody(U('6459'));
  ok(!!s, 'No.6459 の本文を取得できる');
  ok(s.no === '6459', 'no が入る');
  ok(s.title.length > 0, 'title が入る');
  ok(s.body.length > 100, '本文が十分な長さ');
  ok(!/\n/.test(s.body), '本文の改行が正規化されている');
  ok(loadSourceBody(U('9999')) === null, '存在しない番号は null');
  ok(loadSourceBody('https://example.com/x.htm') === null, '国税庁外は null');
}

console.log('\n=== Test 3: 長い本文は切り詰める ===');
{
  const short = loadSourceBody(U('6459'), { maxChars: 100 });
  ok(short.body.length === 100, 'maxChars で切り詰められる');
  ok(short.truncated === true, 'truncated フラグが立つ');
  const full = loadSourceBody(U('6459'));
  ok(full.truncated === false, '上限内なら truncated=false');
}

console.log('\n=== Test 4: 過去の誤りを正す原文がブロックに入る ===');
// 実際に誤記が出た3記事について、誤りを打ち消す原文が含まれることを確認する
const cases = [
  ['出張旅費（日当を不課税と誤記）',
    { tax_domain: 'consumption_tax', pain_point: 'travel-expense-input-tax', source_url: U('6459') },
    ['通常必要であると認められる部分の金額は、課税仕入れになります', '海外への出張または転勤']],
  ['自販機特例（コインパーキングを対象と誤記）',
    { tax_domain: 'consumption_tax', pain_point: 'vending-machine-special', source_url: U('6496') },
    ['3万円未満の自動販売機及び自動サービス機', '3万円未満の公共交通機関']],
  ['プラットフォーム課税（国内事業者に適用と誤記）',
    { tax_domain: 'invoice_system', pain_point: 'content-invoice', source_url: U('6568') },
    ['国外事業者', '特定プラットフォーム事業者']],
];
for (const [label, topic, needles] of cases) {
  const block = buildSourceBodyBlock(topic, getRefsForTopic(topic, 4), { maxRefs: 1 });
  ok(block.length > 500, `${label}: 本文ブロックが生成される`);
  for (const kw of needles) {
    ok(block.includes(kw), `${label}: 「${kw.slice(0, 24)}」が含まれる`);
  }
}

console.log('\n=== Test 5: 捏造を禁じる指示が入る ===');
{
  const topic = { tax_domain: 'consumption_tax', pain_point: 'travel-expense-input-tax', source_url: U('6459') };
  const block = buildSourceBodyBlock(topic, getRefsForTopic(topic, 4), { maxRefs: 1 });
  ok(/捏造であり厳禁/.test(block), '出典に無いことを「明示している」と書くのを禁止している');
  ok(/限定列挙として扱う/.test(block), '対象範囲の列挙を限定列挙として扱わせている');
  ok(/必ず本文を優先/.test(block), '記憶と食い違う場合は本文優先と明示している');
}

console.log('\n=== Test 6: 主出典と参考の重複を避ける ===');
{
  const topic = { tax_domain: 'consumption_tax', pain_point: 'vending-machine-special', source_url: U('6496') };
  const block = buildSourceBodyBlock(topic, getRefsForTopic(topic, 4), { maxRefs: 1 });
  const nos = (block.match(/No\.(\d{4})「/g) || []);
  ok(nos.length === new Set(nos).size, '同じ出典が二重に載らない');
  ok(nos.length <= 2, '主出典＋参考1件で最大2件');
  ok(/【主出典】/.test(block), '主出典が明示される');
}

console.log('\n=== Test 7: カタログ外でも壊れない ===');
{
  // パンフレット等（カタログにない）を主出典にしたケース
  const topic = {
    tax_domain: 'overseas_transactions', pain_point: 'platform-fee-treatment',
    source_url: 'https://www.nta.go.jp/publication/pamph/shohi/cross/01.htm',
  };
  const block = buildSourceBodyBlock(topic, [], { maxRefs: 1 });
  ok(block === '', 'カタログ外かつ参考なしなら空文字（従来動作にフォールバック）');
  ok(buildSourceBodyBlock({}, []) === '', '出典なしでも例外を投げない');
  ok(buildSourceBodyBlock(undefined, undefined) === '', '引数なしでも例外を投げない');
}

console.log(`\n=== 結果 ===\nPASS: ${pass} / FAIL: ${fail}`);
if (fail > 0) process.exit(1);
