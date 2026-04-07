'use strict';

const { getFile, putFile, updateFrontmatter, nowJST, findPR, mergePR } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-approve — 「このまま公開」操作（完全自動）
 *
 * POST /.netlify/functions/review-approve
 * Body: { filename, publish_at?, ref? }
 *
 * 処理:
 * 1. frontmatter を approved + published に更新
 * 2. publish_at を自動設定（未指定なら翌日 11:30 JST）
 * 3. PR を自動マージ
 * 4. 公開完了通知を送信
 */

// 翌日 11:30 JST を返す
function defaultPublishAt() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setDate(jst.getDate() + 1);
  jst.setHours(11, 30, 0, 0);
  return jst.toISOString().replace(/\.\d{3}Z$/, '+09:00');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { filename, publish_at, ref } = JSON.parse(event.body || '{}');

    if (!filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'filename は必須です' }) };
    }

    const filepath = `content/posts/${filename}`;
    const { content, sha } = await getFile(filepath, ref || undefined);

    // frontmatter から記事情報を抽出
    const fmTitle    = (content.match(/^title:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmSlug     = (content.match(/^slug:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmCategory = (content.match(/^category:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmPersona  = (content.match(/^primary_persona:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';

    const now = nowJST();

    // publish_at: ユーザー指定 > 自動設定（翌日 11:30 JST）
    let publishAt = publish_at || defaultPublishAt();
    if (publishAt && !publishAt.includes('+')) publishAt += '+09:00';

    const updates = {
      review_status: 'published',
      approved_at: now,
      publish_at: publishAt,
      published_at: now,
      updated_at: now,
    };

    const updated = updateFrontmatter(content, updates);
    await putFile(filepath, updated, sha, `publish: ${fmTitle || filename}`, ref || undefined);

    // PR 自動マージ
    const baseUrl = process.env.SITE_BASE_URL || 'https://mori-zeirishi.net';
    let mergeResult = null;
    if (ref) {
      try {
        const pr = await findPR(ref);
        if (pr) {
          mergeResult = await mergePR(pr.number, `publish: ${fmTitle || filename}`);
          console.log(`[review-approve] PR #${pr.number} をマージしました`);
        } else {
          console.warn('[review-approve] 対象 PR が見つかりません');
        }
      } catch (mergeErr) {
        console.error(`[review-approve] PR マージ失敗: ${mergeErr.message}`);
        sendNotification('merge_failed', {
          title: fmTitle,
          filename,
        }).catch(() => {});
      }
    }

    // 公開完了通知
    sendNotification('published', {
      title: fmTitle,
      publicUrl: fmSlug ? `${baseUrl}/blog/${fmSlug}/` : '',
      category: fmCategory,
      persona: fmPersona,
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `公開処理を完了しました: ${fmTitle || filename}`,
        action: 'approve',
        filename,
        publish_at: publishAt,
        merged: !!mergeResult,
      }),
    };
  } catch (err) {
    console.error('[review-approve] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
