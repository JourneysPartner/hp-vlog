'use strict';
// 照合を実施できなかったときの理由（鍵を伏せた短い診断）の記録を確かめる。
const assert = require('assert');
// 偽の鍵は実行時に組み立てる。鍵の形の文字列をそのまま置くと、公開範囲がリポジトリ全体の
// Netlify の秘密情報の自動検出がビルドを止める（2026-10-15、#672 のプレビュー公開の失敗の疑い）。
const KEY = ['sk', 'ant', 'api03', 'TESTKEY1234567890abcdef'].join('-');
const PROJECT_KEY = ['sk', 'proj', 'abcdefghijk'].join('-');
process.env.ANTHROPIC_API_KEY = KEY;
const contentModel = require('../content-model');
const F = require('../fact-check');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

(async () => {
  await test('Anthropic の 400 は状態番号・種類・説明だけを残す', () => {
    const d = contentModel.safeDiagnostic(new Error('Anthropic API 400: {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 64000 > 32000"}}'));
    assert.strictEqual(d, 'Anthropic HTTP 400 invalid_request_error: max_tokens: 64000 > 32000');
  });
  await test('JSON でない応答は状態番号だけ', () => {
    assert.strictEqual(contentModel.safeDiagnostic(new Error('Anthropic API 502: <html>bad gateway</html>')), 'Anthropic HTTP 502');
  });
  await test('応答の説明に鍵そのもの・sk- の形・x-api-key の値があれば伏せる', () => {
    const detail = `boom ${KEY} ${PROJECT_KEY} x-api-key: secretvalue authorization=Bearer abc`;
    const d = contentModel.safeDiagnostic(new Error(`Anthropic API 401: ${JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: detail } })}`));
    assert.ok(d.startsWith('Anthropic HTTP 401 authentication_error: '), d);
    assert.ok(!d.includes(KEY) && !d.includes(PROJECT_KEY) && !d.includes('secretvalue') && !d.includes('Bearer abc'), d);
    assert.ok(d.includes('[秘匿]'));
  });
  await test('一般の例外は文面を捨てる（鍵を含んでいても残らない）', () => {
    assert.strictEqual(contentModel.safeDiagnostic(new Error(`boom ${KEY}`)), 'Error');
  });
  await test('SDK の例外（status つき）は種類と状態番号', () => {
    const e = new Error('Request failed'); e.name = 'APIError'; e.status = 429; e.code = 'rate_limit_exceeded';
    assert.strictEqual(contentModel.safeDiagnostic(e), 'APIError HTTP 429 rate_limit_exceeded');
  });
  await test('通信の例外は種類と原因のコードだけ（文面は残さない）', () => {
    const e = new TypeError('fetch failed 任意の文面'); e.cause = { code: 'ECONNRESET' };
    assert.strictEqual(contentModel.safeDiagnostic(e), 'TypeError (ECONNRESET)');
  });
  await test('固定文の例外（時間切れ・認証情報なし）は文面を残す', () => {
    assert.strictEqual(contentModel.safeDiagnostic(new Error('照合の時間切れ')), 'Error: 照合の時間切れ');
    assert.strictEqual(contentModel.safeDiagnostic(new Error('モデルの認証情報が未設定です')), 'Error: モデルの認証情報が未設定です');
  });
  await test('応答の JSON が壊れていれば種類（SyntaxError）だけ', () => {
    let e; try { JSON.parse('{x'); } catch (err) { e = err; }
    assert.strictEqual(contentModel.safeDiagnostic(e), 'SyntaxError');
  });
  await test('300 字で切る', () => {
    const long = `Anthropic API 400: {"type":"error","error":{"type":"invalid_request_error","message":"${'x'.repeat(1000)}"}}`;
    assert.ok(contentModel.safeDiagnostic(new Error(long)).length <= 300);
  });

  const body = '## 期限\n\n結婚・子育て資金の一括贈与の非課税は令和9年3月31日までの拠出が対象です。'.repeat(3);
  await test('照合の呼び出しが失敗したら not_run と診断を記録する', async () => {
    const error = new Error('照合モデルの呼び出しに失敗しました');
    error.diagnostic = 'Anthropic HTTP 404 not_found_error: model: claude-x';
    const { record } = await F.checkFacts(body, { callLLM: async () => { throw error; }, enabled: true });
    assert.strictEqual(record.status, 'not_run');
    assert.strictEqual(record.error, 'Anthropic HTTP 404 not_found_error: model: claude-x');
    assert.ok(/照合を実施できませんでした/.test(record.summary));
  });
  await test('診断の無い例外でも鍵は記録に残らない', async () => {
    const { record } = await F.checkFacts(body, { callLLM: async () => { throw new Error(`leak ${KEY}`); }, enabled: true });
    assert.strictEqual(record.status, 'not_run');
    assert.ok(record.error && !record.error.includes(KEY), record.error);
    assert.ok(!JSON.stringify(F.compactRecord(record)).includes(KEY));
  });
  await test('generateContent（fallback なし）は失敗時に診断を付けて投げ、別モデルへ切り替えない', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}' }; };
    try {
      await contentModel.generateContent({ staticSystem: 's', dynamicSystem: '', user: 'u' }, { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false });
      assert.fail('例外になるはず');
    } catch (e) {
      assert.strictEqual(e.message, '照合モデルの呼び出しに失敗しました');
      assert.strictEqual(e.diagnostic, 'Anthropic HTTP 400 invalid_request_error: bad');
      assert.strictEqual(calls, 1);
    } finally { global.fetch = original; }
  });

  await test('照合の呼び出しは空の system ブロックを送らない（API が 400 で断るため）', async () => {
    const original = global.fetch;
    let sent;
    global.fetch = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }], usage: {} }) }; };
    try {
      await contentModel.generateContent({ staticSystem: '照合の指示', dynamicSystem: '', user: 'u' }, { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false });
      assert.ok(sent.system.length >= 1 && sent.system.every(b => b.text && b.text.trim()), JSON.stringify(sent.system));
      assert.strictEqual(sent.system[0].text, '照合の指示');
    } finally { global.fetch = original; }
  });
  await test('記事生成（可変部分あり）は従来どおり 2 ブロック', () => {
    const { toAnthropicRequest } = require('../article-prompt-builder');
    const req = toAnthropicRequest({ staticSystem: 'S', dynamicSystem: 'D', user: 'U' }, { model: 'm', maxTokens: 1, useCache: true });
    assert.strictEqual(req.system.length, 2);
    assert.ok(req.system[0].cache_control && !req.system[1].cache_control);
  });

  console.log(`\n照合の診断: PASS ${passed} / FAIL ${failed}`);
  process.exitCode = failed ? 1 : 0;
})();
