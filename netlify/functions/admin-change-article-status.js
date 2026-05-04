'use strict';

/**
 * admin-change-article-status — 記事の状態を変更する API
 *
 * POST /admin/api/change
 * Body:
 *   {
 *     filename: "2026-04-04-xxx.md",
 *     action: "unpublish" | "cancel_publish"
 *   }
 *
 * 必須認証: HTTP Basic（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）
 *
 * 動作:
 *   action="unpublish":
 *     条件: review_status === 'published'
 *     更新: review_status='draft', published_at='', publish_at='', publish_slot=''
 *     コミット: "admin: <filename> を未公開（draft）に戻す"
 *
 *   action="cancel_publish":
 *     条件: review_status === 'approved' かつ publish_at が存在
 *     更新: review_status='draft', approved_at='', publish_at='', publish_slot=''
 *     コミット: "admin: <filename> の公開予約を取り消す"
 *
 * 既存のレビュー機能（review-approve など）と重複しないため、main 直 commit のみを行う。
 */

const { requireBasicAuth } = require('./lib/admin-auth');
const { getFile, putFile, updateFrontmatter, nowJST } = require('./lib/github-api');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*"?(.*?)"?\s*$/);
    if (!kv) continue;
    meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return meta;
}

function jsonRes(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  if (event.httpMethod !== 'POST') {
    return jsonRes(405, { ok: false, error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonRes(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { filename, action } = body;
  if (!filename || !action) {
    return jsonRes(400, { ok: false, error: 'filename / action は必須です' });
  }
  if (!['unpublish', 'cancel_publish'].includes(action)) {
    return jsonRes(400, { ok: false, error: `unknown action: ${action}` });
  }
  // 簡易な path traversal 防止
  if (!/^[\w.\-]+\.md$/.test(filename)) {
    return jsonRes(400, { ok: false, error: 'filename が不正です' });
  }

  const filepath = `content/posts/${filename}`;

  try {
    const { content, sha } = await getFile(filepath, 'main');
    const meta = parseFrontmatter(content);

    if (action === 'unpublish') {
      if (meta.review_status !== 'published') {
        return jsonRes(409, {
          ok: false,
          error: `現在の状態は '${meta.review_status}' です。published 記事のみ未公開にできます。`,
        });
      }
      const updated = updateFrontmatter(content, {
        review_status: 'draft',
        published_at: '',
        publish_at: '',
        publish_slot: '',
        updated_at: nowJST(),
      });
      await putFile(filepath, updated, sha,
        `admin: ${meta.title || filename} を未公開（draft）に戻す`,
        'main');

      return jsonRes(200, {
        ok: true, action,
        message: '公開済み記事を未公開（draft）に戻しました。',
        filename, title: meta.title || '',
      });
    }

    if (action === 'cancel_publish') {
      if (meta.review_status !== 'approved') {
        return jsonRes(409, {
          ok: false,
          error: `現在の状態は '${meta.review_status}' です。approved（公開予約中）のみ取り消しできます。`,
        });
      }
      if (!meta.publish_at) {
        return jsonRes(409, {
          ok: false,
          error: 'publish_at が設定されていません（予約状態ではありません）',
        });
      }
      const updated = updateFrontmatter(content, {
        review_status: 'draft',
        approved_at: '',
        publish_at: '',
        publish_slot: '',
        updated_at: nowJST(),
      });
      await putFile(filepath, updated, sha,
        `admin: ${meta.title || filename} の公開予約を取り消す`,
        'main');

      return jsonRes(200, {
        ok: true, action,
        message: '公開予約を取り消し、draft に戻しました。',
        filename, title: meta.title || '',
      });
    }

    // 到達不能
    return jsonRes(500, { ok: false, error: 'unreachable' });
  } catch (err) {
    console.error(`[admin-change] ${action} ${filename} 失敗:`, err.message);
    return jsonRes(500, { ok: false, error: err.message });
  }
};
