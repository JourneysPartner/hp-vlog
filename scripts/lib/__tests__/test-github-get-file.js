'use strict';

/**
 * github-api.getFile() が 1MB を超えるファイルを blob API から読むことの試験。
 *
 *   node scripts/lib/__tests__/test-github-get-file.js
 *
 * ネットワークは使わない。global.fetch を偽物に差し替え、GitHub の答えを
 * その場で組み立てる。トークンは「試験用のトークン」という分かる文字列だけを使う。
 */

const assert = require('assert/strict');
const api = require('../../../netlify/functions/lib/github-api');
const { authenticatedEvent } = require('./review-auth-test-helpers');

const TOKEN = '試験用のトークン';
const REPO = 'example/example';
const API_BASE = 'https://api.github.com';
const CANDIDATES_FILE = 'data/nta-shitsugi-topics-candidate.json';
const SHA_FILE = '0123456789abcdef0123456789abcdef01234567';
const SHA_OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

let passed = 0;
let failed = 0;
const errorMessages = [];

async function test(number, description, run) {
  try {
    await run();
    passed++;
    console.log(`PASS 試験${number}: ${description}`);
  } catch (error) {
    failed++;
    console.error(`FAIL 試験${number}: ${description}\n${error.stack}`);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function contentsUrl(filepath, ref) {
  return `${API_BASE}/repos/${REPO}/contents/${filepath}?ref=${encodeURIComponent(ref)}`;
}

function blobUrl(sha) {
  return `${API_BASE}/repos/${REPO}/git/blobs/${sha}`;
}

// GitHub は blob の base64 を改行で区切ることがある。改行入りでも読めることを確かめる。
function base64WithBreaks(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
}

function largeText() {
  const unit = '日本語を含む 1MB を超える中身です。\n';
  let text = '';
  while (Buffer.byteLength(text) <= 1024 * 1024) text += unit;
  return text;
}

// 候補管理の偽のファイル（1MB 超・日本語を含む・候補 2 件）。
function candidatesFileText() {
  const data = {
    version: 1,
    generated_at: '2026-11-20T00:00:00+09:00',
    stats: { adopted_count: 1, rejected_count: 0 },
    candidates: [
      {
        shitsugi_url: 'https://example.invalid/topic-1',
        shitsugi_title: '試験の候補1',
        tax_category: '所得税',
        adopted: false,
        rejected: false,
        adoption_note: '',
        rejection_note: '',
      },
      {
        shitsugi_url: 'https://example.invalid/topic-2',
        shitsugi_title: '試験の候補2',
        tax_category: '消費税',
        adopted: true,
        rejected: false,
        adoption_note: '',
        rejection_note: '',
      },
    ],
    padding: '',
  };
  const filler = '試験用の詰め物です。';
  let text = JSON.stringify(data);
  while (Buffer.byteLength(text) <= 1024 * 1024) {
    data.padding += filler.repeat(2000);
    text = JSON.stringify(data);
  }
  return text;
}

// contents / blob / PUT を返す偽の GitHub。呼ばれた URL と PUT を記録する。
function installGitHubFake({ contents, blob, blobStatus = 200 } = {}) {
  const calls = [];
  const puts = [];
  global.fetch = async (target, options = {}) => {
    const url = String(target);
    calls.push({ url, options });
    if (options.method === 'PUT') {
      puts.push({ url, options });
      return response(200, { content: { sha: '新しい版' } });
    }
    if (url.includes('/git/blobs/')) {
      if (blobStatus !== 200) return response(blobStatus, `blob の失敗 ${blobStatus}`);
      return response(200, blob);
    }
    if (url.includes('/contents/')) return response(200, contents);
    throw new Error(`想定外の取得: ${url}`);
  };
  return { calls, puts };
}

async function captureError(run) {
  try {
    await run();
  } catch (error) {
    errorMessages.push(error.message);
    return error;
  }
  throw new Error('例外になりませんでした');
}

function blobCallCount(calls) {
  return calls.filter(call => call.url.includes('/git/blobs/')).length;
}

(async () => {
  const saved = {
    fetch: global.fetch,
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH,
    appId: process.env.GH_APP_ID,
    appKey: process.env.GH_APP_PRIVATE_KEY,
    appInstallation: process.env.GH_APP_INSTALLATION_ID,
  };
  delete process.env.GH_APP_ID;
  delete process.env.GH_APP_PRIVATE_KEY;
  delete process.env.GH_APP_INSTALLATION_ID;
  process.env.GITHUB_TOKEN = TOKEN;
  process.env.GITHUB_REPO = REPO;
  process.env.GITHUB_BRANCH = 'main';

  try {
    await test(1, '1MB 以下（base64）は取得 1 回・今と同じ URL・正しい中身と sha', async () => {
      const text = '{"message":"日本語の中身"}';
      const contents = {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(text, 'utf8').toString('base64'),
        sha: SHA_FILE,
        size: Buffer.byteLength(text),
      };
      const fake = installGitHubFake({ contents });
      const file = await api.getFile('data/example.json', 'edit/a b');

      assert.equal(fake.calls.length, 1, '取得は 1 回だけ');
      assert.equal(fake.calls[0].url, contentsUrl('data/example.json', 'edit/a b'));
      assert.ok(fake.calls[0].url.endsWith('ref=edit%2Fa%20b'), 'ref を符号化する');
      assert.equal(fake.calls[0].options.headers.Accept, 'application/vnd.github.v3+json');
      assert.equal(fake.calls[0].options.headers.Authorization, `token ${TOKEN}`);
      assert.equal(file.content, text);
      assert.equal(file.sha, SHA_FILE);
    });

    await test(2, '1MB 超（encoding none・content 空）は blob から読み、sha は contents のもの', async () => {
      const text = largeText();
      assert.ok(Buffer.byteLength(text) > 1024 * 1024, '中身は 1MB 超');
      const contents = {
        type: 'file',
        encoding: 'none',
        content: '',
        sha: SHA_FILE,
        size: Buffer.byteLength(text),
      };
      const blob = { sha: SHA_FILE, encoding: 'base64', content: base64WithBreaks(text) };
      const fake = installGitHubFake({ contents, blob });
      const file = await api.getFile('data/large.json');

      assert.equal(fake.calls.length, 2, 'contents と blob で 2 回');
      assert.equal(fake.calls[0].url, contentsUrl('data/large.json', 'main'));
      assert.equal(fake.calls[1].url, blobUrl(SHA_FILE));
      assert.equal(fake.calls[1].options.headers.Accept, 'application/vnd.github.v3+json');
      assert.equal(file.content, text);
      assert.equal(file.sha, SHA_FILE);
    });

    await test(3, 'blob の sha が contents と違えば例外・中身を返さない', async () => {
      const text = largeText();
      const contents = {
        type: 'file',
        encoding: 'none',
        content: '',
        sha: SHA_FILE,
        size: Buffer.byteLength(text),
      };
      const blob = { sha: SHA_OTHER, encoding: 'base64', content: base64WithBreaks(text) };
      const fake = installGitHubFake({ contents, blob });
      const error = await captureError(() => api.getFile('data/large.json', 'main'));

      assert.match(error.message, /sha/);
      assert.equal(fake.calls.length, 2);
    });

    await test(4, '読んだバイト数が size と違えば例外（base64 の道と blob の道の両方）', async () => {
      const shortText = '短い中身';
      const base64Contents = {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(shortText, 'utf8').toString('base64'),
        sha: SHA_FILE,
        size: Buffer.byteLength(shortText) + 1,
      };
      const base64Fake = installGitHubFake({ contents: base64Contents });
      const base64Error = await captureError(() => api.getFile('data/short.json', 'main'));

      assert.match(base64Error.message, /大きさ/);
      assert.equal(base64Fake.calls.length, 1);

      const text = largeText();
      const blobContents = {
        type: 'file',
        encoding: 'none',
        content: '',
        sha: SHA_FILE,
        size: Buffer.byteLength(text) + 1,
      };
      const blob = { sha: SHA_FILE, encoding: 'base64', content: base64WithBreaks(text) };
      const blobFake = installGitHubFake({ contents: blobContents, blob });
      const blobError = await captureError(() => api.getFile('data/large.json', 'main'));

      assert.match(blobError.message, /大きさ/);
      assert.equal(blobFake.calls.length, 2);
    });

    await test(5, 'blob の取得が 404・403 なら状態の数字を含む例外', async () => {
      const text = largeText();
      for (const status of [404, 403]) {
        const contents = {
          type: 'file',
          encoding: 'none',
          content: '',
          sha: SHA_FILE,
          size: Buffer.byteLength(text),
        };
        const fake = installGitHubFake({ contents, blobStatus: status });
        const error = await captureError(() => api.getFile('data/large.json', 'main'));

        assert.match(error.message, new RegExp(String(status)), `${status} を文に含む`);
        assert.equal(fake.calls.length, 2);
      }
    });

    await test(6, 'encoding の欠落・未対応、type が dir、sha の形が不正は例外', async () => {
      const base64Text = Buffer.from('中身', 'utf8').toString('base64');

      for (const [label, contents] of [
        ['encoding が無い', { type: 'file', content: base64Text, sha: SHA_FILE, size: Buffer.byteLength('中身') }],
        ['encoding が utf-8', { type: 'file', encoding: 'utf-8', content: '中身', sha: SHA_FILE, size: Buffer.byteLength('中身') }],
      ]) {
        const fake = installGitHubFake({ contents });
        const error = await captureError(() => api.getFile('data/example.json', 'main'));
        assert.match(error.message, /encoding/, label);
        assert.equal(fake.calls.length, 1, `${label}: 取得は contents だけ`);
      }

      const dirFake = installGitHubFake({
        contents: { type: 'dir', encoding: 'base64', content: base64Text, sha: SHA_FILE },
      });
      const dirError = await captureError(() => api.getFile('data', 'main'));
      assert.match(dirError.message, /ファイルではありません/);
      assert.equal(dirFake.calls.length, 1);

      for (const badSha of ['abc', SHA_FILE.toUpperCase()]) {
        const contents = { type: 'file', encoding: 'none', content: '', sha: badSha, size: 1 };
        const fake = installGitHubFake({ contents, blob: { sha: badSha, encoding: 'base64', content: '' } });
        const error = await captureError(() => api.getFile('data/large.json', 'main'));
        assert.match(error.message, /sha/, badSha);
        assert.equal(blobCallCount(fake.calls), 0, `${badSha}: blob を取りに行かない`);
      }
    });

    await test(7, '例外の文に試験用のトークンを含めない（3〜6 のすべて）', async () => {
      assert.ok(errorMessages.length >= 7, '3〜6 の例外を集めている');
      for (const message of errorMessages) {
        assert.ok(!message.includes(TOKEN), `トークンを含む: ${message}`);
        assert.ok(!/authorization/i.test(message), `Authorization を含む: ${message}`);
        assert.ok(!/bearer/i.test(message), `Bearer を含む: ${message}`);
      }
    });

    await test(8, '本物の一覧 API は 1MB 超でも 200 で候補を返し、blob の失敗では 500', async () => {
      const text = candidatesFileText();
      assert.ok(Buffer.byteLength(text) > 1024 * 1024, '偽のファイルは 1MB 超');
      const contents = {
        type: 'file',
        encoding: 'none',
        content: '',
        sha: SHA_FILE,
        size: Buffer.byteLength(text),
      };
      const blob = { sha: SHA_FILE, encoding: 'base64', content: base64WithBreaks(text) };
      const list = require('../../../netlify/functions/admin-list-candidates');

      const ok = installGitHubFake({ contents, blob });
      const listed = await list.handler(authenticatedEvent({ httpMethod: 'GET', headers: {} }));
      assert.equal(listed.statusCode, 200);
      const body = JSON.parse(listed.body);
      assert.equal(body.candidates.length, 2);
      assert.equal(body.sha, SHA_FILE);
      assert.equal(body.candidates[0].shitsugi_title, '試験の候補1');
      assert.equal(ok.calls.length, 2);

      const broken = installGitHubFake({ contents, blobStatus: 500 });
      const failedResponse = await list.handler(authenticatedEvent({ httpMethod: 'GET', headers: {} }));
      assert.equal(failedResponse.statusCode, 500, '空の一覧を 200 で返さない');
      assert.ok(JSON.parse(failedResponse.body).error);
      assert.equal(broken.calls.length, 2);
    });

    await test(9, '本物の保存 API は contents の sha で 1 回 PUT し、食い違いは 409、blob の失敗は 500', async () => {
      const text = candidatesFileText();
      const contents = {
        type: 'file',
        encoding: 'none',
        content: '',
        sha: SHA_FILE,
        size: Buffer.byteLength(text),
      };
      const blob = { sha: SHA_FILE, encoding: 'base64', content: base64WithBreaks(text) };
      const save = require('../../../netlify/functions/admin-save-candidates');
      const updates = {
        'https://example.invalid/topic-1': { adopted: true, adoption_note: '採用します' },
      };

      const saved = installGitHubFake({ contents, blob });
      const savedResponse = await save.handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ sha: SHA_FILE, updates }),
      }));
      assert.equal(savedResponse.statusCode, 200);
      assert.equal(saved.puts.length, 1, 'PUT は 1 回だけ');
      assert.equal(saved.puts[0].url, `${API_BASE}/repos/${REPO}/contents/${CANDIDATES_FILE}`);
      const putBody = JSON.parse(saved.puts[0].options.body);
      assert.equal(putBody.sha, SHA_FILE, 'contents の sha を送る');
      assert.equal(putBody.branch, 'main');
      const written = JSON.parse(Buffer.from(putBody.content, 'base64').toString('utf8'));
      const updated = written.candidates.find(c => c.shitsugi_url === 'https://example.invalid/topic-1');
      assert.equal(updated.adopted, true);
      assert.equal(updated.adoption_note, '採用します');

      const conflict = installGitHubFake({ contents, blob });
      const conflictResponse = await save.handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ sha: SHA_OTHER, updates }),
      }));
      assert.equal(conflictResponse.statusCode, 409);
      assert.equal(conflict.puts.length, 0, 'sha が違えば PUT を送らない');
      assert.equal(conflict.calls.length, 2, '最新の版は読んでから断る');

      const broken = installGitHubFake({ contents, blobStatus: 404 });
      const brokenResponse = await save.handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ sha: SHA_FILE, updates }),
      }));
      assert.equal(brokenResponse.statusCode, 500);
      assert.equal(broken.puts.length, 0, '中身を読めないときは PUT を送らない');
    });
  } finally {
    global.fetch = saved.fetch;
    restoreEnv('GITHUB_TOKEN', saved.token);
    restoreEnv('GITHUB_REPO', saved.repo);
    restoreEnv('GITHUB_BRANCH', saved.branch);
    restoreEnv('GH_APP_ID', saved.appId);
    restoreEnv('GH_APP_PRIVATE_KEY', saved.appKey);
    restoreEnv('GH_APP_INSTALLATION_ID', saved.appInstallation);
  }

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
