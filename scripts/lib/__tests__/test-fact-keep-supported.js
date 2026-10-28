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
for (const word of ['合計', '合算', '総額', '合わせて', '併せて', 'あわせて', '加えた', '足した', '加算した', '上乗せした']) {
  test('1', `指定の合計語「${word}」を認める`, () => {
    assert.equal(supports(amountClaim(`基礎控除110万円と${word}2,110万円です。`)), true);
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
  const [result] = siblings({ reject_reason: '元の理由', rejected_answer: { status: '裏付けあり' }, evidence: [ref4508] });
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, ref4508.id);
  assert.equal(result.quote, c45.quote);
  assert.equal(result.correct, '');
  assert.deepEqual(result.number_from_sibling, { id: 'c45', sentence: c45.sentence, type: c45.type, subject: c45.subject,
    previous_status: '資料なし', previous_reject_reason: '元の理由' });
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
test('3', '要約に番号が無いもの・4桁以外は採らない', () => {
  assert.equal(siblings({ claim: '資料の番号' })[0].status, '資料なし');
  assert.equal(siblings({ claim: 'No.45081', sentence: c35.sentence.replace('4508', '45081') })[0].status, '資料なし');
});
test('3', '複数の番号が全部対応すれば最初の番号の根拠を採る', () => {
  const related = { ...ref4508, id: 'test:4509', no: '4509', url: 'https://example.invalid/4509' };
  const subject = ref4508.title;
  const sentence = c35.sentence.replace('No.4508', 'No.4509・4508');
  const extra = { ...c45, id: 'c46', sentence, subject, evidence_id: related.id, evidence: [related] };
  const [result] = F.supportNumbersFromSiblings([{ ...c35, sentence, subject, claim: 'No.4509・No.4508', evidence: [related, ref4508] }, { ...c45, sentence, subject }, extra]);
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, related.id);
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
        ...(recheckNumber ? [{ ...c35, sentence: repairReplacement, subject: amount.subject, claim: 'No.4452' }] : [])]
      : [amount, c35, c45]).map(({ sentence, type, subject, claim }) => ({ sentence, type, subject, claim }));
    if (['judge', 'retry_judge'].includes(req.task)) return H.readPayload(req).claims.map(c => c.type === '番号'
      ? { id: c.id, status: '資料なし' }
      : { id: c.id, status: '裏付けあり', evidence_id: c.type === '金額' ? ref4452.id : ref4508.id, quote: c.type === '金額' ? quote : c45.quote, correct: '' });
    if (req.task === 'condition_check') return { verdict: '一致', conditions: [] };
    if (req.task === 'repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: repairReplacement }));
    throw new Error('予期しない偽LLM呼び出し: ' + req.task);
  };
  const result = await F.checkFacts(body, { ...options, writer_materials: writer ? ['ta:4452', 'ta:4508'] : [],
    searchEvidence: c => c.type === '金額' ? [ref4452] : c.type === '番号' ? [ref4508, ref4452] : [ref4508],
    searchWriterEvidence: c => c.type === '金額' ? [ref4452] : c.type === '番号' ? [ref4508, ref4452] : [ref4508],
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
  assert.ok(html.includes('AI の答え: 記録なし（&lt;理由&gt;）'));
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

for (const claim of ['No.4508・4510', 'No.4508、4510', '措置法70の2・No.4508', 'No.4508・４５１０', 'No.4508・四五一〇']) {
  test('F1', `要約に未確認の数字が残る「${claim}」を補わない`, () => {
    const input = { ...c35, claim };
    assert.deepEqual(F.supportNumbersFromSiblings([input, c45])[0], input);
  });
}
test('F1', '要約に番号が無く、文に条文と番号があっても補わない', () => {
  const sentence = '租税特別措置法第70条の2（国税庁タックスアンサー No.4508）を確認してください。';
  const input = { ...c35, claim: '資料の番号', sentence };
  assert.deepEqual(F.supportNumbersFromSiblings([input, { ...c45, sentence }])[0], input);
  assert.equal(siblings()[0].status, '裏付けあり');
});

for (const status of ['食い違い', '期限の書き漏れ']) for (const reason of [
  '資料の番号が読めない', '根拠の文の番号が読めない・範囲外', '引用が短い・数字が引用の近くに無い',
]) test('F2', `AI の ${status} を形式で却下した「${reason}」は補わない`, () => {
  const input = { ...c35, reject_reason: reason, rejected_answer: { status, evidence: ref4508.id, quote: c45.quote } };
  assert.deepEqual(F.supportNumbersFromSiblings([input, c45])[0], input);
});
test('F2', '却下した状態が不明なものも補わない', () => {
  assert.equal(siblings({ rejected_answer: {} })[0].status, '資料なし');
});
for (const status of ['食い違い', '期限の書き漏れ']) for (const rejected of [false, true]) {
  test('F2', `段Aの${rejected ? '却下された' : '採用された'}${status}を段Bの資料なしから補わない`, async () => {
    const body = c35.sentence;
    const fake = async req => {
      if (req.task === 'extract') return [c35, c45].map(({ sentence, type, subject, claim }) => ({ sentence, type, subject, claim }));
      if (req.task === 'condition_check') return { verdict: '一致', conditions: [] };
      if (req.task === 'retry_judge') return H.readPayload(req).claims.map(c => ({ id: c.id, status: '資料なし' }));
      assert.equal(req.task, 'judge');
      return H.readPayload(req).claims.map(c => c.type === '番号'
        ? req.stageB ? { id: c.id, status: '資料なし' }
          : { id: c.id, status, evidence_id: ref4452.id, quote, correct: rejected ? '' : '国税庁タックスアンサー No.4452' }
        : { id: c.id, status: '裏付けあり', evidence_id: ref4508.id, quote: c45.quote, correct: '' });
    };
    const result = await F.checkFacts(body, { ...options, repair: false, writer_materials: ['ta:4452', 'ta:4508'],
      searchWriterEvidence: c => c.type === '番号' ? [ref4452] : [ref4508], searchEvidence: () => [ref4508],
      loadEvidenceText: ref => ref.id === ref4452.id ? ref4452.text : ref4508.text,
      callLLM: H.numberedFake(fake, { body, refs: [ref4452, ref4508] }) });
    const number = result.record.claims.find(c => c.type === '番号');
    assert.ok(number, result.record.summary);
    assert.equal(number.stage, 'B');
    assert.equal(number.stage_a_status, status);
    assert.equal(number.status, '資料なし');
    assert.equal(number.number_from_sibling, undefined);
    assert.equal(result.record.claims.find(c => c.type === '要件').status, '裏付けあり');
    assert.equal(result.record.status, 'revise');
    assert.equal(JSON.parse(JSON.stringify(F.compactRecord(result.record))).claims.find(c => c.type === '番号').stage_a_status, status);
  });
}

for (const [sentence, text] of [
  ['3,000万円に600万円を加えた3,600万円です。', '相続税の基礎控除は3,000万円＋（600万円×法定相続人の数）です。'],
  ['800万円に70万円を加えた870万円です。', '勤続年数が20年を超える場合、退職所得控除は800万円＋70万円×（勤続年数－20年）です。'],
]) test('F3', `掛け算のある式から誤った合計「${sentence}」を採らない`, () => {
  assert.equal(supports(amountClaim(sentence), source(text), text), false);
});
for (const marker of ['×', '✕', '＊', '*', '倍', 'につき', '当たり', 'あたり']) {
  test('F3', `原文の範囲に「${marker}」があれば合計を補わない`, () => {
    assert.equal(supports(c16, source(quote + 'この計算は' + marker + 'の表記を使います。')), false);
  });
}
test('F3', 'No.4452 の実際の引用範囲には掛け算の語がなく、c16 は裏付ける', () => {
  const at = ref4452.text.indexOf(quote);
  assert.ok(at >= 0);
  assert.equal(/[×✕＊*]|倍|につき|当たり|あたり|乗じ|乗ず|掛け/.test(ref4452.text.slice(Math.max(0, at - 320), at + quote.length + 320)), false);
  assert.equal(supports(c16), true);
});
test('F3', '掛け算の印だけ同じ出現位置の前後320字で確かめる', () => {
  assert.equal(supports(c16, source(quote + '空'.repeat(299) + '×')), false);
  assert.equal(supports(c16, source(quote + '空'.repeat(300) + '×')), false);
  assert.equal(supports(c16, source(quote + '空'.repeat(320) + '×')), true);
  assert.equal(supports(amountClaim('基礎控除110万円です。'), source(quote + '×')), true);
});
test('F3', 'partialQuoteNumbers も掛け算のある範囲では合計を残さない', () => {
  const c = amountClaim(c16.sentence + '別の控除額は9,999万円です。');
  const partial = partialQuoteNumbers(c, { quote, correct: '' }, source(quote + '×'));
  assert.deepEqual(partial.forms, ['110万円']);
  assert.equal(partial.sum_support, undefined);
});

test('F4', '教育資金と住宅取得等資金で番号を取り違えた文を別制度の兄弟から補わない', () => {
  const sentence = '教育資金の一括贈与（No.4508）と住宅取得等資金の贈与（No.4510）は併用できます。';
  const ref4510 = c35.evidence.find(e => e.no === '4510');
  const education = { ...c35, sentence, subject: '教育資金の一括贈与', claim: 'No.4508', evidence: [ref4508, ref4510] };
  const housing = { ...c35, id: 'c36', sentence, subject: '住宅取得等資金の贈与', claim: 'No.4510', evidence: [ref4508, ref4510] };
  const rows = F.supportNumbersFromSiblings([education, housing,
    { ...c45, sentence, subject: housing.subject },
    { ...c45, id: 'c46', sentence, subject: education.subject, evidence_id: ref4510.id, evidence: [ref4510] },
  ]);
  assert.deepEqual(rows.slice(0, 2), [education, housing]);
  assert.equal(siblings()[0].status, '裏付けあり');
});
test('F4', '制度名は NFKC と空白だけを揃えて一致させる', () => {
  const ref = { ...source('A制度の要件について説明します。'), id: 'test:normalized-subject', no: '4508', title: 'A制度' };
  assert.equal(siblings({ subject: 'Ａ 制度', evidence: [ref] }, { subject: 'A　制 度', evidence_id: ref.id, evidence: [ref] })[0].status, '裏付けあり');
  assert.equal(siblings({}, { subject: c45.subject + '（別制度）' })[0].status, '資料なし');
});

test('F5', '候補外の資料で裏付けられた兄弟から補わない', () => {
  const input = { ...c35 };
  assert.deepEqual(F.supportNumbersFromSiblings([input, { ...c45, evidence_outside_candidates: true }])[0], input);
  assert.equal(siblings({}, { evidence_outside_candidates: false })[0].status, '裏付けあり');
});
test('F5', '番号の主張自身の候補に一致する資料がなければ補わない', () => {
  for (const evidence of [[], [ref4452]]) {
    const input = { ...c35, evidence };
    assert.deepEqual(F.supportNumbersFromSiblings([input, c45])[0], input);
    assert.deepEqual(input.evidence, evidence);
  }
});

for (const sentence of [
  '基礎控除110万円に加えて、配偶者控除の上限は2,110万円です。',
  '上限は2,110万円で、基礎控除110万円とあわせて確認してください。',
]) test('F6', `合計の金額を直接受けない文「${sentence}」は補わない`, () => {
  assert.equal(supports(amountClaim(sentence)), false);
});
for (const prefix of ['問い', '組み', '打ち', '照らし', '申し', '掛け']) {
  test('F6', `「${prefix}合わせて」を合計の語に数えない`, () => {
    assert.equal(supports(amountClaim(`基礎控除110万円を${prefix}合わせて2,110万円を確認してください。`)), false);
  });
}
test('F6', '合計の語は原文の直前8字以内だけで確かめる', () => {
  assert.equal(supports(amountClaim('基礎控除110万円と合計' + 'あ'.repeat(6) + '2,110万円です。')), true);
  assert.equal(supports(amountClaim('基礎控除110万円と合計' + 'あ'.repeat(7) + '2,110万円です。')), false);
  assert.equal(supports(amountClaim('基礎控除110万円と合計' + ' '.repeat(7) + '2,110万円です。')), false);
  assert.equal(supports(amountClaim('基礎控除110万円と合計（No.4452）2,110万円です。')), false);
});
for (const separator of ['。', '、', '，']) test('F6', `合計の語から金額まで「${separator}」をまたがない`, () => {
  assert.equal(supports(amountClaim(`基礎控除110万円と合計${separator}2,110万円です。`)), false);
});
test('F6', '金額の直後の「の合計」「の合算」と全角・漢数字の金額を認める', () => {
  for (const suffix of ['の合計', 'の合算']) assert.equal(supports(amountClaim(`基礎控除110万円と2,110万円${suffix}です。`)), true);
  assert.equal(supports(amountClaim('基礎控除110万円と合計２，１１０万円です。')), true);
  assert.equal(supports(amountClaim('基礎控除110万円と合計二千百十万円です。')), true);
});
test('F6', 'partialQuoteNumbers も金額を直接受けない合計の語では合計を残さない', () => {
  const c = amountClaim('基礎控除110万円に加えて、配偶者控除の上限は2,110万円です。');
  assert.deepEqual(partialQuoteNumbers(c, { quote, correct: '' }, ref4452).forms, ['110万円']);
});

test('F7', '回答の記録が無い理由を表示し、主張が見つからないときは何も足さない', () => {
  for (const reason of ['答えが無い', '状態が不正', '<script>古い記録</script>']) {
    const original = { ...c35, reject_reason: reason };
    const record = { status: 'ok', claims: [original], corrections: [{ id: c35.id, generalized: true, resolved: true }], remaining: [] };
    const html = page.renderFactCheck({}, record);
    assert.ok(html.includes('AI の答え: 記録なし（'));
    assert.equal(html.includes('AI の答え: 資料なし'), false);
    assert.equal(html.includes('<script>'), false);
  }
  const absent = { status: 'ok', claims: [], corrections: [{ id: 'missing', generalized: true, resolved: true }], remaining: [] };
  assert.equal(page.renderFactCheck({}, absent).includes('AI の答え:'), false);
});
test('F8', '兄弟の文・種類・制度名が JSON に残り、id を振り直しても監査できる', () => {
  const rows = siblings();
  const saved = JSON.parse(JSON.stringify(F.compactRecord({ claims: rows }))).claims.map((c, i) => ({ ...c, id: `renumbered-${i}` }));
  const audit = saved[0].number_from_sibling;
  assert.deepEqual(audit, { id: 'c45', sentence: c45.sentence, type: c45.type, subject: c45.subject,
    previous_status: '資料なし', previous_reject_reason: '' });
  assert.notEqual(saved[1].id, audit.id);
  assert.equal(saved[1].sentence, audit.sentence);
  assert.equal(saved[1].type, audit.type);
  assert.equal(saved[1].subject, audit.subject);
});

for (const [law, article, sentence, formula] of [
  ['sozokuzei', '15', '3,000万円に600万円を加えた3,600万円です。', '三千万円と六百万円'],
  ['shotokuzei_hou', '30', '800万円に70万円を加えた870万円です。', '八百万円と七十万円'],
]) test('G1', `${law} 第${article}条の実本文の「乗じて」を合計として採らない`, () => {
  const text = require(`../../../data/law-sources/${law}.json`).articles.find(a => a.num === article).text;
  assert.ok(text.includes(formula));
  assert.ok(text.includes('乗じて'));
  assert.equal(/[×✕＊*]/.test(text), false);
  const q = text.split('\n').find(line => line.includes(formula));
  assert.equal(supports(amountClaim(sentence), { ...source(text), kind: 'law' }, q), false);
});
for (const marker of ['乗じ', '乗ず', '掛け']) test('G1', `乗算の語「${marker}」があれば合計を補わない`, () => {
  assert.equal(supports(c16, source(quote + marker)), false);
});
test('G1', '数を集める範囲の外側20字も乗算の印を確認する', () => {
  for (const before of [false, true]) for (const padding of [300, 319, 320]) {
    const text = before ? '×' + '空'.repeat(padding) + quote : quote + '空'.repeat(padding) + '×';
    assert.equal(supports(c16, source(text)), padding === 320);
  }
  const q = '配偶者への贈与についての制度を説明します。';
  assert.equal(supports(c16, source(q + '空'.repeat(301) + '110万円と2,000万円。'), q), false);
});

test('G2', '教育資金の制度を住宅取得等資金の No.4508 から補わない', () => {
  const sentence = '教育資金の一括贈与（国税庁タックスアンサー No.4508）は、父母や祖父母など直系尊属からの贈与が対象です。';
  const input = { ...c35, sentence, subject: '教育資金の一括贈与', evidence: [ref4508] };
  const sibling = { ...c45, sentence, subject: input.subject };
  assert.deepEqual(F.supportNumbersFromSiblings([input, sibling])[0], input);
  assert.equal(siblings()[0].status, '裏付けあり');
});
test('G2', '本文に制度名があるだけでは補わず、関連リンクより前の本文で関連を確かめる', () => {
  const relevantMaterial = require('../article-plan').relevantMaterial;
  const subject = '教育資金の一括贈与';
  const onlyBody = { ...ref4508, title: '贈与の一般的な手続', text: `${subject}について説明します。` };
  assert.equal(relevantMaterial(subject, onlyBody, onlyBody.text).condition, 2);
  assert.equal(siblings({ subject, evidence: [onlyBody] }, { subject, evidence: [onlyBody] })[0].status, '資料なし');
  const linked = { ...ref4508, text: ref4508.text.split('関連リンク')[0] + '関連リンク' + c35.subject };
  assert.equal(relevantMaterial(c35.subject, linked, linked.text).condition, 2);
  assert.equal(relevantMaterial(c35.subject, linked, linked.text.split('関連リンク')[0]).condition, 3);
  assert.equal(siblings({ evidence: [linked] }, { evidence: [linked] })[0].status, '裏付けあり');
});
test('G2', '条件3の資料が一意でなくても c35 を救う', () => {
  const relevantMaterial = require('../article-plan').relevantMaterial;
  assert.equal(relevantMaterial(c35.subject, ref4508, ref4508.text.split('関連リンク')[0]).condition, 3);
  assert.ok(c35.evidence.some(ref => ref.id !== ref4508.id && relevantMaterial(c35.subject, ref, ref.text.split('関連リンク')[0]).condition === 3));
  assert.equal(siblings()[0].status, '裏付けあり');
});

for (const retryStatus of ['食い違い', '期限の書き漏れ', '資料なし']) {
  test('G3', `却下した裏付けありの聞き直し「${retryStatus}」を記録し、番号補完を判断する`, async () => {
    const calls = [];
    const rows = await F.judgeClaims([c35], { [c35.id]: [ref4508] }, c35.sentence, async req => {
      calls.push(req.task);
      return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: req.task === 'judge' ? '裏付けあり' : retryStatus,
        evidence_id: c.evidence_ids[0], basis: '99999', correct: '国税庁タックスアンサー No.4508' }));
    }, { ...options, writer_materials: ['ta:4508'], loadEvidenceText: () => ref4508.text });
    assert.deepEqual(calls, ['judge', 'retry_judge']);
    assert.equal(rows[0].status, '資料なし');
    assert.equal(rows[0].rejected_answer.status, '裏付けあり');
    assert.equal(rows[0].retry_status, retryStatus === '資料なし' ? undefined : retryStatus);
    const [number] = F.supportNumbersFromSiblings([...rows, c45]);
    assert.equal(number.status, retryStatus === '資料なし' ? '裏付けあり' : '資料なし');
    assert.equal(JSON.parse(JSON.stringify(F.compactRecord({ claims: rows }))).claims[0].retry_status, rows[0].retry_status);
  });
}
for (const retryStatus of ['食い違い', '期限の書き漏れ']) {
  test('G3', `段Aの聞き直しで却下した「${retryStatus}」も段Bの資料なしから救わない`, async () => {
    const body = c35.sentence, calls = [];
    const result = await F.checkFacts(body, { ...options, repair: false, writer_materials: ['ta:4508'],
      searchWriterEvidence: () => [ref4508], searchEvidence: () => [ref4508], loadEvidenceText: () => ref4508.text,
      callLLM: H.numberedFake(async req => {
        calls.push(req.stageB ? 'stage_b_' + req.task : req.task);
        if (req.task === 'extract') return [c35, c45].map(({ sentence, type, subject, claim }) => ({ sentence, type, subject, claim }));
        if (req.task === 'condition_check') return { verdict: '一致', conditions: [] };
        assert.ok(['judge', 'retry_judge'].includes(req.task));
        return JSON.parse(req.user).claims.map(c => c.type === '番号'
          ? req.stageB ? { id: c.id, status: '資料なし' }
            : { id: c.id, status: req.task === 'retry_judge' ? retryStatus : '裏付けあり', evidence_id: c.evidence_ids[0], basis: '99999', correct: 'No.4508' }
          : { id: c.id, status: '裏付けあり', evidence_id: c.evidence_ids[0], basis: '1', correct: '' });
      }) });
    assert.ok(calls.includes('retry_judge'));
    assert.ok(calls.includes('stage_b_judge'));
    const number = result.record.claims.find(c => c.type === '番号');
    assert.ok(number, result.record.summary);
    assert.equal(number.stage, 'B');
    assert.equal(number.stage_a_status, retryStatus);
    assert.equal(number.status, '資料なし');
    assert.equal(number.number_from_sibling, undefined);
    assert.equal(result.record.status, 'revise');
  });
}

