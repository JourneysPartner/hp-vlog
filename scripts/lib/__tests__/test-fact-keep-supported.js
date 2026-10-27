'use strict';

// 実記録の再現と境界条件。通信と本物の LLM は使わない。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const F = require('../fact-check');
const H = require('./fact-pages-test-helpers');
const page = require('../../../netlify/functions/review-page');
const fixture = require('../../../docs/codex-tasks/fact-keep-supported/fixtures/644-record-36b726eb.json');
const filename = require.resolve('../fact-check');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.partialQuoteNumbers = partialQuoteNumbers;', filename);
const partialQuoteNumbers = loaded.exports.partialQuoteNumbers;
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const restoreClaim = id => {
  const c = fixture.claims.find(c => c.id === id);
  return { ...c, evidence: F.evidenceRefs(fixture, c) };
};
const c16 = restoreClaim('c16'), c35 = restoreClaim('c35'), c45 = restoreClaim('c45');
const ref4452 = c16.evidence.find(e => e.no === '4452');
const ref4508 = c45.evidence.find(e => e.id === c45.evidence_id);
const quote = c16.rejected_answer.quote;
const sums = [{ number: '21100000', parts: ['1100000', '20000000'] }];
const amountClaim = (sentence, extra = {}) => ({ ...c16, sentence, claim: sentence, ...extra });
const source = text => ({ id: 'sum-source', kind: 'taxanswer', no: '9999', title: '試験資料', url: 'https://example.invalid/sum', text });
const supports = (claim, ref = ref4452, q = quote, status = '裏付けあり', correct = '') => F.sufficientQuote(claim, { quote: q, correct }, ref, status);

test('1', 'c16 の金額を同じ引用の二つの金額の合計で裏付ける', () => {
  const recorded = [];
  assert.equal(F.sufficientQuote(c16, { quote, correct: '' }, ref4452, '裏付けあり', recorded), true);
  assert.deepEqual(recorded, sums);
});
for (const [name, sentence] of [
  ['(a) 合計の語が無い', '基礎控除110万円があり、2,110万円まで非課税での贈与が可能です。'],
  ['(b) 合計が違う', '基礎控除110万円と合わせて、合計2,210万円まで非課税での贈与が可能です。'],
  ['(c) 足す数が文に無い', '合計2,110万円まで非課税での贈与が可能です。'],
]) test('1', name, () => assert.equal(supports(amountClaim(sentence)), false));
for (const type of ['割合', '期限', '適用年']) test('1', `(d) ${type} は合計で補わない`, () => {
  assert.equal(supports({ ...c16, type }), false);
});
for (const status of ['食い違い', '期限の書き漏れ']) test('1', `(e) ${status} の correct は合計で補わない`, () => {
  assert.equal(supports(c16, ref4452, quote, status, '合計2,110万円'), false);
});
test('1', '(f) 前後300字の外にしか無い加数を採らない', () => {
  const q = '配偶者への贈与についての制度を説明します。';
  for (const before of [true, false]) {
    const text = before ? '110万円と2,000万円。' + '空'.repeat(301) + q : q + '空'.repeat(301) + '110万円と2,000万円。';
    assert.equal(supports(c16, source(text), q), false);
  }
});
for (const word of ['合計', '合わせ', '併せ', 'あわせ', '合算', '足す', '足し', '加え', '加算', '上乗せ', 'プラス']) {
  test('1', `指定の合計語「${word}」を認める`, () => {
    assert.equal(supports(amountClaim(`基礎控除110万円と${word}、2,110万円です。`)), true);
  });
}
test('1', '自分のタックスアンサー番号を金額に数えない', () => {
  assert.equal(supports(amountClaim(c16.sentence + '（No.4452）')), true);
});
test('1', '要約の数字が原文と違えば合計でも採らない', () => {
  assert.equal(supports({ ...c16, claim: '基礎控除110万円と合わせて合計2,210万円' }), false);
});
test('1', '同額同士・小さい数・割合・日付から合計を作らない', () => {
  for (const [sentence, text] of [
    ['100万円と合わせて合計200万円です。', '控除額は100万円と100万円を使う制度です。'],
    ['9,000円と合わせて合計2万円です。', '控除額は9,000円と11,000円を使う制度です。'],
    ['1万円と合わせて合計3万円です。', '控除額は1万円と20000%を使う制度です。'],
    ['1万円と合わせて合計3万円です。', '控除額は1万円で令和20000年1月1日現在法令等の制度です。'],
  ]) assert.equal(supports(amountClaim(sentence), source(text), text), false);
});
test('1', '引用の二つの部分をまたいで加算しない', () => {
  const a = '基礎控除額110万円についての説明を掲載します。';
  const b = '配偶者控除額2,000万円についての説明を掲載します。';
  assert.equal(supports(c16, source(a + '空'.repeat(701) + b), a + '\n…\n' + b), false);
  assert.equal(supports(c16, source(quote + '空'.repeat(701) + b), quote + '\n…\n' + b), true);
});
test('1', '同じ引用の別々の出現位置の加数を混ぜない', () => {
  const q = '配偶者への贈与について制度を説明します。';
  const text = '110万円。' + q + '空'.repeat(701) + q + '2,000万円。';
  assert.equal(supports(c16, source(text), q), false);
});
test('1', '同じ引用内でも別の採用範囲の加数を混ぜない', () => {
  const q = '配偶者への贈与について制度を説明します。';
  const a = '110万円。' + q, b = q + '2,000万円。';
  assert.equal(supports(c16, { ...source(a + b), text_ranges: [[0, a.length], [a.length, a.length + b.length]] }, q), false);
});

