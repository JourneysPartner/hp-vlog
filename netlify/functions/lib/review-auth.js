'use strict';

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');

const ORIGIN = 'https://mori-zeirishi.net';
const COOKIE_NAME = '__Host-review_session';
const TTL = 43200;
const sha256 = value => crypto.createHash('sha256').update(value).digest();
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 重複したヘッダは、どちらを信頼するかを選ばず無効にする。
function header(event, name) {
  const entries = Object.entries(event.headers || {}).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  if (entries.length > 1 || (entries.length && typeof entries[0][1] !== 'string')) return null;
  const multiple = Object.entries(event.multiValueHeaders || {}).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  if (multiple.length > 1) return null;
  if (multiple.length) {
    const values = multiple[0][1];
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') return null;
    if (entries.length && entries[0][1] !== values[0]) return null;
    return values[0];
  }
  return entries.length ? entries[0][1] : undefined;
}

function decode(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const result = Buffer.from(value, 'base64url');
  return result.toString('base64url') === value && (!bytes || result.length === bytes) ? result : null;
}

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/review?')) return '/review';
  try {
    // 二重に符号化された制御文字もリダイレクトに持ち込まない。
    let decoded = value;
    for (let i = 0; i <= 3; i++) {
      if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.startsWith('//')) return '/review';
      if (i === 3) break;
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    const url = new URL(value, ORIGIN);
    return url.origin === ORIGIN && url.pathname === '/review' ? value : '/review';
  } catch { return '/review'; }
}

function pageHeaders(nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  };
}

function jsonError(statusCode, error) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error }) };
}

