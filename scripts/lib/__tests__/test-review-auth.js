'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const envBefore = { ...process.env };
// SDK自身の再試行待機を短くする。実装や戻り値は差し替えない。
process.env.NODE_ENV = 'test';
const { marked } = require('marked');
const { getStore } = require('@netlify/blobs');
const { createBlobsHttp } = require('./review-blobs-test-helpers');
const authLib = require('../../../netlify/functions/lib/review-auth');
const { sanitizeReviewHtml } = require('../../../netlify/functions/lib/review-html');
const page = require('../../../netlify/functions/review-page');
const github = require('../../../netlify/functions/lib/github-api');
const notify = require('../../../netlify/functions/lib/notify');
const denylist = require('../../../netlify/functions/lib/denylist-store');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const ORIGIN = 'https://mori-zeirishi.net';
const PASSWORD = '試験用のパスワードです。本番では使いません。';
const nowBefore = Date.now;
let passed = 0;
let failed = 0;

// 通信先・時計・待機・通知・ログを全て試験内に閉じる。
function setup(options = {}) {
  let time = Date.now();
  const records = new Map();
  const etags = new Map();
  let version = 0;
  let comparisons = 0;
  const operations = [];
  const pause = () => options.ioDelay ? new Promise(resolve => setTimeout(resolve, options.ioDelay)) : Promise.resolve();
  const logs = [], delays = [], notices = [];
  const env = { REVIEW_PASSWORD: PASSWORD, REVIEW_SESSION_SECRET: crypto.randomBytes(32).toString('hex'), CONTEXT: 'production', ...options.env };
  const store = {
    getWithMetadata: async (key, readOptions) => {
      assert.deepEqual(readOptions, { type: 'json' });
      if (records.has(key) && !etags.has(key)) etags.set(key, JSON.stringify(`版${++version}`));
      const snapshot = records.has(key) ? { data: structuredClone(records.get(key)), etag: etags.get(key), metadata: {} } : null;
      operations.push({ operation: '読む', key });
      await pause();
      return snapshot;
    },
    set: async (key, serialized, condition) => {
      assert.equal(typeof serialized, 'string');
      const value = JSON.parse(serialized);
      assert.ok(condition && (condition.onlyIfNew === true || typeof condition.onlyIfMatch === 'string'));
      assert.equal(Object.keys(condition).length, 1);
      await pause();
      const modified = condition.onlyIfNew ? !records.has(key) : records.has(key) && condition.onlyIfMatch === etags.get(key);
      operations.push({ operation: '書く', key, modified, condition });
      if (!modified) return { modified: false };
      records.set(key, structuredClone(value)); etags.set(key, JSON.stringify(`版${++version}`));
      return { modified: true, etag: etags.get(key) };
    },
    delete: async key => { operations.push({ operation: '消す', key }); records.delete(key); etags.delete(key); },
  };
  const auth = authLib.createReviewAuth({ env, now: () => time, getStoreFn: input => {
    assert.deepEqual(input, { name: 'review-auth', fetch: input.fetch });
    assert.equal(typeof input.fetch, 'function');
    return options.realBlobs ? getStore({ ...input, ...options.realBlobs.connection }) : store;
  }, fetchFn: options.realBlobs?.fetch, sleep: async ms => { delays.push(ms); }, notify: async (...args) => { notices.push(args); }, log: entry => { logs.push(entry); },
  comparePassword: (input, expected) => {
    comparisons++; operations.push({ operation: '照合' });
    const digest = value => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(input), digest(expected));
  } });
  function event(password = PASSWORD, ip = '192.0.2.1', next = '/review?file=x.md&ref=draft%2Fx') {
    return { httpMethod: 'POST', headers: { origin: ORIGIN, host: 'mori-zeirishi.net', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-nf-client-connection-ip': ip }, body: new URLSearchParams({ password, next }).toString() };
  }
  function signed(changes = {}) {
    const { key } = auth.configuration({});
    const value = auth.issueSession(key);
    const session = auth.verifySession(value, key);
    return { httpMethod: 'POST', headers: { origin: ORIGIN, host: 'mori-zeirishi.net', 'content-type': 'application/json', cookie: `${authLib.COOKIE_NAME}=${value}`, 'x-review-token': auth.csrfToken(session, key), ...changes }, body: '{}' };
  }
  return { auth, env, records, logs, delays, notices, store, event, signed, operations, comparisons: () => comparisons, advance: ms => { time += ms; }, time: () => time };
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
  for (const [key, value] of Object.entries({ 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })) assert.equal(response.headers[key], value);
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
      '/review?x=%0d%0aSet-Cookie:', '/review?x=%250a', '/review?x=\\evil', '/review?x=%']) {
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
    assert.equal(cleared.records.get('global').count, 5); assert.equal(cleared.records.size, 1);
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
    for (const [method, password] of [['getWithMetadata', PASSWORD], ['set', '間違えた試験用のパスワード'], ['delete', PASSWORD]]) {
      const h = setup(); h.store[method] = async () => { throw new Error('試験用の障害'); };
      const response = await h.auth.login(h.event(password));
      assert.equal(response.statusCode, 503); assert.equal(response.headers['Set-Cookie'], undefined);
    }
    const h = setup(); h.records.set('global', { count: '壊れた記録' });
    assert.equal((await h.auth.login(h.event())).statusCode, 503);
    const unwritten = setup(); unwritten.store.set = async () => ({ modified: false });
    assert.equal((await unwritten.auth.login(unwritten.event('間違えた試験用のパスワード'))).statusCode, 429);
    assert.equal(unwritten.comparisons(), 0);
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
    vm.runInNewContext(loginScript, { document: { querySelector: selector => selector === 'form' ? { addEventListener() {} } : next } });
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
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: status === 200, status: url.endsWith('/review-auth-check') ? 204 : status, json: async () => ({}) }; },
      confirm: () => true, location: { search: '?file=x.md', assign: value => redirects.push(value) },
      setTimeout: callback => callback(),
    });
    vm.runInContext(script, context);
    for (const id of ['btnApprove', 'btnSkip', 'btnSkipForever']) await listeners.get(id)();
    listeners.get('btnRevise')(); assert.ok(controls.get('commentCard').classList.contains('show'));
    controls.get('reviewComment').value = '試験の修正コメント'; await listeners.get('btnRevise')();
    assert.deepEqual(requests.map(r => r.url), ['/.netlify/functions/review-auth-check', '/.netlify/functions/review-approve-background', '/.netlify/functions/review-skip', '/.netlify/functions/review-skip', '/.netlify/functions/review-revise']);
    assert.equal(JSON.parse(requests[3].options.body).suppress_topic, true);
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
    for (const expected of ['<h1>', '<table>', '<ul>', '<strong>', '<a href="https://example.invalid/" target="_blank" rel="noopener noreferrer">']) assert.ok(html.includes(expected));
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

  await testFixes();
  await testFixes2();
  console.log(`試験01の1〜15・01bのF1〜F8・01cのG1〜G3・G4: PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

async function testFixes() {
  await test('F1', '同サイトのフォームとsame-origin方針、ログインの各エラーはHTML', async () => {
    const h = setup();
    const login = h.auth.loginPage('/review?file=x.md');
    const review = await drawAuthenticated('---\ntitle: "試験の記事"\n---\n本文');
    for (const response of [login, review]) {
      assert.equal(response.headers['Referrer-Policy'], 'same-origin');
      assert.notEqual(response.headers['Referrer-Policy'], 'no-referrer');
    }
    assert.match(login.body, /<form method="post" action="\/review-login">/);
    assert.equal(new URL('/review-login', ORIGIN).origin, ORIGIN);
    const forbidden = h.event(); forbidden.headers.origin = 'null';
    const plain = h.event(); plain.headers['content-type'] = 'text/plain';
    const missing = setup({ env: { REVIEW_PASSWORD: undefined } });
    const unavailable = setup(); unavailable.store.getWithMetadata = async () => { throw new Error('試験用の障害'); };
    const limited = setup();
    for (let i = 0; i < 5; i++) await limited.auth.login(limited.event('間違えた試験用のパスワード'));
    for (const [response, status] of [
      [await h.auth.login(forbidden), 403], [await h.auth.login(plain), 403],
      [await h.auth.login({ httpMethod: 'GET' }), 405], [await missing.auth.login(missing.event()), 503],
      [await unavailable.auth.login(unavailable.event()), 503], [await limited.auth.login(limited.event()), 429],
    ]) {
      assert.equal(response.statusCode, status);
      assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
      assert.match(response.body, /レビュー画面にログイン/);
      assert.match(response.body, /action="\/review-login"/);
      assert.equal(response.headers['Set-Cookie'], undefined);
      assert.ok(!response.body.includes(PASSWORD));
    }
  });

  await test('F2', '照合前の条件付き書込、同じIP200件・異なるIP200件の同時要求', async () => {
    const wrong = '間違えた試験用のパスワード';
    const same = setup({ ioDelay: 2 });
    const sameResponses = await Promise.all(Array.from({ length: 200 }, () => same.auth.login(same.event(wrong))));
    const sameCount = same.comparisons();
    assert.ok(sameCount > 0 && sameCount <= 5);
    assert.equal(sameResponses.filter(response => response.statusCode === 401).length, sameCount);
    assert.equal(sameResponses.filter(response => response.statusCode === 429).length, 200 - sameCount);
    const different = setup({ ioDelay: 2 });
    const differentResponses = await Promise.all(Array.from({ length: 200 }, (_, i) => different.auth.login(different.event(wrong, `192.0.2.${i + 1}`))));
    const differentCount = different.comparisons();
    assert.ok(differentCount > 0 && differentCount <= 30);
    assert.equal(differentResponses.filter(response => response.statusCode === 401).length, differentCount);
    assert.equal(differentResponses.filter(response => response.statusCode === 429).length, 200 - differentCount);
    for (const h of [same, different]) {
      const writes = h.operations.slice(0, h.operations.findIndex(entry => entry.operation === '照合')).filter(entry => entry.operation === '書く' && entry.modified);
      assert.ok(writes.some(entry => entry.key.startsWith('ip/')));
      assert.ok(writes.some(entry => entry.key === 'global'));
    }
    // 全体の最後の枠と通知も、同時要求の後に一度だけ確保される。
    for (let i = differentCount; i < 30; i++) assert.equal((await different.auth.login(different.event(wrong, `198.51.100.${i + 1}`))).statusCode, 401);
    const blocked = await Promise.all(Array.from({ length: 200 }, (_, i) => different.auth.login(different.event(PASSWORD, `203.0.113.${i + 1}`))));
    assert.ok(blocked.every(response => response.statusCode === 429));
    assert.equal(different.comparisons(), 30); assert.equal(different.notices.length, 1);
    for (const conflictKey of ['ip', 'global']) {
      const h = setup();
      const write = h.store.set;
      h.store.set = async (key, ...args) => (conflictKey === 'global' ? key === 'global' : key.startsWith('ip/')) ? { modified: false } : write(key, ...args);
      assert.equal((await h.auth.login(h.event(PASSWORD))).statusCode, 429);
      assert.equal(h.comparisons(), 0); assert.equal(h.delays.length, 0);
      assert.equal(h.operations.filter(entry => entry.operation === '消す').length, 0);
    }
    const existing = setup();
    await existing.auth.login(existing.event(wrong)); await existing.auth.login(existing.event(wrong));
    assert.ok(existing.operations.some(entry => entry.operation === '書く' && typeof entry.condition.onlyIfMatch === 'string'));
    assert.ok(existing.operations.some(entry => entry.operation === '書く' && entry.condition.onlyIfNew === true));
    for (const malformed of [undefined, {}, { modified: '成功' }]) {
      const h = setup(); h.store.set = async () => malformed;
      assert.equal((await h.auth.login(h.event())).statusCode, 503); assert.equal(h.comparisons(), 0);
    }
    const noEtag = setup(); noEtag.store.getWithMetadata = async () => ({ data: {}, metadata: {} });
    assert.equal((await noEtag.auth.login(noEtag.event())).statusCode, 503); assert.equal(noEtag.comparisons(), 0);
    console.log(`  F2 照合回数: 同じIP200件=${sameCount} / 異なるIP200件=${differentCount}`);
  });

  await test('F3', '未閉鎖タグを本文内で閉じ、余分な閉じタグを除く', () => {
    const dangling = '<a href="https://evil.example/">続き';
    const clean = sanitizeReviewHtml(dangling);
    assert.equal(clean, '<a href="https://evil.example/" target="_blank" rel="noopener noreferrer">続き</a>');
    assert.equal((clean.match(/<a\b/g) || []).length, (clean.match(/<\/a>/g) || []).length);
    const html = page.renderReviewPage('x.md', {}, dangling, 'draft/test');
    assert.ok(html.includes(clean + '\n    </div>\n  </div>'));
    assert.ok(html.indexOf('続き</a>') < html.indexOf('id="factCheck"'));
    assert.equal(sanitizeReviewHtml('</div></div><script>危険()</script>'), '');
    const escaped = page.renderReviewPage('x.md', {}, '</div></div><script>危険()</script>', 'draft/test');
    assert.match(escaped, /id="articleBody">\s*<\/div>\s*<\/div>\s*<div class="card mb-4" id="factCheck">/);
    assert.equal(sanitizeReviewHtml('<table><tr><td>'), '<table><tr><td></td></tr></table>');
    assert.equal(sanitizeReviewHtml('<div><strong>文</div></strong>'), '<strong>文</strong>');
    assert.equal(sanitizeReviewHtml('<br><hr><img src="/images/x.png">'), '<br><hr><img src="/images/x.png">');
    assert.equal(sanitizeReviewHtml('<a href="#factCheck">詳細</a>'), '<a href="#factCheck">詳細</a>');
    const fixture = path.resolve(__dirname, '../../../docs/codex-tasks/review-page-layout/fixtures/2026-10-16-gift-cash-procedure-tax-return.md');
    // チェックボックスのinputは01でも除いていた。その他はリンクの属性だけ変わる。
    const ordinary = marked(page.parseFrontmatter(fs.readFileSync(fixture, 'utf8')).body).replace(/<input disabled="" type="checkbox">/g, '');
    assert.equal(sanitizeReviewHtml(ordinary).replace(/ target="_blank" rel="noopener noreferrer"/g, ''), ordinary);
  });

  await test('F4', '偽装可能な転送IPを使わず、不明・重複は同じ区分', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) {
      const event = h.event('間違えた試験用のパスワード');
      delete event.headers['x-nf-client-connection-ip'];
      event.headers['x-forwarded-for'] = `192.0.2.${i + 1}`;
      if (i === 1) { event.headers['x-nf-client-connection-ip'] = '192.0.2.1'; event.headers['X-Nf-Client-Connection-Ip'] = '192.0.2.2'; }
      if (i === 2) event.multiValueHeaders = { 'x-nf-client-connection-ip': ['192.0.2.3', '192.0.2.4'] };
      if (i === 3) event.headers['x-nf-client-connection-ip'] = '';
      if (i === 4) event.headers['x-nf-client-connection-ip'] = '   ';
      assert.equal((await h.auth.login(event)).statusCode, 401);
    }
    const event = h.event(); delete event.headers['x-nf-client-connection-ip']; event.headers['x-forwarded-for'] = '198.51.100.1';
    assert.equal((await h.auth.login(event)).statusCode, 429);
    assert.equal([...h.records.keys()].filter(key => key.startsWith('ip/')).length, 1);
    assert.equal((await h.auth.login(h.event(PASSWORD, '203.0.113.1'))).statusCode, 303);
  });

  await test('F5', 'IPは別用途HKDF鍵のHMACで、パスワード変更後も同じ区分', async () => {
    const source = crypto.randomBytes(32).toString('hex');
    async function keyFor(env) {
      const h = setup({ env }); await h.auth.login(h.event('間違えた試験用のパスワード'));
      const key = [...h.records.keys()].find(key => key.startsWith('ip/'));
      assert.equal(h.logs[0].ipHash, key.slice(3, 11));
      return key;
    }
    const env = { REVIEW_SESSION_SECRET: source };
    const first = await keyFor(env);
    assert.equal(await keyFor(env), first);
    assert.equal(await keyFor({ ...env, REVIEW_PASSWORD: '別の試験用のパスワードです。本番用ではありません。' }), first);
    assert.notEqual(await keyFor({ REVIEW_SESSION_SECRET: crypto.randomBytes(32).toString('hex') }), first);
    const ipKey = Buffer.from(crypto.hkdfSync('sha256', source, Buffer.alloc(0), 'hp-vlog review ip v1', 32));
    assert.equal(first, 'ip/' + crypto.createHmac('sha256', ipKey).update('192.0.2.1').digest('hex'));
    assert.equal(await keyFor({ REVIEW_SESSION_SECRET: undefined, GH_APP_PRIVATE_KEY: source }), first);
    const h = setup({ env });
    for (let i = 0; i < 4; i++) await h.auth.login(h.event('間違えた試験用のパスワード'));
    h.env.REVIEW_PASSWORD += '変更後';
    assert.equal((await h.auth.login(h.event('間違えた試験用のパスワード'))).statusCode, 401);
    assert.equal((await h.auth.login(h.event(h.env.REVIEW_PASSWORD))).statusCode, 429);
    assert.doesNotMatch(JSON.stringify([...h.records]) + JSON.stringify(h.logs), /192\.0\.2\.1/);
  });

  await test('F6', '外部画像はaltごと除去し、同サイトの画像だけ保持', async () => {
    for (const src of ['https://evil.example/image.gif', 'http://evil.example/image.gif', '//evil.example/image.gif', '&#47;&#47;evil.example/image.gif', 'data:image/png,試験', 'image.gif', '/\\evil.example/image.gif']) {
      assert.equal(sanitizeReviewHtml(`<img src="${src}" alt="外部の代替文字">`), '');
    }
    assert.equal(sanitizeReviewHtml('<img src="/images/a.png" alt="同サイト">'), '<img src="/images/a.png" alt="同サイト">');
    assert.equal(sanitizeReviewHtml('<img alt="画像なし">'), '');
    const h = setup();
    const review = await drawAuthenticated('---\ntitle: "試験の記事"\n---\n<img src="https://evil.example/image.gif" alt="外部の代替文字">');
    for (const response of [h.auth.loginPage('/review'), review]) assert.equal(response.headers['Content-Security-Policy'].match(/img-src ([^;]+)/)[1], "'self' data:");
    assert.ok(!review.body.includes('外部の代替文字')); assert.ok(!review.body.includes('https://evil.example/image.gif'));
  });

  await test('F7', 'httpを含む正常な道筋を保ち、外部・制御文字などは拒否', async () => {
    const h = setup();
    for (const next of ['/review?file=x.md&ref=draft/http-guide', '/review?file=https-guide.md', '/review?x=https://evil.example/', '/review?file=x.md&ref=draft%2Fhttp-guide']) {
      assert.equal(authLib.safeNext(next), next);
      assert.equal((await h.auth.login(h.event(PASSWORD, '192.0.2.1', next))).headers.Location, next);
    }
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil', '/review%0d%0aSet-Cookie:', '/admin', '/review?x=%25250a', '/review?x=%25255c']) assert.equal(authLib.safeNext(next), '/review');
  });

  await test('F8', '同期確認の204・401・403・503と、確認失敗時の承認送信0回', async () => {
    const check = require('../../../netlify/functions/review-auth-check');
    await withActions(async (_, calls) => {
      const valid = authenticatedEvent({ httpMethod: 'POST', body: '{}' });
      assert.equal((await check.handler(valid)).statusCode, 204);
      for (const [headers, status] of [[{ cookie: undefined }, 401], [{ origin: 'https://evil.example' }, 403], [{ 'x-review-token': undefined }, 403], [{ 'content-type': 'text/plain' }, 403]]) assert.equal((await check.handler({ ...valid, headers: { ...valid.headers, ...headers } })).statusCode, status);
      const before = process.env.REVIEW_PASSWORD; delete process.env.REVIEW_PASSWORD;
      try { assert.equal((await check.handler(valid)).statusCode, 503); } finally { process.env.REVIEW_PASSWORD = before; }
      assert.equal((await check.handler({ httpMethod: 'GET' })).statusCode, 405);
      assert.equal(calls.length, 0);
    });
    const response = await drawAuthenticated('---\ntitle: "試験の記事"\n---\n本文');
    const script = checkPageHeaders(response);
    assert.ok(script.indexOf("fetch(FUNC_BASE + '/review-auth-check'") < script.indexOf("fetch(FUNC_BASE + endpoint"));
    assert.ok(script.includes('check.status !== 204'));
    for (const status of [204, 401, 403, 503, 200, 202, '通信失敗']) {
      const requests = [], redirects = [], controls = new Map(), listeners = new Map();
      for (const id of ['btnApprove', 'btnRevise', 'btnSkip', 'btnSkipForever', 'btnLogout', 'commentCard', 'reviewComment', 'resultMsg', 'publishAt', 'suppressTopic']) controls.set(id, { value: '', checked: false, disabled: false, addEventListener: (_, fn) => listeners.set(id, fn) });
      const buttons = ['btnApprove', 'btnRevise', 'btnSkip'].map(id => controls.get(id));
      vm.runInNewContext(script, {
        document: { getElementById: id => controls.get(id), querySelectorAll: () => buttons },
        fetch: async (url, options) => {
          requests.push({ url, options });
          if (url.endsWith('/review-auth-check')) { if (status === '通信失敗') throw new Error('試験用の通信障害'); return { status }; }
          return { status: 202, ok: true };
        },
        confirm: () => true, location: { search: '?file=x.md', assign: value => redirects.push(value) }, setTimeout: fn => fn(),
      });
      await listeners.get('btnApprove')();
      assert.equal(requests[0].url, '/.netlify/functions/review-auth-check');
      assert.equal(requests[0].options.body, '{}'); assert.equal(requests[0].options.method, 'POST');
      assert.equal(requests[0].options.headers['Content-Type'], 'application/json'); assert.ok(requests[0].options.headers['X-Review-Token']);
      if (status === 204) {
        assert.deepEqual(requests.map(request => request.url), ['/.netlify/functions/review-auth-check', '/.netlify/functions/review-approve-background']);
        assert.deepEqual(requests[1].options.headers, requests[0].options.headers);
        assert.match(controls.get('resultMsg').className, /success/);
      } else {
        assert.equal(requests.length, 1); assert.match(controls.get('resultMsg').className, /error/);
        if (status === 401) { assert.equal(controls.get('resultMsg').textContent, 'ログインし直してください'); assert.deepEqual(redirects, ['/review?file=x.md']); }
        else assert.ok(buttons.every(button => button.disabled === false));
      }
    }
  });
}

async function testFixes2() {
  await test('G1', '実物のBlobs SDKの条件ヘッダ、同時要求、HTTP失敗時の閉鎖', async () => {
    const wrong = '間違えた試験用のパスワード';
    const backend = createBlobsHttp();
    const h = setup({ realBlobs: backend });
    assert.equal((await h.auth.login(h.event(wrong))).statusCode, 401);
    const firstWrites = backend.requests.filter(request => request.method === 'PUT');
    assert.equal(firstWrites.length, 2);
    assert.ok(firstWrites.every(request => request.ifNoneMatch === '*' && request.ifMatch === null && request.status === 200));
    const previousEtags = new Map(backend.etags);
    assert.equal((await h.auth.login(h.event(wrong))).statusCode, 401);
    const nextWrites = backend.requests.filter(request => request.method === 'PUT').slice(2);
    assert.equal(nextWrites.length, 2);
    for (const request of nextWrites) {
      assert.equal(request.ifMatch, previousEtags.get(request.key));
      assert.equal(request.ifNoneMatch, null); assert.equal(request.status, 200);
      assert.equal(JSON.parse(backend.records.get(request.key)).count, 2);
    }
    const counts = [];
    for (const sameIp of [true, false]) {
      const http = createBlobsHttp();
      const concurrent = setup({ realBlobs: http });
      const responses = await Promise.all(Array.from({ length: 200 }, (_, i) => concurrent.auth.login(concurrent.event(wrong, sameIp ? '192.0.2.1' : `192.0.2.${i + 1}`))));
      const count = concurrent.comparisons();
      assert.ok(count > 0 && count <= (sameIp ? 5 : 30));
      assert.equal(responses.filter(response => response.statusCode === 401).length, count);
      assert.equal(responses.filter(response => response.statusCode === 429).length, 200 - count);
      assert.ok(http.requests.some(request => request.method === 'PUT' && request.status === 412));
      assert.ok(http.requests.filter(request => request.method === 'PUT').every(request => request.ifMatch !== null || request.ifNoneMatch === '*'));
      assert.ok(responses.every(response => !response.headers['Set-Cookie']));
      counts.push(count);
    }
    // SDKがETag付きのエラーもmodified:trueにする経路を、fetchで先に止める。
    for (const status of [201, 204, 400, 401, 403, 404, 429, 500]) {
      for (const globalOnly of [false, true]) {
        const http = createBlobsHttp({ writeStatus: key => !globalOnly || key === 'global' ? status : 200 });
        const stopped = setup({ realBlobs: http });
        const response = await stopped.auth.login(stopped.event());
        assert.equal(response.statusCode, 503);
        assert.equal(stopped.comparisons(), 0);
        assert.equal(response.headers['Set-Cookie'], undefined);
        assert.equal(stopped.notices.length, 0);
        assert.ok(http.requests.some(request => request.method === 'PUT' && request.status === status));
        assert.ok(!http.requests.some(request => request.method === 'DELETE'));
      }
    }
    const conflict = setup({ realBlobs: createBlobsHttp({ writeStatus: 412 }) });
    const response = await conflict.auth.login(conflict.event());
    assert.equal(response.statusCode, 429); assert.equal(conflict.comparisons(), 0);
    assert.match(response.body, /もう一度お試しください/);
    const unreadable = setup({ realBlobs: createBlobsHttp({ readStatus: 403 }) });
    assert.equal((await unreadable.auth.login(unreadable.event())).statusCode, 503);
    assert.equal(unreadable.comparisons(), 0);
    const noEtag = setup({ realBlobs: createBlobsHttp({ omitEtag: true }) });
    assert.equal((await noEtag.auth.login(noEtag.event(wrong))).statusCode, 401);
    assert.equal((await noEtag.auth.login(noEtag.event())).statusCode, 503);
    assert.equal(noEtag.comparisons(), 1);
    const successful = setup({ realBlobs: createBlobsHttp() });
    assert.equal((await successful.auth.login(successful.event())).statusCode, 303);
    assert.equal(successful.comparisons(), 1);
    console.log(`  G1 実物SDK: 新規=If-None-Match:* / 既存=If-Match:保存済みETag / 同じIP200件=${counts[0]} / 異なるIP200件=${counts[1]} / PUT403・500=503、照合0回`);
  });

  await test('G2', '暗黙の閉鎖・表の入れ子を正規化し本文カードの境界を保持', () => {
    const examples = [
      ['<li><div><li></div>外の文', '<li></li><li>外の文</li>'],
      ['<table><table></table></table>外の文', '<table></table>外の文'],
      ['<dl><dt><div><dt></div>外', '<dl><dt></dt><dt>外</dt></dl>'],
      ['<p><table></p>外', '<p></p><table>外</table>'],
    ];
    for (const [input, expected] of examples) {
      const clean = sanitizeReviewHtml(input);
      assert.equal(clean, expected);
      assert.doesNotMatch(clean, /<\/?div\b|<table>[^]*<table>/);
      const html = page.renderReviewPage('x.md', {}, input, 'draft/test');
      const bodyStart = html.indexOf('id="articleBody">');
      const cardStart = html.lastIndexOf('<div class="card mb-4">', bodyStart);
      const bodyEnd = html.indexOf('</div>', bodyStart);
      const stack = [];
      let cardEnd = -1;
      // 依存関係を足さず、本文カード全体の開始・終了タグを文字列で照合する。
      for (const match of html.slice(cardStart).matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
        const tag = match[2].toLowerCase();
        if (['br', 'hr', 'img', 'input'].includes(tag)) continue;
        if (match[1]) assert.equal(stack.pop(), tag);
        else stack.push(tag);
        if (!stack.length) { cardEnd = cardStart + match.index + match[0].length; break; }
      }
      assert.ok(cardStart >= 0 && cardEnd > bodyEnd);
      const marker = html.indexOf('外', bodyStart);
      assert.ok(marker > bodyStart && marker < bodyEnd && marker < cardEnd);
      assert.ok(html.slice(cardStart, cardEnd).includes(clean));
      assert.match(html.slice(cardEnd), /id="factCheck"/);
    }
    assert.equal(sanitizeReviewHtml('<table>外<table>内</table>末</table>後'), '<table>外内末</table>後');
    assert.equal(sanitizeReviewHtml('<ul><li>外<ul><li>内<li>次</ul><li>末</ul>'), '<ul><li>外<ul><li>内</li><li>次</li></ul></li><li>末</li></ul>');
    assert.equal(sanitizeReviewHtml('<dl><dt>外<dl><dd>内<dt>次</dl><dd>末</dl>'), '<dl><dt>外<dl><dd>内</dd><dt>次</dt></dl></dt><dd>末</dd></dl>');
    assert.equal(sanitizeReviewHtml('<dl><dt>語<dd>説明<dt>次</dl>'), '<dl><dt>語</dt><dd>説明</dd><dt>次</dt></dl>');
    assert.equal(sanitizeReviewHtml('<p>前<p>後'), '<p>前</p><p>後</p>');
    for (const tag of ['ul', 'ol', 'table', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'dl']) {
      assert.ok(sanitizeReviewHtml(`<p>前<${tag}>後`).startsWith(`<p>前</p><${tag}>`));
    }
    const fixture = path.resolve(__dirname, '../../../docs/codex-tasks/review-page-layout/fixtures/2026-10-16-gift-cash-procedure-tax-return.md');
    const parsed = page.parseFrontmatter(fs.readFileSync(fixture, 'utf8'));
    const original = marked(parsed.body).replace(/<input disabled="" type="checkbox">/g, '');
    const clean = sanitizeReviewHtml(original);
    assert.equal(clean.replace(/ target="_blank" rel="noopener noreferrer"/g, ''), original);
    const html = page.renderReviewPage('x.md', parsed.meta, marked(parsed.body), 'draft/test');
    assert.ok(html.includes(clean)); assert.doesNotMatch(html, /table-wrapper/);
    const refresh = page.renderReviewPage('x.md', { refresh_of: 'published' }, '<p>本文</p>', 'draft/test', {
      available: true, diff: [{ heading: '表', changedParagraphs: {
        before: [{ text: '| 列 |\n|---|\n| 前 |', changed: true }],
        after: [{ text: '| 列 |\n|---|\n| 後 |', changed: true }],
      } }],
    });
    assert.doesNotMatch(refresh, /table-wrapper/);
    assert.equal((refresh.match(/<table>/g) || []).length, 2);
    assert.match(refresh, /\.article-body table, \.refresh-diff-list table \{ display: block;[^}]*overflow-x: auto;[^}]*-webkit-overflow-scrolling: touch;/);
  });

  await test('G3', 'ログイン送信を一度に制限し、競合と上限の429の文言を分ける', async () => {
    const h = setup();
    const script = checkPageHeaders(h.auth.loginPage('/review?file=x.md'));
    const button = { disabled: false, textContent: 'レビュー画面を開く' };
    const next = { value: '%2freview%3ffile%3dx.md' };
    let submit;
    const form = {
      addEventListener: (name, listener) => { assert.equal(name, 'submit'); submit = listener; },
      querySelector: selector => { assert.equal(selector, 'button[type="submit"]'); return button; },
    };
    vm.runInNewContext(script, { document: { querySelector: selector => selector === 'form' ? form : next } });
    assert.equal(next.value, '/review?file=x.md'); assert.equal(typeof submit, 'function');
    let prevented = 0;
    const event = { preventDefault: () => { prevented++; } };
    submit(event);
    assert.equal(button.disabled, true); assert.equal(button.textContent, '確認しています…');
    assert.equal(prevented, 0);
    submit(event); assert.equal(prevented, 1);
    h.store.set = async () => ({ modified: false });
    const conflict = await h.auth.login(h.event());
    assert.equal(conflict.statusCode, 429); assert.equal(h.comparisons(), 0);
    assert.match(conflict.body, /もう一度お試しください/);
    assert.doesNotMatch(conflict.body, /しばらくしてからお試しください/);
    const capped = setup();
    for (let i = 0; i < 5; i++) await capped.auth.login(capped.event('間違えた試験用のパスワード'));
    const limited = await capped.auth.login(capped.event());
    assert.equal(limited.statusCode, 429); assert.equal(capped.comparisons(), 5);
    assert.match(limited.body, /しばらくしてからお試しください/);
    assert.doesNotMatch(limited.body, /もう一度お試しください/);
  });

  await test('G4', '通常の接続でログインでき、古い記録は条件付き書き込みで拒否する', async () => {
    const wrong = '間違えた試験用のパスワード';
    const lambdaHttp = createBlobsHttp();
    const h = setup();
    const contextBefore = process.env.NETLIFY_BLOBS_CONTEXT;
    let lambdaComparisons = 0;
    const lambda = authLib.createReviewAuth({ env: h.env, now: h.time, fetchFn: lambdaHttp.fetch,
      sleep: async () => {}, notify: async () => {}, log: () => {},
      comparePassword: (input, expected) => {
        lambdaComparisons++;
        const digest = value => crypto.createHash('sha256').update(value).digest();
        return crypto.timingSafeEqual(digest(input), digest(expected));
      },
    });
    try {
      for (const [password, status] of [[wrong, 401], [PASSWORD, 303]]) {
        const event = h.event(password);
        event.headers['x-nf-site-id'] = lambdaHttp.connection.siteID;
        event.headers['x-nf-deploy-id'] = crypto.randomUUID();
        event.blobs = Buffer.from(JSON.stringify({ url: lambdaHttp.connection.edgeURL, token: lambdaHttp.connection.token })).toString('base64');
        const response = await lambda.login(event);
        assert.equal(response.statusCode, status);
        if (status === 303) assert.ok(response.headers['Set-Cookie']);
        else assert.equal(response.headers['Set-Cookie'], undefined);
        const context = JSON.parse(Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT, 'base64').toString('utf8'));
        assert.deepEqual(Object.keys(context).sort(), ['deployID', 'edgeURL', 'siteID', 'token']);
      }
      assert.equal(lambdaComparisons, 2);
      const reads = lambdaHttp.requests.filter(request => request.method === 'GET');
      assert.ok(reads.length > 0);
      assert.ok(reads.every(request => request.origin === lambdaHttp.connection.edgeURL));
      assert.ok(lambdaHttp.requests.some(request => request.method === 'DELETE'));
      assert.equal([...lambdaHttp.records.keys()].filter(key => key.startsWith('ip/')).length, 0);
    } finally {
      if (contextBefore === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT;
      else process.env.NETLIFY_BLOBS_CONTEXT = contextBefore;
    }
    for (const target of ['ip', 'global']) {
      for (const blocked of [false, true]) {
        const http = createBlobsHttp();
        const stale = setup({ realBlobs: http });
        const attempts = blocked ? target === 'ip' ? 5 : 30 : 2;
        for (let i = 0; i < attempts; i++) {
          assert.equal((await stale.auth.login(stale.event(wrong, target === 'ip' ? '192.0.2.1' : `192.0.2.${i + 1}`))).statusCode, 401);
        }
        const key = target === 'global' ? 'global' : [...http.records.keys()].find(name => name.startsWith('ip/'));
        const current = http.records.get(key);
        const previous = http.previous.get(key);
        assert.equal(JSON.parse(previous.body).count, attempts - 1);
        assert.equal(JSON.parse(previous.body).blockedUntil, 0);
        assert.equal(JSON.parse(current).blockedUntil > stale.time(), blocked);
        assert.notEqual(previous.etag, http.etags.get(key));
        http.staleReads.add(key);
        const before = { comparisons: stale.comparisons(), requests: http.requests.length, notices: stale.notices.length };
        const response = await stale.auth.login(stale.event(PASSWORD, target === 'ip' ? '192.0.2.1' : '198.51.100.240'));
        assert.equal(response.statusCode, 429);
        assert.match(response.body, /もう一度お試しください/);
        assert.doesNotMatch(response.body, /しばらくしてからお試しください/);
        assert.equal(response.headers['Set-Cookie'], undefined);
        assert.equal(stale.comparisons() - before.comparisons, 0);
        assert.equal(stale.notices.length, before.notices);
        assert.equal(http.records.get(key), current);
        const requests = http.requests.slice(before.requests);
        const write = requests.find(request => request.method === 'PUT' && request.key === key);
        assert.ok(write); assert.equal(write.ifMatch, previous.etag); assert.equal(write.status, 412);
        assert.ok(!requests.some(request => request.method === 'DELETE'));
      }
    }
    // 新規作成前の「記録なし」を読んでも、If-None-Matchで競合して照合しない。
    const absentHttp = createBlobsHttp();
    const absent = setup({ realBlobs: absentHttp });
    assert.equal((await absent.auth.login(absent.event(wrong))).statusCode, 401);
    const ipKey = [...absentHttp.records.keys()].find(key => key.startsWith('ip/'));
    assert.equal(absentHttp.previous.get(ipKey), null);
    absentHttp.staleReads.add(ipKey);
    const response = await absent.auth.login(absent.event());
    assert.equal(response.statusCode, 429); assert.equal(absent.comparisons(), 1);
    assert.match(response.body, /もう一度お試しください/);
    const write = absentHttp.requests.filter(request => request.method === 'PUT').at(-1);
    assert.equal(write.ifNoneMatch, '*'); assert.equal(write.status, 412);
    console.log('  G4 実物SDK: uncachedEdgeURLなしで誤り401・成功303 / 読み込み先=edgeURL / 古いIP・全体記録（停止前を含む）は412→429、照合0回');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Date.now = nowBefore;
  for (const name of Object.keys(process.env)) if (!Object.hasOwn(envBefore, name)) delete process.env[name];
  Object.assign(process.env, envBefore);
});