for (const sentence of [
  '基礎控除110万円があり、合計所得金額が2,110万円です。',
  '基礎控除110万円を含む相続税の総額は2,110万円です。',
  '基礎控除110万円の総額2,110万円です。',
  '基礎控除110万円と掛けあわせて2,110万円です。',
  '基礎控除110万円と突き合わせて2,110万円です。',
  '基礎控除110万円と掛け併せて2,110万円です。',
  '基礎控除110万円と2,110万円の合計所得金額です。',
]) test('G4', `名詞や不適切な複合語「${sentence}」を合計の語にしない`, () => {
  assert.equal(supports(amountClaim(sentence)), false);
  assert.deepEqual(partialQuoteNumbers(amountClaim(sentence), { quote, correct: '' }, ref4452).forms, ['110万円']);
});
for (const word of ['合わせて', 'あわせて', '併せて']) for (const preceding of ['と', 'を', 'に', '円']) {
  test('G4', `「${word}」の直前が「${preceding}」なら合計の語にする`, () => {
    assert.equal(supports(amountClaim(`基礎控除110万円${preceding === '円' ? '' : preceding}${word}2,110万円です。`)), true);
    assert.equal(supports(c16), true);
  });
}

for (const subject of ['', '　 \t', undefined]) test('G5', '制度名を揃えると空になる主張は補わない: ' + String(subject), () => {
  const input = { ...c35, subject };
  assert.deepEqual(F.supportNumbersFromSiblings([input, { ...c45, subject }])[0], input);
});
for (const citation of ['No.4508・4510', 'No.4508、4510', 'No.4508，4510', 'Ｎｏ．４５０８・４５１０']) {
  test('G5', `文「${citation}」に要約にない番号が残るなら補わない`, () => {
    const sentence = c35.sentence.replace('No.4508', citation);
    const input = { ...c35, sentence, claim: 'No.4508' };
    assert.deepEqual(F.supportNumbersFromSiblings([input, { ...c45, sentence }])[0], input);
  });
}
test('G5', '番号集合は順序・重複を除いて一致させ、候補の配列をそのまま使う', () => {
  const related = { ...ref4508, id: 'test:4510', no: '4510', url: 'https://example.invalid/4510' };
  const subject = ref4508.title;
  const sentence = c35.sentence.replace('No.4508', 'No.4508・4510・4508');
  const evidence = [ref4508, related];
  const input = { ...c35, sentence, subject, claim: 'No.4510・No.4508', evidence };
  const sibling = { ...c45, sentence, subject };
  const extra = { ...sibling, id: 'c46', evidence_id: related.id, evidence: [related] };
  const [result] = F.supportNumbersFromSiblings([input, sibling, extra]);
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, related.id);
  assert.equal(result.evidence, evidence);
  const unmatched = { ...input, sentence: c35.sentence };
  assert.deepEqual(F.supportNumbersFromSiblings([unmatched, { ...c45, subject }, { ...extra, sentence: c35.sentence }])[0], unmatched);
  assert.equal(siblings({ sentence: c35.sentence.replace('No.4508', 'No.4508・4508') },
    { sentence: c35.sentence.replace('No.4508', 'No.4508・4508') })[0].status, '裏付けあり');
});

