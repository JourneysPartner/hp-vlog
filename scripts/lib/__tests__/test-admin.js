'use strict';

/**
 * 管理画面・管理APIの認証および挙動テスト。
 * 実際の GitHub API は呼ばないため、モック / 環境変数だけで検証可能な範囲を確認する。
 *   node scripts/lib/__tests__/test-admin.js
 */

const path = require('path');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const ROOT = path.join(__dirname, '..', '..', '..');
const ORIGIN = 'https://mori-zeirishi.net';
const BASIC = 'Basic ' + Buffer.from('試験用の自動処理ID:試験用の自動処理パスワード').toString('base64');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

function clearEnv() {
  delete process.env.ADMIN_BASIC_USER;
  delete process.env.ADMIN_BASIC_PASS;
  delete process.env.REVIEW_PASSWORD;
  delete process.env.REVIEW_SESSION_SECRET;
  delete process.env.CONTEXT;
}

function reload(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

(async () => {
  // ── 1. 設定不足は安全側（503、認証の小窓なし） ──────────────────
  console.log('\n=== Test 1: 設定不足は503・認証の小窓なし ===');
  clearEnv();
  let adminAuth = reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js'));
  let { requireAdminPage } = adminAuth;
  const r1 = requireAdminPage({ httpMethod: 'GET', headers: {} }, '/admin/articles');
  assert(r1.response && r1.response.statusCode === 503, 'env未設定時は503');
  assert(r1.response && !r1.response.headers['WWW-Authenticate'], '認証の小窓を付けない');

  // ── 2. セッション無し → 401 のログイン画面 ──────────────────────
  console.log('\n=== Test 2: セッション無し → 401 ログイン画面 ===');
  authenticatedEvent({});
  adminAuth = reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js'));
  ({ requireAdminPage } = adminAuth);
  const r2 = requireAdminPage({ httpMethod: 'GET', headers: {} }, '/admin/articles');
  assert(r2.response && r2.response.statusCode === 401, 'セッション無しは401');
  assert(r2.response && r2.response.body.includes('管理画面にログイン'), 'ログイン画面を出す');
  assert(r2.response && !r2.response.headers['WWW-Authenticate'], '認証の小窓を付けない');

  // ── 3. 不正フォーマットの Authorization → 通らない ─────────────
  console.log('\n=== Test 3: Authorization が Basic でなくても通らない ===');
  const r3 = requireAdminPage({ httpMethod: 'GET', headers: { authorization: 'Bearer 試験用の値' } }, '/admin/articles');
  assert(r3.response && r3.response.statusCode === 401, 'Bearerトークンは401');

  // ── 4. 誤った Basic → 通らない ─────────────────────────────────
  console.log('\n=== Test 4: 誤った Basic → 通らない ===');
  const wrong = 'Basic ' + Buffer.from('試験用の自動処理ID:違うパスワード').toString('base64');
  const r4 = requireAdminPage({ httpMethod: 'GET', headers: { authorization: wrong } }, '/admin/articles');
  assert(r4.response && r4.response.statusCode === 401, '誤PWは401');

  // ── 5. 正しい Basic が通るのは読み取りの自動処理用だけ ──────────
  console.log('\n=== Test 5: 正しい Basic は自動処理用の読み取りだけ ===');
  process.env.ADMIN_BASIC_USER = '試験用の自動処理ID';
  process.env.ADMIN_BASIC_PASS = '試験用の自動処理パスワード';
  const r5 = requireAdminPage({ httpMethod: 'GET', headers: { authorization: BASIC } }, '/admin/articles');
  assert(r5.response && r5.response.statusCode === 401, '画面は Basic では通らない');
  const { requireAnalyticsRead } = adminAuth;
  const analytics = await requireAnalyticsRead({ httpMethod: 'GET', headers: { authorization: BASIC, host: 'mori-zeirishi.net' } });
  assert(!analytics.response, '自動処理用の読み取りは Basic で通る');
  const analyticsWithRawUrl = await requireAnalyticsRead({
    httpMethod: 'GET',
    rawUrl: 'https://mori-zeirishi.net/admin/api/analytics',
    headers: { authorization: BASIC, host: 'mori-zeirishi.net' },
  });
  assert(!analyticsWithRawUrl.response, '本番の住所の rawUrl なら通る');

  // ── 6. ID の大文字小文字を区別 ────────────────────────────────
  console.log('\n=== Test 6: 大文字小文字区別 ===');
  const wrongCase = 'Basic ' + Buffer.from('試験用の自動処理id:試験用の自動処理パスワード').toString('base64');
  const r6 = await requireAnalyticsRead({ httpMethod: 'GET', headers: { authorization: wrongCase, host: 'mori-zeirishi.net' } });
  assert(r6.response && r6.response.statusCode === 401, '大文字小文字を区別');

  // ── 7. admin-articles-page: セッション無し → 401、ログイン後 → 200 ──
  console.log('\n=== Test 7: admin-articles-page セッション無し → 401 ===');
  const pageFn = reload(path.join(ROOT, 'netlify/functions/admin-articles-page.js'));
  const p1 = await pageFn.handler({ httpMethod: 'GET', headers: {} });
  assert(p1.statusCode === 401, 'セッション無しHTMLは401');
  assert(!p1.headers['WWW-Authenticate'], '認証の小窓を付けない');

  const p2 = await pageFn.handler(authenticatedEvent({ httpMethod: 'GET' }));
  assert(p2.statusCode === 200, 'ログイン後は200');
  assert(p2.body && p2.body.includes('記事管理画面'), 'タイトルが含まれる');
  assert(p2.body && p2.body.includes('/admin/api/list'), 'list APIへのfetchがある');
  assert(p2.body && p2.body.includes('/admin/api/change'), 'change APIへのfetchがある');
  assert(p2.body && p2.body.includes('未公開にする'), '未公開ボタンの表示文言');
  assert(p2.body && p2.body.includes('公開予約を取り消す'), '取消ボタンの表示文言');
  assert(p2.body && p2.body.includes('confirm'), '確認ダイアログ呼び出しが含まれる');

  // ── 8. admin-list-articles: セッション無し → 401 ────────────────
  console.log('\n=== Test 8: admin-list-articles セッション無し → 401 ===');
  const listFn = reload(path.join(ROOT, 'netlify/functions/admin-list-articles.js'));
  const l1 = await listFn.handler({ httpMethod: 'GET', headers: {} });
  assert(l1.statusCode === 401, 'セッション無し list APIは401');
  assert(!l1.headers['WWW-Authenticate'], '認証の小窓を付けない');

  // ログイン済み + GETでない → 405（中身には進まない）
  const l2 = await listFn.handler(authenticatedEvent({ httpMethod: 'POST' }));
  assert(l2.statusCode === 405, 'POSTでは405');

  // ── 9. admin-change-article-status: セッション無し → 401 ────────
  console.log('\n=== Test 9: admin-change-article-status セッション無し → 401 ===');
  const changeFn = reload(path.join(ROOT, 'netlify/functions/admin-change-article-status.js'));

  const c1 = await changeFn.handler({
    httpMethod: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  });
  assert(c1.statusCode === 401, 'セッション無し変更APIは401');

  const c2 = await changeFn.handler(authenticatedEvent({ httpMethod: 'GET', body: '' }));
  assert(c2.statusCode === 405, 'GETは405');

  // ログイン済み + 不正な action
  const c3 = await changeFn.handler(authenticatedEvent({
    httpMethod: 'POST',
    body: JSON.stringify({ filename: 'test.md', action: 'evil_action' }),
  }));
  assert(c3.statusCode === 400, '不正actionは400');

  // ログイン済み + filename 不正（path traversal対策）
  const c4 = await changeFn.handler(authenticatedEvent({
    httpMethod: 'POST',
    body: JSON.stringify({ filename: '../secrets.env', action: 'unpublish' }),
  }));
  assert(c4.statusCode === 400, 'path traversal は400');

  // ログイン済み + filename / action 不足
  const c5 = await changeFn.handler(authenticatedEvent({
    httpMethod: 'POST',
    body: '{}',
  }));
  assert(c5.statusCode === 400, '必須項目欠落は400');

  // ── 10. 候補画面: 保存の 401 は再読み込みせず、理由を出す ────────
  console.log('\n=== Test 10: 候補画面の保存の401は再読み込みしない ===');
  const candidatesPage = reload(path.join(ROOT, 'netlify/functions/admin-candidates-page.js'));
  const cp = await candidatesPage.handler(authenticatedEvent({ httpMethod: 'GET' }));
  assert(cp.statusCode === 200, '候補画面は200');
  const doSave = cp.body.slice(cp.body.indexOf('async function doSave()'), cp.body.indexOf('function setIndicator'));
  assert(doSave.includes('ログインが切れたため保存していません。ページを開き直してログインしてください。'), '保存の401で理由を出す');
  assert(!doSave.includes('location.reload()'), '保存の道では再読み込みしない');
  assert(doSave.includes("throw new Error('SESSION_EXPIRED')"), '保存の401は専用の印で失敗の扱いへ回す');
  const init = cp.body.slice(cp.body.indexOf('async function init()'), cp.body.indexOf('// ── フィルタオプション組み立て'));
  assert(init.includes('location.reload()'), '一覧の読み込みの401は今までどおり再読み込みする');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
