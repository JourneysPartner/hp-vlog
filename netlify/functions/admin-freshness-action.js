'use strict';

const matter = require('gray-matter');
const { requireBasicAuth } = require('./lib/admin-auth');
const githubApi = require('./lib/github-api');

const CANDIDATES_FILE = 'data/freshness/candidates.json';
const SITE_ORIGIN = 'https://mori-zeirishi.net';

function response(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function refreshBranch(slug) {
  return `draft/refresh-${slug}`;
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find(value => value.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '').trim() : '';
}

function isSameOriginRequest(headers) {
  const origin = headerValue(headers, 'origin');
  if (origin) {
    try { return new URL(origin).origin === SITE_ORIGIN; }
    catch (_) { return false; }
  }
  return headerValue(headers, 'sec-fetch-site') === 'same-origin';
}

async function handler(event, injected = {}) {
  const auth = requireBasicAuth(event);
  if (auth) return auth;
  if (event.httpMethod !== 'POST') return response(405, { error: 'method_not_allowed', message: 'POSTで操作してください。' });
  if (!/^application\/json(?:\s*;|\s*$)/i.test(headerValue(event.headers, 'content-type'))) {
    return response(415, { error: 'unsupported_media_type', message: 'JSON形式で送信してください。' });
  }
  if (!isSameOriginRequest(event.headers)) {
    return response(403, { error: 'forbidden_origin', message: 'この画面から操作してください。' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return response(400, { error: 'invalid_json', message: '入力を読み取れませんでした。' });
  }
  const slug = String(body.slug || '');
  if (!/^[a-z0-9_-]+$/.test(slug)) {
    return response(400, { error: 'invalid_slug', message: 'slug の形式が正しくありません。' });
  }
  if (!['refresh', 'reviewed'].includes(body.action)) {
    return response(400, { error: 'invalid_action', message: '操作を選び直してください。' });
  }

  const getFile = injected.getFile || githubApi.getFile;
  const putFile = injected.putFile || githubApi.putFile;
  const updateFrontmatter = injected.updateFrontmatter || githubApi.updateFrontmatter;
  const findPR = injected.findPR || githubApi.findPR;
  const listWorkflowRuns = injected.listWorkflowRuns || githubApi.listWorkflowRuns;
  const triggerWorkflow = injected.triggerWorkflow || githubApi.triggerWorkflow;
  const nowJST = injected.nowJST || githubApi.nowJST;

  try {
    const candidateFile = await getFile(CANDIDATES_FILE, 'main');
    const data = JSON.parse(candidateFile.content);
    const candidate = (data.candidates || []).find(item => item && item.slug === slug);
    if (!candidate || !/^[\w-]+\.md$/.test(String(candidate.file || ''))) {
      return response(404, { error: 'candidate_not_found', message: '現在の更新候補に記事がありません。' });
    }
    const branch = refreshBranch(slug);
    const refreshBusy = async () => {
      const [pr, runs] = await Promise.all([
        findPR(branch),
        listWorkflowRuns('refresh-article.yml', { per_page: '100' }),
      ]);
      const activeStatuses = new Set(['queued', 'in_progress', 'requested', 'pending', 'waiting']);
      const hasMatchingRun = runs && Array.isArray(runs.workflow_runs) && runs.workflow_runs.some(run =>
        activeStatuses.has(String(run.status || ''))
        && String(run.display_title || '') === `記事の更新案 ${slug}`);
      return Boolean(pr || hasMatchingRun);
    };
    const articlePath = `content/posts/${candidate.file}`;

    if (body.action === 'refresh') {
      if (candidate.refreshable !== true) {
        return response(400, { error: 'not_refreshable', message: 'この記事は更新案の対象ではありません。' });
      }
      if (await refreshBusy()) return response(409, { error: 'refresh_busy', message: '更新案の作成中、または更新案があります。' });
      await triggerWorkflow('refresh-article.yml', 'main', { slug });
      return response(202, { ok: true, message: '更新案の作成を開始しました。数分後に Chatwork に届きます。' });
    }

    if (await refreshBusy()) return response(409, { error: 'refresh_busy', message: '更新案の作成中、または更新案があります。' });

    const current = await getFile(articlePath, 'main');
    let parsed = matter(current.content);
    if (parsed.data.slug !== slug || parsed.data.review_status !== 'published') {
      return response(409, { error: 'article_changed', message: '記事が候補作成後に変更されたため、確認済みにできません。候補を更新してください。' });
    }
    const reviewedAt = nowJST();
    let content = updateFrontmatter(current.content, { reviewed_at: reviewedAt });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await putFile(articlePath, content, current.sha, `freshness: ${slug} を確認済みにする`, 'main');
        return response(200, { ok: true, message: '確認済みにしました。次回の候補更新で理由が判定されます。' });
      } catch (error) {
        const isShaConflict = /\b409\b|sha|conflict/i.test(String(error && error.message || ''));
        if (attempt !== 0 || !isShaConflict) throw error;
        if (await refreshBusy()) {
          return response(409, { error: 'refresh_busy', message: '更新案の作成中、または更新案があります。' });
        }
        const latest = await getFile(articlePath, 'main');
        parsed = matter(latest.content);
        if (parsed.data.slug !== slug || parsed.data.review_status !== 'published') {
          return response(409, { error: 'article_changed', message: '記事が候補作成後に変更されたため、確認済みにできません。候補を更新してください。' });
        }
        content = updateFrontmatter(latest.content, { reviewed_at: reviewedAt });
        current.sha = latest.sha;
      }
    }
    return response(500, { error: 'write_failed', message: '確認済みの記録に失敗しました。しばらくしてからお試しください。' });
  } catch (_) {
    console.error('[admin-freshness-action] 更新候補の操作に失敗しました');
    return response(503, { error: 'github_unavailable', message: 'GitHub と通信できませんでした。しばらくしてからお試しください。' });
  }
}

exports.handler = handler;
exports._handler = handler;
exports.refreshBranch = refreshBranch;
exports.isSameOriginRequest = isSameOriginRequest;