test('2', 'partialQuoteNumbers は加数と合計を保持し、別の未裏付け金額を残さない', () => {
  const c = amountClaim(c16.sentence + '別の控除額は9,999万円です。');
  const partial = partialQuoteNumbers(c, { quote, correct: '' }, ref4452);
  assert.deepEqual(partial.forms, ['110万円', '2,110万円']);
  assert.deepEqual(partial.sum_support, sums);
  assert.equal(partialQuoteNumbers(c16, { quote, correct: '' }, ref4452), null);
  assert.deepEqual(partialQuoteNumbers({ ...c, type: '割合' }, { quote, correct: '' }, ref4452).forms, ['110万円']);
});
test('2', '判定の supported_numbers と合計の記録を JSON に保存できる', async () => {
  const c = amountClaim(c16.sentence + '別の控除額は9,999万円です。');
  const rows = await F.judgeClaims([c], { [c.id]: [ref4452] }, c.sentence, H.numberedFake(async () => [
    { id: c.id, status: '裏付けあり', evidence_id: ref4452.id, quote, correct: '' },
  ], { refs: [ref4452] }), { batch: false, loadEvidenceText: e => e.text });
  const saved = JSON.parse(JSON.stringify(F.compactRecord({ claims: rows }))).claims[0];
  assert.equal(saved.status, '資料なし');
  assert.deepEqual(saved.supported_numbers, ['110万円', '2,110万円']);
  assert.deepEqual(saved.sum_support, sums);
});

const siblings = (number = {}, sibling = {}) => F.supportNumbersFromSiblings([{ ...c35, ...number }, { ...c45, ...sibling }]);
test('3', 'c35 は同じ文の c45 の No.4508 で裏付ける', () => {
  const [result] = siblings({ reject_reason: '元の理由', rejected_answer: { status: '裏付けあり' }, evidence: [] });
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, ref4508.id);
  assert.equal(result.quote, c45.quote);
  assert.equal(result.correct, '');
  assert.deepEqual(result.number_from_sibling, { id: 'c45', previous_status: '資料なし', previous_reject_reason: '元の理由' });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].no, '4508');
  assert.equal(Object.hasOwn(result, 'reject_reason'), false);
  assert.equal(Object.hasOwn(result, 'rejected_answer'), false);
  assert.equal(c35.status, '資料なし');
  assert.equal(siblings()[0].evidence.filter(e => e.id === ref4508.id).length, 1);
});
for (const [name, number, sibling] of [
  ['根拠が No.4452', {}, { evidence_id: ref4452.id, evidence: [ref4452] }],
  ['兄弟が資料なし', {}, { status: '資料なし' }],
  ['一つでも未対応の番号', { claim: 'No.4508・No.4510' }, {}],
  ['食い違い', { status: '食い違い' }, {}],
  ['期限の書き漏れ', { status: '期限の書き漏れ' }, {}],
  ['条文を含む', { claim: 'No.4508・措法70条の2' }, {}],
  ['漢数字の条文', { claim: 'No.4508・第七十条' }, {}],
  ['通達を含む', { claim: 'No.4508・相基通19-8' }, {}],
  ['除外理由', { reject_reason: '同じ制度の期限の書き漏れは記録済み' }, {}],
  ['文が違う', {}, { sentence: c45.sentence + ' ' }],
  ['兄弟も番号', {}, { type: '番号' }],
  ['資料が taxanswer でない', {}, { evidence: [{ ...ref4508, kind: 'law' }] }],
  ['根拠IDに資料が無い', {}, { evidence_id: 'missing' }],
]) test('3', `${name}なら状態を変えない`, () => {
  const input = { ...c35, ...number };
  assert.deepEqual(siblings(number, sibling)[0], input);
});
for (const citation of ['No.4508', 'Ｎｏ．４５０８', 'No4508', 'タックスアンサー4508', 'タックスアンサーNo.4508', 'TA4508']) {
  test('3', `番号表記 ${citation}`, () => assert.equal(siblings({ claim: citation })[0].status, '裏付けあり'));
}
test('3', '要約に番号が無ければ文から取り、4桁以外は採らない', () => {
  assert.equal(siblings({ claim: '資料の番号' })[0].status, '裏付けあり');
  assert.equal(siblings({ claim: 'No.45081', sentence: c35.sentence.replace('4508', '45081') })[0].status, '資料なし');
});
test('3', '複数の番号が全部対応すれば最初の番号の根拠を採る', () => {
  const extra = { ...c45, id: 'c46', evidence_id: ref4452.id, evidence: [ref4452], quote };
  const [result] = F.supportNumbersFromSiblings([{ ...c35, claim: 'No.4452・No.4508', evidence: [] }, c45, extra]);
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, ref4452.id);
  assert.equal(result.number_from_sibling.id, 'c46');
  assert.equal(result.evidence.length, 2);
});

