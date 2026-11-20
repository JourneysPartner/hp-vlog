'use strict';

const fs = require('fs');
const path = require('path');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const ROOT = path.join(__dirname, '..', '..', '..');
const FUNCTION_ROOT = path.join(ROOT, 'netlify', 'functions');
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL ${label}`);
    failed += 1;
  }
}

function count(haystack, needle) {
  return (haystack.match(new RegExp(needle, 'g')) || []).length;
}

(async () => {
  // ログインした状態の要求を作る手助けが、承認画面と同じ環境変数を用意する。
  authenticatedEvent({});

  const { renderAdminNav } = require(path.join(FUNCTION_ROOT, 'lib', 'admin-nav.js'));
  for (const key of ['home', 'articles', 'candidates', 'analytics']) {
    const html = renderAdminNav(key);
    const markup = html.slice(html.indexOf('<nav'));
    assert(count(markup, '<nav class="admin-nav"') === 1, `${key}: nav is rendered once`);
    assert(markup.includes('aria-label="管理メニュー"'), `${key}: nav landmark is labelled`);
    assert(count(markup, 'aria-current="page"') === 1, `${key}: exactly one active item`);
    assert(markup.includes('aria-hidden="true"'), `${key}: icon is hidden from assistive tech`);
    assert(markup.includes('HP設定') && markup.includes('準備中'), `${key}: settings placeholder is present`);
    assert(!markup.includes('/admin/settings'), `${key}: settings has no href`);
    assert(!/https?:\/\//.test(html), `${key}: nav has no external URL`);
    // A: ログアウトはボタンで、リンクの並びの最後に置く。
    assert(markup.includes('<button type="button" class="admin-nav__logout" id="admin-logout">ログアウト</button>'), `${key}: logout button is a plain button`);
    assert(markup.indexOf('id="admin-logout"') > markup.indexOf('/admin/analytics'), `${key}: logout comes after the links`);
    const hrefs = [...markup.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
    assert(JSON.stringify(hrefs) === JSON.stringify(['/admin', '/admin/articles', '/admin/candidates', '/admin/freshness', '/admin/analytics']), `${key}: link order is unchanged`);
    assert(!/<[^>]*\son\w+\s*=/i.test(html), `${key}: no inline event attribute`);
    assert(markup.includes('id="admin-nav-error"'), `${key}: failure message area exists`);
  }

  const adminHome = require(path.join(FUNCTION_ROOT, 'admin-home.js'));
  const unauth = await adminHome.handler({ httpMethod: 'GET', headers: {} });
  assert(unauth.statusCode === 401, 'admin-home: unauthenticated request is 401');
  assert(!(unauth.headers && unauth.headers['WWW-Authenticate']), 'admin-home: 401 has no browser challenge');
  assert((unauth.body || '').includes('<title>管理画面にログイン</title>'), 'admin-home: 401 shows the login page');

  const get = await adminHome.handler(authenticatedEvent({ httpMethod: 'GET' }));
  assert(get.statusCode === 200, 'admin-home: authenticated GET is 200');
  assert(get.headers && get.headers['Content-Type'].includes('text/html'), 'admin-home: response is HTML');
  assert(get.headers && get.headers['Cache-Control'] === 'no-store', 'admin-home: dashboard is not cached');
  assert(get.body && get.body.includes('<h1>管理トップ</h1>'), 'admin-home: dashboard title is present');
  assert(count(get.body || '', '<nav class="admin-nav"') === 1, 'admin-home: shared nav is injected once');
  const homeNav = get.body.slice(get.body.indexOf('<nav'), get.body.indexOf('</nav>') + 6);
  assert(count(homeNav, 'aria-current="page"') === 1, 'admin-home: only home is current in nav markup');
  assert(get.body && get.body.includes('href="/admin/articles"'), 'admin-home: articles card is present');
  assert(get.body && get.body.includes('href="/admin/candidates"'), 'admin-home: candidates card is present');
  assert(get.body && get.body.includes('href="/admin/analytics"'), 'admin-home: analytics card is present');
  assert(get.body && get.body.includes('HP設定') && get.body.includes('準備中'), 'admin-home: settings placeholder is present');

  const post = await adminHome.handler(authenticatedEvent({ httpMethod: 'POST' }));
  assert(post.statusCode === 405, 'admin-home: authenticated non-GET is 405');
  assert(post.headers && post.headers.Allow === 'GET', 'admin-home: 405 allows GET only');

  for (const [name, key] of [
    ['admin-articles-page.js', 'articles'],
    ['admin-candidates-page.js', 'candidates'],
    ['admin-analytics-page.js', 'analytics'],
  ]) {
    const page = require(path.join(FUNCTION_ROOT, name));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    assert(response.statusCode === 200, `${name}: authenticated GET is 200`);
    assert(count(response.body || '', '<nav class="admin-nav"') === 1, `${name}: nav is injected once`);
    assert((response.body || '').includes(`href="/admin/${key}"`), `${name}: current route is present`);
  }

  const netlifyToml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert(netlifyToml.includes('from = "/admin"'), 'netlify.toml: /admin route exists');
  assert(netlifyToml.includes('from = "/admin/"'), 'netlify.toml: /admin/ route exists');
  assert(netlifyToml.includes('to = "/.netlify/functions/admin-home"'), 'netlify.toml: admin routes target admin-home');

  console.log(`\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
