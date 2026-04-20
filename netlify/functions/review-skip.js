'use strict';

const { getFile, putFile, updateFrontmatter, nowJST, findPR, closePR, extractFmField, readjustPublishSlots } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-skip — 「今回は見送り」操作（PR自動クローズ付き）
 *
 * POST /.netlify/functions/review-skip
 * Body: { filename, ref? }
 *
 * 処理:
 * 1. review_status → skipped
 * 2. PR を自動クローズ
 * 3. Chatwork に見送り完了通知
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

    // frontmatter からタイトルを取得
    const fmTitle = (content.match(/^title:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';

    const now = nowJST();
    const updated = updateFrontmatter(content, {
      review_status: 'skipped',
      updated_at: now,
    });

    await putFile(filepath, updated, sha, `review: skip ${filename}`, ref || undefined);

    // PR 自動クローズ
    if (ref) {
      try {
        const pr = await findPR(ref);
        if (pr) {
          await closePR(pr.number);
          console.log(`[review-skip] PR #${pr.number} をクローズしました`);
        }
      } catch (closeErr) {
        console.error(`[review-skip] PR クローズ失敗: ${closeErr.message}`);
      }
    }

    // 公開枠の再調整: 承認済み記事が1本だけ残った場合 evening→morning
    const origStatus = extractFmField(content, 'review_status');
    const origPublishAt = extractFmField(content, 'publish_at');
    let readjusted = null;
    if (origStatus === 'approved' && origPublishAt) {
      try {
        readjusted = await readjustPublishSlots(origPublishAt, filename);
        if (readjusted) {
          console.log(`[review-skip] 公開枠を再調整: ${readjusted.filename} → morning`);
        }
      } catch (e) {
        console.error(`[review-skip] 公開枠再調整失敗: ${e.message}`);
      }
    }

    // 見送り完了通知（await して Lambda 終了前に必ず送信完了させる）
    try {
      await sendNotification('skipped', { title: fmTitle, filename });
    } catch (notifyErr) {
      console.error(`[review-skip] 通知送信失敗: ${notifyErr.message}`);
    }

    // 公開枠再調整通知
    if (readjusted) {
      try {
        await sendNotification('slot_readjusted', {
          title: readjusted.title,
          publishAt: readjusted.publishAt,
        });
      } catch (e) {
        console.error(`[review-skip] 再調整通知失敗: ${e.message}`);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `見送りにしました: ${fmTitle || filename}`,
        action: 'skip',
        filename,
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
