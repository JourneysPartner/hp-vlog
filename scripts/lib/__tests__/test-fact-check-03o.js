'use strict';

// 03o の回帰試験。実 AI・通信・実時間の待ちは使わない。
const assert = require('assert/strict');
const F = require('../fact-check');
const CM = require('../content-model');
const B = require('../article-prompt-builder');
const H = require('./fact-pages-test-helpers');
const U = require('../fact-units');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const now = new Date('2026-10-19T00:00:00Z');
const ref = (text, id = 'e1') => ({ id, kind: 'taxanswer', text, title: id, url: `https://example.jp/${id}`, law_version: '' });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '制度', heading: '', type: '金額', ...extra });
const options = { enabled: true, now, provider: 'anthropic', model: 'claude-opus-5-5' };
const raw = body => `---\nslug: fact-03o\nrecommendation: publish\n---\n${body}`;
const KEY = '試験用認証値-03o-0123456789';
const RIGHT = '基礎控除は110万円です。', WRONG = '基礎控除は120万円です。';
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => data, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
function clock() {
  let time = 0;
  return { now: () => time, advance: ms => { time += ms; }, sleep: async (ms, signal) => { assert.ok(!signal?.aborted); time += ms; } };
}
async function judge(sentence, source, basis, extra = {}) {
  const c = claim(sentence, extra.claim), e = ref(source);
  const rows = await F.judgeClaims([c], { c1: [e] }, sentence, async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis, ...extra.answer }],
    { ...options, loadEvidenceText: () => source });
  return rows[0];
}
function fake(request) {
  if (request.task === 'extract') return [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)]
    .filter(m => /控除/.test(m[2])).map(m => ({ s: Number(m[1]), type: '金額', subject: m[2].includes('特別') ? '特別控除' : '基礎控除', claim: m[2] }));
  if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: RIGHT }));
  const pages = H.materials(request);
  return JSON.parse(request.user).claims.map(c => {
    const page = pages.find(p => c.evidence_ids.includes(p.number));
    const row = page.rows.find(r => r.text.includes(c.subject)) || page.rows[0];
    return { id: c.id, status: c.claim === WRONG ? '食い違い' : '裏付けあり', evidence_id: page.number, basis: String(row.s),
      ...(c.claim === WRONG ? { correct: RIGHT } : {}) };
  });
}
function transport(hook = () => undefined) {
  const calls = [], batches = new Map();
  global.fetch = async (url, init) => {
    assert.ok(url.startsWith('https://api.anthropic.com/v1/messages'));
    const stage = url.endsWith('/batches') ? 'create' : url.endsWith('/cancel') ? 'cancel' : url.endsWith('/results') ? 'results' : url.includes('/batches/') ? 'status' : 'sync';
    let batch;
    if (stage === 'create') {
      const item = JSON.parse(init.body).requests[0];
      batch = { item, id: `batch-03o-${batches.size + 1}` }; batches.set(batch.id, batch);
    } else if (stage !== 'sync') batch = batches.get(url.split('/batches/')[1].split('/')[0]);
    const params = stage === 'sync' ? JSON.parse(init.body) : batch.item.params;
    const c = { stage, params, batch, init }; calls.push(c);
    const custom = await hook(c);
    if (custom !== undefined) return custom;
    if (stage === 'create') return reply({ id: batch.id });
    if (stage === 'status') return reply({ processing_status: 'ended' });
    if (stage === 'cancel') return reply({ processing_status: 'canceling' });
    const user = params.messages[0].content.at(-1).text;
    let task = 'extract';
    try { task = JSON.parse(user).corrections ? 'repair' : 'judge'; } catch (_) { /* 抜き出しは番号付き本文。 */ }
    const message = { content: [{ type: 'text', text: JSON.stringify(fake({ task, user, system: params.system.map(s => s.text).join('\n') })) }], stop_reason: 'end_turn' };
    return stage === 'sync' ? reply(message) : reply(JSON.stringify({ custom_id: batch.item.custom_id, result: { type: 'succeeded', message } }));
  };
  return calls;
}
const simpleIR = { staticSystem: '固定の指示', dynamicSystem: '可変の指示', user: '[1] ' + RIGHT };
const cmOptions = { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false, maxTokens: 8000, modelOptions: {} };

