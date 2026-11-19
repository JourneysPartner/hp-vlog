'use strict';

/**
 * 管理画面 11 本の入口（セッション Cookie・合言葉・自動処理用の Basic）の試験。
 *
 *   node scripts/lib/__tests__/test-admin-auth.js
 *
 * GitHub・Blobs・時刻・待ち時間は偽のものに差し替える。認証の部品
 * （lib/review-auth.js）は差し替えず、実際の署名・検証を通した要求を作る。
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const reviewAuth = require('../../../netlify/functions/lib/review-auth');
const adminAuth = require('../../../netlify/functions/lib/admin-auth');
const GITHUB = require('../../../netlify/functions/lib/github-api');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const ROOT = path.join(__dirname, '..', '..', '..');
const FUNCTIONS = path.join(ROOT, 'netlify', 'functions');
const ORIGIN = 'https://mori-zeirishi.net';
const PASSWORD = '試験用のパスワードです。本番では使いません。';
const OTHER_PASSWORD = '別の試験用のパスワードです。本番では使いません。';
const BASIC_USER = '試験用の自動処理ID';
const BASIC_PASS = '試験用の自動処理パスワード';

let passed = 0;
let failed = 0;
async function test(number, description, run) {
  try { await run(); passed++; console.log(`PASS 試験${number}: ${description}`); }
  catch (error) { failed++; console.error(`FAIL 試験${number}: ${description}\n${error.stack}`); }
}

const ADMIN_FILES = {
  home: 'admin-home.js',
  articles: 'admin-articles-page.js',
  candidates: 'admin-candidates-page.js',
  freshness: 'admin-freshness-page.js',
  analyticsPage: 'admin-analytics-page.js',
  listArticles: 'admin-list-articles.js',
  listCandidates: 'admin-list-candidates.js',
  listAnalytics: 'admin-list-analytics.js',
  change: 'admin-change-article-status.js',
  save: 'admin-save-candidates.js',
  freshnessAction: 'admin-freshness-action.js',
};
const ALL_FILES = Object.values(ADMIN_FILES);

const ARTICLE = [
  '---', 'title: "試験の記事"', 'slug: "shiken"', 'review_status: "published"',
  'publish_at: "2026-01-01T00:00:00+09:00"', '---', '本文', '',
].join('\n');
const CANDIDATES_JSON = JSON.stringify({ candidates: [{ shitsugi_url: 'https://example.invalid/topic', adopted: false }] });

// ── GitHub の偽物（呼ばれた名前だけを記録する） ────────────────────
const originalGithub = { ...GITHUB };
const githubCalls = [];
function stubGithub() {
  for (const [name, value] of Object.entries(originalGithub)) {
    if (typeof value !== 'function') continue;
    GITHUB[name] = async (...args) => {
      githubCalls.push(name);
      if (name === 'getFile') {
        const file = String(args[0] || '');
        if (file.includes('nta-shitsugi-topics-candidate')) return { content: CANDIDATES_JSON, sha: '試験の版' };
        if (file.includes('freshness/candidates')) return { content: JSON.stringify({ candidates: [] }), sha: '試験の版' };
        return { content: ARTICLE, sha: '試験の版' };
      }
      if (name === 'listDirectory') return [];
      if (name === 'listOpenPRs') return [];
      if (name === 'findPR') return null;
      if (name === 'listWorkflowRuns') return { workflow_runs: [] };
      if (name === 'putFile') return { content: { sha: '新しい版' } };
      return {};
    };
  }
}
function restoreGithub() { Object.assign(GITHUB, originalGithub); }

// 入口で部品を読み込む関数は、偽物を入れてから読み直す。
function loadAdmin() {
  const loaded = {};
  for (const [key, file] of Object.entries(ADMIN_FILES)) {
    const modulePath = path.join(FUNCTIONS, file);
    delete require.cache[require.resolve(modulePath)];
    loaded[key] = require(modulePath);
  }
  return loaded;
}

// ── ログインした状態の要求 ────────────────────────────────────────
function sessionOf(event) {
  const { key } = reviewAuth.configuration({});
  const cookie = event.headers.cookie;
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const session = reviewAuth.verifySession(value, key);
  assert.ok(session, '試験の要求のセッションが読める');
  return { session, key, token: reviewAuth.csrfToken(session, key) };
}

function csrfOf(event) { return sessionOf(event).token; }

// 署名は正しいが、期限切れ・別のパスワードの Cookie を作る。
function cookieValue({ password = PASSWORD, offsetMs = 0, secret = process.env.REVIEW_SESSION_SECRET } = {}) {
  const env = { REVIEW_PASSWORD: password, REVIEW_SESSION_SECRET: secret, CONTEXT: 'production' };
  const auth = reviewAuth.createReviewAuth({ env, now: () => Date.now() + offsetMs });
  const { key } = auth.configuration({});
  return `${reviewAuth.COOKIE_NAME}=${auth.issueSession(key)}`;
}
function tamper(cookie) {
  const cut = cookie.lastIndexOf('.') + 1;
  const head = cookie.slice(0, cut);
  const body = cookie.slice(cut);
  const last = body.slice(-1) === 'A' ? 'B' : 'A';
  return head + body.slice(0, -1) + last;
}

// ── Blobs の偽物 ─────────────────────────────────────────────────
function fakeStore() {
  return {
    get: async () => null,
    list: async function* () { /* 何も無い */ },
  };
}

