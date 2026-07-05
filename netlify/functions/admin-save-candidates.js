'use strict';

/**
 * admin-save-candidates — 候補の adopted フラグを保存
 *
 * POST /admin/api/candidates/save
 *   body: {
 *     sha: "...",                          // optimistic lock
 *     updates: { "<shitsugi_url>": { adopted, adoption_note } }
 *   }
 *
 * 必須認証: HTTP Basic
 *
 * GitHub Content API で data/nta-shitsugi-topics-candidate.json を取得し、
 * updates をマージして書き戻す（commit）。
 *
 * 競合検知: クライアントから受け取った sha と取得した最新 sha が異なれば
 *   409 Conflict を返し、フロントは再 fetch して再保存する。
 */

const { requireBasicAuth } = require('./lib/admin-auth');
const { getFile, putFile } = require('./lib/github-api');

const CANDIDATES_FILE = 'data/nta-shitsugi-topics-candidate.json';

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) };
  }

  const updates = body.updates || {};
  const clientSha = body.sha;
  if (typeof updates !== 'object' || updates === null) {
    return { statusCode: 400, body: JSON.stringify({ error: 'updates must be object' }) };
  }

  try {
    // 1. 最新ファイル取得（sha 含む）
    const file = await getFile(CANDIDATES_FILE, 'main');

    // 2. 楽観的並行制御
    if (clientSha && clientSha !== file.sha) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'sha_conflict',
          message: '他の更新が先に commit されました。ページをリロードしてから再度保存してください。',
          current_sha: file.sha,
        }),
      };
    }

    const data = JSON.parse(file.content);

    // 3. updates を適用（adopted / rejected / notes）
    let appliedCount = 0;
    let adoptedCount = 0;
    let rejectedCount = 0;
    for (const c of data.candidates || []) {
      const u = updates[c.shitsugi_url];
      if (u) {
        if (typeof u.adopted === 'boolean' && c.adopted !== u.adopted) {
          c.adopted = u.adopted;
          if (u.adopted) c.rejected = false; // 採用したら除外は解除
          appliedCount++;
        }
        if (typeof u.rejected === 'boolean' && c.rejected !== u.rejected) {
          c.rejected = u.rejected;
          if (u.rejected) c.adopted = false; // 除外したら採用は解除
          appliedCount++;
        }
        if (typeof u.adoption_note === 'string' && c.adoption_note !== u.adoption_note) {
          c.adoption_note = u.adoption_note;
          appliedCount++;
        }
        if (typeof u.rejection_note === 'string' && c.rejection_note !== u.rejection_note) {
          c.rejection_note = u.rejection_note;
          appliedCount++;
        }
      }
      if (c.adopted) adoptedCount++;
      if (c.rejected) rejectedCount++;
    }

    // 4. stats を更新
    if (data.stats) {
      data.stats.adopted_count = adoptedCount;
      data.stats.rejected_count = rejectedCount;
    }

    if (appliedCount === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          message: 'no changes',
          sha: file.sha,
          adopted_count: adoptedCount,
        }),
      };
    }

    // 5. GitHub に commit
    const newContent = JSON.stringify(data, null, 2) + '\n';
    const updateKeys = Object.keys(updates);
    const message = updateKeys.length === 1
      ? `chore(candidates): adopted フラグを更新（${appliedCount} 件、合計採用 ${adoptedCount} 件）`
      : `chore(candidates): adopted フラグを ${updateKeys.length} 件更新（合計採用 ${adoptedCount} 件）`;
    const result = await putFile(CANDIDATES_FILE, newContent, file.sha, message, 'main');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        applied: appliedCount,
        adopted_count: adoptedCount,
        rejected_count: rejectedCount,
        sha: result.content && result.content.sha,
      }),
    };
  } catch (e) {
    console.error('[admin-save-candidates]', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
