'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const { deleteBranch } = require(path.join(ROOT, 'netlify/functions/lib/github-api'));
const { collect } = require(path.join(ROOT, 'scripts/collect-pending-drafts'));
const {
  classifyBranches,
  main: pruneMain,
} = require(path.join(ROOT, 'scripts/prune-draft-branches'));

const results = Object.fromEntries(['R1', 'R2', 'R3', 'R4'].map(key => [key, { passed: 0, failed: 0 }]));

function check(group, condition, label) {
  if (condition) {
    results[group].passed++;
    console.log(`  PASS [${group}] ${label}`);
  } else {
    results[group].failed++;
    console.error(`  FAIL [${group}] ${label}`);
  }
}

function frontmatter(slug, reviewStatus = 'draft') {
  return `---\nslug: "${slug}"\nreview_status: "${reviewStatus}"\ntitle: "${slug}"\n---\n\n本文`;
}

function createCollectRunner({ failGh = false, simple = false } = {}) {
  const calls = [];
  const statuses = simple ? {
    'origin/draft/open': 'draft',
    'origin/draft/no-pr': 'draft',
  } : {
    'origin/draft/merged': 'draft',
    'origin/draft/closed': 'draft',
    'origin/draft/skipped': 'skipped',
    'origin/draft/rejected': 'rejected',
    'origin/draft/fm-merged': 'merged',
    'origin/draft/open': 'draft',
    'origin/draft/no-pr': 'draft',
  };
  const branches = Object.keys(statuses);

  function run(command, args) {
    const display = [command, ...args].join(' ');
    calls.push(display);
    if (command === 'git' && args[0] === 'ls-remote') {
      return branches.map((branch, i) => `${String(i + 1).padStart(40, '0')}\trefs/heads/${branch.replace(/^origin\//, '')}`).join('\n');
    }
    if (command === 'git' && args[0] === 'fetch') return '';
    if (command === 'git' && args[0] === 'ls-tree' && args[3] === 'origin/main') return '';
    if (command === 'gh' && args[0] === 'pr') {
      if (failGh) throw new Error('偽の gh 失敗');
      return JSON.stringify([
        { headRefName: 'draft/merged', state: 'MERGED', closedAt: '2026-09-20T00:00:00Z' },
        { headRefName: 'draft/closed', state: 'CLOSED', closedAt: '2026-09-20T00:00:00Z' },
        { headRefName: 'draft/open', state: 'OPEN', closedAt: null },
      ]);
    }
    if (command === 'git' && args[0] === 'ls-tree') {
      return `content/posts/${args[3].replace(/\//g, '-')}.md\n`;
    }
    if (command === 'git' && args[0] === 'show') {
      const branch = args[1].split(':')[0];
      return frontmatter(branch.replace('origin/draft/', ''), statuses[branch]);
    }
    throw new Error(`未定義の偽コマンド: ${display}`);
  }
  return { run, calls, branches };
}

