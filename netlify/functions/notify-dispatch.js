'use strict';

const { sendNotification } = require('./lib/notify');

/**
 * notify-dispatch — 外部（GitHub Actions 等）からの通知受付エンドポイント
 *
 * POST /.netlify/functions/notify-dispatch
 * Headers:
 *   X-Webhook-Secret: <NOTIFY_WEBHOOK_SECRET>
 * Body (JSON):
 *   { event, title, summary, persona, category, reviewUrl, prUrl, comment, publicUrl, filename }
 *
 * 認証:
 *   NOTIFY_WEBHOOK_SECRET 環境変数と X-Webhook-Secret ヘッダを照合する。
 *   一致しない場合は 401 を返す。
 */

function verifySecret(event) {
  const expected = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!expected) {
    // secret 未設定 = 認証なし（開発時のみ許容、本番では設定必須）
    console.warn('[notify-dispatch] NOTIFY_WEBHOOK_SECRET 未設定 — 認証をスキップ');
    return true;
  }
  const provided = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'] || '';
  return provided === expected;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!verifySecret(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: '認証に失敗しました' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const notifyEvent = body.event || 'draft_created';

    if (!body.title && !body.filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'title または filename は必須です' }) };
    }

    await sendNotification(notifyEvent, {
      title:     body.title     || '',
      summary:   body.summary   || '',
      persona:   body.persona   || '',
      category:  body.category  || '',
      reviewUrl: body.reviewUrl || '',
      prUrl:     body.prUrl     || '',
      comment:   body.comment   || '',
      publicUrl: body.publicUrl || '',
      filename:  body.filename  || '',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '通知を送信しました', event: notifyEvent }),
    };
  } catch (err) {
    console.error('[notify-dispatch] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
