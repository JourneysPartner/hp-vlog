'use strict';

/**
 * Shared navigation for the authenticated admin pages.
 *
 * The component intentionally owns its markup and styles so it can be
 * embedded in pages with or without Bootstrap. Every selector is scoped to
 * .admin-nav; the host page's globals are not changed.
 */

const ADMIN_NAV_ITEMS = Object.freeze([
  { key: 'home', label: '管理トップ', href: '/admin', icon: '🏠' },
  { key: 'articles', label: '記事管理', href: '/admin/articles', icon: '📝' },
  { key: 'candidates', label: '候補管理', href: '/admin/candidates', icon: '💬' },
  { key: 'freshness', label: '更新候補', href: '/admin/freshness', icon: '🔄' },
  { key: 'analytics', label: 'アクセス解析', href: '/admin/analytics', icon: '📊' },
  { key: 'settings', label: 'HP設定', icon: '⚙️', disabled: true },
]);

const ADMIN_NAV_STYLE = `<style>
.admin-nav {
  background: #fff;
  border-bottom: 1px solid #dbe3ef;
  box-shadow: 0 1px 3px rgba(15, 23, 42, .08);
  color: #0b2045;
  font-family: -apple-system, BlinkMacSystemFont, "Noto Sans JP", sans-serif;
  overflow: hidden;
}
.admin-nav .admin-nav__scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.admin-nav .admin-nav__list {
  display: flex;
  flex-wrap: nowrap;
  gap: .35rem;
  list-style: none;
  margin: 0;
  min-width: max-content;
  padding: .45rem .75rem;
}
.admin-nav .admin-nav__item {
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
}
.admin-nav .admin-nav__link,
.admin-nav .admin-nav__disabled,
.admin-nav .admin-nav__logout {
  align-items: center;
  border: 1px solid transparent;
  border-radius: 999px;
  display: inline-flex;
  font-size: .84rem;
  gap: .35rem;
  line-height: 1.2;
  min-height: 2rem;
  padding: .4rem .75rem;
  text-decoration: none;
  white-space: nowrap;
}
.admin-nav .admin-nav__link {
  color: #0b2045;
}
.admin-nav .admin-nav__link:hover,
.admin-nav .admin-nav__link:focus-visible {
  background: #fff3ed;
  border-color: #e85320;
  color: #a93815;
  outline: none;
}
.admin-nav .admin-nav__link[aria-current="page"] {
  background: #0b2045;
  color: #fff;
}
.admin-nav .admin-nav__icon {
  font-size: 1rem;
  line-height: 1;
}
.admin-nav .admin-nav__disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
.admin-nav .admin-nav__status {
  background: #eef2f7;
  border-radius: 999px;
  font-size: .68rem;
  padding: .12rem .35rem;
}
.admin-nav .admin-nav__logout {
  background: none;
  color: #0b2045;
  cursor: pointer;
  font-family: inherit;
}
.admin-nav .admin-nav__logout:hover,
.admin-nav .admin-nav__logout:focus-visible {
  background: #fff3ed;
  border-color: #e85320;
  color: #a93815;
  outline: none;
}
.admin-nav .admin-nav__logout:disabled {
  cursor: wait;
  opacity: .6;
}
.admin-nav .admin-nav__error {
  color: #b42318;
  font-size: .78rem;
  margin-left: .35rem;
}
@media (max-width: 520px) {
  .admin-nav .admin-nav__list {
    padding-left: .5rem;
    padding-right: .5rem;
  }
  .admin-nav .admin-nav__link,
  .admin-nav .admin-nav__disabled,
  .admin-nav .admin-nav__logout {
    font-size: .8rem;
    padding-left: .65rem;
    padding-right: .65rem;
  }
}
</style>`;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// script の中に埋める値。`</script>` で抜けられないように < > & を変える。
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

// 各画面の nonce 付き script に埋めるログアウトの処理。属性には書かない。
// 埋める先の script に `const REVIEW_TOKEN = …` が必要。
const ADMIN_LOGOUT_SCRIPT = `const adminLogoutButton = document.getElementById('admin-logout');
if (adminLogoutButton) {
  adminLogoutButton.addEventListener('click', async () => {
    if (adminLogoutButton.disabled) return;
    adminLogoutButton.disabled = true;
    const adminLogoutError = document.getElementById('admin-nav-error');
    try {
      const response = await fetch('/review-logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Review-Token': REVIEW_TOKEN },
        body: '{}',
      });
      if (response.status === 200 || response.status === 401) { location.assign('/admin/articles'); return; }
      throw new Error('ログアウトできませんでした。');
    } catch (error) {
      if (adminLogoutError) adminLogoutError.textContent = error.message;
      adminLogoutButton.disabled = false;
    }
  });
}`;

function renderAdminNav(current) {
  const currentKey = String(current || '');
  const items = ADMIN_NAV_ITEMS.map((item) => {
    const icon = `<span class="admin-nav__icon" aria-hidden="true">${escapeHtml(item.icon)}</span>`;
    if (item.disabled) {
      return `<li class="admin-nav__item"><span class="admin-nav__disabled" aria-disabled="true">${icon}<span>${escapeHtml(item.label)}</span><span class="admin-nav__status">準備中</span></span></li>`;
    }
    const active = item.key === currentKey ? ' aria-current="page"' : '';
    return `<li class="admin-nav__item"><a class="admin-nav__link" href="${escapeHtml(item.href)}"${active}>${icon}<span>${escapeHtml(item.label)}</span></a></li>`;
  }).join('');
  const logout = '<li class="admin-nav__item"><button type="button" class="admin-nav__logout" id="admin-logout">ログアウト</button><span class="admin-nav__error" id="admin-nav-error" role="alert"></span></li>';

  return `${ADMIN_NAV_STYLE}<nav class="admin-nav" aria-label="管理メニュー"><div class="admin-nav__scroll"><ul class="admin-nav__list">${items}${logout}</ul></div></nav>`;
}

module.exports = { renderAdminNav, ADMIN_NAV_ITEMS, ADMIN_LOGOUT_SCRIPT, scriptJson };
