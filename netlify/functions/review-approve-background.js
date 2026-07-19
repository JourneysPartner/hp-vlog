'use strict';

const { getFile, putFile, updateFrontmatter, nowJST, findPR, waitForMergeable, mergePR, findApprovedArticlesForDate } = require('./lib/github-api');
const { sendNotification } = require('./lib/notify');
const { parseFrontmatterMeta, evaluateSourceGuard } = require('../../scripts/lib/source-guard');

function approvalSourceGuard(content) {
  return evaluateSourceGuard(parseFrontmatterMeta(content), { stage: 'approve' });
}

exports.approvalSourceGuard = approvalSourceGuard;

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

// 翌日の公開時刻を返す（公開枠に応じた時刻）
//
// publish_at に 0〜50 分のランダムジッタを乗せて、サイト上の表示時刻を散らす
// （機械的に見えないようにする）。
//   morning: JST 11:05〜11:55
//   evening: JST 17:05〜17:55
//
// scheduler-publish 系の cron は publish_at 窓の末尾より後（12:00 / 18:00 JST）に
// 設定してあるため、ジッタを乗せた publish_at が 11:55 でも次の起動で確実に拾える。
// 既存の publish-due.js の `publish_at <= now` ロジックには手を入れない。
//
// なぜ GitHub Actions の sleep ではなくここでジッタを乗せるか:
//   PR #224 で GitHub Actions 内の sleep を削除し月 1,900 分を削減した。
//   その代わり投稿時刻が JST 09:05 / 11:05 / 17:05 ぴったりに固定されてしまったので、
//   GitHub Actions minutes を消費しない形で publish_at だけランダム化する。
function publishAtForSlot(slot) {
  const baseHour   = slot === 'evening' ? 17 : 11;
  const baseMinute = 5;
  // 0〜50 分のジッタ → 末尾は最大 55 分
  const jitterMin  = Math.floor(Math.random() * 51);
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + 1);
  jst.setUTCHours(baseHour, baseMinute + jitterMin, 0, 0);
  return jst.toISOString().replace('Z', '+09:00');
}

// 翌日の JST 日付文字列を返す
function targetPublishDateJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + 1);
  return jst.toISOString().split('T')[0];
}

// 公開枠の決定（article_role ベース・レース非依存）。
//   本命(main)   → morning 優先（同枠が埋まっていて逆枠が空いていれば evening）
//   補強(support)→ evening 優先（同枠が埋まっていて逆枠が空いていれば morning）
// これにより本命+補強を短時間に承認しても、レースで両方 morning になって
// 同時公開されることがなくなり、ペアは必ず別枠に分かれる。
function decidePublishSlot(role, hasMorning, hasEvening) {
  if (role === 'support') return (hasEvening && !hasMorning) ? 'morning' : 'evening';
  return (hasMorning && !hasEvening) ? 'evening' : 'morning';
}

exports.decidePublishSlot = decidePublishSlot;

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

    const sourceGuard = approvalSourceGuard(content);
    if (sourceGuard.blocked) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Source review is required before approval.',
          blocked: true,
          reasons: sourceGuard.reasons,
        }),
      };
    }

    // frontmatter から記事情報を抽出
    const fmTitle    = (content.match(/^title:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmSlug     = (content.match(/^slug:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmCategory = (content.match(/^category:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmPersona  = (content.match(/^primary_persona:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmRole     = (content.match(/^article_role:\s*"?([^"\n\r]+)"?/m) || [])[1] || 'main';

    // ── 品質ゲート（承認前チェック）─────────────────────────────
    // recommendation / 適合スコアが低い記事は承認を拒否する（400）。
    // スコア未設定のレガシー記事は従来どおり承認可（既存運用を壊さない）。
    const fmStr = (re) => (content.match(re) || [])[1];
    const fmNum = (re) => { const v = fmStr(re); const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    const recommendation = fmStr(/^recommendation:\s*"?([^"\n\r]+)"?/m);
    if (recommendation) {
      const scores = {
        customer_fit_score:     fmNum(/^customer_fit_score:\s*"?(\d+)"?/m),
        search_intent_score:    fmNum(/^search_intent_score:\s*"?(\d+)"?/m),
        source_alignment_score: fmNum(/^source_alignment_score:\s*"?(\d+)"?/m),
      };
      const reviewWarning = fmStr(/^review_warning:\s*"?([^"\n\r]*)"?/m) || '';
      const reasons = [];
      if (recommendation === 'reject') reasons.push('recommendation が reject です');
      if (recommendation === 'revise') reasons.push('recommendation が revise です');
      if (scores.customer_fit_score != null && scores.customer_fit_score <= 3) reasons.push(`顧客適合スコアが低い (${scores.customer_fit_score}/5)`);
      if (scores.search_intent_score != null && scores.search_intent_score <= 3) reasons.push(`検索意図スコアが低い (${scores.search_intent_score}/5)`);
      if (scores.source_alignment_score != null && scores.source_alignment_score <= 3) reasons.push(`出典一致スコアが低い (${scores.source_alignment_score}/5)`);
      if (reasons.length > 0) {
        console.warn(`[review-approve] 承認拒否(品質ゲート): ${filename} — ${reasons.join(' / ')}`);
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'この記事は品質ゲートにより承認できません。差し戻して内容・出典・タイトルを見直してください。',
            blocked: true,
            recommendation,
            scores,
            reasons,
            review_warning: reviewWarning,
          }),
        };
      }
    }

    const now = nowJST();

    // 公開枠の決定: article_role ベース（本命=morning / 補強=evening）
    let publishAt;
    let publishSlot;

    if (publish_at) {
      publishAt = publish_at;
      publishSlot = 'morning';
    } else {
      const targetDate = targetPublishDateJST();
      const otherApproved = await findApprovedArticlesForDate(targetDate, filename);
      const hasMorning = otherApproved.some(a => a.slot === 'morning');
      const hasEvening = otherApproved.some(a => a.slot === 'evening');
      // 「同日の承認状況」だけで枠を決めると、本命+補強を短時間に承認したとき、
      // 2本目の枠判定が1本目の main 反映前に走り、両方 morning になって同時公開
      // される（レース）。role ベースにすればレースの影響を受けず、ペアは必ず別枠。
      //   本命(main)   → morning 優先
      //   補強(support)→ evening 優先
      // 逆枠が空いていて同枠が既に埋まっていれば、軽くバランスを取って逆へ回す。
      publishSlot = decidePublishSlot(fmRole, hasMorning, hasEvening);
      publishAt = publishAtForSlot(publishSlot);
      console.log(`[review-approve] 公開枠: ${publishSlot} (role=${fmRole}, 同日 approved: ${otherApproved.length} 件, morning=${hasMorning}, evening=${hasEvening})`);
    }
    if (publishAt && !publishAt.includes('+')) publishAt += '+09:00';

    const updates = {
      review_status: 'approved',
      approved_at: now,
      publish_at: publishAt,
      publish_slot: publishSlot,
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

    // 通知: マージ成功時は approved（公開予約完了）、失敗時のみ merge_failed
    // 実際の公開完了通知 (published) は publish-scheduled ワークフローが送る。
    try {
      if (mergeError || (ref && !mergeResult)) {
        await sendNotification('merge_failed', {
          title: fmTitle,
          filename,
        });
      } else {
        await sendNotification('approved', {
          title: fmTitle,
          filename,
          publishAt,
          publishSlot,
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
