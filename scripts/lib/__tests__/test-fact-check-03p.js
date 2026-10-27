'use strict';

// 03p の回帰試験。通信・時計・LLM は偽物にし、実 AI は呼ばない。
const assert = require('assert/strict');
const matter = require('gray-matter');
const F = require('../fact-check');
const CM = require('../content-model');
const H = require('./fact-pages-test-helpers');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const now = new Date('2026-10-20T00:00:00Z');
const WRONG = '基礎控除は120万円です。', RIGHT = '基礎控除は110万円です。';
const WRONG_DATE = '基礎控除の期限は3月10日です。', RIGHT_DATE = '基礎控除の期限は3月15日です。';
const SOURCE = RIGHT + '\n' + RIGHT_DATE;
const KEY = '試験用認証値-03p-0123456789';
const ref = (text = SOURCE, id = 'e1') => ({ id, kind: 'taxanswer', title: id, url: `https://example.jp/${id}`, text, law_version: '' });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, type: '期限', subject: '基礎控除', heading: '', ...extra });
const options = { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', now, loadEvidenceText: e => e.text };
const raw = body => `---\nslug: fact-03p\nrecommendation: publish\n---\n${body}`;
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => data, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
function clock() {
  let time = 0;
  return { now: () => time, advance: ms => { time += ms; }, sleep: async (ms, signal) => { assert.ok(!signal?.aborted); time += ms; } };
}
function assertBlocked(result) {
  assert.equal(result.record.status, 'revise'); assert.ok(result.record.remaining.length > 0);
  const meta = matter(F.applyFactResult(raw(result.body), result)).data;
  assert.equal(meta.recommendation, 'revise'); assert.equal(meta.fact_check_blocking, true);
}
async function scenario({ body = WRONG + '\n' + WRONG_DATE, replacements = [WRONG, RIGHT_DATE], source = SOURCE,
  extractFilter = () => true, initialStatus = '食い違い', recheckStatus = () => '裏付けあり', subject = () => '基礎控除',
  searchEvidence = () => [ref(source)], onJudge = () => {} } = {}) {
  let extracts = 0;
  const requests = [];
  const result = await F.checkFacts(body, { ...options, searchEvidence, callLLM: async request => {
    requests.push(request);
    if (request.task === 'extract') {
      extracts++;
      return [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => !/^#/.test(m[2]) && (extracts === 1 || extractFilter(m[2])))
        .map(m => ({ s: +m[1], type: /万円/.test(m[2]) ? '金額' : '期限', subject: subject(m[2]), claim: m[2] }));
    }
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map((c, i) => ({ id: c.id, replacement: replacements[i] }));
    onJudge(request, extracts > 1);
    return H.readPayload(request).claims.map(c => {
      const status = extracts === 1 ? typeof initialStatus === 'function' ? initialStatus(c) : initialStatus : recheckStatus(c);
      return { id: c.id, status, evidence_id: c.evidence_ids[0], basis: /万円/.test(c.sentence) ? '1' : '2',
        ...(status === '裏付けあり' ? {} : { correct: c.subject === '別制度' ? '別制度の控除は200万円です。' : /万円/.test(c.sentence) ? RIGHT : RIGHT_DATE }) };
    });
  } });
  return { ...result, requests };
}

test('P1', '同じ文を返した食い違いは別の文が直っても未解決で止まる', async () => {
  const result = await scenario();
  assertBlocked(result); assert.ok(result.body.includes(WRONG)); assert.ok(result.body.includes(RIGHT_DATE));
  assert.equal(result.record.corrections[0].reason, '置き換え後の文が元の文と同じです');
  assert.equal(result.record.corrections[0].after, ''); assert.equal(result.record.corrections[0].resolved, false);
  assert.equal(result.record.corrections[1].resolved, true);
  assert.deepEqual(result.record.remaining.map(c => c.sentence), [WRONG]);
});
for (const status of ['食い違い', '期限の書き漏れ', '資料なし']) test('P1', `${status}は同一文と書式だけの変更を却下する`, async () => {
  for (const replacement of [WRONG, '**基礎控除**は１２０万円です。', '基礎控除は 120万円です。']) {
    const result = await F.repairBody(WRONG, [{ ...claim(WRONG, { type: '金額' }), status }], async () => [{ id: 'c1', replacement }]);
    assert.equal(result.body, WRONG); assert.equal(result.rejected.get('c1'), '置き換え後の文が元の文と同じです');
    assert.equal(result.replacements.size, 0);
  }
});
test('P1', '書き換えた文自身の裏付けが無ければ同じ制度名の別の文で解決しない', async () => {
  const stillWrong = '基礎控除は121万円です。';
  const result = await scenario({ replacements: [stillWrong, RIGHT_DATE], extractFilter: s => s === RIGHT_DATE });
  assertBlocked(result); assert.ok(result.body.includes(stillWrong));
  assert.equal(result.record.corrections[0].resolved, false); assert.equal(result.record.corrections[1].resolved, true);
});
test('P1', '止める主張は同じ制度名の別の文まで広く見る', async () => {
  const result = await scenario({ replacements: [RIGHT, WRONG_DATE.replace('10日', '11日')],
    recheckStatus: c => /万円/.test(c.sentence) ? '裏付けあり' : '資料なし' });
  assertBlocked(result); assert.equal(result.record.corrections[0].resolved, false);
});
test('P1', '両方を正しく修正すると両方とも解決する', async () => {
  const result = await scenario({ replacements: [RIGHT, RIGHT_DATE] });
  assert.equal(result.record.status, 'ok'); assert.equal(result.record.remaining.length, 0);
  assert.ok(result.record.corrections.every(c => c.resolved)); assert.equal(result.body, RIGHT + '\n' + RIGHT_DATE);
});
test('P1', '期限追記は追加した文自身が裏付けありなら解決する', async () => {
  const original = '基礎控除を利用できます。';
  const result = await scenario({ body: original, replacements: [original + RIGHT_DATE], source: original + '\n' + RIGHT_DATE,
    initialStatus: '期限の書き漏れ', extractFilter: s => s === RIGHT_DATE });
  assert.equal(result.record.status, 'ok'); assert.equal(result.record.corrections[0].resolved, true);
  assert.equal(result.body, original + RIGHT_DATE);
});

async function judge(sentence, { type = '期限', source = '確定申告書の提出が必要となる場合の手続を説明しています。', basis = '1', status = '裏付けあり', correct } = {}) {
  const rows = await F.judgeClaims([claim(sentence, { type })], { c1: [ref(source)] }, sentence,
    async () => [{ id: 'c1', status, evidence_id: 1, basis, ...(correct === undefined ? {} : { correct }) }], options);
  return rows[0];
}
for (const type of ['期限', '金額']) test('P2', `${type}の読めない漢数字の条番号を数字なしとして通さない`, async () => {
  for (const sentence of ['所得税法百二十条により確定申告書の提出が必要です。', '措置法七十条の四により提出が必要です。', '六九の四−一により提出が必要です。']) {
    assert.deepEqual(F.normalizedNumbers(sentence), []);
    const row = await judge(sentence, { type });
    assert.equal(row.status, '資料なし'); assert.equal(row.reject_reason, '引用が短い・数字が引用の近くに無い');
    const result = await F.checkFacts(sentence, { ...options, repair: false, searchEvidence: () => [ref('確定申告書の提出が必要となる場合の手続を説明しています。')],
      callLLM: async r => r.task === 'extract' ? [{ s: 1, type, subject: '基礎控除', claim: sentence }] : [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }] });
    assertBlocked(result);
  }
});
test('P2', '範囲を絞る処理でも読めない条番号を数字なしとして救わない', async () => {
  const source = '確定申告書の提出が必要となる場合の手続を説明しています。\n対象となる申請者について説明します。\n提出先の確認方法を説明します。';
  const row = await judge('所得税法百二十条により確定申告書の提出が必要です。', { source, basis: '1-3' });
  assert.equal(row.status, '資料なし'); assert.equal(row.reject_reason, '数字の主張の根拠が2文を超える');
});
test('P2', '数字も条番号も無い主張と、数字なしのcorrectは従来どおり確認する', async () => {
  const sentence = '延納申請は納期限までに行う必要があります。';
  assert.equal((await judge(sentence)).status, '裏付けあり');
  assert.equal((await judge(sentence, { status: '食い違い', correct: '申請の提出は必須です。' })).status, '食い違い');
  assert.equal((await judge(sentence, { status: '食い違い', correct: '期限は3月15日です。' })).status, '資料なし');
});
test('P3', '算用数字の件数・回数の割は読み、数十割・数割は読まない', () => {
  assert.deepEqual(F.normalizedNumbers('件数2割'), ['割合:1/5']);
  assert.deepEqual(F.normalizedNumbers('回数3割増'), ['割合:3/10']);
  for (const s of ['数十割', '数割', '数百割', '数二割']) assert.deepEqual(F.normalizedNumbers(s), []);
  assert.deepEqual(F.normalizedNumbers('二割五分'), ['割合:1/4']);
  assert.deepEqual(F.normalizedNumbers('7・5・3割'), ['割合:7/10', '割合:1/2', '割合:3/10']);
});
test('Q1', '漢字の名詞に続く数は漢数字も従来どおり読む', () => {
  for (const [text, expected] of [
    ['耐用年数四年', ['4']], ['滞在日数百八十三日', ['183']], ['人数二人', ['2']],
    ['件数二件', ['2']], ['年数四年', ['4']], ['件数二割', ['割合:1/5']], ['回数三割増', ['割合:3/10']],
  ]) assert.deepEqual(F.normalizedNumbers(text), expected, text);
});
test('Q1', '数十・数百・十数の概数と数割は引き続き読まない', () => {
  for (const text of ['数十万円', '数百万円', '数十%', '数十割', '数割', '十数万円']) {
    assert.deepEqual(F.normalizedNumbers(text), [], text);
  }
});
test('Q1', '除外した分母の分子も読み飛ばし、後続の別の数と正確な分数は読む', () => {
  for (const text of ['数十分の一', '数百分の一', '十数万分の一']) assert.deepEqual(F.normalizedNumbers(text), [], text);
  assert.deepEqual(F.normalizedNumbers('数十分の一、件数二件'), ['2']);
  assert.deepEqual(F.normalizedNumbers('数十分の一', [4, 5]), []);
  assert.deepEqual(F.normalizedNumbers('件数二分の一'), ['割合:1/2']);
  assert.deepEqual(F.normalizedNumbers('十分の一'), ['割合:1/10']);
});
test('P1', 'O1補足: 無関係な主張には修正元の根拠を候補へ足さない', async () => {
  const foreign = '別制度の控除は200万円です。';
  let checked = false;
  const result = await scenario({ body: WRONG + '\n別制度の控除は210万円です。', replacements: [RIGHT, foreign], source: SOURCE,
    subject: s => s.startsWith('別制度') ? '別制度' : '基礎控除', searchEvidence: c => [ref(c.subject === '別制度' ? foreign : SOURCE, c.subject === '別制度' ? 'foreign' : 'original')],
    onJudge: (request, rechecking) => {
      if (!rechecking) return;
      const c = H.readPayload(request).claims.find(c => c.sentence === foreign);
      if (!c) return;
      const pages = H.materials(request);
      const urls = c.evidence_ids.map(n => pages.find(p => p.number === n).url);
      assert.deepEqual(urls, ['https://example.jp/foreign']); checked = true;
    } });
  // 別の指摘の置き換え文へ、制度名も文も対応しない元の指摘の根拠を足さない。
  assert.equal(result.record.status, 'ok'); assert.ok(checked);
});

const ir = { staticSystem: '固定の指示', dynamicSystem: '可変の指示', user: '[1] ' + RIGHT };
const cmOptions = { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false, maxTokens: 8000, modelOptions: {} };
function transport(time, { short = false, failSync = false } = {}) {
  const calls = [];
  let item;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/batches')) { item = JSON.parse(init.body).requests[0]; return response({ id: 'batch-03p' }); }
    if (url.endsWith('/results')) return response(JSON.stringify({ custom_id: item.custom_id, result: { type: 'succeeded', message: { content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn' } } }));
    if (url.includes('/batches/')) return response({ processing_status: 'ended' });
    if (short) time.advance(20000);
    if (failSync) return response({ error: { message: KEY } }, 500);
    return response({ content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn' });
  };
  return calls;
}
test('P4', '判定の固定部分に項目の一覧と省略する条件がある', async () => {
  await F.judgeClaims([claim(RIGHT, { type: '金額' })], { c1: [ref()] }, RIGHT, async r => {
    assert.ok(r.staticSystem.includes('出力は [{id,status,evidence_id,basis,correct}] の形のJSON配列だけです（correct は食い違い・期限の書き漏れのときだけ、資料なしでは evidence_id・basis も書かない）'));
    return [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }];
  }, options);
});
test('P5', 'Batchの打ち切りに250秒を上乗せし、同期の制限は変えない', async () => {
  const savedSet = global.setTimeout, delays = [];
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return savedSet(fn, ms, ...args); };
  try {
    for (const batch of [true, false]) {
      delays.length = 0;
      const r = await F.checkFacts(RIGHT, { ...options, batch, batchMaxWaitMinutes: 2, timeoutMs: 1000, batchRuntime: clock(),
        searchEvidence: () => [ref()], callLLM: async r => r.task === 'extract' ? [{ s: 1, type: '金額', subject: '基礎控除', claim: RIGHT }] : [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }] });
      assert.equal(r.record.status, 'ok'); assert.equal(delays.length, 2);
      assert.ok(delays.every(ms => ms === (batch ? 371000 : 1000)));
    }
  } finally { global.setTimeout = savedSet; }
});
test('P6', '最初から同期の所要時間をBatchの待ちに記録しない', async () => {
  const time = clock(), calls = transport(time, { short: true });
  const r = await F.checkFacts(RIGHT, { ...options, batch: true, batchMaxWaitMinutes: 1, batchPollSeconds: 90,
    batchRuntime: time, searchEvidence: () => [ref()], callLLM: undefined,
    // 取得結果は空なので照合状態ではなく、呼び出しの計測を確認する。
  });
  assert.ok(calls.length > 0); assert.equal(r.record.calls[0].mode, 'sync'); assert.equal(r.record.calls[0].wait_seconds, 0);
  const result = await CM.generateContent(ir, { ...cmOptions, batch: CM.createBatchContext({ ...time, maxWaitMs: 59000 }) });
  assert.equal(result.mode, 'sync'); assert.equal(result.wait_seconds, 0);
});
test('P6', '最初から同期の失敗でも待ちを0と記録し、照合不能で止める', async () => {
  const time = clock(); transport(time, { short: true, failSync: true });
  const r = await F.checkFacts(RIGHT, { ...options, batch: true, batchMaxWaitMinutes: 1, batchPollSeconds: 90,
    batchRuntime: time, searchEvidence: () => [ref()] });
  assert.equal(r.record.status, 'not_run'); assert.equal(r.record.calls[0].mode, 'sync');
  assert.equal(r.record.calls[0].wait_seconds, 0); assert.ok(!JSON.stringify(r.record).includes(KEY));
});
test('P6', 'Batchのログはcache=false、同期のログは従来どおり', async logs => {
  process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'true';
  const time = clock(); transport(time);
  await CM.generateContent(ir, { ...cmOptions, batch: CM.createBatchContext(time) });
  const batchLog = logs.find(s => s.includes('mode=batch'));
  assert.ok(batchLog); assert.match(batchLog, /cache=false /);
  await CM.generateContent(ir, cmOptions);
  assert.ok(logs.at(-1).includes('cache=true '));
});

(async () => {
  const counts = {};
  for (const t of tests) {
    counts[t.group] ||= { pass: 0, fail: 0 };
    const env = { ...process.env }, savedFetch = global.fetch, log = console.log, warn = console.warn, logs = [];
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith('FACT_CHECK_') || k.startsWith('CONTENT_MODEL_')) delete process.env[k];
      process.env.ANTHROPIC_API_KEY = KEY;
      global.fetch = async () => { throw new Error('定義のない通信は禁止'); };
      console.log = console.warn = (...args) => logs.push(args.join(' '));
      await t.run(logs); assert.ok(!logs.join('\n').includes(KEY));
      counts[t.group].pass++; log(`PASS ${t.group} ${t.name}`);
    } catch (e) { counts[t.group].fail++; log(`FAIL ${t.group} ${t.name}: ${e.stack}`); }
    finally {
      console.log = log; console.warn = warn; global.fetch = savedFetch;
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
    }
  }
  console.log(JSON.stringify(counts));
  process.exitCode = Object.values(counts).some(c => c.fail) ? 1 : 0;
})();
