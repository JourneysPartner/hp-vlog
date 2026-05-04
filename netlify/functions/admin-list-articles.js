'use strict';

/**
 * admin-list-articles — 管理画面用の記事一覧 JSON API
 *
 * GET /admin/api/list
 *   → content/posts 配下を GitHub API で取得し、frontmatter をパースして返す
 *
 * 必須認証: HTTP Basic（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）
 *
 * 返り値（JSON）:
 *   {
 *     ok: true,
 *     count: number,
 *     items: [
 *       {
 *         filename, slug, title, category, primary_persona,
 *         article_type, article_role,
 *         review_status, publish_at, published_at, publish_slot,
 *         approved_at, updated_at,
 *         publicUrl, reviewUrl, githubUrl
 *       }
 *     ],
 *     groupedCounts: { published, approved, needs_review, needs_revision, draft, skipped }
 *   }
 */

const { requireBasicAuth } = require('./lib/admin-auth');
const { listDirectory, getFile } = require('./lib/github-api');

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

function siteOrigin(event) {
  // Netlify は host ヘッダを必ず付ける
  const host = (event.headers && (event.headers.host || event.headers.Host)) || '';
  if (!host) return 'https://mori-zeirishi.net';
  // Netlify deploy preview や branch deploy にもフォールバック
  return `https://${host}`;
}

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const items = await listDirectory('content/posts', 'main');
    const mdFiles = items.filter(i => i.name && i.name.endsWith('.md'));

    // 並行取得（やや控えめに 8 並列）
    const concurrency = 8;
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < mdFiles.length) {
        const i = cursor++;
        const item = mdFiles[i];
        try {
          const { content } = await getFile(item.path, 'main');
          const meta = parseFrontmatter(content);
          results.push({
            filename: item.name,
            slug: meta.slug || '',
            title: meta.title || '',
            category: meta.category || '',
            primary_persona: meta.primary_persona || '',
            article_type: meta.article_type || '',
            article_role: meta.article_role || '',
            review_status: meta.review_status || '',
            publish_at: meta.publish_at || '',
            published_at: meta.published_at || '',
            publish_slot: meta.publish_slot || '',
            approved_at: meta.approved_at || '',
            updated_at: meta.updated_at || '',
            macro: meta.macro || '',
          });
        } catch (e) {
          console.warn(`[admin-list] skip ${item.name}: ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // 並び順: published_at（公開済み）/ publish_at（予約）/ updated_at の新しい順
    results.sort((a, b) => {
      const ka = a.published_at || a.publish_at || a.updated_at || a.filename;
      const kb = b.published_at || b.publish_at || b.updated_at || b.filename;
      return kb.localeCompare(ka);
    });

    const origin = siteOrigin(event);
    for (const r of results) {
      r.publicUrl = r.slug ? `${origin}/blog/${r.slug}/` : '';
      r.reviewUrl = `${origin}/review?file=${encodeURIComponent(r.filename)}`;
      r.githubUrl = `https://github.com/${process.env.GITHUB_REPO || 'JourneysPartner/hp-vlog'}/blob/main/content/posts/${r.filename}`;
    }

    const groupedCounts = {
      published: 0, approved: 0, needs_review: 0, needs_revision: 0, draft: 0, skipped: 0, other: 0,
    };
    for (const r of results) {
      if (groupedCounts[r.review_status] != null) groupedCounts[r.review_status]++;
      else groupedCounts.other++;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, count: results.length, items: results, groupedCounts }),
    };
  } catch (err) {
    console.error('[admin-list] error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