async function run() {
  console.log('\n=== 06-R1: マージ後の枝削除 ===');
  let apiCalls = 0;
  const logger = { log() {}, error() {} };
  const ignored = await deleteBranch('feature/x', {
    fetchImpl: async () => { apiCalls++; return { ok: true }; },
    headersImpl: async () => ({}),
    logger,
  });
  check('R1', ignored === false && apiCalls === 0, 'draft/* 以外は API を呼ばない');

  let request = null;
  const deleted = await deleteBranch('draft/sample', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
    headersImpl: async () => ({ Authorization: 'token fake' }),
    logger,
  });
  check('R1', deleted === true && request.options.method === 'DELETE', 'draft/* は DELETE API を呼ぶ');
  check('R1', /\/git\/refs\/heads\/draft\/sample$/.test(request.url), 'head ref の API URL を使う');

  const failedDelete = await deleteBranch('draft/failure', {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => '偽の失敗' }),
    headersImpl: async () => ({}),
    logger,
  });
  check('R1', failedDelete === false, 'API 失敗は例外を投げず false を返す');
  const approveSource = fs.readFileSync(path.join(ROOT, 'netlify/functions/review-approve-background.js'), 'utf8');
  check('R1', /mergeResult = await mergePR[\s\S]*await deleteBranch\(headBranch\)/.test(approveSource),
    '承認フローはマージ成功後に head 枝を削除する');

  console.log('\n=== 06-R2: 終了済み下書きの除外 ===');
  const fixture = createCollectRunner();
  const warnings = [];
  const logs = [];
  const posts = collect({
    run: fixture.run,
    env: { GH_TOKEN: 'fake' },
    warn: message => warnings.push(message),
    log: message => logs.push(message),
  });
  check('R2', posts.map(post => post.slug).join(',') === 'open,no-pr',
    'MERGED・CLOSED・見送り状態を除外し、OPEN と PR なしを残す');
  check('R2', fixture.calls.filter(command => command.startsWith('gh pr list ')).length === 1,
    'PR 一覧は 1 回だけ取得する');
  const fetchCall = fixture.calls.find(command => command.startsWith('git fetch ')) || '';
  check('R2', fetchCall.includes('draft/open') && fetchCall.includes('draft/no-pr')
    && !fetchCall.includes('draft/merged') && !fetchCall.includes('draft/closed'),
  'OPEN と PR なしの枝だけを fetch する');
  check('R2', logs.includes('[pending-drafts] 除外: merged 1 / closed 1 / skipped 3'),
    '理由別の除外数をログに出す');
  check('R2', warnings.length === 0, 'PR 一覧取得成功時は警告を出さない');
  check('R2', posts.every(post => post._pending === true && Object.hasOwn(post, 'review_status')),
    '.pending-drafts.json と同じ記事形状を維持する');

  const fallbackFixture = createCollectRunner({ failGh: true, simple: true });
  const fallbackWarnings = [];
  const fallbackPosts = collect({
    run: fallbackFixture.run,
    env: { GH_TOKEN: 'fake' },
    warn: message => fallbackWarnings.push(message),
    log() {},
  });
  check('R2', fallbackPosts.map(post => post.slug).join(',') === 'open,no-pr',
    'gh 失敗時は従来どおり全枝を収集する');
  check('R2', fallbackWarnings.length === 1 && !fallbackWarnings[0].includes('fake'),
    'gh 失敗時は秘密や詳細を含めず警告を 1 行出す');

  console.log('\n=== 06-R3: 残存枝の分類と dry-run ===');
  const now = new Date('2026-09-27T12:00:00Z');
  const branches = [
    'draft/merged', 'draft/closed-old', 'draft/closed-new',
    'draft/open', 'draft/no-pr', 'feature/x',
  ];
  const prs = [
    { number: 1, headRefName: 'draft/merged', state: 'MERGED', closedAt: '2026-09-27T11:00:00Z' },
    { number: 2, headRefName: 'draft/closed-old', state: 'CLOSED', closedAt: '2026-09-24T12:00:00Z' },
    { number: 3, headRefName: 'draft/closed-new', state: 'CLOSED', closedAt: '2026-09-26T12:00:00Z' },
    { number: 4, headRefName: 'draft/open', state: 'OPEN', closedAt: null },
    { number: 5, headRefName: 'feature/x', state: 'MERGED', closedAt: '2026-09-20T00:00:00Z' },
  ];
  const rows = classifyBranches(branches, prs, now);
  const row = name => rows.find(item => item.branch === name);
  check('R3', row('draft/merged').eligible, 'MERGED は削除候補');
  check('R3', row('draft/closed-old').eligible, 'CLOSED から 3 日以上は削除候補');
  check('R3', !row('draft/closed-new').eligible && row('draft/closed-new').decision.startsWith('保留'),
    'CLOSED から 3 日未満は保留');
  check('R3', !row('draft/open').eligible && row('draft/open').decision.includes('OPEN'), 'OPEN は対象外');
  check('R3', !row('draft/no-pr').eligible && row('draft/no-pr').decision.includes('PR なし'), 'PR なしは対象外');
  check('R3', !row('feature/x').eligible && row('feature/x').decision.includes('draft/* 以外'),
    'draft/* 以外は対象外');

  const commandCalls = [];
  const output = [];
  const fakeRun = (command, args) => {
    commandCalls.push([command, ...args]);
    if (command === 'git' && args[0] === 'ls-remote') {
      return branches.map((branch, i) => `${String(i + 1).padStart(40, '0')}\trefs/heads/${branch}`).join('\n');
    }
    if (command === 'gh') return JSON.stringify(prs);
    throw new Error('dry-run で削除コマンドが呼ばれました');
  };
  const dryCode = pruneMain([], {
    run: fakeRun,
    now,
    log: message => output.push(message),
    error: message => output.push(message),
    env: {},
  });
  check('R3', dryCode === 0 && !commandCalls.some(call => call[0] === 'git' && call[1] === 'push'),
    '--apply なしでは git push を呼ばない');
  check('R3', output[0] === '枝名\tPR番号\t状態\t閉じた日\t判定', 'dry-run は指定の見出しで表を出す');

  console.log('\n=== 06-R4: テスト登録 ===');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('R4', packageJson.scripts['masters:test'].includes('test-draft-branch-hygiene.js'),
    'test-draft-branch-hygiene.js を masters:test に登録する');

  const passed = Object.values(results).reduce((sum, value) => sum + value.passed, 0);
  const failed = Object.values(results).reduce((sum, value) => sum + value.failed, 0);
  console.log('\n=== 結果 ===');
  for (const [group, value] of Object.entries(results)) {
    console.log(`${group}: PASS ${value.passed} / FAIL ${value.failed}`);
  }
  console.log(`合計: PASS ${passed} / FAIL ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
