'use strict';

const githubApi = require('./lib/github-api');
const notify = require('./lib/notify');
const { parseFrontmatterMeta, evaluateSourceGuard } = require('../../scripts/lib/source-guard');
const { isPlaceholderTitle } = require('../../scripts/lib/draft-normalizer');
const freshnessRefresh = require('../../scripts/lib/freshness-refresh');

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

function splitArticle(raw) {
  const match = String(raw || '').match(/^(---\r?\n[\s\S]+?\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter が見つかりません');
  return { frontmatter: match[1], body: match[2] };
}

function mainStatus(raw) {
  return parseFrontmatterMeta(raw).review_status || '';
}

function refreshQualityFailure(raw, filename) {
  const meta = parseFrontmatterMeta(raw);
  const title = meta.title || filename;
  const guard = evaluateSourceGuard(meta, { stage: 'approve' });
  if (guard.blocked) return { title, reason: (guard.reasons || []).join(' / '), event: 'source_blocked' };
  if (meta.title && isPlaceholderTitle(meta.title)) {
    return { title, reason: 'タイトルが仮置きのままです（記事に合ったタイトルを付けてください）' };
  }

  if (meta.recommendation) {
    const score = key => {
      const number = Number.parseInt(meta[key], 10);
      return Number.isNaN(number) ? null : number;
    };
    const reasons = [];
    if (meta.recommendation === 'reject') reasons.push('recommendation が reject です');
    if (meta.recommendation === 'revise') reasons.push('recommendation が revise です');
    const fit = score('customer_fit_score');
    const intent = score('search_intent_score');
    const alignment = guard.alignment && typeof guard.alignment.score === 'number'
      ? guard.alignment.score
      : score('source_alignment_score');
    if (fit != null && fit <= 3) reasons.push(`顧客適合スコアが低い (${fit}/5)`);
    if (intent != null && intent <= 3) reasons.push(`検索意図スコアが低い (${intent}/5)`);
    if (alignment != null && alignment <= 3) reasons.push(`出典一致スコアが低い (${alignment}/5)`);
    if (reasons.length) return { title, reason: reasons.join(' / ') };
  }
  return null;
}

function refreshBodyOnMain(mainRaw, branchRaw) {
  const main = splitArticle(mainRaw);
  const branch = splitArticle(branchRaw);
  const newline = main.frontmatter.includes('\r\n') ? '\r\n' : '\n';
  const body = branch.body.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, newline);
  return { content: main.frontmatter + body, mainBody: main.body, branchBody: body };
}

function updateRefreshDates(raw, now) {
  const match = String(raw || '').match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter が見つかりません');
  const newline = match[1].includes('\r\n') ? '\r\n' : '\n';
  const updates = { updated_at: now, reviewed_at: now };
  const found = new Set();
  const lines = match[2].split(/(?<=\n)/).map(chunk => {
    const ending = chunk.endsWith('\r\n') ? '\r\n' : (chunk.endsWith('\n') ? '\n' : '');
    const line = ending ? chunk.slice(0, -ending.length) : chunk;
    const field = line.match(/^((updated_at|reviewed_at):[ \t]*).*$/);
    if (!field) return chunk;
    found.add(field[2]);
    return `${field[1]}"${updates[field[2]]}"${ending}`;
  });
  let frontmatterLines = lines.join('');
  for (const [key, value] of Object.entries(updates)) {
    if (found.has(key)) continue;
    if (frontmatterLines && !frontmatterLines.endsWith('\n')) frontmatterLines += newline;
    frontmatterLines += `${key}: "${value}"`;
    found.add(key);
  }
  return match[1] + frontmatterLines + match[3] + match[4];
}

function sameRefreshBody(left, right) {
  return String(left || '').normalize('NFKC').replace(/\s+/g, '')
    === String(right || '').normalize('NFKC').replace(/\s+/g, '');
}

function isShaConflict(error) {
  return /\b409\b|sha|conflict/i.test(String(error && error.message || ''));
}

async function handleRefreshApproval({
  filename, filepath, ref, branchFile, getFile, putFile, updateFrontmatter,
  nowJST, findPR, closePR, deleteBranch, sendNotification,
}) {
  let title = filename;
  const notifyFailure = async reason => {
    try { await sendNotification('refresh_approve_failed', { title, comment: reason }); }
    catch (_) { console.error('[review-approve] 更新案の失敗通知送信に失敗しました'); }
  };

  let branchMeta;
  let branchParts;
  try {
    branchMeta = parseFrontmatterMeta(branchFile.content);
    branchParts = splitArticle(branchFile.content);
  } catch (_) {
    await notifyFailure('更新案のファイルを読み取れませんでした。');
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '更新案のファイルを読み取れませんでした。' }) };
  }

  let mainFile;
  try {
    mainFile = await getFile(filepath, 'main');
  } catch (error) {
    if (/\b404\b|not found/i.test(String(error && error.message || ''))) {
      await notifyFailure('公開中の記事が見つかりません。');
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '公開中の記事が見つかりません。' }) };
    }
    throw error;
  }
  title = parseFrontmatterMeta(mainFile.content).title || filename;

  const finishAlreadyApplied = async () => {
    let existingPR = null;
    try { existingPR = await findPR(ref); }
    catch (_) { console.error('[review-approve] 処理済み更新案のPR確認に失敗しました'); }
    if (existingPR) {
      try { await closePR(existingPR.number); }
      catch (_) { console.error('[review-approve] 処理済み更新案PRのクローズに失敗しました'); }
    }
    try { await deleteBranch(existingPR && existingPR.head && existingPR.head.ref || ref); }
    catch (_) { console.error('[review-approve] 処理済み更新案ブランチの削除に失敗しました'); }
    try { await sendNotification('refresh_processed', { title, kind: 'applied' }); }
    catch (_) { console.error('[review-approve] 更新案の処理済み通知送信に失敗しました'); }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'この更新案はすでに反映済みです。', action: 'refresh_approve', filename, processed: true }),
    };
  };

  const prepareMain = raw => {
    if (mainStatus(raw) !== 'published') return { error: '公開中ではなくなった記事です。' };
    const mainMeta = parseFrontmatterMeta(raw);
    if (!mainMeta.slug || ref !== `draft/refresh-${mainMeta.slug}`) {
      return { error: '更新案の枝と記事が一致しません。' };
    }
    if (!/^[a-f0-9]{64}$/.test(String(branchMeta.refresh_base_hash || ''))) {
      return { error: '更新案の作成時の情報がありません。管理画面から作り直してください。' };
    }
    const next = refreshBodyOnMain(raw, branchFile.content);
    const mainHash = freshnessRefresh.refreshBaseHash(next.mainBody);
    if (sameRefreshBody(next.mainBody, next.branchBody)) {
      return mainHash === branchMeta.refresh_base_hash ? { noChange: true } : { processed: true };
    }
    if (mainHash !== branchMeta.refresh_base_hash) {
      return { error: '更新案の作成後に公開中の記事が変わりました。管理画面から更新案を作り直してください。' };
    }
    const quality = refreshQualityFailure(raw, filename);
    if (quality) return { error: quality.reason };
    const now = nowJST();
    return { content: updateRefreshDates(next.content, now), now };
  };

  let target = prepareMain(mainFile.content);
  if (target.processed) return finishAlreadyApplied();
  if (target.error) {
    await notifyFailure(target.error);
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: target.error }) };
  }
  if (target.noChange) {
    try { await sendNotification('refresh_approve_failed', { title, comment: '反映する変更がありません。' }); }
    catch (_) { console.error('[review-approve] 更新案の通知送信に失敗しました'); }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '反映する変更がありません。', action: 'refresh_approve', filename, noChange: true }) };
  }

  let pr;
  try { pr = await findPR(ref); }
  catch (_) {
    await notifyFailure('更新案のPRを確認できませんでした。');
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '更新案のPRを確認できませんでした。' }) };
  }
  if (!pr) {
    await notifyFailure('更新案のPRが見つかりません。');
    return { statusCode: 409, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '更新案のPRが見つかりません。' }) };
  }

  const commitMessage = `refresh: ${title} (#${pr.number})`;
  try {
    await putFile(filepath, target.content, mainFile.sha, commitMessage, 'main');
  } catch (error) {
    if (!isShaConflict(error)) throw error;
    mainFile = await getFile(filepath, 'main');
    title = parseFrontmatterMeta(mainFile.content).title || filename;
    target = prepareMain(mainFile.content);
    if (target.processed) return finishAlreadyApplied();
    if (target.error) {
      await notifyFailure(target.error);
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: target.error }) };
    }
    if (target.noChange) {
      try { await sendNotification('refresh_approve_failed', { title, comment: '反映する変更がありません。' }); }
      catch (_) { console.error('[review-approve] 更新案の通知送信に失敗しました'); }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '反映する変更がありません。', action: 'refresh_approve', filename, noChange: true }) };
    }
    try {
      await putFile(filepath, target.content, mainFile.sha, `refresh: ${title} (#${pr.number})`, 'main');
    } catch (_) {
      await notifyFailure('公開中の記事への反映に失敗しました。更新案の枝は残しています。');
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '公開中の記事への反映に失敗しました。' }) };
    }
  }

  try { await closePR(pr.number); }
  catch (_) { console.error('[review-approve] 更新案PRのクローズに失敗しました'); }
  try { await deleteBranch(pr.head && pr.head.ref ? pr.head.ref : ref); }
  catch (_) { console.error('[review-approve] 更新案ブランチの削除に失敗しました'); }

  const mainMeta = parseFrontmatterMeta(mainFile.content);
  const publicUrl = mainMeta.slug ? `https://mori-zeirishi.net/blog/${mainMeta.slug}/` : '';
  try {
    await sendNotification('refresh_published', {
      title,
      publicUrl,
      reason: branchMeta.refresh_note || '',
    });
  } catch (_) { console.error('[review-approve] 更新反映通知の送信に失敗しました'); }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `更新案を反映しました: ${title}`, action: 'refresh_approve', filename, merged: true }),
  };
}

