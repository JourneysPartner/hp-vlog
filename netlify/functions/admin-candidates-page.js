'use strict';

/**
 * admin-candidates-page — 質疑応答事例 候補リスト管理画面
 *
 * GET /admin/candidates
 *
 * 必須認証: HTTP Basic
 *
 * テーブル形式の UI:
 *   - 番号 / 税目 / ペルソナ / タイトル / 原文リンク / 採用チェック
 *   - 列ヘッダクリックでソート
 *   - 税目・ペルソナ・採用済フィルタ
 *   - チェックボックス変更 → 1.5 秒 debounce で GitHub に commit
 *   - 保存中インジケータ
 */

const { requireBasicAuth } = require('./lib/admin-auth');

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>候補管理｜質疑応答事例｜毛利順活税理士事務所</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
<style>
  :root {
    --primary: #0B2045;
    --accent:  #E85320;
    --success: #1A9660;
    --warning: #F57F17;
    --danger:  #C62828;
    --muted:   #6b7280;
    --border:  #e2e8f0;
    --bg:      #f8f9fc;
  }
  html, body { height: 100%; }
  body { font-family: 'Noto Sans JP', sans-serif; background: var(--bg); color: #2c2c2c; margin: 0; }

  /* 固定ヘッダの高さは CSS 変数で一元管理（テーブル thead の sticky 計算に使用） */
  :root {
    --header-h: 48px;
    --filter-h: 48px;
    --stack-h:  96px;   /* header-h + filter-h */
  }

  .admin-header {
    background: var(--primary); color: #fff; padding: .75rem 1rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    position: sticky; top: 0; z-index: 50;
    height: var(--header-h);
    display: flex; align-items: center; justify-content: space-between;
    box-sizing: border-box;
  }
  .admin-header h1 { font-size: 1rem; margin: 0; font-weight: 700; }
  .admin-header .meta { font-size: .8rem; opacity: .9; }

  .filter-bar {
    background: #fff; padding: .6rem 1rem; border-bottom: 1px solid var(--border);
    display: flex; flex-wrap: wrap; gap: .5rem; align-items: center;
    position: sticky; top: var(--header-h); z-index: 49;
    min-height: var(--filter-h); box-sizing: border-box;
  }
  .filter-bar label { font-size: .82rem; color: var(--muted); margin-right: .3rem; }
  .filter-bar select, .filter-bar input[type="text"] {
    font-size: .85rem; padding: .25rem .5rem; border: 1px solid var(--border); border-radius: 6px;
  }
  .filter-bar .save-indicator { margin-left: auto; font-size: .82rem; color: var(--muted); }
  .filter-bar .save-indicator.saving { color: var(--warning); }
  .filter-bar .save-indicator.saved  { color: var(--success); }
  .filter-bar .save-indicator.error  { color: var(--danger); font-weight: 700; }

  .table-wrap {
    background: #fff; margin: 1rem; border-radius: 8px; overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.04);
  }
  table.candidates {
    width: 100%; border-collapse: separate; border-spacing: 0; font-size: .85rem;
  }
  /* <thead> ではなく各 <th> に sticky を適用（thead sticky はブラウザ互換性が悪い）。
     top はヘッダ + フィルタバー合計の var(--stack-h) で計算する。 */
  table.candidates thead th {
    background: var(--primary); color: #fff;
    position: sticky; top: var(--stack-h); z-index: 48;
    padding: .55rem .5rem; text-align: left; font-weight: 500; cursor: pointer; user-select: none;
    white-space: nowrap;
    box-shadow: inset 0 -1px 0 rgba(255,255,255,0.15);
  }
  table.candidates thead th:hover { background: #1a3268; }
  table.candidates th .sort-arrow { opacity: .5; font-size: .75rem; margin-left: 4px; }
  table.candidates th.sorted-asc  .sort-arrow::after { content: ' ▲'; opacity: 1; }
  table.candidates th.sorted-desc .sort-arrow::after { content: ' ▼'; opacity: 1; }

  table.candidates tbody tr { border-bottom: 1px solid var(--border); transition: background 80ms; }
  table.candidates tbody tr:hover { background: #f1f5fb; }
  table.candidates tbody tr.adopted { background: #effaf1; }
  table.candidates tbody tr.adopted:hover { background: #ddf3e1; }

  table.candidates td { padding: .5rem; vertical-align: top; }
  table.candidates td.num { color: var(--muted); width: 50px; text-align: right; }
  table.candidates td.score { width: 50px; text-align: right; font-weight: 700; color: var(--accent); }
  table.candidates td.tax { width: 90px; }
  table.candidates td.persona { width: 180px; font-size: .78rem; color: var(--muted); }
  table.candidates td.title { line-height: 1.4; }
  table.candidates td.link { width: 80px; }
  table.candidates td.link a { color: var(--accent); text-decoration: none; font-size: .82rem; }
  table.candidates td.link a:hover { text-decoration: underline; }
  table.candidates td.adopt { width: 60px; text-align: center; }
  table.candidates td.adopt input[type="checkbox"] {
    width: 20px; height: 20px; cursor: pointer; accent-color: var(--success);
  }

  .stats-bar {
    padding: .5rem 1rem; font-size: .82rem; color: var(--muted);
    background: #fff; border-bottom: 1px solid var(--border);
  }
  .stats-bar strong { color: var(--accent); font-size: .9rem; }

  .loading {
    text-align: center; padding: 3rem; color: var(--muted);
  }
  .empty {
    text-align: center; padding: 2rem; color: var(--muted); font-style: italic;
  }

  @media (max-width: 768px) {
    table.candidates td.persona { display: none; }
    table.candidates th[data-key="proposed_persona"] { display: none; }
  }
</style>
</head>
<body>
<header class="admin-header">
  <h1><i class="bi bi-check2-square"></i> 候補管理｜質疑応答事例</h1>
  <div class="meta" id="meta-info">読込中…</div>
</header>

<div class="filter-bar">
  <label>税目:</label>
  <select id="filter-tax">
    <option value="">全て</option>
  </select>

  <label>ペルソナ:</label>
  <select id="filter-persona">
    <option value="">全て</option>
  </select>

  <label>表示:</label>
  <select id="filter-adopted">
    <option value="all">すべて</option>
    <option value="adopted">採用済のみ</option>
    <option value="unadopted">未採用のみ</option>
  </select>

  <input type="text" id="filter-keyword" placeholder="タイトル検索..." style="min-width: 200px;">

  <span class="save-indicator" id="save-indicator">準備中…</span>
</div>

<div class="stats-bar" id="stats-bar">読込中…</div>

<div class="table-wrap">
  <table class="candidates">
    <thead>
      <tr>
        <th data-key="idx">#<span class="sort-arrow"></span></th>
        <th data-key="score">スコア<span class="sort-arrow"></span></th>
        <th data-key="tax_category">税目<span class="sort-arrow"></span></th>
        <th data-key="proposed_persona">ペルソナ<span class="sort-arrow"></span></th>
        <th data-key="shitsugi_title">タイトル<span class="sort-arrow"></span></th>
        <th>原文</th>
        <th data-key="adopted">採用<span class="sort-arrow"></span></th>
      </tr>
    </thead>
    <tbody id="tbody">
      <tr><td colspan="7" class="loading">読込中…</td></tr>
    </tbody>
  </table>
</div>

<script>
'use strict';
(() => {
  const API_LIST = '/admin/api/candidates/list';
  const API_SAVE = '/admin/api/candidates/save';

  const PERSONA_LABELS = {
    ebay_export_seller:          'eBay 輸出セラー',
    domestic_ec_seller:          '国内 EC セラー',
    reseller_marketplace_seller: 'フリマ・転売',
    influencer_creator:          'インフルエンサー',
    beauty_salon_owner:          'サロン',
    inheritance_client:          '相続・贈与',
  };

  let state = {
    sha: null,
    candidates: [],
    sortKey: 'score',
    sortDir: 'desc',
    filterTax: '',
    filterPersona: '',
    filterAdopted: 'all',
    filterKeyword: '',
    pendingUpdates: {},  // shitsugi_url → { adopted, adoption_note }
    saveTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  // ── 初期化 ──────────────────────────────────────────────────
  async function init() {
    setIndicator('loading', '読込中…');
    try {
      const res = await fetch(API_LIST);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.sha = data.sha;
      state.candidates = data.candidates;
      $('meta-info').textContent =
        '全 ' + data.candidates.length + ' 件　最終生成 ' +
        (data.generated_at ? data.generated_at.slice(0, 10) : '?');
      buildFilterOptions();
      render();
      setIndicator('saved', '保存済');
    } catch (e) {
      $('tbody').innerHTML = '<tr><td colspan="7" class="loading">読込失敗: ' + e.message + '</td></tr>';
      setIndicator('error', '読込失敗');
    }
  }

  // ── フィルタオプション組み立て ──────────────────────────────
  function buildFilterOptions() {
    const taxes = [...new Set(state.candidates.map(c => c.tax_category).filter(Boolean))].sort();
    const personas = [...new Set(state.candidates.map(c => c.proposed_persona).filter(Boolean))].sort();
    const taxSel = $('filter-tax');
    const personaSel = $('filter-persona');
    for (const t of taxes)     taxSel.add(new Option(t, t));
    for (const p of personas)  personaSel.add(new Option(PERSONA_LABELS[p] || p, p));
  }

  // ── レンダリング ────────────────────────────────────────────
  function render() {
    const filtered = applyFilters(state.candidates);
    const sorted = applySorting(filtered);
    updateStats(filtered);
    updateSortArrows();
    renderTable(sorted);
  }

  function applyFilters(items) {
    return items.filter(c => {
      if (state.filterTax && c.tax_category !== state.filterTax) return false;
      if (state.filterPersona && c.proposed_persona !== state.filterPersona) return false;
      if (state.filterAdopted === 'adopted' && !c.adopted) return false;
      if (state.filterAdopted === 'unadopted' && c.adopted) return false;
      if (state.filterKeyword) {
        const kw = state.filterKeyword.toLowerCase();
        if (!(c.shitsugi_title || '').toLowerCase().includes(kw)) return false;
      }
      return true;
    });
  }

  function applySorting(items) {
    const k = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      if (typeof va === 'boolean' && typeof vb === 'boolean') return ((va ? 1 : 0) - (vb ? 1 : 0)) * dir;
      return String(va).localeCompare(String(vb), 'ja') * dir;
    });
  }

  function updateStats(filtered) {
    const total = state.candidates.length;
    const adopted = state.candidates.filter(c => c.adopted).length;
    const visible = filtered.length;
    $('stats-bar').innerHTML =
      '全 <strong>' + total + '</strong> 件、' +
      '採用済 <strong>' + adopted + '</strong> 件、' +
      '表示中 <strong>' + visible + '</strong> 件';
  }

  function updateSortArrows() {
    document.querySelectorAll('th[data-key]').forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.key === state.sortKey) {
        th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  function renderTable(items) {
    const tbody = $('tbody');
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">該当する候補がありません</td></tr>';
      return;
    }
    const html = items.map(c => {
      const personaLabel = PERSONA_LABELS[c.proposed_persona] || c.proposed_persona || '-';
      const rowClass = c.adopted ? 'adopted' : '';
      const safeUrl = (c.shitsugi_url || '').replace(/"/g, '&quot;');
      const safeTitle = escapeHtml(c.shitsugi_title || '');
      return '<tr class="' + rowClass + '" data-url="' + safeUrl + '">' +
        '<td class="num">' + c.idx + '</td>' +
        '<td class="score">' + c.score + '</td>' +
        '<td class="tax">' + escapeHtml(c.tax_category || '') + '</td>' +
        '<td class="persona">' + escapeHtml(personaLabel) + '</td>' +
        '<td class="title">' + safeTitle + '</td>' +
        '<td class="link"><a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">原文 <i class="bi bi-box-arrow-up-right"></i></a></td>' +
        '<td class="adopt"><input type="checkbox" data-url="' + safeUrl + '"' + (c.adopted ? ' checked' : '') + '></td>' +
      '</tr>';
    }).join('');
    tbody.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
  }

  // ── イベントハンドラ ────────────────────────────────────────
  document.querySelectorAll('th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (state.sortKey === k) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = k;
        state.sortDir = (k === 'idx' || k === 'shitsugi_title' || k === 'tax_category' || k === 'proposed_persona') ? 'asc' : 'desc';
      }
      render();
    });
  });

  ['filter-tax', 'filter-persona', 'filter-adopted'].forEach(id => {
    $(id).addEventListener('change', () => {
      state['filter' + id.split('-')[1].replace(/^./, c => c.toUpperCase())] = $(id).value;
      render();
    });
  });
  // 上の split マッピングが分かりづらいので明示的に再設定
  $('filter-tax').addEventListener('change', () => { state.filterTax = $('filter-tax').value; render(); });
  $('filter-persona').addEventListener('change', () => { state.filterPersona = $('filter-persona').value; render(); });
  $('filter-adopted').addEventListener('change', () => { state.filterAdopted = $('filter-adopted').value; render(); });
  $('filter-keyword').addEventListener('input', () => { state.filterKeyword = $('filter-keyword').value; render(); });

  // チェックボックス変更 → イベント委譲
  $('tbody').addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
    const url = cb.dataset.url;
    const adopted = cb.checked;
    // local state 更新
    const cand = state.candidates.find(c => c.shitsugi_url === url);
    if (cand) cand.adopted = adopted;
    cb.closest('tr').classList.toggle('adopted', adopted);
    state.pendingUpdates[url] = { adopted };
    // 統計更新
    updateStats(applyFilters(state.candidates));
    scheduleSave();
  });

  // ── 保存（debounced） ──────────────────────────────────────
  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    setIndicator('saving', '変更あり…');
    state.saveTimer = setTimeout(doSave, 1500);
  }

  async function doSave() {
    state.saveTimer = null;
    if (Object.keys(state.pendingUpdates).length === 0) return;
    setIndicator('saving', '保存中…');
    const updates = state.pendingUpdates;
    state.pendingUpdates = {};
    try {
      const res = await fetch(API_SAVE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: state.sha, updates }),
      });
      const data = await res.json();
      if (res.status === 409) {
        // sha 競合 → 再 fetch して再試行
        setIndicator('saving', '競合検出、再取得中…');
        const reload = await fetch(API_LIST);
        const fresh = await reload.json();
        state.sha = fresh.sha;
        // pending を再投入
        for (const [url, u] of Object.entries(updates)) {
          state.pendingUpdates[url] = u;
        }
        scheduleSave();
        return;
      }
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      state.sha = data.sha;
      setIndicator('saved', '保存済（採用 ' + data.adopted_count + ' 件）');
    } catch (e) {
      setIndicator('error', '保存失敗: ' + e.message);
      // pending を戻す（次回保存で再試行）
      for (const [url, u] of Object.entries(updates)) {
        if (!state.pendingUpdates[url]) state.pendingUpdates[url] = u;
      }
    }
  }

  function setIndicator(cls, text) {
    const el = $('save-indicator');
    el.className = 'save-indicator ' + cls;
    el.textContent = text;
  }

  init();
})();
</script>
</body>
</html>
`;

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: HTML,
  };
};
