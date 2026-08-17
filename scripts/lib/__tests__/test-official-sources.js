'use strict';

/**
 * 国税庁以外の公的出典（社会保険等）のテスト。
 *
 * 背景（2026-08-17）:
 *   「社会保険の扶養と税の扶養の違い」の記事で、社会保険は厚労省・年金機構の
 *   所管にもかかわらず国税庁の No.1191（配偶者控除）が出典に選ばれ、
 *   記事の主題である社会保険側が裏付けのないまま書かれていた。
 */

const {
  OFFICIAL_DOMAINS, isOfficialDomain, NON_TAX_SOURCES,
  findNonTaxSource, buildNonTaxSourceBlock,
} = require('../official-sources');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}`); fail++; } };

console.log('=== Test 1: 公的ドメインの判定 ===');
ok(isOfficialDomain('https://www.nenkin.go.jp/x.html'), '日本年金機構は許可');
ok(isOfficialDomain('https://www.mhlw.go.jp/x.html'), '厚生労働省は許可');
ok(isOfficialDomain('https://www.nta.go.jp/x.htm'), '国税庁は許可');
ok(!isOfficialDomain('https://example.com/x'), '民間サイトは拒否');
ok(!isOfficialDomain('https://nenkin.go.jp.evil.com/x'), '偽装ドメインは拒否');
ok(!isOfficialDomain(''), '空文字は拒否');
ok(!isOfficialDomain(null), 'null は拒否');
ok(OFFICIAL_DOMAINS.every(d => /\.go\.jp$|^[a-z.]+\.go\.jp$/.test(d)),
  '登録ドメインはすべて go.jp（政府機関のみ）');

console.log('\n=== Test 2: 登録URLがすべて公的ドメイン ===');
for (const [key, def] of Object.entries(NON_TAX_SOURCES)) {
  for (const e of def.entries) {
    ok(isOfficialDomain(e.url), `${key}: ${e.url.slice(0, 52)} が公的ドメイン`);
    ok(!!e.title && !!e.note, `${key}: title と note が設定されている`);
  }
}

console.log('\n=== Test 3: 社会保険テーマで注入される（2026-08-17 の事故）===');
{
  const topic = {
    pain_point: 'social-insurance-misconception', tax_domain: 'income_tax',
    title: '扶養から外れる？売上が伸びてきたサロンオーナーが確認すべき社会保険と税の違い',
    search_intent: '売上拡大期にいる個人事業主が社会保険の扶養と税の扶養の違いを理解したい',
  };
  const f = findNonTaxSource(topic);
  ok(!!f, '社会保険テーマが検出される');
  ok(f.agency === '日本年金機構', '所管官庁が特定される');

  const b = buildNonTaxSourceBlock(topic);
  ok(b.length > 300, 'ブロックが生成される');
  ok(/nenkin\.go\.jp/.test(b), '日本年金機構のURLが含まれる');
  ok(/mhlw\.go\.jp/.test(b), '厚生労働省のURLが含まれる');
  ok(/130万円/.test(b), '収入要件（130万円）が示される');
  ok(/国税庁タックスアンサーを根拠として引かない/.test(b),
    '社会保険の話で国税庁を根拠に引くことを禁止している');
  ok(/混同しない/.test(b), '税と社会保険の混同を禁止している');
}

console.log('\n=== Test 4: キーワードでも拾える ===');
for (const [label, topic] of [
  ['130万円の壁', { title: '130万円の壁を超えたらどうなる？' }],
  ['被扶養者', { search_intent: '被扶養者の認定要件を知りたい' }],
  ['年収の壁', { summary: '年収の壁の対応を解説' }],
]) {
  ok(!!findNonTaxSource(topic), `${label} で検出される`);
}

console.log('\n=== Test 5: 税のテーマには注入しない ===');
for (const [label, topic] of [
  ['相続の申告期限', { pain_point: 'deadline-pressure', tax_domain: 'inheritance_tax', title: '相続税の申告と納税' }],
  ['自販機特例', { pain_point: 'vending-machine-special', title: '自動販売機特例とは' }],
  ['専従者給与', { pain_point: 'family-employment', title: '専従者給与と専従者控除' }],
  ['減価償却', { pain_point: 'software-depreciation', title: 'ソフトウェアの減価償却' }],
]) {
  ok(findNonTaxSource(topic) === null, `${label} には注入しない`);
  ok(buildNonTaxSourceBlock(topic) === '', `${label}: ブロックは空文字`);
}

console.log('\n=== Test 6: 壊れた入力でも例外を投げない ===');
ok(findNonTaxSource({}) === null, '空トピックは null');
ok(findNonTaxSource(undefined) === null, 'undefined でも落ちない');
ok(buildNonTaxSourceBlock({}) === '', '空トピックは空文字');
ok(buildNonTaxSourceBlock(undefined) === '', 'undefined でも空文字');

console.log(`\n=== 結果 ===\nPASS: ${pass} / FAIL: ${fail}`);
if (fail > 0) process.exit(1);
