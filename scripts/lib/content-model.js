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
const OPENAI_DEFAULT_MODEL    = process.env.OPENAI_MODEL || 'gpt-5.4';
const ANTHROPIC_VERSION       = '2023-06-01';

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

function resolveModel(provider, override) {
  if (override) return override;
  if (process.env.CONTENT_MODEL) return process.env.CONTENT_MODEL;
  return provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
}

// ── OpenAI 呼び出し（既存挙動）──────────────────────────────────
async function callOpenAI(promptIR, { model, maxTokens }) {
  const _sdk = require('openai');
  const OpenAI = _sdk.default || _sdk.OpenAI || _sdk;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { toOpenAIMessages } = require('./article-prompt-builder');
  const messages = toOpenAIMessages(promptIR);
  const completion = await client.chat.completions.create({
    model,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  });
  const choice = completion && completion.choices && completion.choices[0];
  const text = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content
    : (choice && choice.message && Array.isArray(choice.message.content)
        ? choice.message.content.map(p => p.text || '').join('')
        : '');
  return { text, usage: completion.usage || null, provider: 'openai', model };
}

// ── Anthropic 呼び出し（prompt caching 対応、fetch ベース）───────
async function callAnthropic(promptIR, { model, maxTokens }) {
  const { toAnthropicRequest } = require('./article-prompt-builder');
  const reqBody = toAnthropicRequest(promptIR, { model, maxTokens: maxTokens || 4096, useCache: useCache() });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(reqBody),
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
  // usage には cache_creation_input_tokens / cache_read_input_tokens が含まれる
  return { text, usage: data.usage || null, provider: 'anthropic', model };
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
  const provider = resolveProvider();
  const model = resolveModel(provider, opts.model);
  if (provider === 'anthropic') {
    try {
      return await callAnthropic(promptIR, { model, maxTokens: opts.maxTokens });
    } catch (e) {
      console.warn(`[content-model] Anthropic 失敗（${e.message}）→ openai に fallback`);
      const oaModel = resolveModel('openai', null);
      return await callOpenAI(promptIR, { model: oaModel, maxTokens: opts.maxTokens });
    }
  }
  return await callOpenAI(promptIR, { model, maxTokens: opts.maxTokens });
}

/**
 * シンプルな { system, user } 形式（部分修正プロンプト用）を呼ぶ。
 * provider は本文生成と同じ。Anthropic でも cache は付けない（短いため）。
 */
async function generateSimple({ system, user }, opts = {}) {
  const provider = resolveProvider();
  const model = resolveModel(provider, opts.model);
  const promptIR = { staticSystem: system, dynamicSystem: '', user };
  if (provider === 'anthropic') {
    try {
      const req = {
        model,
        max_tokens: opts.maxTokens || 2048,
        system: [{ type: 'text', text: system }],
        messages: [{ role: 'user', content: user }],
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
  return await callOpenAI(promptIR, { model: resolveModel('openai', null), maxTokens: opts.maxTokens });
}

module.exports = {
  generateContent,
  generateSimple,
  resolveProvider,
  resolveModel,
  useCache,
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
};
