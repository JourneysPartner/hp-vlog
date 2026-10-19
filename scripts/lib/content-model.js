'use strict';

/**
 * 本文生成モデルの provider 抽象化
 *
 * 環境変数:
 *   CONTENT_MODEL_PROVIDER   'anthropic'（既定）| 'gateway'
 *   CONTENT_MODEL            モデルID（未指定時は provider 既定。Anthropic は claude-sonnet-5-5）
 *   CONTENT_MODEL_USE_PROMPT_CACHE  'true' で Anthropic prompt caching を有効化（既定 true）
 *   ANTHROPIC_API_KEY  本文生成のキー（OpenAI は事実照合の明示指定だけ）
 *   AI_GATEWAY_API_KEY  Gateway のキー
 *
 * 重要:
 *   - Anthropic の失敗は呼び出し元へ返す（別の提供元では生成し直さない）
 *   - APIキー・秘密情報はログに出さない
 */

const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_VERSION       = '2023-06-01';

// 照合の失敗理由は、鍵を含まない「状態番号・エラーの種類・短い説明」だけに絞って残す。
function redactSecrets(text) {
  let out = String(text || '');
  for (const key of [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]) {
    if (key && key.length >= 8) out = out.split(key).join('[秘匿]');
  }
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[秘匿]')
    .replace(/((?:x-api-key|api[_-]?key|authorization|bearer)["']?\s*[:=]?\s*)[^\s"',;]+/gi, '$1[秘匿]');
}

const FIXED_ERROR_MESSAGES = ['照合の時間切れ', 'モデルの認証情報が未設定です', '未対応のモデル提供元です'];

function safeDiagnostic(e) {
  const message = String((e && e.message) || e || '');
  const http = message.match(/^Anthropic API (\d{3}):\s*([\s\S]*)$/);
  let out;
  if (http) {
    let type = '', detail = '';
    try {
      const body = JSON.parse(http[2]);
      type = (body.error && body.error.type) || '';
      detail = (body.error && body.error.message) || '';
    } catch (_) { /* 応答が JSON でなければ状態番号だけ残す */ }
    out = `Anthropic HTTP ${http[1]}${type ? ` ${type}` : ''}${detail ? `: ${detail}` : ''}`;
  } else if (e && typeof e.status === 'number') {
    out = `${(e && e.name) || 'Error'} HTTP ${e.status}${e.code ? ` ${e.code}` : ''}`;
  } else {
    // 例外の文面は任意の内容を含みうるので残さない。こちらで決めた固定文だけは残す。
    const cause = e && e.cause && (e.cause.code || e.cause.name);
    const fixed = FIXED_ERROR_MESSAGES.includes(message) ? `: ${message}` : '';
    out = `${(e && e.name) || 'Error'}${cause ? ` (${cause})` : ''}${fixed}`;
  }
  return redactSecrets(out).replace(/\s+/g, ' ').slice(0, 300);
}

function resolveProvider() {
  const p = (process.env.CONTENT_MODEL_PROVIDER || 'anthropic').toLowerCase();
  if (!['anthropic', 'gateway'].includes(p)) throw new Error('未対応の本文生成提供元です');
  return p;
}

function useCache() {
  const v = (process.env.CONTENT_MODEL_USE_PROMPT_CACHE || 'true').toLowerCase();
  return v !== 'false' && v !== '0';
}

// OpenAI は事実照合がモデル名を明示した場合だけ利用できる。
function resolveModel(provider, override) {
  if (override) return override;
  if (provider === 'anthropic' || provider === 'gateway') return process.env.CONTENT_MODEL || ANTHROPIC_DEFAULT_MODEL;
  throw new Error('事実照合のモデル名を明示してください');
}

// ── OpenAI 呼び出し（既存挙動）──────────────────────────────────
async function callOpenAI(promptIR, { model, maxTokens, signal, timeoutMs }) {
  const _sdk = require('openai');
  const OpenAI = _sdk.default || _sdk.OpenAI || _sdk;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  const { toOpenAIMessages } = require('./article-prompt-builder');
  const messages = toOpenAIMessages(promptIR);
  const completion = await client.chat.completions.create({
    model,
    messages,
    ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
  }, signal ? { signal } : undefined);
  const choice = completion && completion.choices && completion.choices[0];
  const text = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content
    : (choice && choice.message && Array.isArray(choice.message.content)
        ? choice.message.content.map(p => p.text || '').join('')
        : '');
  const u = completion.usage || {};
  console.log(`[content-model] provider=openai model=${model} cache=false ` +
    `usage(in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'})`);
  return { text, usage: completion.usage || null, provider: 'openai', model,
    stopReason: (choice && choice.finish_reason) || null };
}

// ── Anthropic 呼び出し（prompt caching 対応、fetch ベース）───────
async function callAnthropic(promptIR, { model, maxTokens, signal, timeoutMs, modelOptions, validateContent }) {
  const { toAnthropicRequest } = require('./article-prompt-builder');
  const reqBody = toAnthropicRequest(promptIR, { model, maxTokens: maxTokens || 4096, useCache: useCache(), modelOptions });

  // 照合だけは、fetch の既定の待ち時間より長い設定を接続にも反映する。
  const dispatcher = timeoutMs ? new (require('undici').Agent)({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }) : null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(reqBody),
      ...(signal ? { signal } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!res.ok) {
      const errText = await res.text();
      // 秘密情報は出さない（errText は Anthropic の応答のみ）
      throw new Error(`Anthropic API ${res.status}: ${errText}`);
    }
    const data = await res.json();
    if (validateContent) validateAnthropicContent(data);
    return anthropicResult(data, model);
  } finally { if (dispatcher) await dispatcher.close(); }
}

function validateAnthropicContent(data) {
  if (!data || typeof data !== 'object' || data.stop_reason !== 'refusal'
    && (!Array.isArray(data.content) || data.content.some(b => !b || typeof b.type !== 'string' || b.type === 'text' && typeof b.text !== 'string')
      || !data.content.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()))) {
    throw new Error('Anthropic の応答を読み取れません');
  }
}

// 同期と Batch は、拒否・出力上限・使用量を同じ形で呼び出し元へ返す。
function anthropicResult(data, model, logSuffix = '') {
  if (data.stop_reason === 'refusal') {
    const error = new Error('Anthropic refusal' + (data.stop_details?.category ? ` (${redactSecrets(data.stop_details.category)})` : ''));
    error.noSyncFallback = true;
    throw error;
  }
  const text = Array.isArray(data.content) ? data.content.map(b => b.type === 'text' ? b.text : '').join('') : '';
  const u = data.usage || {};
  console.log(`[content-model] provider=anthropic model=${model} cache=${useCache()} ` +
    `usage(in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} ` +
    `cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}) stop=${data.stop_reason}${logSuffix}`);
  return { text, usage: data.usage || null, provider: 'anthropic', model, stopReason: data.stop_reason || null };
}

function abortBatch(signal) {
  if (signal?.aborted) {
    const error = new Error('照合の時間切れ');
    error.noSyncFallback = true;
    throw error;
  }
}

function batchSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); reject(new Error('照合の時間切れ')); };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  });
}

