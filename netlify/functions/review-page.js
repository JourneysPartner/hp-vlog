'use strict';

const fs   = require('fs');
const path = require('path');

// GitHub App 認証つき共通 helper（getInstallationToken → 必ず authenticated request）
const githubApi = require('./lib/github-api');
const freshnessRefresh = require('../../scripts/lib/freshness-refresh');

/**
 * review-page — レビュー画面を動的生成する Netlify Function
 *
 * GET /.netlify/functions/review-page?file=2026-04-04-slug.md
 *   → content/posts/{file} を GitHub App 認証つき API で取得し、レビューUIを返す
 *
 * 認証:
 *   netlify/functions/lib/github-api.js の getFile() を使用。
 *   GH_APP_ID / GH_APP_PRIVATE_KEY / GH_APP_INSTALLATION_ID から
 *   installation access token を生成して必ず authenticated に呼ぶ。
 *   （以前は GITHUB_TOKEN が未設定だと無認証 fetch にフォールバックしており、
 *     GitHub API の rate limit (60 req/h) に到達して 403 → 500 になっていた）
 */

// ── ローカルファイル読み取り（netlify dev 用）──────────────────────────
function fetchPostLocal(filename) {
  const filepath = path.join(process.cwd(), 'content', 'posts', filename);
  return fs.readFileSync(filepath, 'utf8');
}

// ── gray-matter 相当の簡易パーサ ────────────────────────────────────
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2];
  }
  return { meta, body: match[2] };
}

