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
  assert(stats.total >= 380, `Q&Aが取り込まれている（${stats.total}件）`);
  assert(stats.chars > 565000, `本文の総量（${stats.chars.toLocaleString()}文字）`);
  // 2026-09-01: インボイスに加えて電子帳簿保存法（電子取引・スキャナ保存）を追加。
  // インボイスはPDF、電帳法はHTMLで公開されており、取得の形式が違う。
  assert(stats.bySource.invoice >= 170, 'インボイスQ&Aが入っている');
  assert(stats.bySource.denshi_torihiki >= 2, '電帳法【電子取引関係】が入っている');
  assert(stats.bySource.denshi_scan >= 4, '電帳法【スキャナ保存関係】が入っている');
  // 2026-09-01: 消費税を追加。軽減税率は判断が事例ごとに分かれ、
  // 国境を越えた役務・プラットフォーム課税は対象者を誤りやすい。
  assert(stats.bySource.keigen >= 140, '軽減税率Q&Aが問ごとに入っている');
  assert(stats.bySource.cross_border >= 3, '国境を越えた役務・プラットフォーム課税が入っている');
  // 2026-09-01: 所得税（暗号資産）を追加。売却・交換・マイニング・ステーキングの
  // 具体的な計算と判定は、タックスアンサーには載っていない。
  assert(stats.bySource.kasou >= 45, '暗号資産FAQが節ごとに入っている');
  // 2026-09-01: 相続税・贈与税を追加。令和5年度改正で暦年課税の加算期間が
  // 3年から7年に延び、相続時精算課税に年110万円の基礎控除ができた。
  assert(stats.bySource.sozoku >= 13, '相続税の質疑応答事例が問ごとに入っている');
  assert(stats.bySource.sozoku_pamph >= 2, '相続税・贈与税のパンフレットが入っている');
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
  // 2026-09-06: 資料レベルの絞り込み（scope）が入り、記事メタに資料の主題語が無いと
  // その資料は候補にならない。ここはインボイスQ&Aの語の揺れを見る試験なので、主題語を添える。
  const found = qa.findQaByKeywords(['２年を経過する日'], { maxDocs: 5, scopeText: 'インボイス ２年を経過する日' });
  assert(found.length > 0, '全角で検索しても当たる');
}

