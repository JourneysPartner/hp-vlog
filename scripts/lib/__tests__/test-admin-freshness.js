'use strict';

const path = require('path');
const api = require('../../../netlify/functions/lib/github-api');
const page = require('../../../netlify/functions/admin-freshness-page');
const action = require('../../../netlify/functions/admin-freshness-action');

const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const candidate = {
  slug: 'refresh-test', file: '2026-01-01-refresh-test.md', title: '更新対象の記事',
  url: 'https://mori-zeirishi.net/blog/refresh-test/', score: 6, impressions28d: 125,
  refreshable: true, reasons: [{ kind: 'fiscal_year', detail: '令和7年分を含む', where: '## 年分' }],
};
const candidatesText = JSON.stringify({ candidates: [candidate] });
const articleText = [
  '---', 'title: "更新対象の記事"', 'slug: "refresh-test"', 'review_status: "published"',
  'updated_at: "2026-01-01T00:00:00+09:00"', 'reviewed_at: "2026-01-01T00:00:00+09:00"',
  'published_at: "2026-01-01T00:00:00+09:00"', 'publish_at: "2026-01-01T00:00:00+09:00"',
  'source_url: "https://www.nta.go.jp/example"',
  '---', '記事本文', '',
].join('\n');
const authEvent = {
  headers: {
    authorization: `Basic ${Buffer.from('admin:password').toString('base64')}`,
    'content-type': 'application/json',
    origin: 'https://mori-zeirishi.net',
  },
};
function event(actionName, slug = candidate.slug, headers = {}) {
  return {
    ...authEvent,
    headers: { ...authEvent.headers, ...headers },
    httpMethod: 'POST',
    body: JSON.stringify({ action: actionName, slug }),
  };
}

function setup(options = {}) {
  const state = { gets: [], puts: [], triggers: [], lists: 0, runCalls: [], article: articleText, busyChecks: 0, refChecks: 0 };
  const deps = {
    getFile: async (file, ref) => {
      state.gets.push({ file, ref });
      if (file === 'data/freshness/candidates.json') return { content: candidatesText, sha: 'candidates-sha' };
      return { content: state.article, sha: `article-sha-${state.gets.filter(item => item.file.startsWith('content/posts')).length}` };
    },
    putFile: async (file, content, sha, message, ref) => {
      state.puts.push({ file, content, sha, message, ref });
      if (options.conflictOnce && state.puts.length === 1) throw new Error('GitHub PUT 409: sha conflict');
      state.article = content;
      return {};
    },
    updateFrontmatter: api.updateFrontmatter,
    getRef: async branch => { state.refChecks++; return options.branchExists ? { ref: `refs/heads/${branch}` } : null; },
    findPR: async branch => {
      state.findPRBranches = (state.findPRBranches || []).concat(branch);
      return options.openPR ? { number: 19, head: { ref: branch } } : null;
    },
    listWorkflowRuns: async (workflow, params) => {
      state.runCalls.push({ workflow, params });
      state.busyChecks++;
      const runs = options.busyAfterConflict && state.busyChecks >= 2
        ? [{ status: 'queued', display_title: `記事の更新案 ${candidate.slug}` }]
        : (options.activeRuns || (options.activeStatus
          ? [{ status: options.activeStatus, display_title: options.displayTitle || `記事の更新案 ${candidate.slug}` }]
          : []));
      return { total_count: runs.length, workflow_runs: runs };
    },
    listOpenPRs: async () => { state.lists++; return options.pullRequests || []; },
    triggerWorkflow: async (...args) => { state.triggers.push(args); return {}; },
    nowJST: () => '2026-10-01T12:00:00+09:00',
  };
  return { state, deps };
}

