'use strict';

/**
 * content-model の provider/model 解決と fallback 安全性のテスト。
 *   node scripts/lib/__tests__/test-content-model-routing.js
 *
 * 重要検証:
 *   - CONTENT_MODEL_PROVIDER=anthropic → claude-sonnet-5-5（4.6 への切り戻しも維持）
 *   - 本文生成の OpenAI 経路を使わず、明示した事実照合経路だけを残す
 *   - ANTHROPIC_API_KEY 未設定でも Anthropic のまま失敗する
 */

const path = require('path');
const { isDeepStrictEqual } = require('util');
const ROOT = path.join(__dirname, '..', '..', '..');
const ENV_KEYS = ['CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL', 'OPENAI_MODEL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTENT_MODEL_USE_PROMPT_CACHE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}
function reload(p) { delete require.cache[require.resolve(p)]; return require(p); }
function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const CM = path.join(ROOT, 'scripts/lib/content-model');

// ── 1. anthropic + key → claude-sonnet-4-6 ──────────────────
console.log('\n=== Test 1: anthropic provider → Sonnet 4.6 ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(CM);
  assert(cm.resolveProvider() === 'anthropic', 'provider=anthropic');
  assert(cm.resolveModel('anthropic') === 'claude-sonnet-4-6', 'model=claude-sonnet-4-6');
}

// ── 2. OpenAI は照合の明示指定のみ──────
console.log('\n=== Test 2: OpenAI は照合の明示指定のみ ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';  // ← これが OpenAI に渡ってはいけない
  process.env.OPENAI_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(CM);
  let rejected = false;
  try { cm.resolveModel('openai'); } catch (_) { rejected = true; }
  assert(rejected, 'OpenAI の本文モデルを暗黙に解決しない');
  assert(cm.resolveModel('openai', 'explicit-fact-model') === 'explicit-fact-model', '照合の明示モデルは保持する');
}

// ── 3. 本文モデルの明示指定を維持 ──
console.log('\n=== Test 3: 本文モデルの明示指定を維持 ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(CM);
  assert(cm.resolveModel('anthropic') === 'claude-sonnet-4-6', '本文モデルは指定どおり');
}

// ── 4. ANTHROPIC_API_KEY 未設定でも Anthropic ────────
console.log('\n=== Test 4: ANTHROPIC_API_KEY 未設定でも Anthropic ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.OPENAI_MODEL = 'gpt-5.4';
  // ANTHROPIC_API_KEY なし
  const cm = reload(CM);
  assert(cm.resolveProvider() === 'anthropic', 'キー無しでも本文の提供元を変更しない');
}

// ── 5. 既定（CONTENT_MODEL_PROVIDER 未設定）は anthropic ───────
console.log('\n=== Test 5: 既定は anthropic===');
{
  clearEnv();
  process.env.OPENAI_MODEL = 'gpt-5.4';
  const cm = reload(CM);
  assert(cm.resolveProvider() === 'anthropic', '既定 anthropic');
  assert(cm.resolveModel('anthropic') === 'claude-sonnet-5-5', '既定は指定された書き手');
}

// ── 6. useCache の解釈 ───────────────────────────────────────
console.log('\n=== Test 6: prompt cache フラグ ===');
{
  clearEnv();
  const cm = reload(CM);
  assert(cm.useCache() === true, '未設定は既定 true');
  process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'false';
  const cm2 = reload(CM);
  assert(cm2.useCache() === false, 'false で無効');
  process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'true';
  const cm3 = reload(CM);
  assert(cm3.useCache() === true, 'true で有効');
}

// ── 7. toAnthropicRequest が cache_control を付ける（cache=true）─
console.log('\n=== Test 7: Anthropic リクエストに cache_control ===');
{
  const builder = reload(path.join(ROOT, 'scripts/lib/article-prompt-builder'));
  const ir = { staticSystem: 'STATIC', dynamicSystem: 'DYN', user: 'U' };
  const req = builder.toAnthropicRequest(ir, { model: 'claude-sonnet-4-6', useCache: true });
  assert(req.system[0].cache_control && req.system[0].cache_control.type === 'ephemeral', '固定ブロックに ephemeral cache');
  assert(req.model === 'claude-sonnet-4-6', 'model 指定');
}

async function testResponses() {
  console.log('\n=== Test 8: fetch / OpenAI を差し替えた本文生成と simple 生成 ===');
  const oldFetch = global.fetch;
  const sdkPath = require.resolve('openai');
  const oldSdk = require.cache[sdkPath];
  const oldLog = console.log;
  const oldWarn = console.warn;
  const requests = [], openaiCalls = [], logs = [], warnings = [];
  let response, completion;
  class MockOpenAI {
    constructor() {
      this.chat = { completions: { create: async request => {
        openaiCalls.push(request);
        return completion;
      } } };
    }
  }
  try {
    // 実 SDK をロード・呼び出しせず、両 provider の通信を必ず差し替える。
    require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: MockOpenAI };
    global.fetch = async (url, opts) => {
      assert(url === 'https://api.anthropic.com/v1/messages', 'fetch は Anthropic Messages 宛て');
      requests.push(JSON.parse(opts.body));
      return { ok: response.ok !== false, status: response.status || 200,
        json: async () => response, text: async () => 'mock HTTP failure' };
    };
    console.log = (...args) => { logs.push(args.join(' ')); oldLog(...args); };
    console.warn = (...args) => { warnings.push(args.join(' ')); oldWarn(...args); };
    clearEnv();
    process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'dummy';
    process.env.OPENAI_API_KEY = 'dummy';
    const cm = reload(CM);
    const ir = { staticSystem: 'STATIC', dynamicSystem: 'DYN', user: 'USER' };
    const generators = [
      ['generateContent', opts => cm.generateContent(ir, opts)],
      ['generateSimple', opts => cm.generateSimple({ system: 'STATIC', user: 'USER' }, opts)],
    ];
    function reset() {
      requests.length = openaiCalls.length = logs.length = warnings.length = 0;
      response = {
        content: [
          { type: 'thinking', thinking: '', text: 'PRIVATE_THINKING' },
          { type: 'text', text: 'BODY_1' },
          { type: 'redacted_thinking', data: 'PRIVATE_REDACTED', text: 'PRIVATE_REDACTED' },
          { type: 'text', text: 'BODY_2' },
        ],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
      };
      completion = { choices: [{ message: { content: 'FALLBACK_BODY' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 33, completion_tokens: 44 } };
    }

    for (const [name, generate] of generators) {
      for (const model of ['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-5-5']) {
        reset();
        const result = await generate({ model, maxTokens: 600 });
        const req = requests[0];
        const label = `${name} / ${model}`;
        assert(requests.length === 1 && openaiCalls.length === 0, `${label}: Anthropic だけ1回呼ぶ`);
        assert(req.model === model && req.max_tokens === 600, `${label}: model と短い出力上限を保つ`);
        if (model === 'claude-sonnet-5-5') {
          assert(isDeepStrictEqual(req.thinking, { type: 'between_tools' }), `${label}: thinking は between_tools だけ`);
          assert(isDeepStrictEqual(req.output_config, { effort: 'high' }), `${label}: effort は high`);
        } else {
          assert(!('thinking' in req) && !('output_config' in req), `${label}: 追加項目なし`);
        }
        const system = name === 'generateContent'
          ? [{ type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'DYN' }]
          : [{ type: 'text', text: 'STATIC' }];
        assert(isDeepStrictEqual(req.system, system), `${label}: system / cache_control は従来どおり`);
        assert(isDeepStrictEqual(req.messages, [{ role: 'user', content: [{ type: 'text', text: 'USER' }] }]),
          `${label}: messages は従来どおり`);
        assert(result.text === 'BODY_1BODY_2', `${label}: thinking を除外し text だけ連結`);
        assert(result.stopReason === 'max_tokens', `${label}: stopReason=max_tokens`);
        assert(result.provider === 'anthropic' && result.model === model && result.usage === response.usage,
          `${label}: provider / model / usage を保つ`);
        const usageLogs = logs.filter(line => line.startsWith('[content-model]'));
        assert(usageLogs.length === 1 && usageLogs[0].includes(`provider=anthropic model=${model}`)
          && usageLogs[0].includes('usage(in=11 out=22') && usageLogs[0].includes('stop=max_tokens'),
          `${label}: provider / model / in / out / stop を1行ログに記録`);
        assert(!usageLogs.join('').includes('BODY_') && !usageLogs.join('').includes('PRIVATE_'),
          `${label}: 本文や thinking はログに出さない`);
      }

      for (const category of [undefined, 'safety']) {
        reset();
        response = { stop_reason: 'refusal', content: [{ type: 'text', text: 'PRIVATE_REFUSAL_BODY' }],
          stop_details: category ? { category, explanation: 'PRIVATE_EXPLANATION' } : undefined };
        let error;
        try { await generate({ model: 'claude-sonnet-5-5', maxTokens: 600 }); } catch (e) { error = e; }
        assert(error instanceof Error, `${name}: refusal は失敗として返す`);
        assert(requests.length === 1 && openaiCalls.length === 0, `${name}: refusal でも OpenAI を呼ばない`);
        assert(!String(error).includes('PRIVATE_'), `${name}: refusal の本文・explanation を例外へ出さない`);
        assert(!warnings.concat(logs).join('').includes('PRIVATE_'), `${name}: refusal の本文・explanation をログへ出さない`);
      }

      reset();
      response = { ok: false, status: 500 };
      let failed = false;
      try { await generate({ model: 'claude-sonnet-5-5', maxTokens: 600 }); } catch (_) { failed = true; }
      assert(failed && openaiCalls.length === 0, `${name}: HTTP エラーでも OpenAI を呼ばない`);

      reset();
      delete response.stop_reason;
      const missingStop = await generate({ model: 'claude-sonnet-5-5' });
      assert(missingStop.stopReason === null, `${name}: Anthropic の終了理由なしは null`);

      process.env.CONTENT_MODEL_PROVIDER = 'openai';
      process.env.CONTENT_MODEL = 'claude-sonnet-5-5';
      reset();
      let rejected = false;
      try { await generate({ maxTokens: 600 }); } catch (_) { rejected = true; }
      assert(rejected && requests.length === 0 && openaiCalls.length === 0, `${name}: OpenAI の本文生成指定は拒否する`);
      // 03n の明示指定の経路は引き続き終了理由・空応答を安全に返す。
      const explicit = () => cm.generateContent(ir, { provider: 'openai', model: 'explicit-fact-model', fallback: false, maxTokens: 600 });
      const direct = await explicit();
      assert(direct.model === 'explicit-fact-model' && direct.stopReason === 'length', '照合だけは明示した OpenAI モデルを使う');
      reset();
      delete completion.choices[0].finish_reason;
      const missingFinish = await explicit();
      assert(missingFinish.stopReason === null, '照合の終了理由なしは null');
      reset();
      completion.choices = [];
      const missingChoice = await explicit();
      assert(missingChoice.stopReason === null && missingChoice.text === '', '照合の choice なしも安全に返す');
      process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
      delete process.env.CONTENT_MODEL;
    }
  } finally {
    global.fetch = oldFetch;
    if (oldSdk === undefined) delete require.cache[sdkPath];
    else require.cache[sdkPath] = oldSdk;
    console.log = oldLog;
    console.warn = oldWarn;
    restoreEnv();
  }
}

testResponses().then(() => {
  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}).catch(error => {
  restoreEnv();
  console.error(error);
  process.exitCode = 1;
});