function cookie(value, maxAge = TTL) {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function createReviewAuth({ env = process.env, now = () => Date.now(), getStoreFn = getStore,
  fetchFn = (...args) => globalThis.fetch(...args),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  notify = (...args) => require('./notify').sendNotification(...args),
  log = entry => console.info(JSON.stringify(entry)),
  comparePassword = (input, expected) => crypto.timingSafeEqual(sha256(input), sha256(expected)),
} = {}) {
  async function blobsFetch(input, options) {
    const response = await fetchFn(input, options);
    const method = String(options?.method || input?.method || 'GET').toUpperCase();
    // 導入済みSDKは条件付きPUTの失敗もmodified:trueにするため、先に止める。
    if (method === 'PUT' && response.status !== 200 && response.status !== 412) {
      throw new Error('ログイン記録の保存に失敗しました');
    }
    return response;
  }
  function sourceSecret() {
    const source = env.REVIEW_SESSION_SECRET !== undefined ? env.REVIEW_SESSION_SECRET : env.GH_APP_PRIVATE_KEY;
    return typeof source === 'string' && source && (env.REVIEW_SESSION_SECRET === undefined || [...source].length >= 32) ? source : null;
  }
  function ipHash(event) {
    const source = sourceSecret();
    if (!source) return null;
    const ip = (header(event, 'x-nf-client-connection-ip') || '').trim() || 'unknown';
    // パスワード変更で失敗回数を消さず、セッションとも用途を分ける。
    const key = Buffer.from(crypto.hkdfSync('sha256', source, Buffer.alloc(0), 'hp-vlog review ip v1', 32));
    return hmac(key, ip).toString('hex');
  }
  function audit(event, reason) {
    // 鍵が未設定のときは、IPに依存しない固定のマスクだけを残す。
    log({ ipHash: ipHash(event)?.slice(0, 8) || '00000000', reason, time: new Date(now()).toISOString() });
  }
  function configuration(event) {
    const password = env.REVIEW_PASSWORD;
    const source = sourceSecret();
    if (typeof password !== 'string' || [...password].length < 12) {
      audit(event, 'パスワード設定の誤り');
      return { response: jsonError(503, 'レビューのパスワードが未設定です') };
    }
    if (!source) {
      audit(event, '署名設定の誤り');
      return { response: jsonError(503, 'レビューの認証設定を確認してください') };
    }
    return { password, key: Buffer.from(crypto.hkdfSync('sha256', source, sha256(password), 'hp-vlog review session v1', 32)) };
  }
  function issueSession(key) {
    const iat = Math.floor(now() / 1000);
    const session = { v: 1, iat, exp: iat + TTL, sid: crypto.randomBytes(16).toString('base64url') };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    return `${payload}.${hmac(key, payload).toString('base64url')}`;
  }
  function verifySession(value, key) {
    try {
      if (typeof value !== 'string' || value.length > 2048) return null;
      const parts = value.split('.');
      if (parts.length !== 2) return null;
      const payload = decode(parts[0]);
      const signature = decode(parts[1], 32);
      if (!payload || !signature || !crypto.timingSafeEqual(signature, hmac(key, parts[0]))) return null;
      const s = JSON.parse(payload.toString('utf8'));
      const seconds = Math.floor(now() / 1000);
      if (!s || s.v !== 1 || !Number.isSafeInteger(s.iat) || !Number.isSafeInteger(s.exp)
        || s.iat < 0 || s.iat > seconds || s.exp <= seconds || s.exp <= s.iat || s.exp - s.iat > TTL || !decode(s.sid, 16)) return null;
      return s;
    } catch { return null; }
  }
  function sessionFromEvent(event, key) {
    const cookies = header(event, 'cookie');
    if (typeof cookies !== 'string') return null;
    const values = cookies.split(';').map(part => part.trim()).filter(part => part.split('=')[0] === COOKIE_NAME);
    return values.length === 1 ? verifySession(values[0].slice(COOKIE_NAME.length + 1), key) : null;
  }
  const csrfToken = (session, key) => hmac(key, `csrf:${session.sid}`).toString('base64url');
  function validOrigin(event) {
    // 本番の Origin を偽装したプレビュー宛ての要求も実行させない。
    if (env.CONTEXT && env.CONTEXT !== 'production') return false;
    const host = header(event, 'host');
    if (host !== undefined && host !== 'mori-zeirishi.net') return false;
    if (event.rawUrl) {
      try { if (new URL(event.rawUrl).origin !== ORIGIN) return false; } catch { return false; }
    }
    const origin = header(event, 'origin');
    if (origin !== undefined) return origin === ORIGIN;
    try { return new URL(header(event, 'referer')).origin === ORIGIN; } catch { return false; }
  }
  function requireSession(event) {
    const config = configuration(event);
    if (config.response) return config;
    const session = sessionFromEvent(event, config.key);
    if (!session) {
      audit(event, 'セッション無効');
      return { response: jsonError(401, 'ログインし直してください') };
    }
    return { ...config, session };
  }
  function requireAction(event) {
    const config = configuration(event);
    if (config.response) return config;
    if (!validOrigin(event)) {
      audit(event, 'CSRF送り元不正');
      return { response: jsonError(403, 'この操作は許可されていません') };
    }
    const session = sessionFromEvent(event, config.key);
    if (!session) {
      audit(event, 'セッション無効');
      return { response: jsonError(401, 'ログインし直してください') };
    }
    const token = decode(header(event, 'x-review-token'), 32);
    const type = (header(event, 'content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' || !token || !crypto.timingSafeEqual(token, hmac(config.key, `csrf:${session.sid}`))) {
      audit(event, 'CSRFトークン不正');
      return { response: jsonError(403, 'この操作は許可されていません') };
    }
    return { ...config, session };
  }
  function loginPage(next, statusCode = 401, message = '') {
    const nonce = crypto.randomBytes(18).toString('base64url');
    // next 全体を符号化し、未認証の HTML にファイル名を直接載せない。
    const encodedNext = [...Buffer.from(safeNext(next))].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
    return { statusCode, headers: pageHeaders(nonce), body: `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>レビュー画面にログイン</title>
<style>body{font-family:sans-serif;background:#f5f5f5;color:#0b2045;margin:0;padding:2rem}.box{max-width:400px;margin:4rem auto;background:white;padding:2rem;border-radius:12px}input,button{box-sizing:border-box;width:100%;padding:.8rem;margin-top:1rem}button{background:#0b2045;color:white;border:0;border-radius:6px}</style></head><body><main class="box"><h1>レビュー画面にログイン</h1><p role="alert">${escapeHtml(message)}</p><form method="post" action="/review-login"><label for="password">パスワード</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required><input type="hidden" name="next" value="${escapeHtml(encodedNext)}"><button type="submit">レビュー画面を開く</button></form><script nonce="${nonce}">
const next = document.querySelector('input[name="next"]');
next.value = decodeURIComponent(next.value);
const form = document.querySelector('form');
form.addEventListener('submit', event => {
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) { event.preventDefault(); return; }
  button.disabled = true;
  button.textContent = '確認しています…';
});
</script></main></body></html>` };
  }
  function pageNext(event) {
    const query = new URLSearchParams(event.queryStringParameters || {}).toString();
    return safeNext(query ? `/review?${query}` : '/review');
  }
  function rateRecord(record, windowMs, at) {
    if (record === null) return { start: at, count: 0, blockedUntil: 0, notified: false };
    if (!record || !Number.isSafeInteger(record.start) || record.start < 0 || record.start > at
      || !Number.isSafeInteger(record.count) || record.count < 0
      || !Number.isSafeInteger(record.blockedUntil) || record.blockedUntil < 0 || typeof record.notified !== 'boolean') throw new Error('失敗回数の記録が不正');
    if (record.blockedUntil > at) return record;
    return record.blockedUntil || at - record.start >= windowMs ? { start: at, count: 0, blockedUntil: 0, notified: false } : record;
  }
  async function readRate(store, key, windowMs, at) {
    const entry = await store.getWithMetadata(key, { type: 'json' });
    if (entry === null) return { record: rateRecord(null, windowMs, at), condition: { onlyIfNew: true } };
    if (!entry || typeof entry.etag !== 'string' || !entry.etag || !entry.data) throw new Error('失敗回数の記録が不正');
    return { record: rateRecord(entry.data, windowMs, at), condition: { onlyIfMatch: entry.etag } };
  }
  function limited(next, event, conflict = false) {
    audit(event, conflict ? 'ログイン記録の競合' : 'ログイン試行回数の上限');
    return loginPage(next, 429, conflict ? 'もう一度お試しください' : 'しばらくしてからお試しください');
  }
  async function login(event) {
    if (event.httpMethod !== 'POST') return loginPage('/review', 405, 'レビュー画面からログインしてください');
    const config = configuration(event);
    if (config.response) return loginPage('/review', 503, '現在ログインできません。しばらくしてからお試しください');
    if (!validOrigin(event)) {
      audit(event, 'CSRF送り元不正');
      return loginPage('/review', 403, 'レビュー画面を開き直してからログインしてください');
    }
    if ((header(event, 'content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      audit(event, 'CSRFログイン形式不正');
      return loginPage('/review', 403, 'レビュー画面を開き直してからログインしてください');
    }
    const form = new URLSearchParams(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '');
    const next = safeNext(form.get('next'));
    try {
      if (getStoreFn === getStore) connectLambda(event);
      // connectLambdaの接続では通常の読み込みを使い、古い記録は照合前の条件付き書き込みで止める。
      const store = getStoreFn({ name: 'review-auth', fetch: blobsFetch });
      const ipKey = `ip/${ipHash(event)}`;
      const at = now();
      const ipRate = await readRate(store, ipKey, 900000, at);
      const globalRate = await readRate(store, 'global', 3600000, at);
      const ip = ipRate.record;
      const global = globalRate.record;
      if (ip.blockedUntil > at || global.blockedUntil > at) return limited(next, event);
      // 照合より先に両方の枠を確保する。競合時は再試行も照合もしない。
      ip.count++;
      global.count++;
      if (ip.count >= 5) ip.blockedUntil = at + 900000;
      const shouldNotify = global.count >= 30 && !global.notified;
      if (global.count >= 30) { global.blockedUntil = at + 3600000; global.notified = true; }
      for (const [key, record, condition] of [[ipKey, ip, ipRate.condition], ['global', global, globalRate.condition]]) {
        const result = await store.set(key, JSON.stringify(record), condition);
        if (result?.modified === false) return limited(next, event, true);
        if (result?.modified !== true) throw new Error('失敗回数の保存に失敗');
      }
      if (shouldNotify) {
        try { await notify('review_auth_locked', {}); }
        catch { audit(event, '上限通知の失敗'); }
      }
      if (comparePassword(form.get('password') || '', config.password) === true) {
        // 書き込みできないストアでは成功 Cookie を発行しない。
        await store.delete(ipKey);
        audit(event, 'ログイン成功');
        return { statusCode: 303, headers: { 'Cache-Control': 'no-store', Location: next, 'Set-Cookie': cookie(issueSession(config.key)) }, body: '' };
      }
      audit(event, 'ログイン失敗');
      await sleep(1000);
      return loginPage(next, 401, 'パスワードが違います');
    } catch {
      audit(event, 'ログイン記録の読み書き失敗');
      return loginPage(next, 503, '現在ログインできません。しばらくしてからお試しください');
    }
  }
  function logout(event) {
    if (event.httpMethod !== 'POST') return jsonError(405, 'Method Not Allowed');
    const auth = requireAction(event);
    if (auth.response) return auth.response;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': cookie('', 0) }, body: JSON.stringify({ message: 'ログアウトしました' }) };
  }
  return { configuration, issueSession, verifySession, csrfToken, requireSession, requireAction, loginPage, pageNext, login, logout };
}

module.exports = { ...createReviewAuth(), createReviewAuth, pageHeaders, safeNext, escapeHtml, COOKIE_NAME, TTL };
