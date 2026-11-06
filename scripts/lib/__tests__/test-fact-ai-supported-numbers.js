'use strict';

// 段階1の通し試験。資料・AI は偽物にし、通信は行わない。
const assert = require('assert/strict');
const F = require('../fact-check');
const H = require('./fact-pages-test-helpers');
const page = require('../../../netlify/functions/review-page');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const REVIEW = 'AI は裏付けあり（数字は機械で確かめられなかった）';
const REASON = '引用が短い・数字が引用の近くに無い';
const sentence = '建設業はみなし仕入率70%のため、3割特例と同じ30万円の納付になります。';
const table = '| 第三種事業（建設業など） | 70％ |';
const tableRef = { id: 'test:6505', kind: 'taxanswer', no: '6505', title: 'No.6505 簡易課税制度',
  url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm', text: table };
const wrong = '消費税の納付額は40万円です。';
const right = '消費税の納付額は30万円です。';
const recheckOriginal = sentence.replace('30万円', '40万円');
const amountRef = { id: 'test:amount', kind: 'taxanswer', no: '9999', title: '消費税の納付額',
  url: 'https://example.invalid/amount', text: right };
const claim = (text = sentence) => ({ sentence: text, type: '金額', subject: '簡易課税制度', claim: text });
const options = { now: new Date('2026-11-06T00:00:00Z'), enabled: true, provider: 'anthropic',
  model: 'claude-opus-5-5', batch: false, loadEvidenceText: ref => ref.text };

async function scenario({ writer = false, status = '裏付けあり', mixed = false, recheck = false, repair = true } = {}) {
  const body = recheck ? recheckOriginal : sentence + (mixed ? '\n\n' + wrong : '');
  const replacement = recheck ? sentence : right;
  const payable = recheck ? { ...amountRef, text: sentence } : amountRef;
  const calls = [], targets = [];
  let repaired = false;
  const fake = async req => {
    calls.push(req.task);
    if (req.task === 'extract') return (repaired ? [replacement] : recheck ? [recheckOriginal] : mixed ? [sentence, wrong] : [sentence]).map(claim);
    if (['judge', 'retry_judge'].includes(req.task)) return H.readPayload(req).claims.map(c => c.sentence === wrong || c.sentence === recheckOriginal
      ? { id: c.id, status: '食い違い', evidence_id: payable.id, quote: payable.text, correct: payable.text }
      : c.sentence === right
        ? { id: c.id, status: '裏付けあり', evidence_id: amountRef.id, quote: right }
        : { id: c.id, status, evidence_id: tableRef.id, quote: table, correct: status === '裏付けあり' ? '' : wrong });
    if (req.task === 'condition_check') return { verdict: '一致', conditions: [] };
    if (req.task === 'repair') {
      const corrections = JSON.parse(req.user).corrections;
      targets.push(...corrections);
      if (!mixed && !recheck) return [];
      repaired = true;
      return corrections.map(c => ({ id: c.id, replacement }));
    }
    throw new Error('予期しない偽AI: ' + req.task);
  };
  const select = c => c.sentence === recheckOriginal ? [payable, tableRef] : [wrong, right].includes(c.sentence) ? [payable] : [tableRef];
  const result = await F.checkFacts(body, { ...options, repair,
    ...(writer ? { writer_materials: ['ta:6505', 'ta:9999'], resolvedWriterMaterials: [tableRef, payable] } : { writer_materials: [] }),
    searchEvidence: select, searchWriterEvidence: select,
    callLLM: H.numberedFake(fake, { body, refs: [tableRef, payable] }) });
  assert.notEqual(result.record.status, 'not_run', JSON.stringify(result.record.error));
  return { ...result, originalBody: body, calls, targets };
}

for (const writer of [false, true]) test('1', `${writer ? '段A/B' : '通常'}: #693 の数字は本文に残し、人へ回す`, async () => {
  const result = await scenario({ writer });
  assert.equal(result.body, sentence, JSON.stringify(result.record.corrections) + result.record.repair_warning);
  assert.equal(result.record.status, 'ok', result.record.summary);
  assert.equal(result.record.claims[0].status, '資料なし');
  assert.equal(result.record.claims[0].reject_reason, REASON);
  assert.equal(result.record.claims[0].rejected_answer.status, '裏付けあり');
  assert.deepEqual(result.record.corrections, []);
  assert.deepEqual(result.record.remaining, []);
  assert.equal(result.calls.includes('repair'), false);
  assert.equal(result.record.review_items.length, 1);
  const item = result.record.review_items[0];
  assert.equal(item.status, REVIEW);
  assert.equal(item.sentence, sentence);
  assert.deepEqual(item.rejected_answer, result.record.claims[0].rejected_answer);
  assert.equal(item.rejected_answer.evidence, tableRef.id);
  assert.equal(item.rejected_answer.quote, table);
  assert.ok(result.record.summary.includes('AI 裏付けあり・数字未確認 1 件'));
  const saved = JSON.parse(JSON.stringify(F.compactRecord(result.record)));
  assert.deepEqual(saved.review_items[0].rejected_answer, item.rejected_answer);
});

for (const status of ['食い違い', '期限の書き漏れ']) test('2', `T2: 却下した${status}は引き続き書き換えの対象`, async () => {
  const result = await scenario({ status });
  assert.equal(result.record.claims[0].reject_reason, REASON);
  assert.equal(result.record.claims[0].rejected_answer.status, status);
  assert.ok(result.calls.includes('repair'));
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].sentence, sentence);
  assert.equal(result.record.status, 'revise');
  assert.equal(result.record.remaining.length, 1);
  assert.equal(result.record.review_items.some(c => c.status === REVIEW), false);
  assert.equal(result.record.summary.includes('AI 裏付けあり・数字未確認'), false);
});

