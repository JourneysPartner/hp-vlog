'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { callGateway } = require('../gateway-model');
const CM = require('../content-model');
const aux = require('../aux-model');
const dedup = require('../ai-dedup');
const W = require('../withdrawn-topics');
const G = require('../../generate-draft');
const results = {};
const savedEnv = { ...process.env };
const oldFetch = global.fetch, oldLog = console.log, oldWarn = console.warn, oldTimer = global.setTimeout;
const requests = [], logs = [], timers = [];
const secret = 'gateway-test-secret';
let reply;
const success = (text = '本文', finish = 'stop') => ({ ok: true, json: async () => ({
  choices: [{ message: { content: text }, finish_reason: finish }],
  usage: { prompt_tokens: 11, completion_tokens: 22, completion_tokens_details: { reasoning_tokens: 7 }, prompt_tokens_details: { cached_tokens: 5 } },
}) });
const http = status => ({ ok: false, status, body: { cancel: async () => {} }, text: async () => secret });
const input = { model: 'test/model', system: '固定指示', user: '入力', maxTokens: 123, task: '試験' };
const figures = [{ media_type: 'image/png', data: 'YWJj', alt: '図の説明', sourceTitle: '主出典', url: 'https://example.test/source' },
  { media_type: 'image/jpeg', data: 'ZGVm' }];
const label = f => `次の画像は、根拠として渡している主出典「${f.sourceTitle || '出典'}」（${f.url || ''}）に掲載されている図です${f.alt ? `（図の説明: ${f.alt}）` : ''}。この図に書かれている数値・続柄・関係だけを設例に使ってください。`;

