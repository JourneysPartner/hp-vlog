'use strict';

/**
 * LINE WORKS 通知プロバイダ（スタブ — Netlify Functions 用）
 *
 * 将来実装時に必要な Netlify 環境変数（想定）:
 *   LINEWORKS_BOT_ID        — Bot ID
 *   LINEWORKS_CHANNEL_ID    — 送信先チャンネル / トークルーム ID
 *   LINEWORKS_CLIENT_ID     — OAuth Client ID
 *   LINEWORKS_CLIENT_SECRET — OAuth Client Secret
 *   LINEWORKS_SERVICE_ACCOUNT — Service Account
 *   LINEWORKS_PRIVATE_KEY   — JWT 署名用秘密鍵
 */

async function send(message) {
  throw new Error(
    'LINE WORKS プロバイダは未実装です。' +
    'NOTIFY_PROVIDER=chatwork を使用するか、lineworks.js を実装してください。'
  );
}

module.exports = { send };
