'use strict';

const githubApi = require('./lib/github-api');
const manualEdit = require('./lib/manual-edit');
const reviewAuth = require('./lib/review-auth');
const notify = require('./lib/notify');
const denylistStore = require('./lib/denylist-store');
const { buildEntriesFromContext } = require('../../scripts/lib/denylist');

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

async function handler(event, injected = {}) {
  const getFile = injected.getFile || githubApi.getFile;
  const putFile = injected.putFile || githubApi.putFile;
  const updateFrontmatter = injected.updateFrontmatter || githubApi.updateFrontmatter;
  const nowJST = injected.nowJST || githubApi.nowJST;
  const findPR = injected.findPR || githubApi.findPR;
  const closePR = injected.closePR || githubApi.closePR;
  const commentOnPR = injected.commentOnPR || githubApi.commentOnPR;
  const deleteBranch = injected.deleteBranch || githubApi.deleteBranch;
  const listPRFiles = injected.listPRFiles || githubApi.listPRFiles;
  const compareCommits = injected.compareCommits || githubApi.compareCommits;
  const extractFmField = injected.extractFmField || githubApi.extractFmField;
  const readjustPublishSlots = injected.readjustPublishSlots || githubApi.readjustPublishSlots;
  const appendEntries = injected.appendEntries || denylistStore.appendEntries;
  const sendNotification = injected.sendNotification || notify.sendNotification;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = reviewAuth.requireAction(event);
  if (auth.response) return auth.response;

  try {
    const { filename, ref, suppress_topic } = JSON.parse(event.body || '{}');

    if (!filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'filename は必須です' }) };
    }

    // ── 形が正しくない edit/ の枝 ──────────────────────────────────
    // 記事のファイルにも denylist にも書かず、PR も閉じない。
    if (manualEdit.isEditRefShape(ref) && !manualEdit.isManualEditRef(ref)) {
      try {
        await sendNotification('edit_unsupported', {
          title: filename,
          comment: '手直しの枝の名前の形が正しくありません。',
        });
      } catch (_) { console.error('[review-skip] 扱えない枝の通知に失敗しました'); }
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: '手直しの枝の名前の形が正しくありません。' }),
      };
    }

    const filepath = `content/posts/${filename}`;
    const { content, sha } = await getFile(filepath, ref || undefined);

    // frontmatter からタイトル + denylist 用メタを取得
    const fmTitle = (content.match(/^title:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';

    // ── 公開中の記事の手直し PR ────────────────────────────────────
    // 記事のファイル・denylist・公開枠には何も書かず、PR を閉じてコメントを残す。
    // 枝は消さない（deleteBranch は draft/* だけ）。
    if (manualEdit.isManualEditRef(ref)) {
      // PR が開いていることと枝の名前の形だけは必ず確かめる。
      let check = null;
      try {
        check = await manualEdit.checkManualEditPR({
          filename, ref, findPR, listPRFiles, getFile, compareCommits,
        });
      } catch (_) { check = null; }
      const editPR = check && check.pr ? check.pr : null;
      const editContent = check && check.branchFile ? check.branchFile.content : content;
      const editTitle = (editContent.match(/^title:\s*"?([^"\n\r]+)"?/m) || [])[1] || fmTitle || filename;
      const skipFailed = async (reason, statusCode = 502) => {
        try {
          await sendNotification('edit_skip_failed', {
            title: editTitle, filename, comment: reason,
            ...(editPR && editPR.html_url ? { prUrl: editPR.html_url } : {}),
          });
        } catch (_) { console.error('[review-skip] 手直しの見送り失敗通知に失敗しました'); }
        return {
          statusCode,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: reason }),
        };
      };
      if (!editPR) {
        return skipFailed('手直しの PR が見つかりません。見送りできませんでした。', 409);
      }
      try {
        await commentOnPR(editPR.number, '承認画面から見送り');
      } catch (e) {
        console.error(`[review-skip] 手直し PR へのコメント失敗: ${e.message}`);
        return skipFailed('PR に見送りを伝えられませんでした。しばらくしてからもう一度お試しください。');
      }
      try {
        await closePR(editPR.number);
      } catch (e) {
        console.error(`[review-skip] 手直し PR のクローズ失敗: ${e.message}`);
        return skipFailed('PR を閉じられませんでした。しばらくしてからもう一度お試しください。');
      }
      try {
        await sendNotification('edit_skipped', {
          title: editTitle,
          ...(editPR.html_url ? { prUrl: editPR.html_url } : {}),
        });
      } catch (e) { console.error(`[review-skip] 手直しの見送り通知失敗: ${e.message}`); }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `見送りにしました: ${editTitle}`,
          action: 'skip',
          filename,
        }),
      };
    }

    const fmExisting = {};
    for (const line of (content.match(/^---[\s\S]+?---/) || [''])[0].split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_]+):\s*"?(.*?)"?\s*$/);
      if (m) fmExisting[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }

    // suppress_topic フラグがあれば denylist にも登録
    let denylistAdded = [];
    if (suppress_topic === true) {
      const newEntries = buildEntriesFromContext(fmExisting, '見送り時にチェック', 'review_skip');
      try {
        const result = await appendEntries(newEntries,
          `denylist: review-skip ${filename}（このテーマを今後生成しない指定）`);
        denylistAdded = result.added || [];
        if (denylistAdded.length > 0) {
          console.log(`[review-skip] denylist に ${denylistAdded.length} 件追加: ${denylistAdded.map(e => e.type + '=' + e.value).join(', ')}`);
        }
      } catch (e) {
        console.error(`[review-skip] denylist 更新失敗（処理は続行）: ${e.message}`);
      }
    }

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
      if (ref.startsWith('draft/refresh-')) {
        try {
          await deleteBranch(ref);
          console.log('[review-skip] 更新案ブランチを削除しました');
        } catch (_) {
          console.error('[review-skip] 更新案ブランチの削除に失敗しました');
        }
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

    const suppressionMsg = denylistAdded.length > 0
      ? `\n※このテーマは今後生成しない設定に登録しました（denylist に ${denylistAdded.length} 件追加）。`
      : '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `見送りにしました: ${fmTitle || filename}${suppressionMsg}`,
        action: 'skip',
        filename,
        denylistAdded: denylistAdded.map(e => ({ type: e.type, value: e.value })),
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
}

exports.handler = event => handler(event);
exports._handler = handler;
