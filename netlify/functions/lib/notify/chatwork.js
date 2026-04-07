'use strict';

/**
 * Chatwork 通知プロバイダ（Netlify Functions 用）
 *
 * Netlify 環境変数:
 *   CHATWORK_API_TOKEN  — Chatwork API トークン
 *   CHATWORK_ROOM_ID    — 投稿先ルーム ID
 */

const API_BASE = 'https://api.chatwork.com/v2';

/**
 * @param {{ subject: string, body: string }} message
 */
async function send(message) {
  const token  = process.env.CHATWORK_API_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;

  if (!token || !roomId) {
    throw new Error(
      'Chatwork 通知に必要な環境変数が未設定です。' +
      'CHATWORK_API_TOKEN と CHATWORK_ROOM_ID を Netlify に設定してください。'
    );
  }

  const body = `[info][title]${message.subject}[/title]${message.body}[/info]`;

  const url = `${API_BASE}/rooms/${roomId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': token,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `body=${encodeURIComponent(body)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chatwork API ${res.status}: ${text}`);
  }

  return res.json();
}

module.exports = { send };
