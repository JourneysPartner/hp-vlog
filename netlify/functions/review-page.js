'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * review-page — レビュー画面を動的生成する Netlify Function
 *
 * GET /.netlify/functions/review-page?file=2026-04-04-slug.md
 *   → content/posts/{file} を GitHub API 経由で取得し、レビューUIを返す
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

// ── GitHub API で content/posts/{file} を取得 ────────────────────────
// ref: 省略時は GITHUB_BRANCH (デフォルト main)
async function fetchPostFromGitHub(filename, ref) {
  const repo  = process.env.GITHUB_REPO  || 'JourneysPartner/hp-vlog';
  const branch = ref || process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;

  const url = `https://api.github.com/repos/${repo}/contents/content/posts/${encodeURIComponent(filename)}?ref=${encodeURIComponent(branch)}`;
  const headers = { 'Accept': 'application/vnd.github.v3.raw', 'User-Agent': 'mori-tax-review' };
  if (token) headers['Authorization'] = `token ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.text();
}

// ── HTML テンプレート ─────────────────────────────────────────────────
function renderReviewPage(filename, meta, bodyMd, ref) {
  const title      = meta.title      || '（タイトル未設定）';
  const summary    = meta.summary    || '';
  const sourceUrl  = meta.source_url || '';
  const sourceTitle = meta.source_title || sourceUrl;
  const previewUrl = meta.preview_url || '';
  const publishAt  = meta.publish_at || '';
  const status     = meta.review_status || 'needs_review';
  const category   = meta.category   || '';

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

  <!-- メタ情報カード -->
  <div class="card mb-4">
    <div class="card-body">
      <h2 class="h5 mb-3">${title}</h2>
      <table class="table table-sm meta-table mb-0">
        <tbody>
          <tr><th>カテゴリ</th><td>${category}</td></tr>
          <tr><th>要約</th><td>${summary}</td></tr>
          <tr>
            <th>出典URL</th>
            <td>${sourceUrl ? `<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceTitle} <i class="bi bi-box-arrow-up-right"></i></a>` : '（未設定）'}</td>
          </tr>
          <tr>
            <th>プレビューURL</th>
            <td>${previewUrl ? `<a href="${previewUrl}" target="_blank" rel="noopener">${previewUrl} <i class="bi bi-box-arrow-up-right"></i></a>` : '（未設定）'}</td>
          </tr>
          <tr>
            <th>公開日時（任意）</th>
            <td>
              <input type="datetime-local" id="publishAt" class="form-control form-control-sm" style="max-width:280px"
                value="${publishAt ? publishAt.replace(/\+.*$/, '').replace('T', 'T') : ''}">
              <small class="text-muted">未入力の場合は翌日 11:30 に自動設定されます</small>
            </td>
          </tr>
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
      <div class="form-check mt-3">
        <input class="form-check-input" type="checkbox" id="suppressTopic">
        <label class="form-check-label" for="suppressTopic">
          このテーマを<strong>今後生成しない</strong>（denylist に追加 / 再生成もスキップ）
        </label>
      </div>
      <div class="form-text">
        コメントに「今後…書かないでください」「もう生成しないでください」等の文言があれば、自動で禁止登録されます。
      </div>
    </div>
  </div>

  <!-- 結果メッセージ -->
  <div class="result-msg" id="resultMsg"></div>
</div>

<!-- 操作ボタン (sticky bottom) -->
<div class="action-section">
  <div class="container d-flex flex-wrap gap-2 justify-content-center">
    <button class="btn btn-approve btn-lg px-4" id="btnApprove" onclick="handleAction('approve')">
      <i class="bi bi-check-circle me-1"></i>このまま公開
    </button>
    <button class="btn btn-revise btn-lg px-4" id="btnRevise" onclick="toggleRevise()">
      <i class="bi bi-pencil me-1"></i>差し戻し
    </button>
    <button class="btn btn-skip btn-lg px-4" id="btnSkip" onclick="handleAction('skip')">
      <i class="bi bi-skip-forward me-1"></i>今回は見送り
    </button>
    <button class="btn btn-outline-danger btn-lg px-4" id="btnSkipForever" onclick="handleAction('skip', true)" title="このテーマを今後生成しない設定にしたうえで見送る">
      <i class="bi bi-slash-circle me-1"></i>見送り＋今後このテーマを生成しない
    </button>
  </div>
</div>

<script>
const FILENAME = ${JSON.stringify(filename)};
const REF = ${JSON.stringify(ref || '')};
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
  const publishAt = document.getElementById('publishAt').value;
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
        resultEl.textContent = '公開処理を受け付けました。PRの自動マージ（最大1分程度かかります）と公開完了通知をChatworkでお知らせします。';
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
    try {
      // ローカルファイルがあればそちらを優先（netlify dev 用）
      raw = fetchPostLocal(filename);
    } catch {
      // ローカルになければ GitHub API フォールバック（ref 指定対応）
      raw = await fetchPostFromGitHub(filename, ref || undefined);
    }
    const { meta, body } = parseFrontmatter(raw);

    // Markdown → HTML 変換（marked + GFM テーブル対応）
    const { marked } = require('marked');
    const bodyHtml = marked(body)
      .replace(/<table>/g, '<div class="table-wrapper"><table>')
      .replace(/<\/table>/g, '</table></div>');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: renderReviewPage(filename, meta, bodyHtml, ref),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<h1>500 Error</h1><p>${err.message}</p>`,
    };
  }
};
