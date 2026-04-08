'use strict';

const { getFile, putFile, updateFrontmatter, nowJST, findPR, waitForMergeable, mergePR } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');

/**
 * review-approve-background — 「このまま公開」操作（完全自動 / バックグラウンド実行）
 *
 * Netlify Background Function: 関数名末尾の `-background` により最大15分まで実行可能。
 * 呼び出し元には 202 Accepted を即返し、後続処理は非同期で進む。
 * これにより mergeable 確定待ち + merge リトライを 10s 制限なしで実行できる。
 *
 * POST /.netlify/functions/review-approve-background
 * Body: { filename, publish_at?, ref? }
 *
 * 処理:
 * 1. frontmatter を approved + published に更新
 * 2. publish_at を自動設定（未指定なら翌日 11:30 JST）
 * 3. PR の mergeable 状態が確定するまで待機（waitForMergeable）
 * 4. PR を自動マージ（mergePR は 405/409/502/503 に対しリトライ）
 * 5. 成功時のみ published、失敗時のみ merge_failed を Chatwork に通知
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
    // - findPR → waitForMergeable で mergeable 確定を待ってから merge
    // - 成功時のみ published 通知、失敗時は merge_failed 通知（両方は送らない）
    const baseUrl = process.env.SITE_BASE_URL || 'https://mori-zeirishi.net';
    let mergeResult = null;
    let mergeError = null;
    if (ref) {
      try {
        const pr = await findPR(ref);
        if (!pr) {
          throw new Error(`対象 PR が見つかりません (head=${ref})`);
        }
        console.log(`[review-approve] PR #${pr.number} 検出 → mergeable 確定待ち`);

        // GitHub の mergeable 計算が落ち着くまで待つ
        // 直前の putFile で sha が更新されているため、push 直後と同じく
        // mergeable=null になりやすい。長めに待つ。
        const stable = await waitForMergeable(pr.number, { maxAttempts: 12, intervalMs: 2000 });
        console.log(`[review-approve] PR #${pr.number} 状態: mergeable=${stable && stable.mergeable} state=${stable && stable.mergeable_state}`);

        // mergePR 内部でも 405/409/502/503 に対し最大 4 回リトライ
        mergeResult = await mergePR(pr.number, `publish: ${fmTitle || filename}`);
        console.log(`[review-approve] PR #${pr.number} をマージしました`);
      } catch (mergeErr) {
        mergeError = mergeErr;
        console.error(`[review-approve] PR マージ失敗: ${mergeErr.message}`);
      }
    }

    // 通知: マージ成功時のみ published、失敗時のみ merge_failed
    try {
      if (mergeError || (ref && !mergeResult)) {
        await sendNotification('merge_failed', {
          title: fmTitle,
          filename,
        });
      } else {
        await sendNotification('published', {
          title: fmTitle,
          publicUrl: fmSlug ? `${baseUrl}/blog/${fmSlug}/` : '',
          category: fmCategory,
          persona: fmPersona,
        });
      }
    } catch (notifyErr) {
      console.error(`[review-approve] 通知送信失敗: ${notifyErr.message}`);
    }

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