test('O1', '隣り合う表の行で却下した行の対応が末尾まで広がらない', () => {
  const first = '| 基礎控除 | 120万円 |';
  const second = '| 特別控除 | 300万円 |';
  const replacement = '| 特別控除 | 250万円 |';
  const tail = '後ろの無関係な文です。';
  const findings = [{ id: 'c1', sentence: first, after: '' }, { id: 'c2', sentence: second, after: replacement }];
  const pairs = F.correctionPairs([first, second, tail].join('\n'), [first, replacement, tail].join('\n'), findings,
    new Map([[second, replacement]]));
  assert.equal(pairs.get(first), first);
  assert.equal(pairs.get(second), replacement);
});

for (const count of [2, 3, 5]) test('O1', `隣接${count}行で再抜き出しに採用行だけを渡す`, async () => {
  const lines = Array.from({ length: count }, (_, i) => `| 控除${i + 1} | ${120 + i}万円 |`);
  const replacement = lines.at(-1).replace(`${119 + count}万円`, '110万円');
  const tail = '後ろの無関係な説明です。';
  const requests = [];
  let extracts = 0;
  const result = await F.checkFacts([...lines, tail].join('\n'), { ...options, searchEvidence: () => [ref('正しい控除の金額は110万円です。')],
    loadEvidenceText: e => e.text, callLLM: async r => {
      requests.push(r);
      if (r.task === 'extract') {
        extracts++;
        return [...r.user.matchAll(/^\[(\d+)\] (\|.*)$/gm)].map(m => ({ s: +m[1], type: '金額', subject: '控除', claim: m[2] }));
      }
      if (r.task === 'repair') return JSON.parse(r.user).corrections.map((c, i) => ({ id: c.id, replacement: i === count - 1 ? replacement : '' }));
      return JSON.parse(r.user).claims.map(c => ({ id: c.id, status: extracts === 1 ? '食い違い' : '裏付けあり',
        evidence_id: 1, basis: '1', ...(extracts === 1 ? { correct: '正しい控除の金額は110万円です。' } : {}) }));
    } });
  assert.equal(result.record.status, 'revise');
  const text = H.bodyText(requests.filter(r => r.task === 'extract')[1].user);
  assert.ok(text.includes(replacement)); assert.ok(!text.includes(tail));
  for (const line of lines.slice(0, -1)) assert.ok(!text.includes(line));
  const pairs = F.correctionPairs(lines.join('\n'), result.body, result.record.corrections);
  lines.forEach((line, i) => assert.equal(pairs.get(line), i === count - 1 ? replacement : line));
  assert.deepEqual(result.record.corrections.map(c => c.after), lines.map((_, i) => i === count - 1 ? replacement : ''));
});
test('O1', '却下だけなら再照合を呼ばない', async () => {
  const calls = [];
  const r = await F.checkFacts(WRONG, { ...options, searchEvidence: () => [ref(RIGHT)], loadEvidenceText: e => e.text,
    callLLM: async req => { calls.push(req); return req.task === 'repair' ? [{ id: 'c1', replacement: '' }] : fake(req); } });
  assert.equal(r.body, WRONG); assert.equal(r.record.rechecked.length, 0);
  assert.deepEqual(calls.map(c => c.task), ['extract', 'judge', 'repair']);
});
test('O1', '期限追記で足した文も再照合する', async () => {
  const sentence = '基礎控除を利用できます。', addition = '申告期限は3月15日です。';
  const calls = [];
  await F.checkFacts(sentence, { ...options, searchEvidence: () => [ref(sentence + addition)], loadEvidenceText: e => e.text,
    callLLM: async r => {
      calls.push(r);
      if (r.task === 'extract') return [...r.user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => ({ s: +m[1], type: '期限', subject: '制度', claim: m[2] }));
      if (r.task === 'repair') return [{ id: 'c1', replacement: sentence + addition }];
      return JSON.parse(r.user).claims.map(c => ({ id: c.id, status: calls.filter(r => r.task === 'extract').length === 1 ? '期限の書き漏れ' : '裏付けあり', evidence_id: 1, basis: '1-2', correct: addition }));
    } });
  assert.ok(H.bodyText(calls.filter(c => c.task === 'extract')[1].user).includes(addition));
});
test('O2', 'Batchはキャッシュなし、同期は従来の本文とバイト一致', async () => {
  const wire = transport();
  for (const cache of ['true', 'false']) {
    process.env.CONTENT_MODEL_USE_PROMPT_CACHE = cache;
    await CM.generateContent(simpleIR, cmOptions);
    assert.equal(wire.at(-1).init.body, JSON.stringify(B.toAnthropicRequest(simpleIR, { model: cmOptions.model, maxTokens: 8000, useCache: cache === 'true', modelOptions: {} })));
    await CM.generateContent(simpleIR, { ...cmOptions, batch: CM.createBatchContext(clock()) });
    const params = wire.findLast(c => c.stage === 'create').params;
    assert.ok(!JSON.stringify(params).includes('cache_control'));
    const sync = JSON.parse(wire.findLast(c => c.stage === 'sync').init.body);
    for (const b of sync.system) delete b.cache_control;
    assert.deepEqual(params, sync);
  }
});
for (const mode of ['batch', 'sync', 'disabled']) test('O2', `${mode}の再判定資料表と初回キャッシュ`, async () => {
  const a = ref(RIGHT, 'a'), b = ref('特別控除は2500万円です。' + '補足の原文です。'.repeat(40), 'b');
  const seen = [], cache = {}, batch = mode === 'sync' ? null : { disabled: false };
  const first = [claim(RIGHT), claim('特別控除は2500万円です。', { id: 'c2', subject: '特別控除' })];
  const run = (claims, evidence) => F.judgeClaims(claims, evidence, first.map(c => c.sentence).join('\n'), r => { seen.push(r); return fake(r); }, { ...options, batch, pageCache: cache, loadEvidenceText: e => e.text });
  await run(first, { c1: [a], c2: [b] });
  const saved = cache.groups;
  if (mode === 'disabled') batch.disabled = true;
  await run(first.slice(0, 1), { c1: [a] });
  assert.equal(cache.groups, saved);
  if (mode === 'batch') { assert.ok(seen[1].system.length < seen[0].system.length); assert.ok(!seen[1].system.includes(b.url)); }
  else assert.equal(seen[1].system, seen[0].system);
});
test('O3', '割・漢数字・中黒・割分を割合にし、一般語と読点を広げない', () => {
  for (const s of ['2割', '二割', '2割特例']) assert.deepEqual(F.normalizedNumbers(s), ['割合:1/5']);
  assert.deepEqual(F.normalizedNumbers('3割 7割 10割'), ['割合:3/10', '割合:7/10', '割合:1/1']);
  assert.deepEqual(F.normalizedNumbers('7・5・3割'), ['割合:7/10', '割合:1/2', '割合:3/10']);
  assert.deepEqual(F.normalizedNumbers('2割5分'), ['割合:1/4']);
  assert.deepEqual(F.normalizedNumbers('二割五分'), ['割合:1/4']);
  assert.deepEqual(F.normalizedNumbers('七・五・三割'), ['割合:7/10', '割合:1/2', '割合:3/10']);
  assert.deepEqual(F.normalizedNumbers('-2割5分'), ['割合:-1/4']);
  assert.deepEqual(F.normalizedNumbers('2割5分', [0, 3]), []);
  assert.deepEqual(F.normalizedNumbers('1.2.5割'), [null]);
  for (const s of ['割合', '割引', '数割', '5分', '2割合']) assert.ok(!F.normalizedNumbers(s).some(n => n?.startsWith('割合:')));
  assert.deepEqual(F.normalizedNumbers('1、2、3割'), ['1', '2', '割合:3/10']);
});
for (const [sentence, source] of [
  ['2割特例の納付税額は売上税額の20%です。', 'その納付税額を売上税額の2割とすることができる経過措置（2割特例）。'],
  ['元請は70%しか控除できません。', '仕入税額相当額の一定割合（80パーセント、7・5・3割）。'],
]) test('O3', 'TA No.6498の割と百分率が一致する: ' + sentence, async () => assert.equal((await judge(sentence, source, '1', { claim: { type: '割合' } })).status, '裏付けあり'));
test('O4', '引用そのものの同年年月日だけを年の裏付けにする', async () => {
  const sentence = '個人事業者の2割特例は令和8年分が最後です。';
  const source = '令和5年10月1日から令和8年9月30日までの日の属する課税期間において、その納付税額を売上税額の2割とすることができる。';
  assert.equal((await judge(sentence, source, '1', { claim: { type: '適用年' } })).status, '裏付けあり');
  assert.equal((await judge('2026年分が対象です。', '2026年9月30日までの課税期間が対象です。', '1', { claim: { type: '適用年' } })).status, '裏付けあり');
  for (const [s, text, basis] of [
    ['令和8年分が対象です。', '[令和8年4月1日現在法令等]\n対象の課税期間について説明しています。', '1-2'],
    ['令和8年分が対象です。', '令和8年9月30日までです。\n対象の課税期間について説明しています。', '2'],
    ['2026年分が対象です。', source, '1'],
    ['令和8年3月31日までです。', '令和8年が対象の課税期間です。', '1'],
  ]) assert.equal((await judge(s, text, basis, { claim: { type: '期限' } })).status, '資料なし');
  const original = '令和8年分の控除は120万円です。';
  const repair = await F.repairBody(original, [{ ...claim(original, { claim: '控除は120万円です。' }), status: '資料なし',
    keep: [{ claim: '令和8年分が対象です。' }] }], async () => [{ id: 'c1', replacement: '令和8年9月30日までの課税期間について確認してください。' }]);
  assert.equal(repair.body, original); assert.equal(repair.rejected.get('c1'), '裏付けのある数字を消しています');
});
test('O4', '3文から絞るときも引用内の年だけの例外を使う', async () => {
  const r = await judge('令和8年分が対象です。', '令和8年9月30日までの課税期間が対象です。\n説明が続きます。\n最後の説明です。', '1-3', { claim: { type: '適用年' } });
  assert.equal(r.status, '裏付けあり'); assert.equal(r.quote, '令和8年9月30日までの課税期間が対象です。');
});
for (const type of ['期限', '金額', '割合', '適用年']) test('O5', `数字のない${type}は長さを確かめ、correctの数字は確かめる`, async () => {
  const s = '延納申請は納期限までに行う必要があります。';
  assert.equal((await judge(s, s, '1', { claim: { type } })).status, '裏付けあり');
  assert.equal((await judge(s, '申請期限は3月15日です。', '1', { claim: { type }, answer: { status: '食い違い', correct: '申請期限は3月15日です。' } })).status, '食い違い');
  assert.equal((await judge(s, s, '1', { claim: { type }, answer: { status: '食い違い', correct: '申請期限は3月15日です。' } })).status, '資料なし');
  assert.equal((await judge(s, s, '1', { claim: { type }, answer: { status: '食い違い', correct: '申請は必須です。' } })).status, '食い違い');
});
const distantSource = ['説明の最初です。', '概要を説明します。', '贈与の額が110万円を超える場合は申告が必要です。',
  ...Array(5).fill('資料の中間の説明が続きます'.repeat(15) + '。'), '申告期間は翌年2月1日から3月15日までです。', '末尾の説明です。', 'その他の説明です。', '最後の説明です。'].join('\n');
