'use strict';

/**
 * 管理画面・管理APIの入口の確認。
 *
 * 承認画面（/review）と同じセッション Cookie（lib/review-auth.js の
 * __Host-review_session）と、同じ合言葉（X-Review-Token）を使う。
 * パスワードの照合・Cookie の発行・失敗回数の上限は承認画面と共通で、
 * ログインの入口は POST /review-login の 1 つだけ。
 *
 * 自動処理（.github/workflows/export-contact-transitions.yml）だけは、
 * 本番の GET /admin/api/analytics に限り、ADMIN_BASIC_USER / ADMIN_BASIC_PASS で
 * 読み取りを許す（ほかの画面・処理・GET 以外には使えない）。
 *
 * 守ること:
 *   - 認証を通らない要求は、GitHub・Blobs・自動処理に触れない。
 *   - 失敗はすべて安全側（出さない・処理しない）。ブラウザの認証の小窓は出さない。
 *   - パスワード・Cookie・合言葉・ID・IP そのものは記録しない。
 */

const crypto = require('crypto');
const defaultReviewAuth = require('./review-auth');

// 自動処理用の読み取りを許す本番の住所。プレビュー・ブランチのデプロイは通さない。
const PRODUCTION_HOST = 'mori-zeirishi.net';
const PRODUCTION_ORIGIN = 'https://mori-zeirishi.net';

const sha256 = value => crypto.createHash('sha256').update(value).digest();

const jsonHeaders = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
});

// 重複したヘッダは、どちらを信頼するかを選ばず無効にする（review-auth.js と同じ考え方）。
function singleHeader(event, name) {
  const wanted = name.toLowerCase();
  const entries = Object.entries(event.headers || {}).filter(([key]) => key.toLowerCase() === wanted);
  if (entries.length > 1 || (entries.length && typeof entries[0][1] !== 'string')) return null;
  const multiple = Object.entries(event.multiValueHeaders || {}).filter(([key]) => key.toLowerCase() === wanted);
  if (multiple.length > 1) return null;
  if (multiple.length) {
    const values = multiple[0][1];
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') return null;
    if (entries.length && entries[0][1] !== values[0]) return null;
    return values[0];
  }
  return entries.length ? entries[0][1] : undefined;
}

// Basic の値を ID とパスワードに分ける。形が違えば null（照合に進まない）。
function decodeBasic(value) {
  if (typeof value !== 'string' || !value.startsWith('Basic ')) return null;
  const encoded = value.slice(6).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { id: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function createAdminAuth({
  reviewAuth = defaultReviewAuth,
  env = process.env,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  // 画面 5 本用。pagePath は関数ごとの固定の文字列だけを渡す。
  function requireAdminPage(event, pagePath) {
    const auth = reviewAuth.requireSession(event);
    if (auth.response) {
      if (auth.response.statusCode === 401) return { response: reviewAuth.loginPage(pagePath) };
      return { response: auth.response };
    }
    const nonce = crypto.randomBytes(18).toString('base64url');
    return {
      session: auth.session,
      key: auth.key,
      nonce,
      csrfToken: reviewAuth.csrfToken(auth.session, auth.key),
      headers: { ...reviewAuth.pageHeaders(nonce), 'X-Robots-Tag': 'noindex, nofollow' },
    };
  }

  // 読み取り 2 本用。失敗は JSON の 401・503。
  function requireAdminRead(event) {
    return reviewAuth.requireSession(event);
  }

  // 書き込み 3 本用。送り元 → セッション → 合言葉と Content-Type の順で見る。
  function requireAdminAction(event) {
    return reviewAuth.requireAction(event);
  }

  // 自動処理用の読み取り。admin-list-analytics だけが使う。
  function basicReadAllowed(event, authorization) {
    if (event.httpMethod !== 'GET') return false;
    // プレビューでは自動処理の ID・パスワードを使えない。
    if (env.CONTEXT && env.CONTEXT !== 'production') return false;
    // 動いている関数には CONTEXT が入らない見込みなので、宛先の住所でも本番だけに限る。
    // host が無い・重複・本番以外なら通さない（singleHeader は重複を null にする）。
    if (singleHeader(event, 'host') !== PRODUCTION_HOST) return false;
    if (event.rawUrl !== undefined && event.rawUrl !== null) {
      let origin;
      try { origin = new URL(event.rawUrl).origin; } catch { return false; }
      if (origin !== PRODUCTION_ORIGIN) return false;
    }
    const expectedUser = env.ADMIN_BASIC_USER;
    const expectedPass = env.ADMIN_BASIC_PASS;
    if (typeof expectedUser !== 'string' || expectedUser === '') return false;
    if (typeof expectedPass !== 'string' || expectedPass === '') return false;
    const decoded = decodeBasic(authorization);
    if (!decoded) return false;
    // 片方が違っても両方の比較を行い、比べた時間から当たりを絞らせない。
    const idMatches = crypto.timingSafeEqual(sha256(decoded.id), sha256(expectedUser));
    const passwordMatches = crypto.timingSafeEqual(sha256(decoded.password), sha256(expectedPass));
    return idMatches && passwordMatches;
  }

  async function requireAnalyticsRead(event) {
    const session = reviewAuth.requireSession(event);
    if (!session.response) return session;

    // 重複した Authorization は singleHeader が null にして、ここへ来ない。
    const authorization = singleHeader(event, 'authorization');
    if (typeof authorization !== 'string' || !authorization.startsWith('Basic ')) return session;

    if (basicReadAllowed(event, authorization)) {
      reviewAuth.audit(event, '自動処理の読み取り');
      return { basic: true };
    }
    // 失敗は 1 秒待つ。応答にブラウザの認証の小窓を出すヘッダは付けない。
    await sleep(1000);
    reviewAuth.audit(event, '自動処理の読み取りの失敗');
    return { response: { statusCode: 401, headers: { ...jsonHeaders }, body: JSON.stringify({ error: '認証に失敗しました' }) } };
  }

  return { requireAdminPage, requireAdminRead, requireAdminAction, requireAnalyticsRead };
}

const adminAuth = createAdminAuth();

module.exports = {
  createAdminAuth,
  requireAdminPage: adminAuth.requireAdminPage,
  requireAdminRead: adminAuth.requireAdminRead,
  requireAdminAction: adminAuth.requireAdminAction,
  requireAnalyticsRead: adminAuth.requireAnalyticsRead,
};