const options = { now: new Date('2026-10-27T00:00:00Z'), provider: 'anthropic', model: 'claude-opus-5-5', enabled: true, batch: false };
const replacement = '暦年課税の基礎控除110万円との併用については、詳しくは国税庁のタックスアンサーで確認してください。';
async function checkExample({ wrong = false, writer = false, recheckNumber = false } = {}) {
  const amount = { ...c16, sentence: c16.sentence.replace('2,110', wrong ? '2,210' : '2,110'), claim: c16.claim.replace('2,110', wrong ? '2,210' : '2,110') };
  const body = amount.sentence + '\n\n' + c35.sentence;
  const repairReplacement = recheckNumber ? replacement.replace('タックスアンサーで', 'タックスアンサー No.4452 で') : replacement;
  const calls = [];
  const fake = async req => {
    calls.push(req.task);
    if (req.task === 'extract') return (req.user.includes(repairReplacement)
      ? [{ ...amount, sentence: repairReplacement, claim: '基礎控除110万円' },
        ...(recheckNumber ? [{ ...c35, sentence: repairReplacement, claim: 'No.4452' }] : [])]
      : [amount, c35, c45]).map(({ sentence, type, subject, claim }) => ({ sentence, type, subject, claim }));
    if (['judge', 'retry_judge'].includes(req.task)) return H.readPayload(req).claims.map(c => c.type === '番号'
      ? { id: c.id, status: '資料なし' }
      : { id: c.id, status: '裏付けあり', evidence_id: c.type === '金額' ? ref4452.id : ref4508.id, quote: c.type === '金額' ? quote : c45.quote, correct: '' });
    if (req.task === 'condition_check') return { verdict: '一致', conditions: [] };
    if (req.task === 'repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: repairReplacement }));
    throw new Error('予期しない偽LLM呼び出し: ' + req.task);
  };
  const result = await F.checkFacts(body, { ...options, writer_materials: writer ? ['ta:4452', 'ta:4508'] : [],
    searchEvidence: c => c.type === '金額' ? [ref4452] : [ref4508],
    searchWriterEvidence: c => c.type === '金額' ? [ref4452] : [ref4508],
    loadEvidenceText: ref => ref.id === ref4452.id ? ref4452.text : ref4508.text,
    callLLM: H.numberedFake(fake, { body, refs: [ref4452, ref4508] }) });
  return { ...result, originalBody: body, fakeCalls: calls };
}
for (const writer of [false, true]) test('4', `${writer ? '段A/B' : '通常'}の通し照合で二つの正しい文を維持し記録する`, async () => {
  const result = await checkExample({ writer });
  assert.equal(result.record.status, 'ok', result.record.summary);
  assert.equal(result.body, result.originalBody);
  assert.deepEqual(result.record.corrections, []);
  assert.equal(result.fakeCalls.includes('repair'), false);
  const saved = JSON.parse(JSON.stringify(F.compactRecord(result.record)));
  const amount = saved.claims.find(c => c.type === '金額');
  const number = saved.claims.find(c => c.type === '番号');
  assert.deepEqual(amount.sum_support, sums);
  assert.equal(amount.status, '裏付けあり');
  assert.equal(number.status, '裏付けあり');
  assert.equal(number.evidence_id, ref4508.id);
  assert.equal(number.number_from_sibling.id, saved.claims.find(c => c.type === '要件').id);
  assert.equal(number.number_from_sibling.previous_status, '資料なし');
});
for (const writer of [false, true]) test('5', `${writer ? '段A/B' : '通常'}の不正な合計は従来どおり具体を外す`, async () => {
  const result = await checkExample({ wrong: true, writer });
  const original = result.record.claims.find(c => c.type === '金額');
  assert.equal(original.status, '資料なし', result.record.summary);
  assert.equal(original.sum_support, undefined);
  assert.equal(original.rejected_answer.status, '裏付けあり');
  assert.deepEqual(original.supported_numbers, ['110万円']);
  const correction = result.record.corrections.find(c => c.id === original.id);
  assert.ok(correction, result.record.summary);
  assert.equal(correction.generalized, true);
  assert.equal(correction.resolved, true);
  assert.equal(correction.after, replacement);
  assert.equal(result.body, replacement + '\n\n' + c35.sentence);
  assert.equal(result.record.rechecked[0].status, '裏付けあり');
  assert.equal(result.record.status, 'ok');
});
for (const writer of [false, true]) test('5', `${writer ? '段A/B' : '通常'}の再照合でも同じ文の資料番号を補う`, async () => {
  const result = await checkExample({ wrong: true, writer, recheckNumber: true });
  assert.equal(result.record.status, 'ok', result.record.summary);
  assert.equal(result.record.corrections[0].resolved, true);
  const number = result.record.rechecked.find(c => c.type === '番号');
  assert.equal(number.status, '裏付けあり');
  assert.equal(number.evidence_id, ref4452.id);
  assert.equal(number.number_from_sibling.id, result.record.rechecked.find(c => c.type === '金額').id);
});

test('6', '却下した回答・理由・引用をエスケープし、要点に件数を表示する', () => {
  const rejected = { ...c16, reject_reason: '数字が引用の近くに無い<script>',
    rejected_answer: { status: '裏付けあり', evidence: ref4452.id, quote: '<script>alert("x")</script>' + '引'.repeat(220) },
    evidence: [{ ...ref4452, title: '<資料>&"題名' }] };
  const noAnswer = { ...c35, reject_reason: '<理由>' };
  const corrections = [rejected, noAnswer].map(c => ({ ...c, generalized: true, resolved: true, before: c.sentence, after: '国税庁で確認してください。' }));
  const record = F.compactRecord({ status: 'ok', claims: [rejected, noAnswer], corrections, remaining: [], review_items: [] });
  const html = page.renderFactCheck({}, record);
  assert.ok(html.includes('AI の答え: 裏付けあり（&lt;資料&gt;&amp;&quot;題名）／機械が採らなかった理由: 数字が引用の近くに無い&lt;script&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('引'.repeat(201)), false);
  assert.ok(html.includes('AI の答え: 資料なし（&lt;理由&gt;）'));
  const summary = page.renderFactCheckSummary({}, record);
  assert.ok(summary.includes('資料が無く案内に変えた 2 件（うち AI は裏付けありと答えた 1 件）'));
});
test('6', 'claims が無い記録は再照合から取得し、題名が無ければ URL を表示する', () => {
  const original = { ...c16, evidence: [{ ...ref4452, title: '', url: 'https://example.invalid/?a=<b>&c="d"' }] };
  const record = { status: 'ok', rechecked: [original], corrections: [{ id: c16.id, generalized: true, resolved: true }], remaining: [] };
  const html = page.renderFactCheck({}, record);
  assert.ok(html.includes('AI の答え: 裏付けあり（https://example.invalid/?a=&lt;b&gt;&amp;c=&quot;d&quot;）'));
  assert.ok(page.renderFactCheckSummary({}, record).includes('（うち AI は裏付けありと答えた 1 件）'));
  const plain = { status: 'ok', claims: [{ ...c35 }], corrections: [{ id: c35.id, generalized: true, resolved: true }], remaining: [] };
  assert.ok(page.renderFactCheck({}, plain).includes('AI の答え: 資料なし</div>'));
  assert.equal(page.renderFactCheckSummary({}, plain).includes('うち AI は'), false);
});
test('7', 'LOGIC_VERSION は plan2-s3', async () => {
  const result = await F.checkFacts('', { ...options, writer_materials: [], callLLM: async () => { throw new Error('空本文で LLM を呼ばない'); } });
  assert.equal(result.record.logic_version, 'plan2-s3');
});

(async () => {
  const originalFetch = global.fetch;
  const previousWriterMode = process.env.FACT_CHECK_WRITER_MATERIALS;
  global.fetch = async () => { throw new Error('試験中のネットワークは禁止'); };
  process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
  let passed = 0;
  try {
    for (const t of tests) {
      try { await t.run(); passed++; console.log(`PASS 試験${t.group}: ${t.name}`); }
      catch (error) { console.error(`FAIL 試験${t.group}: ${t.name}\n${error.stack}`); }
    }
  } finally {
    global.fetch = originalFetch;
    if (previousWriterMode === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS;
    else process.env.FACT_CHECK_WRITER_MATERIALS = previousWriterMode;
  }
  console.log(`試験1〜7: PASS ${passed} / FAIL ${tests.length - passed}`);
  if (passed !== tests.length) process.exitCode = 1;
})();
