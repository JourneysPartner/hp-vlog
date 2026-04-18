'use strict';

/**
 * 通知送信スクリプト（CLI → Netlify エンドポイント経由）
 *
 * GitHub Actions から呼ぶ。Chatwork API は直接叩かず、
 * Netlify の notify-dispatch Function に中継する。
 *
 * 使い方:
 *   node scripts/notify.js --event draft_created \
 *     --title "記事タイトル" \
 *     --summary "記事の概要" \
 *     --persona "eBay輸出セラー" \
 *     --category "消費税" \
 *     --review-url "https://..." \
 *     --pr-url "https://..."
 *
 * 環境変数:
 *   NETLIFY_NOTIFY_URL    — Netlify 通知エンドポイント URL
 *   NOTIFY_WEBHOOK_SECRET — 認証用シークレット
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--event':      opts.event     = args[++i]; break;
      case '--title':      opts.title     = args[++i]; break;
      case '--summary':    opts.summary   = args[++i]; break;
      case '--persona':    opts.persona   = args[++i]; break;
      case '--category':   opts.category  = args[++i]; break;
      case '--review-url': opts.reviewUrl = args[++i]; break;
      case '--pr-url':     opts.prUrl     = args[++i]; break;
      case '--comment':      opts.comment     = args[++i]; break;
      case '--public-url':   opts.publicUrl   = args[++i]; break;
      case '--article-type': opts.articleType = args[++i]; break;
      case '--article-role': opts.articleRole = args[++i]; break;
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  if (!opts.title) {
    console.error('[notify] --title は必須です');
    process.exit(1);
  }

  const url    = process.env.NETLIFY_NOTIFY_URL;
  const secret = process.env.NOTIFY_WEBHOOK_SECRET || '';

  if (!url) {
    console.warn('[notify] NETLIFY_NOTIFY_URL が未設定です — 通知をスキップ');
    return;
  }

  const payload = {
    event:     opts.event     || 'draft_created',
    title:     opts.title,
    summary:   opts.summary   || '',
    persona:   opts.persona   || '',
    category:  opts.category  || '',
    reviewUrl: opts.reviewUrl || '',
    prUrl:     opts.prUrl     || '',
    comment:     opts.comment     || '',
    publicUrl:   opts.publicUrl   || '',
    articleType: opts.articleType || '',
    articleRole: opts.articleRole || '',
  };

  console.log(`[notify] Netlify notify-dispatch に送信: event=${payload.event}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': secret,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[notify] Netlify 応答 ${res.status}: ${text}`);
  } else {
    const data = await res.json();
    console.log(`[notify] 送信完了: ${data.message || 'OK'}`);
  }
}

main().catch(err => {
  console.error(`[notify] エラー: ${err.message}`);
  // 通知失敗で CI を止めない
  process.exit(0);
});
