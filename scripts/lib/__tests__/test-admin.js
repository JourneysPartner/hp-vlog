'use strict';

/**
 * 管理画面・管理APIの認証および挙動テスト。
 * 実際の GitHub API は呼ばないため、モック / 環境変数だけで検証可能な範囲を確認する。
 *   node scripts/lib/__tests__/test-admin.js
 */

const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

function clearEnv() {
  delete process.env.ADMIN_BASIC_USER;
  delete process.env.ADMIN_BASIC_PASS;
}

function reload(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

(async () => {
  // ── 1. admin-auth: 環境変数未設定で 503 ──────────────────────────
  console.log('\n=== Test 1: admin-auth.requireBasicAuth env未設定で503 ===');
  clearEnv();
  let { requireBasicAuth } = reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js'));
  const r1 = requireBasicAuth({ headers: {} });
  assert(r1 && r1.statusCode === 503, 'env未設定時は503');

  // ── 2. admin-auth: 認証ヘッダなし → 401 + WWW-Authenticate ──────
  console.log('\n=== Test 2: 認証ヘッダなし → 401 ===');
  process.env.ADMIN_BASIC_USER = 'admin';
  process.env.ADMIN_BASIC_PASS = 's3cret';
  ({ requireBasicAuth } = reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js')));
  const r2 = requireBasicAuth({ headers: {} });
  assert(r2 && r2.statusCode === 401, '認証ヘッダなしは401');
  assert(r2 && r2.headers && r2.headers['WWW-Authenticate'], 'WWW-Authenticate ヘッダ付与');

  // ── 3. admin-auth: 不正フォーマット → 401 ────────────────────────
  console.log('\n=== Test 3: 不正フォーマット → 401 ===');
  const r3 = requireBasicAuth({ headers: { authorization: 'Bearer xxx' } });
  assert(r3 && r3.statusCode === 401, 'Bearerトークンは401');

  // ── 4. admin-auth: 誤った認証 → 401 ──────────────────────────────
  console.log('\n=== Test 4: 誤PW → 401 ===');
  const wrong = Buffer.from('admin:wrong').toString('base64');
  const r4 = requireBasicAuth({ headers: { authorization: 'Basic ' + wrong } });
  assert(r4 && r4.statusCode === 401, '誤PWは401');

  // ── 5. admin-auth: 正しい認証 → null ─────────────────────────────
  console.log('\n=== Test 5: 正しい認証 → 通過 ===');
  const ok = Buffer.from('admin:s3cret').toString('base64');
  const r5 = requireBasicAuth({ headers: { authorization: 'Basic ' + ok } });
  assert(r5 === null, '正しい認証は通過 (null)');

  // ── 6. admin-auth: user 大文字小文字を区別 ───────────────────────
  console.log('\n=== Test 6: 大文字小文字区別 ===');
  const wrongCase = Buffer.from('Admin:s3cret').toString('base64');
  const r6 = requireBasicAuth({ headers: { authorization: 'Basic ' + wrongCase } });
  assert(r6 && r6.statusCode === 401, '大文字小文字を区別');

  // ── 7. admin-articles-page: 認証なし → 401 ────────────────────────
  console.log('\n=== Test 7: admin-articles-page 認証なし → 401 ===');
  clearEnv();
  process.env.ADMIN_BASIC_USER = 'admin';
  process.env.ADMIN_BASIC_PASS = 's3cret';
  reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js'));
  const pageFn = reload(path.join(ROOT, 'netlify/functions/admin-articles-page.js'));
  const p1 = await pageFn.handler({ httpMethod: 'GET', headers: {} });
  assert(p1.statusCode === 401, '認証なしHTMLは401');

  const p2 = await pageFn.handler({ httpMethod: 'GET', headers: { authorization: 'Basic ' + ok } });
  assert(p2.statusCode === 200, '認証OKは200');
  assert(p2.body && p2.body.includes('記事管理画面'), 'タイトルが含まれる');
  assert(p2.body && p2.body.includes('/admin/api/list'), 'list APIへのfetchがある');
  assert(p2.body && p2.body.includes('/admin/api/change'), 'change APIへのfetchがある');
  assert(p2.body && p2.body.includes('未公開にする'), '未公開ボタンの表示文言');
  assert(p2.body && p2.body.includes('公開予約を取り消す'), '取消ボタンの表示文言');
  assert(p2.body && p2.body.includes('confirm'), '確認ダイアログ呼び出しが含まれる');

  // ── 8. admin-list-articles: 認証なし → 401 ────────────────────────
  console.log('\n=== Test 8: admin-list-articles 認証なし → 401 ===');
  reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js'));
  const listFn = reload(path.join(ROOT, 'netlify/functions/admin-list-articles.js'));
  const l1 = await listFn.handler({ httpMethod: 'GET', headers: {} });
  assert(l1.statusCode === 401, '認証なし list APIは401');

  // 認証あり + GETでない → 405
  const l2 = await listFn.handler({ httpMethod: 'POST', headers: { authorization: 'Basic ' + ok } });
  assert(l2.statusCode === 405, 'POSTでは405');

  // ── 9. admin-change-article-status: 認証なし → 401 ──────────────
  console.log('\n=== Test 9: admin-change-article-status 認証なし → 401 ===');
  reload(path.join(ROOT, 'netlify/functions/lib/admin-auth.js'));
  const changeFn = reload(path.join(ROOT, 'netlify/functions/admin-change-article-status.js'));

  const c1 = await changeFn.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert(c1.statusCode === 401, '認証なし変更APIは401');

  const c2 = await changeFn.handler({
    httpMethod: 'GET', headers: { authorization: 'Basic ' + ok }, body: ''
  });
  assert(c2.statusCode === 405, 'GETは405');

  // 認証あり + 不正な action
  const c3 = await changeFn.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Basic ' + ok },
    body: JSON.stringify({ filename: 'test.md', action: 'evil_action' }),
  });
  assert(c3.statusCode === 400, '不正actionは400');

  // 認証あり + filename 不正（path traversal対策）
  const c4 = await changeFn.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Basic ' + ok },
    body: JSON.stringify({ filename: '../secrets.env', action: 'unpublish' }),
  });
  assert(c4.statusCode === 400, 'path traversal は400');

  // 認証あり + filename / action 不足
  const c5 = await changeFn.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Basic ' + ok },
    body: '{}',
  });
  assert(c5.statusCode === 400, '必須項目欠落は400');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