test('3', 'T1: 引用が資料に無い AI の裏付けありは従来どおり止める', async () => {
  const pageCache = {};
  const rows = await F.judgeClaims([{ ...claim(), id: 'c1', heading: '' }], { c1: [tableRef] }, sentence, async req => {
    const packed = pageCache.groups[0].pack.pages[0];
    packed.ref = { ...packed.ref, text: 'この資料にはその引用がありません。', text_ranges: undefined };
    return [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }];
  }, { ...options, pageCache });
  assert.equal(rows[0].reject_reason, '引用が資料に無い');
  assert.equal(rows[0].rejected_answer.status, '裏付けあり');
  const result = await F.checkFacts(sentence, { ...options, repair: false, previousBody: sentence, previousClaims: rows,
    callLLM: async req => { assert.equal(req.task, 'extract'); return []; } });
  assert.equal(result.record.incremental.reused, 1);
  assert.equal(result.record.status, 'revise');
  assert.equal(result.record.remaining.length, 1);
  assert.equal(result.record.review_items.some(c => c.status === REVIEW), false);
});

for (const writer of [false, true]) test('4', `T3: ${writer ? '段A/B' : '通常'}の再照合の数字は従来どおり止める`, async () => {
  const result = await scenario({ writer, recheck: true });
  assert.equal(result.body, sentence, JSON.stringify(result.record.corrections) + result.record.repair_warning);
  assert.equal(result.record.rechecked.length, 1);
  assert.equal(result.record.rechecked[0].reject_reason, REASON, JSON.stringify(result.record.rechecked[0]));
  assert.equal(result.record.rechecked[0].rejected_answer.status, '裏付けあり');
  assert.equal(result.record.status, 'revise');
  assert.equal(result.record.corrections[0].resolved, false);
  assert.ok(result.record.remaining.includes(result.record.rechecked[0]));
  assert.equal(result.record.review_items.some(c => c.status === REVIEW), false);
});

for (const writer of [false, true]) test('5', `${writer ? '段A/B' : '通常'}: 別の文の食い違いだけを直す`, async () => {
  const result = await scenario({ writer, mixed: true });
  assert.equal(result.body, sentence + '\n\n' + right);
  assert.deepEqual(result.targets.map(c => c.sentence), [wrong]);
  assert.equal(result.record.corrections.length, 1);
  assert.equal(result.record.corrections[0].status, '食い違い');
  assert.equal(result.record.corrections[0].resolved, true);
  assert.equal(result.record.status, 'ok', result.record.summary);
  assert.deepEqual(result.record.remaining, []);
  assert.equal(result.record.review_items.length, 1);
  assert.equal(result.record.review_items[0].sentence, sentence);
});

