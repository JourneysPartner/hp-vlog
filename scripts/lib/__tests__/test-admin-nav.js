'use strict';

const fs = require('fs');
const path = require('path');

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

function authHeader(user = 'admin', pass = 's3cret') {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function count(haystack, needle) {
  return (haystack.match(new RegExp(needle, 'g')) || []).length;
}

(async () => {
  process.env.ADMIN_BASIC_USER = 'admin';
  process.env.ADMIN_BASIC_PASS = 's3cret';

  const { renderAdminNav } = require(path.join(FUNCTION_ROOT, 'lib', 'admin-nav.js'));
  for (const key of ['articles', 'candidates', 'analytics']) {
    const html = renderAdminNav(key);
    const markup = html.slice(html.indexOf('<nav'));
    assert(count(markup, '<nav class="admin-nav"') === 1, `${key}: nav is rendered once`);
    assert(markup.includes('aria-label="管理メニュー"'), `${key}: nav landmark is labelled`);
    assert(count(markup, 'aria-current="page"') === 1, `${key}: exactly one active item`);
    assert(markup.includes('aria-hidden="true"'), `${key}: icon is hidden from assistive tech`);
    assert(markup.includes('HP設定') && markup.includes('準備中'), `${key}: settings placeholder is present`);
    assert(!markup.includes('/admin/settings'), `${key}: settings has no href`);
    assert(!/https?:\/\//.test(html), `${key}: nav has no external URL`);
  }

  const adminHome = require(path.join(FUNCTION_ROOT, 'admin-home.js'));
  const unauth = await adminHome.handler({ httpMethod: 'GET', headers: {} });
  assert(unauth.statusCode === 401, 'admin-home: unauthenticated request is 401');
  assert(unauth.headers && unauth.headers['WWW-Authenticate'], 'admin-home: 401 has challenge');

  const get = await adminHome.handler({ httpMethod: 'GET', headers: { authorization: authHeader() } });
  assert(get.statusCode === 302, 'admin-home: authenticated GET is 302');
  assert(get.headers && get.headers.Location === '/admin/articles', 'admin-home: Location is articles');
  assert(get.headers && get.headers['Cache-Control'] === 'no-store', 'admin-home: redirect is not cached');
  assert(get.body === '', 'admin-home: redirect body is empty');

  const post = await adminHome.handler({ httpMethod: 'POST', headers: { authorization: authHeader() } });
  assert(post.statusCode === 405, 'admin-home: authenticated non-GET is 405');
  assert(post.headers && post.headers.Allow === 'GET', 'admin-home: 405 allows GET only');

  for (const [name, key] of [
    ['admin-articles-page.js', 'articles'],
    ['admin-candidates-page.js', 'candidates'],
    ['admin-analytics-page.js', 'analytics'],
  ]) {
    const page = require(path.join(FUNCTION_ROOT, name));
    const response = await page.handler({ httpMethod: 'GET', headers: { authorization: authHeader() } });
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