test('H1', '所得税法76条の実本文の分数を単純な合計として採らない', () => {
  const text = require('../../../data/law-sources/shotokuzei_hou.json').articles.find(a => a.num === '76').text;
  const q = text.split('\n').find(line => line.includes('四万円を超え八万円以下'));
  assert.ok(q.includes('三万円と当該合計額から四万円を控除した金額の四分の一'));
  const c = amountClaim('3万円に4万円を加えた7万円です。');
  const ref = { ...source(text), kind: 'law' };
  assert.equal(supports(c, ref, q), false);
  const partial = partialQuoteNumbers(c, { quote: q, correct: '' }, ref);
  assert.deepEqual(partial.forms, ['3万円', '4万円']);
  assert.equal(partial.sum_support, undefined);
});
for (const marker of ['四分の一', '4分の1', '二十分の一', '1/4', '1／4', '÷', '乗算']) {
  test('H1', `分数・除算の印「${marker}」があれば合計を補わない`, () => {
    assert.equal(supports(c16, source(quote + 'この計算は' + marker + 'を使います。')), false);
  });
}
test('H1', 'No.4452 の範囲に新しい印がなく、c16 の合計は引き続き裏付ける', () => {
  const at = ref4452.text.indexOf(quote);
  assert.ok(at >= 0);
  const window = ref4452.text.slice(Math.max(0, at - 320), at + quote.length + 320);
  assert.equal(/[0-9〇一二三四五六七八九十百千]分の[0-9〇一二三四五六七八九十百千]|[0-9][\/／][0-9]|÷|乗算/.test(window), false);
  const recorded = [];
  assert.equal(F.sufficientQuote(c16, { quote, correct: '' }, ref4452, '裏付けあり', recorded), true);
  assert.deepEqual(recorded, sums);
});
for (const phrase of ['法定相続分の', '持分の', '部分の']) test('H1', `数字のない「${phrase}」だけでは合計の補完を止めない`, () => {
  assert.equal(supports(c16, source(quote + phrase + '説明も掲載します。')), true);
});

