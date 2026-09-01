'use strict';
/**
 * 国税庁Q&Aカタログ（2026-09-01）
 *
 * 何のために作ったか:
 *   カタログはタックスアンサー・質疑応答事例・基本通達の3種類しか収録しておらず、
 *   インボイスの詳細が載っている Q&A（PDF）が入っていなかった。そのため
 *   「インボイス登録をやめたい」の記事が、取消届出書の期限（15日前）を外し、
 *   経過措置で登録した場合の2年縛りにも触れないまま出た。
 *
 *   全2,222件を全文検索しても2年縛りは1件も収録されておらず、記事に誤りが出てから
 *   手で参考資料に登録する後追いを4回繰り返していた。それをやめるために取り込んだ。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const qa = require(path.join(ROOT, 'scripts/lib/nta-qa'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const N = qa.normalize;

console.log('=== 1. カタログが取り込まれている ===');
{
  const stats = qa.catalogStats();
  assert(stats.total >= 170, `Q&Aが取り込まれている（${stats.total}件）`);
  assert(stats.chars > 200000, `本文の総量（${stats.chars.toLocaleString()}文字）`);
  const entries = qa.loadIndex();
  assert(entries.every(e => e.url && /^https:\/\/www\.nta\.go\.jp\//.test(e.url)),
    'すべて国税庁のURLを持つ');
  assert(entries.filter(e => e.q_no).length >= 165, '大半で問番号を取得できている');
  assert(entries.filter(e => e.digest).length === 2,
    '総集編（多く寄せられるご質問・事例集）に印が付いている');
}

console.log('');
console.log('=== 2. 今回の誤りの原文が引ける ===');
{
  const bodyOf = (id) => {
    const e = qa.loadIndex().find(x => x.id === id);
    return e ? N(JSON.parse(fs.readFileSync(path.join(qa.QA_DIR, e.file_path), 'utf8')).body) : '';
  };
  assert(/2年を経過する日の属する課税期間までの各課税期間については免税事業者となることはできません/
    .test(bodyOf('07')), '問7に経過措置の2年縛りの原文がある');
  // 丸数字（⑤）は PDF 抽出で崩れる（「44⑤」→「444」）。条番号までで確認する。
  assert(/28年改正法附則44/.test(bodyOf('07')), '問7に根拠条文がある');
  assert(/1,000万円以下となった場合でも免税事業者となりません/.test(bodyOf('17')),
    '問17に「登録中は売上が減っても免税にならない」原文がある');
  assert(/15日前の日までに/.test(bodyOf('07')), '15日前の期限の原文がある');
}

console.log('');
console.log('=== 3. 全角・空白の揺れを吸収する ===');
{
  // PDF の抽出結果は「２年」「1,000 万円」のように全角と空白が混ざる
  assert(N('２年を経過する日') === N('2年を経過する日'), '全角数字を吸収する');
  assert(N('1,000 万円') === N('1,000万円'), 'PDF由来の空白を吸収する');
  const found = qa.findQaByKeywords(['２年を経過する日'], { maxDocs: 5 });
  assert(found.length > 0, '全角で検索しても当たる');
}

console.log('');
console.log('=== 4. 絞り込みに効く語だけを使う ===');
{
  // 半数以上に出る語しか無ければ結果を返さない（「登録」は93/173件＝希少度0.62）
  const common = qa.findQaByKeywords(['登録'], { maxDocs: 3 });
  assert(common.length === 0, 'ありふれた語（登録）だけでは絞り込まない');

  // 長すぎる断片（文をそのまま切ったもの）は使わない
  const longFragment = qa.findQaByKeywords(['インボイス登録をやめるにはどのような手続きが必要で'], { maxDocs: 3 });
  assert(longFragment.length === 0, '長すぎる断片は語として使わない');

  const useful = qa.findQaByKeywords(['登録の取りやめ', '取消しを求める旨の届出書'], { maxDocs: 3 });
  assert(useful.length > 0, '制度の用語では当たる');
}

console.log('');
console.log('=== 5. 実際の記事の企画メタで正しい問が選ばれる ===');
{
  // 2026-09-01 の記事のメタをそのまま使う
  const topic = {
    tax_domain: 'invoice_system',
    pain_point: 'suggest-invoice-yametai-dd16cd',
    primary_question: 'インボイス登録をやめるにはどのような手続きが必要で、やめると何が変わる？',
    reader_problem: 'インボイス登録後に納税負担や事務負担が増え、登録を取り消すべきかや手続きの時期が分からない',
    search_intent: 'インボイス 辞めたい インボイス やめたいとき インボイス やめたい場合 インボイス 登録 やめたい',
  };
  const keywords = [topic.pain_point, topic.primary_question, topic.reader_problem, topic.search_intent]
    .filter(Boolean).join(' ').split(/[\s、。？?・／/]+/).filter(w => w.length >= 2);

  const found = qa.findQaByKeywords(keywords, { taxDomain: topic.tax_domain, maxDocs: 3 });
  assert(found.length > 0, '該当する問が見つかる');
  assert(found[0].q_no === '問13', `1位が「登録の取りやめ」（実: ${found[0].q_no} ${found[0].title.slice(0, 20)}）`);
  assert(!found.some(f => f.digest), '総集編は個別の問より後ろに回る');

  const block = qa.buildQaBlock(keywords, { taxDomain: topic.tax_domain, maxDocs: 3 });
  assert(block.length > 0, 'プロンプトに渡すブロックが作られる');
  assert(/登録の取りやめ/.test(N(block)), '「登録の取りやめ」の原文が渡る');
  assert(/nta\.go\.jp/.test(block), '出典URLが添えられる');
  assert(/記憶ではなくこの本文を根拠に/.test(block), '原文を根拠にする指示が入る');
}

console.log('');
console.log('=== 6. 安全に動く ===');
{
  assert(qa.findQaByKeywords([]).length === 0, '語が空なら何も返さない');
  assert(qa.buildQaBlock(['そんな語はどこにもない文字列xyz']) === '', '該当が無ければ空文字');
  const trimmed = qa.trimBody('あ'.repeat(5000));
  assert(trimmed.truncated && trimmed.text.length === qa.MAX_BODY_CHARS,
    '長い本文は上限で切られる');
  assert(qa.trimBody('短い本文').truncated === false, '短い本文は切らない');

  // 生成側の呼び出しでカタログが無くても落ちないこと
  const generate = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  assert(/buildQaBlockForTopic/.test(generate), '生成側から呼ばれている');
  assert(/Q&Aの参照に失敗（添付なしで続行）/.test(generate), '失敗しても生成を止めない');
  assert((generate.match(/buildQaBlockForTopic\(/g) || []).length >= 3,
    '通常生成と差し戻し再生成の両方で使われている');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
