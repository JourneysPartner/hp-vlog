'use strict';

const DEFAULT_LUNA_MODEL = 'gpt-6-luna';
const MODEL_LIST_TIMEOUT_MS = 15000;

// 並行する最初の呼び出しも同じ Promise を共有し、実行中は一度だけ問い合わせる。
function createLunaResolver({ env = process.env, fetchImpl = (...args) => fetch(...args),
  logger = console, timeoutMs = MODEL_LIST_TIMEOUT_MS } = {}) {
  let resolved;
  return function resolveLunaModel() {
    if (!resolved) resolved = (async () => {
      const fixed = String(env.OPENAI_LUNA_MODEL || '').trim();
      // 設定値に鍵が誤入力されていてもログへ出さない。
      const logModel = model => String(model).replace(/[\r\n]/g, '')
        .split(env.OPENAI_API_KEY || '\0').join('[秘匿]').replace(/sk-[\w-]+/g, '[秘匿]');
      const selected = (model, reason) => {
        logger.log(`[openai-model] Luna: ${logModel(model)}（${reason}）`);
        return model;
      };
      if (fixed) return selected(fixed, '変数で固定');
      const controller = new AbortController();
      let timer;
      try {
        if (!env.OPENAI_API_KEY) throw new Error('認証情報なし');
        const expired = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('時間切れ')); }, timeoutMs);
        });
        const listing = (async () => {
          const response = await fetchImpl('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, signal: controller.signal,
          });
          if (!response.ok) throw new Error('一覧取得失敗');
          return response.json();
        })();
        const data = await Promise.race([listing, expired]);
        const candidates = (Array.isArray(data.data) ? data.data : [])
          .map(item => /^gpt-(\d+)(?:\.(\d+))?-luna(?![\s\S])/.exec(item?.id || ''))
          .filter(Boolean)
          .sort((a, b) => {
            const major = BigInt(b[1]) - BigInt(a[1]);
            const minor = BigInt(b[2] || 0) - BigInt(a[2] || 0);
            return major > 0n ? 1 : major < 0n ? -1 : minor > 0n ? 1 : minor < 0n ? -1 : a[0].localeCompare(b[0]);
          });
        if (!candidates.length) throw new Error('候補なし');
        return selected(candidates[0][0], '一覧から自動選択');
      } catch (_) {
        // 応答本文・例外文には鍵が含まれうるので、固定文だけを記録する。
        logger.warn('[openai-model] Luna の一覧を読めないため既定値を使います');
        return selected(DEFAULT_LUNA_MODEL, '一覧を読めず既定値');
      } finally {
        clearTimeout(timer);
      }
    })();
    return resolved;
  };
}

const resolveLunaModel = createLunaResolver();
function logOpenAIUsage(model, task, usage = {}) {
  const key = process.env.OPENAI_API_KEY;
  const safeModel = String(model).split(key || '\0').join('[秘匿]').replace(/sk-[\w-]+/g, '[秘匿]').replace(/[\r\n]/g, '');
  const count = (value, fallback = '?') => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  console.log(`[openai] model=${safeModel} task=${task} usage(in=${count(usage?.prompt_tokens)} out=${count(usage?.completion_tokens)} cached=${count(usage?.prompt_tokens_details?.cached_tokens, 0)})`);
}

module.exports = { resolveLunaModel, createLunaResolver, logOpenAIUsage, DEFAULT_LUNA_MODEL, MODEL_LIST_TIMEOUT_MS };
