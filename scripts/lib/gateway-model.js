'use strict';

const { toOpenAIMessages } = require('./article-prompt-builder');
const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';

class GatewayError extends Error {}

// 応答本文や通信例外の文面は、鍵を反射する可能性があるので例外にも残さない。
function gatewayError(code, status) {
  const messages = {
    credentials: 'Gateway の認証情報が未設定です',
    timeout: 'Gateway の時間切れ',
    aborted: 'Gateway の呼び出しを中止しました',
    network: 'Gateway の通信に失敗しました',
    response: 'Gateway の応答を読み取れません',
    http: `Gateway HTTP ${status}`,
  };
  const error = new GatewayError(messages[code]);
  const names = { credentials: 'GatewayCredentialsError', timeout: 'GatewayTimeoutError',
    aborted: 'GatewayAbortError', network: 'GatewayNetworkError', response: 'GatewayResponseError', http: 'GatewayError' };
  error.name = names[code];
  if (status) error.status = status;
  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(gatewayError('aborted')); };
    let timer;
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  });
}

async function callGateway({ model, system, user, figures, maxTokens, task, signal, timeoutMs = 300000 }) {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw gatewayError('credentials');
  const messages = toOpenAIMessages({ staticSystem: '', dynamicSystem: '', user, figures });
  messages[0].content = system;
  const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { expired = true; abort(); }, timeoutMs);
  // fetch 自体の既定の接続待ち時間でも、15分の本文生成を打ち切らない。
  const dispatcher = new (require('undici').Agent)({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  let onAbort;
  const limit = new Promise((_, reject) => {
    onAbort = () => reject(gatewayError(expired ? 'timeout' : 'aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    if (signal?.aborted) abort();
    return await Promise.race([limit, (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.signal.aborted) throw gatewayError(expired ? 'timeout' : 'aborted');
        let res;
        try {
          res = await fetch(ENDPOINT, { method: 'POST', headers: {
            'content-type': 'application/json', authorization: `Bearer ${key}`,
          }, body, signal: controller.signal, dispatcher });
        } catch (_) {
          if (controller.signal.aborted) throw gatewayError(expired ? 'timeout' : 'aborted');
          if (attempt === 2) throw gatewayError('network');
          await sleep(15000 * (attempt + 1), controller.signal);
          continue;
        }
        if (!res.ok) {
          // 再試行前に応答を解放する。本文は診断にもログにも含めない。
          try { await res.body?.cancel(); } catch (_) { /* 応答の解放失敗で状態番号を隠さない。 */ }
          if (attempt < 2 && (res.status === 429 || res.status >= 500 && res.status <= 599)) {
            await sleep(15000 * (attempt + 1), controller.signal);
            continue;
          }
          throw gatewayError('http', res.status);
        }
        let data;
        try { data = await res.json(); } catch (error) {
          if (controller.signal.aborted) throw gatewayError(expired ? 'timeout' : 'aborted');
          if (error instanceof TypeError) {
            if (attempt === 2) throw gatewayError('network');
            await sleep(15000 * (attempt + 1), controller.signal);
            continue;
          }
          throw gatewayError('response');
        }
        if (controller.signal.aborted) throw gatewayError(expired ? 'timeout' : 'aborted');
        const choice = data?.choices?.[0];
        if (typeof choice?.message?.content !== 'string') throw gatewayError('response');
        const u = data.usage || {};
        // 自由な応答文字列・環境変数をそのままログに出さない。
        const safe = value => {
          let text = String(value ?? '?');
          for (const secret of [key, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]) {
            if (secret) text = text.split(secret).join('[秘匿]');
          }
          return text.replace(/[\r\n]/g, ' ');
        };
        const count = value => Number.isFinite(value) ? value : '?';
        console.log(`[gateway] model=${safe(model)} task=${safe(task)} ` +
          `usage(in=${count(u.prompt_tokens)} out=${count(u.completion_tokens)} ` +
          `reasoning=${count(u.completion_tokens_details?.reasoning_tokens)} cached=${count(u.prompt_tokens_details?.cached_tokens)}) finish=${safe(choice.finish_reason)}`);
        return { text: choice.message.content,
          usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens },
          provider: 'gateway', model, stopReason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn' };
      }
    })()]);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw gatewayError('response');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
    await dispatcher.close();
  }
}

module.exports = { callGateway };