for (const no of ['4503', '4508']) test('H2', `関連するタックスアンサーが4508と4503の2件なら No.${no} を補わない`, () => {
  const ref4503 = require('../writer-materials').resolveMaterial('ta:4503');
  const relevantMaterial = require('../article-plan').relevantMaterial;
  const evidence = [ref4508, ref4503];
  for (const ref of evidence) assert.equal(relevantMaterial(c35.subject, ref, ref.text.split('関連リンク')[0]).condition, 3);
  const sentence = `直系尊属から住宅取得等資金の贈与を受けた場合は、住宅取得等資金の贈与の非課税特例の対象です（国税庁タックスアンサー No.${no}）。`;
  const input = { ...c35, sentence, claim: `国税庁タックスアンサーNo.${no}`, evidence };
  const ref = evidence.find(ref => ref.no === no);
  const sibling = { ...c45, sentence, evidence_id: ref.id, evidence: [ref], quote: ref.text.split('。')[0] + '。' };
  assert.deepEqual(F.supportNumbersFromSiblings([input, sibling])[0], input);
});
test('H2', 'c35 の候補で関連するタックスアンサーは4508だけなので補完できる', () => {
  const relevantMaterial = require('../article-plan').relevantMaterial;
  const related = c35.evidence.filter(ref => ref.kind === 'taxanswer' &&
    relevantMaterial(c35.subject, ref, ref.text.split('関連リンク')[0]).condition > 0);
  assert.deepEqual(related.map(ref => ref.no), ['4508']);
  assert.equal(siblings()[0].status, '裏付けあり');
});
test('H2', '関連する法令と通達はタックスアンサーの一意性に数えない', () => {
  const ref4503 = require('../writer-materials').resolveMaterial('ta:4503');
  const nonTaxAnswers = ['law', 'tsutatsu'].map(kind => ({ ...ref4503, id: `test:${kind}`, kind }));
  const evidence = [ref4508, ...nonTaxAnswers];
  assert.equal(siblings({ evidence })[0].status, '裏付けあり');
});
test('H2', '条件1は他の関連候補があっても採り、条件3は他の条件1候補があれば採らない', () => {
  const exact = { ...ref4508, id: 'test:exact-topic', no: '4509', title: c35.subject, url: 'https://example.invalid/4509' };
  const evidence = [ref4508, exact];
  assert.equal(siblings({ evidence })[0].status, '資料なし');
  const sentence = c35.sentence.replace('No.4508', 'No.4509');
  const input = { ...c35, sentence, claim: 'No.4509', evidence };
  const sibling = { ...c45, sentence, evidence_id: exact.id, evidence: [exact] };
  const [result] = F.supportNumbersFromSiblings([input, sibling]);
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, exact.id);
});
test('J2', '一意に関連する候補が別の資料なら、IDの照合で兄弟資料を採らない', () => {
  const ref4503 = require('../writer-materials').resolveMaterial('ta:4503');
  const candidate4508 = { ...ref4508, title: '別の題名', text: '関係のない説明。' };
  const input = { ...c35, evidence: [candidate4508, ref4503] };
  const relevance = ref => require('../article-plan').relevantMaterial(c35.subject, ref, ref.text.split('関連リンク')[0]).condition;
  assert.equal(relevance(candidate4508), 0);
  const related = input.evidence.filter(ref => ref.kind === 'taxanswer' && relevance(ref) > 0);
  assert.deepEqual(related.map(ref => ref.id), [ref4503.id]);
  assert.equal(relevance(related[0]), 3);
  assert.equal(relevance(ref4508), 3);
  assert.notEqual(related[0].id, ref4508.id);
  assert.deepEqual(F.supportNumbersFromSiblings([input, c45])[0], input);
});

