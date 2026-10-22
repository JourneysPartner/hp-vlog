'use strict';

// 10/16 の記録を変更せず、実際の表示経路と承認に関わる表示を検証する。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const page = require('../../../netlify/functions/review-page');
const github = require('../../../netlify/functions/lib/github-api');
const { bodyHash, compactRecord } = require('../fact-check');

const fixtureDir = path.resolve(__dirname, '../../../docs/codex-tasks/review-page-layout/fixtures');
const filename = '2026-10-16-gift-cash-procedure-tax-return.md';
const { meta, body } = page.parseFrontmatter(fs.readFileSync(path.join(fixtureDir, filename), 'utf8'));
const record = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gift-cash-procedure-tax-return.json'), 'utf8'));
const originalRecord = JSON.stringify(record);
const screens = [];
let passed = 0;
let failed = 0;
let summaryLength;

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function textOnly(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function draw(screenMeta, screenRecord, markdown = '確認用の本文です。') {
  const htmlBody = marked(markdown).replace(/<table>/g, '<div class="table-wrapper"><table>')
    .replace(/<\/table>/g, '</table></div>');
  screens.push({ meta: screenMeta, record: screenRecord, htmlBody });
  return page.renderReviewPage(filename, screenMeta, htmlBody, 'draft/test', null, screenRecord);
}

function summary(html) {
  const start = html.search(/<(?:div|p)[^>]*id="factCheckSummary"/);
  assert.ok(start >= 0, '照合の要点がある');
  return html.slice(start, html.indexOf('<!-- メタ情報カード -->', start));
}

function detail(html) {
  const start = html.indexOf('<div class="card mb-4" id="factCheck">');
  assert.ok(start > html.indexOf('id="articleBody"'), '詳細は本文の後ろにある');
  return html.slice(start, html.indexOf('<!-- 修正コメント入力欄 -->', start));
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function makeRecord(extra = {}) {
  return { status: 'ok', body_sha256: bodyHash('確認用の本文です。'), corrections: [], remaining: [], review_items: [], ...extra };
}

// 書式を含む実データの期待値は固定し、実装の整形関数に依存させない。
const expectedEdits = new Map([
  [1, '提出先：もらった人の住所を所轄する税務署'],
  [2, '提出方法：e-Taxのほか、郵便・信書便、税務署の時間外収受箱への投函'],
  [3, '選ぶ場合は別の届出が必要です（後述）。'],
  [21, 'その年に受け取った額の合計で、申告が必要か確認する'],
  [27, '110万円以内 ／ 通常は不要'],
  [28, '110万円を超える ／ 必要'],
  [29, '以内なら、通常は申告不要です。'],
]);
const expectedSentences = record.review_items.map((item, index) => expectedEdits.get(index) || item.sentence);
const fixtureHtml = draw(meta, record, body);

async function test(number, description, run) {
  try { await run(); passed++; console.log(`PASS 試験${number}: ${description}`); }
  catch (error) { failed++; console.error(`FAIL 試験${number}: ${description}\n${error.stack}`); }
}

async function main() {
  await test(1, '実データの要点は600字以内で、35件の文を本文の前に出さない', () => {
    const before = fixtureHtml.slice(0, fixtureHtml.indexOf('id="articleBody"'));
    summaryLength = [...textOnly(summary(fixtureHtml))].length;
    assert.ok(summaryLength <= 600, `要点は${summaryLength}字`);
    assert.equal(record.review_items.length, 35);
    for (const [index, item] of record.review_items.entries()) {
      assert.ok(!before.includes(escape(item.sentence)), `原文${index + 1}を本文前に出さない`);
      assert.ok(!before.includes(escape(expectedSentences[index])), `整形後の文${index + 1}を本文前に出さない`);
    }
    assert.match(summary(fixtureHtml), /href="#factCheck">詳細は本文の後ろ/);
    assert.ok(fixtureHtml.indexOf('id="factCheckSummary"') < fixtureHtml.indexOf('<!-- メタ情報カード -->'));
  });

  await test(2, '実データ35件を本文後ろの閉じた一覧に置き、35・20・15の内訳を示す', () => {
    const details = [...detail(fixtureHtml).matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
    assert.equal(details.length, 1);
    assert.ok(!/\bopen\b/i.test(details[0][1]));
    const content = details[0][2];
    const caption = content.match(/<summary>([\s\S]*?)<\/summary>/)[1];
    assert.match(caption, /人が確かめる箇所 35 件/);
    assert.match(caption, /資料が見つからなかった 20 件/);
    assert.match(caption, /件数の上限で照合しなかった 15 件/);
    assert.match(caption, /承認を止める理由ではありません/);
    assert.equal(occurrences(content, 'class="border rounded p-3 mb-2"'), 35);
    for (const sentence of new Set(expectedSentences)) {
      assert.equal(occurrences(content, `<div>${escape(sentence)}</div>`), expectedSentences.filter(s => s === sentence).length, sentence);
    }
    assert.ok(!/blockquote/.test(content), '引用のない候補の原文全文は出さない');
    assert.equal(JSON.stringify(record), originalRecord, '記録は変更しない');
  });

  await test(3, '実データの太字タグの切れ端と表の区切りを整える', () => {
    assert.ok(!fixtureHtml.includes('&lt;strong&gt;'));
    assert.ok(!fixtureHtml.includes('&lt;/strong&gt;'));
    assert.match(detail(fixtureHtml), /110万円以内 ／ 通常は不要/);
  });

  await test(4, '案内に変えた1件の件数を要点に、前後の文と長い要約を詳細に出す', () => {
    const top = summary(fixtureHtml);
    const bottom = detail(fixtureHtml);
    assert.match(top, /直した 0 件・資料が無く案内に変えた 1 件/);
    assert.ok(!top.includes('主張 58 件'));
    assert.ok(bottom.includes('主張 58 件'));
    assert.ok(bottom.includes(escape(record.corrections[0].before)));
    assert.ok(bottom.includes(escape(record.corrections[0].after)));
    const fixedHeading = bottom.indexOf('<h3 class="h6">直した箇所</h3>');
    const generalizedHeading = bottom.indexOf('<h3 class="h6">資料が無く案内に変えた箇所</h3>');
    const remainingHeading = bottom.indexOf('<h3 class="h6 text-danger">残った食い違い</h3>');
    assert.ok(fixedHeading >= 0 && generalizedHeading > fixedHeading);
    assert.ok(remainingHeading > generalizedHeading);
    assert.ok(bottom.indexOf('<details>') > remainingHeading);

    const mixed = summary(draw({}, makeRecord({ corrections: [
      { before: '修正前', after: '修正後', resolved: true },
      { before: '具体的な文', after: '資料への案内', generalized: true, resolved: true },
    ] })));
    assert.match(mixed, /直した 1 件・資料が無く案内に変えた 1 件/);
  });

  await test('03c-R2', 'Opusの記載なしで外した具体を、既存の具体を外した件数と一覧に表示する', async () => {
    const F=require('../fact-check'),W=require('../writer-materials'),H=require('./fact-pages-test-helpers');
    const rawSource=W.resolveMaterial('ta:4508'),source={...rawSource,text:rawSource.text.split('関連リンク')[0]},before='取消届出の期限は土日祝でも延長されない。',after='取消届出の期限は国税庁で確認してください。';
    const markdown=before+'\n'+['甲','乙','丙','丁'].map(s=>s+'受贈者は18歳以上です。').join('\n');
    const saved=Object.fromEntries(['FACT_CHECK_WRITER_MATERIALS','FACT_CHECK_CONFIRM'].map(k=>[k,process.env[k]]));
    let result;
    try{
      process.env.FACT_CHECK_WRITER_MATERIALS='true';process.env.FACT_CHECK_CONFIRM='true';
      result=await F.checkFacts(markdown,{enabled:true,repair:true,batch:false,provider:'gateway',model:'zai/glm-5.3-flash',writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],findQaByKeywords:()=>[],loadEvidenceText:()=>source.text,callLLM:async req=>{
        if(req.task==='extract')return [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m=>({s:+m[1],type:'要件',subject:'住宅取得等資金の贈与の非課税',claim:m[2]}));
        const claims=JSON.parse(req.user).claims;
        if(req.task==='condition_check')return {verdict:'一致',conditions:[],correct:''};
        if(req.task==='confirm')return claims.map(c=>({id:c.id,verdict:'記載なし',replacement:after}));
        const page=H.materials(req).find(p=>p.url===source.url),unit=page.rows.find(u=>u.text.includes('18歳以上'));
        return claims.map(c=>c.claim===before?{id:c.id,status:'資料なし'}:{id:c.id,status:'裏付けあり',evidence_id:page.number,basis:String(unit.s)});
      }});
    }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
    assert.equal(result.record.status,'ok');assert.equal(result.record.corrections[0].confirm.verdict,'記載なし');
    const html=draw({},result.record,result.body);assert.match(summary(html),/直した 0 件・資料が無く案内に変えた 1 件/);
    const list=detail(html).split('<h3 class="h6">資料が無く案内に変えた箇所</h3>')[1];assert(list);assert(list.includes(escape(before)));assert(list.includes(escape(after)));
  });

  await test(5, '食い違い・資料なし・差し止め・未実施・古い記録・読めない記録を本文前に開いて出す', async () => {
    const cases = [
      { record: makeRecord({ remaining: [{ sentence: '**誤った金額**', status: '食い違い', correct: '正しい金額', evidence: [{ title: '根拠の資料', url: 'https://example.jp/source' }] }] }), words: ['誤った金額', '正しい金額', '根拠の資料', 'https://example.jp/source'], color: 'alert-danger' },
      { record: makeRecord({ remaining: [{ sentence: '期限の記述', status: '期限の書き漏れ', correct: '正しい期限' }] }), words: ['期限の記述', '正しい期限'], color: 'alert-danger' },
      { record: makeRecord({ remaining: [{ sentence: '未解決の文', status: '資料なし' }] }), words: ['資料なしの記述が未解決です。', '未解決の文'], color: 'alert-warning' },
      { record: makeRecord({ status: 'revise' }), words: ['要修正', '照合で承認が止まっています'], color: 'alert-danger' },
      ...[true, 'true'].map(value => ({ meta: { fact_check_blocking: value }, record: makeRecord(), words: ['照合で承認が止まっています'], color: 'alert-danger' })),
      { record: makeRecord({ status: 'not_run' }), words: ['未実施'], color: 'alert-warning' },
    ];
    const savedGet = github.getFile;
    try {
      github.getFile = async () => ({ content: JSON.stringify({ version: 1, slug: 'layout-test', ...makeRecord() }) });
      const stale = await page.fetchFactCheck('layout-test', 'draft/test', '変わった本文です。');
      assert.equal(stale.stale, true);
      cases.push({ record: stale, words: ['この記録は今の本文と一致しません（古い記録）'], color: 'alert-warning' });
      github.getFile = async () => { throw new Error('503 読み込み失敗'); };
      cases.push({ record: await page.fetchFactCheck('layout-test', 'draft/test', body), words: ['照合の記録を読めませんでした'], color: 'alert-warning' });
    } finally { github.getFile = savedGet; }
    for (const scenario of cases) {
      const html = draw(scenario.meta || {}, scenario.record);
      const top = summary(html);
      for (const word of scenario.words) assert.ok(top.includes(word), word);
      assert.ok(top.includes(scenario.color));
      assert.ok(!top.includes('<details'), '止める理由を畳まない');
      assert.ok(html.indexOf(top) < html.indexOf('id="articleBody"'));
    }
    assert.match(page.renderFactCheckSummary({}, makeRecord(), '変わった本文です。'), /古い記録/);
    assert.ok(!summary(draw({ fact_check_blocking: 'false' }, makeRecord())).includes('照合で承認が止まっています'));
    assert.match(summary(draw({ fact_check_blocking: true }, null)), /照合で承認が止まっています/);
  });

  await test(6, '記録なしは一行表示し、記事情報が未実施なら本文前に状態と黄色の警告を出す', () => {
    const html = draw({}, null);
    assert.equal(summary(html).trim(), '<p id="factCheckSummary">照合の記録なし</p>');
    assert.equal(textOnly(summary(html)), '照合の記録なし');

    const notRunHtml = draw({ fact_check_status: 'not_run' }, null);
    const top = summary(notRunHtml);
    assert.match(top, /<p><strong>状態:<\/strong> 未実施<\/p>/);
    assert.ok(top.includes('<div class="alert alert-warning">未実施</div>'));
    assert.ok(notRunHtml.indexOf(top) < notRunHtml.indexOf('id="articleBody"'));
    assert.ok(!top.includes('<details'), '未実施の警告を畳まない');
    // この画面も試験7に含め、通常記事と更新案の承認ボタンの条件を検証する。
  });

  await test(7, '試験1〜6の画面で承認ボタンの条件を維持し、更新案の案内と変更箇所も先頭に保つ', () => {
    for (const screen of screens) {
      for (const variant of [
        { meta: screen.meta, ref: 'draft/test', context: null, disabled: false },
        { meta: { ...screen.meta, refresh_of: 'published' }, ref: 'draft/test', context: null, disabled: true },
        { meta: screen.meta, ref: 'draft/refresh-test', context: { available: false }, disabled: true },
        { meta: { ...screen.meta, refresh_of: 'published' }, ref: 'draft/refresh-test', context: { available: true, diff: [] }, disabled: false },
      ]) {
        const html = page.renderReviewPage(filename, variant.meta, screen.htmlBody, variant.ref, variant.context, screen.record);
        const button = html.match(/<button\b[^>]*id="btnApprove"[^>]*>/)[0];
        assert.equal(/\sdisabled(?:\s|>)/.test(button), variant.disabled);
        if (variant.ref.startsWith('draft/refresh-') || variant.meta.refresh_of === 'published') {
          assert.ok(html.indexOf('公開中の記事の更新案です') < html.indexOf('変更箇所</div>'));
          assert.ok(html.indexOf('変更箇所</div>') < html.indexOf('id="factCheckSummary"'));
          assert.ok(html.indexOf('変更箇所</div>') < html.indexOf('事実の照合</div>'));
        }
      }
    }
  });

  await test(8, '指定した書式だけ除き、その他のタグをエスケープして危険な候補リンクを出さない', () => {
    const values = [
      ['<strong class="x" title="a > b">太字</strong>', '太字'],
      ['<EM>強調</EM><b>太字</b><i>斜体</i><u>下線</u><mark>印</mark><span data-x="1">範囲</span><br/><a href="javascript:alert(1)">リンク</a><sup>上</sup><sub>下</sub>', '強調太字斜体下線印範囲リンク上下'],
      ['</strong>切れ端', '切れ端'], ['**強調**と__強調__', '強調と強調'],
      ['- 項目', '項目'], ['* 項目', '項目'], ['+ 項目', '項目'], ['1. 項目', '項目'], ['2) 項目', '項目'],
      ['| 金額 | 必要な手続 |', '金額 ／ 必要な手続'],
      ['<script>記述</script><img src=x onerror="alert(1)"><stronger>維持</stronger>', '<script>記述</script><img src=x onerror="alert(1)"><stronger>維持</stronger>'],
      ['<strong></strong>', '<strong></strong>'], ['**', '**'],
    ];
    for (const [input, expected] of values) {
      const data = makeRecord({
        corrections: [{ before: input, after: input, resolved: true }],
        remaining: [{ sentence: input, status: '食い違い', correct: '正しい内容' }],
        review_items: [{ sentence: input, status: '資料なし', type: '<種類>', subject: '<制度>', heading: '<見出し>', evidence: [
          { title: '<候補>', url: 'https://example.jp/?a="&b=1', law_version: '<版>' },
          { title: '危険な候補', url: 'javascript:alert(1)' },
        ] }],
      });
      for (const saved of [data, compactRecord(data)]) {
        const html = draw({}, saved);
        const top = summary(html);
        const bottom = detail(html);
        assert.ok(top.includes(escape(expected)), input);
        assert.ok(bottom.includes(`<strong>前:</strong> ${escape(expected)}`), input);
        assert.ok(bottom.includes(`<strong>後:</strong> ${escape(expected)}`), input);
        assert.ok(bottom.includes(`<div>${escape(expected)}</div>`), input);
        for (const escaped of ['&lt;種類&gt;', '&lt;制度&gt;', '&lt;見出し&gt;', '&lt;候補&gt;', '&lt;版&gt;']) assert.ok(bottom.includes(escaped));
        assert.ok(!html.includes('javascript:'));
        assert.ok(bottom.includes('href="https://example.jp/?a=&quot;&amp;b=1"'));
        assert.ok(!bottom.includes('<script>記述') && !bottom.includes('<img src=x'));
        assert.match(bottom, /見た資料: <a[^>]*>&lt;候補&gt;<\/a>（&lt;版&gt;）・危険な候補<\/div>/);
      }
    }
    const quoted = detail(draw({}, makeRecord({ review_items: [{ sentence: '引用つきの文', status: '資料なし', quote: '引用', evidence_id: 'e1', evidence: [
      { id: 'e1', title: '引用元', text: '前後の引用を表示する' }, { id: 'e2', title: '別候補', text: '別候補の引用は出さない' },
    ] }] })));
    assert.equal(occurrences(quoted, '<blockquote>'), 1);
    assert.ok(quoted.includes('<blockquote>前後の引用を表示する</blockquote>'));
    assert.ok(!quoted.includes('別候補の引用は出さない'));
  });

  await test(9, '状態を3群に分け、見出しの重複を避け、記事順と記録順を保つ', () => {
    const unknown = '<未定&"状態>';
    const items = [
      { sentence: '記事で後の文', status: '資料なし', heading: '共通の見出し', s: 20 },
      { sentence: '記事で先の文', status: '資料なし', heading: '共通の見出し', s: 10 },
      { sentence: '上限の文', status: '上限で未照合', heading: '別の見出し', s: 30 },
      { sentence: '未知の文', status: unknown, heading: '未知の見出し', s: 40 },
    ];
    const html = draw({}, makeRecord({ review_items: items }));
    const bottom = detail(html);
    assert.match(bottom, /<h4 class="h6">資料が見つからなかった記述<\/h4>/);
    assert.match(bottom, /<h4 class="h6">件数の上限で照合しなかった記述<\/h4>/);
    assert.ok(bottom.includes(`<h4 class="h6">${escape(unknown)}</h4>`));
    assert.equal(occurrences(bottom, '<h4 '), 3);
    assert.equal(occurrences(bottom, '<h5 class="h6">共通の見出し</h5>'), 1);
    assert.ok(bottom.indexOf('記事で先の文') < bottom.indexOf('記事で後の文'));
    assert.match(summary(html), /人が確かめる箇所 4 件（資料が見つからなかった 2 件・件数の上限で照合しなかった 1 件/);
    assert.ok(summary(html).includes(`${escape(unknown)} 1 件`));

    const grouped = detail(draw({}, makeRecord({ review_items: [
      { sentence: '後の見出しの文', status: '資料なし', heading: '後の見出し', s: 50 },
      { sentence: '先の見出しの文', status: '資料なし', heading: '先の見出し', s: 1 },
    ] })));
    assert.ok(grouped.indexOf('<h5 class="h6">先の見出し') < grouped.indexOf('<h5 class="h6">後の見出し'));
    const unsorted = detail(draw({}, makeRecord({ review_items: [
      { sentence: '記録で先の文', status: '資料なし', heading: '共通' },
      { sentence: '記録で後の文', status: '資料なし', heading: '共通' },
    ] })));
    assert.ok(unsorted.indexOf('記録で先の文') < unsorted.indexOf('記録で後の文'));
    for (const status of ['constructor', '__proto__']) {
      const special = draw({}, makeRecord({ review_items: [{ sentence: '未知の状態の文', status, heading: '見出し' }] }));
      assert.ok(detail(special).includes(`<h4 class="h6">${status}</h4>`));
      assert.ok(summary(special).includes(`${status} 1 件`));
    }
    assert.equal(JSON.stringify(record), originalRecord);
  });

  console.log(`実データ: 本文前の照合 ${summaryLength} 字 / 本文後ろの折り畳み一覧 ${record.review_items.length} 件`);
  console.log(`試験1〜9: PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
