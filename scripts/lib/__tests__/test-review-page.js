'use strict';

/**
 * review-page の GitHub 認証まわりのテスト。
 *   node scripts/lib/__tests__/test-review-page.js
 *
 * 実際の GitHub API は叩かず、以下を検証:
 *   - 認証情報が無いときに無認証 fallback せず明確なエラー（500 + credentials missing）
 *   - rate limit (403) のときに 503 + 分かりやすいメッセージ
 *   - ローカルファイルが存在すれば GitHub を呼ばずに表示できる
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..', '..');
const reviewPagePath = path.join(ROOT, 'netlify/functions/review-page.js');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

function reload(p) { delete require.cache[require.resolve(p)]; return require(p); }

(async () => {
  // ── 1. 認証情報が全く無い + ローカルにファイルが無い → credentials missing ──
  console.log('\n=== Test 1: GH 認証情報なし → credentials missing エラー ===');
  {
    delete process.env.GH_APP_ID;
    delete process.env.GH_APP_PRIVATE_KEY;
    delete process.env.GH_APP_INSTALLATION_ID;
    delete process.env.GITHUB_TOKEN;
    const fn = reload(reviewPagePath);
    const res = await fn.handler({
      httpMethod: 'GET',
      queryStringParameters: { file: '__nonexistent-file__.md' },
    });
    assert(res.statusCode === 500, `status 500（実: ${res.statusCode}）`);
    assert(/GitHub 認証が未設定です|credentials/.test(res.body), '認証未設定メッセージを表示');
    assert(!/PRIVATE_KEY.*-----BEGIN/.test(res.body), '秘密鍵を画面に出していない');
  }

  // ── 2. file パラメータが不正 → 400 ──
  console.log('\n=== Test 2: 不正な file パラメータ → 400 ===');
  {
    const fn = reload(reviewPagePath);
    const res = await fn.handler({
      httpMethod: 'GET',
      queryStringParameters: { file: '../../etc/passwd' },
    });
    assert(res.statusCode === 400, `status 400（実: ${res.statusCode}）`);
  }

  // ── 3. GET 以外 → 405 ──
  console.log('\n=== Test 3: POST → 405 ===');
  {
    const fn = reload(reviewPagePath);
    const res = await fn.handler({ httpMethod: 'POST', queryStringParameters: {} });
    assert(res.statusCode === 405, `status 405（実: ${res.statusCode}）`);
  }

  // ── 4. ローカルファイルがあれば GitHub を呼ばずに 200 ──
  console.log('\n=== Test 4: ローカルファイル優先で 200 表示 ===');
  {
    // content/posts に実在する .md を 1 つ選ぶ
    const postsDir = path.join(ROOT, 'content', 'posts');
    const md = fs.readdirSync(postsDir).find(f => f.endsWith('.md'));
    if (md) {
      // review-page は process.cwd()/content/posts を見るため cwd を ROOT に
      const origCwd = process.cwd();
      process.chdir(ROOT);
      const fn = reload(reviewPagePath);
      const res = await fn.handler({
        httpMethod: 'GET',
        queryStringParameters: { file: md },
      });
      process.chdir(origCwd);
      assert(res.statusCode === 200, `status 200（実: ${res.statusCode}）`);
      assert(/レビュー|このまま公開|差し戻し|見送り/.test(res.body), 'レビューUIが含まれる');
    } else {
      console.log('  （content/posts に .md が無いためスキップ）');
      passed++;
    }
  }

  // ── 5. github-api.getFile が GH_APP_* / GITHUB_TOKEN 無しで getToken エラー ──
  console.log('\n=== Test 5: github-api は無認証で呼ばない（getToken で throw）===');
  {
    delete process.env.GH_APP_ID;
    delete process.env.GH_APP_PRIVATE_KEY;
    delete process.env.GH_APP_INSTALLATION_ID;
    delete process.env.GITHUB_TOKEN;
    const api = reload(path.join(ROOT, 'netlify/functions/lib/github-api.js'));
    let threw = false;
    try {
      await api.getFile('content/posts/__x__.md', 'main');
    } catch (e) {
      threw = /認証情報が未設定|credentials/.test(e.message) || /GH_APP/.test(e.message);
    }
    assert(threw, '認証情報なしでは getFile が認証エラーで throw（無認証 fetch しない）');
  }

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