/** 記事ごとに作り、全呼び出しの待ち時間と同期への切替を共有する。時計・待ちは試験で差し替える。 */
function createBatchContext({ maxWaitMs = 3600000, pollMs = 30000, now = Date.now, sleep = batchSleep } = {}) {
  return { maxWaitMs, pollMs: Math.max(5000, pollMs), now, sleep, waitedMs: 0, disabled: false, sequence: 0,
    remainingMs() { return Math.max(0, this.maxWaitMs - this.waitedMs); } };
}

function batchFailure(name) {
  const error = new Error('Batch の結果を利用できません');
  error.name = name;
  return error;
}

async function callAnthropicBatch(promptIR, opts) {
  const { model, maxTokens, modelOptions, signal, batch } = opts;
  const { toAnthropicRequest } = require('./article-prompt-builder');
  const params = toAnthropicRequest(promptIR, { model, maxTokens, useCache: useCache(), modelOptions });
  const base = 'https://api.anthropic.com/v1/messages/batches';
  const customId = `fc-${++batch.sequence}`;
  const started = batch.now(), budget = batch.remainingMs();
  let id, cancelPromise, accounted = false;
  const waited = () => Math.max(0, batch.now() - started);
  const account = () => {
    if (!accounted) { batch.waitedMs += Math.min(budget, waited()); accounted = true; }
  };
  const request = async (url, method = 'GET', body, requestSignal = signal) => {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
      ...(body ? { body: JSON.stringify(body) } : {}), ...(requestSignal ? { signal: requestSignal } : {}) });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    return res;
  };
  // 打ち切られた signal は取消に使えない。取消自体も短い独立の制限で必ず終える。
  const cancel = () => {
    if (!id) return Promise.resolve();
    if (!cancelPromise) cancelPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try { await Promise.race([request(`${base}/${id}/cancel`, 'POST', null, controller.signal),
        new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))]); }
      catch (_) { /* 取消失敗は元の失敗を隠さない。 */ }
      finally { clearTimeout(timer); }
    })();
    return cancelPromise;
  };
  const onAbort = () => { void cancel(); };
  // 確認・結果の通信そのものが止まっても、通常の予算と取消後60秒の上限を守る。
  const bounded = async (deadline, work) => {
    const remaining = deadline - batch.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    let timer, expired = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const limit = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        if (expired) resolve(null);
        else reject(new Error('照合の時間切れ'));
      }, { once: true });
      timer = setTimeout(() => { expired = true; controller.abort(); }, remaining);
    });
    try {
      if (signal?.aborted) abort();
      return await Promise.race([limit, Promise.resolve().then(() => work(controller.signal))]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const result = async phaseSignal => {
    const text = await (await request(`${base}/${id}/results`, 'GET', null, phaseSignal)).text();
    const rows = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    if (rows.length !== 1 || rows[0].custom_id !== customId) throw batchFailure('BatchResultError');
    const value = rows[0].result;
    if (value?.type !== 'succeeded') {
      const names = { errored: 'BatchErroredError', expired: 'BatchExpiredError', canceled: 'BatchCanceledError' };
      throw batchFailure(names[value?.type] || 'BatchResultError');
    }
    if (!value.message || !Array.isArray(value.message.content) || typeof value.message.stop_reason !== 'string') {
      throw batchFailure('BatchResultError');
    }
    abortBatch(phaseSignal);
    const waitSeconds = Math.floor(waited() / 1000);
    return { ...anthropicResult(value.message, model, ` mode=batch wait_seconds=${waitSeconds} batch_id=${redactSecrets(id)}`),
      mode: 'batch', wait_seconds: waitSeconds };
  };
  const poll = async (deadline, phaseSignal) => {
    while (true) {
      abortBatch(phaseSignal);
      if (batch.now() >= deadline) return null;
      const state = await (await request(`${base}/${id}`, 'GET', null, phaseSignal)).json();
      abortBatch(phaseSignal);
      if (state.processing_status === 'ended') return result(phaseSignal);
      if (!['in_progress', 'canceling'].includes(state.processing_status)) throw batchFailure('BatchStatusError');
      const remaining = deadline - batch.now();
      if (remaining <= 0) return null;
      await batch.sleep(Math.min(batch.pollMs, remaining), phaseSignal);
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    abortBatch(signal);
    if (budget <= 0) throw batchFailure('BatchTimeoutError');
    const completed = await bounded(started + budget, async phaseSignal => {
      abortBatch(phaseSignal);
      const created = await (await request(base, 'POST', { requests: [{ custom_id: customId, params }] }, phaseSignal)).json();
      if (typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(created.id)) throw batchFailure('BatchIdError');
      id = created.id;
      if (phaseSignal.aborted) { await cancel(); abortBatch(phaseSignal); }
      return poll(started + budget, phaseSignal);
    });
    if (completed) return completed;
    account();
    if (!id) throw batchFailure('BatchTimeoutError');
    // 通常の待ちの上限とは別に、取消と完了の競合を最大60秒だけ確かめる。
    const cancelDeadline = batch.now() + 60000;
    const raced = await bounded(cancelDeadline, async phaseSignal => { await cancel(); return poll(cancelDeadline, phaseSignal); });
    if (raced) return raced;
    throw batchFailure('BatchTimeoutError');
  } catch (error) {
    abortBatch(signal);
    if (error.noSyncFallback) throw error;
    batch.disabled = true;
    const diagnostic = id ? safeDiagnostic(error).split(id).join('[batch]') : safeDiagnostic(error);
    await cancel();
    abortBatch(signal);
    account();
    const waitSeconds = Math.floor(waited() / 1000);
    try {
      return { ...await callAnthropic(promptIR, opts), mode: 'sync-fallback',
        wait_seconds: waitSeconds, batch_error: diagnostic };
    } catch (syncError) {
      // 同期へのやり直しも失敗した場合に、やり直した理由を記録できるようにする。
      syncError.mode = 'sync-fallback';
      syncError.wait_seconds = waitSeconds;
      syncError.batch_error = diagnostic;
      throw syncError;
    }
  } finally {
    account();
    if (batch.remainingMs() <= 0) batch.disabled = true;
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) await cancel();
  }
}

// 本文のAPI失敗だけを識別する。生の例外や鍵は通知へ渡さない。
function contentCallError(cause) {
  const error = new Error('本文生成モデルの呼び出しに失敗しました');
  const status = cause?.status || Number(String(cause?.message || '').match(/^Anthropic API (\d{3}):/)?.[1]);
  // 拒否・入力不備・応答形式の不備はその候補だけの失敗とする。
  error.contentModelCallFailed = status
    ? [401, 402, 403, 404, 408, 429].includes(status) || status >= 500 && status <= 599
    : ['TypeError', 'AbortError', 'TimeoutError', 'GatewayTimeoutError', 'GatewayNetworkError',
      'GatewayAbortError', 'GatewayCredentialsError'].includes(cause?.name)
      || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(cause?.code || cause?.cause?.code);
  error.contentCandidateFailed = !error.contentModelCallFailed;
  if (status) error.status = status;
  const unreadable = !status && (['GatewayResponseError', 'SyntaxError'].includes(cause?.name)
    || cause?.message === 'Anthropic の応答を読み取れません');
  error.diagnostic = unreadable ? '応答を読み取れない' : safeDiagnostic(cause);
  for (const key of [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.AI_GATEWAY_API_KEY]) {
    if (key) error.diagnostic = error.diagnostic.split(key).join('[秘匿]');
  }
  return error;
}

/**
 * 中間表現 promptIR = { staticSystem, dynamicSystem, user } を受け取り、
 * provider に応じて本文生成モデルを呼ぶ。
 *
 * @param {Object} promptIR
 * @param {Object} opts { model?, maxTokens?, modelOptions?, batch? }
 * @returns {Object} { text, usage, provider, model, stopReason }
 */
async function generateContent(promptIR, opts = {}) {
  // 事実照合は本文生成と独立した設定を使い、失敗時のモデル変更を行わない。
  const provider = opts.provider || resolveProvider();
  if (!['anthropic', 'openai', 'gateway'].includes(provider) || (provider === 'openai' && !(opts.provider === 'openai' && opts.model && opts.fallback === false))) throw new Error('未対応のモデル提供元です');
  if (provider === 'gateway') {
    try {
      return await require('./gateway-model').callGateway({ model: resolveModel(provider, opts.model),
        system: [promptIR.staticSystem, promptIR.dynamicSystem].filter(s => typeof s === 'string' && s.trim()).join('\n\n'),
        user: promptIR.user, figures: promptIR.figures, maxTokens: 64000,
        task: 'generateContent', signal: opts.signal, timeoutMs: 900000 });
    } catch (e) { throw contentCallError(e); }
  }
  if (opts.fallback === false && !process.env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']) {
    throw new Error('モデルの認証情報が未設定です');
  }
  const model = resolveModel(provider, opts.model);
  if (provider === 'anthropic') {
    try {
      const call = opts.batch && !opts.batch.disabled ? callAnthropicBatch : callAnthropic;
      return await call(promptIR, { model, maxTokens: opts.maxTokens, signal: opts.signal, modelOptions: opts.modelOptions,
        batch: opts.batch, ...(opts.fallback === false ? { timeoutMs: opts.timeoutMs } : { validateContent: true }) });
    } catch (e) {
      if (opts.fallback === false) {
        const error = new Error('照合モデルの呼び出しに失敗しました');
        error.diagnostic = safeDiagnostic(e);
        for (const key of ['mode', 'wait_seconds', 'batch_error']) if (e[key] !== undefined) error[key] = e[key];
        throw error;
      }
      throw contentCallError(e);
    }
  }
  return await callOpenAI(promptIR, { model, maxTokens: opts.maxTokens, signal: opts.signal, timeoutMs: opts.timeoutMs });
}

/**
 * シンプルな { system, user } 形式（部分修正プロンプト用）を呼ぶ。
 * provider は本文生成と同じ。Anthropic でも cache は付けない（短いため）。
 */
// figures: 出典の図（nta-source-body.loadSourceFigures の戻り）。差し戻し再生成でも
// 図を見られるように受け取る（2026-09-06、日次生成だけに入れていた穴を塞ぐ）。
async function generateSimple({ system, user, figures }, opts = {}) {
  const provider = resolveProvider();
  const model = resolveModel(provider, opts.model);
  // デフォルト 4096：本文相当の出力長を呼び出し側が忘れても安全側に倒す。
  // 短い JSON 等を返す呼び出しは opts.maxTokens で明示的に絞ること。
  const maxTokens = opts.maxTokens || 4096;
  if (provider === 'gateway') {
    try {
      return await require('./gateway-model').callGateway({ model, system, user, figures,
        maxTokens: opts.kind === 'body' ? 64000 : Math.max(maxTokens, 16000),
        task: 'generateSimple', signal: opts.signal, timeoutMs: opts.kind === 'body' ? 900000 : 300000 });
    } catch (e) { throw contentCallError(e); }
  }
  if (provider === 'anthropic') {
    try {
      const { buildAnthropicUserContent, anthropicModelOptions } = require('./article-prompt-builder');
      const req = {
        model,
        max_tokens: maxTokens,
        ...anthropicModelOptions(model),
        system: [{ type: 'text', text: system }],
        messages: [{ role: 'user', content: buildAnthropicUserContent(user, figures) }],
      };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      validateAnthropicContent(data);
      if (data.stop_reason === 'refusal') {
        throw new Error('Anthropic refusal' + (data.stop_details?.category ? ` (${data.stop_details.category})` : ''));
      }
      const text = Array.isArray(data.content)
        ? data.content.map(b => (b.type === 'text' ? b.text : '')).join('')
        : '';
      const u = data.usage || {};
      console.log(`[content-model] provider=anthropic model=${model} cache=false ` +
        `usage(in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} ` +
        `cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}) stop=${data.stop_reason}`);
      return { text, usage: data.usage || null, provider: 'anthropic', model, stopReason: data.stop_reason || null };
    } catch (e) {
      throw contentCallError(e);
    }
  }
  throw new Error('未対応の本文生成提供元です');
}

module.exports = {
  generateContent,
  generateSimple,
  createBatchContext,
  safeDiagnostic,
  resolveProvider,
  resolveModel,
  useCache,
  ANTHROPIC_DEFAULT_MODEL,
};
