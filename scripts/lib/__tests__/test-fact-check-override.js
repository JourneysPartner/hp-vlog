'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const matter = require('gray-matter');
const { authenticatedEvent } = require('./review-auth-test-helpers');
const approval = require('../../../netlify/functions/review-approve-background');
const api = require('../../../netlify/functions/lib/github-api');
const page = require('../../../netlify/functions/review-page');
const { buildMessage } = require('../../../netlify/functions/lib/notify/message');
const F = require('../fact-check');
const { refreshBaseHash } = require('../freshness-refresh');
const publish = require('../../publish-due');
const { validateFile } = require('../../validate');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const now = '2026-11-06T12:34:56+09:00';
const filename = '2026-11-06-override-check.md';
const originalBody = '## 制度\n公開中の本文です。\n免責: 本記事は情報提供です。';
const body = '## 制度\n確認した本文です。\n免責: 本記事は情報提供です。';
const base = {
  title: '制度を確かめる', slug: 'override-check', summary: '要約', category: '消費税',
  created_at: now, updated_at: now, primary_persona: 'general_individual_proprietor',
  search_intent: '制度の申告をどう進めるか', reader_problem: '申告の手続を確認したい',
  success_outcome: '必要な手続が分かる', primary_question: '申告の手続は何か',
  review_status: 'needs_review', source_url: 'https://www.nta.go.jp/example',
  source_guard_version: 1, source_provenance: 'curated', tax_domain: 'consumption_tax',
  recommendation: 'revise', fact_check_prev_recommendation: 'publish',
  fact_check_status: 'revise', fact_check_summary: '見出しに食い違いが残っています', fact_check_blocking: true,
  customer_fit_score: 5, search_intent_score: 5, source_alignment_score: 5,
};
function serialize(meta, text) { return matter.stringify(text, meta).replace(/^title:.*$/m, () => `title: ${JSON.stringify(meta.title)}`); }
function article(meta = {}, text = body) { return serialize({ ...base, ...meta }, text); }
function setup(meta = {}, { refresh = false, mainMeta = {}, putError = '', putResult = { commit: { sha: 'approved-commit' } }, mergeImpl = null, fallbackMainStatus = '' } = {}) {
  const data = { ...base, ...meta };
  if (meta.fact_check_prev_recommendation === undefined && Object.hasOwn(meta, 'fact_check_prev_recommendation')) delete data.fact_check_prev_recommendation;
  if (refresh) Object.assign(data, { refresh_of: 'published', refresh_base_hash: refreshBaseHash(originalBody + '\n') });
  const branch = serialize(data, body);
  const main = article({ recommendation: 'publish', review_status: 'published', fact_check_status: 'ok', fact_check_blocking: false, ...mainMeta }, originalBody);
  const state = { puts: [], notifications: [], merges: [], closes: [], deletes: [], waits: 0 };
  const deps = {
    getFile: async (_file, ref) => {
      if (ref === undefined && fallbackMainStatus) return { content: article({ review_status: fallbackMainStatus }), sha: 'main-sha' };
      if (ref === 'main') { if (!refresh && !mainMeta.review_status) throw new Error('404 not found'); return { content: main, sha: 'main-sha' }; }
      return { content: branch, sha: 'seen-sha' };
    },
    putFile: async (...args) => { state.puts.push(args); if (putError) throw new Error(putError); return putResult; },
    updateFrontmatter: api.updateFrontmatter, nowJST: () => now,
    findPR: async ref => ({ number: 744, head: { ref } }),
    waitForMergeable: async () => { state.waits++; return { mergeable: true }; },
    mergePR: async (...args) => { state.merges.push(args); return mergeImpl ? mergeImpl(...args) : { merged: true }; },
    closePR: async n => state.closes.push(n), deleteBranch: async ref => state.deletes.push(ref),
    findApprovedArticlesForDate: async () => [],
    sendNotification: async (event, data) => state.notifications.push({ event, data }),
  };
  return { state, branch, main, run: (extra = {}) => approval._handler(authenticatedEvent({ httpMethod: 'POST', body: JSON.stringify({
    filename, ref: refresh ? 'draft/refresh-override-check' : 'draft/override-check',
    publish_at: '2020-01-01T11:30:00+09:00', ...extra,
  }) }), deps) };
}
const consent = { fact_check_override: true, file_sha: 'seen-sha' };
function noWrites(h) { assert.equal(h.state.puts.length, 0); assert.equal(h.state.merges.length, 0); assert.equal(h.state.closes.length, 0); assert.equal(h.state.deletes.length, 0); }

