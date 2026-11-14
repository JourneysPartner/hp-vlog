'use strict';

// 「十分」「不十分」の十を数として読まないことと、AI の引用を 200 字で切らないことの回帰確認。
// 通信と本物の AI は使わない。
const assert = require('assert/strict');
const F = require('../fact-check');
const page = require('../../../netlify/functions/review-page');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const now = new Date('2026-11-13T00:00:00Z');
const NOTE = '<div class="small text-muted">この引用は 200 字ちょうどのため、記録の時点で切れている可能性があります（2026-11-13 より前の記録は先頭 200 字だけを残していました）。続きは資料のリンク先で確かめてください。</div>';

function judge(sentence, text, quote, options = {}) {
  const c = { id: 'c1', sentence, claim: options.claim ?? sentence, type: options.type || '期限', subject: '制度', heading: '制度' };
  const source = { id: '資料1', kind: 'taxanswer', no: '2024', title: '制度の原文', url: 'https://example.jp/制度', law_version: '', text };
  const exists = F.normalizedQuote(text).includes(F.normalizedQuote(quote));
  return exists && F.sufficientQuote(c, { quote, correct: options.correct || '' }, source, '裏付けあり') ? '裏付けあり' : '資料なし';
}

function pageRecord(quote) {
  const evidence = [{ id: 'e1', kind: 'taxanswer', no: '1', title: '資料1', url: 'https://example.jp/1', law_version: '', text: '制度の説明です。' }];
  const original = { id: 'c1', sentence: '制度の説明です。', claim: '制度の説明です。', type: '金額', subject: '制度', heading: '制度', s: 1,
    reject_reason: '引用が短い・数字が引用の近くに無い',
    rejected_answer: { status: '裏付けあり', evidence: 'e1', basis: '1', quote }, evidence };
  const correction = { id: 'c1', generalized: true, resolved: true, before: '制度の説明です。', after: '国税庁で確認してください。' };
  const reviewItem = { ...original, status: 'AI は裏付けあり（数字は機械で確かめられなかった）' };
  return { status: 'ok', slug: 'jubun-quote', claims: [original], corrections: [correction], remaining: [], review_items: [reviewItem] };
}

// 「人が確かめる箇所」を空にして、「資料が無く案内に変えた」欄だけが引用を出す記録。
function pageRecordGeneralizedOnly(quote) {
  return { ...pageRecord(quote), review_items: [] };
}

test('1', 'R1 の表: 「十分」「不十分」を数として読まない（T1・T2・T5）', () => {
  for (const [text, expected] of [
    ['十分', []],
    ['不十分', []],
    ['十分な', []],
    ['十分に', []],
    ['十分である', []],
    ['十分間', []],
    ['十分の配慮', []],
    ['不十分な場合は10%', ['割合:1/10']],
  ]) assert.deepEqual(F.normalizedNumbers(text), expected, text);
  for (const [text, expected] of [
    ['十分の一', ['割合:1/10']],
    ['十分の1', ['割合:1/10']],
    ['十分の三', ['割合:3/10']],
    ['二十分の一', ['割合:1/20']],
    ['数十分の一', []],
    ['三十分', ['30']],
    ['百十分', ['110']],
    ['10分', ['10']],
    ['10分の1', ['割合:1/10']],
    ['第十条', ['10']],
    ['十年', ['10']],
    ['十人', ['10']],
    ['十万円', ['100000']],
    ['十%', ['割合:1/10']],
    ['十割', ['割合:1/1']],
    ['五分五分', ['5', '5']],
    ['百分率', ['100']],
    ['一般の一定の要件', []],
  ]) assert.deepEqual(F.normalizedNumbers(text), expected, text);
  // 「十分の一定」は直す前と同じ照合不能のまま。
  assert.deepEqual(F.normalizedNumbers('十分の一定'), [null]);
});

test('2', '#768 の文が通る（T3）', () => {
  const text = '4 令和6年1月1日以後に法定申告期限が到来するもの（令和5年分以降）について、税務署の調査において、帳簿の提示または提出を求められた際に帳簿の提示等をしなかった場合および帳簿への売上金額の記載等が本来記載等をすべき金額の2分の1未満だった場合は、納付すべき税金に10パーセントの割合を乗じて計算した金額が無申告加算税に加算されます。また、帳簿への売上金額の記載等が本来記載等をすべき金額の3分の2未満だった場合は、納付すべき税金に5パーセントの割合を乗じて計算した金額が無申告加算税に加算されます。';
  const sentence = 'さらに、帳簿への売上記載が不十分だった場合は上記に5%または10%が加算され、隠蔽や仮装があったと判断されれば、無申告加算税に代えて重加算税（40%）が課されます。';
  assert.equal(judge(sentence, text, text, { type: '割合', claim: '帳簿への売上記載が不十分な場合、無申告加算税に5%または10%が加算される' }), '裏付けあり');
});

test('3', '数字の確かめは残る（T3）', () => {
  const text = '4 令和6年1月1日以後に法定申告期限が到来するもの（令和5年分以降）について、税務署の調査において、帳簿の提示または提出を求められた際に帳簿の提示等をしなかった場合および帳簿への売上金額の記載等が本来記載等をすべき金額の2分の1未満だった場合は、納付すべき税金に10パーセントの割合を乗じて計算した金額が無申告加算税に加算されます。また、帳簿への売上金額の記載等が本来記載等をすべき金額の3分の2未満だった場合は、納付すべき税金に5パーセントの割合を乗じて計算した金額が無申告加算税に加算されます。';
  const sentence = '帳簿への売上記載が不十分な場合は5%または20%が加算されます。';
  assert.equal(judge(sentence, text, text, { type: '割合', claim: '帳簿への売上記載が不十分な場合、無申告加算税に5%または20%が加算される' }), '資料なし');
});

