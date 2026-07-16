'use strict';

/**
 * admin-articles-page — 管理画面（記事一覧）の HTML を返す Netlify Function
 *
 * GET /admin/articles
 *
 * 必須認証: HTTP Basic（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）
 * 認証通過後、SPA 風の HTML を返す。実際のデータは
 *   GET /admin/api/list（admin-list-articles.js）
 *   POST /admin/api/change（admin-change-article-status.js）
 * から取得する。これらの API も Basic 認証を必須化している。
 */

const { requireBasicAuth } = require('./lib/admin-auth');
const { renderAdminNav } = require('./lib/admin-nav');

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理画面｜記事一覧｜毛利順活税理士事務所</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
<style>
  :root {
    --primary: #0B2045;
    --accent:  #E85320;
    --danger:  #C62828;
    --warning: #F57F17;
    --success: #1A9660;
    --muted:   #6b7280;
    --border:  #e2e8f0;
    --bg:      #f8f9fc;
  }
  body { font-family: 'Noto Sans JP', sans-serif; background: var(--bg); color: #2c2c2c; }
  .admin-header {
    background: var(--primary); color: #fff; padding: 1rem 0; margin-bottom: 1.5rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  .admin-header h1 { font-size: 1.1rem; margin: 0; font-weight: 700; }
  .admin-header .subtitle { font-size: .82rem; opacity: .82; }
  .filter-bar {
    background: #fff; border-radius: 12px; padding: 1rem; margin-bottom: 1rem;
    box-shadow: 0 2px 6px rgba(0,0,0,0.04);
  }
  .filter-tabs button {
    border: 1px solid var(--border); background: #fff; padding: .5rem 1rem;
    border-radius: 999px; font-size: .85rem; font-weight: 500; transition: all .2s;
    margin-right: .4rem; margin-bottom: .25rem;
  }
  .filter-tabs button:hover { border-color: var(--accent); color: var(--accent); }
  .filter-tabs button.active {
    background: var(--primary); color: #fff; border-color: var(--primary);
  }
  .filter-tabs .count { display: inline-block; margin-left: .35rem; font-size: .75rem; opacity: .8; }
  .article-row {
    background: #fff; border-radius: 10px; padding: 1rem 1.2rem; margin-bottom: .75rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.04); border-left: 4px solid var(--border);
  }
  .article-row.status-published   { border-left-color: var(--success); }
  .article-row.status-approved    { border-left-color: var(--accent);  }
  .article-row.status-draft       { border-left-color: var(--muted);   }
  .article-row.status-needs_review{ border-left-color: var(--warning); }
  .article-row.status-needs_revision { border-left-color: var(--warning); }
  .article-row.status-skipped     { border-left-color: var(--muted);   opacity: .65; }
  .article-title { font-size: 1rem; font-weight: 700; color: var(--primary); margin-bottom: .25rem; }
  .article-meta {
    font-size: .78rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: .5rem 1rem;
    margin-bottom: .35rem;
  }
  .article-meta .badge-status {
    display: inline-block; padding: .15rem .55rem; border-radius: 999px;
    font-size: .72rem; font-weight: 700; letter-spacing: .03em;
  }
  .badge-status.published   { background: #e6f5ee; color: var(--success); }
  .badge-status.approved    { background: #fdebe2; color: var(--accent); }
  .badge-status.draft       { background: #eef0f4; color: var(--muted); }
  .badge-status.needs_review{ background: #fff4d4; color: var(--warning); }
  .badge-status.needs_revision { background: #fff4d4; color: var(--warning); }
  .badge-status.skipped     { background: #eef0f4; color: var(--muted); }
  .article-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
  .article-actions .btn { font-size: .82rem; padding: .35rem .8rem; }
  .btn-danger-outline {
    background: #fff; border: 1px solid var(--danger); color: var(--danger);
  }
  .btn-danger-outline:hover { background: var(--danger); color: #fff; }
  .btn-warn-outline {
    background: #fff; border: 1px solid var(--warning); color: var(--warning);
  }
  .btn-warn-outline:hover { background: var(--warning); color: #fff; }
  .btn-link-outline {
    background: #fff; border: 1px solid var(--border); color: var(--muted);
  }
  .btn-link-outline:hover { border-color: var(--primary); color: var(--primary); }
  .empty-state {
    background: #fff; border-radius: 10px; padding: 3rem 1rem; text-align: center;
    color: var(--muted); font-size: .9rem;
  }
  .toast-area {
    position: fixed; right: 1rem; bottom: 1rem; z-index: 9999;
    display: flex; flex-direction: column; gap: .5rem;
  }
  .toast-msg {
    background: #fff; border: 1px solid var(--border); border-left: 4px solid var(--success);
    border-radius: 8px; padding: .8rem 1rem; box-shadow: 0 4px 16px rgba(0,0,0,0.10);
    font-size: .88rem; max-width: 360px;
  }
  .toast-msg.error { border-left-color: var(--danger); color: var(--danger); }
  .loading { display: inline-block; width: 1em; height: 1em;
    border: 2px solid currentColor; border-bottom-color: transparent;
    border-radius: 50%; animation: spin 1s linear infinite; vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<header class="admin-header">
  <div class="container">
    <h1><i class="bi bi-shield-lock me-2"></i>記事管理画面</h1>
    <div class="subtitle">毛利順活税理士事務所｜公開済み記事の未公開・公開予約取消・状態確認</div>
  </div>
</header>

${renderAdminNav('articles')}

<main class="container">
  <div class="filter-bar">
    <div class="filter-tabs mb-2" id="filter-tabs">
      <button class="active" data-status="all">全て<span class="count" id="count-all">-</span></button>
      <button data-status="published">📢 公開済み<span class="count" id="count-published">-</span></button>
      <button data-status="approved">⏰ 公開予約中<span class="count" id="count-approved">-</span></button>
      <button data-status="needs_review">🔍 レビュー待ち<span class="count" id="count-needs_review">-</span></button>
      <button data-status="needs_revision">📝 差し戻し中<span class="count" id="count-needs_revision">-</span></button>
      <button data-status="draft">📄 下書き<span class="count" id="count-draft">-</span></button>
      <button data-status="skipped">⏭️ 見送り<span class="count" id="count-skipped">-</span></button>
    </div>
    <input type="text" id="search-box" class="form-control"
      placeholder="タイトル / slug / カテゴリ で絞り込み...">
  </div>

  <div id="loading" class="empty-state">
    <span class="loading"></span> 記事一覧を読み込んでいます...
  </div>
  <div id="article-list"></div>
  <div id="empty-msg" class="empty-state d-none">該当する記事がありません。</div>
</main>

<div class="toast-area" id="toast-area"></div>

<script>
(function () {
  const STATE = { items: [], filterStatus: 'all', search: '' };

  const STATUS_LABELS = {
    published: '📢 公開済み',
    approved:  '⏰ 公開予約中',
    needs_review: '🔍 レビュー待ち',
    needs_revision: '📝 差し戻し中',
    draft:     '📄 下書き',
    skipped:   '⏭️ 見送り',
  };
  const ROLE_LABELS = { main: '本命', support: '補強' };
  const TYPE_LABELS = {
    basic_explainer: '基本解説',
    comparison_decision: '比較・判断',
    edge_case: '判断ケース',
    industry_example: '業種別具体例',
    filing_practice: '申告実務',
    misconception_fix: '誤解の整理',
    case_study: 'ケーススタディ',
  };
  const PERSONA_LABELS = {
    ebay_export_seller: 'eBay輸出セラー',
    domestic_ec_seller: '国内EC物販',
    reseller_marketplace_seller: 'フリマ・転売',
    influencer_creator: 'インフルエンサー',
    beauty_salon_owner: '美容サロン',
    inheritance_client: '相続・贈与',
  };

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return s;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return y + '/' + m + '/' + day + ' ' + hh + ':' + mm;
  }

  function toast(msg, isError) {
    const div = document.createElement('div');
    div.className = 'toast-msg' + (isError ? ' error' : '');
    div.textContent = msg;
    document.getElementById('toast-area').appendChild(div);
    setTimeout(function () { div.remove(); }, 5000);
  }

  function fetchList() {
    document.getElementById('loading').classList.remove('d-none');
    return fetch('/admin/api/list', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401) { toast('認証エラー: 再ログインしてください', true); throw new Error('401'); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'list取得失敗');
        STATE.items = data.items || [];
        updateCounts(data.groupedCounts);
        render();
      })
      .catch(function (e) { toast('一覧取得失敗: ' + e.message, true); })
      .finally(function () { document.getElementById('loading').classList.add('d-none'); });
  }

  function updateCounts(g) {
    if (!g) g = {};
    const total = (g.published || 0) + (g.approved || 0) + (g.needs_review || 0)
      + (g.needs_revision || 0) + (g.draft || 0) + (g.skipped || 0) + (g.other || 0);
    document.getElementById('count-all').textContent = '(' + total + ')';
    ['published', 'approved', 'needs_review', 'needs_revision', 'draft', 'skipped'].forEach(function (k) {
      const el = document.getElementById('count-' + k);
      if (el) el.textContent = '(' + (g[k] || 0) + ')';
    });
  }

  function render() {
    const filtered = STATE.items.filter(function (it) {
      if (STATE.filterStatus !== 'all' && it.review_status !== STATE.filterStatus) return false;
      if (STATE.search) {
        const q = STATE.search.toLowerCase();
        const hay = (it.title + ' ' + it.slug + ' ' + it.category + ' ' + it.filename).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    const list = document.getElementById('article-list');
    list.innerHTML = '';
    if (filtered.length === 0) {
      document.getElementById('empty-msg').classList.remove('d-none');
      return;
    }
    document.getElementById('empty-msg').classList.add('d-none');

    for (const it of filtered) {
      list.appendChild(renderRow(it));
    }
  }

  function renderRow(it) {
    const row = document.createElement('div');
    row.className = 'article-row status-' + (it.review_status || 'draft');

    const statusLabel = STATUS_LABELS[it.review_status] || it.review_status;
    const typeLabel   = TYPE_LABELS[it.article_type] || it.article_type;
    const roleLabel   = ROLE_LABELS[it.article_role] || (it.article_role || '');
    const personaLabel = PERSONA_LABELS[it.primary_persona] || it.primary_persona;

    const dates = [];
    if (it.publish_at)   dates.push('予定: ' + fmtDate(it.publish_at));
    if (it.published_at) dates.push('公開: ' + fmtDate(it.published_at));
    if (it.publish_slot) dates.push('枠: ' + it.publish_slot);

    const links = [];
    if (it.publicUrl && it.review_status === 'published') {
      links.push('<a class="btn btn-link-outline" target="_blank" href="' + escHtml(it.publicUrl)
        + '"><i class="bi bi-box-arrow-up-right"></i> 公開URL</a>');
    }
    links.push('<a class="btn btn-link-outline" target="_blank" href="' + escHtml(it.reviewUrl)
      + '"><i class="bi bi-search"></i> レビュー画面</a>');
    links.push('<a class="btn btn-link-outline" target="_blank" href="' + escHtml(it.githubUrl)
      + '"><i class="bi bi-github"></i> GitHub</a>');

    let actionBtns = '';
    if (it.review_status === 'published') {
      actionBtns += '<button class="btn btn-danger-outline" data-action="unpublish" data-filename="'
        + escHtml(it.filename) + '"><i class="bi bi-eye-slash"></i> 未公開にする</button>';
    } else if (it.review_status === 'approved') {
      actionBtns += '<button class="btn btn-warn-outline" data-action="cancel_publish" data-filename="'
        + escHtml(it.filename) + '"><i class="bi bi-x-circle"></i> 公開予約を取り消す</button>';
    }

    row.innerHTML =
      '<div class="article-meta">'
      + '<span class="badge-status ' + escHtml(it.review_status || 'draft') + '">' + escHtml(statusLabel) + '</span>'
      + (roleLabel ? '<span><i class="bi bi-bookmark"></i> ' + escHtml(roleLabel) + '記事</span>' : '')
      + (typeLabel ? '<span><i class="bi bi-tag"></i> ' + escHtml(typeLabel) + '</span>' : '')
      + (it.category ? '<span><i class="bi bi-folder"></i> ' + escHtml(it.category) + '</span>' : '')
      + (personaLabel ? '<span><i class="bi bi-person"></i> ' + escHtml(personaLabel) + '</span>' : '')
      + '</div>'
      + '<div class="article-title">' + escHtml(it.title || '（タイトル未設定）') + '</div>'
      + '<div class="article-meta">'
      + '<span><i class="bi bi-file-earmark-code"></i> ' + escHtml(it.filename) + '</span>'
      + (it.slug ? '<span>slug: ' + escHtml(it.slug) + '</span>' : '')
      + (dates.length ? '<span><i class="bi bi-clock"></i> ' + escHtml(dates.join(' / ')) + '</span>' : '')
      + '</div>'
      + '<div class="article-actions">' + actionBtns + links.join('') + '</div>';

    row.querySelectorAll('button[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { handleAction(btn); });
    });
    return row;
  }

  function handleAction(btn) {
    const action = btn.getAttribute('data-action');
    const filename = btn.getAttribute('data-filename');
    const confirmMsg = action === 'unpublish'
      ? 'この記事を未公開にしますか？\\n（公開URLからは外れますが、ファイルは残ります）'
      : 'この公開予約を取り消しますか？\\n（draftに戻り、scheduler では公開されなくなります）';
    if (!confirm(confirmMsg)) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 実行中...';

    fetch('/admin/api/change', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: filename, action: action }),
    })
      .then(function (res) {
        if (res.status === 401) { toast('認証エラー: 再ログインしてください', true); throw new Error('401'); }
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        if (!r.ok || !r.data.ok) throw new Error((r.data && r.data.error) || '操作失敗');
        toast(r.data.message || '操作が完了しました');
        return fetchList();
      })
      .catch(function (e) {
        toast('失敗: ' + e.message, true);
        btn.disabled = false;
        btn.innerHTML = (action === 'unpublish'
          ? '<i class="bi bi-eye-slash"></i> 未公開にする'
          : '<i class="bi bi-x-circle"></i> 公開予約を取り消す');
      });
  }

  // フィルタタブ
  document.getElementById('filter-tabs').addEventListener('click', function (e) {
    if (e.target.tagName !== 'BUTTON') return;
    document.querySelectorAll('#filter-tabs button').forEach(function (b) { b.classList.remove('active'); });
    e.target.classList.add('active');
    STATE.filterStatus = e.target.getAttribute('data-status');
    render();
  });

  // 検索ボックス
  document.getElementById('search-box').addEventListener('input', function (e) {
    STATE.search = e.target.value.trim();
    render();
  });

  // 初回読み込み
  fetchList();
})();
</script>
</body>
</html>`;

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: HTML,
  };
};
