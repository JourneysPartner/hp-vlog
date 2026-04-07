'use strict';

const { getFile, putFile, updateFrontmatter, nowJST } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-skip — 「今回は見送り」操作
 *
 * POST /.netlify/functions/review-skip
 * Body: { filename }
 *
 * 処理:
 * 1. GitHub API で対象記事を取得
 * 2. review_status → "skipped"
 * 3. GitHub API で書き戻し
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { filename, ref } = JSON.parse(event.body || '{}');

    if (!filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'filename は必須です' }) };
    }

    const filepath = `content/posts/${filename}`;
    const { content, sha } = await getFile(filepath, ref || undefined);

    const now = nowJST();
    const updated = updateFrontmatter(content, {
      review_status: 'skipped',
      updated_at: now,
    });

    const result = await putFile(filepath, updated, sha, `review: skip ${filename}`, ref || undefined);

    // 通知（非致命的）
    sendNotification('skipped', {
      title: '',
      filename,
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `見送りにしました: ${filename}`,
        action: 'skip',
        filename,
        commit_sha: result.commit?.sha || null,
      }),
    };
  } catch (err) {
    console.error('[review-skip] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
