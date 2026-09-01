'use strict';
/**
 * インボイス登録の取消しと免税事業者に戻れる時期（2026-09-01）
 *
 * 何が起きたか:
 *   「インボイス登録をやめたい」の記事が、次の2点を誤って書いた。
 *     ・取消届出書は「12月31日までに提出すれば翌年1月1日から効力」
 *       → 正しくは課税期間の初日から起算して15日前の日まで（個人は12月17日まで）
 *     ・取り消せば「免税事業者に戻る（売上1,000万円以下なら納税義務なし）」
 *       → 登録した経路（経過措置か課税事業者選択か）で結論が変わる
 *
 * なぜ気づけなかったか:
 *   カタログはタックスアンサー・質疑応答事例・基本通達の3種類しか収録しておらず、
 *   インボイスの詳細が載っている Q&A（PDF）が入っていなかった。全2,222件を
 *   全文検索しても、経過措置の2年縛りは1件も収録されていなかった。
 *   → 該当箇所を原文で確認し、参考資料として登録した。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const refs = require(path.join(ROOT, 'scripts/lib/nta-reference-pages'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const page = refs.NTA_REFERENCE_PAGES.invoice_registration_cancel;
const notes = (page && page.notes || []).join('\n');

console.log('=== 1. 参考資料として登録されている ===');
{
  assert(!!page, '登録されている');
  assert(/nta\.go\.jp/.test(page.url), '出典は国税庁のページ');
  assert(page.verified_at === '2026-09-01', '原文で確認した日付が記録されている');
  assert(refs.isReferenceOnlyUrl(page.url),
    '主出典（source_url）には採用されない（参考資料としてのみ使う）');
}

console.log('');
console.log('=== 2. 誤りを正す原文が入っている ===');
{
  // 誤り①: 取消届出書の期限
  assert(/15日前の日までに/.test(notes), '「15日前の日まで」の原文が入っている');
  assert(/12月17日/.test(notes), '個人事業者の具体的な期限（12月17日）が示されている');
  assert(/「12月31日まで」ではない/.test(notes), '記事が書いた誤りを明示的に否定している');
  assert(/日曜日等の国民の休日等に当たる場合であっても/.test(notes),
    '休日でも期限が延びないことの原文が入っている');

  // 誤り②: 取り消せば免税に戻れる、という単純化
  assert(/1,000万円以下となった場合でも免税事業者となりません/.test(notes),
    '登録中は売上1,000万円以下でも免税にならない原文が入っている');
  assert(/2年を経過する日の属する課税期間までの各課税期間については免税事業者となることはできません/.test(notes),
    '経過措置による2年縛りの原文が入っている');
  assert(/28年改正法附則44⑤/.test(notes), '2年縛りの根拠条文が示されている');
  assert(/令和5年10月1日を含む場合は、2年縛りの対象外/.test(notes),
    '2年縛りが適用されない場合も示されている');
  assert(/課税事業者選択不適用届出書も要る/.test(notes),
    '課税事業者選択で登録した場合は届出書が2枚要ることが示されている');
}

console.log('');
console.log('=== 3. 必要な記事で発火する ===');
{
  const fires = (t) => page.match(t);
  assert(fires({ search_intent: 'インボイス 登録 やめたい 取り消し' }),
    '「インボイス登録をやめたい」の記事で発火する（今回の記事）');
  assert(fires({ primary_question: '免税事業者に戻れますか？' }), '免税事業者に戻る話で発火する');
  assert(fires({ reader_problem: '適格請求書発行事業者の登録を取消したい' }), '登録の取消で発火する');
  assert(fires({ tax_domain: 'invoice_system', search_intent: 'インボイス 登録' }),
    'インボイス全般で発火する');
  assert(!fires({ search_intent: '相続税 いくらから 基礎控除' }), '無関係な論点では発火しない');
}

console.log('');
console.log('=== 4. 実際にプロンプトへ渡る ===');
{
  const topic = {
    tax_domain: 'invoice_system',
    search_intent: 'インボイス 登録 やめたい',
    primary_question: 'インボイス登録をやめるにはどうすればよい？',
  };
  const found = refs.findReferencePages(topic).map(p => p.label);
  assert(found.includes('インボイス登録の取消しと免税事業者に戻れる時期'),
    '参考資料として選ばれる');

  const block = refs.buildReferencePagesBlock(topic);
  assert(block.length > 0, 'プロンプトに渡すブロックが作られる');
  assert(/15日前の日までに/.test(block), '15日前の原文がプロンプトに渡る');
  assert(/2年を経過する日の属する課税期間までの各課税期間/.test(block),
    '2年縛りの原文がプロンプトに渡る');
}

console.log('');
console.log('=== 5. 論点別ルールでも同じ内容を指示している ===');
{
  const { CONDITIONAL_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));
  const rule = CONDITIONAL_RULES.invoice_registration_cancel;
  assert(!!rule, 'ルールが登録されている');
  assert(rule.match({ search_intent: 'インボイス 登録 やめたい' }), '該当記事で発火する');
  assert(rule.match({ tax_domain: 'invoice_system' }), 'インボイスの記事で発火する');
  assert(!rule.match({ search_intent: '相続 手続き 期限' }), '無関係な論点では発火しない');

  assert(/12月17日まで/.test(rule.text), '個人事業者の具体的な期限を示している');
  assert(/「12月31日まで」「年内に出せばよい」と書かない/.test(rule.text),
    '誤った期限を禁止表現として挙げている');
  assert(/期限が延びない/.test(rule.text), '休日でも期限が延びないことを示している');
  assert(/28年改正法附則44⑤/.test(rule.text), '2年縛りの根拠条文を示している');
  assert(/令和5年10月1日を含まない/.test(rule.text) && /この2年縛りの対象外/.test(rule.text),
    '2年縛りの適用の有無が分岐として書かれている');
  assert(/消費税課税事業者選択不適用届出書/.test(rule.text),
    '課税事業者選択で登録した場合の追加手続を示している');
  assert(/免税事業者と<strong>ならない<\/strong>/.test(rule.text),
    '登録中は売上1,000万円以下でも免税にならないことを示している');
}
console.log('=== 結果 ===');
console.log('');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