function reset() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const key of ['CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL', 'AUX_MODEL_PROVIDER', 'AUX_MODEL', 'AUX_MODEL_ENABLED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'CONTENT_MODEL_USE_PROMPT_CACHE']) delete process.env[key];
  process.env.AI_GATEWAY_API_KEY = secret;
  requests.length = logs.length = timers.length = 0;
  reply = () => success();
  global.fetch = async (url, opts) => { requests.push({ url, opts, body: JSON.parse(opts.body) }); return reply(url, opts); };
  console.log = console.warn = (...args) => logs.push(args.join(' '));
  global.setTimeout = (fn, ms, ...args) => {
    timers.push(ms);
    // 再試行の待ちは実時間を消費せず、指定された間隔を検証する。
    return oldTimer(fn, ms === 15000 || ms === 30000 ? 0 : ms, ...args);
  };
}
async function test(group, name, fn) {
  const r = results[group] ||= { pass: 0, fail: 0 };
  reset();
  try { await fn(); r.pass++; oldLog(`PASS ${group}: ${name}`); }
  catch (e) { r.fail++; oldLog(`FAIL ${group}: ${name}\n${e.stack}`); }
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  await test('R7', '宛先・ヘッダー・図なし本文・戻り値・使用量ログ', async () => {
    const value = await callGateway(input);
    const { url, opts } = requests[0];
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
    assert.equal(opts.method, 'POST');
    assert.deepEqual(opts.headers, { 'content-type': 'application/json', authorization: `Bearer ${secret}` });
    assert.equal(opts.body, JSON.stringify({ model: input.model, max_tokens: 123, messages: [
      { role: 'system', content: input.system }, { role: 'user', content: input.user },
    ] }));
    assert.deepEqual(value, { text: '本文', usage: { input_tokens: 11, output_tokens: 22 }, provider: 'gateway', model: input.model, stopReason: 'end_turn' });
    assert.deepEqual(logs, ['[gateway] model=test/model task=試験 usage(in=11 out=22 reasoning=7 cached=5) finish=stop']);
    assert(!logs.join('').includes(secret));
    assert.deepEqual(timers, [300000]);
  });
  await test('R7', '複数の図は説明・画像・最後に本文の順', async () => {
    await callGateway({ ...input, figures });
    assert.deepEqual(requests[0].body.messages[1].content, [
      ...figures.flatMap(f => [{ type: 'text', text: label(f) }, { type: 'image_url', image_url: { url: `data:${f.media_type};base64,${f.data}` } }]),
      { type: 'text', text: input.user },
    ]);
  });
  await test('R7', 'lengthだけmax_tokens、使用量の詳細が無くても返る', async () => {
    reply = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '途中' }, finish_reason: 'length' }] }) });
    assert.equal((await callGateway(input)).stopReason, 'max_tokens');
    assert(logs[0].includes('reasoning=? cached=?'));
  });
  for (const kind of [429, 500, '通信']) {
    for (const recover of [true, false]) {
      await test('R7', `${kind}を15秒・30秒後に再試行、3回目で${recover ? '成功' : '例外'}`, async () => {
        reply = () => {
          if (recover && requests.length === 3) return success();
          if (kind === '通信') throw new TypeError(secret);
          return http(kind);
        };
        if (recover) assert.equal((await callGateway(input)).text, '本文');
        else await assert.rejects(callGateway(input), e => !e.message.includes(secret));
        assert.equal(requests.length, 3);
        assert.deepEqual(timers, [300000, 15000, 30000]);
        assert(!logs.join('').includes(secret));
      });
    }
  }
  for (const status of [400, 401, 403]) {
    await test('R7', `${status}は再試行せず、応答本文の鍵を例外に含めない`, async () => {
      reply = () => http(status);
      await assert.rejects(callGateway(input), e => e.status === status && !e.message.includes(secret));
      assert.equal(requests.length, 1);
    });
  }
  await test('R7', '鍵なしは通信しない', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    await assert.rejects(callGateway(input), /認証情報/);
    assert.equal(requests.length, 0);
  });
  await test('R7', '停止した通信も指定時間で終了しsignalを中止', async () => {
    reply = () => new Promise(() => {});
    await assert.rejects(callGateway({ ...input, timeoutMs: 10 }), /時間切れ/);
    assert(requests[0].opts.signal.aborted);
    assert.equal(requests.length, 1);
  });
  await test('R7', '応答本文の読み取り中も指定時間で終了', async () => {
    reply = () => ({ ok: true, json: () => new Promise(() => {}) });
    await assert.rejects(callGateway({ ...input, timeoutMs: 10 }), /時間切れ/);
  });
  await test('R7', '既に中止されたsignalでは通信しない', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(callGateway({ ...input, signal: controller.signal }), /中止/);
    assert.equal(requests.length, 0);
  });
  await test('R7', '待機中の外部中止は再試行しない', async () => {
    const controller = new AbortController();
    reply = () => { controller.abort(); throw new Error(secret); };
    await assert.rejects(callGateway({ ...input, signal: controller.signal }), /中止/);
    assert.equal(requests.length, 1);
  });
  await test('R7', '読めない応答は鍵を伏せて例外、再試行しない', async () => {
    reply = () => ({ ok: true, json: async () => { throw new Error(secret); } });
    await assert.rejects(callGateway(input), /応答を読み取れません/);
    assert.equal(requests.length, 1);
  });
  await test('R7', '応答読み取り中の通信切断も2回まで再試行', async () => {
    reply = () => ({ ok: true, json: async () => { throw new TypeError(secret); } });
    await assert.rejects(callGateway(input), /通信に失敗/);
    assert.equal(requests.length, 3);
    assert.deepEqual(timers, [300000, 15000, 30000]);
  });
  await test('R7', 'モデル名・用途・finishに鍵が反射してもログに出さない', async () => {
    reply = () => success('本文', secret);
    await callGateway({ ...input, model: secret, task: secret });
    assert(!logs.join('').includes(secret));
  });

  const picks = [{ slug: 'candidate', title: '確認する書類', persona: '個人', category: 'その他' }];
  const corpus = [{ slug: 'existing', title: '別の手続き', persona: '法人', category: 'その他' }];
  const answer = JSON.stringify([{ slug: 'candidate', duplicate: false, similar_to: null, reason: '対象が異なる' }]);
  function auxEnv(provider) {
    process.env.AUX_MODEL_ENABLED = 'true'; process.env.AUX_MODEL_PROVIDER = provider;
    process.env.AUX_MODEL = provider === 'gateway' ? 'zai/glm-5.3-flash' : 'claude-haiku-4-5-20251001';
  }
  await test('R8', '重複確認はAUX_MODELと8000、上限到達は読めない扱い', async () => {
    auxEnv('gateway');
    reply = () => success(answer);
    assert.equal((await dedup.checkDuplicatesWithAI(picks, corpus)).skipped, false);
    assert.equal(requests[0].body.model, 'zai/glm-5.3-flash');
    assert.equal(requests[0].body.max_tokens, 8000);
    reply = () => success(answer, 'length');
    assert.equal((await dedup.checkDuplicatesWithAI(picks, corpus)).skipped, true);
    assert.equal(await aux.generateAux({ system: 's', user: 'u', task: 'ai_dedup', maxTokens: 300 }), null);
    assert(requests.every(r => r.body.max_tokens === 8000));
  });
  await test('R8', 'Gatewayの鍵だけで有効化し、無効・鍵なしは通信しない', async () => {
    auxEnv('gateway'); assert.equal(aux.canUseAux(), true);
    delete process.env.AI_GATEWAY_API_KEY;
    assert.equal(aux.canUseAux(), false);
    await aux.generateAux(input); assert.equal(requests.length, 0);
    process.env.AI_GATEWAY_API_KEY = secret; process.env.AUX_MODEL_ENABLED = 'false';
    assert.equal(aux.canUseAux(), false);
  });
  await test('R8', 'Anthropicの重複確認リクエスト本文は変更前とバイト一致', async () => {
    auxEnv('anthropic'); process.env.ANTHROPIC_API_KEY = 'anthropic-test-secret';
    reply = () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: answer }] }) });
    await dedup.checkDuplicatesWithAI(picks, corpus);
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(requests[0].body.max_tokens, 400);
    // 変更前（78091dd2）の同じ入力によるリクエスト本文のSHA-256。
    assert.equal(hash(requests[0].opts.body), '8ac8e30c3203c129927c206d38ada3e8236f80b4b83c2352d016cf143e3ac8c8');
  });

  await test('R9', '本文生成は64000・15分・system結合・図、Anthropic固有設定を送らない', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; process.env.CONTENT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
    const value = await CM.generateContent({ staticSystem: '静的', dynamicSystem: '動的', user: '本文指示', figures }, { maxTokens: 5, modelOptions: { thinking: { type: 'between_tools' } } });
    assert.equal(value.provider, 'gateway');
    assert.equal(requests[0].body.model, process.env.CONTENT_MODEL);
    assert.equal(requests[0].body.max_tokens, 64000);
    assert.equal(requests[0].body.messages[0].content, '静的\n\n動的');
    assert.equal(requests[0].body.messages[1].content.length, 5);
    assert(!requests[0].opts.body.includes('cache_control'));
    assert(!requests[0].opts.body.includes('thinking'));
    assert.deepEqual(timers, [900000]);
  });
  await test('R9', '空のsystemは結合から除く', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway';
    for (const [staticSystem, dynamicSystem, expected] of [['', '動的', '動的'], ['静的', '  ', '静的'], [undefined, '', '']]) {
      await CM.generateContent({ staticSystem, dynamicSystem, user: '本文' });
      assert.equal(requests.at(-1).body.messages[0].content, expected);
    }
  });
  await test('R9', '部分生成はmax(指定,16000)・5分・同じモデルと図', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; process.env.CONTENT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
    for (const maxTokens of [undefined, 300, 20000]) {
      await CM.generateSimple({ system: '指示', user: '本文', figures }, { maxTokens });
      const body = requests.at(-1).body;
      assert.equal(body.model, process.env.CONTENT_MODEL);
      assert.equal(body.max_tokens, maxTokens === 20000 ? 20000 : 16000);
      assert.equal(body.messages[1].content.length, 5);
      assert(!JSON.stringify(body).includes('cache_control'));
      assert(!JSON.stringify(body).includes('thinking'));
    }
    assert.deepEqual(timers, [300000, 300000, 300000]);
  });
  await test('R9', 'Anthropicの本文・部分生成は変更前とバイト一致（図とキャッシュ）', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'anthropic-test-secret';
    process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'true';
    reply = () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '本文' }], stop_reason: 'end_turn' }) });
    for (const withFigures of [false, true]) {
      const ir = { staticSystem: '静的', dynamicSystem: '動的', user: '本文指示', ...(withFigures ? { figures } : {}) };
      await CM.generateContent(ir, { maxTokens: 567 });
      await CM.generateSimple({ system: '静的', user: '本文指示', ...(withFigures ? { figures } : {}) }, { maxTokens: 567 });
    }
    assert.deepEqual(requests.map(r => hash(r.opts.body)), [
      '0a15b22eec227ad81c0b4c0213d7813c75fe4c22dc304cdc8aeb0c3abac45aad',
      '23ed8528475d56a8b805b10bf497554902a2e6482727fa24cac90e365629b172',
      '59383b83a2f215d6233efd2d6b41f2b8a8db11c10ebfba8373dd7f2fc3a7d293',
      'dfd39e3c10d4e9eb26ef93c8636c9fb3939b06f8ab8388656676c123e5087757',
    ]);
  });
  await test('R9', 'DeepSeekの字数補正は1.11、既定の提供元とモデルは不変', () => {
    const S = require('../article-prompt-static');
    assert.equal(S.LENGTH_OVERSHOOT_BY_MODEL['deepseek/deepseek-v4.1-flash-1017'], 1.11);
    assert.equal(CM.resolveProvider(), 'anthropic');
    assert.equal(CM.resolveModel('anthropic'), 'claude-sonnet-5-5');
    assert.equal(aux.auxProvider(), 'anthropic');
    assert.equal(aux.auxModel(), 'claude-haiku-4-5-20251001');
  });
  await test('R9', '本文がGatewayでも照合の明示したAnthropicと出力上限を維持', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; process.env.CONTENT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-secret';
    reply = () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '照合結果' }], stop_reason: 'end_turn' }) });
    const value = await CM.generateContent({ staticSystem: '照合指示', user: '照合対象' }, {
      provider: 'anthropic', model: 'claude-opus-5-5', maxTokens: 1234, fallback: false,
    });
    assert.equal(value.provider, 'anthropic');
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(requests[0].body.model, 'claude-opus-5-5');
    assert.equal(requests[0].body.max_tokens, 1234);
  });
  await test('R9', '日次の本文生成はGatewayの鍵だけで実行でき、提供元をログに出す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-key-only-'));
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; process.env.CONTENT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
    reply = () => success('---\ntitle: "確認する書類と手続き"\nsummary: "必要な書類を確認します。"\n---\n\n## 書類\n\n' + '確認する書類です。'.repeat(550));
    try {
      const value = await G.generateTopics([{ slug: 'gateway-key-only', persona: 'test', category: 'その他', article_type: 'basic_explainer' }], '2026-10-19', {
        postsDir: dir, selfCheck: () => {},
        factCheck: async content => ({ content, record: { status: 'ok', summary: '偽の照合' } }),
      });
      assert.equal(value.length, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.max_tokens, 64000);
      assert(logs.some(line => line.includes('本文生成: content-model 経由 provider=gateway model=deepseek/deepseek-v4.1-flash-1017 cache=false')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  async function runFailure(generateArticle, extra = {}, expectedWithdrawals = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-failure-'));
    const recorder = W.createWithdrawalRecorder({ file: path.join(dir, 'withdrawn.json'), env: {} });
    const events = [];
    try {
      const run = await G.runSingleDraft('2026-10-19', {
        topics: ['a', 'b'].map(slug => ({ slug, persona: '個人', category: 'その他' })), recorder,
        pendingDrafts: [], corpus: [], postsDir: dir, env: {},
        context: { queryInputs: {}, targetQueryCorpus: [], takenUrlSlugs: new Set() },
        select: pool => { events.push('選定'); return { picks: pool.slice(0, 1), explanation: { steps: [], warnings: [] } }; },
        ensureSource: t => { t.source_provenance = 'curated'; }, enrichSource: async () => {},
        resolveQuery: async t => ({ target_query: `検索語${t.slug}`, secondary_queries: [], slug_words: `url-${t.slug}` }),
        checkAI: async () => ({ results: [], skipped: true }), generateArticle,
        factCheck: async () => { throw new Error('照合は呼ばれない'); }, ...extra,
      });
      assert.equal(recorder.additions.length, expectedWithdrawals);
      assert(!recorder.additions.some(entry => entry.stage === 'generation-failed'));
      assert.deepEqual(fs.readdirSync(dir), expectedWithdrawals ? ['withdrawn.json'] : []);
      return { run, events };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  for (const provider of ['anthropic', 'gateway']) {
    await test('R0', `${provider}のAPI失敗は再選定せず0本、通知理由だけに残す`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      process.env.ANTHROPIC_API_KEY = 'anthropic-test-secret';
      reply = () => http(429);
      const { run, events } = await runFailure(async () => CM.generateContent({ staticSystem: '指示', user: '本文' }));
      assert.equal(run.results.length, 0); assert.equal(run.generations, 1); assert.equal(run.candidates, 1);
      assert.equal(events.length, 1); assert.equal(run.attempts.length, 1);
      assert(run.reason.includes('本文生成モデルの呼び出しに失敗（'));
      assert(run.reason.includes('HTTP 429'));
      assert(!run.reason.includes(secret));
      assert(!logs.join('').includes(secret));
      // 0本の既存通知へsingle_reasonとして渡る配線と、メッセージへの反映を確かめる。
      const source = fs.readFileSync(path.join(__dirname, '../../generate-draft.js'), 'utf8');
      assert(source.includes('singleRun.results.length ? [] : [singleRun.reason]'));
      assert(source.includes('outputs.single_reason = reason'));
      const workflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/daily-draft.yml'), 'utf8');
      assert(workflow.includes('SINGLE_REASON: ${{ steps.draft.outputs.single_reason }}'));
      const { buildMessage } = require('../../../netlify/functions/lib/notify/message');
      assert(workflow.includes('--event daily_draft_none'));
      assert(buildMessage('daily_draft_none', { comment: run.reason }).body.includes(run.reason));
    });
  }
  await test('R0', 'Gatewayの鍵なしはAnthropicの鍵で代用せず日次終了', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; process.env.ANTHROPIC_API_KEY = 'anthropic-test-secret';
    delete process.env.AI_GATEWAY_API_KEY;
    const { run, events } = await runFailure(undefined);
    assert.equal(events.length, 1); assert.equal(requests.length, 0);
    assert(run.reason.includes('認証情報が未設定'));
  });
  await test('R0', 'API以外の生成失敗も取り下げに残さず試行に記録', async () => {
    const { run } = await runFailure(async () => { throw new Error(secret); });
    assert.equal(run.candidates, 2);
    assert(run.attempts.every(value => value.includes('本文生成に失敗')));
    assert(!run.reason.includes(secret));
  });
  await test('R0', '先行候補の長い理由があってもAPI診断を通知の600文字に残す', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway';
    reply = () => http(401);
    const { run } = await runFailure(async () => CM.generateContent({ user: '本文' }), {
      checkAI: async ([t]) => ({ results: [{ slug: t.slug, duplicate: t.slug === 'a', similar_to: '旧'.repeat(650), reason: '重複' }] }),
    }, 1);
    assert.equal(run.candidates, 2); assert.equal(run.generations, 1);
    assert.equal(run.attempts.length, 2);
    assert(run.reason.includes('本文生成モデルの呼び出しに失敗（GatewayError HTTP 401）'));
    assert([...run.reason].length <= 600);
  });
  await test('R0', 'generation-failedだけを除外から外し、本来の取り下げは維持', () => {
    const failed = { topic_id: 'a', stage: 'generation-failed', target_query: '検索　税金' };
    for (const data of [[failed], { entries: [failed] }]) {
      assert.equal(W.findWithdrawnTopic({ slug: 'a' }, data), null);
      assert.equal(W.findWithdrawnQuery('検索 税金', data), null);
    }
    const withdrawn = { ...failed, stage: 'pregen-dedup' };
    assert.equal(W.findWithdrawnTopic({ slug: 'a' }, [failed, withdrawn]), withdrawn);
    assert.equal(W.findWithdrawnQuery('検索 税金', [failed, withdrawn]), withdrawn);
  });
  await test('R10', '3ワークフローの生成envはSecretと変数を参照しrunに埋め込まない', () => {
    for (const name of ['daily-draft', 'regenerate-draft', 'refresh-article']) {
      const source = fs.readFileSync(path.join(__dirname, `../../../.github/workflows/${name}.yml`), 'utf8');
      const lines = source.split('\n');
      assert.equal(lines.filter(line => line.includes('AI_GATEWAY_API_KEY')).length, 1);
      assert(lines.some(line => line.trim() === 'AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}'));
      for (const variable of ['CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL', 'AUX_MODEL_PROVIDER', 'AUX_MODEL']) {
        assert(source.includes(`${variable}: \u0024{{ vars.${variable} }}`));
      }
      let inRun = false, indentation = 0;
      for (const line of lines) {
        if (inRun && line.trim() && line.search(/\S/) <= indentation) inRun = false;
        if (/^\s+run:/.test(line)) { inRun = true; indentation = line.search(/\S/); }
        if (inRun) assert(!line.includes('secrets.AI_GATEWAY_API_KEY'));
      }
    }
  });
}

main().finally(() => {
  global.fetch = oldFetch; console.log = oldLog; console.warn = oldWarn; global.setTimeout = oldTimer;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  let failures = 0;
  for (const [group, r] of Object.entries(results)) { oldLog(`${group}: PASS ${r.pass} / FAIL ${r.fail}`); failures += r.fail; }
  process.exitCode = failures ? 1 : 0;
}).catch(error => { oldLog(error.stack); process.exitCode = 1; });