test('6', 'T4: 要点に件数・文・AI の資料と引用を折りたたまず表示し、一覧でも先頭に置く', async () => {
  const result = await scenario();
  const record = JSON.parse(JSON.stringify(F.compactRecord(result.record)));
  const heading = 'AI は裏付けありと答えたが、数字を機械で確かめられなかった文 1 件（公開前に数字を確かめてください）';
  const summary = page.renderFactCheckSummary({}, record, result.body);
  assert.ok(summary.includes(heading));
  for (const text of [sentence, tableRef.url, table]) assert.ok(summary.includes(text), text);
  assert.equal(summary.includes('<details'), false);
  // 関係のない候補を先に入れても、AI が実際に引いた資料だけをリンクする。
  record.review_items[0].evidence_ids.unshift('other');
  record.evidence.other = { id: 'other', title: '別の候補', url: 'https://example.invalid/other' };
  record.review_items.unshift({ ...record.review_items[0], id: 'missing', status: '資料なし', sentence: '資料なしの文です。' });
  const html = page.renderFactCheck({}, record);
  const list = html.slice(html.indexOf('<details><summary>人が確かめる箇所'));
  assert.ok(list.indexOf(`<h4 class="h6">${REVIEW}</h4>`) < list.indexOf('<h4 class="h6">資料が見つからなかった記述</h4>'));
  assert.ok(list.includes(`<blockquote>${table}</blockquote>`));
  assert.equal(page.renderFactCheckSummary({}, record).includes('href="https://example.invalid/other"'), false);
  record.review_items = [];
  assert.equal(page.renderFactCheckSummary({}, record).includes('公開前に数字を確かめてください'), false);
  assert.equal(page.renderFactCheckSummary({}, { ...result.record, stale: true }).includes(heading), false);
});

test('6', '文・資料リンク・AI の引用をエスケープする', async () => {
  const result = await scenario();
  const item = result.record.review_items[0];
  item.sentence = '**' + sentence + '**<script>article()</script>';
  item.rejected_answer.quote = '<script>alert("x")</script>&引用';
  item.evidence[0] = { ...item.evidence[0], title: '<資料>', url: tableRef.url + '?x="<y>&z=1' };
  for (const html of [page.renderFactCheckSummary({}, result.record), page.renderFactCheck({}, result.record)]) {
    assert.ok(html.includes(sentence + '&lt;script&gt;article()&lt;/script&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;引用'));
    assert.ok(html.includes('&lt;資料&gt;'));
    assert.ok(html.includes('?x=&quot;&lt;y&gt;&amp;z=1'));
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('**'), false);
  }
  item.evidence[0].url = 'javascript:alert(1)';
  assert.equal(page.renderFactCheckSummary({}, result.record).includes('href="javascript:'), false);
});

for (const writer of [false, true]) test('1再利用', `${writer ? '段A/B' : '通常'}の previousClaims も同じ扱い`, async () => {
  const first = await scenario({ writer });
  const result = await F.checkFacts(sentence, { ...options, repair: false, previousBody: sentence, previousClaims: first.record.claims,
    ...(writer ? { writer_materials: ['ta:6505', 'ta:9999'], resolvedWriterMaterials: [tableRef, amountRef] } : { writer_materials: [] }),
    callLLM: async req => { assert.equal(req.task, 'extract'); return []; } });
  assert.equal(result.record.incremental.reused, 1);
  assert.equal(result.body, sentence);
  assert.equal(result.record.status, 'ok');
  assert.deepEqual(result.record.remaining, []);
  assert.equal(result.record.review_items.length, 1);
  assert.equal(result.record.review_items[0].status, REVIEW);
  assert.deepEqual(result.record.review_items[0].rejected_answer, first.record.claims[0].rejected_answer);
  assert.ok(result.record.summary.includes('AI 裏付けあり・数字未確認 1 件'));
});

(async () => {
  const fetch = global.fetch, mode = process.env.FACT_CHECK_WRITER_MATERIALS;
  global.fetch = async () => { throw new Error('試験中の通信は禁止'); };
  process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
  let passed = 0;
  try {
    for (const t of tests) {
      try { await t.run(); passed++; console.log(`PASS 試験${t.group}: ${t.name}`); }
      catch (error) { console.error(`FAIL 試験${t.group}: ${t.name}\n${error.stack}`); }
    }
  } finally {
    global.fetch = fetch;
    if (mode === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS;
    else process.env.FACT_CHECK_WRITER_MATERIALS = mode;
  }
  console.log(`試験1〜6・前回記録: PASS ${passed} / FAIL ${tests.length - passed}`);
  if (passed !== tests.length) process.exitCode = 1;
})();
