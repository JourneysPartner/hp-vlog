'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { marked } = require('marked');
const authLib = require('../../../netlify/functions/lib/review-auth');
const { sanitizeReviewHtml } = require('../../../netlify/functions/lib/review-html');
const page = require('../../../netlify/functions/review-page');
const github = require('../../../netlify/functions/lib/github-api');
const notify = require('../../../netlify/functions/lib/notify');
const denylist = require('../../../netlify/functions/lib/denylist-store');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const ORIGIN = 'https://mori-zeirishi.net';
const PASSWORD = '試験用のパスワードです。本番では使いません。';
const envBefore = { ...process.env };
const nowBefore = Date.now;
let passed = 0;
let failed = 0;

// 通信先・時計・待機・通知・ログを全て試験内に閉じる。
function setup(options = {}) {
  let time = Date.now();
  const records = new Map();
  const logs = [], delays = [], notices = [];
  const env = { REVIEW_PASSWORD: PASSWORD, REVIEW_SESSION_SECRET: crypto.randomBytes(32).toString('hex'), CONTEXT: 'production', ...options.env };
  const store = {
    get: async key => records.has(key) ? structuredClone(records.get(key)) : null,
    setJSON: async (key, value) => { records.set(key, structuredClone(value)); return { modified: true }; },
    delete: async key => { records.delete(key); },
  };
  const auth = authLib.createReviewAuth({ env, now: () => time, getStoreFn: input => {
    assert.deepEqual(input, { name: 'review-auth', consistency: 'strong' }); return store;
  }, sleep: async ms => { delays.push(ms); }, notify: async (...args) => { notices.push(args); }, log: entry => { logs.push(entry); } });
  function event(password = PASSWORD, ip = '192.0.2.1', next = '/review?file=x.md&ref=draft%2Fx') {
    return { httpMethod: 'POST', headers: { origin: ORIGIN, host: 'mori-zeirishi.net', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-nf-client-connection-ip': ip }, body: new URLSearchParams({ password, next }).toString() };
  }
  function signed(changes = {}) {
    const { key } = auth.configuration({});
    const value = auth.issueSession(key);
    const session = auth.verifySession(value, key);
    return { httpMethod: 'POST', headers: { origin: ORIGIN, host: 'mori-zeirishi.net', 'content-type': 'application/json', cookie: `${authLib.COOKIE_NAME}=${value}`, 'x-review-token': auth.csrfToken(session, key), ...changes }, body: '{}' };
  }
  return { auth, env, records, logs, delays, notices, store, event, signed, advance: ms => { time += ms; }, time: () => time };
}

async function test(number, description, run) {
  try { await run(); passed++; console.log(`PASS 試験${number}: ${description}`); }
  catch (error) { failed++; console.error(`FAIL 試験${number}: ${description}\n${error.stack}`); }
}

function replaceEnv(values) {
  for (const name of ['REVIEW_PASSWORD', 'REVIEW_SESSION_SECRET', 'GH_APP_PRIVATE_KEY', 'CONTEXT']) {
    if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
  }
}

async function withActions(run) {
  const apiBefore = { ...github };
  const notifyBefore = notify.sendNotification, denyBefore = denylist.appendEntries;
  const calls = [];
  for (const name of Object.keys(github)) {
    if (typeof github[name] !== 'function') continue;
    github[name] = async (...args) => {
      calls.push(name);
      if (name === 'getFile') return { content: '---\ntitle: "試験の記事"\nfact_check_status: "revise"\nreview_status: "draft"\n---\n本文\n', sha: '試験の版' };
      if (name === 'findPR') return null;
      return undefined;
    };
  }
  github.updateFrontmatter = (...args) => { calls.push('updateFrontmatter'); return apiBefore.updateFrontmatter(...args); };
  github.extractFmField = (...args) => { calls.push('extractFmField'); return apiBefore.extractFmField(...args); };
  github.nowJST = () => { calls.push('nowJST'); return '2026-10-16T12:00:00+09:00'; };
  notify.sendNotification = async () => { calls.push('sendNotification'); };
  denylist.appendEntries = async () => { calls.push('appendEntries'); return { added: [] }; };
  const revisePath = require.resolve('../../../netlify/functions/review-revise');
  const savedModule = require.cache[revisePath];
  delete require.cache[revisePath];
  const actions = [
    ['承認', require('../../../netlify/functions/review-approve-background').handler],
    ['差し戻し', require(revisePath).handler],
    ['見送り', require('../../../netlify/functions/review-skip').handler],
  ];
  try { await run(actions, calls); }
  finally {
    Object.assign(github, apiBefore);
    notify.sendNotification = notifyBefore; denylist.appendEntries = denyBefore;
    if (savedModule) require.cache[revisePath] = savedModule; else delete require.cache[revisePath];
  }
}

function checkPageHeaders(response) {
  for (const [key, value] of Object.entries({ 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })) assert.equal(response.headers[key], value);
  const nonce = response.headers['Content-Security-Policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.deepEqual(response.headers, authLib.pageHeaders(nonce));
  const scripts = [...response.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1], ` nonce="${nonce}"`);
  assert.doesNotMatch(response.body, /<[^>]*\son\w+\s*=/i);
  new vm.Script(scripts[0][2]);
  return scripts[0][2];
}

async function drawAuthenticated(raw, record = null) {
  const savedGet = github.getFile;
  const before = process.env.GITHUB_TOKEN;
  const event = authenticatedEvent({ httpMethod: 'GET', queryStringParameters: { file: 'x.md', ref: 'draft/test' } });
  process.env.GITHUB_TOKEN = crypto.randomBytes(24).toString('hex');
  github.getFile = async name => ({ content: name.startsWith('data/fact-check/') ? JSON.stringify(record) : raw });
  try { return await page.handler(event); }
  finally { github.getFile = savedGet; if (before === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = before; }
}

async function main() {
  Date.now = () => Date.UTC(2026, 9, 16, 12);
  await test(1, '設定不足は画面・3処理・ログイン・ログアウトとも503、外部呼出しなし', async () => {
    await withActions(async (actions, calls) => {
      const base = setup().env;
      for (const changes of [
        { REVIEW_PASSWORD: undefined }, { REVIEW_PASSWORD: 'あ'.repeat(11) },
        { REVIEW_SESSION_SECRET: undefined, GH_APP_PRIVATE_KEY: undefined },
        { REVIEW_SESSION_SECRET: crypto.randomBytes(16).toString('hex').slice(0, 31) },
        { REVIEW_SESSION_SECRET: '', GH_APP_PRIVATE_KEY: crypto.randomBytes(32).toString('hex') },
      ]) {
        replaceEnv({ ...base, ...changes });
        assert.equal((await page.handler({ httpMethod: 'GET', queryStringParameters: { file: 'x.md' } })).statusCode, 503);
        for (const [, handler] of actions) assert.equal((await handler({ httpMethod: 'POST', headers: { origin: ORIGIN } })).statusCode, 503);
        assert.equal((await require('../../../netlify/functions/review-login').handler({ httpMethod: 'POST' })).statusCode, 503);
        assert.equal((await require('../../../netlify/functions/review-logout').handler({ httpMethod: 'POST' })).statusCode, 503);
        assert.equal(calls.length, 0);
      }
      const fallback = setup({ env: { REVIEW_SESSION_SECRET: undefined, GH_APP_PRIVATE_KEY: crypto.randomBytes(64).toString('hex') } });
      const { key } = fallback.auth.configuration({});
      const expected = crypto.hkdfSync('sha256', fallback.env.GH_APP_PRIVATE_KEY, crypto.createHash('sha256').update(PASSWORD).digest(), 'hp-vlog review session v1', 32);
      assert.deepEqual(key, Buffer.from(expected));
    });
  });

  await test(2, 'Cookieの署名・型・時刻・寿命・パスワード変更を厳密に検査', () => {
    const h = setup(), { key } = h.auth.configuration({});
    const value = h.auth.issueSession(key);
    const s = h.auth.verifySession(value, key);
    assert.equal(s.v, 1); assert.equal(Buffer.from(s.sid, 'base64url').length, 16); assert.equal(s.exp - s.iat, 43200);
    const sign = object => {
      const payload = Buffer.from(JSON.stringify(object)).toString('base64url');
      return payload + '.' + crypto.createHmac('sha256', key).update(payload).digest('base64url');
    };
    for (const invalid of [null, '', '壊れたCookie', value + '.extra', value.slice(0, -1),
      value.split('.')[0] + '.' + (value.split('.')[1][0] === 'A' ? 'B' : 'A') + value.split('.')[1].slice(1),
      sign({ ...s, v: 2 }), sign({ ...s, iat: s.iat + 1 }), sign({ ...s, exp: s.iat }),
      sign({ ...s, exp: s.iat + 43201 }), sign({ ...s, exp: String(s.exp) }), sign({ ...s, iat: -1 }),
      sign({ ...s, sid: '形の違う識別子' }), sign(null), sign([]),
    ]) assert.equal(h.auth.verifySession(invalid, key), null);
    const event = h.signed();
    event.headers.cookie += `; ${event.headers.cookie}`;
    assert.equal(h.auth.requireAction(event).response.statusCode, 401);
    h.env.REVIEW_PASSWORD += '変更';
    assert.equal(h.auth.verifySession(value, h.auth.configuration({}).key), null);
    h.advance(43200000);
    assert.equal(h.auth.verifySession(value, key), null);
  });

  await test(3, '未認証の画面に下書き情報を出さず、記事も照合記録も取得しない', async () => {
    replaceEnv(setup().env);
    const saved = github.getFile;
    let reads = 0;
    github.getFile = async () => { reads++; throw new Error('取得してはいけません'); };
    try {
      for (const cookie of [undefined, '壊れたCookie']) {
        const response = await page.handler({ httpMethod: 'GET', headers: { cookie }, queryStringParameters: { file: 'x.md', ref: 'draft/x' } });
        assert.equal(response.statusCode, 401); assert.equal(reads, 0);
        assert.match(response.body, /type="password" autocomplete="current-password" autofocus/);
        assert.match(response.body, /レビュー画面を開く/);
        assert.doesNotMatch(response.body, /x\.md|draft\/x|記事本文|試験の記事|factCheck/);
        const next = response.body.match(/name="next" value="([^"]+)"/)[1];
        assert.equal(decodeURIComponent(next), '/review?file=x.md&ref=draft%2Fx');
        assert.doesNotMatch(response.body, /name="(?:user|username)"/);
      }
    } finally { github.getFile = saved; }
  });

  await test(4, 'ログイン成功で303、元の道筋と12時間の安全なCookie', async () => {
    const h = setup();
    const response = await h.auth.login(h.event());
    assert.equal(response.statusCode, 303); assert.equal(response.headers.Location, '/review?file=x.md&ref=draft%2Fx');
    assert.match(response.headers['Set-Cookie'], /^__Host-review_session=/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) assert.ok(response.headers['Set-Cookie'].includes('; ' + attr));
    assert.doesNotMatch(response.headers['Set-Cookie'], /Domain=/i);
    const value = response.headers['Set-Cookie'].split(';')[0].split('=')[1];
    assert.ok(h.auth.verifySession(value, h.auth.configuration({}).key));
    assert.equal(h.delays.length, 0);
    const encoded = h.event(); encoded.isBase64Encoded = true; encoded.body = Buffer.from(encoded.body).toString('base64');
    assert.equal((await h.auth.login(encoded)).statusCode, 303);
  });

  await test(5, 'nextの外部URL・制御文字・別画面を/reviewへ置換', async () => {
    const h = setup();
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil', '/review%0d%0aSet-Cookie:', '/admin',
      '/review?x=%0d%0aSet-Cookie:', '/review?x=%250a', '/review?x=\\evil', '/review?x=https://evil.example/', '/review?x=%']) {
      const response = await h.auth.login(h.event(PASSWORD, '192.0.2.1', next));
      assert.equal(response.headers.Location, '/review');
    }
    assert.equal(authLib.safeNext('/review?file=x.md&ref=draft%2Fx'), '/review?file=x.md&ref=draft%2Fx');
  });

  await test(6, '誤パスワードは401、1秒待ち、Cookieを発行しない', async () => {
    const h = setup();
    const response = await h.auth.login(h.event('間違えた試験用のパスワード'));
    assert.equal(response.statusCode, 401); assert.deepEqual(h.delays, [1000]);
    assert.equal(response.headers['Set-Cookie'], undefined); assert.match(response.body, /パスワードが違います/);
    assert.equal(decodeURIComponent(response.body.match(/name="next" value="([^"]+)"/)[1]), '/review?file=x.md&ref=draft%2Fx');
  });

  await test(7, 'IP5回・全体30回、停止時間・通知1回・成功時のIP解除', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) assert.equal((await h.auth.login(h.event('間違えた試験用のパスワード'))).statusCode, 401);
    assert.equal((await h.auth.login(h.event())).statusCode, 429);
    assert.equal((await h.auth.login(h.event(PASSWORD, '192.0.2.2'))).statusCode, 303);
    h.advance(899999); assert.equal((await h.auth.login(h.event())).statusCode, 429);
    h.advance(1); assert.equal((await h.auth.login(h.event())).statusCode, 303);
    const cleared = setup();
    for (let i = 0; i < 4; i++) await cleared.auth.login(cleared.event('間違えた試験用のパスワード'));
    assert.equal((await cleared.auth.login(cleared.event())).statusCode, 303);
    assert.equal(cleared.records.get('global').count, 4); assert.equal(cleared.records.size, 1);
    for (let i = 0; i < 4; i++) assert.equal((await cleared.auth.login(cleared.event('間違えた試験用のパスワード'))).statusCode, 401);
    const global = setup();
    for (let i = 0; i < 30; i++) assert.equal((await global.auth.login(global.event('間違えた試験用のパスワード', `192.0.2.${i + 1}`))).statusCode, 401);
    for (let i = 0; i < 3; i++) assert.equal((await global.auth.login(global.event(PASSWORD, `198.51.100.${i + 1}`))).statusCode, 429);
    assert.deepEqual(global.notices, [['review_auth_locked', {}]]);
    const message = notify.buildMessage('review_auth_locked', {});
    assert.match(message.body, /1時間/); assert.doesNotMatch(JSON.stringify(message), /192\.0\.2|パスワードです/);
    global.advance(3599999); assert.equal((await global.auth.login(global.event())).statusCode, 429);
    global.advance(1); assert.equal((await global.auth.login(global.event())).statusCode, 303);
    const proxy = setup();
    for (let i = 0; i < 5; i++) { const request = proxy.event('間違えた試験用のパスワード'); delete request.headers['x-nf-client-connection-ip']; request.headers['x-forwarded-for'] = '192.0.2.9, 198.51.100.1'; await proxy.auth.login(request); }
    const request = proxy.event(); delete request.headers['x-nf-client-connection-ip']; request.headers['x-forwarded-for'] = '192.0.2.9, 198.51.100.2';
    assert.equal((await proxy.auth.login(request)).statusCode, 429);
    assert.doesNotMatch(JSON.stringify([...proxy.records]), /192\.0\.2|198\.51\.100/);
  });

  await test(8, 'Blobsの読取・保存・削除失敗と壊れた記録では503', async () => {
    for (const [method, password] of [['get', PASSWORD], ['setJSON', '間違えた試験用のパスワード'], ['delete', PASSWORD]]) {
      const h = setup(); h.store[method] = async () => { throw new Error('試験用の障害'); };
      const response = await h.auth.login(h.event(password));
      assert.equal(response.statusCode, 503); assert.equal(response.headers['Set-Cookie'], undefined);
    }
    const h = setup(); h.records.set('global', { count: '壊れた記録' });
    assert.equal((await h.auth.login(h.event())).statusCode, 503);
    const unwritten = setup(); unwritten.store.setJSON = async () => ({ modified: false });
    assert.equal((await unwritten.auth.login(unwritten.event('間違えた試験用のパスワード'))).statusCode, 503);
    const unopened = setup();
    const auth = authLib.createReviewAuth({ env: unopened.env, getStoreFn: () => { throw new Error('試験用の接続障害'); }, log: () => {} });
    assert.equal((await auth.login(unopened.event())).statusCode, 503);
  });

  await test(9, '3処理の全拒否条件で既存処理0回、全確認後だけ開始', async () => {
    await withActions(async (actions, calls) => {
      for (const [name, handler] of actions) {
        const valid = authenticatedEvent({ httpMethod: 'POST', body: JSON.stringify({ filename: 'x.md', comment: '修正してください', ref: 'draft/test' }) });
        const cases = [
          ['Cookie無し', { cookie: undefined }, 401], ['Cookie不正', { cookie: '壊れたCookie' }, 401],
          ['プレビューOrigin', { origin: 'https://deploy-preview-1--x.netlify.app' }, 403],
          ['Origin無し', { origin: undefined }, 403], ['Origin空', { origin: '', referer: ORIGIN + '/review' }, 403],
          ['トークン無し', { 'x-review-token': undefined }, 403], ['トークン違い', { 'x-review-token': crypto.randomBytes(32).toString('base64url') }, 403],
          ['形式違い', { 'content-type': 'text/plain' }, 403],
          ['偽装Originのプレビュー宛て', { host: 'deploy-preview-1--x.netlify.app' }, 403],
          ['Origin重複', { Origin: ORIGIN }, 403],
          ['別セッションのトークン', { 'x-review-token': authenticatedEvent({}).headers['x-review-token'] }, 403],
        ];
        for (const [label, headers, status] of cases) {
          calls.length = 0;
          const response = await handler({ ...valid, body: 'JSONにもならない要求は認証より先に読まない', headers: { ...valid.headers, ...headers } });
          assert.equal(response.statusCode, status, `${name}: ${label}`);
          assert.equal(calls.length, 0, `${name}: ${label}で既存処理に到達しない`);
          assert.equal(response.headers['Cache-Control'], 'no-store');
        }
        const original = process.env.CONTEXT; process.env.CONTEXT = 'deploy-preview'; calls.length = 0;
        assert.equal((await handler(valid)).statusCode, 403); assert.equal(calls.length, 0); process.env.CONTEXT = original;
        for (const field of ['origin', 'cookie', 'x-review-token', 'content-type']) {
          calls.length = 0;
          const response = await handler({ ...valid, multiValueHeaders: { [field]: [valid.headers[field], valid.headers[field]] } });
          assert.equal(response.statusCode, field === 'cookie' ? 401 : 403); assert.equal(calls.length, 0);
        }
        calls.length = 0;
        assert.equal((await handler({ ...valid, rawUrl: 'https://deploy-preview-1--x.netlify.app/.netlify/functions/review-skip' })).statusCode, 403);
        assert.equal(calls.length, 0);
        calls.length = 0;
        await handler(valid); assert.ok(calls.includes('getFile'), `${name}: 認証成功時に既存処理へ入る`);
        calls.length = 0;
        const fallback = { ...valid, headers: { ...valid.headers, referer: ORIGIN + '/review?file=x.md' } }; delete fallback.headers.origin;
        await handler(fallback); assert.ok(calls.includes('getFile'), `${name}: Refererの代替確認`);
        console.log(`  ${name}: 拒否${cases.length + 6}条件で既存処理0回、Origin/Referer成功時のみ取得`);
      }
    });
    const h = setup();
    for (const origin of [undefined, 'https://deploy-preview-1--x.netlify.app', 'null', ORIGIN + '/']) {
      const event = h.event(); event.headers.origin = origin;
      assert.equal((await h.auth.login(event)).statusCode, 403); assert.equal(h.records.size, 0);
    }
    const fallback = h.event(); delete fallback.headers.origin; fallback.headers.referer = ORIGIN + '/review';
    assert.equal((await h.auth.login(fallback)).statusCode, 303);
  });

  await test(10, 'ログアウトはCSRF確認後にCookieを消す', async () => {
    const h = setup();
    const valid = h.signed();
    const response = h.auth.logout(valid);
    assert.equal(response.statusCode, 200); assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
    assert.match(response.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax; Path=\//);
    for (const [headers, status] of [[{ origin: undefined }, 403], [{ cookie: undefined }, 401], [{ 'x-review-token': undefined }, 403], [{ 'content-type': 'text/plain' }, 403]]) assert.equal(h.auth.logout({ ...valid, headers: { ...valid.headers, ...headers } }).statusCode, status);
    assert.equal(h.auth.logout({ httpMethod: 'GET' }).statusCode, 405);
    const real = authenticatedEvent({ httpMethod: 'POST', body: '{}' });
    assert.equal((await require('../../../netlify/functions/review-logout').handler(real)).statusCode, 200);
  });

  await test(11, '両画面のCSPと全ヘッダ、nonce付きscript1つ、イベント登録と再ログイン', async () => {
    const response = await drawAuthenticated('---\ntitle: "試験の題名"\n---\n# 見出し\n\n本文');
    assert.equal(response.statusCode, 200);
    const script = checkPageHeaders(response);
    const login = setup().auth.loginPage('/review?file=x.md');
    const loginScript = checkPageHeaders(login);
    const next = { value: login.body.match(/name="next" value="([^"]+)"/)[1] };
    vm.runInNewContext(loginScript, { document: { querySelector: () => next } });
    assert.equal(next.value, '/review?file=x.md');
    assert.notEqual(setup().auth.loginPage('/review').headers['Content-Security-Policy'], setup().auth.loginPage('/review').headers['Content-Security-Policy']);
    const controls = new Map();
    const listeners = new Map();
    for (const id of ['btnApprove', 'btnRevise', 'btnSkip', 'btnSkipForever', 'btnLogout', 'commentCard', 'reviewComment', 'resultMsg', 'publishAt', 'suppressTopic']) {
      const classes = new Set();
      controls.set(id, { value: '', textContent: id === 'btnRevise' ? '差し戻し' : '', innerHTML: '', checked: false,
        focus() {}, classList: { toggle: value => classes.has(value) ? classes.delete(value) : classes.add(value), contains: value => classes.has(value) },
        addEventListener: (type, callback) => { listeners.set(id, callback); } });
    }
    const requests = [], redirects = [];
    let status = 200;
    const context = vm.createContext({
      document: { getElementById: id => controls.get(id), querySelectorAll: () => [] },
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: status === 200, status, json: async () => ({}) }; },
      confirm: () => true, location: { search: '?file=x.md', assign: value => redirects.push(value) },
      setTimeout: callback => callback(),
    });
    vm.runInContext(script, context);
    for (const id of ['btnApprove', 'btnSkip', 'btnSkipForever']) await listeners.get(id)();
    listeners.get('btnRevise')(); assert.ok(controls.get('commentCard').classList.contains('show'));
    controls.get('reviewComment').value = '試験の修正コメント'; await listeners.get('btnRevise')();
    assert.deepEqual(requests.map(r => r.url), ['/.netlify/functions/review-approve-background', '/.netlify/functions/review-skip', '/.netlify/functions/review-skip', '/.netlify/functions/review-revise']);
    assert.equal(JSON.parse(requests[2].options.body).suppress_topic, true);
    for (const request of requests) { assert.ok(request.options.headers['X-Review-Token']); assert.equal(request.options.headers['Content-Type'], 'application/json'); }
    status = 401; await listeners.get('btnSkip')();
    assert.equal(controls.get('resultMsg').textContent, 'ログインし直してください');
    assert.equal(redirects.pop(), '/review?file=x.md');
    status = 200; await listeners.get('btnLogout')(); assert.equal(requests.at(-1).url, '/review-logout');
    assert.equal(redirects.pop(), '/review?file=x.md');
    assert.equal(authLib.requireSession({ headers: authenticatedEvent({}).headers }).response, undefined);
  });

  await test(12, '全メタ情報・ファイル名・script内の値をエスケープし、httpsのみリンク', () => {
    for (const attack of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>']) {
      const meta = Object.fromEntries(['title', 'summary', 'category', 'customer_segment', 'target_query', 'secondary_queries', 'source_title', 'publish_at', 'review_status', 'intent_type', 'review_warning'].map(name => [name, attack]));
      meta.source_url = 'javascript:alert(1)'; meta.preview_url = 'javascript:alert(1)';
      const html = page.renderReviewPage(attack, meta, '<p>本文</p>', attack);
      assert.doesNotMatch(html, /<script>alert|<img src=x|href="javascript:/);
      for (const [tag] of html.matchAll(/<[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
        assert.doesNotMatch(tag.replace(/"[^"]*"|'[^']*'/g, '""'), /\son\w+\s*=/i);
      }
      const escaped = authLib.escapeHtml(attack);
      for (const prefix of ['<title>レビュー: ', '<h2 class="h5 mb-3">', '<tr><th>カテゴリ</th><td>', '<tr><th>要約</th><td>', '<tr><th>ファイル</th><td><code>']) assert.ok(html.includes(prefix + escaped));
      assert.ok(html.includes('副: ' + escaped)); assert.ok(html.includes('（型: ' + escaped));
      const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
      new vm.Script(script); assert.ok(!script.includes(attack));
      assert.equal((html.match(/<script\b/g) || []).length, 1);
      const safe = page.renderReviewPage('x.md', { source_title: attack, source_url: 'https://example.invalid/?x="bad', preview_url: 'https://example.invalid/?x="bad' }, '', '');
      assert.ok(safe.includes('href="https://example.invalid/?x=&quot;bad"'));
      assert.ok(safe.includes(escaped));
    }
  });

  await test(13, '危険要素・属性・URLを除き通常の書式と更新差分を維持', () => {
    const dangerous = '<script>危険な実行()</script><style>危険な見た目</style><img src=x onerror=alert(1)><a href="javascript:alert(1)">危険なリンク</a><iframe>危険な枠</iframe><form><input><button>操作</button><textarea>入力</textarea><select><option>選択</option></select></form><object></object><embed><meta><link><base><svg><script>実行()</script></svg><math><mi>式</mi></math>';
    const safe = marked('# 普通の見出し\n\n| 列 | 値 |\n|---|---|\n| 甲 | 乙 |\n\n- **太字**\n\n[普通のリンク](https://example.invalid/)');
    const html = sanitizeReviewHtml(dangerous + safe);
    assert.doesNotMatch(html, /<(?:script|style|iframe|form|input|button|textarea|select|object|embed|meta|link|base|svg|math)\b|onerror|javascript:|危険な実行|危険な見た目/);
    for (const expected of ['<h1>', '<table>', '<ul>', '<strong>', '<a href="https://example.invalid/">']) assert.ok(html.includes(expected));
    for (const url of ['jav&#x61;script:alert(1)', 'javascript&colon;alert(1)', 'java&#10;script:alert(1)', 'data:text/html,危険']) assert.doesNotMatch(sanitizeReviewHtml(`<a href="${url}">文</a><img src="${url}">`), /href=|src=/);
    assert.doesNotMatch(sanitizeReviewHtml('<p id="btnApprove" name="fetch" style="display:none" onclick="alert(1)">文</p>'), /id=|name=|style=|onclick=/);
    const refresh = page.renderReviewPage('x.md', { refresh_of: 'published' }, dangerous + safe, 'draft/refresh-x', { available: true, diff: [{ heading: '変更', changedParagraphs: { before: [{ text: dangerous }], after: [{ text: dangerous }] } }] });
    assert.equal((refresh.match(/<script\b/g) || []).length, 1);
    assert.doesNotMatch(refresh, /onerror=|<iframe|<form|危険な実行/);
  });

  await test(14, 'ログはIPハッシュ8桁・固定理由・時刻のみで秘密や入力を含めない', async () => {
    const h = setup();
    const wrong = '間違えた試験用のパスワード';
    await h.auth.login(h.event(wrong));
    const response = await h.auth.login(h.event());
    h.auth.requireAction(h.signed({ origin: 'https://evil.example' }));
    const value = response.headers['Set-Cookie'].split(';')[0].split('=')[1];
    const serialized = JSON.stringify(h.logs);
    for (const secret of [PASSWORD, wrong, value, '192.0.2.1', h.env.REVIEW_SESSION_SECRET, h.signed().headers['x-review-token']]) assert.ok(!serialized.includes(secret));
    for (const entry of h.logs) { assert.deepEqual(Object.keys(entry), ['ipHash', 'reason', 'time']); assert.match(entry.ipHash, /^[0-9a-f]{8}$/); assert.ok(Number.isFinite(Date.parse(entry.time))); }
    assert.ok(h.logs.some(entry => entry.reason === 'ログイン成功')); assert.ok(h.logs.some(entry => entry.reason === 'ログイン失敗'));
  });

  await test(15, '実データを認証経由で描画し、照合の要点→本文→詳細の並びを保持', async () => {
    const dir = path.resolve(__dirname, '../../../docs/codex-tasks/review-page-layout/fixtures');
    const raw = fs.readFileSync(path.join(dir, '2026-10-16-gift-cash-procedure-tax-return.md'), 'utf8');
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'gift-cash-procedure-tax-return.json'), 'utf8'));
    const response = await drawAuthenticated(raw, record);
    assert.equal(response.statusCode, 200); checkPageHeaders(response);
    const html = response.body;
    assert.ok(html.indexOf('id="factCheckSummary"') < html.indexOf('id="articleBody"'));
    assert.ok(html.indexOf('id="articleBody"') < html.indexOf('id="factCheck"'));
    assert.match(html, /人が確かめる箇所 35 件/); assert.match(html, /資料が見つからなかった 20 件/); assert.match(html, /件数の上限で照合しなかった 15 件/);
  });

  console.log(`試験1〜15: PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Date.now = nowBefore;
  for (const name of Object.keys(process.env)) if (!Object.hasOwn(envBefore, name)) delete process.env[name];
  Object.assign(process.env, envBefore);
});