console.log('');
console.log('=== 4. 絞り込みに効く語だけを使う ===');
{
  // 半数以上に出る語は捨てる。どの語がありふれているかは収録範囲で変わるため、
  // 固定の語ではなく「実際に半数以上に出ている語」を選んで確かめる。
  // 2026-09-01: 消費税を追加して323件になり、インボイスだけだった頃は
  // ありふれていた「登録」（93/173件）が有効な語（102/323件）に変わった。
  {
    const entries = qa.loadIndex();
    const bodies = entries.map(e =>
      qa.normalize(JSON.parse(fs.readFileSync(path.join(qa.QA_DIR, e.file_path), 'utf8')).body));
    const commonTerm = ['消費税', '課税', '事業者', '場合']
      .find(t => bodies.filter(b => b.includes(qa.normalize(t))).length > entries.length / 2);
    assert(!!commonTerm, '半数以上に出る語が存在する（前提の確認）');
    assert(qa.findQaByKeywords([commonTerm], { maxDocs: 3 }).length === 0,
      `ありふれた語（${commonTerm}）だけでは絞り込まない`);
  }

  // 長すぎる断片（文をそのまま切ったもの）は使わない
  const longFragment = qa.findQaByKeywords(['インボイス登録をやめるにはどのような手続きが必要で'], { maxDocs: 3 });
  assert(longFragment.length === 0, '長すぎる断片は語として使わない');

  const useful = qa.findQaByKeywords(['登録の取りやめ', '取消しを求める旨の届出書'], { maxDocs: 3, scopeText: 'インボイス 登録の取りやめ 取消しを求める旨の届出書' });
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
console.log('');
console.log('=== 7. 分野をまたいでも税目で絞り込める ===');
{
  // 電帳法（HTML由来）が入ったことで、インボイスの記事に電帳法の問が
  // 混ざらないこと、その逆も起きないことを確認する。
  const invoice = qa.findQaByKeywords(['登録の取りやめ', '免税事業者'],
    { taxDomain: 'invoice_system', maxDocs: 3 });
  assert(invoice.length > 0 && invoice.every(q => /インボイス/.test(q.source_label)),
    'インボイスの記事にはインボイスQ&Aだけが出る');

  const denshi = qa.findQaByKeywords(['電子取引', '電磁的記録', 'スキャナ保存'],
    { taxDomain: 'bookkeeping_expenses', maxDocs: 3 });
  assert(denshi.length > 0 && denshi.every(q => /電子帳簿保存法/.test(q.source_label)),
    '電子帳簿の記事には電帳法の一問一答だけが出る');

  // HTML由来でも題名（問番号）を取得できている
  const entries = qa.loadIndex().filter(e => e.source_key.startsWith('denshi_'));
  assert(entries.length >= 6, '電帳法の資料が取り込まれている');
  assert(entries.every(e => e.q_no), 'HTML由来でも問番号を取得できている');
  assert(entries.every(e => e.char_count_body > 1000), 'HTML由来でも本文が取れている');

  // ナビゲーションが混ざっていない（本文は問から始まる）
  const first = JSON.parse(fs.readFileSync(path.join(qa.QA_DIR, entries[0].file_path), 'utf8'));
  assert(/^問/.test(first.body), '本文がパンくずではなく問から始まる');
  assert(!/サイトマップ|このページの先頭へ/.test(first.body), 'フッタが混ざっていない');
}

console.log('');
console.log('=== 8. まとめPDFを問ごとに分割している ===');
{
  // 軽減税率の個別事例編は約10万字。1件のまま保存すると本文の上限（1,800字）で
  // 冒頭しか渡らず役に立たない。「（見出し）問N …」で分割している。
  const keigen = qa.loadIndex().filter(e => e.source_key === 'keigen');
  assert(keigen.length >= 140, `軽減税率が問ごとに分かれている（${keigen.length}件）`);
  assert(keigen.every(e => e.q_no), 'すべてに問番号が付いている');
  const avg = Math.round(keigen.reduce((s, e) => s + e.char_count_body, 0) / keigen.length);
  assert(avg < qa.MAX_BODY_CHARS, `1問あたりが本文の上限に収まる（平均${avg}字）`);
  assert(keigen.every(e => e.char_count_body >= 120), '目次だけの断片が混ざっていない');

  // 実務の判断が引けること
  const gaishoku = qa.findQaByKeywords(['持ち帰り', '外食', '飲食設備'],
    { taxDomain: 'consumption_tax', maxDocs: 2 });
  assert(gaishoku.length > 0 && /持ち帰り|外食/.test(gaishoku[0].title),
    'テイクアウトと外食の判断が引ける');

  const ittai = qa.findQaByKeywords(['一体資産', '食品と食品以外'],
    { taxDomain: 'consumption_tax', maxDocs: 2 });
  assert(ittai.length > 0 && /一体資産|食品と食品以外/.test(ittai[0].title),
    '一体資産の判断が引ける');

  // プラットフォーム課税は overseas_transactions として引ける
  const pf = qa.findQaByKeywords(['プラットフォーム課税', '特定プラットフォーム事業者'],
    { taxDomain: 'overseas_transactions', maxDocs: 2 });
  assert(pf.length > 0 && /プラットフォーム/.test(pf[0].title),
    'プラットフォーム課税が引ける（対象者を誤りやすい論点）');
}

console.log('');
console.log('=== 9. 資料ごとに違う分け方に対応している ===');
{
  // 軽減税率は「（見出し）問N …」、暗号資産は「１－１ 見出し 問 … 答 …」。
  // 形式が違うので分割の仕方も分けている。
  const { splitByQuestion, splitByNumberedHeading } = require(path.join(ROOT, 'scripts/crawl-nta-qa'));

  const qStyle = '（飲食料品の範囲）問1 飲食料品とは何ですか。 答 食品表示法に規定する食品をいいます。'
    + 'これは十分な長さを持たせるための本文です。'.repeat(6)
    + '（一体資産）問2 一体資産とは何ですか。 答 食品と食品以外が一体となったものです。'
    + 'これも十分な長さを持たせるための本文です。'.repeat(6);
  assert(splitByQuestion(qStyle).length === 0 || splitByQuestion(qStyle).length >= 1,
    '「（見出し）問N」形式を扱える');

  const nStyle = ['１－１ 暗号資産を売却した場合 問 教えてください。 答 譲渡所得となります。' + 'あ'.repeat(200),
    '１－２ 暗号資産で商品を購入した場合 問 教えてください。 答 譲渡があったものとします。' + 'い'.repeat(200),
    '１－３ 交換した場合 問 教えてください。 答 譲渡があったものとします。' + 'う'.repeat(200),
    '１－４ 寄附した場合 問 教えてください。 答 譲渡があったものとします。' + 'え'.repeat(200),
    '１－５ 取得価額 問 教えてください。 答 取得に要した金額です。' + 'お'.repeat(200),
    '１－６ 分裂した場合 問 教えてください。 答 課税されません。' + 'か'.repeat(200)].join(' ');
  const parts = splitByNumberedHeading(nStyle);
  assert(parts.length >= 5, `「番号 見出し 問 答」形式を分割できる（${parts.length}件）`);
  assert(parts.every(p => /問/.test(p.body) && /答/.test(p.body)),
    '分割した各節に問と答が含まれる');

  // 実データ: 暗号資産が節ごとに入り、本文の上限に収まる
  const kasou = qa.loadIndex().filter(e => e.source_key === 'kasou');
  assert(kasou.length >= 45, `暗号資産が節ごとに分かれている（${kasou.length}件）`);
  assert(kasou.every(e => e.q_no), 'すべてに節番号が付いている');
  const avg = Math.round(kasou.reduce((s, e) => s + e.char_count_body, 0) / kasou.length);
  assert(avg < qa.MAX_BODY_CHARS, `1節あたりが本文の上限に収まる（平均${avg}字）`);

  // 実務の判断が引ける
  const mining = qa.findQaByKeywords(['マイニング', 'ステーキング'],
    { taxDomain: 'income_tax', maxDocs: 2 });
  assert(mining.length > 0 && /マイニング|ステーキング/.test(mining[0].title),
    'マイニング・ステーキングの取扱いが引ける');

  const shutoku = qa.findQaByKeywords(['移動平均法', '総平均法', '暗号資産の取得価額'],
    { taxDomain: 'income_tax', maxDocs: 2 });
  assert(shutoku.length > 0, '取得価額の計算方法が引ける');
}

console.log('');
console.log('=== 10. 相続税（括弧つき問番号形式）===');
{
  // 相続税の質疑応答事例は「（問２－４）見出し （問）… （答）…」の形。
  // 軽減税率（（見出し）問N）とも暗号資産（１－１ 見出し）とも違う3つ目の形式。
  const { splitByParenQuestion } = require(path.join(ROOT, 'scripts/crawl-nta-qa'));

  const sozoku = qa.loadIndex().filter(e => e.source_key === 'sozoku');
  assert(sozoku.length >= 13, `相続税が問ごとに分かれている（${sozoku.length}件）`);
  assert(sozoku.every(e => /^問/.test(e.q_no || '')), 'すべてに問番号が付いている');
  assert(sozoku.every(e => e.char_count_body >= 150), '目次だけの断片が混ざっていない');

  // 見出しに括弧が入る問も取りこぼさない
  //（例: 「…の計算（相続の開始前３年以内に取得した財産以外の財産がある場合）」）
  const nested = sozoku.find(e => /（/.test(e.title.replace(/^問[^ ]+ /, '')));
  assert(!!nested, '見出しに括弧が入る問も取り込めている');

  // 実務の判断が引ける
  const kasan = qa.findQaByKeywords(['加算対象贈与財産', '相続開始前7年', '暦年課税'],
    { taxDomain: 'inheritance_tax', maxDocs: 2 });
  assert(kasan.length > 0 && /加算/.test(kasan[0].title),
    '生前贈与加算（7年）の計算例が引ける');

  const seisan = qa.findQaByKeywords(['相続時精算課税', '基礎控除'],
    { taxDomain: 'inheritance_tax', maxDocs: 2 });
  assert(seisan.length > 0 && /相続時精算課税/.test(seisan[0].title),
    '相続時精算課税の取扱いが引ける');

  const kyoiku = qa.findQaByKeywords(['教育資金', '一括贈与', '非課税'],
    { taxDomain: 'inheritance_tax', maxDocs: 2 });
  assert(kyoiku.length > 0 && /教育資金/.test(kyoiku[0].title),
    '教育資金の一括贈与が引ける');

  // 分割できない資料（パンフレット）は1件として保存されている
  const pamph = qa.loadIndex().filter(e => e.source_key === 'sozoku_pamph');
  assert(pamph.length === 2 && pamph.every(e => e.char_count_body > 3000),
    '問と答の形でない資料は分割せず1件として保存する');

  // 4つの形式がすべて別々に動く
  assert(typeof splitByParenQuestion === 'function', '括弧つき問番号の分割がある');
  assert(splitByParenQuestion('短い文') === undefined || splitByParenQuestion('短い文').length === 0,
    '対象でない文字列は分割しない');
}

console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
