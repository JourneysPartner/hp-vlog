'use strict';

/**
 * 管理画面・管理APIの HTTP Basic 認証ガード。
 *
 * 環境変数:
 *   ADMIN_BASIC_USER — 管理者ID
 *   ADMIN_BASIC_PASS — 管理者パスワード
 *
 * 全ての管理系 Netlify Function（HTML/API共通）で必ず requireBasicAuth(event) を呼ぶこと。
 * 認証失敗時は 401 を返し、ブラウザに認証ダイアログを促すため WWW-Authenticate ヘッダを付与する。
 *
 * セキュリティ上の注意:
 *   - 比較は constant-time（タイミング攻撃対策）
 *   - パスワードはコードに直書きしない
 *   - 失敗時のログには平文を出力しない
 *   - ADMIN_BASIC_USER / ADMIN_BASIC_PASS が未設定の場合は安全側に倒して 503 を返す
 */

const crypto = require('crypto');

// constant-time に等しいか比較（タイミング攻撃対策）
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // 長さ自体は分かるが、ここで早期 return しても致命的ではない
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function unauthorizedResponse() {
  return {
    statusCode: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="mori-tax admin", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
    body: '401 Unauthorized\n認証が必要です。',
  };
}

function misconfiguredResponse() {
  return {
    statusCode: 503,
    headers: {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
    body: '503 Service Unavailable\nADMIN_BASIC_USER / ADMIN_BASIC_PASS が未設定です。',
  };
}

/**
 * Basic 認証チェック。
 *
 * @param {Object} event - Netlify Function event
 * @returns {Object|null} 認証失敗時は HTTP response オブジェクト、成功時は null
 */
function requireBasicAuth(event) {
  const expectedUser = process.env.ADMIN_BASIC_USER;
  const expectedPass = process.env.ADMIN_BASIC_PASS;

  if (!expectedUser || !expectedPass) {
    console.error('[admin-auth] ADMIN_BASIC_USER または ADMIN_BASIC_PASS が未設定');
    return misconfiguredResponse();
  }

  const headers = event.headers || {};
  // Netlify は HTTP ヘッダ名を lower-case で渡す
  const authHeader = headers.authorization || headers.Authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return unauthorizedResponse();
  }

  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return unauthorizedResponse();
  }

  const idx = decoded.indexOf(':');
  if (idx < 0) return unauthorizedResponse();

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  // 平文ログ禁止: user 名のみ最初の 1 文字 + マスクで残す
  const userMasked = user ? user[0] + '***' : '(empty)';

  if (!safeEqual(user, expectedUser) || !safeEqual(pass, expectedPass)) {
    console.warn(`[admin-auth] 認証失敗 user=${userMasked}`);
    return unauthorizedResponse();
  }

  return null;
}

module.exports = { requireBasicAuth };
