'use strict';

const { getFile, putFile, updateFrontmatter, nowJST, triggerWorkflow, findPR, commentOnPR } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-revise — 「差し戻し」操作（自動再生成付き）
 *
 * POST /.netlify/functions/review-revise
 * Body: { filename, comment, ref? }
 *
 * 処理:
 * 1. review_status → needs_revision, review_comment → comment
 * 2. GitHub Actions の regenerate-draft ワークフローを起動
 * 3. 再生成ジョブが完了したら Chatwork に通知が届く
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { filename, comment, ref } = JSON.parse(event.body || '{}');

    if (!filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'filename は必須です' }) };
    }
    if (!comment || !comment.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: '修正コメントは必須です' }) };
    }

    const filepath = `content/posts/${filename}`;
    const { content, sha } = await getFile(filepath, ref || undefined);

    const now = nowJST();
    const updated = updateFrontmatter(content, {
      review_status: 'needs_revision',
      review_comment: comment.trim(),
      updated_at: now,
    });

    await putFile(filepath, updated, sha, `review: revise ${filename}`, ref || undefined);

    // PR にコメントを残す（非致命的）
    if (ref) {
      try {
        const pr = await findPR(ref);
        if (pr) {
          await commentOnPR(pr.number, `📝 差し戻しコメント:\n\n${comment.trim()}\n\n自動再生成を開始します。`);
        }
      } catch (e) {
        console.warn(`[review-revise] PR コメント失敗: ${e.message}`);
      }
    }

    // GitHub Actions で再生成ジョブを起動
    const branch = ref || 'main';
    try {
      await triggerWorkflow('regenerate-draft.yml', 'main', {
        filename,
        branch,
        comment: comment.trim(),
      });
      console.log(`[review-revise] regenerate-draft ワークフローを起動しました`);
    } catch (dispatchErr) {
      console.error(`[review-revise] ワークフロー起動失敗: ${dispatchErr.message}`);
      // 起動失敗時は通知で知らせる
      try {
        await sendNotification('regenerate_failed', {
          title: '',
          filename,
          comment: comment.trim(),
        });
      } catch (e) {
        console.error(`[review-revise] regenerate_failed 通知失敗: ${e.message}`);
      }
    }

    // 差し戻し受付通知（await して Lambda 終了前に必ず送信完了させる）
    const baseUrl = process.env.SITE_BASE_URL || 'https://mori-zeirishi.net';
    const reviewQuery = ref ? `file=${filename}&ref=${encodeURIComponent(ref)}` : `file=${filename}`;
    try {
      await sendNotification('revised', {
        title: '',
        filename,
        comment: comment.trim(),
        reviewUrl: `${baseUrl}/review?${reviewQuery}`,
      });
    } catch (notifyErr) {
      console.error(`[review-revise] 通知送信失敗: ${notifyErr.message}`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `差し戻しを受け付けました。自動再生成を開始しています。完了後に Chatwork で通知します。`,
        action: 'revise',
        filename,
        comment: comment.trim(),
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