// ── GitHub App 認証つきで content/posts/{file} を取得 ─────────────────
// ref: 省略時は GITHUB_BRANCH (デフォルト main)
// getFile は { content, sha } を返すので content を取り出す。
async function fetchPostFromGitHub(filename, ref) {
  const filepath = `content/posts/${filename}`;
  const { content } = await githubApi.getFile(filepath, ref || undefined);
  return content;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderFactCheck(meta, record, body) {
  const labels = { ok: '照合済み', revise: '要修正', not_run: '未実施' };
  const stale = record?.stale || (body !== undefined && record && !record.read_error && record.body_sha256 !== require('../../scripts/lib/fact-check').bodyHash(body));
  const unreadable = record?.read_error;
  const status = stale || unreadable ? 'not_run' : meta.fact_check_status || record?.status || '';
  const refs = item => require('../../scripts/lib/fact-check').evidenceRefs(record || {}, item).map(e => {
    const url = /^https:\/\//.test(e.url || '') ? e.url : '';
    return `<div class="small mt-2">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(e.title || e.no || '根拠')}</a>` : escapeHtml(e.title || e.no || '根拠')}${e.law_version ? `（${escapeHtml(e.law_version)}）` : ''}<blockquote>${escapeHtml(e.text || '')}</blockquote></div>`;
  }).join('');
  const pairs = items => items.length ? items.map(c => `<div class="border rounded p-3 mb-2"><div><strong>前:</strong> ${escapeHtml(c.before || c.sentence)}</div><div><strong>後:</strong> ${escapeHtml(c.after || '（修正なし）')}</div>${!c.resolved ? '<div class="text-danger">再照合後も未解決です</div>' : ''}${refs(c)}</div>`).join('') : '<p class="text-muted">該当なし</p>';
  const remaining = record?.remaining || [];
  const contradictions = remaining.filter(c => c.status === '食い違い' || c.status === '期限の書き漏れ');
  return `<div class="card mb-4" id="factCheck"><div class="card-header bg-white fw-bold">事実の照合</div><div class="card-body">
    <p class="${status === 'revise' ? 'text-danger' : ''}"><strong>状態:</strong> ${escapeHtml(labels[status] || '照合の記録なし')}${status ? `（${escapeHtml(status)}）` : ''}</p>
    <p>${escapeHtml(stale ? 'この記録は今の本文と一致しません（古い記録）' : unreadable ? '照合の記録を読めませんでした' : meta.fact_check_summary || record?.summary || '')}</p>
    ${record && !stale && !unreadable ? `<h3 class="h6">直した箇所</h3>${pairs((record.corrections || []).filter(c => !c.generalized))}
    <h3 class="h6">資料が無く案内に変えた箇所</h3>${pairs((record.corrections || []).filter(c => c.generalized))}
    <h3 class="h6 text-danger">残った食い違い</h3>${contradictions.length ? contradictions.map(c => `<div class="alert alert-danger">${escapeHtml(c.sentence)}<div>${escapeHtml(c.correct || c.status)}</div>${refs(c)}</div>`).join('') : '<p class="text-muted">該当なし</p>'}
    ${remaining.some(c => c.status === '資料なし') ? `<div class="alert alert-warning">資料なしの記述が未解決です。${remaining.filter(c => c.status === '資料なし').map(c => `<p>${escapeHtml(c.sentence)}</p>`).join('')}</div>` : ''}` : stale || unreadable ? '' : '<p>照合の記録なし</p>'}
    </div></div>`;
}

async function fetchFactCheck(slug, ref, body) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug || '')) return null;
  try {
    const { content } = await githubApi.getFile(`data/fact-check/${slug}.json`, ref || undefined);
    const record = JSON.parse(content);
    if (!record || record.version !== 1 || record.slug !== slug) return { read_error: true };
    if (body !== undefined && record.body_sha256 !== require('../../scripts/lib/fact-check').bodyHash(body)) return { ...record, stale: true };
    return record;
  } catch (error) {
    return /\b404\b|not found/i.test(String(error?.message || '')) ? null : { read_error: true };
  }
}

function renderRefreshDiff(refreshContext, marked) {
  if (!refreshContext || !refreshContext.available) {
    return `<div class="alert alert-warning" role="alert">${escapeHtml(refreshContext && refreshContext.message || '公開中の記事を取得できませんでした。更新案を承認できません。')}</div>`;
  }
  if (!refreshContext.diff.length) {
    return '<div class="alert alert-info" role="status">変更箇所を検出できませんでした。</div>';
  }
  const renderSide = (paragraphs) => paragraphs.map(row => {
    const style = row.changed ? 'background:#fff0d4;border-left:4px solid #e6851a;padding:.55rem .75rem;margin:.45rem 0' : 'padding:.55rem .75rem;margin:.45rem 0';
    const html = marked(row.text).replace(/<table>/g, '<div class="table-wrapper"><table>').replace(/<\/table>/g, '</table></div>');
    return `<div style="${style}">${html}</div>`;
  }).join('') || '<p class="text-muted">（段落なし）</p>';
  return `<div class="refresh-diff-list">${refreshContext.diff.map(section => `
    <section class="card mb-3"><div class="card-header fw-bold">${escapeHtml(section.heading)}</div>
      <div class="card-body"><div class="row g-3">
        <div class="col-md-6"><h4 class="h6">変更前</h4>${renderSide(section.changedParagraphs.before)}</div>
        <div class="col-md-6"><h4 class="h6">変更後</h4>${renderSide(section.changedParagraphs.after)}</div>
      </div></div>
    </section>`).join('')}</div>`;
}

// ── GitHub App 認証情報が揃っているか事前チェック ────────────────────
// 不足している場合は無認証 fallback で呼び続けず、明確なエラーを投げる。
function assertGitHubCredentials() {
  const hasApp = process.env.GH_APP_ID &&
                 process.env.GH_APP_PRIVATE_KEY &&
                 process.env.GH_APP_INSTALLATION_ID;
  const hasPat = process.env.GITHUB_TOKEN;
  if (!hasApp && !hasPat) {
    throw new Error(
      'GitHub App credentials are missing: GH_APP_ID / GH_APP_PRIVATE_KEY / GH_APP_INSTALLATION_ID'
    );
  }
}

// ── HTML テンプレート ─────────────────────────────────────────────────
function renderReviewPage(filename, meta, bodyMd, ref, refreshContext = null, factRecord = null) {
  const title      = meta.title      || '（タイトル未設定）';
  const summary    = meta.summary    || '';
  const sourceUrl  = meta.source_url || '';
  const sourceTitle = meta.source_title || sourceUrl;
  const previewUrl = meta.preview_url || '';
  const publishAt  = meta.publish_at || '';
  const status     = meta.review_status || 'needs_review';
  const category   = meta.category   || '';
  const isRefresh = meta.refresh_of === 'published' || String(ref || '').startsWith('draft/refresh-');
  const approvalDisabled = isRefresh && !(refreshContext && refreshContext.available);
  const expiredTheme = isRefresh && freshnessRefresh.isExpiredRefreshTheme(meta);
  const refreshBanner = isRefresh ? `
  <div class="alert alert-primary" role="status">
    公開中の記事の更新案です。承認すると、すぐに公開中の記事へ反映されます（公開日は変わらず、更新日が付きます）。
    <div>反映されるのは本文だけです。題名・要約・公開日・出典欄は公開中の記事のまま変わりません。</div>
    ${meta.refresh_note ? `<div class="mt-2"><strong>更新理由:</strong> ${escapeHtml(meta.refresh_note)}</div>` : ''}
  </div>
  ${expiredTheme ? '<div class="alert alert-warning" role="alert">期限切れのテーマです。更新ではなく公開停止も検討してください</div>' : ''}
  ${!meta.source_guard_version ? `<div class="alert alert-warning" role="alert">出典確認の仕組みができる前の記事です（出典: ${escapeHtml(meta.source_url || '未設定')}）。出典との食い違いが無いかを特に見てください。</div>` : ''}
  <div class="card mb-4"><div class="card-header bg-white fw-bold">変更箇所</div><div class="card-body">${renderRefreshDiff(refreshContext, require('marked').marked)}</div></div>` : '';

  // ── 顧客カテゴリ・適合スコア（Phase 3b）─────────────────────────
  const customerSegment = meta.customer_segment || '';
  const recommendation  = meta.recommendation || '';
  const reviewWarning   = meta.review_warning || '';
  const targetQuery     = meta.target_query || '';
  const secondaryQueries = meta.secondary_queries || '';
  const intentLabel = { answer: '一問一答', decide: '判断・比較', guide: '手順・全体像' }[meta.intent_type] || meta.intent_type || '';
  const SEGMENT_LABELS = {
    ec_seller: 'EC物販', beauty_salon: '美容・サロン', creator: 'インフルエンサー',
    general_business: '一般事業者', inheritance_gift: '相続・贈与',
  };
  const scoreDefs = [
    ['顧客適合', meta.customer_fit_score], ['検索意図', meta.search_intent_score],
    ['出典一致', meta.source_alignment_score], ['実務有用', meta.practical_usefulness_score],
    ['集客価値', meta.lead_value_score], ['税リスク', meta.tax_risk_score],
  ];
  const scoreChip = (label, v) => {
    const n = parseInt(v, 10);
    const color = isNaN(n) ? '#888' : (n >= 4 ? '#198754' : (n >= 3 ? '#fd7e14' : '#dc3545'));
    return `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:10px;background:${color};color:#fff;font-size:12px">${label} ${isNaN(n) ? '-' : n}</span>`;
  };
  const scoresHtml = scoreDefs.map(([l, v]) => scoreChip(l, v)).join('');
  const recLabel = { publish: '✅ 公開推奨', revise: '⚠ 要修正（内容確認）', reject: '⛔ 非推奨（作り直し検討）' }[recommendation] || '';
  const warnBanner = (recommendation && recommendation !== 'publish')
    ? `<div style="margin-bottom:12px;padding:10px 14px;border-radius:6px;background:#fff3cd;border:1px solid #ffe69c;color:#664d03">
        <strong>${recLabel}</strong>${reviewWarning ? `<div style="margin-top:4px;font-size:13px">理由: ${escapeHtml(reviewWarning)}</div>` : ''}
      </div>`
    : '';

  const statusLabel = {
    needs_review:   '🔍 レビュー待ち',
    approved:       '✅ 承認済み',
    needs_revision: '📝 差し戻し中',
    skipped:        '⏭️ 見送り',
    published:      '📢 公開済み',
  }[status] || status;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>レビュー: ${title}｜毛利順活税理士事務所</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
<style>
  :root { --primary: #1a5632; --primary-light: #e8f5e9; --danger: #c62828; --warning: #f57f17; }
  body { font-family: 'Noto Sans JP', sans-serif; background: #f5f5f5; }
  .review-header { background: var(--primary); color: #fff; padding: 1rem 0; }
  .review-header h1 { font-size: 1rem; margin: 0; }
  .status-badge { display: inline-block; padding: .25rem .75rem; border-radius: 1rem;
    font-size: .85rem; font-weight: 500; background: var(--primary-light); color: var(--primary); }
  .card { border: none; border-radius: .75rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .meta-table th { width: 140px; font-weight: 500; white-space: nowrap; vertical-align: top; }
  .meta-table td { word-break: break-all; }
  .article-body { line-height: 1.85; }
  .article-body h2 { font-size: 1.25rem; font-weight: 700; margin: 1.5rem 0 .75rem;
    padding-left: .75rem; border-left: 4px solid var(--primary); }
  .article-body h3 { font-size: 1.1rem; font-weight: 600; margin: 1.25rem 0 .5rem; }
  .article-body blockquote { background: #fafafa; border-left: 3px solid #ccc; padding: .75rem 1rem; margin: 1rem 0; }
  .article-body ul, .article-body ol { padding-left: 1.5rem; }
  .article-body hr { margin: 1.5rem 0; }
  .article-body .table-wrapper { overflow-x: auto; margin: 1.5rem 0; -webkit-overflow-scrolling: touch; }
  .article-body table { width: 100%; border-collapse: collapse; font-size: .9rem; min-width: 480px; }
  .article-body thead th { background: var(--primary-light); color: var(--primary); font-weight: 600;
    padding: .6rem .75rem; border: 1px solid #c8e6c9; text-align: left; white-space: nowrap; }
  .article-body tbody td { padding: .6rem .75rem; border: 1px solid #e0e0e0; line-height: 1.7; }
  .article-body tbody tr:nth-child(even) { background: #fafafa; }
  .article-body tbody tr:hover { background: #f0f7f1; }

  .action-section { position: sticky; bottom: 0; background: #fff;
    border-top: 1px solid #dee2e6; padding: 1rem 0; z-index: 10; }
  .btn-approve { background: var(--primary); color: #fff; }
  .btn-approve:hover { background: #124225; color: #fff; }
  .btn-revise  { background: var(--warning); color: #fff; }
  .btn-revise:hover  { background: #c66a00; color: #fff; }
  .btn-skip    { background: #757575; color: #fff; }
  .btn-skip:hover    { background: #555; color: #fff; }

  .comment-area { display: none; margin-top: .75rem; }
  .comment-area.show { display: block; }

  .result-msg { display: none; padding: 1rem; border-radius: .5rem; margin-top: 1rem; }
  .result-msg.show { display: block; }
  .result-msg.success { background: var(--primary-light); color: var(--primary); }
  .result-msg.error   { background: #ffebee; color: var(--danger); }
</style>
</head>
<body>

<!-- ヘッダー -->
<div class="review-header">
  <div class="container d-flex align-items-center justify-content-between">
    <h1><i class="bi bi-pencil-square me-2"></i>ブログ記事レビュー</h1>
    <span class="status-badge">${statusLabel}</span>
  </div>
</div>

<div class="container py-4">

  ${refreshBanner}
  ${renderFactCheck(meta, factRecord)}

  <!-- メタ情報カード -->
  <div class="card mb-4">
    <div class="card-body">
      <h2 class="h5 mb-3">${title}</h2>
      ${warnBanner}
      <table class="table table-sm meta-table mb-0">
        <tbody>
          <tr><th>カテゴリ</th><td>${category}</td></tr>
          <tr><th>顧客カテゴリ</th><td>${SEGMENT_LABELS[customerSegment] || customerSegment || '（判定なし）'}${recLabel ? ` <span class="text-muted" style="font-size:12px">／ 判定: ${recLabel}</span>` : ''}</td></tr>
          <tr><th>適合スコア</th><td>${scoresHtml}<div class="text-muted" style="font-size:11px;margin-top:2px">5=良 / 3=注意 / 1-2=要改善</div></td></tr>
          ${targetQuery ? `<tr><th>狙う検索語</th><td><strong>${targetQuery}</strong>${intentLabel ? `（型: ${intentLabel}）` : ''}${secondaryQueries ? `<div class="text-muted" style="font-size:12px;margin-top:3px">副: ${secondaryQueries}</div>` : ''}</td></tr>` : ''}
          ${meta.article_role === 'main' ? '<tr><th>本命記事の確認</th><td>実務で実際によくある場面（出典に無い一次情報）が 1 つ以上あるか</td></tr>' : ''}
          <tr><th>要約</th><td>${summary}</td></tr>
          <tr>
            <th>出典URL</th>
            <td>${sourceUrl ? `<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceTitle} <i class="bi bi-box-arrow-up-right"></i></a>` : '（未設定）'}</td>
          </tr>
          <tr>
            <th>プレビューURL</th>
            <td>${previewUrl ? `<a href="${previewUrl}" target="_blank" rel="noopener">${previewUrl} <i class="bi bi-box-arrow-up-right"></i></a>` : '（未設定）'}</td>
          </tr>
          ${isRefresh ? '' : `<tr>
            <th>公開日時（任意）</th>
            <td>
              <input type="datetime-local" id="publishAt" class="form-control form-control-sm" style="max-width:280px"
                value="${publishAt ? publishAt.replace(/\+.*$/, '').replace('T', 'T') : ''}">
              <small class="text-muted">未入力の場合は翌日 11:30 に自動設定されます</small>
            </td>
          </tr>`}
          <tr><th>ファイル</th><td><code>${filename}</code></td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 記事本文カード -->
  <div class="card mb-4">
    <div class="card-header bg-white fw-bold">記事本文</div>
    <div class="card-body article-body" id="articleBody">
      ${bodyMd}
    </div>
  </div>

  <!-- 修正コメント入力欄 -->
  <div class="card mb-4 comment-area" id="commentCard">
    <div class="card-body">
      <label for="reviewComment" class="form-label fw-bold">修正コメント</label>
      <textarea id="reviewComment" class="form-control" rows="4"
        placeholder="修正してほしい内容を具体的に記入してください…"></textarea>
      ${isRefresh ? '' : `<div class="form-check mt-3">
        <input class="form-check-input" type="checkbox" id="suppressTopic">
        <label class="form-check-label" for="suppressTopic">
          このテーマを<strong>今後生成しない</strong>（denylist に追加 / 再生成もスキップ）
        </label>
      </div>
      <div class="form-text">
        コメントに「今後…書かないでください」「もう生成しないでください」等の文言があれば、自動で禁止登録されます。
      </div>`}
    </div>
  </div>

  <!-- 結果メッセージ -->
  <div class="result-msg" id="resultMsg"></div>
</div>

<!-- 操作ボタン (sticky bottom) -->
<div class="action-section">
  <div class="container d-flex flex-wrap gap-2 justify-content-center">
    <button class="btn btn-approve btn-lg px-4" id="btnApprove" onclick="handleAction('approve')"${approvalDisabled ? ' disabled' : ''}>
      <i class="bi bi-check-circle me-1"></i>${isRefresh ? '更新を反映する' : 'このまま公開'}
    </button>
    <button class="btn btn-revise btn-lg px-4" id="btnRevise" onclick="toggleRevise()">
      <i class="bi bi-pencil me-1"></i>差し戻し
    </button>
    <button class="btn btn-skip btn-lg px-4" id="btnSkip" onclick="handleAction('skip')">
      <i class="bi bi-skip-forward me-1"></i>今回は見送り
    </button>
    ${isRefresh ? '' : `<button class="btn btn-outline-danger btn-lg px-4" id="btnSkipForever" onclick="handleAction('skip', true)" title="このテーマを今後生成しない設定にしたうえで見送る">
      <i class="bi bi-slash-circle me-1"></i>見送り＋今後このテーマを生成しない
    </button>`}
  </div>
</div>

<script>
const FILENAME = ${JSON.stringify(filename)};
const REF = ${JSON.stringify(ref || '')};
const IS_REFRESH = ${JSON.stringify(isRefresh)};
const FUNC_BASE = '/.netlify/functions';

function toggleRevise() {
  const card = document.getElementById('commentCard');
  card.classList.toggle('show');
  if (card.classList.contains('show')) {
    document.getElementById('reviewComment').focus();
    // ボタンテキストを「送信」に変更
    const btn = document.getElementById('btnRevise');
    if (btn.textContent.includes('差し戻し')) {
      btn.innerHTML = '<i class="bi bi-send me-1"></i>コメントを送信';
      btn.onclick = function() { handleAction('revise'); };
    }
  }
}

async function handleAction(action, forceSuppress) {
  const publishInput = document.getElementById('publishAt');
  const publishAt = publishInput ? publishInput.value : '';
  const comment   = document.getElementById('reviewComment').value;
  const resultEl  = document.getElementById('resultMsg');
  const suppressCheckbox = document.getElementById('suppressTopic');
  const suppress_topic = (suppressCheckbox && suppressCheckbox.checked) || forceSuppress === true;

  // 差し戻し時はコメント必須
  if (action === 'revise' && !comment.trim()) {
    resultEl.className = 'result-msg show error';
    resultEl.textContent = '修正コメントを入力してください。';
    return;
  }

  // 「今後生成しない」が選ばれている時は確認ダイアログ
  if (suppress_topic) {
    if (!confirm('このテーマを今後生成しない設定にします（denylist に追加されます）。よろしいですか？')) {
      return;
    }
  }

  // ボタン無効化
  document.querySelectorAll('.action-section button').forEach(b => b.disabled = true);

  try {
    // approve のみバックグラウンド関数（最大15分）にルーティングし、
    // mergeable 待機 + マージリトライが Netlify の 10秒制限に阻まれないようにする。
    // バックグラウンド関数は 202 Accepted を即返すため、結果は Chatwork 通知で受け取る。
    const endpoint = action === 'approve' ? '/review-approve-background' : '/review-' + action;
    const res = await fetch(FUNC_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: FILENAME, publish_at: publishAt, comment,
        ref: REF || undefined,
        suppress_topic: suppress_topic,
      }),
    });

    // 202 Accepted (background function) はボディが空なので JSON 解析を試みない
    const data = res.status === 202 ? {} : await res.json().catch(() => ({}));
    if (res.ok) {
      resultEl.className = 'result-msg show success';
      const suppressNote = (data.denylistAdded && data.denylistAdded.length > 0)
        ? '\\n※このテーマは今後生成しない設定に登録しました（' + data.denylistAdded.length + ' 件）。再生成も自動でスキップされます。'
        : '';
      if (action === 'approve') {
        resultEl.textContent = IS_REFRESH
          ? '公開中の記事へ反映しています。数分後にサイトに出ます。'
          : '公開処理を受け付けました。PRの自動マージ（最大1分程度かかります）と公開完了通知をChatworkでお知らせします。';
      } else if (action === 'revise') {
        resultEl.textContent = '差し戻しを受け付けました。AIが記事を再生成中です。完了後にChatworkで通知します。' + suppressNote;
      } else if (action === 'skip') {
        resultEl.textContent = '見送りにしました。PRは自動でクローズされます。' + suppressNote;
      } else {
        resultEl.textContent = (data.message || '処理が完了しました。') + suppressNote;
      }
    } else {
      throw new Error(data.error || 'エラーが発生しました。');
    }
  } catch (err) {
    resultEl.className = 'result-msg show error';
    resultEl.textContent = err.message;
    document.querySelectorAll('.action-section button').forEach(b => b.disabled = false);
  }
}
</script>

</body>
</html>`;
}

// ── Netlify Function Handler ─────────────────────────────────────────
exports.handler = async (event) => {
  // GET のみ
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const params = event.queryStringParameters || {};
  const filename = params.file;
  const ref = params.ref || '';   // draft ブランチ名（省略時は main）

  if (!filename || !/^[\w-]+\.md$/.test(filename)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<h1>400 Bad Request</h1><p>クエリパラメータ <code>?file=ファイル名.md</code> を指定してください。</p>',
    };
  }

  try {
    let raw;
    if (ref) {
      // ref が明示されていれば必ずその ref から取得する。
      //
      // 以前はローカル読み込みを無条件に優先していたため、記事が main にも
      // 存在する場合（公開済み・マージ済みの記事を差し戻して直しているとき）に
      // ローカル読み込みが成功してしまい、ref が黙って無視されていた。
      // その結果、下書きブランチの修正版を見に行ったつもりで main の
      // 修正前の本文が表示された（2026-08-17 に発生）。
      // 「ローカル優先」は netlify dev のためのものなので、ref 指定時は使わない。
      assertGitHubCredentials();
      raw = await fetchPostFromGitHub(filename, ref);
    } else {
      try {
        // ローカルファイルがあればそちらを優先（netlify dev 用）
        raw = fetchPostLocal(filename);
      } catch {
        // ローカルになければ GitHub App 認証つき API で取得
        // 認証情報が無い場合は無認証 fallback せず明確なエラーにする
        assertGitHubCredentials();
        raw = await fetchPostFromGitHub(filename, undefined);
      }
    }
    const { meta, body } = parseFrontmatter(raw);

    // Markdown → HTML 変換（marked + GFM テーブル対応）
    const { marked } = require('marked');
    const bodyHtml = marked(body)
      .replace(/<table>/g, '<div class="table-wrapper"><table>')
      .replace(/<\/table>/g, '</table></div>');

    let refreshContext = null;
    if (meta.refresh_of === 'published' || ref.startsWith('draft/refresh-')) {
      try {
        const mainRaw = await fetchPostFromGitHub(filename, 'main');
        const mainArticle = parseFrontmatter(mainRaw);
        if (mainArticle.meta.review_status !== 'published') {
          refreshContext = { available: false, message: '公開中ではなくなった記事です。更新案を承認できません。' };
        } else {
          refreshContext = {
            available: true,
            diff: freshnessRefresh.diffSections(mainArticle.body, body),
          };
        }
      } catch (_) {
        refreshContext = { available: false, message: '公開中の記事を取得できませんでした。更新案を承認できません。' };
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: renderReviewPage(filename, meta, bodyHtml, ref, refreshContext, await fetchFactCheck(meta.slug, ref, body)),
    };
  } catch (err) {
    const msg = String(err && err.message || err);
    // 秘密情報をログに出さないため、token / 秘密鍵は含めない（err.message は GitHub の応答のみ）
    console.error('[review-page] error:', msg);

    // rate limit (403) の場合は分かりやすいメッセージにする
    const isRateLimit = /rate limit|API rate limit exceeded|\b403\b/.test(msg);
    const isAuthMissing = /credentials are missing/.test(msg);

    let statusCode = 500;
    let heading = '500 Error';
    let detail = msg;

    if (isRateLimit) {
      statusCode = 503;
      heading = '一時的にレビュー画面を表示できません';
      detail = 'GitHub API の制限に達しました。しばらく待ってから再度お試しください。' +
        '（本来は認証付きで呼び出すため通常は発生しません。継続する場合は GitHub App の認証設定をご確認ください）';
    } else if (isAuthMissing) {
      statusCode = 500;
      heading = 'GitHub 認証が未設定です';
      detail = 'GitHub App の認証情報（GH_APP_ID / GH_APP_PRIVATE_KEY / GH_APP_INSTALLATION_ID）が' +
        'Netlify 環境変数に設定されていません。設定後に再度お試しください。';
    }

    return {
      statusCode,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">` +
            `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
            `<title>${heading}</title>` +
            `<style>body{font-family:'Noto Sans JP',sans-serif;background:#f5f5f5;padding:2rem;color:#2c2c2c;}` +
            `.box{max-width:640px;margin:2rem auto;background:#fff;border-radius:12px;padding:2rem;` +
            `box-shadow:0 2px 12px rgba(0,0,0,0.08);border-left:4px solid #c62828;}` +
            `h1{font-size:1.2rem;color:#0B2045;}p{line-height:1.8;font-size:.95rem;color:#5a6572;}</style></head>` +
            `<body><div class="box"><h1>${heading}</h1><p>${detail}</p></div></body></html>`,
    };
  }
};

exports.renderReviewPage = renderReviewPage;
exports.parseFrontmatter = parseFrontmatter;
exports.renderFactCheck = renderFactCheck;
exports.fetchFactCheck = fetchFactCheck;