const realReadFileSync = fs.readFileSync;
let fsReads = 0;

const PAGES = [
  ['home', '/admin/articles'],
  ['articles', '/admin/articles'],
  ['candidates', '/admin/candidates'],
  ['freshness', '/admin/freshness'],
  ['analyticsPage', '/admin/analytics'],
];
const READ_FILES = ['listArticles', 'listCandidates'];
const WRITE_FILES = ['change', 'save', 'freshnessAction'];

function unauthorizedPage(response, expectedNext) {
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['WWW-Authenticate'], undefined);
  assert.match(response.body, /<title>管理画面にログイン<\/title>/);
  assert.match(response.body, /<form method="post" action="\/review-login">/);
  assert.match(response.body, /管理画面を開く/);
  assert.doesNotMatch(response.body, /admin-nav|管理トップ|記事管理画面|候補管理|アクセス解析/);
  const next = response.body.match(/name="next" value="([^"]+)"/)[1];
  assert.equal(decodeURIComponent(next), expectedNext);
}

function jsBody() {
  return { filename: 'shiken.md', action: 'unpublish' };
}

function writeEvent(overrides = {}) {
  return authenticatedEvent({
    httpMethod: 'POST',
    body: JSON.stringify(jsBody()),
    ...overrides,
  });
}

function freshnessDeps() {
  const state = { gets: 0, puts: 0, triggers: 0 };
  return {
    state,
    deps: {
      getFile: async file => {
        state.gets++;
        if (String(file).includes('freshness/candidates')) {
          return { content: JSON.stringify({ candidates: [{ slug: 'shiken', file: 'shiken.md', refreshable: true }] }) };
        }
        return { content: ARTICLE, sha: '試験の版' };
      },
      putFile: async () => { state.puts++; return {}; },
      updateFrontmatter: originalGithub.updateFrontmatter,
      findPR: async () => null,
      listWorkflowRuns: async () => ({ workflow_runs: [] }),
      triggerWorkflow: async () => { state.triggers++; return {}; },
      nowJST: () => '2026-01-01T00:00:00+09:00',
    },
  };
}

function checkPageHeaders(response) {
  const nonce = response.headers['Content-Security-Policy'].match(/script-src 'nonce-([^']+)'/)[1];
  for (const [key, value] of Object.entries(reviewAuth.pageHeaders(nonce))) assert.equal(response.headers[key], value);
  assert.equal(response.headers['X-Robots-Tag'], 'noindex, nofollow');
  const scripts = [...response.body.matchAll(/<script\b([^>]*)>/gi)];
  for (const [, attributes] of scripts) assert.ok(attributes.includes(`nonce="${nonce}"`), 'script に nonce がある');
  assert.doesNotMatch(response.body, /<[^>]*\son\w+\s*=/i);
  return nonce;
}

