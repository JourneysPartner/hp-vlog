'use strict';

/**
 * 管理画面 5 本の表示のエスケープの総点検（C）。
 *
 *   node scripts/lib/__tests__/test-admin-escape.js
 *
 * GitHub・Blobs・API・URL から来る値を、HTML・属性・script にそのまま出さないこと。
 * ブラウザで動く script は、偽の DOM と偽の fetch で実際に走らせて確かめる。
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const FUNCTIONS = path.join(__dirname, '..', '..', '..', 'netlify', 'functions');
const PAYLOADS = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', 'javascript:alert(1)'];
const TAG = '<img src=x onerror=alert(1)>';
const BREAKOUT = '"><script>alert(1)</script>';
const SCRIPT_URL = 'javascript:alert(1)';

let passed = 0;
let failed = 0;

async function test(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${label}\n${error.stack}`);
  }
}

// そのまま出ていないこと。href/src の javascript: も許さない。
// 画面自身の nonce 付き script は除いて、中身（外から来る値）だけを見る。
function assertSafe(html, label) {
  const outside = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(outside, /<img src=x onerror/i, `${label}: img がそのまま出る`);
  assert.doesNotMatch(outside, /<script/i, `${label}: script がそのまま出る`);
  assert.doesNotMatch(outside, /<\/script/i, `${label}: script の閉じがそのまま出る`);
  assert.doesNotMatch(outside, /\shref="javascript:/i, `${label}: href に javascript: が入る`);
  assert.doesNotMatch(outside, /\ssrc="javascript:/i, `${label}: src に javascript: が入る`);
}

// 偽の DOM。管理画面の script が必要とする要素だけを返す。
function fakeDom() {
  const elements = new Map();
  const appended = [];
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', textContent: '', value: '', className: '', checked: false, hidden: false,
        dataset: {}, style: {}, clientWidth: 800,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, appendChild(child) { appended.push(child.innerHTML); }, add() {},
        remove() {}, focus() {}, querySelectorAll() { return []; }, querySelector() { return null; },
        closest() { return null; }, setAttribute() {},
        getBoundingClientRect() { return { left: 0, width: 800 }; },
      });
    }
    return elements.get(id);
  };
  return {
    elements, appended, element, text: id => element(id).innerHTML || element(id).textContent,
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => ({
        innerHTML: '', className: '', textContent: '', dataset: {},
        querySelectorAll: () => [], addEventListener() {}, remove() {}, appendChild() {},
      }),
    },
  };
}

async function drawScript(body, context) {
  const match = body.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'nonce 付きの script がある');
  vm.runInNewContext(match[1], context);
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

function scriptBody(body) {
  return body.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
}

(async () => {
  await test('記事管理: 一覧の題名・slug・URL をエスケープし、href は # にする', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-articles-page'));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    assert.equal(response.statusCode, 200);
    const dom = fakeDom();
    const items = [{
      idx: 1, filename: `${BREAKOUT}.md`, title: TAG, slug: BREAKOUT, category: TAG,
      review_status: 'published', publicUrl: SCRIPT_URL, reviewUrl: BREAKOUT, githubUrl: SCRIPT_URL,
      article_type: TAG, article_role: 'main', primary_persona: 'ebay_export_seller',
      publish_at: '2026-01-01T00:00:00Z', published_at: null, publish_slot: BREAKOUT,
    }, {
      idx: 2, filename: 'ok.md', title: '正常な記事', slug: 'ok', category: '所得税', review_status: 'draft',
      publicUrl: '', reviewUrl: 'https://mori-zeirishi.net/review?file=ok.md', githubUrl: 'https://github.com/example/ok',
    }];
    await drawScript(response.body, {
      document: dom.document,
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, items, groupedCounts: {} }) }),
      location: { reload() {} }, setTimeout: () => 0, confirm: () => false,
    });
    const html = dom.appended.join('');
    assert.match(html, /正常な記事/);
    assertSafe(html, '記事管理');
    assert.ok(html.includes('href="#"'), 'href は # になる');
    assert.ok(html.includes('href="https://mori-zeirishi.net/review?file=ok.md"'), '正常な https は残る');
    assert.ok(html.includes('href="https://github.com/example/ok"'), '正常な https は残る');
    assert.ok(!html.includes('href="javascript:'), 'javascript: の href を作らない');
    assert.ok(!html.includes(BREAKOUT), 'href に生の "><script> を入れない');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '題名は実体参照にする');
    assert.ok(html.includes(`data-filename="${BREAKOUT.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}.md"`), '属性も実体参照にする');
  });

  await test('記事管理: script の中の値と URL の確かめ', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-articles-page'));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    const script = scriptBody(response.body);
    const escHtml = script.match(/function escHtml\(s\) \{[\s\S]*?\n  \}/)[0];
    const safeHref = script.match(/function safeHref\(s\) \{[\s\S]*?\n  \}/)[0];
    const { escHtml: esc, safeHref: safe } = vm.runInNewContext(`${escHtml}\n${safeHref}\n({ escHtml, safeHref })`);
    for (const payload of PAYLOADS) assert.doesNotMatch(esc(payload), /[<>"']/, `エスケープ: ${payload}`);
    assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
    for (const payload of PAYLOADS) assert.equal(safe(payload), '#', `URL の確かめ: ${payload}`);
    for (const allowed of ['https://example.invalid/a', 'http://example.invalid/a', '/admin/articles']) assert.equal(safe(allowed), allowed);
    for (const rejected of ['//evil.example', 'data:text/html,x', 'mailto:x@example.invalid', '/\\evil.example', ' javascript:alert(1)']) assert.equal(safe(rejected), '#', rejected);
  });

  await test('候補管理: 題名・税目・判定・URL をエスケープし、href は # にする', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-candidates-page'));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    assert.equal(response.statusCode, 200);
    const dom = fakeDom();
    const candidates = [
      {
        idx: 1, shitsugi_url: SCRIPT_URL, shitsugi_title: TAG, tax_category: BREAKOUT,
        proposed_persona: BREAKOUT, auto_decision: BREAKOUT, auto_score: 1,
        target_segments: [TAG], auto_reasons: [TAG, BREAKOUT], article_potential: 'low',
        adopted: false, rejected: false,
      },
      {
        idx: 2, shitsugi_url: 'https://example.invalid/topic', shitsugi_title: '正常な候補', tax_category: '所得税',
        auto_decision: 'recommend', auto_score: 80, target_segments: [], auto_reasons: [],
        article_potential: 'high', adopted: true, rejected: false,
      },
    ];
    await drawScript(response.body, {
      document: dom.document,
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ candidates, summary: {}, sha: '版' }) }),
      location: { reload() {} }, setTimeout: () => 0, confirm: () => false, alert: () => {},
      Option: function Option(text, value) { this.text = text; this.value = value; },
    });
    const html = dom.element('tbody').innerHTML;
    assert.match(html, /正常な候補/);
    assertSafe(html, '候補管理');
    assert.ok(html.includes('href="#" target="_blank" rel="noopener noreferrer">原文</a>'), 'href は # になる');
    assert.ok(html.includes('href="https://example.invalid/topic"'), '正常な https は残る');
    assert.ok(html.includes('data-url="javascript:alert(1)"'), 'data-url は識別子として元の値を持つ');
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), '属性は実体参照にする');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '題名は実体参照にする');
  });

  await test('候補管理: script の中のエスケープと URL の確かめ', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-candidates-page'));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    const script = scriptBody(response.body);
    const escapeHtml = script.match(/function escapeHtml\(s\) \{[\s\S]*?\n  \}/)[0];
    const safeHref = script.match(/function safeHref\(s\) \{[\s\S]*?\n  \}/)[0];
    const { escapeHtml: esc, safeHref: safe } = vm.runInNewContext(`${escapeHtml}\n${safeHref}\n({ escapeHtml, safeHref })`);
    for (const payload of PAYLOADS) assert.doesNotMatch(esc(payload), /[<>"']/);
    assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
    for (const payload of PAYLOADS) assert.equal(safe(payload), '#');
    assert.equal(safe('https://example.invalid/topic'), 'https://example.invalid/topic');
    assert.equal(safe('/admin/articles'), '/admin/articles');
    assert.equal(safe('//evil.example'), '#');
  });

  await test('更新候補: 記事と PR の URL を確かめ、理由と題名をエスケープする', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-freshness-page'));
    const html = page.renderPage([
      {
        slug: 'shiken', file: 'shiken.md', title: TAG, url: SCRIPT_URL, score: 1, impressions28d: 2, refreshable: true,
        reasons: [{ kind: 'source_updated', detail: BREAKOUT, where: TAG }],
      },
      { slug: 'ok', file: 'ok.md', title: '正常な記事', url: 'https://mori-zeirishi.net/blog/ok/', refreshable: false, reasons: [] },
    ], [{ html_url: SCRIPT_URL, head: { ref: 'draft/refresh-shiken' } }], { nonce: '試験用のnonce', csrfToken: '試験用の合言葉' });
    assert.match(html, /正常な記事/);
    assertSafe(html, '更新候補');
    assert.ok(html.includes('href="#"'), 'href は # になる');
    assert.ok(html.includes('href="https://mori-zeirishi.net/blog/ok/"'), '正常な https は残る');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '題名は実体参照にする');
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), '理由は実体参照にする');
    assert.ok(html.includes('data-slug="shiken"'), '操作の対象は slug だけ');
    assert.ok(html.includes('const REVIEW_TOKEN = "試験用の合言葉";'), 'script の値は JSON にする');
    const script = scriptBody(html);
    new vm.Script(script);
    assert.ok(!script.includes('</script'), 'script の中に閉じタグを入れない');
  });

  await test('更新候補: 操作の合言葉を < で script から抜けられない形にする', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-freshness-page'));
    const token = '"><script>alert(1)</script>';
    const html = page.renderPage([], [], { nonce: 'n', csrfToken: token });
    const expected = JSON.stringify(token).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    assert.ok(!expected.includes('<') && !expected.includes('>'), 'script に < > を残さない');
    assert.ok(html.includes(`const REVIEW_TOKEN = ${expected};`), 'script の中の < > は \\u003c \\u003e にする');
    const script = scriptBody(html);
    assert.ok(!script.includes('<script'), '閉じタグを作らない');
    new vm.Script(script);
  });

  await test('アクセス解析: サーチコンソールの本文をエスケープする', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-analytics-page'));
    const original = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => String(file).includes('search-console')
      ? `${TAG}\n${BREAKOUT}\n${SCRIPT_URL}`
      : original(file, ...rest);
    let section;
    try { section = page.renderSearchConsoleSection(); } finally { fs.readFileSync = original; }
    assertSafe(section, 'サーチコンソール');
    assert.ok(section.includes('&lt;img src=x onerror=alert(1)&gt;'), '本文は実体参照にする');
    assert.ok(section.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  await test('アクセス解析: 画面の script が、API とページ名の地図の値をそのまま出さない', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-analytics-page'));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    assert.equal(response.statusCode, 200);
    const dom = fakeDom();
    const daily = [
      {
        date: '2026-01-01', pageviews: 3, visitors: 2, byPath: { [TAG]: 2, [SCRIPT_URL]: 1 },
        contactFrom: {}, submittedFrom: {}, lineFrom: {},
        sources: { visits: {}, engaged: {}, details: {} },
      },
      {
        date: '2026-01-02', pageviews: 1, visitors: 1, byPath: {},
        contactFrom: { [BREAKOUT]: 1 }, submittedFrom: { [TAG]: 1 }, lineFrom: { [SCRIPT_URL]: 1 },
        sources: { visits: { other: { pc: 1 } }, engaged: {}, details: { [`other|${BREAKOUT}`]: 1 } },
      },
    ];
    const summaries = {
      today: { pageviews: 1, visitors: 1 }, yesterday: { pageviews: 0, visitors: 0 },
      sevenDays: { pageviews: 4, visitors: 3 }, thirtyDays: { pageviews: 9, visitors: 7 },
    };
    await drawScript(response.body, {
      document: dom.document,
      fetch: async url => url.includes('/admin/api/')
        ? { status: 200, ok: true, json: async () => ({ ok: true, today: '2026-01-02', daily, summaries, byPath: {}, contactFrom: {}, submittedFrom: {}, lineFrom: {}, sourcesSince: '2026-01-01' }) }
        : { status: 200, ok: true, json: async () => ({ [TAG]: BREAKOUT, [SCRIPT_URL]: TAG }) },
      location: { reload() {} }, setTimeout: () => 0,
    });
    const rendered = ['cards', 'top', 'contact-from', 'submitted-from', 'line-from', 'source-details', 'chart-table', 'chart', 'sources-since', 'line-total']
      .map(id => dom.element(id).innerHTML || dom.element(id).textContent).join('\n');
    assertSafe(rendered, 'アクセス解析');
    assert.ok(rendered.includes('&lt;img src=x onerror=alert(1)&gt;'), 'ページ名は実体参照にする');
    assert.ok(rendered.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), '流入元の内訳は実体参照にする');
    assert.ok(!rendered.includes('href="javascript:'), 'href を作らない');
    assert.ok(dom.element('sources-since').textContent.includes('2026/1/1'), '記録の開始日は文字だけで出す');
  });

  await test('管理トップ: 外から来る値は無く、合言葉は JSON で埋める', async () => {
    const page = require(path.join(FUNCTIONS, 'admin-home'));
    const response = await page.handler(authenticatedEvent({ httpMethod: 'GET' }));
    assert.equal(response.statusCode, 200);
    assertSafe(response.body, '管理トップ');
    const scripts = [...response.body.matchAll(/<script\b[^>]*>/g)];
    assert.equal(scripts.length, 1, 'script は 1 つ');
    assert.match(scripts[0][0], /^<script nonce="[^"]+">$/, 'nonce を付ける');
    assert.match(response.body, /const REVIEW_TOKEN = "[A-Za-z0-9_-]+";/, '合言葉は JSON で埋める');
    const script = scriptBody(response.body);
    new vm.Script(script);
    assert.ok(!script.includes('<'), 'script の中に < を入れない');
  });
})().catch(error => {
  console.error(error);
  process.exit(1);
}).finally(() => {
  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  if (failed) process.exitCode = 1;
});
