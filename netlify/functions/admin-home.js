'use strict';

const { requireBasicAuth } = require('./lib/admin-auth');
const { renderAdminNav, ADMIN_NAV_ITEMS } = require('./lib/admin-nav');

const DESCRIPTIONS = Object.freeze({
  articles: '記事の公開状態、予約、レビュー状況を確認・変更します。',
  candidates: '記事候補の内容を確認し、採用・除外を管理します。',
  analytics: '訪問者数、PV、人気ページなどのアクセス状況を確認します。',
  settings: 'サイト全体の設定を管理する予定です。',
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDashboardCards() {
  return ADMIN_NAV_ITEMS
    .filter((item) => item.key !== 'home')
    .map((item) => {
      const icon = `<span class="admin-dashboard__icon" aria-hidden="true">${escapeHtml(item.icon)}</span>`;
      const content = `${icon}<span class="admin-dashboard__card-body"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(DESCRIPTIONS[item.key])}</span></span>`;
      if (item.disabled) {
        return `<div class="admin-dashboard__card admin-dashboard__card--disabled" aria-disabled="true">${content}<span class="admin-dashboard__badge">準備中</span></div>`;
      }
      return `<a class="admin-dashboard__card" href="${escapeHtml(item.href)}">${content}<span class="admin-dashboard__arrow" aria-hidden="true">→</span></a>`;
    })
    .join('');
}

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>管理トップ｜毛利順活税理士事務所</title>
<style>
:root{--navy:#0b2045;--orange:#e85320;--line:#dbe3ef;--muted:#64748b;--bg:#f6f8fc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}
.admin-dashboard__header{background:var(--navy);color:#fff;padding:24px}
.admin-dashboard__header-inner{margin:0 auto;max-width:1100px}
.admin-dashboard__eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;margin:0 0 5px;opacity:.75;text-transform:uppercase}
.admin-dashboard__header h1{font-size:22px;margin:0}
.admin-dashboard__header p:last-child{font-size:13px;margin:7px 0 0;opacity:.82}
.admin-dashboard__main{margin:0 auto;max-width:1100px;padding:28px 16px 48px}
.admin-dashboard__main h2{font-size:18px;margin:0 0 6px}
.admin-dashboard__lead{color:var(--muted);font-size:13px;margin:0 0 20px}
.admin-dashboard__grid{display:grid;gap:14px;grid-template-columns:repeat(2,minmax(0,1fr))}
.admin-dashboard__card{align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;color:var(--navy);display:flex;gap:14px;min-height:118px;padding:20px;text-decoration:none;transition:border-color .16s,box-shadow .16s,transform .16s}
.admin-dashboard__card[href]:hover,.admin-dashboard__card[href]:focus-visible{border-color:var(--orange);box-shadow:0 8px 22px rgba(15,23,42,.1);outline:none;transform:translateY(-1px)}
.admin-dashboard__icon{font-size:30px;line-height:1}
.admin-dashboard__card-body{display:flex;flex:1;flex-direction:column;gap:6px}
.admin-dashboard__card-body strong{font-size:16px}
.admin-dashboard__card-body span{color:var(--muted);font-size:13px;line-height:1.55}
.admin-dashboard__arrow{color:var(--orange);font-size:22px;font-weight:700}
.admin-dashboard__card--disabled{background:#f8fafc;color:#94a3b8;cursor:not-allowed}
.admin-dashboard__badge{background:#e9eef5;border-radius:999px;color:#64748b;font-size:11px;font-weight:700;padding:4px 8px;white-space:nowrap}
@media(max-width:700px){.admin-dashboard__header{padding:20px 16px}.admin-dashboard__main{padding:22px 12px 36px}.admin-dashboard__grid{grid-template-columns:1fr}.admin-dashboard__card{min-height:105px;padding:17px}}
</style>
</head>
<body>
<header class="admin-dashboard__header">
  <div class="admin-dashboard__header-inner">
    <p class="admin-dashboard__eyebrow">Administration</p>
    <h1>管理トップ</h1>
    <p>各管理機能への入口です。</p>
  </div>
</header>
${renderAdminNav('home')}
<main class="admin-dashboard__main">
  <h2>管理メニュー</h2>
  <p class="admin-dashboard__lead">利用する機能を選択してください。</p>
  <section class="admin-dashboard__grid" aria-label="管理機能一覧">
    ${renderDashboardCards()}
  </section>
</main>
</body>
</html>`;

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: {
        Allow: 'GET',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=UTF-8',
      },
      body: 'Method Not Allowed\n',
    };
  }

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