test('4', '両方に「不十分」がある文は今までどおり通る（T3）', () => {
  const text = '売上げに関する帳簿の記載が不十分であったことなどが税務調査において把握された場合には、通常課される加算税の割合に5パーセントまたは10パーセントが加重されることとなりました。';
  const sentence = '売上の記載が不十分だと、通常の加算税に5%または10%が上乗せされます。';
  assert.equal(judge(sentence, text, text, { type: '割合', claim: sentence }), '裏付けあり');
});

test('5', '逆向きの穴を塞ぐ（T4）', () => {
  const text = '帳簿の記載が十分でない場合は、調査で説明を求められます。';
  const sentence = '帳簿の保存期間は10年です。';
  for (const type of ['期限', '金額']) assert.equal(judge(sentence, text, text, { type }), '資料なし', type);
});

test('6', '読めない割合が消えても数字は確かめる（T5）', () => {
  const text = '十分の配慮が必要です。控除は10万円です。';
  const quote = '控除は10万円です。';
  assert.equal(judge('控除は10万円です。', text, quote, { type: '金額' }), '裏付けあり');
  assert.equal(judge('控除は20万円です。', text, quote, { type: '金額' }), '資料なし');
});

test('7', '記録に全文が残る（T6）', async () => {
  const source = '基礎控除は110万円です' + '原文の説明'.repeat(45) + '。';
  const claim = { id: 'c1', sentence: '基礎控除は120万円です。', claim: '基礎控除は120万円です。', type: '金額', subject: '制度', heading: '' };
  const ref = { id: 'e1', kind: 'taxanswer', text: source, title: 'e1', url: 'https://example.jp/e1', law_version: '' };
  const options = { now, loadEvidenceText: () => source };
  const long = (await F.judgeClaims([claim], { c1: [ref] }, claim.sentence, async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options))[0];
  assert.equal(long.status, '資料なし');
  assert.equal(long.rejected_answer.quote.length, source.length);
  assert.ok(long.rejected_answer.quote.length > 200);
  const bad = (await F.judgeClaims([claim], { c1: [ref] }, claim.sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 99, basis: '1234567890'.repeat(8) }], options))[0];
  assert.equal(bad.rejected_answer.basis.length, 40);
});

test('8', '画面は全文を出す（T7）', () => {
  const quote = '<script>alert("x")</script>' + '引'.repeat(220);
  const record = pageRecord(quote);
  const detail = page.renderFactCheck({}, record), summary = page.renderFactCheckSummary({}, record);
  for (const html of [detail, summary]) {
    assert.ok(html.includes('引'.repeat(220)));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes(NOTE), false);
  }
  const exact = pageRecord('あ'.repeat(200));
  assert.ok(page.renderFactCheck({}, exact).includes(NOTE));
  assert.ok(page.renderFactCheckSummary({}, exact).includes(NOTE));
  for (const length of [199, 201]) {
    const other = pageRecord('あ'.repeat(length));
    assert.equal(page.renderFactCheck({}, other).includes(NOTE), false, `${length} 字`);
    assert.equal(page.renderFactCheckSummary({}, other).includes(NOTE), false, `${length} 字`);
  }
  // 人が確かめる箇所を空にしても、「資料が無く案内に変えた」欄（renderGeneralizedAnswer）だけで
  // 全文・エスケープ・書き添えが揃うことを単独で確かめる。
  const onlyHtml = page.renderFactCheck({}, pageRecordGeneralizedOnly(quote));
  assert.ok(onlyHtml.includes('引'.repeat(220)), '案内に変えた欄: 220 字の引用が全文で出る');
  assert.ok(onlyHtml.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), '案内に変えた欄: <script> をエスケープして出す');
  assert.equal(onlyHtml.includes('<script>'), false, '案内に変えた欄: <script> をそのまま出さない');
  assert.equal(onlyHtml.includes(NOTE), false, '案内に変えた欄: 220 字には書き添えを出さない');
  assert.ok(page.renderFactCheck({}, pageRecordGeneralizedOnly('あ'.repeat(200)))
    .includes(`<blockquote>${'あ'.repeat(200)}</blockquote>${NOTE}`), '案内に変えた欄: 200 字ちょうどには書き添えを出す');
  for (const length of [199, 201]) {
    const other = page.renderFactCheck({}, pageRecordGeneralizedOnly('あ'.repeat(length)));
    assert.equal(other.includes(NOTE), false, `案内に変えた欄: ${length} 字には書き添えを出さない`);
    assert.equal(other.includes(`</blockquote>${NOTE}`), false, `案内に変えた欄: ${length} 字の引用の直後に書き添えを出さない`);
  }
});

test('9', '版（R3）', async () => {
  const result = await F.checkFacts('', { enabled: true, now, provider: 'anthropic', model: 'claude-opus-5-5', writer_materials: [],
    callLLM: async () => { throw new Error('空本文で AI を呼ばない'); } });
  assert.equal(result.record.logic_version, 'plan2-s10');
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); passed++; console.log(`PASS ${t.group}: ${t.name}`); }
    catch (error) { failed++; console.error(`FAIL ${t.group}: ${t.name}\n${error.stack}`); }
  }
  console.log(`PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
})();
