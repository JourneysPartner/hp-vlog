'use strict';

const { getFile, putFile, updateFrontmatter, nowJST } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-approve — 「このまま公開」操作
 *
 * POST /.netlify/functions/review-approve
 * Body: { filename, publish_at }
 *
 * 処理:
 * 1. GitHub API で対象記事を取得
 * 2. review_status → "approved", approved_at → now, publish_at → 指定値
 * 3. GitHub API で書き戻し
 */

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

    const now = nowJST();
    const updates = {
      review_status: 'approved',
      approved_at: now,
      updated_at: now,
    };
    if (publish_at) {
      updates.publish_at = publish_at.includes('+') ? publish_at : publish_at + '+09:00';
    }

    const updated = updateFrontmatter(content, updates);
    const result = await putFile(filepath, updated, sha, `review: approve ${filename}`, ref || undefined);

    // 通知（非致命的）
    const baseUrl = process.env.SITE_BASE_URL || 'https://mori-zeirishi.net';
    const reviewQuery = ref ? `file=${filename}&ref=${encodeURIComponent(ref)}` : `file=${filename}`;
    sendNotification('approved', {
      title: '',
      filename,
      reviewUrl: `${baseUrl}/review?${reviewQuery}`,
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `承認しました: ${filename}`,
        action: 'approve',
        filename,
        publish_at: updates.publish_at || null,
        commit_sha: result.commit?.sha || null,
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
