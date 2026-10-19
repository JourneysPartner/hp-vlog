'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLunaResolver, MODEL_LIST_TIMEOUT_MS } = require('../openai-models');
const results = {};
async function test(group, name, fn) {
  const r = results[group] ||= { pass: 0, fail: 0 };
  try { await fn(); r.pass++; console.log(`PASS ${group}: ${name}`); }
  catch (e) { r.fail++; console.error(`FAIL ${group}: ${name}\n${e.stack}`); }
}
function fixture(ids, extra = {}) {
  const logs = [], warnings = [];
  let calls = 0;
  const resolve = createLunaResolver({ env: { OPENAI_API_KEY: 'sk-fake-secret-123' },
    logger: { log: s => logs.push(s), warn: s => warnings.push(s) },
    fetchImpl: async (url, opts) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(opts.headers.Authorization, 'Bearer sk-fake-secret-123');
      return { ok: true, json: async () => ({ data: ids.map(id => ({ id })) }) };
    }, ...extra });
  return { resolve, logs, warnings, calls: () => calls };
}
async function main() {
  await test('R5', '完全一致のLunaだけを数値で比較する', async () => {
    const ids = ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-luna-batch', 'gpt-6-luna-2026-09-01', 'gpt-6-mini', 'gpt-6.1-luna-fast', 'gpt-999-luna\n'];
    assert.equal(await fixture(ids).resolve(), 'gpt-6-luna');
    assert.equal(await fixture([...ids, 'gpt-6.1-luna']).resolve(), 'gpt-6.1-luna');
    assert.equal(await fixture(['gpt-9.5-luna', 'gpt-10-luna']).resolve(), 'gpt-10-luna');
    assert.equal(await fixture(['gpt-6.9-luna', 'gpt-6.10-luna']).resolve(), 'gpt-6.10-luna');
  });
  await test('R5', '変数で固定した場合は問い合わせない', async () => {
    const f = fixture([], { env: { OPENAI_LUNA_MODEL: ' pinned-luna ' } });
    assert.equal(await f.resolve(), 'pinned-luna'); assert.equal(f.calls(), 0);
    assert(f.logs[0].includes('変数で固定'));
  });
  for (const [label, extra] of [
    ['HTTP500', { fetchImpl: async () => ({ ok: false, status: 500 }) }],
    ['時間切れ', { fetchImpl: async () => new Promise(() => {}), timeoutMs: 5 }],
    ['候補なし', {}],
    ['鍵なし', { env: {} }],
    ['例外に鍵', { fetchImpl: async () => { throw new Error('Bearer sk-fake-secret-123'); } }],
    ['JSON不正', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('sk-fake-secret-123'); } }) }],
  ]) await test('R5', `${label}は既定値・警告1行・鍵を出さない`, async () => {
    const f = fixture([], extra);
    assert.equal(await f.resolve(), 'gpt-6-luna'); assert.equal(await f.resolve(), 'gpt-6-luna');
    assert.equal(f.warnings.length, 1); assert.equal(f.logs.length, 1);
    assert(!f.logs.concat(f.warnings).join('').includes('sk-fake-secret-123'));
    if (label === '鍵なし') assert.equal(f.calls(), 0);
    assert.equal(MODEL_LIST_TIMEOUT_MS, 15000);
  });
  await test('R5', '同時呼び出しと継続呼び出しで問い合わせ1回', async () => {
    const f = fixture(['gpt-6.1-luna']);
    assert.deepEqual(await Promise.all([f.resolve(), f.resolve(), f.resolve()]), ['gpt-6.1-luna', 'gpt-6.1-luna', 'gpt-6.1-luna']);
    assert.equal(await f.resolve(), 'gpt-6.1-luna'); assert.equal(f.calls(), 1); assert.equal(f.logs.length, 1);
  });
  await test('R5', '応答本文の時間切れも中断し、使用量の異常値に鍵を出さない', async () => {
    let signal;
    const f = fixture([], { timeoutMs: 5, fetchImpl: async (_, opts) => {
      signal = opts.signal;
      return { ok: true, json: async () => new Promise(() => {}) };
    } });
    assert.equal(await f.resolve(), 'gpt-6-luna'); assert(signal.aborted);
    const oldLog = console.log, savedKey = process.env.OPENAI_API_KEY;
    const logs = [];
    try {
      process.env.OPENAI_API_KEY = 'sk-fake-secret-123'; console.log = s => logs.push(s);
      require('../openai-models').logOpenAIUsage('gpt-6-luna', 'source_select', { prompt_tokens: 'sk-fake-secret-123', completion_tokens: 12 });
      assert.equal(logs[0], '[openai] model=gpt-6-luna task=source_select usage(in=? out=12 cached=0)');
    } finally { console.log = oldLog; if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey; }
  });
  await test('R5', '出典・検索候補・GSC・質疑応答が同じモデルと使用量ログを使う', async () => {
    const modulePath = require.resolve('../openai-models');
    const sdkPath = require.resolve('openai');
    const oldModule = require.cache[modulePath], oldSdk = require.cache[sdkPath];
    const oldFetch = global.fetch, oldLog = console.log;
    const saved = { ...process.env };
    const logs = [], requests = [];
    let listCalls = 0, failCompletion = false;
    class FakeOpenAI {
      constructor() { this.chat = { completions: { create: async req => {
        if (failCompletion) throw new Error('sk-fake-secret-123');
        requests.push(req); return { choices: [{ message: { content: '{"selected":null}' } }],
          usage: { prompt_tokens: 101, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 33 } } };
      } } }; }
    }
    try {
      process.env.OPENAI_API_KEY = 'sk-fake-secret-123'; delete process.env.OPENAI_LUNA_MODEL;
      delete require.cache[modulePath];
      require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeOpenAI };
      global.fetch = async url => { listCalls++; assert.equal(url, 'https://api.openai.com/v1/models'); return { ok: true, json: async () => ({ data: [{ id: 'gpt-6.1-luna' }] }) }; };
      console.log = s => logs.push(s);
      const { makeOpenAILuna, pickFromCandidates } = require('../llm-source-selector');
      const defaultCall = makeOpenAILuna(); // 同期で関数を返し、ここでは一覧を読まない。
      assert.equal(listCalls, 0);
      await defaultCall('system', 'user');
      for (const task of ['suggest', 'gsc', 'triage']) await makeOpenAILuna(task)('system', 'user');
      assert.equal(listCalls, 1); assert.equal(requests.length, 4);
      assert(requests.every(r => r.model === 'gpt-6.1-luna'));
      for (const task of ['source_select', 'suggest', 'gsc', 'triage']) assert(logs.some(s => s === `[openai] model=gpt-6.1-luna task=${task} usage(in=101 out=12 cached=33)`));
      assert(!logs.join('').includes('sk-fake-secret-123'));
      // 応答が読めないモデルでも、出典を勝手に確定しない。
      assert.equal(await pickFromCandidates({ title: '試験' }, [{ no: '9999', title: '試験', url: 'https://example.invalid' }], async () => '壊れたJSON'), null);
      failCompletion = true;
      await assert.rejects(defaultCall('system', 'user'), e => e.message === 'OpenAI Luna の呼び出しに失敗しました');
      const routes = [ ['update-suggest-topics.js', 'suggest'], ['update-gsc-topics.js', 'gsc'], ['triage-shitsugi-topics.js', 'triage'] ];
      for (const [file, task] of routes) assert(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').includes(`makeOpenAILuna('${task}')`));
    } finally {
      global.fetch = oldFetch; console.log = oldLog;
      require.cache[modulePath] = oldModule;
      if (oldSdk) require.cache[sdkPath] = oldSdk; else delete require.cache[sdkPath];
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
  await test('R6', '本文・短い呼び出しのAnthropic失敗にOpenAIを使わない', async () => {
    const CM = require('../content-model');
    const sdkPath = require.resolve('openai'), oldSdk = require.cache[sdkPath];
    const oldFetch = global.fetch, saved = { ...process.env };
    let openaiCalls = 0, fetchCalls = 0;
    try {
      delete process.env.CONTENT_MODEL_PROVIDER; process.env.ANTHROPIC_API_KEY = 'sk-anthropic-secret-123';
      process.env.OPENAI_API_KEY = 'sk-openai-secret-123';
      require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: class { constructor() { openaiCalls++; throw new Error('OpenAI禁止'); } } };
      global.fetch = async () => { fetchCalls++; return { ok: false, status: 500, text: async () => 'sk-anthropic-secret-123 sk-openai-secret-123' }; };
      assert.equal(CM.resolveProvider(), 'anthropic');
      await assert.rejects(CM.generateContent({ staticSystem: 's', dynamicSystem: '', user: 'u' }), e => !e.message.includes('secret'));
      await assert.rejects(CM.generateSimple({ system: 's', user: 'u' }), e => !e.message.includes('secret'));
      assert.equal(openaiCalls, 0); assert.equal(fetchCalls, 2);
      process.env.CONTENT_MODEL_PROVIDER = 'openai';
      await assert.rejects(CM.generateContent({ user: 'u' }));
      await assert.rejects(CM.generateSimple({ user: 'u' }));
      assert.equal(openaiCalls, 0);
      process.env.AUX_MODEL_ENABLED = 'true'; process.env.AUX_MODEL_PROVIDER = 'openai';
      const aux = require('../aux-model'); assert.equal(aux.canUseAux(), false);
      assert.equal(await aux.generateAux({ system: 's', user: 'u', task: 'test' }), null);
    } finally {
      global.fetch = oldFetch;
      if (oldSdk) require.cache[sdkPath] = oldSdk; else delete require.cache[sdkPath];
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
  await test('R6', '日次は生成失敗を取り下げに記録せず0本、照合も記事保存も行わない', async () => {
    const G = require('../../generate-draft');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-models-failure-'));
    const entries = [];
    try {
      const results = await G.generateTopics([{ slug: 'failure' }], { toString: () => '2026-10-19' }, {
        postsDir: dir, recorder: { record: (t, stage) => entries.push(stage) },
        generateArticle: async () => { throw new Error('秘密を含みうる例外'); },
        factCheck: async () => { throw new Error('呼ばれない'); },
      });
      assert.equal(results.length, 0); assert.deepEqual(entries, []); assert.deepEqual(fs.readdirSync(dir), []);
      const workflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/regenerate-draft.yml'), 'utf8');
      assert(workflow.includes('regenerate_failed'));
      assert(workflow.includes('if: failure()\n'));
      const source = fs.readFileSync(path.join(__dirname, '../../generate-draft.js'), 'utf8');
      assert(source.includes('regenerateWithContentModel(existing, comment)'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R6', '差し戻しの全文生成失敗は呼び出し元へ返り、元の記事を保持する', async () => {
    const G = require('../../generate-draft'), CM = require('../content-model');
    const oldSimple = CM.generateSimple, oldFetch = global.fetch;
    const existing = '---\ntitle: "書類の確認"\nslug: test\narticle_type: basic_explainer\n---\n\n## 書類\n\n元の記事です。';
    let calls = 0;
    try {
      global.fetch = async () => { throw new Error('通信は禁止'); };
      CM.generateSimple = async () => { calls++; throw new Error('本文生成モデルの呼び出しに失敗しました'); };
      await assert.rejects(G.regenerateWithContentModel(existing, '書類の説明を修正'), /本文生成モデルの呼び出しに失敗/);
      assert.equal(calls, 1); assert(existing.endsWith('元の記事です。'));
    } finally { CM.generateSimple = oldSimple; global.fetch = oldFetch; }
  });
  await test('R5', 'ワークフローに共通変数、旧モデル変数なし', () => {
    const root = path.join(__dirname, '../../../.github/workflows');
    for (const file of fs.readdirSync(root).filter(f => /\.ya?ml$/.test(f))) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert(!/\b(?:OPENAI_MODEL(?:_HIGH)?|LLM_(?:SOURCE_SELECT|SUGGEST|GSC|TRIAGE)_MODEL)\b/.test(text), file);
      if (text.includes('OPENAI_API_KEY:')) {
        assert(text.includes('OPENAI_LUNA_MODEL: ${{ vars.OPENAI_LUNA_MODEL }}'), file);
        let runIndent = -1;
        for (const line of text.split('\n')) {
          const indent = line.search(/\S/);
          if (/^\s*run:/.test(line)) runIndent = indent;
          else if (indent >= 0 && indent <= runIndent) runIndent = -1;
          if (runIndent >= 0) assert(!/\$\{\{[^}]*inputs\./.test(line), `${file}: run に入力を直接展開しない`);
        }
      }
    }
  });
  await test('R6', 'high_quality入力とCLI切替を撤去し入力はenv経由', () => {
    const root = path.join(__dirname, '../../..');
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/daily-draft.yml'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'scripts/generate-draft.js'), 'utf8');
    assert(!/high_quality|--high-quality/.test(workflow + source));
    assert(workflow.includes('FORCE_SLUG: ${{ inputs.force_slug }}'));
    assert(workflow.includes('ARGS+=(--force-slug "$FORCE_SLUG")'));
  });
  for (const [group, r] of Object.entries(results)) console.log(`${group} PASS: ${r.pass} / FAIL: ${r.fail}`);
  process.exitCode = Object.values(results).some(r => r.fail) ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