const distantClaim = '110万円を超えたら翌年2月1日から3月15日に申告します。';
// 間の説明は各300字以内の1文にし、3文目と9文目を300字以上離す。
const distantUnits = U.splitUnits(distantSource, { material: true });
const deadlineNo = distantUnits.find(u => u.text.startsWith('申告期間')).s;
const distantBasis = `3,${deadlineNo}`;
test('O6', '離れた2範囲の引用を保存し、差分照合でも使い回す', async () => {
  assert.equal(distantBasis, '3,9');
  const r = await judge(distantClaim, distantSource, distantBasis, { claim: { type: '期限' } });
  assert.equal(r.status, '裏付けあり');
  assert.equal(r.quote, distantUnits[2].text + '\n…\n' + distantUnits.find(u => u.s === deadlineNo).text);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03o-'));
  const opts = { ...options, recordDir: dir, repair: false, searchEvidence: () => [ref(distantSource)], loadEvidenceText: () => distantSource,
    callLLM: async req => req.task === 'extract' ? [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => m[2] === distantClaim).map(m => ({ s: +m[1], type: '期限', subject: '制度', claim: distantClaim }))
      : [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: distantBasis }] };
  try {
    const before = raw(distantClaim);
    await F.checkArticle(before, opts);
    const next = await F.checkArticle(raw(distantClaim + '\n案内を追記します。'), { ...opts, previousRaw: before, persist: false });
    assert.equal(next.record.incremental.reused, 1);
    // 一方の引用が存在しなければ、記録を使い回さず全体照合へ戻す。
    const file = F.recordPath('fact-03o', dir), prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    prior.claims[0].quote += '\n…\n存在しない引用です。'; fs.writeFileSync(file, JSON.stringify(prior));
    const invalid = await F.checkArticle(raw(distantClaim + '\n案内を追記します。'), { ...opts, previousRaw: before, persist: false });
    assert.equal(invalid.record.incremental, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('O6', '範囲の数・重なり・別資料・連続の文数を制限する', async () => {
  for (const basis of ['3,9,12', '3-5,9', `3-4,4`, `3,資料2:${deadlineNo}`, '1-5,9']) {
    assert.equal((await judge(distantClaim, distantSource, basis, { claim: { type: '期限' } })).status, '資料なし');
  }
  assert.deepEqual(U.basisRanges('12,13'), ['12-13']);
  assert.equal((await judge(RIGHT, RIGHT + '\n補足の説明が続きます。', '1,2')).status, '裏付けあり');
  const irreducible = '令和8年9月30日までです。\n中間の説明です。\n令和9年9月30日までです。\n' + '間の説明です。'.repeat(90) + '\n控除額は110万円です。';
  const us = U.splitUnits(irreducible, { material: true }), end = us.find(u => u.text.includes('110万円')).s;
  assert.equal((await judge('令和8年分と令和9年分は110万円です。', irreducible, `1-3,${end}`, { claim: { type: '期限' } })).status, '資料なし');
});
test('O6', '各部分の実在・長さ・300字の数字の確認を弱めない', () => {
  const e = ref(RIGHT + '空'.repeat(700) + '申告は3月15日です。');
  const c = claim('110万円、3月15日が対象です。', { type: '期限' });
  assert.ok(F.sufficientQuote(c, { quote: RIGHT + '\n…\n申告は3月15日です。' }, e, '裏付けあり'));
  assert.ok(!F.sufficientQuote(c, { quote: RIGHT }, e, '裏付けあり'));
  assert.ok(!F.sufficientQuote(claim('令和8年分です。', { type: '期限' }), { quote: RIGHT + '\n…\n申告は3月15日です。' }, e, '裏付けあり'));
});
test('O6', 'レビュー画面と公開監査は部分ごとの抜粋を表示する', async () => {
  const page = require('../../../netlify/functions/review-page'), audit = require('../../audit-published-facts'), A = require('../fact-audit');
  const r = await judge(distantClaim, distantSource, distantBasis, { claim: { type: '期限' } });
  const finding = { ...r, status: '食い違い', correct: distantClaim };
  const record = { status: 'revise', claims: [finding], corrections: [], remaining: [finding], review_items: [] };
  const html = page.renderReviewPage('2026-10-19-fact-03o.md', { slug: 'fact-03o' }, '<p>本文</p>', 'main', null, record);
  for (const part of F.quoteParts(r.quote)) assert.ok(html.includes(part));
  assert.ok(!html.includes('\n…\n'));
  const report = audit.renderReport([record]);
  assert.equal((report.match(/根拠の抜粋:/g) || []).length, 2);
  assert.equal((A.auditInstructions(record).split('\n')[3]), '根拠の抜粋: ' + F.quoteParts(r.quote)[0]);
});
test('O7', '落とした答えの番号と引用を行に残し、表へ入れない', async () => {
  const r = await judge('控除は120万円です。', RIGHT, '1');
  assert.equal(r.status, '資料なし');
  assert.deepEqual(r.rejected_answer, { status: '裏付けあり', evidence: 'e1', basis: '1', quote: RIGHT });
  assert.deepEqual(F.compactRecord({ claims: [r] }).claims[0].rejected_answer, r.rejected_answer);
  const bad = await judge(RIGHT, RIGHT, '1234567890'.repeat(8), { answer: { evidence_id: 99 } });
  assert.equal(bad.rejected_answer.evidence, 99); assert.equal(bad.rejected_answer.basis.length, 40); assert.equal(bad.rejected_answer.quote, '');
  const long = await judge(WRONG, '基礎控除は110万円です' + '原文の説明'.repeat(45) + '。', '1');
  assert.equal(long.rejected_answer.quote.length, 200);
});
test('O8', '抜き出しと再抜き出しだけeffortを変え、未指定時は従来どおり', async () => {
  process.env.FACT_CHECK_EXTRACT_EFFORT = 'low';
  const envCalls = transport();
  const envResult = await F.checkFacts(WRONG, { ...options, effort: 'high', searchEvidence: () => [ref(RIGHT)], loadEvidenceText: e => e.text });
  assert.equal(envResult.record.extract_effort, 'low');
  assert.deepEqual(envCalls.map(c => c.params.output_config.effort), ['low', 'high', 'high', 'low', 'high']);
  delete process.env.FACT_CHECK_EXTRACT_EFFORT;
  for (const effort of [undefined, 'high']) for (const extractEffort of [undefined, 'low']) {
    const calls = transport();
    const result = await F.checkFacts(WRONG, { ...options, effort, extractEffort, searchEvidence: () => [ref(RIGHT)], loadEvidenceText: e => e.text });
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.extract_effort, extractEffort || effort || null);
    assert.deepEqual(result.record.calls.map(c => c.task), ['extract', 'judge', 'repair', 'recheck_extract', 'recheck_judge']);
    calls.forEach((c, i) => assert.deepEqual(c.params.output_config, ([0, 3].includes(i) ? extractEffort || effort : effort) ? { effort: [0, 3].includes(i) ? extractEffort || effort : effort } : undefined));
  }
});
test('O8', '不正な抜き出しeffortではAIを呼ばない', async () => {
  process.env.FACT_CHECK_EXTRACT_EFFORT = 'fast';
  const r = await F.checkFacts(RIGHT, { ...options, callLLM: () => { throw new Error('呼んではいけない'); } });
  assert.equal(r.record.status, 'not_run'); assert.equal(r.record.summary, '照合のモデル設定が不正です'); assert.equal(r.record.calls.length, 0);
});
test('O8', '差分記録のextract_effort不一致と古い記録のeffortを確かめる', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03o-effort-'));
  const opts = { ...options, recordDir: dir, effort: 'high', repair: false, searchEvidence: () => [ref(RIGHT)], loadEvidenceText: e => e.text, callLLM: fake };
  try {
    const before = raw(RIGHT), after = raw(RIGHT + '\n案内を追記します。');
    await F.checkArticle(before, opts);
    const file = F.recordPath('fact-03o', dir), prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete prior.extract_effort; fs.writeFileSync(file, JSON.stringify(prior));
    const same = await F.checkArticle(after, { ...opts, previousRaw: before, persist: false });
    assert.equal(same.record.incremental.reused, 1);
    const changed = await F.checkArticle(after, { ...opts, extractEffort: 'low', previousRaw: before, persist: false });
    assert.equal(changed.record.incremental, undefined);
    assert.equal(changed.record.logic_version, '03r');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('O8', '省略したcorrect・資料なしの番号が従来の空欄と同じ記録になる', async () => {
  const a = await judge(RIGHT, RIGHT, '1');
  const b = await judge(RIGHT, RIGHT, '1', { answer: { correct: '' } });
  assert.deepEqual(a, b);
  const c = await judge(RIGHT, RIGHT, undefined, { answer: { status: '資料なし', evidence_id: undefined } });
  const d = await judge(RIGHT, RIGHT, '', { answer: { status: '資料なし', evidence_id: null, correct: null } });
  assert.deepEqual(c, d);
});
test('O9', '待ちが60秒または確認間隔未満なら作成しない', async () => {
  for (const [maxWaitMs, pollMs] of [[59000, 5000], [80000, 90000]]) {
    const wire = transport(), batch = CM.createBatchContext({ ...clock(), maxWaitMs, pollMs });
    const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch });
    assert.equal(ret.mode, 'sync'); assert.equal(batch.disabled, true); assert.deepEqual(wire.map(c => c.stage), ['sync']);
  }
});
test('O9', '作成の60秒を待ち予算から外す', async () => {
  const time = clock(), delays = [], saved = global.setTimeout;
  const wire = transport(c => { if (c.stage === 'create') time.advance(59000); });
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return saved(fn, ms, ...args); };
  try {
    const batch = CM.createBatchContext({ ...time, maxWaitMs: 60000 });
    const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch });
    assert.equal(ret.mode, 'batch'); assert.equal(batch.waitedMs, 0); assert.equal(wire.filter(c => c.stage === 'sync').length, 0);
    assert.equal(delays[0], 60000); assert.equal(delays[1], 60000);
  } finally { global.setTimeout = saved; }
});
test('O9', '作成が失敗しても通信時間を待ち予算に含めない', async () => {
  const time = clock();
  transport(c => { if (c.stage === 'create') { time.advance(50000); return reply({}, 500); } });
  const batch = CM.createBatchContext({ ...time, maxWaitMs: 60000 });
  const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch });
  assert.equal(ret.mode, 'sync-fallback'); assert.equal(batch.waitedMs, 0); assert.equal(ret.wait_seconds, 0);
});
for (const failure of ['status503', 'status429', 'network', 'results500']) test('O9', `${failure}は間隔を空けて再試行し同期を呼ばない`, async () => {
  const time = clock(); let attempts = 0;
  const wire = transport(c => {
    if (c.stage === (failure === 'results500' ? 'results' : 'status')) {
      attempts++;
      if (attempts <= 2) {
        if (failure === 'network') throw new TypeError('通信失敗');
        return reply({}, failure === 'status429' ? 429 : failure === 'results500' ? 500 : 503);
      }
    }
  });
  const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch: CM.createBatchContext({ ...time, pollMs: 5000 }) });
  assert.equal(ret.mode, 'batch'); assert.equal(attempts, 3); assert.equal(time.now(), 10000);
  assert.equal(wire.filter(c => c.stage === 'sync').length, 0);
});
test('O9', 'endedの時点で待ち予算が尽きても結果を再取得する', async () => {
  const time = clock(); let attempts = 0;
  const wire = transport(c => {
    if (c.stage === 'status') time.advance(60000);
    if (c.stage === 'results' && ++attempts <= 2) return reply({}, 500);
  });
  const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch: CM.createBatchContext({ ...time, maxWaitMs: 60000, pollMs: 5000 }) });
  assert.equal(ret.mode, 'batch'); assert.equal(attempts, 3); assert.equal(wire.filter(c => c.stage === 'sync').length, 0);
});
test('O9', 'ended後の結果は既定の間隔でも3回まで再試行する', async () => {
  const time = clock(); let attempts = 0;
  const wire = transport(c => {
    if (c.stage === 'status') time.advance(60000);
    if (c.stage === 'results' && ++attempts <= 3) return reply({}, 500);
  });
  const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch: CM.createBatchContext({ ...time, maxWaitMs: 60000 }) });
  assert.equal(ret.mode, 'batch'); assert.equal(attempts, 4); assert.equal(time.now(), 75000);
  assert.equal(wire.filter(c => c.stage === 'sync').length, 0);
});
for (const cancelOK of [true, false]) test('O9', `同期やり直しの警告にID・理由・取消の成否だけを出す（${cancelOK}）`, async logs => {
  const wire = transport(c => c.stage === 'status' ? reply({ error: { message: KEY } }, 400) : c.stage === 'cancel' && !cancelOK ? reply({}, 500) : undefined);
  const ret = await CM.generateContent(simpleIR, { ...cmOptions, batch: CM.createBatchContext(clock()) });
  assert.equal(ret.mode, 'sync-fallback'); assert.equal(wire.filter(c => c.stage === 'sync').length, 1);
  const warnings = logs.filter(s => s.includes('Batch同期やり直し'));
  assert.equal(warnings.length, 1); assert.match(warnings[0], /batch_id=batch-03o-1/);
  assert.ok(warnings[0].includes(`cancel_attempted=true cancel_succeeded=${cancelOK}`)); assert.ok(!warnings[0].includes(KEY));
});
test('O9', '待ち上限は180分、呼び出しの制限は通信と取消の余裕250秒を含む', async () => {
  process.env.FACT_CHECK_BATCH_MAX_WAIT_MINUTES = '500'; assert.equal(F.config().batchMaxWaitMs, 180 * 60000);
  const saved = global.setTimeout, delays = []; transport();
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return saved(fn, ms, ...args); };
  try {
    const r = await F.checkFacts(RIGHT, { ...options, batch: true, batchMaxWaitMinutes: 2, timeoutMs: 1000, batchRuntime: clock(), searchEvidence: () => [ref(RIGHT)], loadEvidenceText: e => e.text });
    assert.equal(r.record.status, 'ok'); assert.ok(delays.includes(371000));
  } finally { global.setTimeout = saved; }
});
test('O10', '5本のenv・監査の設定・手動の入力をenv経由で渡す', () => {
  for (const name of ['daily-draft', 'regenerate-draft', 'refresh-article', 'audit-published-facts', 'fact-check']) {
    const s = fs.readFileSync(path.join(__dirname, '../../../.github/workflows', name + '.yml'), 'utf8');
    assert.match(s, /FACT_CHECK_EXTRACT_EFFORT: \$\{\{ (?:inputs.extract_effort \|\| )?vars.FACT_CHECK_EXTRACT_EFFORT \}\}/);
    if (name === 'audit-published-facts') { assert.match(s, /FACT_CHECK_EXTRACT_MODEL: \$\{\{ vars.FACT_CHECK_EXTRACT_MODEL/); assert.match(s, /FACT_CHECK_EFFORT: \$\{\{ vars.FACT_CHECK_EFFORT/); assert.ok(!s.includes('FACT_CHECK_BATCH:')); }
    if (name === 'fact-check') {
      for (const key of ['effort', 'extract_effort']) assert.match(s, new RegExp(`      ${key}:\\n        description: [^\\n]+\\n        type: string\\n        required: false`));
      assert.match(s, /FACT_CHECK_EFFORT: \$\{\{ inputs.effort \|\| vars.FACT_CHECK_EFFORT/);
      assert.ok(![...s.matchAll(/        run: \|\n((?:          .*\n|\n)*)/g)].some(m => /inputs\.(?:effort|extract_effort)/.test(m[1])));
    }
  }
});

(async () => {
  const counts = {};
  for (const t of tests) {
    counts[t.group] ||= { pass: 0, fail: 0 };
    const savedEnv = { ...process.env }, savedFetch = global.fetch, log = console.log, warn = console.warn, logs = [];
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith('FACT_CHECK_') || k.startsWith('CONTENT_MODEL_')) delete process.env[k];
      process.env.ANTHROPIC_API_KEY = KEY;
      global.fetch = async () => { throw new Error('定義のない通信は禁止'); };
      console.log = console.warn = (...args) => logs.push(args.join(' '));
      await t.run(logs); assert.ok(!logs.join('\n').includes(KEY));
      counts[t.group].pass++; log(`PASS ${t.group} ${t.name}`);
    }
    catch (e) { counts[t.group].fail++; log(`FAIL ${t.group} ${t.name}: ${e.stack}`); }
    finally {
      console.log = log; console.warn = warn; global.fetch = savedFetch;
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
      Object.assign(process.env, savedEnv);
    }
  }
  console.log(JSON.stringify(counts));
  process.exitCode = Object.values(counts).some(c => c.fail) ? 1 : 0;
})();
