'use strict';

const { getFile, putFile, updateFrontmatter, nowJST } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-revise — 「差し戻し（修正コメント付き）」操作
 *
 * POST /.netlify/functions/review-revise
 * Body: { filename, comment }
 *
 * 処理:
 * 1. GitHub API で対象記事を取得
 * 2. review_status → "needs_revision", review_comment → comment
 * 3. GitHub API で書き戻し
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { filename, comment } = JSON.parse(event.body || '{}');

    if (!filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'filename は必須です' }) };
    }
    if (!comment || !comment.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: '修正コメントは必須です' }) };
    }

    const filepath = `content/posts/${filename}`;
    const { content, sha } = await getFile(filepath);

    const now = nowJST();
    const updated = updateFrontmatter(content, {
      review_status: 'needs_revision',
      review_comment: comment.trim(),
      updated_at: now,
    });

    const result = await putFile(filepath, updated, sha, `review: revise ${filename}`);

    // 通知（非致命的）
    const baseUrl = process.env.SITE_BASE_URL || 'https://mori-zeirishi.net';
    sendNotification('revised', {
      title: '',
      filename,
      comment: comment.trim(),
      reviewUrl: `${baseUrl}/review?file=${filename}`,
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `差し戻しました: ${filename}`,
        action: 'revise',
        filename,
        comment: comment.trim(),
        commit_sha: result.commit?.sha || null,
      }),
    };
  } catch (err) {
    console.error('[review-revise] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