async function handler(event, injected = {}) {
  const getFile = injected.getFile || githubApi.getFile;
  const putFile = injected.putFile || githubApi.putFile;
  const updateFrontmatter = injected.updateFrontmatter || githubApi.updateFrontmatter;
  const nowJST = injected.nowJST || githubApi.nowJST;
  const findPR = injected.findPR || githubApi.findPR;
  const closePR = injected.closePR || githubApi.closePR;
  const waitForMergeable = injected.waitForMergeable || githubApi.waitForMergeable;
  const mergePR = injected.mergePR || githubApi.mergePR;
  const deleteBranch = injected.deleteBranch || githubApi.deleteBranch;
  const findApprovedArticlesForDate = injected.findApprovedArticlesForDate || githubApi.findApprovedArticlesForDate;
  const sendNotification = injected.sendNotification || notify.sendNotification;
  let refreshRequest = false;
  let refreshFilename = '';
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { filename, publish_at, ref } = JSON.parse(event.body || '{}');
    refreshRequest = typeof ref === 'string' && ref.startsWith('draft/refresh-');
    refreshFilename = filename || '';

    if (!filename) {
      return { statusCode: 400, body: JSON.stringify({ error: 'filename は必須です' }) };
    }

    const filepath = `content/posts/${filename}`;
    let branchFile;
    try {
      branchFile = await getFile(filepath, ref || undefined);
    } catch (error) {
      if (refreshRequest) {
        let pr;
        try { pr = ref ? await findPR(ref) : null; }
        catch (_) {
          try { await sendNotification('refresh_approve_failed', { title: filename, comment: '更新案の状態を確認できませんでした。' }); }
          catch (_) { console.error('[review-approve] 更新案の失敗通知送信に失敗しました'); }
          return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '更新案の状態を確認できませんでした。' }) };
        }
        if (!pr) {
          try { await sendNotification('refresh_processed', { title: filename }); }
          catch (_) { console.error('[review-approve] 更新案の処理済み通知送信に失敗しました'); }
          return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'この更新案は処理済みか、取り下げられています。', processed: true }) };
        }
        try { await sendNotification('refresh_approve_failed', { title: filename, comment: '更新案のファイルを読み取れませんでした。' }); }
        catch (_) { console.error('[review-approve] 更新案の失敗通知送信に失敗しました'); }
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '更新案のファイルを読み取れませんでした。' }) };
      }
      throw error;
    }
    const content = branchFile.content;
    const sha = branchFile.sha;
    const branchMeta = parseFrontmatterMeta(content);
    if (branchMeta.fact_check_blocking === true || String(branchMeta.fact_check_blocking) === 'true' || branchMeta.fact_check_status === 'revise') {
      const reason = `事実の照合で承認できない状態です（${branchMeta.fact_check_status || '照合で停止'}）。差し戻して直してください`;
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: reason }) };
    }
    if (!Object.keys(branchMeta).some(key => key.startsWith('fact_check_'))) console.log(`[review-approve] ${filename}: 照合の記録なし`);
    const isRefresh = refreshRequest || branchMeta.refresh_of === 'published';
    refreshRequest = isRefresh;
    if (isRefresh) {
      if (!ref) {
        try { await sendNotification('refresh_approve_failed', { title: filename, comment: '更新案の承認には ref が必要です。' }); }
        catch (_) { console.error('[review-approve] 更新案の失敗通知送信に失敗しました'); }
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '更新案の承認には ref が必要です。' }) };
      }
      return await handleRefreshApproval({ filename, filepath, ref, branchFile, getFile, putFile, updateFrontmatter, nowJST, findPR, closePR, deleteBranch, sendNotification });
    }

    if (ref) {
      try {
        const currentMain = await getFile(filepath, 'main');
        if (mainStatus(currentMain.content) === 'published') {
          return { statusCode: 409, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '公開済みの記事は通常の承認経路で変更できません。' }) };
        }
      } catch (error) {
        if (!/\b404\b|not found/i.test(String(error && error.message || ''))) throw error;
      }
    }

    const sourceGuard = approvalSourceGuard(content);
    if (sourceGuard.blocked) {
      const blockedTitle = (content.match(/^title:\s*"?([^"\n\r]+)"?/m) || [])[1] || filename;
      console.warn(`[review-approve] 承認拒否(出典ガード): ${filename} — ${(sourceGuard.reasons || []).join(' / ')}`);
      try {
        await sendNotification('source_blocked', {
          title: blockedTitle,
          filename,
          reasons: sourceGuard.reasons || [],
        });
      } catch (notifyErr) {
        console.error(`[review-approve] 出典ガード通知送信失敗: ${notifyErr.message}`);
      }
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
    const fmCategory = (content.match(/^category:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmPersona  = (content.match(/^primary_persona:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const fmRole     = (content.match(/^article_role:\s*"?([^"\n\r]+)"?/m) || [])[1] || 'main';

    // ── 品質ゲート（承認前チェック）─────────────────────────────
    // recommendation / 適合スコアが低い記事は承認を拒否する（400）。
    // スコア未設定のレガシー記事は従来どおり承認可（既存運用を壊さない）。
    const fmStr = (re) => (content.match(re) || [])[1];
    const fmNum = (re) => { const v = fmStr(re); const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    const recommendation = fmStr(/^recommendation:\s*"?([^"\n\r]+)"?/m);

    // タイトルが仮置きのままなら承認しない。生成時にタイトルを確定できないと
    // 「[要レビュー] {slug}」が入る。これが公開されると slug が記事タイトルになる。
    // 2026-08-25: 仮置きのまま「公開推奨」と表示され、承認できる状態になっていた。
    // recommendation の有無に関係なく必ず見る（レガシー記事でも公開してよい理由がない）。
    if (fmTitle && isPlaceholderTitle(fmTitle)) {
      const reason = 'タイトルが仮置きのままです（記事に合ったタイトルを付けてください）';
      console.warn(`[review-approve] 承認拒否(タイトル未確定): ${filename}`);
      try {
        await sendNotification('quality_blocked', { title: fmTitle, filename, reasons: [reason] });
      } catch (notifyErr) {
        console.error(`[review-approve] 通知送信失敗: ${notifyErr.message}`);
      }
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: reason }),
      };
    }

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
      // 出典一致スコアは、直前の出典ガードが今のルールで再判定した結果を優先する。
      // frontmatter の値は生成時点のスナップショットで、出典の扱いを後から変えると
      // 古いまま残る。出典ガードが「問題なし」と判定した記事を、同じ出典について
      // 古いスコアで拒否するのは矛盾している（2026-08-20 に発生）。
      const freshAlignment = sourceGuard && sourceGuard.alignment;
      const alignmentScore = freshAlignment && typeof freshAlignment.score === 'number'
        ? freshAlignment.score
        : scores.source_alignment_score;
      if (alignmentScore != null && alignmentScore <= 3) {
        reasons.push(`出典一致スコアが低い (${alignmentScore}/5)`);
      }
      if (reasons.length > 0) {
        console.warn(`[review-approve] 承認拒否(品質ゲート): ${filename} — ${reasons.join(' / ')}`);
        try {
          await sendNotification('quality_blocked', {
            title: fmTitle || filename,
            filename,
            reasons,
          });
        } catch (notifyErr) {
          console.error(`[review-approve] 品質ゲート通知送信失敗: ${notifyErr.message}`);
        }
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

        // 記事は main に取り込み済みなので、枝の削除失敗では公開処理を止めない。
        // deleteBranch 側でも draft/* 以外を拒否する二重の安全弁を設けている。
        const headBranch = pr.head && pr.head.ref ? pr.head.ref : ref;
        await deleteBranch(headBranch);
      } catch (mergeErr) {
        mergeError = mergeErr;
        console.error(`[review-approve] PR マージ失敗: ${mergeErr.message}`);
      }
    }

    // マージが失敗に見えても、記事が既に main に取り込まれていれば
    // 「二度押し等で既に公開処理が完了している」＝実質成功。
    // （典型例: 1回目の承認でマージ成功 → 2回目は開いている PR が無く findPR が null →
    //  例外 → 従来は誤って merge_failed 通知を出していた）
    // この場合は誤った失敗通知を出さず、かつ重複の approved 通知も出さない。
    let alreadyPublished = false;
    if (ref && (mergeError || !mergeResult)) {
      try {
        const mainFile = await getFile(filepath); // ref 省略 = main
        const mainStatus = (mainFile.content.match(/^review_status:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
        if (['approved', 'scheduled', 'published'].includes(mainStatus)) {
          alreadyPublished = true;
          console.log(`[review-approve] 記事は既に main に取り込み済み (status=${mainStatus}) → 二度押し等の空振り。merge_failed 通知は抑止`);
        }
      } catch (_) {
        // main に無い = 本当に未マージ（通常の失敗）
      }
    }

    // 通知: マージ成功時は approved（公開予約完了）、失敗時のみ merge_failed
    // 実際の公開完了通知 (published) は publish-scheduled ワークフローが送る。
    try {
      if (alreadyPublished) {
        // 既に公開処理済み（二度押し等）→ 追加通知しない（重複・誤報の防止）
        console.log('[review-approve] 既に公開処理済みのため通知はスキップ');
      } else if (mergeError || (ref && !mergeResult)) {
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
    if (refreshRequest) {
      try { await sendNotification('refresh_approve_failed', { title: refreshFilename || '更新案', comment: '更新案の承認処理に失敗しました。' }); }
      catch (_) { console.error('[review-approve] 更新案の失敗通知送信に失敗しました'); }
      console.error('[review-approve] 更新案の承認処理に失敗しました');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: '更新案の承認処理に失敗しました。' }),
      };
    }
    console.error('[review-approve] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

exports.handler = event => handler(event);
exports._handler = handler;
