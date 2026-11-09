'use strict';

/**
 * 公開中の記事の手直し PR（枝 edit/<slug>）の試験。
 *   node scripts/lib/__tests__/test-manual-edit-review.js
 *
 * 認証は本物（authenticatedEvent）を通し、GitHub の部品だけを偽物にする。
 * R1〜R9 の受け入れ項目（判定・画面・承認・差し戻し・見送り・通知・ワークフロー）を確かめる。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { authenticatedEvent } = require('./review-auth-test-helpers');
const api = require('../../../netlify/functions/lib/github-api');
const manualEdit = require('../../../netlify/functions/lib/manual-edit');
const approval = require('../../../netlify/functions/review-approve-background');
const revise = require('../../../netlify/functions/review-revise');
const skip = require('../../../netlify/functions/review-skip');
const page = require('../../../netlify/functions/review-page');
const { buildMessage } = require('../../../netlify/functions/lib/notify/message');

const ROOT = path.join(__dirname, '..', '..', '..');
const FILENAME = '2026-01-01-edit-check.md';
const ARTICLE_PATH = `content/posts/${FILENAME}`;
const REF = 'edit/edit-check';
const PR_URL = 'https://github.com/example/hp-vlog/pull/901';

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
async function group(name, run) {
  console.log(`\n=== ${name} ===`);
  try { await run(); }
  catch (error) { failed++; console.error(`  ✗ 例外: ${error && error.stack ? error.stack : error}`); }
}

function article({
  status = 'published', title = '記事の題名', summary = '説明文', slug = 'edit-check',
  body = '本文です。', overrides = {},
} = {}) {
  const fields = {
    title,
    slug,
    summary,
    category: '消費税',
    created_at: '2024-01-01T00:00:00+09:00',
    updated_at: '2025-01-01T00:00:00+09:00',
    reviewed_at: '2025-01-02T00:00:00+09:00',
    publish_at: '2024-02-01T17:15:00+09:00',
    published_at: '2024-02-01T17:15:00+09:00',
    publish_slot: 'evening',
    approved_at: '2024-01-31T11:00:00+09:00',
    review_status: status,
    source_url: 'https://www.nta.go.jp/example',
    source_title: '出典',
    source_guard_version: 1,
    source_provenance: 'curated',
    tax_domain: 'consumption_tax',
    customer_fit_score: 5,
    search_intent_score: 5,
    source_alignment_score: 5,
    ...overrides,
  };
  const lines = Object.entries(fields).map(([key, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
    return `${key}: ${JSON.stringify(String(value))}`;
  });
  return ['---', ...lines, '---', body, ''].join('\n');
}

function prFile(filename, status = 'modified', extra = {}) {
  return { filename, status, additions: 3, deletions: 1, ...extra };
}

const DEFAULT_FILES = [
  prFile(ARTICLE_PATH),
  prFile('data/internal-link-placements.json'),
];

function defaultPR(overrides = {}) {
  return {
    number: 901,
    html_url: PR_URL,
    head: { ref: REF, sha: 'head-sha' },
    base: { ref: 'main' },
    ...overrides,
  };
}

// ── checkManualEditPR 用の偽の部品 ───────────────────────────────────
function checkContext({
  ref = REF, pr = defaultPR(), files = DEFAULT_FILES,
  main = article({ title: '公開中の題名', summary: '公開中の説明文', body: '公開中の本文です。' }),
  branch = article({ title: '手直し後の題名', summary: '手直し後の説明文', body: '手直し後の本文です。' }),
  baseSha = 'base-sha', baseFileSha = 'main-sha', baseFile = main,
  compareCommits = null,
} = {}) {
  return manualEdit.checkManualEditPR({
    filename: FILENAME,
    ref,
    findPR: async () => pr,
    listPRFiles: async () => files,
    compareCommits: compareCommits || (async () => ({ merge_base_commit: { sha: baseSha } })),
    getFile: async (file, fileRef) => {
      if (file !== ARTICLE_PATH) throw new Error('GitHub GET 404: not found');
      if (fileRef === 'main') return { content: main, sha: 'main-sha' };
      if (fileRef === baseSha) return { content: baseFile, sha: baseFileSha };
      return { content: branch, sha: 'branch-sha' };
    },
  });
}

// ── 承認の偽の部品 ──────────────────────────────────────────────────
function editSetup({
  ref = REF,
  branch = article({ title: '手直し後の題名', summary: '手直し後の説明文', body: '手直し後の本文です。' }),
  main = article({ title: '公開中の題名', summary: '公開中の説明文', body: '公開中の本文です。' }),
  files = DEFAULT_FILES,
  pr = defaultPR(),
  branchSha = 'branch-sha',
  mainSha = 'main-sha',
  baseSha = 'base-sha',
  baseFileSha = 'main-sha',
  putResult = { commit: { sha: 'override-commit', parents: [{ sha: 'head-sha' }] } },
  waitResult = { mergeable: true, mergeable_state: 'clean', head: { sha: 'head-sha' } },
  waitError = null,
  mergeError = null,
  afterMerge = { merged: true, head: { sha: 'head-sha' } },
  getPR: getPROverride = null,
  getCombinedStatus = null,
  listCheckRuns = null,
  editCheckWait = null,
  sleep = async () => {},
} = {}) {
  const state = {
    puts: [], notifications: [], merges: [], waits: [], closes: [], deletes: [],
    comments: [], gets: [], prReads: 0,
  };
  const waitResults = Array.isArray(waitResult) ? waitResult : null;
  const deps = {
    getFile: async (file, fileRef) => {
      state.gets.push({ file, ref: fileRef });
      if (file !== ARTICLE_PATH) throw new Error('GitHub GET 404: not found');
      if (fileRef === 'main') return { content: main, sha: mainSha };
      if (fileRef === baseSha) return { content: main, sha: baseFileSha };
      return { content: branch, sha: branchSha };
    },
    putFile: async (...args) => { state.puts.push(args); return putResult; },
    updateFrontmatter: api.updateFrontmatter,
    nowJST: () => '2026-11-09T10:00:00+09:00',
    findPR: async () => pr,
    listPRFiles: async () => files,
    compareCommits: async () => ({ merge_base_commit: { sha: baseSha } }),
    getCombinedStatus: getCombinedStatus || (async () => ({ state: 'success', statuses: [] })),
    listCheckRuns: listCheckRuns || (async () => ({ total_count: 0, check_runs: [] })),
    editCheckWait: editCheckWait || { intervalMs: 1, maxWaitMs: 3 },
    sleep,
    // マージ前の読み直しは「まだマージされていない開いている PR」を返し、
    // マージ後（mergePR を呼んだ後）は afterMerge を返す。
    // pr が null のときは、閉じた PR を確かめる読み直しなので afterMerge を返す。
    getPR: getPROverride || (async () => {
      state.prReads++;
      if (pr === null) return afterMerge;
      if (state.merges.length === 0) {
        return { merged: false, state: 'open', head: { sha: 'head-sha' } };
      }
      return afterMerge;
    }),
    closePR: async number => state.closes.push(number),
    commentOnPR: async (number, body) => state.comments.push([number, body]),
    waitForMergeable: async (number, options) => {
      state.waits.push({ number, options });
      if (waitError) throw new Error(waitError);
      if (waitResults) return waitResults[Math.min(state.waits.length - 1, waitResults.length - 1)];
      return waitResult;
    },
    mergePR: async (...args) => {
      state.merges.push(args);
      if (mergeError) throw new Error(mergeError);
      return { merged: true };
    },
    deleteBranch: async name => state.deletes.push(name),
    findApprovedArticlesForDate: async () => [],
    sendNotification: async (event, data) => state.notifications.push({ event, data }),
  };
  return {
    state,
    run: (extra = {}, options = {}) => approval._handler(authenticatedEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        filename: options.filename || FILENAME,
        ref: options.ref === undefined ? ref : options.ref,
        ...extra,
      }),
    }), deps),
  };
}

function notificationEvents(state) {
  return state.notifications.map(item => item.event);
}

function findNotification(state, event) {
  return state.notifications.find(item => item.event === event);
}

// ── 画面のスクリプトを動かす ─────────────────────────────────────────
function runPageScript(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const script = scripts[scripts.length - 1][1];
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        checked: false, disabled: false, value: '', textContent: '', innerHTML: '', className: '',
        classList: { contains: () => false, toggle() {} },
        addEventListener(type, callback) { this[type] = callback; },
        focus() {},
      });
    }
    return nodes.get(id);
  };
  const requests = [];
  const context = vm.createContext({
    document: {
      getElementById: node,
      querySelectorAll: () => [node('btnApprove'), node('btnRevise'), node('btnSkip'), node('btnSkipForever')],
    },
    fetch: async (url, options) => {
      if (url.endsWith('review-auth-check')) return { status: 204 };
      requests.push({ url, body: JSON.parse(options.body) });
      return { status: 202, ok: true, json: async () => ({}) };
    },
    confirm: () => true,
    location: { search: '', assign() {} },
    setTimeout: callback => callback(),
  });
  vm.runInContext(script, context);
  return { context, node, requests };
}

function editContext({
  ok = true, reasons = [], headSha = 'head-sha',
  main = article({ title: '公開中の題名', summary: '公開中の説明文', body: '公開中の本文です。' }),
  branch = article({ title: '手直し後の題名', summary: '手直し後の説明文', body: '手直し後の本文です。' }),
  files = DEFAULT_FILES,
  pr = defaultPR(),
} = {}) {
  return {
    ok, reasons, headSha, pr, files,
    mainFile: ok ? { content: main, sha: 'main-sha' } : null,
    branchFile: ok ? { content: branch, sha: 'branch-sha' } : null,
  };
}

async function main() {
  console.log('\n=== 1. 手直し PR の判定 ===');
  {
    const okResult = await checkContext();
    check(okResult.ok === true && okResult.reasons.length === 0, '許可リストだけの edit/ の PR は手直しとして扱える');
    check(okResult.headSha === 'head-sha' && okResult.files.length === 2, '先頭のコミットと変更ファイルを返す');

    const otherRef = await checkContext({ ref: 'draft/ordinary' });
    check(otherRef.ok === false && otherRef.reasons.some(reason => reason.includes('edit/')), 'edit/ 以外の枝は手直しとして扱わない');
    check(manualEdit.isManualEditRef('edit/edit-check') && manualEdit.isManualEditRef('edit/a-1_x')
      && !manualEdit.isManualEditRef('edit/') && !manualEdit.isManualEditRef('edit/A')
      && !manualEdit.isManualEditRef('draft/edit-check'), '枝の名前の形を正規表現で確かめる');

    const noPR = await checkContext({ pr: null });
    check(noPR.ok === false && noPR.reasons.some(reason => reason.includes('PR')), '開いている PR が無ければ断る');

    const wrongBase = await checkContext({ pr: defaultPR({ base: { ref: 'develop' } }) });
    check(wrongBase.ok === false && wrongBase.reasons.some(reason => reason.includes('main')), '向き先が main でなければ断る');

    const extraFile = await checkContext({ files: [...DEFAULT_FILES, prFile('scripts/build.js')] });
    check(extraFile.ok === false && extraFile.reasons.some(reason => reason.includes('scripts/build.js')), '許可リストにないファイルがあれば断る');

    const twoPosts = await checkContext({ files: [...DEFAULT_FILES, prFile('content/posts/2026-01-02-another.md')] });
    check(twoPosts.ok === false && twoPosts.reasons.some(reason => reason.includes('1 本')), '記事が 2 本あれば断る');

    const notPublishedMain = await checkContext({ main: article({ status: 'draft' }) });
    check(notPublishedMain.ok === false && notPublishedMain.reasons.some(reason => reason.includes('published')), 'main が published でなければ断る');

    const notPublishedBranch = await checkContext({ branch: article({ status: 'needs_review' }) });
    check(notPublishedBranch.ok === false && notPublishedBranch.reasons.some(reason => reason.includes('published')), '枝が published でなければ断る');

    const differentSlug = await checkContext({ branch: article({ slug: 'another-slug' }) });
    check(differentSlug.ok === false && differentSlug.reasons.some(reason => reason.includes('slug')), 'slug が違えば断る');

    const allowedFactCheck = await checkContext({
      files: [...DEFAULT_FILES, prFile('data/fact-check/edit-check.json'), prFile('scripts/lib/__tests__/test-title-refresh.js')],
    });
    check(allowedFactCheck.ok === true, '照合の記録と test-title-refresh.js は許す');
  }

  console.log('\n── 1b. main と枝で変えてはいけない 6 項目 ──');
  {
    const cases = [
      ['review_status', { status: 'approved' }],
      ['slug', { slug: 'another-slug' }],
      ['publish_at', { overrides: { publish_at: '2024-03-01T11:05:00+09:00' } }],
      ['published_at', { overrides: { published_at: '2024-03-01T11:05:00+09:00' } }],
      ['approved_at', { overrides: { approved_at: '2024-02-20T11:00:00+09:00' } }],
      ['publish_slot', { overrides: { publish_slot: 'morning' } }],
    ];
    for (const [key, options] of cases) {
      const result = await checkContext({ branch: article(options) });
      check(result.ok === false && result.reasons.some(reason => reason.includes(key) && reason.includes('main と違います')),
        `${key} が main と違えば断り、項目名を理由に出す`);
    }
  }

  console.log('\n── 1c. 変更ファイルの状態と名前の変更 ──');
  {
    const renamedArticle = await checkContext({
      files: [prFile('content/posts/2026-01-02-renamed.md', 'renamed', { previous_filename: ARTICLE_PATH })],
    });
    check(renamedArticle.ok === false, '記事の名前の変更は断る');

    const removedArticle = await checkContext({ files: [prFile(ARTICLE_PATH, 'removed')] });
    check(removedArticle.ok === false && removedArticle.reasons.some(reason => reason.includes('「変更」だけ')),
      '記事の削除は断る');

    const addedArticle = await checkContext({ files: [prFile(ARTICLE_PATH, 'added')] });
    check(addedArticle.ok === false && addedArticle.reasons.some(reason => reason.includes('「変更」だけ')),
      '記事の追加は断る');

    const renamedExtra = await checkContext({
      files: [...DEFAULT_FILES, prFile('data/internal-link-placements.json', 'renamed', { previous_filename: 'data/old-placements.json' })],
    });
    check(renamedExtra.ok === false && renamedExtra.reasons.some(reason => reason.includes('状態ではありません')),
      '許可リストのファイルの名前の変更は断る');

    const removedExtra = await checkContext({
      files: [...DEFAULT_FILES, prFile('scripts/lib/__tests__/test-title-refresh.js', 'removed')],
    });
    check(removedExtra.ok === false, '許可リストのファイルの削除は断る');

    const otherFactCheck = await checkContext({
      files: [...DEFAULT_FILES, prFile('data/fact-check/another-slug.json', 'modified')],
    });
    check(otherFactCheck.ok === false && otherFactCheck.reasons.some(reason => reason.includes('another-slug.json')),
      '別の slug の照合の記録は断る');

    const upperPath = await checkContext({ files: [prFile('Content/posts/2026-01-01-edit-check.md'), ...DEFAULT_FILES] });
    check(upperPath.ok === false && upperPath.reasons.some(reason => reason.includes('Content/posts')),
      '大文字のパスは断る');

    const renameOut = await checkContext({
      files: [prFile('scripts/build.js', 'renamed', { previous_filename: 'data/internal-link-placements.json' })],
    });
    check(renameOut.ok === false && renameOut.reasons.some(reason => reason.includes('scripts/build.js')),
      '許可リストの外への名前の変更は、変更後の名前で断る');
  }

  console.log('\n── 1d. main 側の記事が変わっていないか ──');
  {
    const same = await checkContext();
    check(same.ok === true, '共通の親の記事が今の main と同じなら通す');

    const changedMain = await checkContext({ baseFileSha: 'old-main-sha' });
    check(changedMain.ok === false && changedMain.reasons.some(reason => reason.includes('main 側でこの記事が変わりました')),
      '共通の親の記事が今の main と違えば断る');

    const noCompare = await checkContext({ compareCommits: async () => { throw new Error('GitHub compare 404'); } });
    check(noCompare.ok === false && noCompare.reasons.some(reason => reason.includes('共通の親')),
      '共通の親を確認できなければ断る');
  }

  console.log('\n── 1e. 下書きの PR ──');
  {
    const draft = await checkContext({ pr: defaultPR({ draft: true }) });
    check(draft.ok === false && draft.reasons.some(reason => reason.includes('下書きの PR')),
      '下書きの PR は断り、確認できる状態にするよう案内する');
  }

  console.log('\n=== 2. 手直し PR の画面 ===');
  {
    const html = page.renderReviewPage(FILENAME, {
      title: '手直し後の題名', summary: '手直し後の説明文', review_status: 'published', source_guard_version: 1,
    }, '<p>手直し後の本文です。</p>', REF, null, null, { fileSha: 'branch-sha' }, editContext());
    check(html.includes('公開中の記事の手直しです。承認すると、この PR をマージして公開中の記事に反映します（題名・説明文も変わります。公開日は変わりません）'),
      '手直しの案内を出す');
    check(html.includes(`href="${PR_URL}"`), 'PR へのリンクを出す');
    check(html.includes('変わる項目') && html.includes('公開中の題名') && html.includes('手直し後の題名')
      && html.includes('公開中の説明文') && html.includes('手直し後の説明文'), '題名・説明文の前後を出す');
    check(html.includes('本文の変更箇所') && html.includes('変更前') && html.includes('変更後'), '本文の変更箇所を更新案と同じ形で出す');
    check(html.includes('この PR で変わるファイル') && html.includes('data/internal-link-placements.json'), '変わるファイルの一覧を出す');
    check(!html.includes('公開日時（任意）'), '公開日時の入力を隠す');
    check(!html.includes('id="suppressTopic"') && !html.includes('このテーマを<strong>今後生成しない</strong>'), '今後このテーマを生成しないを隠す');
    check(!html.includes('見送り＋今後このテーマを生成しない'), '見送り＋今後生成しないボタンを隠す');
    check(html.includes('id="factCheck"') || html.includes('照合の記録なし'), '照合の表示は今のまま出す');
    check(html.includes('手直しを反映する'), '承認ボタンは手直しの文言にする');

    const blocked = page.renderReviewPage(FILENAME, { title: '手直し後の題名', review_status: 'published' },
      '<p>本文</p>', REF, null, null, {}, editContext({ ok: false, reasons: ['PR の向き先が main ではありません。'] }));
    check(/id="btnApprove"[^>]* disabled/.test(blocked), '手直し PR として扱えないときは承認ボタンを無効にする');
    check(blocked.includes('PR の向き先が main ではありません。'), '扱えない理由を出す');
    check(!/id="btnRevise"[^>]* disabled/.test(blocked) && !/id="btnSkip"[^>]* disabled/.test(blocked),
      '扱えないときでも差し戻し・見送りは押せる');

    const { context, node, requests } = runPageScript(html);
    await vm.runInContext("handleAction('approve')", context);
    node('reviewComment').value = '見出しを直してください';
    await vm.runInContext("handleAction('revise')", context);
    await vm.runInContext("handleAction('skip')", context);
    check(requests.length === 3, '承認・差し戻し・見送りを送る');
    check(requests.every(request => request.body.head_sha === 'head-sha'), '3 つの送信すべてに表示した head_sha を入れる');
    check(requests.every(request => request.body.pr_number === 901), '3 つの送信すべてに表示した PR の番号を入れる');

    const ordinary = page.renderReviewPage(FILENAME, { title: '通常記事', review_status: 'draft' }, '<p>本文</p>', 'draft/ordinary', null, null, { fileSha: 'fs' });
    const ordinaryRun = runPageScript(ordinary);
    await vm.runInContext("handleAction('skip')", ordinaryRun.context);
    check(ordinaryRun.requests.length === 1 && !Object.hasOwn(ordinaryRun.requests[0].body, 'head_sha'),
      '手直し PR 以外では head_sha を送らない');
    check(ordinaryRun.requests.length === 1 && !Object.hasOwn(ordinaryRun.requests[0].body, 'pr_number'),
      '手直し PR 以外では pr_number を送らない');

    // L10: 変更ファイルの状態・追加行数・削除行数
    const withCounts = page.renderReviewPage(FILENAME, { title: '手直し後の題名', review_status: 'published' },
      '<p>本文</p>', REF, null, null, {}, editContext({
        files: [prFile(ARTICLE_PATH, 'modified', { additions: 12, deletions: 4 })],
      }));
    check(withCounts.includes('追加 12 行') && withCounts.includes('削除 4 行'), '変更ファイルに追加・削除の行数を出す');

    // L1: 差し戻しの後の文（手直しは Claude が直す）
    const reviseRun = runPageScript(html);
    reviseRun.node('reviewComment').value = '見出しを直してください';
    await vm.runInContext("handleAction('revise')", reviseRun.context);
    check(reviseRun.node('resultMsg').textContent.includes('差し戻しを伝えました。Claude が直します'),
      '手直しの差し戻し後は Claude が直すことを伝える');
    check(!reviseRun.node('resultMsg').textContent.includes('AIが記事を再生成中です'),
      '手直しの差し戻し後に AI の再生成と書かない');

    // 形が正しくない edit/ の枝も、手直しの画面として理由を出し承認を止める。
    const invalidHtml = page.renderReviewPage(FILENAME, { title: '公開中の題名', review_status: 'published' },
      '<p>本文</p>', 'edit/Foo', null, null, {}, {
        ok: false, reasons: ['手直しの枝の名前の形が正しくありません。'], headSha: '', pr: null, files: [],
        mainFile: null, branchFile: null,
      });
    check(invalidHtml.includes('手直しの枝の名前の形が正しくありません。'), '形が正しくない edit/ の枝は画面に理由を出す');
    check(/id="btnApprove"[^>]* disabled/.test(invalidHtml), '形が正しくない edit/ の枝は承認ボタンを無効にする');
  }

  console.log('\n=== 3. 手直し PR の承認（成功）===');
  {
    const harness = editSetup();
    const response = await harness.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    const body = JSON.parse(response.body);
    check(response.statusCode === 200 && body.merged === true, '200 で merged:true を返す');
    check(harness.state.merges.length === 1 && harness.state.merges[0][0] === 901
      && harness.state.merges[0][2] && harness.state.merges[0][2].expectedHeadSha === 'head-sha',
    '表示した head sha を指定して 1 回だけマージする');
    check(harness.state.puts.length === 0, '上書きが無いときは枝にも main にも書かない');
    check(harness.state.deletes.length === 0, '枝を消さない');
    check(harness.state.prReads === 1, 'マージ後に PR を読み直して merged を確かめる');
    check(JSON.stringify(notificationEvents(harness.state)) === JSON.stringify(['edit_published']),
      'edit_published を 1 回だけ通知する');
    const published = findNotification(harness.state, 'edit_published');
    check(published && published.data.publicUrl === 'https://mori-zeirishi.net/blog/edit-check/'
      && published.data.prUrl === PR_URL && published.data.title === '手直し後の題名',
    '題名・公開中の記事の URL・PR の URL を通知する');
  }

  console.log('\n── 3b. 照合の上書きの書き込みの親 ──');
  {
    const blocking = { fact_check_status: 'revise', fact_check_blocking: true, fact_check_summary: '見出しに食い違い' };
    const staleParent = editSetup({
      branch: article({ overrides: blocking }),
      putResult: { commit: { sha: 'override-commit', parents: [{ sha: 'old-sha' }] } },
    });
    const staleParentResponse = await staleParent.run({ head_sha: 'head-sha', file_sha: 'branch-sha', fact_check_override: true });
    check(staleParentResponse.statusCode === 409 && staleParent.state.merges.length === 0,
      '書き込みの親が見た版と違えばマージしない');
    const staleParentNote = findNotification(staleParent.state, 'edit_approve_failed');
    check(staleParentNote && staleParentNote.data.comment.includes('画面を開いた後に PR が更新されました'),
      '書き込みの親が違えば画面を開き直すよう通知する');

    const noParent = editSetup({
      branch: article({ overrides: blocking }),
      putResult: { commit: { sha: 'override-commit' } },
    });
    const noParentResponse = await noParent.run({ head_sha: 'head-sha', file_sha: 'branch-sha', fact_check_override: true });
    check(noParentResponse.statusCode === 409 && noParent.state.merges.length === 0,
      '書き込みの親が取れなければマージしない');

    // L5: マージに失敗しても、相手が先にマージしていれば処理済みにする。
    const alreadyMerged = editSetup({ mergeError: 'GitHub merge 405', afterMerge: { merged: true, head: { sha: 'head-sha' } } });
    const alreadyMergedResponse = await alreadyMerged.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(alreadyMergedResponse.statusCode === 200 && JSON.parse(alreadyMergedResponse.body).processed === true,
      'マージの失敗後に merged なら処理済みにする');
    check(JSON.stringify(notificationEvents(alreadyMerged.state)) === JSON.stringify(['edit_processed']),
      'マージの失敗後に merged なら edit_processed を通知する');

    // N5: マージの失敗後に merged でも、画面で見た版と違う版なら処理済みにしない。
    const otherVersion = editSetup({
      mergeError: 'GitHub merge 405',
      afterMerge: { merged: true, head: { sha: 'other-sha' } },
    });
    const otherVersionResponse = await otherVersion.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(otherVersionResponse.statusCode === 409
      && JSON.parse(otherVersionResponse.body).processed === undefined,
      'マージの失敗後に merged でも、見た版と違う版なら処理済みにしない');
    const otherVersionNote = findNotification(otherVersion.state, 'edit_approve_failed');
    check(otherVersionNote && otherVersionNote.data.comment.includes('画面で見た版と違う版がマージされています'),
      '見た版と違う版がマージされていたら GitHub で確認するよう通知する');
  }

  console.log('\n── 4. 見た版の head sha ──');
  {
    const missing = editSetup();
    const missingResponse = await missing.run({ file_sha: 'branch-sha' });
    check(missingResponse.statusCode === 409 && missing.state.merges.length === 0, 'head_sha が無ければマージしない');
    const missingNote = findNotification(missing.state, 'edit_approve_failed');
    check(missingNote && /開き直して/.test(missingNote.data.comment), 'head_sha が無ければ edit_approve_failed を通知する');

    const different = editSetup();
    const differentResponse = await different.run({ head_sha: 'old-head', file_sha: 'branch-sha' });
    check(differentResponse.statusCode === 409 && different.state.merges.length === 0, 'head_sha が違えばマージしない');
    const differentNote = findNotification(different.state, 'edit_approve_failed');
    check(differentNote && /開き直して/.test(differentNote.data.comment), 'head_sha が違えば edit_approve_failed を通知する');
  }

  console.log('\n── 5. マージできない状態 ──');
  {
    for (const [state, mergeable] of [['blocked', false], ['dirty', false], ['behind', false]]) {
      const harness = editSetup({
        waitResult: { mergeable, mergeable_state: state, head: { sha: 'head-sha' } },
      });
      const response = await harness.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
      const note = findNotification(harness.state, 'edit_approve_failed');
      check(response.statusCode === 409 && harness.state.merges.length === 0, `${state} ではマージしない`);
      check(Boolean(note) && note.data.comment.includes(state), `${state} を edit_approve_failed の理由に書く`);
    }

    const timeout = editSetup({ waitResult: { mergeable: null, mergeable_state: 'unknown', head: { sha: 'head-sha' } } });
    const timeoutResponse = await timeout.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(timeoutResponse.statusCode === 409 && timeout.state.merges.length === 0, '不明のまま時間切れならマージしない');
    const timeoutNote = findNotification(timeout.state, 'edit_approve_failed');
    check(Boolean(timeoutNote) && timeoutNote.data.comment.includes('不明'), '時間切れを edit_approve_failed の理由に書く');

    const failedWait = editSetup({ waitError: 'GitHub get PR 503' });
    const failedWaitResponse = await failedWait.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(failedWaitResponse.statusCode === 409 && failedWait.state.merges.length === 0
      && Boolean(findNotification(failedWait.state, 'edit_approve_failed')), '状態を確認できなければマージしない');

    // has_hooks は今までどおり通す。
    const hooks = editSetup({ waitResult: { mergeable: true, mergeable_state: 'has_hooks', head: { sha: 'head-sha' } } });
    const hooksResponse = await hooks.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(hooksResponse.statusCode === 200 && hooks.state.merges.length === 1, 'has_hooks はそのままマージする');
  }

  console.log('\n── 5b. unstable（自動の確認）──');
  {
    const unstableFirst = { mergeable: true, mergeable_state: 'unstable', head: { sha: 'head-sha' } };
    const cleanSecond = { mergeable: true, mergeable_state: 'clean', head: { sha: 'head-sha' } };

    const pendingThenOk = (() => {
      let reads = 0;
      return editSetup({
        waitResult: [unstableFirst, cleanSecond],
        getCombinedStatus: async () => (++reads === 1
          ? { state: 'pending', statuses: [{ state: 'pending', context: 'ci' }] }
          : { state: 'success', statuses: [{ state: 'success', context: 'ci' }] }),
        listCheckRuns: async () => ({ total_count: 0, check_runs: [] }),
      });
    })();
    const pendingResponse = await pendingThenOk.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(pendingResponse.statusCode === 200 && pendingThenOk.state.merges.length === 1,
      'pending が成功に変わったらマージする');
    check(pendingThenOk.state.waits.length === 2, '確認が終わった後に改めて mergeable を確かめる');

    const pendingRun = (() => {
      let reads = 0;
      return editSetup({
        waitResult: [unstableFirst, cleanSecond],
        getCombinedStatus: async () => ({ state: 'success', statuses: [] }),
        listCheckRuns: async () => (++reads === 1
          ? { total_count: 1, check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }] }
          : { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }),
      });
    })();
    const pendingRunResponse = await pendingRun.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(pendingRunResponse.statusCode === 200 && pendingRun.state.merges.length === 1,
      'check run が実行中から成功に変わったらマージする');

    const statusFailed = editSetup({
      waitResult: unstableFirst,
      getCombinedStatus: async () => ({ state: 'failure', statuses: [{ state: 'failure', context: 'deploy' }] }),
    });
    const statusFailedResponse = await statusFailed.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(statusFailedResponse.statusCode === 409 && statusFailed.state.merges.length === 0,
      'commit status が失敗ならマージしない');
    const statusFailedNote = findNotification(statusFailed.state, 'edit_approve_failed');
    check(statusFailedNote && statusFailedNote.data.comment.includes('自動の確認（試験・試し公開）が失敗しています'),
      'commit status の失敗を理由に通知する');

    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required']) {
      const runFailed = editSetup({
        waitResult: unstableFirst,
        listCheckRuns: async () => ({ total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion }] }),
      });
      const runFailedResponse = await runFailed.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
      check(runFailedResponse.statusCode === 409 && runFailed.state.merges.length === 0,
        `check run が ${conclusion} ならマージしない`);
    }

    const timedOut = editSetup({
      waitResult: unstableFirst,
      getCombinedStatus: async () => ({ state: 'pending', statuses: [{ state: 'pending', context: 'ci' }] }),
      editCheckWait: { intervalMs: 1, maxWaitMs: 3 },
    });
    const timedOutResponse = await timedOut.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(timedOutResponse.statusCode === 409 && timedOut.state.merges.length === 0,
      '時間切れならマージしない');
    const timedOutNote = findNotification(timedOut.state, 'edit_approve_failed');
    check(timedOutNote && timedOutNote.data.comment.includes('自動の確認が終わっていません'),
      '時間切れを理由に通知する');

    const headChanged = (() => {
      let reads = 0;
      return editSetup({
        waitResult: unstableFirst,
        getCombinedStatus: async () => ({ state: 'pending', statuses: [{ state: 'pending', context: 'ci' }] }),
        getPR: async () => {
          reads++;
          return reads === 1
            ? { merged: false, head: { sha: 'head-sha' } }
            : { merged: false, head: { sha: 'new-head-sha' } };
        },
      });
    })();
    const headChangedResponse = await headChanged.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(headChangedResponse.statusCode === 409 && headChanged.state.merges.length === 0,
      '待つ間に head sha が変わったらマージしない');
    const headChangedNote = findNotification(headChanged.state, 'edit_approve_failed');
    check(headChangedNote && headChangedNote.data.comment.includes('画面を開いた後に PR が更新されました'),
      '待つ間の head の変化は画面を開き直すよう通知する');

    // N1: 確認が終わった直後も unstable のときは、PR を読み直して clean を待つ。
    const lateClean = (() => {
      let reads = 0;
      return editSetup({
        waitResult: [unstableFirst, unstableFirst],
        getCombinedStatus: async () => ({ state: 'success', statuses: [] }),
        getPR: async () => {
          reads++;
          if (reads <= 2) {
            return { merged: false, state: 'open', head: { sha: 'head-sha' }, mergeable: true, mergeable_state: 'unstable' };
          }
          if (reads === 3) {
            return { merged: false, state: 'open', head: { sha: 'head-sha' }, mergeable: true, mergeable_state: 'clean' };
          }
          return { merged: true, head: { sha: 'head-sha' } };
        },
      });
    })();
    const lateCleanResponse = await lateClean.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(lateCleanResponse.statusCode === 200 && lateClean.state.merges.length === 1,
      '確認の後にまだ unstable でも、clean に変わったらマージする');

    // N1: 確認が終わった直後に pending が残っていれば、同じ締め切りの中で待ちを続ける。
    const latePending = (() => {
      let statusReads = 0;
      let prReads = 0;
      return editSetup({
        waitResult: [unstableFirst, unstableFirst],
        getCombinedStatus: async () => {
          statusReads++;
          return statusReads === 2
            ? { state: 'pending', statuses: [{ state: 'pending', context: 'ci' }] }
            : { state: 'success', statuses: [] };
        },
        getPR: async () => {
          prReads++;
          if (prReads >= 4) return { merged: true, head: { sha: 'head-sha' } };
          if (prReads >= 2) {
            return { merged: false, state: 'open', head: { sha: 'head-sha' }, mergeable: true, mergeable_state: 'clean' };
          }
          return { merged: false, state: 'open', head: { sha: 'head-sha' } };
        },
      });
    })();
    const latePendingResponse = await latePending.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(latePendingResponse.statusCode === 200 && latePending.state.merges.length === 1,
      '確認の後に pending が残っていても、終わって clean になればマージする');

    // N1: 最後まで unstable なら、mergeable_state の文ではなく開き直しを促す文で止める。
    const stillUnstable = editSetup({
      waitResult: [unstableFirst, unstableFirst],
      getCombinedStatus: async () => ({ state: 'success', statuses: [] }),
      getPR: async () => ({
        merged: false, state: 'open', head: { sha: 'head-sha' }, mergeable: true, mergeable_state: 'unstable',
      }),
    });
    const stillUnstableResponse = await stillUnstable.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(stillUnstableResponse.statusCode === 409 && stillUnstable.state.merges.length === 0,
      '最後まで unstable ならマージしない');
    const stillUnstableNote = findNotification(stillUnstable.state, 'edit_approve_failed');
    check(stillUnstableNote && stillUnstableNote.data.comment.includes('自動の確認が終わっていません')
      && !stillUnstableNote.data.comment.includes('mergeable_state'),
      '最後まで unstable なら mergeable_state の文ではなく、開き直しを促す文で通知する');

    // N7: 待つ間にマージされたら、見た版と同じときだけ処理済みにする。
    const mergedWhileWaiting = (() => {
      let reads = 0;
      return editSetup({
        waitResult: unstableFirst,
        getCombinedStatus: async () => ({ state: 'pending', statuses: [{ state: 'pending', context: 'ci' }] }),
        getPR: async () => {
          reads++;
          return reads === 1
            ? { merged: false, state: 'open', head: { sha: 'head-sha' } }
            : { merged: true, state: 'closed', head: { sha: 'head-sha' } };
        },
      });
    })();
    const mergedWhileWaitingResponse = await mergedWhileWaiting.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(mergedWhileWaitingResponse.statusCode === 200
      && JSON.parse(mergedWhileWaitingResponse.body).processed === true
      && mergedWhileWaiting.state.merges.length === 0,
      '待つ間にマージされたら、見た版と同じなら書き込みもマージもせず処理済み');
    check(JSON.stringify(notificationEvents(mergedWhileWaiting.state)) === JSON.stringify(['edit_processed']),
      '待つ間にマージされたら edit_processed を通知する');

    // N7: 待つ間に閉じられたら、マージせずに止める。
    const closedWhileWaiting = (() => {
      let reads = 0;
      return editSetup({
        waitResult: unstableFirst,
        getCombinedStatus: async () => ({ state: 'pending', statuses: [{ state: 'pending', context: 'ci' }] }),
        getPR: async () => {
          reads++;
          return reads === 1
            ? { merged: false, state: 'open', head: { sha: 'head-sha' } }
            : { merged: false, state: 'closed', head: { sha: 'head-sha' } };
        },
      });
    })();
    const closedWhileWaitingResponse = await closedWhileWaiting.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(closedWhileWaitingResponse.statusCode === 409 && closedWhileWaiting.state.merges.length === 0,
      '待つ間に閉じられたらマージしない');
    const closedWhileWaitingNote = findNotification(closedWhileWaiting.state, 'edit_approve_failed');
    check(closedWhileWaitingNote && closedWhileWaitingNote.data.comment.includes('PR が閉じられました'),
      '待つ間に閉じられたら PR が閉じられたと通知する');

    // N7: 読み取りの一時的なエラーは 3 回続くまで待ちを続ける。
    const transientErrors = (() => {
      let reads = 0;
      return editSetup({
        waitResult: [unstableFirst, cleanSecond],
        getCombinedStatus: async () => ({ state: 'success', statuses: [] }),
        getPR: async () => {
          reads++;
          if (reads <= 2) throw new Error('GitHub get PR 502');
          if (reads >= 4) return { merged: true, head: { sha: 'head-sha' } };
          return { merged: false, state: 'open', head: { sha: 'head-sha' } };
        },
      });
    })();
    const transientErrorsResponse = await transientErrors.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(transientErrorsResponse.statusCode === 200 && transientErrors.state.merges.length === 1,
      '読み取りのエラーが 2 回続いても、その後に読めればマージする');

    // N7: 4 回続いたら「状態を確認できませんでした」で止める。
    const persistentErrors = editSetup({
      waitResult: unstableFirst,
      getPR: async () => { throw new Error('GitHub get PR 502'); },
    });
    const persistentErrorsResponse = await persistentErrors.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(persistentErrorsResponse.statusCode === 409 && persistentErrors.state.merges.length === 0,
      '読み取りのエラーが 4 回続いたらマージしない');
    const persistentErrorsNote = findNotification(persistentErrors.state, 'edit_approve_failed');
    check(persistentErrorsNote && persistentErrorsNote.data.comment.includes('自動の確認の状態を確認できませんでした'),
      '読み取りのエラーが 4 回続いたら状態を確認できなかったと通知する');
  }

  console.log('\n── 6. マージ後の確認と二度押し ──');
  {
    const notMerged = editSetup({ afterMerge: { merged: false } });
    const notMergedResponse = await notMerged.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(notMergedResponse.statusCode === 409 && JSON.parse(notMergedResponse.body).merged === undefined,
      'マージ後に merged が false なら成功扱いにしない');
    check(JSON.stringify(notificationEvents(notMerged.state)) === JSON.stringify(['edit_approve_failed']),
      'merged が false なら edit_approve_failed を通知する');

    // L6: 開いている PR の merged の値だけでは処理済みにしない
    // （findPR は開いている PR しか返さないので、この分岐は起こらない）。
    const openMergedFlag = editSetup({ pr: defaultPR({ merged: true }) });
    const openMergedFlagResponse = await openMergedFlag.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    const openMergedFlagBody = JSON.parse(openMergedFlagResponse.body);
    check(openMergedFlagResponse.statusCode === 200 && openMergedFlagBody.processed === undefined
      && openMergedFlag.state.merges.length === 1,
    '開いている PR の merged の値だけでは処理済みにせず、通常どおりマージする');
  }

  console.log('\n── 6b. 閉じた手直し PR への二度押し ──');
  {
    const mergedClosed = editSetup({
      pr: null,
      afterMerge: defaultPR({ merged: true, state: 'closed', merged_at: '2026-11-08T00:00:00Z' }),
    });
    const mergedClosedResponse = await mergedClosed.run({ pr_number: 901, head_sha: 'head-sha', file_sha: 'branch-sha' });
    const mergedClosedBody = JSON.parse(mergedClosedResponse.body);
    check(mergedClosedResponse.statusCode === 200 && mergedClosedBody.processed === true
      && mergedClosed.state.merges.length === 0 && mergedClosed.state.puts.length === 0,
    'マージ済みの閉じた PR は正しい pr_number なら書き込みもマージもせず 200 の処理済み');
    check(JSON.stringify(notificationEvents(mergedClosed.state)) === JSON.stringify(['edit_processed']),
      'マージ済みの閉じた PR は edit_processed を 1 回だけ通知する');

    // L6: マージされた版が、画面で見た head sha と違う。
    const mergedOtherSha = editSetup({
      pr: null,
      afterMerge: defaultPR({ merged: true, state: 'closed', head: { ref: REF, sha: 'other-head-sha' } }),
    });
    const mergedOtherShaResponse = await mergedOtherSha.run({ pr_number: 901, head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(mergedOtherShaResponse.statusCode === 409 && mergedOtherSha.state.merges.length === 0 && mergedOtherSha.state.puts.length === 0,
      'マージ済みでも見た版と違う版なら処理済みにしない');
    const mergedOtherShaNote = findNotification(mergedOtherSha.state, 'edit_approve_failed');
    check(mergedOtherShaNote && mergedOtherShaNote.data.comment.includes('画面で見た版と違う版がマージされています'),
      '見た版と違う版がマージされていたら GitHub で確認するよう通知する');

    const wrongBranch = editSetup({
      pr: null,
      afterMerge: defaultPR({ merged: true, head: { ref: 'edit/another-article', sha: 'other-sha' } }),
    });
    const wrongBranchResponse = await wrongBranch.run({ pr_number: 901, head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(wrongBranchResponse.statusCode === 409 && wrongBranch.state.merges.length === 0 && wrongBranch.state.puts.length === 0,
      'pr_number の枝が ref と違えばマージも書き込みもしない');
    check(JSON.stringify(notificationEvents(wrongBranch.state)) === JSON.stringify(['edit_approve_failed']),
      'pr_number の枝が ref と違えば edit_approve_failed を通知する');

    const closedUnmerged = editSetup({
      pr: null,
      afterMerge: defaultPR({ merged: false, state: 'closed' }),
    });
    const closedUnmergedResponse = await closedUnmerged.run({ pr_number: 901, head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(closedUnmergedResponse.statusCode === 409 && closedUnmerged.state.merges.length === 0 && closedUnmerged.state.puts.length === 0,
      'マージされずに閉じた PR はマージも書き込みもしない');
    check(JSON.stringify(notificationEvents(closedUnmerged.state)) === JSON.stringify(['edit_approve_failed']),
      'マージされずに閉じた PR は edit_approve_failed を通知する');

    for (const [label, value] of [['文字列', '901'], ['負の数', -901]]) {
      const invalid = editSetup({ pr: null });
      const invalidResponse = await invalid.run({ pr_number: value, head_sha: 'head-sha', file_sha: 'branch-sha' });
      check(invalidResponse.statusCode === 409 && invalid.state.prReads === 0,
        `pr_number が${label}なら getPR を呼ばず 409`);
      check(JSON.stringify(notificationEvents(invalid.state)) === JSON.stringify(['edit_approve_failed']),
        `pr_number が${label}なら edit_approve_failed を通知する`);
    }
  }

  console.log('\n── 7. 照合の停止と上書き ──');
  {
    const blocking = { fact_check_status: 'revise', fact_check_blocking: true, fact_check_summary: '見出しに食い違い' };
    const blocked = editSetup({ branch: article({ overrides: blocking }) });
    const blockedResponse = await blocked.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
    check(blockedResponse.statusCode === 400 && blocked.state.merges.length === 0 && blocked.state.puts.length === 0,
      '照合で止まる記事は上書きなしでは 400 でマージしない');
    check(Boolean(findNotification(blocked.state, 'quality_blocked')), '照合の停止は quality_blocked で通知する');

    const stale = editSetup({ branch: article({ overrides: blocking }) });
    const staleResponse = await stale.run({ head_sha: 'head-sha', file_sha: 'old-sha', fact_check_override: true });
    check(staleResponse.statusCode === 409 && stale.state.merges.length === 0 && stale.state.puts.length === 0,
      '上書きの同意でも見た版が違えば書かずにマージしない');

    const overridden = editSetup({
      branch: article({ overrides: blocking }),
      waitResult: { mergeable: true, mergeable_state: 'clean', head: { sha: 'override-commit' } },
    });
    const overriddenResponse = await overridden.run({ head_sha: 'head-sha', file_sha: 'branch-sha', fact_check_override: true });
    check(overriddenResponse.statusCode === 200 && overridden.state.puts.length === 1 && overridden.state.puts[0][4] === REF,
      '上書きが受け入れられたら枝にだけ記録を書く');
    const saved = overridden.state.puts[0][1];
    check(saved.includes('fact_check_override: true') && saved.includes('review_status: "published"')
      && saved.includes('publish_at: "2024-02-01T17:15:00+09:00"') && saved.includes('published_at: "2024-02-01T17:15:00+09:00"'),
    '上書きの記録だけを足し、公開状態の項目は書き換えない');
    check(overridden.state.waits[0].options.expectedHeadSha === 'override-commit'
      && overridden.state.merges[0][2].expectedHeadSha === 'override-commit',
    '上書きでできた新しいコミットの sha でマージする');
  }

  console.log('\n── 8. 出典ガード・仮置きタイトル・品質ゲート ──');
  {
    const cases = [
      ['出典ガード', article({ overrides: { source_url: 'https://example.invalid/source', source_provenance: 'unknown' } }), 'source_blocked'],
      ['仮置きタイトル', article({ title: '[要レビュー] edit-check' }), 'quality_blocked'],
      ['recommendation が reject', article({ overrides: { recommendation: 'reject' } }), 'quality_blocked'],
      ['顧客適合スコアが低い', article({ overrides: { recommendation: 'publish', customer_fit_score: 3 } }), 'quality_blocked'],
      ['検索意図スコアが低い', article({ overrides: { recommendation: 'publish', search_intent_score: 3 } }), 'quality_blocked'],
    ];
    for (const [label, branch, event] of cases) {
      const harness = editSetup({ branch });
      const response = await harness.run({ head_sha: 'head-sha', file_sha: 'branch-sha' });
      check(response.statusCode === 400 && harness.state.merges.length === 0 && harness.state.puts.length === 0,
        `${label} で止まったらマージしない`);
      check(Boolean(findNotification(harness.state, event)), `${label} は ${event} で通知する`);
    }
  }

  console.log('\n=== 9. 手直し PR の差し戻し ===');
  {
    const state = { puts: [], comments: [], workflows: [], notifications: [], gets: [], denylist: 0 };
    const deps = {
      getFile: async (file, ref) => {
        state.gets.push({ file, ref });
        return { content: article({ title: '手直し後の題名' }), sha: 'branch-sha' };
      },
      putFile: async (...args) => { state.puts.push(args); },
      updateFrontmatter: api.updateFrontmatter,
      nowJST: () => '2026-11-09T10:00:00+09:00',
      triggerWorkflow: async (...args) => { state.workflows.push(args); },
      findPR: async () => defaultPR(),
      listPRFiles: async () => DEFAULT_FILES,
      compareCommits: async () => ({ merge_base_commit: { sha: 'base-sha' } }),
      commentOnPR: async (number, body) => { state.comments.push([number, body]); },
      appendEntries: async () => { state.denylist++; return { added: [] }; },
      extractFmField: api.extractFmField,
      readjustPublishSlots: async () => { throw new Error('公開枠の再調整を呼んではいけません'); },
      sendNotification: async (event, data) => state.notifications.push({ event, data }),
    };
    const response = await revise._handler(authenticatedEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ filename: FILENAME, ref: REF, comment: '見出しを直してください' }),
    }), deps);
    check(response.statusCode === 200, '差し戻しは 200 を返す');
    check(state.puts.length === 0 && state.workflows.length === 0, '記事・禁止リスト・公開枠に書かず、再生成を起動しない');
    check(state.gets.every(item => item.file === ARTICLE_PATH), '記事以外のファイルを読み書きしない');
    check(state.comments.length === 1 && state.comments[0][0] === 901
      && state.comments[0][1] === '承認画面から差し戻し: 見出しを直してください', 'PR に差し戻しのコメントを 1 回残す');
    check(state.notifications.length === 1 && state.notifications[0].event === 'edit_revise_requested',
      'edit_revise_requested を 1 回通知する');
    check(state.notifications[0].data.prUrl === PR_URL
      && state.notifications[0].data.reviewUrl === `https://mori-zeirishi.net/review?file=${FILENAME}&ref=edit%2Fedit-check`,
    'PR の URL と画面の URL を通知する');
    check(state.denylist === 0, '手直しの差し戻しでは denylist の appendEntries を呼ばない');
  }

  console.log('\n=== 10. 手直し PR の見送り ===');
  {
    const state = { puts: [], closes: [], deletes: [], comments: [], notifications: [] };
    const deps = {
      getFile: async () => ({ content: article({ title: '手直し後の題名' }), sha: 'branch-sha' }),
      putFile: async (...args) => { state.puts.push(args); },
      updateFrontmatter: api.updateFrontmatter,
      nowJST: () => '2026-11-09T10:00:00+09:00',
      findPR: async () => defaultPR(),
      listPRFiles: async () => DEFAULT_FILES,
      compareCommits: async () => ({ merge_base_commit: { sha: 'base-sha' } }),
      closePR: async number => { state.closes.push(number); },
      commentOnPR: async (number, body) => { state.comments.push([number, body]); },
      deleteBranch: async name => { state.deletes.push(name); },
      extractFmField: api.extractFmField,
      readjustPublishSlots: async () => { throw new Error('公開枠の再調整を呼んではいけません'); },
      sendNotification: async (event, data) => state.notifications.push({ event, data }),
    };
    const response = await skip._handler(authenticatedEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ filename: FILENAME, ref: REF }),
    }), deps);
    check(response.statusCode === 200, '見送りは 200 を返す');
    check(state.puts.length === 0, '記事には何も書かない');
    check(state.closes.length === 1 && state.closes[0] === 901, 'PR を 1 回閉じる');
    check(state.deletes.length === 0, '枝は消さない');
    check(state.comments.length === 1 && state.comments[0][1] === '承認画面から見送り', 'PR に見送りのコメントを残す');
    check(state.notifications.length === 1 && state.notifications[0].event === 'edit_skipped',
      'edit_skipped を 1 回通知する');
  }

  console.log('\n=== 11. 手直し PR でない公開済みの記事の承認 ===');
  {
    const harness = editSetup({
      ref: 'draft/ordinary-review',
      branch: article({ status: 'needs_review' }),
    });
    const response = await harness.run({}, { ref: 'draft/ordinary-review' });
    check(response.statusCode === 409, '公開済みの記事は通常の承認経路では 409');
    check(harness.state.puts.length === 0 && harness.state.merges.length === 0, '書き込みもマージもしない');
    const note = findNotification(harness.state, 'edit_unsupported');
    check(Boolean(note) && note.data.comment === 'この画面では承認できない種類の PR です。GitHub で確認してください',
      '黙って失敗せず edit_unsupported を通知する');
  }

  console.log('\n=== 11b. 形が正しくない edit/ の枝 ===');
  {
    const badRefs = ['edit/Foo', 'edit/2026/foo', 'edit/foo.bar', `edit/${'a'.repeat(82)}`];
    for (const badRef of badRefs) {
      check(manualEdit.isManualEditRef(badRef) === false, `${badRef.slice(0, 24)}… は手直しの枝として扱わない`);
      const checked = await checkContext({ ref: badRef });
      check(checked.ok === false && checked.reasons.some(reason => reason.includes('形が正しくありません')),
        `${badRef.slice(0, 24)}… は形が正しくないと理由を出す`);
    }

    const approveHarness = editSetup({ ref: 'edit/Foo' });
    const approveResponse = await approveHarness.run({ head_sha: 'head-sha', file_sha: 'branch-sha' }, { ref: 'edit/Foo' });
    check(approveResponse.statusCode === 409 && approveHarness.state.puts.length === 0 && approveHarness.state.merges.length === 0,
      '形が正しくない枝の承認は、書かずにマージせず 409');
    check(JSON.stringify(notificationEvents(approveHarness.state)) === JSON.stringify(['edit_unsupported']),
      '形が正しくない枝の承認は edit_unsupported を通知する');

    const reviseState = { puts: [], workflows: [], notifications: [], denylist: 0 };
    const reviseResponse = await revise._handler(authenticatedEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ filename: FILENAME, ref: 'edit/Foo', comment: '直してください' }),
    }), {
      getFile: async () => { throw new Error('読んではいけません'); },
      putFile: async (...args) => { reviseState.puts.push(args); },
      updateFrontmatter: api.updateFrontmatter,
      nowJST: () => '2026-11-09T10:00:00+09:00',
      triggerWorkflow: async (...args) => { reviseState.workflows.push(args); },
      findPR: async () => defaultPR(),
      commentOnPR: async () => {},
      appendEntries: async () => { reviseState.denylist++; return { added: [] }; },
      extractFmField: api.extractFmField,
      readjustPublishSlots: async () => null,
      sendNotification: async (event, data) => reviseState.notifications.push({ event, data }),
    });
    check(reviseResponse.statusCode === 409 && reviseState.puts.length === 0 && reviseState.workflows.length === 0
      && reviseState.denylist === 0, '形が正しくない枝の差し戻しは、何も書かずワークフローも起動しない');
    check(reviseState.notifications.length === 1 && reviseState.notifications[0].event === 'edit_unsupported',
      '形が正しくない枝の差し戻しは edit_unsupported を通知する');

    const skipState = { puts: [], closes: [], notifications: [] };
    const skipResponse = await skip._handler(authenticatedEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ filename: FILENAME, ref: 'edit/Foo' }),
    }), {
      getFile: async () => { throw new Error('読んではいけません'); },
      putFile: async (...args) => { skipState.puts.push(args); },
      updateFrontmatter: api.updateFrontmatter,
      nowJST: () => '2026-11-09T10:00:00+09:00',
      findPR: async () => defaultPR(),
      closePR: async number => { skipState.closes.push(number); },
      commentOnPR: async () => {},
      deleteBranch: async () => {},
      extractFmField: api.extractFmField,
      readjustPublishSlots: async () => null,
      sendNotification: async (event, data) => skipState.notifications.push({ event, data }),
    });
    check(skipResponse.statusCode === 409 && skipState.puts.length === 0 && skipState.closes.length === 0,
      '形が正しくない枝の見送りは、何も書かず PR も閉じない');
    check(skipState.notifications.length === 1 && skipState.notifications[0].event === 'edit_unsupported',
      '形が正しくない枝の見送りは edit_unsupported を通知する');
  }

  console.log('\n=== 11c. 差し戻し・見送りの失敗 ===');
  {
    const makeRevise = (commentOnPR) => {
      const state = { puts: [], notifications: [], denylist: 0 };
      const deps = {
        getFile: async () => ({ content: article({ title: '手直し後の題名' }), sha: 'branch-sha' }),
        putFile: async (...args) => { state.puts.push(args); },
        updateFrontmatter: api.updateFrontmatter,
        nowJST: () => '2026-11-09T10:00:00+09:00',
        triggerWorkflow: async () => {},
        findPR: async () => defaultPR(),
        listPRFiles: async () => DEFAULT_FILES,
        compareCommits: async () => ({ merge_base_commit: { sha: 'base-sha' } }),
        commentOnPR,
        appendEntries: async () => { state.denylist++; return { added: [] }; },
        extractFmField: api.extractFmField,
        readjustPublishSlots: async () => null,
        sendNotification: async (event, data) => state.notifications.push({ event, data }),
      };
      return { state, run: () => revise._handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ filename: FILENAME, ref: REF, comment: '直してください' }),
      }), deps) };
    };

    const reviseFailed = makeRevise(async () => { throw new Error('comment failed'); });
    const reviseFailedResponse = await reviseFailed.run();
    check(reviseFailedResponse.statusCode === 502 && reviseFailed.state.puts.length === 0,
      '差し戻しのコメントに失敗したら 502 を返し、記事を書かない');
    check(JSON.stringify(notificationEvents(reviseFailed.state)) === JSON.stringify(['edit_revise_failed']),
      '差し戻しのコメントに失敗したら edit_revise_failed を通知する');

    const makeSkip = (commentOnPR, closePR) => {
      const state = { puts: [], notifications: [] };
      const deps = {
        getFile: async () => ({ content: article({ title: '手直し後の題名' }), sha: 'branch-sha' }),
        putFile: async (...args) => { state.puts.push(args); },
        updateFrontmatter: api.updateFrontmatter,
        nowJST: () => '2026-11-09T10:00:00+09:00',
        findPR: async () => defaultPR(),
        listPRFiles: async () => DEFAULT_FILES,
        compareCommits: async () => ({ merge_base_commit: { sha: 'base-sha' } }),
        closePR,
        commentOnPR,
        deleteBranch: async () => {},
        extractFmField: api.extractFmField,
        readjustPublishSlots: async () => null,
        sendNotification: async (event, data) => state.notifications.push({ event, data }),
      };
      return { state, run: () => skip._handler(authenticatedEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ filename: FILENAME, ref: REF }),
      }), deps) };
    };

    const commentFailed = makeSkip(async () => { throw new Error('comment failed'); }, async () => {});
    const commentFailedResponse = await commentFailed.run();
    check(commentFailedResponse.statusCode === 502 && commentFailed.state.puts.length === 0,
      '見送りのコメントに失敗したら 502 を返し、記事を書かない');
    check(JSON.stringify(notificationEvents(commentFailed.state)) === JSON.stringify(['edit_skip_failed']),
      '見送りのコメントに失敗したら edit_skip_failed を通知する');

    const closeFailed = makeSkip(async () => {}, async () => { throw new Error('close failed'); });
    const closeFailedResponse = await closeFailed.run();
    check(closeFailedResponse.statusCode === 502 && closeFailed.state.puts.length === 0,
      '見送りのクローズに失敗したら 502 を返し、記事を書かない');
    check(JSON.stringify(notificationEvents(closeFailed.state)) === JSON.stringify(['edit_skip_failed']),
      '見送りのクローズに失敗したら edit_skip_failed を通知する');
  }

  console.log('\n=== 12. 入力の検査 ===');
  {
    const badName = editSetup();
    const badNameResponse = await badName.run({ head_sha: 'head-sha' }, { filename: '../x.md' });
    check(badNameResponse.statusCode === 400 && badName.state.puts.length === 0, 'filename が ../x.md なら 400');
    const txtName = editSetup();
    const txtNameResponse = await txtName.run({ head_sha: 'head-sha' }, { filename: 'a.txt' });
    check(txtNameResponse.statusCode === 400, 'filename が a.txt なら 400');
    const longRef = editSetup();
    const longRefResponse = await longRef.run({ head_sha: 'head-sha' }, { ref: `edit/${'a'.repeat(196)}` });
    check(longRefResponse.statusCode === 400, 'ref が 200 字を超えたら 400');
  }

  console.log('\n=== 13. getFile の ref の符号化 ===');
  {
    const savedFetch = global.fetch;
    const savedToken = process.env.GITHUB_TOKEN;
    const savedApp = {
      id: process.env.GH_APP_ID,
      key: process.env.GH_APP_PRIVATE_KEY,
      installation: process.env.GH_APP_INSTALLATION_ID,
    };
    delete process.env.GH_APP_ID;
    delete process.env.GH_APP_PRIVATE_KEY;
    delete process.env.GH_APP_INSTALLATION_ID;
    process.env.GITHUB_TOKEN = 'test-secret';
    const urls = [];
    global.fetch = async url => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from('x').toString('base64'), sha: 's' }),
        text: async () => '',
      };
    };
    try {
      await api.getFile('content/posts/x.md', 'edit/a b');
      check(urls.length === 1 && urls[0].endsWith(`/contents/content/posts/x.md?ref=${encodeURIComponent('edit/a b')}`),
        'edit/a b を edit%2Fa%20b に符号化する');
      check(urls[0].includes('ref=edit%2Fa%20b'), '符号化した ref を URL に使う');
    } finally {
      global.fetch = savedFetch;
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedToken;
      process.env.GH_APP_ID = savedApp.id;
      process.env.GH_APP_PRIVATE_KEY = savedApp.key;
      process.env.GH_APP_INSTALLATION_ID = savedApp.installation;
      if (savedApp.id === undefined) delete process.env.GH_APP_ID;
      if (savedApp.key === undefined) delete process.env.GH_APP_PRIVATE_KEY;
      if (savedApp.installation === undefined) delete process.env.GH_APP_INSTALLATION_ID;
    }
  }

  console.log('\n=== 13b. review-page の配線（偽の github-api）===');
  {
    const saved = {
      getFile: api.getFile, findPR: api.findPR, listPRFiles: api.listPRFiles, compareCommits: api.compareCommits,
    };
    const keys = ['GH_APP_ID', 'GH_APP_PRIVATE_KEY', 'GH_APP_INSTALLATION_ID', 'GITHUB_TOKEN'];
    const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.GITHUB_TOKEN = 'test-secret';
    const calls = [];
    const main = article({ title: '公開中の題名', summary: '公開中の説明文', body: '公開中の本文です。' });
    const branch = article({ title: '手直し後の題名', summary: '手直し後の説明文', body: '手直し後の本文です。' });
    api.findPR = async () => defaultPR();
    api.listPRFiles = async () => DEFAULT_FILES;
    api.compareCommits = async () => ({ merge_base_commit: { sha: 'base-sha' } });
    api.getFile = async (file, ref) => {
      calls.push({ file, ref });
      if (file !== ARTICLE_PATH) throw new Error('GitHub GET 404: not found');
      if (ref === 'main' || ref === 'base-sha') return { content: main, sha: 'main-sha' };
      return { content: branch, sha: 'branch-sha' };
    };
    try {
      const response = await page.handler(authenticatedEvent({
        httpMethod: 'GET',
        queryStringParameters: { file: FILENAME, ref: REF },
      }));
      check(response.statusCode === 200, 'review-page は手直し PR の画面を 200 で返す');
      check(response.body.includes('公開中の記事の手直しです'), 'review-page が checkManualEditPR の結果を使って手直しの画面を出す');
      check(response.body.includes('const EDIT_HEAD_SHA = "head-sha";'), '画面に表示した head sha を埋める');
      check(calls.some(call => call.file === ARTICLE_PATH && call.ref === 'head-sha'),
        '本文は checkManualEditPR が読んだ同じ head sha から描く');
      check(!calls.some(call => call.file === ARTICLE_PATH && call.ref === REF),
        '枝の名前のままでは本文を読まない');
    } finally {
      Object.assign(api, saved);
      for (const key of keys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  }

  console.log('\n=== 14. 新しい通知の文面 ===');
  {
    const data = {
      title: '手直し後の題名', comment: '見出しを直しました',
      reviewUrl: 'https://mori-zeirishi.net/review?file=x.md&ref=edit%2Fx',
      prUrl: PR_URL, publicUrl: 'https://mori-zeirishi.net/blog/edit-check/',
    };
    const expected = {
      edit_ready: '【手直しの確認】手直し後の題名',
      edit_published: '【手直し】公開中の記事に反映しました',
      edit_approve_failed: '【手直し】公開中の記事に反映できませんでした',
      edit_processed: '【手直し】すでに反映済みです',
      edit_revise_requested: '【手直し】差し戻しを受け付けました',
      edit_skipped: '【手直し】見送りにしました',
      edit_revise_failed: '【手直し】差し戻しを伝えられませんでした',
      edit_skip_failed: '【手直し】見送れませんでした',
      edit_unsupported: '【手直し】この画面では扱えない PR です',
    };
    for (const [event, subject] of Object.entries(expected)) {
      const message = buildMessage(event, data);
      check(message.subject === subject, `${event} の件名が決まった文面`);
      check(!/^\{/.test(message.body) && !message.body.includes('undefined'), `${event} が JSON のまま出ず、欠けた値も出ない`);
      check(message.body.includes(PR_URL), `${event} に PR の URL が入る`);
    }
    check(buildMessage('edit_ready', data).body.includes(data.reviewUrl), 'edit_ready に画面の URL が入る');
    check(buildMessage('edit_published', data).body.includes(data.publicUrl), 'edit_published に記事の URL が入る');
    check(buildMessage('edit_revise_requested', data).body.includes(data.reviewUrl), 'edit_revise_requested に画面の URL が入る');
  }

  console.log('\n=== 15. 通知のワークフロー ===');
  {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'manual-edit-ready.yml');
    check(fs.existsSync(workflowPath), 'manual-edit-ready.yml がある');
    const yaml = fs.readFileSync(workflowPath, 'utf8');
    check(/pull_request:/.test(yaml) && /types:\s*\[opened, reopened, ready_for_review\]/.test(yaml),
      'opened・reopened・ready_for_review で動く');
    check(/workflow_dispatch:/.test(yaml) && /pr_number:/.test(yaml), 'workflow_dispatch で PR 番号を渡せる');
    check(/branches:\s*\[main\]/.test(yaml), 'base が main の PR だけを対象にする');
    check(/permissions:[\s\S]*contents:\s*read/.test(yaml) && /permissions:[\s\S]*pull-requests:\s*read/.test(yaml),
      '権限は contents と pull-requests の read だけ');
    check(!/contents:\s*write|pull-requests:\s*write/.test(yaml), '書き込み権限を持たない');
    check(/startsWith\(github\.event\.pull_request\.head\.ref, 'edit\/'\)/.test(yaml), 'edit/ の枝だけを対象にする');
    check(/github\.event\.pull_request\.draft == false/.test(yaml) && /isDraft/.test(yaml), '下書きの PR では通知しない');
    check(/uses:\s*actions\/checkout@v4[\s\S]*?ref:\s*main/.test(yaml), 'checkout は main にする');
    check(/gh pr view/.test(yaml) && /pr_number|PR_NUMBER/.test(yaml), 'PR の情報は gh で読む');
    check(/--event edit_ready/.test(yaml) && /--review-url/.test(yaml) && /--pr-url/.test(yaml), 'edit_ready を画面の URL と PR の URL 付きで送る');
    check(/node scripts\/notify\.js/.test(yaml), '既存の通知スクリプトを使う');
    check(/require\("\.\/netlify\/functions\/lib\/manual-edit"\)\.isManualEditRef/.test(yaml)
      && /node -e/.test(yaml), 'main の manual-edit.js の isManualEditRef で同じ判定をする');
    check(/read_field state\)" != "OPEN"/.test(yaml), '開いている PR だけを通知する');
    check(/contents\/content\/posts\/\$\{ENCODED_FILE\}\?ref=\$\{HEAD_SHA\}/.test(yaml),
      '題名は枝の記事を head sha の API からデータとして読む');
    check(/\|\| echo '\{\}'/.test(yaml), '記事を取得できなくてもジョブを失敗させない（題名は PR の題名にする）');
    check(/ENCODED_FILE=/.test(yaml) && /file=\$\{ENCODED_FILE\}/.test(yaml), 'file= の値を URL 符号化する');
    check(/head\.repo\.full_name == github\.repository/.test(yaml), 'フォークからの PR は除外する');
    check(/TITLE=\$\(node -e 'const d = JSON\.parse/.test(yaml), '題名は API で読んだ記事から取る');
  }

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
