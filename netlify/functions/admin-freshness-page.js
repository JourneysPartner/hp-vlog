'use strict';

const { requireBasicAuth } = require('./lib/admin-auth');
const githubApi = require('./lib/github-api');
const { renderAdminNav } = require('./lib/admin-nav');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPage(candidates, pullRequests) {
  const prByBranch = new Map((pullRequests || []).map(pr => [
    pr && pr.head && pr.head.ref, pr,
  ]).filter(([branch]) => branch));
  const cards = (candidates || []).map(candidate => {
    const slug = String(candidate.slug || '');
    const supportedSlug = /^[a-z0-9_-]+$/.test(slug);
    const branch = `draft/refresh-${slug}`;
    const pr = prByBranch.get(branch);
    const reviewUrl = `https://mori-zeirishi.net/review?file=${encodeURIComponent(candidate.file || '')}&ref=${encodeURIComponent(branch)}`;
    const reasons = (candidate.reasons || []).map(reason => `<li>${escapeHtml(reason.detail)}（${escapeHtml(reason.where)}）</li>`).join('');
    const action = pr
      ? `<p class="status">更新案あり：<a href="${escapeHtml(pr.html_url || pr.url || '#')}" target="_blank" rel="noopener">Pull Request</a> · <a href="${escapeHtml(reviewUrl)}">レビュー画面</a></p>`
      : !supportedSlug
        ? '<p class="muted">slug に英小文字・数字・ハイフン・下線以外の文字があるため、この画面からの操作はできません。</p>'
        : candidate.refreshable
        ? `<button class="action" data-action="refresh" data-slug="${escapeHtml(slug)}">更新案を作る</button>`
        : '<p class="muted">更新案を作れる理由はありません。</p>';
    const reviewedAction = supportedSlug
      ? `<button class="action secondary" data-action="reviewed" data-slug="${escapeHtml(slug)}">確認済み（変更なし）</button>`
      : '';
    return `<article class="candidate">
      <h2><a href="${escapeHtml(candidate.url || `https://mori-zeirishi.net/blog/${encodeURIComponent(slug)}/`)}" target="_blank" rel="noopener">${escapeHtml(candidate.title || slug)}</a></h2>
      <p>スコア ${escapeHtml(candidate.score)} · 表示回数 ${escapeHtml(candidate.impressions28d)} 回</p>
      <ul>${reasons}</ul>
      ${action}
      ${reviewedAction}
      <p class="result" aria-live="polite"></p>
    </article>`;
  }).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>記事の更新候補 | 管理画面</title><style>
      body{margin:0;background:#f3f6fa;color:#10233f;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}
      main{max-width:1040px;margin:1.5rem auto;padding:0 1rem}.candidate{background:white;border:1px solid #dbe3ef;border-radius:12px;padding:1rem 1.2rem;margin:1rem 0;box-shadow:0 2px 7px #10233f0a}
      h1{font-size:1.5rem}h2{font-size:1.08rem;margin:.2rem 0 .6rem}a{color:#17633a}.candidate p{margin:.45rem 0;color:#506078}.candidate ul{line-height:1.7;padding-left:1.4rem}.action{border:0;border-radius:7px;background:#14613a;color:white;padding:.55rem .8rem;margin:.35rem .45rem .2rem 0;cursor:pointer}.action.secondary{background:#e9eef5;color:#10233f}.action:disabled{opacity:.55;cursor:wait}.status{font-weight:600}.muted{color:#68778b}.result{min-height:1.2em}.empty{background:white;padding:1.5rem;border-radius:10px}
    </style></head><body>${renderAdminNav('freshness')}<main><h1>記事の更新候補</h1>
    <p>候補の理由を確認し、必要な記事だけ更新案を作成します。公開中の記事は、承認後に反映されます。</p>
    ${cards || '<p class="empty">現在、更新候補はありません。</p>'}
    </main><script>
      document.querySelectorAll('.action').forEach(button=>button.addEventListener('click',async()=>{
        const card=button.closest('.candidate');const result=card.querySelector('.result');
        button.disabled=true;result.textContent='処理しています…';
        try{const response=await fetch('/admin/api/freshness/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:button.dataset.action,slug:button.dataset.slug})});
          const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'処理に失敗しました。');
          result.textContent=data.message||'処理が完了しました。';
        }catch(error){result.textContent=error.message;button.disabled=false;}
      }));
    </script></body></html>`;
}

async function handler(event, injected = {}) {
  const auth = requireBasicAuth(event);
  if (auth) return auth;
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  const getFile = injected.getFile || githubApi.getFile;
  const listOpenPRs = injected.listOpenPRs || githubApi.listOpenPRs;
  try {
    const [file, pullRequests] = await Promise.all([
      getFile('data/freshness/candidates.json', 'main'),
      listOpenPRs(),
    ]);
    const data = JSON.parse(file.content);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: renderPage(data.candidates || [], pullRequests),
    };
  } catch (_) {
    console.error('[admin-freshness-page] 更新候補を取得できませんでした');
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: '<!doctype html><html lang="ja"><meta charset="utf-8"><h1>更新候補を表示できません</h1><p>しばらくしてから再度お試しください。</p></html>',
    };
  }
}

exports.handler = handler;
exports._handler = handler;
exports.renderPage = renderPage;