(async () => {
  process.env.REVIEW_PASSWORD = PASSWORD;
  process.env.REVIEW_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.CONTEXT = 'production';
  process.env.ADMIN_BASIC_USER = BASIC_USER;
  process.env.ADMIN_BASIC_PASS = BASIC_PASS;

  stubGithub();
  const handlers = loadAdmin();

  try {
    await test(1, 'Cookie無しは11本とも401・中身に届かない・認証の小窓なし', async () => {
      githubCalls.length = 0;
      for (const [key, expectedNext] of PAGES) {
        unauthorizedPage(await handlers[key].handler({ httpMethod: 'GET', headers: {} }), expectedNext);
      }
      for (const key of READ_FILES) {
        const response = await handlers[key].handler({ httpMethod: 'GET', headers: {} });
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers['WWW-Authenticate'], undefined);
        assert.equal(JSON.parse(response.body).error, 'ログインし直してください');
      }
      for (const key of WRITE_FILES) {
        const response = await handlers[key].handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(jsBody()) });
        assert.ok([401, 403].includes(response.statusCode), `${key}: ${response.statusCode}`);
        assert.equal(response.headers['WWW-Authenticate'], undefined);
      }
      const blobCalls = [];
      const analyticsPost = await handlers.listAnalytics.handler(
        { httpMethod: 'POST', headers: {} }, { getStoreFn: () => { blobCalls.push(1); return fakeStore(); } });
      assert.equal(analyticsPost.statusCode, 401);
      assert.equal(analyticsPost.headers['WWW-Authenticate'], undefined);
      fsReads = 0;
      fs.readFileSync = (...args) => { fsReads++; return realReadFileSync(...args); };
      const analyticsPage = await handlers.analyticsPage.handler({ httpMethod: 'GET', headers: {} });
      fs.readFileSync = realReadFileSync;
      assert.equal(analyticsPage.statusCode, 401);
      assert.equal(fsReads, 0, '認証前にファイルを読まない');
      assert.equal(blobCalls.length, 0);
      assert.equal(githubCalls.length, 0, '認証前に GitHub を呼ばない');
    });

    await test(2, '正しい Basic だけでは10本を通さず、自動処理用の GET だけ通す', async () => {
      const basic = 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64');
      githubCalls.length = 0;
      for (const [key, expectedNext] of PAGES) {
        const response = await handlers[key].handler({ httpMethod: 'GET', headers: { authorization: basic } });
        unauthorizedPage(response, expectedNext);
      }
      for (const key of READ_FILES) {
        const response = await handlers[key].handler({ httpMethod: 'GET', headers: { authorization: basic } });
        assert.equal(response.statusCode, 401, key);
        assert.equal(response.headers['WWW-Authenticate'], undefined);
      }
      for (const key of WRITE_FILES) {
        const response = await handlers[key].handler({ httpMethod: 'POST', headers: { authorization: basic }, body: JSON.stringify(jsBody()) });
        assert.ok([401, 403].includes(response.statusCode), key);
      }
      const blobCalls = [];
      const posted = await handlers.listAnalytics.handler(
        { httpMethod: 'POST', headers: { authorization: basic } },
        { getStoreFn: () => { blobCalls.push(1); return fakeStore(); } });
      assert.equal(posted.statusCode, 401, 'GET以外では自動処理用の読み取りも通らない');
      assert.equal(blobCalls.length, 0);

      const get = await handlers.listAnalytics.handler(
        { httpMethod: 'GET', headers: { authorization: basic } },
        { getStoreFn: () => { blobCalls.push(1); return fakeStore(); } });
      assert.equal(get.statusCode, 200);
      assert.equal(blobCalls.length, 1);
      assert.equal(githubCalls.length, 0);
    });

    await test(3, '壊れた Cookie（署名・期限・別のパスワード）は11本とも通らない', async () => {
      const valid = cookieValue();
      const broken = [tamper(valid), cookieValue({ offsetMs: -13 * 3600 * 1000 }), cookieValue({ password: OTHER_PASSWORD })];
      for (const cookie of broken) {
        githubCalls.length = 0;
        for (const [key, expectedNext] of PAGES) {
          unauthorizedPage(await handlers[key].handler({ httpMethod: 'GET', headers: { cookie } }), expectedNext);
        }
        for (const key of READ_FILES) {
          const response = await handlers[key].handler({ httpMethod: 'GET', headers: { cookie } });
          assert.equal(response.statusCode, 401, key);
        }
        for (const key of WRITE_FILES) {
          const response = await handlers[key].handler({ httpMethod: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie }, body: JSON.stringify(jsBody()) });
          assert.equal(response.statusCode, 401, key);
        }
        const blobCalls = [];
        const analytics = await handlers.listAnalytics.handler(
          { httpMethod: 'GET', headers: { cookie } }, { getStoreFn: () => { blobCalls.push(1); return fakeStore(); } });
        assert.equal(analytics.statusCode, 401);
        assert.equal(analytics.headers['WWW-Authenticate'], undefined);
        assert.equal(blobCalls.length, 0);
        assert.equal(githubCalls.length, 0);
      }
    });

    await test(4, 'ログインした状態の画面5本はCSP・nonce・合言葉がそろう', async () => {
      for (const [key] of PAGES) {
        const event = authenticatedEvent({ httpMethod: 'GET' });
        const response = await handlers[key].handler(event);
        assert.equal(response.statusCode, 200, key);
        const nonce = checkPageHeaders(response);
        const nextResponse = await handlers[key].handler(authenticatedEvent({ httpMethod: 'GET' }));
        const nextNonce = nextResponse.headers['Content-Security-Policy'].match(/script-src 'nonce-([^']+)'/)[1];
        assert.notEqual(nonce, nextNonce, `${key}: nonce は要求ごとに違う`);
      }
      for (const key of ['articles', 'candidates', 'freshness']) {
        const event = authenticatedEvent({ httpMethod: 'GET' });
        const token = csrfOf(event);
        const response = await handlers[key].handler(event);
        assert.equal(response.statusCode, 200, key);
        assert.ok(response.body.includes(`const REVIEW_TOKEN = ${JSON.stringify(token)};`), `${key}: 合言葉を埋め込む`);
        assert.ok(response.body.includes('X-Review-Token'), `${key}: 送り方を書く`);
        assert.notEqual(token, csrfOf(authenticatedEvent({})), `${key}: 別のセッションでは合言葉が違う`);
      }
    });

    await test(5, '書き込み3本は送り元・セッション・合言葉・形式がそろったときだけ中身に進む', async () => {
      const cases = [
        ['合言葉無し', { 'x-review-token': undefined }, 403],
        ['違う合言葉', { 'x-review-token': crypto.randomBytes(32).toString('base64url') }, 403],
        ['別セッションの合言葉', { 'x-review-token': csrfOf(authenticatedEvent({})) }, 403],
        ['違うOrigin', { origin: 'https://deploy-preview-1--x.netlify.app' }, 403],
        ['OriginもRefererも無し', { origin: undefined, referer: undefined }, 403],
        ['Content-Typeがtext/plain', { 'content-type': 'text/plain' }, 403],
      ];
      for (const key of WRITE_FILES) {
        for (const [label, headers, status] of cases) {
          githubCalls.length = 0;
          const base = writeEvent();
          const event = { ...base, headers: { ...base.headers, ...headers } };
          const harness = key === 'freshnessAction' ? freshnessDeps() : null;
          const response = harness
            ? await handlers[key]._handler(event, harness.deps)
            : await handlers[key].handler(event);
          assert.equal(response.statusCode, status, `${key}: ${label}`);
          assert.equal(response.headers['WWW-Authenticate'], undefined);
          assert.equal(githubCalls.length, 0, `${key}: ${label} で GitHub を呼ばない`);
          if (harness) assert.equal(harness.state.gets, 0, `${key}: ${label} で中身を読まない`);
        }
        const savedContext = process.env.CONTEXT;
        const previewEvent = writeEvent();
        process.env.CONTEXT = 'deploy-preview';
        try {
          const harness = key === 'freshnessAction' ? freshnessDeps() : null;
          const preview = harness
            ? await handlers[key]._handler(previewEvent, harness.deps)
            : await handlers[key].handler(previewEvent);
          assert.equal(preview.statusCode, 403, `${key}: プレビューでは通さない`);
          if (harness) assert.equal(harness.state.gets, 0);
        } finally { process.env.CONTEXT = savedContext; }
        const get = await handlers[key].handler(authenticatedEvent({ httpMethod: 'GET' }));
        assert.equal(get.statusCode, 405, `${key}: GETは405`);
      }

      githubCalls.length = 0;
      const changed = await handlers.change.handler(writeEvent());
      assert.equal(changed.statusCode, 200);
      assert.ok(githubCalls.includes('getFile') && githubCalls.includes('putFile'), 'change は認証後に中身へ進む');
      githubCalls.length = 0;
      const saved = await handlers.save.handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ sha: '試験の版', updates: { 'https://example.invalid/topic': { adopted: true } } }),
      }));
      assert.equal(saved.statusCode, 200);
      assert.ok(githubCalls.includes('getFile') && githubCalls.includes('putFile'), 'save は認証後に中身へ進む');
      const freshness = freshnessDeps();
      const refreshed = await handlers.freshnessAction._handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ action: 'refresh', slug: 'shiken' }),
      }), freshness.deps);
      assert.equal(refreshed.statusCode, 202);
      assert.equal(freshness.state.triggers, 1, 'freshness は認証後に自動処理を起動する');
    });

    await test(6, '自動処理用の読み取りの条件・待ち時間・記録', async () => {
      const env = {
        REVIEW_PASSWORD: PASSWORD,
        REVIEW_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
        CONTEXT: 'production',
        ADMIN_BASIC_USER: BASIC_USER,
        ADMIN_BASIC_PASS: BASIC_PASS,
      };
      const sleeps = [], logs = [];
      const review = reviewAuth.createReviewAuth({ env, log: entry => logs.push(entry) });
      const admin = adminAuth.createAdminAuth({ reviewAuth: review, env, sleep: async ms => { sleeps.push(ms); } });
      const basic = (id, password) => 'Basic ' + Buffer.from(`${id}:${password}`).toString('base64');
      const read = headers => admin.requireAnalyticsRead({ httpMethod: 'GET', headers });

      const ok = await read({ authorization: basic(BASIC_USER, BASIC_PASS) });
      assert.equal(ok.response, undefined);
      assert.deepEqual(sleeps, []);
      assert.ok(logs.some(entry => entry.reason === '自動処理の読み取り'));

      const failures = [
        ['パスワード違い', { authorization: basic(BASIC_USER, '違うパスワード') }],
        ['ID違い', { authorization: basic('違うID', BASIC_PASS) }],
        ['コロン無し', { authorization: 'Basic ' + Buffer.from(BASIC_USER).toString('base64') }],
        ['base64でない', { authorization: 'Basic 試験用の値' }],
      ];
      for (const [label, headers] of failures) {
        sleeps.length = 0;
        const response = await read(headers);
        assert.equal(response.response.statusCode, 401, label);
        assert.deepEqual(sleeps, [1000], `${label}: 1秒待つ`);
        assert.equal(response.response.headers['WWW-Authenticate'], undefined);
        assert.equal(JSON.parse(response.response.body).error, '認証に失敗しました');
      }
      for (const [label, changes, authorization] of [
        ['ID未設定', { ADMIN_BASIC_USER: undefined }, basic(BASIC_USER, BASIC_PASS)],
        ['ID空', { ADMIN_BASIC_USER: '' }, basic('', BASIC_PASS)],
        ['パスワード未設定', { ADMIN_BASIC_PASS: undefined }, basic(BASIC_USER, BASIC_PASS)],
        ['パスワード空', { ADMIN_BASIC_PASS: '' }, basic(BASIC_USER, '')],
      ]) {
        const saved = { ...env };
        for (const [name, value] of Object.entries(changes)) { if (value === undefined) delete env[name]; else env[name] = value; }
        sleeps.length = 0;
        const response = await read({ authorization });
        assert.equal(response.response.statusCode, 401, label);
        assert.deepEqual(sleeps, [1000], `${label}: 1秒待つ`);
        Object.assign(env, saved);
      }
      sleeps.length = 0;
      const emptyId = await read({ authorization: basic('', BASIC_PASS) });
      assert.equal(emptyId.response.statusCode, 401, '空のIDでは通らない');
      sleeps.length = 0;
      env.CONTEXT = 'deploy-preview';
      const preview = await read({ authorization: basic(BASIC_USER, BASIC_PASS) });
      assert.equal(preview.response.statusCode, 401, 'プレビューでは通らない');
      assert.deepEqual(sleeps, [1000]);
      env.CONTEXT = 'production';

      sleeps.length = 0;
      const duplicateHeaders = await read({ authorization: basic(BASIC_USER, BASIC_PASS), Authorization: basic(BASIC_USER, BASIC_PASS) });
      assert.equal(duplicateHeaders.response.statusCode, 401, '同名ヘッダが2つなら通らない');
      const duplicateValues = await admin.requireAnalyticsRead({ httpMethod: 'GET', headers: {}, multiValueHeaders: { authorization: [basic(BASIC_USER, BASIC_PASS), basic(BASIC_USER, BASIC_PASS)] } });
      assert.equal(duplicateValues.response.statusCode, 401, 'multiValueHeaders が2つなら通らない');
      const mismatched = await admin.requireAnalyticsRead({
        httpMethod: 'GET',
        headers: { authorization: basic(BASIC_USER, BASIC_PASS) },
        multiValueHeaders: { authorization: [basic(BASIC_USER, '違うパスワード')] },
      });
      assert.equal(mismatched.response.statusCode, 401, 'headers と multiValueHeaders が食い違えば通らない');

      delete env.CONTEXT;
      const noContext = await read({ authorization: basic(BASIC_USER, BASIC_PASS) });
      assert.equal(noContext.response, undefined, 'CONTEXT が未設定でも本番と同じ扱い');
      env.CONTEXT = 'production';

      const { key } = review.configuration({});
      const value = review.issueSession(key);
      const withSession = await read({ cookie: `${reviewAuth.COOKIE_NAME}=${value}`, authorization: basic(BASIC_USER, '違うパスワード') });
      assert.equal(withSession.response, undefined, 'ログイン済みなら Basic が違っても良い');

      const serialized = JSON.stringify(logs);
      for (const secret of [BASIC_USER, BASIC_PASS, '違うパスワード', 'deploy-preview']) assert.ok(!serialized.includes(secret));
      for (const entry of logs) assert.deepEqual(Object.keys(entry).sort(), ['ipHash', 'reason', 'time']);
      assert.ok(logs.some(entry => entry.reason === '自動処理の読み取りの失敗'));

      // ハンドラ全体でも、誤った Basic では Blobs を読まない。
      const blobCalls = [];
      const wrong = await handlers.listAnalytics.handler(
        { httpMethod: 'GET', headers: { authorization: basic(BASIC_USER, '違うパスワード') } },
        { getStoreFn: () => { blobCalls.push(1); return fakeStore(); } });
      assert.equal(wrong.statusCode, 401);
      assert.equal(wrong.headers['WWW-Authenticate'], undefined);
      assert.equal(blobCalls.length, 0);
    });

    await test(7, 'safeNext は管理画面の道筋だけを通す', async () => {
      for (const page of ['/admin/articles', '/admin/candidates', '/admin/freshness', '/admin/analytics']) {
        assert.equal(reviewAuth.safeNext(page), page);
      }
      // 管理トップ（/admin）は承認画面の既存の試験が「戻さない道筋」として固定している。
      assert.equal(reviewAuth.safeNext('/admin'), '/review');
      for (const next of ['/admin/', '/admin/articles?x=1', '/admin/articles#x', '/admin/api/list', '/admin/../review',
        '/administrator', '//admin', '/admin%2farticles', 'https://evil.example/admin']) {
        assert.equal(reviewAuth.safeNext(next), '/review', next);
      }
      assert.equal(reviewAuth.safeNext('/review?file=x.md'), '/review?file=x.md');
    });

    await test(8, 'ログインの流れ（管理画面へ戻る・Cookie・誤り）', async () => {
      const records = new Map();
      let version = 0;
      const store = {
        getWithMetadata: async key => (records.has(key) ? { data: structuredClone(records.get(key).data), etag: records.get(key).etag, metadata: {} } : null),
        set: async (key, serialized) => { const etag = `版${++version}`; records.set(key, { data: JSON.parse(serialized), etag }); return { modified: true, etag }; },
        delete: async key => { records.delete(key); },
      };
      const env = { REVIEW_PASSWORD: PASSWORD, REVIEW_SESSION_SECRET: process.env.REVIEW_SESSION_SECRET, CONTEXT: 'production' };
      const auth = reviewAuth.createReviewAuth({ env, getStoreFn: () => store, sleep: async () => {}, log: () => {}, notify: async () => {} });
      const loginEvent = password => ({
        httpMethod: 'POST',
        headers: { origin: ORIGIN, host: 'mori-zeirishi.net', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password, next: '/admin/articles' }).toString(),
      });
      const success = await auth.login(loginEvent(PASSWORD));
      assert.equal(success.statusCode, 303);
      assert.equal(success.headers.Location, '/admin/articles');
      const cookie = success.headers['Set-Cookie'].split(';')[0];
      assert.match(cookie, /^__Host-review_session=/);
      const page = await handlers.articles.handler({ httpMethod: 'GET', headers: { cookie } });
      assert.equal(page.statusCode, 200, 'ログインした Cookie で管理画面が開ける');
      assert.equal(reviewAuth.requireSession({ headers: { cookie } }).response, undefined, '承認画面の requireSession も通る');

      const failure = await auth.login(loginEvent('間違えた試験用のパスワード'));
      assert.equal(failure.statusCode, 401);
      assert.match(failure.body, /管理画面にログイン/);
      const next = failure.body.match(/name="next" value="([^"]+)"/)[1];
      assert.equal(decodeURIComponent(next), '/admin/articles');
      assert.equal(failure.headers['Set-Cookie'], undefined);
    });

    await test(9, 'ログイン画面の文言を行き先で分ける', () => {
      const admin = reviewAuth.loginPage('/admin/articles');
      assert.match(admin.body, /<title>管理画面にログイン<\/title>/);
      assert.match(admin.body, /<h1>管理画面にログイン<\/h1>/);
      assert.match(admin.body, /管理画面を開く/);
      assert.match(admin.body, /action="\/review-login"/);
      const review = reviewAuth.loginPage('/review?file=x.md');
      assert.match(review.body, /<title>レビュー画面にログイン<\/title>/);
      assert.match(review.body, /レビュー画面を開く/);
      const next = review.body.match(/name="next" value="([^"]+)"/)[1];
      assert.equal(decodeURIComponent(next), '/review?file=x.md');
    });

    await test(10, '残り物が無く、11本すべてが新しい入口を呼ぶ', () => {
      const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
      const files = walk(FUNCTIONS).filter(file => file.endsWith('.js'));
      for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!text.includes('requireBasicAuth'), `${path.relative(ROOT, file)}: requireBasicAuth が残る`);
        assert.ok(!text.includes('WWW-Authenticate'), `${path.relative(ROOT, file)}: WWW-Authenticate が残る`);
      }
      const guard = /requireAdminPage|requireAdminRead|requireAdminAction|requireAnalyticsRead/;
      for (const file of ALL_FILES) {
        const text = fs.readFileSync(path.join(FUNCTIONS, file), 'utf8');
        assert.match(text, guard, `${file}: 新しい入口を呼ぶ`);
      }
    });
  } finally {
    restoreGithub();
    fs.readFileSync = realReadFileSync;
  }

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
