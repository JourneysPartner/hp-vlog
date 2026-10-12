'use strict';

/**
 * 本文生成モデルの provider 抽象化
 *
 * 環境変数:
 *   CONTENT_MODEL_PROVIDER   'openai'（既定） | 'anthropic'
 *   CONTENT_MODEL            モデルID（未指定時は provider 既定）
 *   CONTENT_MODEL_USE_PROMPT_CACHE  'true' で Anthropic prompt caching を有効化（既定 true）
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY  各 provider のキー
 *
 * 重要:
 *   - 既定は openai（本番の現行挙動を壊さない）
 *   - anthropic はキー未設定なら openai に安全 fallback
 *   - 記事品質を落とさないため、fallback してもモデルは本文生成用（安価モデルに落とさない）
 *   - APIキー・秘密情報はログに出さない
 */

const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-6';
const OPENAI_DEFAULT_MODEL    = 'gpt-5.4';
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
  const p = (process.env.CONTENT_MODEL_PROVIDER || 'openai').toLowerCase();
  if (p === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('[content-model] CONTENT_MODEL_PROVIDER=anthropic だが ANTHROPIC_API_KEY 未設定 → openai に fallback');
    return 'openai';
  }
  return p === 'anthropic' ? 'anthropic' : 'openai';
}

function useCache() {
  const v = (process.env.CONTENT_MODEL_USE_PROMPT_CACHE || 'true').toLowerCase();
  return v !== 'false' && v !== '0';
}

// provider ごとに「その provider 専用の env」からモデルを解決する。
// 重要: OpenAI に CONTENT_MODEL（= claude-sonnet-4-6）を渡さないため、
//       provider が openai のときは OPENAI_MODEL / gpt-5.4 のみを返す。
//       provider が anthropic のときは CONTENT_MODEL / claude-sonnet-4-6 を返す。
function resolveModel(provider, override) {
  if (override) return override;
  if (provider === 'anthropic') {
    return process.env.CONTENT_MODEL || ANTHROPIC_DEFAULT_MODEL;
  }
  // openai（本文生成 provider が openai の時、または anthropic 失敗時の fallback）
  return process.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
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
  return { text, usage: completion.usage || null, provider: 'openai', model };
}

// ── Anthropic 呼び出し（prompt caching 対応、fetch ベース）───────
async function callAnthropic(promptIR, { model, maxTokens, signal, timeoutMs }) {
  const { toAnthropicRequest } = require('./article-prompt-builder');
  const reqBody = toAnthropicRequest(promptIR, { model, maxTokens: maxTokens || 4096, useCache: useCache() });

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
    const text = Array.isArray(data.content)
      ? data.content.map(b => (b.type === 'text' ? b.text : '')).join('')
      : '';
    // usage には cache_creation_input_tokens / cache_read_input_tokens が含まれる（秘密情報ではない）
    const u = data.usage || {};
    console.log(`[content-model] provider=anthropic model=${model} cache=${useCache()} ` +
      `usage(in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} ` +
      `cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0})`);
    return { text, usage: data.usage || null, provider: 'anthropic', model };
  } finally { if (dispatcher) await dispatcher.close(); }
}

/**
 * 中間表現 promptIR = { staticSystem, dynamicSystem, user } を受け取り、
 * provider に応じて本文生成モデルを呼ぶ。
 *
 * @param {Object} promptIR
 * @param {Object} opts { model?, maxTokens? }
 * @returns {Object} { text, usage, provider, model }
 */
async function generateContent(promptIR, opts = {}) {
  // 事実照合は本文生成と独立した設定を使い、失敗時のモデル変更を行わない。
  const provider = opts.provider || resolveProvider();
  if (!['anthropic', 'openai'].includes(provider)) throw new Error('未対応のモデル提供元です');
  if (opts.fallback === false && !process.env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']) {
    throw new Error('モデルの認証情報が未設定です');
  }
  const model = resolveModel(provider, opts.model);
  if (provider === 'anthropic') {
    try {
      return await callAnthropic(promptIR, { model, maxTokens: opts.maxTokens, signal: opts.signal,
        ...(opts.fallback === false ? { timeoutMs: opts.timeoutMs } : {}) });
    } catch (e) {
      if (opts.fallback === false) {
        const error = new Error('照合モデルの呼び出しに失敗しました');
        error.diagnostic = safeDiagnostic(e);
        throw error;
      }
      console.warn(`[content-model] Anthropic 失敗（${e.message}）→ openai に fallback`);
      const oaModel = resolveModel('openai', null);
      return await callOpenAI(promptIR, { model: oaModel, maxTokens: opts.maxTokens });
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
  // openai fallback 側は toOpenAIMessages が figures を data URL で載せる
  const promptIR = { staticSystem: system, dynamicSystem: '', user, figures: figures || [] };
  // デフォルト 4096：本文相当の出力長を呼び出し側が忘れても安全側に倒す。
  // 短い JSON 等を返す呼び出しは opts.maxTokens で明示的に絞ること。
  const maxTokens = opts.maxTokens || 4096;
  if (provider === 'anthropic') {
    try {
      const { buildAnthropicUserContent } = require('./article-prompt-builder');
      const req = {
        model,
        max_tokens: maxTokens,
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
      const text = Array.isArray(data.content) ? data.content.map(b => b.text || '').join('') : '';
      return { text, usage: data.usage || null, provider: 'anthropic', model };
    } catch (e) {
      console.warn(`[content-model] Anthropic(simple) 失敗（${e.message}）→ openai に fallback`);
    }
  }
  // openai
  return await callOpenAI(promptIR, { model: resolveModel('openai', null), maxTokens });
}

module.exports = {
  generateContent,
  generateSimple,
  safeDiagnostic,
  resolveProvider,
  resolveModel,
  useCache,
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
};