async function main() {
  const previousUser = process.env.ADMIN_BASIC_USER;
  const previousPass = process.env.ADMIN_BASIC_PASS;
  process.env.ADMIN_BASIC_USER = 'admin';
  process.env.ADMIN_BASIC_PASS = 'password';

  console.log('\n=== 更新候補管理APIの入力検査 ===');
  {
    const noType = setup();
    const noTypeResponse = await action._handler(event('reviewed', candidate.slug, { 'content-type': 'text/plain' }), noType.deps);
    assert(noTypeResponse.statusCode === 415, 'JSON以外のPOSTは415で断る');
    const wrongOrigin = setup();
    const originResponse = await action._handler(event('reviewed', candidate.slug, { origin: 'https://example.invalid' }), wrongOrigin.deps);
    assert(originResponse.statusCode === 403, '異なるOriginは403で断る');
    const absentOrigin = setup();
    const absentResponse = await action._handler(event('reviewed', candidate.slug, { origin: '', 'sec-fetch-site': '' }), absentOrigin.deps);
    assert(absentResponse.statusCode === 403, 'OriginとSec-Fetch-Siteが無いPOSTは403で断る');
    const fallbackOrigin = setup();
    const fallbackResponse = await action._handler(event('reviewed', 'bad.slug', { origin: '', 'sec-fetch-site': 'same-origin' }), fallbackOrigin.deps);
    assert(fallbackResponse.statusCode === 400, 'Originが無い場合はsame-originのSec-Fetch-Siteを使う');
    const invalid = setup();
    const invalidResponse = await action._handler(event('reviewed', '../bad'), invalid.deps);
    assert(invalidResponse.statusCode === 400 && invalid.state.gets.length === 0, '不正slugをGitHub取得前に断る');
    const missing = setup();
    const missingResponse = await action._handler(event('reviewed', 'missing-slug'), missing.deps);
    assert(missingResponse.statusCode === 404, '現在の候補に無いslugを断る');
  }

  console.log('\n=== 更新案の状態確認と操作 ===');
  {
    for (const options of [{ openPR: true }, ...['queued', 'in_progress', 'requested', 'pending', 'waiting'].map(activeStatus => ({ activeStatus }))]) {
      const harness = setup(options);
      const result = await action._handler(event('reviewed'), harness.deps);
      assert(result.statusCode === 409 && JSON.parse(result.body).message === '更新案の作成中、または更新案があります。'
        && harness.state.puts.length === 0, `PR・${options.activeStatus || 'PR状態'}の更新案があれば確認済みを409で断る`);
    }

    const branchOnlyReviewed = setup({ branchExists: true });
    const branchReviewedResponse = await action._handler(event('reviewed'), branchOnlyReviewed.deps);
    assert(branchReviewedResponse.statusCode === 200 && branchOnlyReviewed.state.puts.length === 1
      && branchOnlyReviewed.state.refChecks === 0,
    '枝だけが残っている記事は確認済みにできる');
    const branchOnlyRefresh = setup({ branchExists: true });
    const branchRefreshResponse = await action._handler(event('refresh'), branchOnlyRefresh.deps);
    assert(branchRefreshResponse.statusCode === 202 && branchOnlyRefresh.state.triggers.length === 1,
      '枝だけが残っていても新しい更新案を作れる');

    const otherSlugRun = setup({ activeStatus: 'in_progress', displayTitle: '記事の更新案 別の記事-slug' });
    const otherSlugResponse = await action._handler(event('reviewed'), otherSlugRun.deps);
    assert(otherSlugResponse.statusCode === 200 && otherSlugRun.state.puts.length === 1,
      '別slugの実行中workflowはbusy判定に含めない');
    const suffixSlugRun = setup({ activeStatus: 'in_progress', displayTitle: `記事の更新案 prefix-${candidate.slug}` });
    const suffixSlugResponse = await action._handler(event('reviewed'), suffixSlugRun.deps);
    assert(suffixSlugResponse.statusCode === 200 && suffixSlugRun.state.puts.length === 1,
      '末尾だけが一致する別slugの実行中workflowはbusy判定に含めない');

    const trigger = setup();
    const start = await action._handler(event('refresh'), trigger.deps);
    assert(start.statusCode === 202 && /数分後に Chatwork に届きます/.test(start.body)
      && JSON.stringify(trigger.state.triggers[0]) === JSON.stringify(['refresh-article.yml', 'main', { slug: candidate.slug }]),
    '更新案作成で refresh-article workflow を起動');

    const beforeWithoutReviewed = articleText;
    const confirmed = setup();
    const marked = await action._handler(event('reviewed'), confirmed.deps);
    const saved = confirmed.state.puts[0] && confirmed.state.puts[0].content;
    const withoutReviewed = value => value.replace(/^reviewed_at:.*\r?\n/gm, '');
    assert(marked.statusCode === 200 && confirmed.state.puts.length === 1, '確認済み操作が成功');
    assert(/reviewed_at: "2026-10-01T12:00:00\+09:00"/.test(saved)
      && withoutReviewed(saved) === withoutReviewed(beforeWithoutReviewed),
    '本文・updated_at・公開日・出典を含むほかの行に触れず reviewed_at だけ記録');

    const retried = setup({ conflictOnce: true });
    const retryResponse = await action._handler(event('reviewed'), retried.deps);
    assert(retryResponse.statusCode === 200 && retried.state.puts.length === 2
      && retried.state.gets.filter(item => item.file.startsWith('content/posts')).length === 2,
    'sha競合時に記事を読み直して1回だけ再試行');

    const busyOnRetry = setup({ conflictOnce: true, busyAfterConflict: true });
    const busyResponse = await action._handler(event('reviewed'), busyOnRetry.deps);
    assert(busyResponse.statusCode === 409 && busyOnRetry.state.puts.length === 1,
      'sha競合の再試行前に更新案の状態を再確認');
  }

  console.log('\n=== GitHub APIのref取得とPRページ送り ===');
  {
    const oldToken = process.env.GITHUB_TOKEN;
    const oldFetch = global.fetch;
    process.env.GITHUB_TOKEN = 'fake-token';
    const requests = [];
    global.fetch = async url => {
      requests.push(String(url));
      if (String(url).includes('/git/ref/heads/')) {
        return { status: 404, ok: false, text: async () => 'not found' };
      }
      const pageNumber = Number(new URL(String(url)).searchParams.get('page'));
      const rows = Array.from({ length: pageNumber === 1 ? 100 : 1 }, (_, index) => ({ number: pageNumber * 100 + index }));
      return { status: 200, ok: true, json: async () => rows };
    };
    try {
      const ref = await api.getRef('draft/refresh-refresh-test');
      const prs = await api.listOpenPRs();
      assert(ref === null && requests[0].includes('/git/ref/heads/draft/refresh-refresh-test'), 'getRefは404をnullにする');
      assert(prs.length === 101 && requests.filter(url => url.includes('/pulls?')).length === 2,
        'open PR一覧を100件単位で最後までページ送り');
    } finally {
      global.fetch = oldFetch;
      if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken;
    }
  }

  console.log('\n=== 更新候補管理画面 ===');
  {
    const harness = setup({ pullRequests: [{ html_url: 'https://github.com/example/pull/17', head: { ref: 'draft/refresh-refresh-test' } }] });
    const response = await page._handler({ ...authEvent, httpMethod: 'GET' }, harness.deps);
    assert(response.statusCode === 200 && harness.state.lists === 1, '候補一覧を読み、開いているPR一覧を取得');
    assert(response.body.includes('更新対象の記事') && response.body.includes('スコア 6')
      && response.body.includes('表示回数 125 回') && response.body.includes('令和7年分を含む'), '題名・スコア・表示回数・理由を表示');
    assert(response.body.includes('更新案あり') && response.body.includes('https://github.com/example/pull/17')
      && response.body.includes('https://mori-zeirishi.net/review?file=2026-01-01-refresh-test.md'), '更新PRとレビュー画面リンクを表示');
    assert(response.body.includes('確認済み（変更なし）') && !response.body.includes('data-action="refresh"'), 'PRが開いている記事は確認済み操作だけ表示');
    const noPrPage = setup();
    const noPrResponse = await page._handler({ ...authEvent, httpMethod: 'GET' }, noPrPage.deps);
    assert(noPrResponse.body.includes('data-action="refresh"') && noPrResponse.body.includes('更新案を作る'), 'refreshable候補に更新案作成ボタンを表示');
    const unsupportedSlug = page.renderPage([{ slug: 'Candidate.With.Dot', file: '2026-01-01-candidate-with-dot.md', title: 'slug形式対象外', refreshable: true, reasons: [] }], []);
    assert(unsupportedSlug.includes('slug に英小文字・数字・ハイフン・下線以外の文字があるため、この画面からの操作はできません。')
      && !unsupportedSlug.includes('data-action="refresh"') && !unsupportedSlug.includes('data-action="reviewed"'), '指定slug形式外の候補は操作不可');
    const underscoreSlug = page.renderPage([{ slug: 'newseg-content_seller-sample-guide', file: '2026-01-01-newseg-content_seller-sample-guide.md', title: '下線を含むslug', refreshable: true, reasons: [] }], []);
    assert(underscoreSlug.includes('data-action="refresh"') && underscoreSlug.includes('data-action="reviewed"'), '下線を含む実在形式slugは操作可能');
  }

  if (previousUser === undefined) delete process.env.ADMIN_BASIC_USER; else process.env.ADMIN_BASIC_USER = previousUser;
  if (previousPass === undefined) delete process.env.ADMIN_BASIC_PASS; else process.env.ADMIN_BASIC_PASS = previousPass;
  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