test('I1', '4508が条件2・4503が条件3でも、4503を一意として補わない', () => {
  const W = require('../writer-materials');
  const relevantMaterial = require('../article-plan').relevantMaterial;
  const subject = '住宅取得等資金の非課税';
  const evidence = [W.resolveMaterial('ta:4508'), W.resolveMaterial('ta:4503')];
  assert.deepEqual(evidence.map(ref => relevantMaterial(subject, ref, ref.text.split('関連リンク')[0]).condition), [2, 3]);
  const sentence = '直系尊属から住宅取得等資金の贈与を受けた場合は、住宅取得等資金の非課税の対象です（国税庁タックスアンサー No.4503）。';
  const input = { ...c35, sentence, subject, claim: '国税庁タックスアンサーNo.4503', evidence };
  const ref = evidence[1];
  const sibling = { ...c45, sentence, subject, evidence_id: ref.id, evidence: [ref], quote: ref.text.split('。')[0] + '。' };
  assert.deepEqual(F.supportNumbersFromSiblings([input, sibling])[0], input);
});
test('I1', '条件2を一意性に数えても、条件2だけの資料を補完には採らない', () => {
  const ref = require('../writer-materials').resolveMaterial('ta:4508');
  const subject = '住宅取得等資金の非課税';
  assert.equal(require('../article-plan').relevantMaterial(subject, ref, ref.text.split('関連リンク')[0]).condition, 2);
  const input = { ...c35, subject, evidence: [ref] };
  const sibling = { ...c45, subject, evidence: [ref] };
  assert.deepEqual(F.supportNumbersFromSiblings([input, sibling])[0], input);
});
test('I1', 'c35は条件2を含めても関連するタックスアンサーが4508だけなので補完できる', () => {
  const relevantMaterial = require('../article-plan').relevantMaterial;
  const related = c35.evidence.filter(ref => ref.kind === 'taxanswer' &&
    relevantMaterial(c35.subject, ref, ref.text.split('関連リンク')[0]).condition > 0);
  assert.deepEqual(related.map(ref => ref.no), ['4508']);
  const [result] = siblings();
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, ref4508.id);
  assert.equal(result.number_from_sibling.id, 'c45');
});

test('J1', '同じIDでも番号側の資料が条件2・兄弟側が条件3なら補完しない', () => {
  const candidate = { ...ref4508, text: c35.subject + 'について説明します。' };
  const input = { ...c35, evidence: [candidate] };
  const relevantMaterial = require('../article-plan').relevantMaterial;
  assert.equal(candidate.id, c45.evidence_id);
  assert.equal(relevantMaterial(c35.subject, candidate, candidate.text.split('関連リンク')[0]).condition, 2);
  assert.equal(relevantMaterial(c35.subject, ref4508, ref4508.text.split('関連リンク')[0]).condition, 3);
  assert.deepEqual(F.supportNumbersFromSiblings([input, c45])[0], input);
});

test('J1', '番号側の資料も条件3で一意なc35は引き続き補完できる', () => {
  const [result] = siblings();
  assert.equal(result.status, '裏付けあり');
  assert.equal(result.evidence_id, ref4508.id);
  assert.equal(result.number_from_sibling.id, 'c45');
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
  console.log(`試験1〜7・01b・01c・01d・01e・01f: PASS ${passed} / FAIL ${tests.length - passed}`);
  if (passed !== tests.length) process.exitCode = 1;
})();