for (const refresh of [false, true]) {
  for (const value of [undefined, false, 'true', 1]) test(`S1: 明示した真偽値だけを受け付ける (${refresh}, ${value})`, async () => {
    const h = setup({ fact_check_override: true }, { refresh });
    assert.equal((await h.run({ file_sha: 'seen-sha', fact_check_override: value })).statusCode, 400);
    noWrites(h);
    assert.match(JSON.stringify(h.state.notifications), /確認欄に印を付けて/);
  });
  for (const file_sha of [undefined, '', 'old-sha']) test(`S2: 見た版が無い・違う (${refresh}, ${file_sha})`, async () => {
    const h = setup({}, { refresh });
    assert.equal((await h.run({ ...consent, file_sha })).statusCode, 409);
    noWrites(h);
    assert.equal(h.state.notifications[0].event, refresh ? 'refresh_approve_failed' : 'quality_blocked');
    assert.match(JSON.stringify(h.state.notifications), /開き直して/);
  });
  test(`S4/R5: 照合結果を保って承認の記録と通知を残す (${refresh})`, async () => {
    const h = setup({}, { refresh });
    assert.equal((await h.run(consent)).statusCode, 200);
    const saved = matter(h.state.puts[0][1]).data;
    const before = matter(refresh ? h.main : h.branch).data;
    assert.equal(saved.review_status, refresh ? 'published' : 'approved');
    assert.equal(saved.recommendation, 'publish');
    assert.equal(saved.fact_check_override, true);
    assert.equal(saved.fact_check_override_at, now);
    assert.equal(saved.fact_check_override_status, 'revise');
    assert.equal(saved.fact_check_override_summary, base.fact_check_summary);
    assert.equal(saved.fact_check_override_sha, 'seen-sha');
    for (const key of ['fact_check_status', 'fact_check_blocking', 'fact_check_summary']) assert.deepEqual(saved[key], before[key], key);
    const n = h.state.notifications.find(n => n.event === (refresh ? 'refresh_published' : 'approved'));
    assert.ok(n);
    assert.ok(buildMessage(n.event, n.data).body.includes(`照合の指摘が残ったまま、確認のうえ公開しました（照合: ${base.fact_check_summary}）`));
    if (refresh) assert.equal(h.state.puts[0][4], 'main');
  });
  for (const previous of ['revise', 'reject', undefined]) test(`S3: 照合前の要修正・非推奨・不明を通さない (${refresh}, ${previous})`, async () => {
    const h = setup({ fact_check_prev_recommendation: previous }, { refresh });
    assert.equal((await h.run(consent)).statusCode, 400); noWrites(h);
    assert.match(JSON.stringify(h.state.notifications), /recommendation が (revise|reject) です/);
  });
  test(`R2: not_run の停止も明示した要求で承認できる (${refresh})`, async () => {
    const h = setup({ fact_check_status: 'not_run' }, { refresh });
    assert.equal((await h.run(consent)).statusCode, 200);
    assert.equal(matter(h.state.puts[0][1]).data.fact_check_override_status, 'not_run');
  });
  test(`R2: 止まっていない記事には記録を足さない (${refresh})`, async () => {
    const h = setup({ recommendation: 'publish', fact_check_status: 'ok', fact_check_blocking: false }, { refresh });
    assert.equal((await h.run(consent)).statusCode, 200);
    assert.ok(!Object.keys(matter(h.state.puts[0][1]).data).some(k => k.startsWith('fact_check_override')));
    assert.ok(!buildMessage(h.state.notifications[0].event, h.state.notifications[0].data).body.includes('指摘が残ったまま'));
  });
}
for (const meta of [
  { title: '[要レビュー] override-check' }, { recommendation: 'reject' },
  { source_url: 'https://example.invalid/source', source_provenance: 'unknown' },
  { customer_fit_score: 3 }, { search_intent_score: 3 },
]) test(`S3: 既存のゲートを維持 ${JSON.stringify(meta)}`, async () => {
  const h = setup(meta); assert.equal((await h.run(consent)).statusCode, 400); noWrites(h);
});
test('S3: 公開済み記事の保護', async () => {
  const h = setup({}, { mainMeta: { review_status: 'published' } });
  assert.equal((await h.run(consent)).statusCode, 409); noWrites(h);
});
for (const mainMeta of [{ title: '[要レビュー] override-check' }, { recommendation: 'reject' },
  { source_url: 'https://example.invalid/source', source_provenance: 'unknown' }, { customer_fit_score: 3 }, { search_intent_score: 3 }]) {
  test(`S3: 更新案でも main の既存のゲートを維持 ${JSON.stringify(mainMeta)}`, async () => {
    const h = setup({}, { refresh: true, mainMeta });
    assert.equal((await h.run(consent)).statusCode, 400); noWrites(h);
  });
}
test('S4: 既存の記録があっても要約の引用符・改行・置換文字をそのまま残す', async () => {
  for (const refresh of [false, true]) {
    const summary = '指摘 "$&"\n次の行';
    const h = setup({ fact_check_summary: summary, fact_check_override_summary: '過去の要約' }, { refresh,
      mainMeta: { fact_check_override_summary: '過去の要約' } });
    assert.equal((await h.run(consent)).statusCode, 200);
    const saved = matter(h.state.puts[0][1]).data;
    assert.equal(saved.fact_check_override_summary, summary);
    assert.equal(saved.fact_check_override, true);
  }
});
test('R1: GitHub から取得した枝の SHA を画面に埋める', async () => {
  const getFile = api.getFile, oldEnv = { GH_APP_ID: process.env.GH_APP_ID, GH_APP_PRIVATE_KEY: process.env.GH_APP_PRIVATE_KEY, GH_APP_INSTALLATION_ID: process.env.GH_APP_INSTALLATION_ID };
  Object.assign(process.env, { GH_APP_ID: 'test', GH_APP_PRIVATE_KEY: 'test', GH_APP_INSTALLATION_ID: 'test' });
  api.getFile = async file => file.startsWith('content/posts/') ? { content: article(), sha: 'seen-sha' } : { content: '{}', sha: 'record-sha' };
  try {
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET', queryStringParameters: { file: filename, ref: 'draft/override-check' } }));
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('const FILE_SHA = "seen-sha";'));
  } finally {
    api.getFile = getFile;
    for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test('S2: 取得後に sha が変わって PUT が失敗したらマージしない', async () => {
  const h = setup({}, { putError: '409 sha conflict' });
  assert.equal((await h.run(consent)).statusCode, 500); assert.equal(h.state.merges.length, 0);
});
test('R1: 確認欄・SHA・初期の disabled・not_run の文言', () => {
  for (const status of ['revise', 'not_run']) {
    const html = page.renderReviewPage(filename, { ...base, fact_check_status: status }, '<p>本文</p>', '', null, null, { fileSha: '</script>sha' });
    assert.match(html, /id="factCheckOverride"/);
    assert.match(html, /id="btnApprove" disabled/);
    assert.match(html, /照合の指摘を確認しました。指摘が残ったまま、自分の判断で公開します/);
    assert.match(html, /file_sha: FILE_SHA/);
    assert.ok(!html.includes('const FILE_SHA = "</script>'));
    if (status === 'not_run') assert.match(html, /照合が最後まで動いていません。照合の指摘/);
  }
  const html = page.renderReviewPage(filename, { ...base, fact_check_status: 'ok', fact_check_blocking: false }, '', '');
  assert.ok(!html.includes('id="factCheckOverride"'));
  assert.ok(!/id="btnApprove" disabled/.test(html));
});
test('R1: 印の変更・送信・失敗後も確認欄でボタンを制御する', async () => {
  const html = page.renderReviewPage(filename, base, '', '', null, null, { fileSha: 'seen-sha' });
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { checked: false, disabled: false, value: '', addEventListener(type, fn) { this[type] = fn; } }); return nodes.get(id); };
  let payload;
  const context = vm.createContext({ document: { getElementById: node, querySelectorAll: () => [node('btnApprove'), node('btnRevise')] },
    window: { location: {} }, fetch: async (url, req) => {
      if (url.endsWith('review-auth-check')) return { status: 204 };
      payload = JSON.parse(req.body); return { status: 400, ok: false, json: async () => ({ error: '試験の失敗' }) };
    } });
  vm.runInContext(script, context);
  node('factCheckOverride').checked = true; node('factCheckOverride').change(); assert.equal(node('btnApprove').disabled, false);
  await vm.runInContext("handleAction('approve')", context);
  assert.equal(payload.file_sha, 'seen-sha'); assert.equal(payload.fact_check_override, true);
  node('factCheckOverride').checked = false; node('factCheckOverride').change(); assert.equal(node('btnApprove').disabled, true);
  await vm.runInContext("handleAction('approve')", context); assert.ok(!Object.hasOwn(payload, 'fact_check_override'));
  assert.equal(node('btnApprove').disabled, true);
});
test('S5: 新しい照合で全ての上書き欄を消し、他の結果は同じ', () => {
  const audit = { fact_check_override: true, fact_check_override_at: now, fact_check_override_status: 'revise',
    fact_check_override_summary: '過去の要約', fact_check_override_sha: 'old', fact_check_override_future: '古い欄' };
  const before = article({ recommendation: 'publish' });
  const result = { body, record: { status: 'ok', summary: '新しい照合', claims: [] } };
  assert.equal(F.applyFactResult(F.updateMeta(before, audit), result), F.applyFactResult(before, result));
  const multiline = before.replace('\nrecommendation:', '\nfact_check_override_summary: |\n  過去の要約\n  次の行\nrecommendation:');
  assert.equal(F.applyFactResult(multiline, result), F.applyFactResult(before, result));
});
test('R7: 公開状態の停止に上書きの真偽値が必要', () => {
  const read = fs.readFileSync, file = path.join(__dirname, '__override-validation__.md');
  let raw;
  fs.readFileSync = function (p, ...args) { return p === file ? raw : read.call(this, p, ...args); };
  try {
    for (const status of ['approved', 'scheduled', 'published']) for (const override of [undefined, 'true', true]) {
      raw = article({ review_status: status, recommendation: 'publish', ...(override === undefined ? {} : { fact_check_override: override }) });
      const result = validateFile(file);
      const errors = result.errors.filter(e => e.includes('照合で止まっている記事'));
      assert.equal(errors.length, override === true ? 0 : 1);
      if (override === true) assert.deepEqual(result.errors, []);
    }
  } finally { fs.readFileSync = read; }
});
test('R4: 上書きで承認した実際の結果を publish-due が公開する', async () => {
  const h = setup(); await h.run(consent);
  let raw = h.state.puts[0][1];
  const dir = path.resolve(__dirname, '../../../content/posts'), file = path.join(dir, filename);
  const saved = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
  const output = process.env.GITHUB_OUTPUT; delete process.env.GITHUB_OUTPUT;
  fs.readdirSync = function (p, ...args) { return p === dir ? [filename] : saved.readdirSync.call(this, p, ...args); };
  fs.readFileSync = function (p, ...args) { return p === file ? raw : saved.readFileSync.call(this, p, ...args); };
  fs.writeFileSync = (p, value) => { assert.equal(p, file); raw = value; };
  try { publish.main(); assert.equal(matter(raw).data.review_status, 'published'); assert.equal(matter(raw).data.fact_check_status, 'revise'); }
  finally { Object.assign(fs, saved); if (output !== undefined) process.env.GITHUB_OUTPUT = output; }
});
async function withMergeFetch(statuses, run) {
  const savedFetch = global.fetch;
  const keys = ['GH_APP_ID', 'GH_APP_PRIVATE_KEY', 'GH_APP_INSTALLATION_ID', 'GITHUB_TOKEN'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests = [];
  let attempt = 0;
  for (const key of keys) delete process.env[key];
  process.env.GITHUB_TOKEN = 'merge-head-sha-test-token';
  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    assert.ok(url.endsWith(method === 'PUT' ? '/pulls/744/merge' : '/pulls/744'));
    assert.ok(['PUT', 'GET'].includes(method));
    requests.push({ method, body: options.body ? JSON.parse(options.body) : null });
    const status = method === 'PUT' ? statuses[attempt++] : 200;
    assert.ok(status, '指定していない通信を行わない');
    return { ok: status >= 200 && status < 300, status,
      json: async () => method === 'PUT' ? { merged: true } : { mergeable: true },
      text: async () => 'fake head changed' };
  };
  try { await run(requests); }
  finally {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
for (const expectedHeadSha of [undefined, 'abc']) test(`R10/試験1: マージ本文の先頭指定 (${expectedHeadSha})`, async () => {
  await withMergeFetch([200], async requests => {
    assert.deepEqual(await api.mergePR(744, 'publish: test', { expectedHeadSha }), { merged: true });
    assert.deepEqual(requests, [{ method: 'PUT', body: { commit_title: 'publish: test', merge_method: 'squash',
      ...(expectedHeadSha ? { sha: expectedHeadSha } : {}) } }]);
  });
});
test('R10/試験2: 先頭指定のある409は1回で失敗し、状態を再取得しない', async () => {
  await withMergeFetch([409], async requests => {
    await assert.rejects(api.mergePR(744, '', { expectedHeadSha: 'abc', maxAttempts: 4, intervalMs: 0 }), /枝の先頭が承認の版と違う/);
    assert.equal(requests.length, 1); assert.equal(requests[0].body.sha, 'abc');
  });
});
test('R10/試験2: 先頭指定のない409は従来どおり再取得して再試行', async () => {
  await withMergeFetch([409, 200], async requests => {
    assert.deepEqual(await api.mergePR(744, '', { maxAttempts: 2, intervalMs: 0 }), { merged: true });
    assert.deepEqual(requests.map(r => r.method), ['PUT', 'GET', 'PUT']);
    assert.deepEqual(requests[0].body, { commit_title: 'merge: PR #744', merge_method: 'squash' });
    assert.deepEqual(requests[2].body, requests[0].body);
  });
});
for (const status of [405, 502, 503]) test(`R10: ${status}の再試行でも承認のSHAを保つ`, async () => {
  await withMergeFetch([status, 200], async requests => {
    await api.mergePR(744, '', { expectedHeadSha: 'abc', maxAttempts: 2, intervalMs: 0 });
    assert.deepEqual(requests.map(r => r.method), ['PUT', 'GET', 'PUT']);
    assert.equal(requests[2].body.sha, 'abc');
  });
});
test('R10: 再試行しないエラーは先頭指定があってもそのまま失敗', async () => {
  await withMergeFetch([400], async requests => {
    await assert.rejects(api.mergePR(744, '', { expectedHeadSha: 'abc', intervalMs: 0 }), /GitHub merge 400/);
    assert.equal(requests.length, 1);
  });
});
test('R10: 先頭指定のない409の再試行上限を保つ', async () => {
  await withMergeFetch([409, 409], async requests => {
    await assert.rejects(api.mergePR(744, '', { maxAttempts: 2, intervalMs: 0 }), /GitHub merge 409/);
    assert.deepEqual(requests.map(r => r.method), ['PUT', 'GET', 'PUT']);
  });
});
const unblocked = { recommendation: 'publish', fact_check_status: 'ok', fact_check_blocking: false };
for (const override of [false, true]) test(`R11/試験3: PUTのコミットSHAでマージする (${override})`, async () => {
  const h = setup(override ? {} : unblocked, { putResult: { commit: { sha: 'abc' } } });
  const response = await h.run(override ? consent : {});
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).merged, true);
  assert.deepEqual(h.state.merges, [[744, `publish: ${base.title}`, { expectedHeadSha: 'abc' }]]);
});
for (const putResult of [{}, { commit: {} }, null]) test(`S2/R11/試験4: 上書きでコミットSHAが無ければマージしない (${JSON.stringify(putResult)})`, async () => {
  const h = setup({}, { putResult });
  const response = await h.run(consent);
  assert.equal(JSON.parse(response.body).merged, false);
  assert.equal(h.state.puts.length, 1); assert.equal(h.state.merges.length, 0); assert.equal(h.state.waits, 0);
  assert.deepEqual(h.state.notifications.map(n => n.event), ['merge_failed']);
  assert.equal(h.state.deletes.length, 0);
});
for (const putResult of [{}, null]) test(`R11/試験5: 通常承認はコミットSHA無しでも従来どおりマージ (${JSON.stringify(putResult)})`, async () => {
  const h = setup(unblocked, { putResult });
  const response = await h.run();
  assert.equal(JSON.parse(response.body).merged, true);
  assert.equal(h.state.merges.length, 1); assert.equal(h.state.merges[0][2], undefined);
  assert.deepEqual(h.state.notifications.map(n => n.event), ['approved']);
});
for (const fallbackMainStatus of ['', 'approved']) test(`S2/R11: マージ時の先頭不一致を既存の失敗・処理済み経路へ渡す (${fallbackMainStatus})`, async () => {
  await withMergeFetch([409], async requests => {
    const h = setup({}, { putResult: { commit: { sha: 'abc' } }, fallbackMainStatus,
      mergeImpl: (number, title, options) => api.mergePR(number, title, { ...options, intervalMs: 0 }) });
    const response = await h.run(consent);
    assert.equal(JSON.parse(response.body).merged, false);
    assert.equal(requests.length, 1); assert.equal(requests[0].body.sha, 'abc');
    assert.equal(h.state.deletes.length, 0);
    assert.deepEqual(h.state.notifications.map(n => n.event), fallbackMainStatus ? [] : ['merge_failed']);
  });
});
(async () => {
  let passed = 0;
  for (const { name, run } of cases) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (e) { console.error(`FAIL ${name}: ${e.stack}`); }
  }
  console.log(`${passed}/${cases.length} passed`); if (passed !== cases.length) process.exitCode = 1;
})();
