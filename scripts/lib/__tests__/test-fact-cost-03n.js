'use strict';

// 03n N1〜N3。通信・時計を偽物にし、実 AI と実時間の待ちを使わない。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CM = require('../content-model');
const F = require('../fact-check');
const B = require('../article-prompt-builder');
const KEY = ['試験用', '認証値', '0123456789'].join('-');
const WRONG = '基礎控除は120万円です。';
const RIGHT = '基礎控除は110万円です。';
const SECOND = '特別控除は2500万円です。';
const SOURCE = RIGHT + '\n' + SECOND;
const REF = { id: 'cost-test', kind: 'taxanswer', title: '控除の資料', url: 'https://www.nta.go.jp/example',
  text: SOURCE, law_version: '令和8年4月1日現在法令等' };
const OPTIONS = { enabled: true, now: new Date('2026-10-17T00:00:00Z'), searchEvidence: () => [REF], loadEvidenceText: () => SOURCE };
const groups = { N1: { pass: 0, fail: 0 }, N2: { pass: 0, fail: 0 }, N3: { pass: 0, fail: 0 } };

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data) };
}
function taskOf(params) {
  try { return JSON.parse(params.messages[0].content.at(-1).text).corrections ? 'repair' : 'judge'; }
  catch (_) { return 'extract'; }
}
function answer(params) {
  const user = params.messages[0].content.at(-1).text;
  let rows;
  if (taskOf(params) === 'extract') {
    rows = [...user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => /^(基礎控除|特別控除)/.test(m[2]))
      .map(m => ({ s: Number(m[1]), type: '金額', subject: m[2].startsWith('基礎') ? '基礎控除' : '特別控除', claim: m[2] }));
  } else if (taskOf(params) === 'repair') {
    rows = JSON.parse(user).corrections.map(c => ({ id: c.id, replacement: RIGHT }));
  } else {
    rows = JSON.parse(user).claims.map(c => ({ id: c.id, status: c.claim === WRONG ? '食い違い' : '裏付けあり',
      evidence_id: c.evidence_ids[0], basis: c.subject === '特別控除' ? '2' : '1', correct: c.claim === WRONG ? RIGHT : '' }));
  }
  return { content: [{ type: 'text', text: JSON.stringify(rows) }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } };
}
function clock() {
  let time = 0;
  const sleeps = [];
  return { now: () => time, sleep: async (ms, signal) => { assert.ok(!signal?.aborted); sleeps.push(ms); time += ms; },
    advance: ms => { time += ms; }, sleeps };
}
function transport(hook = () => undefined) {
  const calls = [], batches = new Map();
  global.fetch = async (url, init) => {
    assert.ok(url.startsWith('https://api.anthropic.com/v1/messages'));
    assert.equal(init.headers['x-api-key'], KEY);
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    let stage, params, batch;
    if (url.endsWith('/batches')) stage = 'create';
    else if (url.endsWith('/cancel')) stage = 'cancel';
    else if (url.endsWith('/results')) stage = 'results';
    else if (url.includes('/batches/')) stage = 'status';
    else stage = 'sync';
    if (stage === 'create') {
      assert.equal(init.method, 'POST');
      const sent = JSON.parse(init.body);
      assert.equal(sent.requests.length, 1);
      const item = sent.requests[0];
      assert.match(item.custom_id, /^[A-Za-z0-9_-]{1,64}$/);
      batch = { id: `msgbatch-${batches.size + 1}`, item, polls: 0, canceled: false };
      assert.ok(![...batches.values()].some(b => b.item.custom_id === item.custom_id));
      batches.set(batch.id, batch);
    } else if (stage !== 'sync') {
      batch = batches.get(url.split('/batches/')[1].split('/')[0]);
      assert.ok(batch);
      assert.equal(init.method, stage === 'cancel' ? 'POST' : 'GET');
      if (stage === 'cancel') { assert.ok(!init.signal.aborted); batch.canceled = true; }
      if (stage === 'status') batch.polls++;
    }
    params = stage === 'sync' ? JSON.parse(init.body) : batch.item.params;
    const call = { url, init, stage, params, batch, task: taskOf(params) };
    calls.push(call);
    const custom = await hook(call);
    if (custom !== undefined) return custom;
    if (stage === 'create') return response({ id: batch.id });
    if (stage === 'status') return response({ processing_status: batch.polls === 1 && !batch.canceled ? 'in_progress' : 'ended' });
    if (stage === 'cancel') return response({ processing_status: 'canceling' });
    if (stage === 'results') return response(JSON.stringify({ custom_id: batch.item.custom_id, result: { type: 'succeeded', message: answer(params) } }) + '\n');
    return response(answer(params));
  };
  return { calls, batches, count: stage => calls.filter(c => c.stage === stage).length };
}
async function test(group, name, fn) {
  const keys = [...new Set([...Object.keys(process.env).filter(k => k.startsWith('FACT_CHECK_')),
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTENT_MODEL_USE_PROMPT_CACHE', 'CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL'])];
  const env = { ...process.env }, oldFetch = global.fetch, log = console.log, warn = console.warn;
  const logs = [];
  try {
    for (const key of keys) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = KEY;
    process.env.OPENAI_API_KEY = KEY;
    global.fetch = async () => { throw new Error('試験の通信が未定義です'); };
    console.log = console.warn = (...args) => logs.push(args.join(' '));
    await fn(logs);
    assert.ok(!logs.join('\n').includes(KEY), 'ログに認証値を残さない');
    groups[group].pass++;
    log(`PASS ${group} ${name}`);
  } catch (error) {
    groups[group].fail++;
    log(`FAIL ${group} ${name}: ${error.stack}`);
  } finally {
    global.fetch = oldFetch; console.log = log; console.warn = warn;
    for (const key of Object.keys(process.env)) if (key.startsWith('FACT_CHECK_') || keys.includes(key)) delete process.env[key];
    for (const key of keys) if (env[key] !== undefined) process.env[key] = env[key];
  }
}
function legacyBody(ir, opts) {
  // 03n導入前と同じ順序・変換。JSON文字列（バイト列）を比較する。
  return JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens || 4096, ...B.anthropicModelOptions(opts.model),
    system: [CM.useCache() ? { type: 'text', text: ir.staticSystem, cache_control: { type: 'ephemeral' } } : { type: 'text', text: ir.staticSystem },
      { type: 'text', text: ir.dynamicSystem }].filter(b => typeof b.text === 'string' && b.text.trim()),
    messages: [{ role: 'user', content: B.buildAnthropicUserContent(ir.user, ir.figures) }] });
}
const raw = body => `---\nslug: fact-cost-03n\nrecommendation: publish\n---\n${body}`;

(async () => {
  for (const cache of ['true', 'false']) await test('N1', `1 Opusの抜き出し・判定・修正・再照合の本文が従来とバイト一致（cache=${cache}）`, async () => {
    process.env.CONTENT_MODEL_USE_PROMPT_CACHE = cache;
    const saved = CM.generateContent, sent = [];
    const wire = transport();
    CM.generateContent = async (ir, opts) => { sent.push(legacyBody(ir, opts)); assert.deepEqual(opts.modelOptions, {}); return saved(ir, opts); };
    try {
      const r = await F.checkFacts(WRONG, OPTIONS);
      assert.equal(r.record.status, 'ok');
      assert.deepEqual(r.record.calls.map(c => c.task), ['extract', 'judge', 'repair', 'recheck_extract', 'recheck_judge']);
      assert.deepEqual(wire.calls.map(c => c.init.body), sent);
      assert.equal(r.record.logic_version, 'plan1');
    } finally { CM.generateContent = saved; }
  });
  for (const effort of ['', 'medium']) await test('N1', `2 Sonnet照合の思考設定を分離、effort=${effort || '指定なし'}、書き手は維持`, async () => {
    process.env.FACT_CHECK_MODEL = 'claude-sonnet-5-5';
    process.env.FACT_CHECK_EFFORT = effort;
    const wire = transport();
    const r = await F.checkFacts(WRONG, OPTIONS);
    assert.equal(r.record.status, 'ok');
    for (const c of wire.calls) {
      assert.equal(c.params.thinking, undefined);
      assert.equal(c.params.output_config?.effort, effort || undefined);
      assert.ok(!c.init.body.includes('between_tools'));
    }
    await CM.generateContent({ staticSystem: '書き手の固定文', dynamicSystem: '可変文', user: '本文' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    assert.deepEqual(wire.calls.at(-1).params.thinking, { type: 'between_tools' });
    assert.deepEqual(wire.calls.at(-1).params.output_config, { effort: 'high' });
  });
  await test('N2', '3 抜き出しと再抜き出しだけ別モデル、記録にモデル・effort', async () => {
    process.env.FACT_CHECK_EXTRACT_MODEL = 'claude-sonnet-5-5';
    process.env.FACT_CHECK_EFFORT = 'high';
    const wire = transport();
    const r = await F.checkFacts(WRONG, OPTIONS);
    assert.equal(r.record.status, 'ok'); assert.equal(r.record.model, 'claude-opus-5-5');
    assert.equal(r.record.extract_model, 'claude-sonnet-5-5'); assert.equal(r.record.effort, 'high');
    assert.deepEqual(r.record.calls.map(c => c.model), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.deepEqual(wire.calls.map(c => c.params.model), r.record.calls.map(c => c.model));
  });
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) await test('N1', `4 有効なeffort ${effort}`, async () => {
    const wire = transport();
    const r = await F.checkFacts(RIGHT, { ...OPTIONS, effort });
    assert.equal(r.record.status, 'ok');
    assert.ok(wire.calls.every(c => c.params.output_config.effort === effort));
  });
  for (const [key, value, provider] of [['FACT_CHECK_EFFORT', 'fast', 'anthropic'], ['FACT_CHECK_EXTRACT_MODEL', 'gpt-wrong', 'anthropic'],
    ['FACT_CHECK_EXTRACT_MODEL', 'claude-wrong', 'openai'], ['FACT_CHECK_MODEL', 'gpt-wrong', 'anthropic']]) {
    await test(key === 'FACT_CHECK_EXTRACT_MODEL' ? 'N2' : 'N1', `4 ${key}不正なら呼び出さず停止（${provider}）`, async () => {
      process.env[key] = value;
      let calls = 0;
      const r = await F.checkFacts(RIGHT, { ...OPTIONS, provider, ...(provider === 'openai' ? { model: 'gpt-test' } : {}),
        callLLM: async () => { calls++; throw new Error('呼んではいけない'); } });
      assert.equal(calls, 0); assert.equal(r.record.status, 'not_run'); assert.equal(r.record.summary, '照合のモデル設定が不正です');
    });
  }
  await test('N2', '5 設定変更時は全体照合、旧記録の同じ設定は差分を使い回す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-cost-03n-'));
    transport();
    const before = raw(RIGHT), after = raw(RIGHT + '\n案内を追記します。');
    const opts = { ...OPTIONS, recordDir: dir };
    try {
      const initial = await F.checkArticle(before, opts);
      assert.equal(initial.record.status, 'ok');
      const file = F.recordPath('fact-cost-03n', dir), prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete prior.extract_model; delete prior.effort;
      fs.writeFileSync(file, JSON.stringify(prior));
      for (const settings of [{}, { extractModel: 'claude-sonnet-5-5' }, { effort: 'medium' }]) {
        const r = await F.checkArticle(after, { ...opts, ...settings, previousRaw: before, persist: false });
        assert.equal(r.record.status, 'ok');
        if (!Object.keys(settings).length) assert.equal(r.record.incremental.reused, 1);
        else { assert.equal(r.record.incremental, undefined); assert.ok(r.record.calls.some(c => c.task === 'judge')); }
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('N3', '6 Batch成功の本文・戻り値・使用量と記録、同期0回', async logs => {
    const fake = clock();
    let wire = transport();
    const batch = CM.createBatchContext(fake);
    const ir = { staticSystem: '固定文', dynamicSystem: '可変文', user: '[1] ' + RIGHT };
    const opts = { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false, modelOptions: {}, maxTokens: 8000 };
    const sync = await CM.generateContent(ir, opts);
    const ret = await CM.generateContent(ir, { ...opts, batch });
    const { mode, wait_seconds, ...same } = ret;
    assert.deepEqual(same, sync); assert.equal(mode, 'batch'); assert.equal(wait_seconds, 30);
    assert.equal(wire.calls.find(c => c.stage === 'create').batch.item.params.system[0].cache_control, undefined);
    const uncached = JSON.parse(wire.calls[0].init.body);
    for (const block of uncached.system) delete block.cache_control;
    assert.equal(JSON.stringify(wire.calls.find(c => c.stage === 'create').params), JSON.stringify(uncached));
    wire = transport();
    const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchRuntime: fake });
    assert.equal(r.record.status, 'ok'); assert.equal(r.record.batch, true); assert.equal(wire.count('sync'), 0);
    assert.ok(r.record.calls.every(c => c.mode === 'batch' && Number.isInteger(c.wait_seconds) && c.usage.output_tokens === 20));
    assert.ok(!JSON.stringify(r.record).includes('msgbatch-'));
    assert.ok(logs.some(s => /mode=batch wait_seconds=30 batch_id=/.test(s)));
    assert.deepEqual(wire.calls.slice(0, 4).map(c => c.stage), ['create', 'status', 'status', 'results']);
  });
  await test('N3', '7 待ち時間を合計し、取り消して1回同期、残りは同期', async () => {
    const fake = clock();
    const wire = transport(c => c.stage === 'status' ? response({ processing_status: 'in_progress' }) : undefined);
    const r = await F.checkFacts(WRONG, { ...OPTIONS, batch: true, batchMaxWaitMinutes: 1, batchPollSeconds: 17, batchRuntime: fake });
    assert.equal(r.record.status, 'ok'); assert.equal(wire.count('create'), 1); assert.equal(wire.count('cancel'), 1);
    assert.deepEqual(r.record.calls.map(c => c.mode), ['sync-fallback', 'sync', 'sync', 'sync', 'sync']);
    assert.equal(wire.count('sync'), 5); assert.equal(fake.now(), 120000);
    assert.ok(fake.sleeps.every(ms => ms <= 17000));
    assert.equal(r.record.calls[0].batch_error, 'BatchTimeoutError');
  });
  await test('N3', '7 複数回のBatchでも待ちの上限は記事全体で共有', async () => {
    const fake = clock();
    const wire = transport(c => c.stage === 'status' ? response({ processing_status:
      c.task === 'extract' && c.batch.polls > 1 ? 'ended' : 'in_progress' }) : undefined);
    const r = await F.checkFacts(WRONG, { ...OPTIONS, batch: true, batchMaxWaitMinutes: 1, batchPollSeconds: 40, batchRuntime: fake });
    assert.equal(r.record.status, 'ok'); assert.equal(wire.count('create'), 1); assert.equal(wire.count('cancel'), 0);
    assert.deepEqual(r.record.calls.map(c => c.mode), ['batch', 'sync', 'sync', 'sync', 'sync']);
    assert.equal(r.record.calls[0].wait_seconds, 40); assert.equal(r.record.calls[1].wait_seconds, 0);
    assert.equal(fake.now(), 40000);
  });
  await test('N3', '8 取り消し後に成功が届けば同期にやり直さない', async () => {
    const fake = clock();
    const wire = transport(c => c.stage === 'status' ? response({ processing_status: c.batch.canceled ? 'ended' : 'in_progress' }) : undefined);
    const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchMaxWaitMinutes: 1, batchRuntime: fake });
    assert.equal(r.record.status, 'ok'); assert.equal(wire.count('cancel'), 1); assert.equal(r.record.calls[0].mode, 'batch');
    // 待ちの予算を使い切ったので、その後の呼び出しは直接同期で頼む。
    assert.equal(r.record.calls[1].mode, 'sync'); assert.equal(wire.count('sync'), 1);
    assert.equal(r.record.calls[0].batch_error, undefined);
  });
  for (const scenario of ['create500', 'status500', 'results500', 'network', 'errored', 'expired', 'canceled', 'broken', 'missing', 'empty', 'bad-message', 'bad-id']) {
    await test('N3', `9 ${scenario}から1回だけ同期、診断に鍵を残さない`, async logs => {
      const fake = clock();
      const wire = transport(c => {
        if (c.stage === 'create' && scenario === 'create500' || c.stage === 'status' && scenario === 'status500' || c.stage === 'results' && scenario === 'results500') {
          return response({ error: { type: 'api_error', message: `失敗 ${KEY} x-api-key: ${KEY}` } }, 500);
        }
        if (c.stage === 'create' && scenario === 'network') throw new TypeError(`通信失敗 ${KEY}`);
        if (c.stage === 'create' && scenario === 'bad-id') return response({ id: '../不正なID' });
        if (c.stage !== 'results') return;
        if (scenario === 'broken') return response('{壊れたJSONL');
        if (scenario === 'empty') return response('');
        if (scenario === 'missing') return response(JSON.stringify({ result: { type: 'succeeded', message: answer(c.params) } }));
        if (scenario === 'bad-message') return response(JSON.stringify({ custom_id: c.batch.item.custom_id, result: { type: 'succeeded', message: {} } }));
        return response(JSON.stringify({ custom_id: c.batch.item.custom_id, result: { type: scenario, error: { message: KEY } } }));
      });
      const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchRuntime: fake });
      assert.equal(r.record.status, 'ok'); assert.deepEqual(r.record.calls.map(c => c.mode), ['sync-fallback', 'sync']);
      assert.equal(wire.count('sync'), 2); assert.ok(r.record.calls[0].batch_error);
      assert.ok(!JSON.stringify(r.record).includes(KEY)); assert.ok(!logs.join('\n').includes(KEY));
    });
  }
  await test('N3', '9 同期のやり直しも失敗すればnot_run、呼び出しに理由を残す', async () => {
    const wire = transport(c => ['create', 'sync'].includes(c.stage) ? response({ error: { message: KEY } }, 500) : undefined);
    const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchRuntime: clock() });
    assert.equal(r.record.status, 'not_run'); assert.equal(wire.count('sync'), 1);
    assert.equal(r.record.calls[0].mode, 'sync-fallback'); assert.ok(r.record.calls[0].batch_error);
    assert.ok(!JSON.stringify(r.record).includes(KEY));
  });
  await test('N3', '10 refusalはnot_run、同期にやり直さない', async () => {
    const wire = transport(c => c.stage === 'results' ? response(JSON.stringify({ custom_id: c.batch.item.custom_id,
      result: { type: 'succeeded', message: { content: [], stop_reason: 'refusal', stop_details: { category: KEY } } } })) : undefined);
    const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchRuntime: clock() });
    assert.equal(r.record.status, 'not_run'); assert.equal(wire.count('sync'), 0); assert.equal(wire.count('create'), 1);
  });
  await test('N3', '10 max_tokensは既存の判定分割に渡す', async () => {
    const wire = transport(c => c.stage === 'results' && c.task === 'judge' && JSON.parse(c.params.messages[0].content.at(-1).text).claims.length === 2 ?
      response(JSON.stringify({ custom_id: c.batch.item.custom_id, result: { type: 'succeeded', message: { content: [], stop_reason: 'max_tokens' } } })) : undefined);
    const r = await F.checkFacts(RIGHT + '\n' + SECOND, { ...OPTIONS, batch: true, batchRuntime: clock() });
    assert.equal(r.record.status, 'ok'); assert.equal(r.record.claims.length, 2); assert.equal(wire.count('sync'), 0);
    assert.deepEqual(r.record.calls.map(c => c.task), ['extract', 'judge', 'judge', 'judge']);
  });
  for (const value of [undefined, 'false', 'TRUE']) await test('N3', `11 Batch=${value}では同期`, async () => {
    if (value !== undefined) process.env.FACT_CHECK_BATCH = value;
    const wire = transport();
    const r = await F.checkFacts(RIGHT, OPTIONS);
    assert.equal(r.record.status, 'ok'); assert.equal(r.record.batch, false); assert.equal(wire.count('create'), 0);
    assert.ok(r.record.calls.every(c => c.mode === 'sync' && c.wait_seconds === undefined));
  });
  await test('N3', '11 OpenAIはBatch・modelOptionsを無視し従来の同期', async () => {
    process.env.FACT_CHECK_BATCH = 'true';
    const sdk = require.resolve('openai'), saved = require.cache[sdk], requests = [];
    class FakeOpenAI {
      constructor() { this.chat = { completions: { create: async req => {
        requests.push(req);
        const data = answer({ messages: [{ content: [{ text: req.messages[1].content }] }] });
        return { choices: [{ message: { content: data.content[0].text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3 } };
      } } }; }
    }
    require.cache[sdk] = { id: sdk, filename: sdk, loaded: true, exports: FakeOpenAI };
    try {
      const r = await F.checkFacts(RIGHT, { ...OPTIONS, provider: 'openai', model: 'gpt-test', effort: 'medium' });
      assert.equal(r.record.status, 'ok'); assert.equal(r.record.batch, false);
      assert.ok(r.record.calls.every(c => c.mode === 'sync')); assert.equal(requests.length, 2);
      assert.ok(requests.every(req => req.thinking === undefined && req.output_config === undefined));
    } finally { if (saved) require.cache[sdk] = saved; else delete require.cache[sdk]; }
  });
  await test('N3', '12 Batch待ちの打ち切りは残り予算＋通信と取消の余裕250秒＋timeoutMs', async () => {
    const fake = clock(), wire = transport(), delays = [], saved = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return saved(fn, ms, ...args); };
    try {
      const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchMaxWaitMinutes: 2, timeoutMs: 5, batchRuntime: fake });
      assert.equal(r.record.status, 'ok'); assert.equal(wire.count('sync'), 0);
      assert.deepEqual(delays, [370005, 60000, 120000, 90000, 60000, 340005, 60000, 90000, 60000, 60000]); assert.equal(fake.now(), 60000);
    } finally { global.setTimeout = saved; }
  });
  await test('N3', '12 合図が来たら確認をやめ、独立のsignalで1回取り消す', async () => {
    const controller = new AbortController(), fake = clock();
    const wire = transport();
    const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, signal: controller.signal,
      batchRuntime: { now: fake.now, sleep: async ms => { fake.advance(ms); controller.abort(); } } });
    // 取消の通信が完了するまでマイクロタスクを進める（実時間の待ちは使わない）。
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(r.record.status, 'not_run'); assert.equal(wire.count('cancel'), 1); assert.equal(wire.count('sync'), 0);
    assert.equal(wire.count('status'), 1);
  });
  for (const stalled of ['status', 'results']) await test('N3', `12 取消後の${stalled}通信が止まっても60秒で同期へ戻る`, async () => {
    const fake = clock(), timers = new Map(), savedSet = global.setTimeout, savedClear = global.clearTimeout;
    const advance = ms => {
      fake.advance(ms);
      for (const [id, timer] of [...timers]) if (timer.at <= fake.now()) { timers.delete(id); timer.fn(); }
    };
    global.setTimeout = (fn, ms) => { const id = {}; timers.set(id, { at: fake.now() + ms, fn }); return id; };
    global.clearTimeout = id => timers.delete(id);
    try {
      const wire = transport(c => {
        if (c.stage === 'status' && !c.batch.canceled) return response({ processing_status: 'in_progress' });
        if (c.stage === stalled && c.batch.canceled) {
          // fetchがsignalに応じなくても、待つ側のPromise.raceで上限を守る。
          void Promise.resolve().then(() => advance(60000));
          return new Promise(() => {});
        }
        if (c.stage === 'cancel') return response({}, 500); // 取消の失敗も元の照合を妨げない。
      });
      const r = await F.checkFacts(RIGHT, { ...OPTIONS, batch: true, batchMaxWaitMinutes: 1,
        batchRuntime: { now: fake.now, sleep: async ms => advance(ms) } });
      assert.equal(r.record.status, 'ok'); assert.equal(fake.now(), 120000);
      assert.equal(wire.count('cancel'), 1); assert.equal(wire.count('sync'), 2);
      assert.deepEqual(r.record.calls.map(c => c.mode), ['sync-fallback', 'sync']);
    } finally { global.setTimeout = savedSet; global.clearTimeout = savedClear; }
  });
  await test('N3', '12 確認間隔の既定30秒・最小5秒', () => {
    assert.equal(F.config().batchPollMs, 30000); assert.equal(F.config().batchMaxWaitMs, 3600000);
    for (const seconds of [0, -1, 1, 4]) assert.equal(F.config({ batchPollSeconds: seconds }).batchPollMs, 5000);
    assert.equal(CM.createBatchContext({ pollMs: 1 }).pollMs, 5000);
  });
  await test('N3', '13 日次だけ既定Batch、手動入力・共通設定はenv経由', () => {
    const workflow = name => fs.readFileSync(path.join(__dirname, '../../../.github/workflows', name + '.yml'), 'utf8');
    for (const name of ['daily-draft', 'regenerate-draft', 'refresh-article', 'fact-check']) {
      const text = workflow(name);
      assert.match(text, /FACT_CHECK_EXTRACT_MODEL: \$\{\{ (?:inputs\.extract_model \|\| )?vars\.FACT_CHECK_EXTRACT_MODEL \}\}/);
      assert.match(text, /FACT_CHECK_EFFORT: \$\{\{ (?:inputs\.effort \|\| )?vars\.FACT_CHECK_EFFORT \}\}/);
      if (name === 'daily-draft') {
        assert.ok(text.includes("FACT_CHECK_BATCH: ${{ vars.FACT_CHECK_BATCH || 'true' }}"));
        assert.ok(text.includes('FACT_CHECK_BATCH_MAX_WAIT_MINUTES: ${{ vars.FACT_CHECK_BATCH_MAX_WAIT_MINUTES }}'));
      } else if (name !== 'fact-check') assert.ok(!text.includes('FACT_CHECK_BATCH'));
      else {
        // 手動照合のrunだけを対象にし、envや次のstepを巻き込まない。
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const run = lines[i].match(/^(\s*)(?:- )?run:/);
          if (!run) continue;
          assert.ok(!lines[i].includes('${{ inputs.'));
          while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > run[1].length)) {
            assert.ok(!lines[++i].includes('${{ inputs.'));
          }
        }
        for (const input of ['model', 'extract_model', 'batch']) assert.match(text, new RegExp(`      ${input}:\\n`));
        assert.ok(text.includes('FACT_CHECK_MODEL: ${{ inputs.model || vars.FACT_CHECK_MODEL }}'));
        assert.ok(text.includes('FACT_CHECK_BATCH: ${{ inputs.batch }}'));
        assert.match(text, /      batch:\n(?:        .*\n)*        default: false/);
      }
    }
  });
  for (const [group, result] of Object.entries(groups)) console.log(`${group}: PASS ${result.pass} / FAIL ${result.fail}`);
  const passed = Object.values(groups).reduce((n, g) => n + g.pass, 0), failed = Object.values(groups).reduce((n, g) => n + g.fail, 0);
  console.log(`03n: PASS ${passed} / FAIL ${failed}`);
  process.exitCode = failed ? 1 : 0;
})();
