'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { decide } = require('../netlify-ignore');
const { createGit } = require('../../netlify-ignore-build');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function env(overrides = {}) {
  return {
    COMMIT_REF: 'new-sha',
    CACHED_COMMIT_REF: 'old-sha',
    CONTEXT: 'production',
    HEAD: 'main',
    BRANCH: 'main',
    ...overrides,
  };
}

function fakeGit(options = {}) {
  const calls = { changedFiles: 0, fetchCommit: 0 };
  const files = options.files || [];
  const contents = options.contents || {};
  return {
    calls,
    changedFiles() {
      calls.changedFiles++;
      if (options.changedFilesError) throw new Error('diff failed');
      return files;
    },
    show(ref, file) {
      const key = `${ref}:${file}`;
      return Object.prototype.hasOwnProperty.call(contents, key) ? contents[key] : null;
    },
    hasCommit() {
      return options.hasCommit !== false;
    },
    fetchCommit() {
      calls.fetchCommit++;
      return options.fetchCommit !== false;
    },
  };
}

function article(status, quoted = false) {
  const value = quoted ? `"${status}"` : status;
  return `---\ntitle: test\nreview_status: ${value}\n---\n本文\n`;
}

function check(label, actual, skip, reason) {
  assert(actual.skip === skip && actual.reason === reason, label);
}

console.log('=== Netlify ビルド要否判定 ===');

{
  const git = fakeGit();
  check('1. COMMIT_REF 無し → ビルド', decide({ env: env({ COMMIT_REF: '' }), git }), false, '比較対象のコミットが無い');
}

{
  const git = fakeGit();
  check('2. 同一 SHA → ビルド', decide({ env: env({ COMMIT_REF: 'same', CACHED_COMMIT_REF: 'same' }), git }), false, 'キャッシュ無し・手動デプロイ・初回のため常にビルド');
}

{
  const git = fakeGit();
  check('3. ビルドフック → ビルド', decide({ env: env({ INCOMING_HOOK_URL: 'https://example.invalid/hook' }), git }), false, 'ビルドフック経由');
}

{
  const git = fakeGit();
  check('4. CONTEXT=dev → ビルド', decide({ env: env({ CONTEXT: 'dev' }), git }), false, '想定外の文脈');
}

{
  const git = fakeGit();
  check('5. deploy-preview × draft/* → 飛ばす', decide({ env: env({ CONTEXT: 'deploy-preview', HEAD: 'draft/2026-09-05-xxx' }), git }), true, '下書きブランチの試しビルドは使われない');
  assert(git.calls.changedFiles === 0, '5. changedFiles を呼ばずに決まる');
}

{
  const git = fakeGit();
  check('6. branch-deploy × draft/* → 飛ばす', decide({ env: env({ CONTEXT: 'branch-deploy', HEAD: 'draft/example' }), git }), true, '下書きブランチの試しビルドは使われない');
}

{
  const git = fakeGit({ files: ['docs/note.md', '.github/workflows/example.yml', 'README.md'] });
  const actual = decide({ env: env(), git });
  assert(actual.skip && actual.reason.startsWith('変更はすべて表示に影響しない（3件、代表例: '), '7. docs/・.github/・README.md だけ → 飛ばす');
}

{
  const file = 'content/posts/example.md';
  const git = fakeGit({ files: [file], contents: { [`old-sha:${file}`]: article('approved'), [`new-sha:${file}`]: article('approved') } });
  assert(decide({ env: env(), git }).skip, '8. 記事 approved → approved → 飛ばす');
}

{
  const file = 'content/posts/new-draft.md';
  const git = fakeGit({ files: [file], contents: { [`new-sha:${file}`]: article('draft') } });
  assert(decide({ env: env(), git }).skip, '9. 記事の新規追加 draft → 飛ばす');
}

{
  const file = 'content/posts/publish.md';
  const git = fakeGit({ files: [file], contents: { [`old-sha:${file}`]: article('approved'), [`new-sha:${file}`]: article('published') } });
  const actual = decide({ env: env(), git });
  assert(!actual.skip && actual.reason === `表示に影響する変更あり（${file}）`, '10. approved → published → ビルド（理由にファイル名）');
}

{
  const file = 'content/posts/unpublish.md';
  const git = fakeGit({ files: [file], contents: { [`old-sha:${file}`]: article('published'), [`new-sha:${file}`]: article('unpublished') } });
  assert(!decide({ env: env(), git }).skip, '11. published → unpublished → ビルド');
}

{
  const file = 'content/posts/deleted.md';
  const git = fakeGit({ files: [file], contents: { [`old-sha:${file}`]: article('published') } });
  assert(!decide({ env: env(), git }).skip, '12. published 記事の削除 → ビルド');
}

{
  const file = 'content/posts/approved.md';
  const git = fakeGit({ files: [file, 'templates/blog-post.html'], contents: { [`old-sha:${file}`]: article('approved'), [`new-sha:${file}`]: article('approved') } });
  const actual = decide({ env: env(), git });
  assert(!actual.skip && actual.reason.includes('templates/blog-post.html'), '13. approved 記事＋templates/ 変更 → ビルド');
}

{
  const file = 'content/posts/quoted.md';
  const git = fakeGit({ files: [file], contents: { [`old-sha:${file}`]: article('approved', true), [`new-sha:${file}`]: article('approved', true) } });
  assert(decide({ env: env(), git }).skip, '14. 引用符付き approved → 飛ばす');
}

{
  const file = 'content/posts/broken.md';
  const git = fakeGit({ files: [file], contents: { [`old-sha:${file}`]: 'frontmatter が無い', [`new-sha:${file}`]: '---\ntitle: test\n---\n' } });
  assert(!decide({ env: env(), git }).skip, '15. frontmatter が読めない記事 → ビルド');
}

{
  const git = fakeGit({ hasCommit: false, fetchCommit: false });
  check('16. 比較コミットを取得できない → ビルド', decide({ env: env(), git }), false, '比較対象のコミットを取得できない');
  assert(git.calls.fetchCommit === 1, '16. fetchCommit は1回だけ呼ぶ');
}

{
  const git = fakeGit({ changedFilesError: true });
  check('17. changedFiles が例外 → ビルド', decide({ env: env(), git }), false, '差分の取得に失敗');
}

{
  const git = fakeGit({ files: [] });
  check('18. 変更 0 件 → 飛ばす', decide({ env: env(), git }), true, '変更なし（Netlify 標準と同じ）');
}

{
  const git = fakeGit({ files: ['data/hub-config.json'] });
  const actual = decide({ env: env(), git });
  assert(!actual.skip && actual.reason === '表示に影響する変更あり（data/hub-config.json）', '19. data/hub-config.json だけ → ビルド');
}

console.log('');
console.log('=== 本物の git を使う確認 ===');

{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-ignore-'));
  try {
    const run = (args) => execFileSync('git', args, { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
    run(['init', '--quiet']);
    run(['config', 'user.email', 'netlify-ignore@example.invalid']);
    run(['config', 'user.name', 'Netlify Ignore Test']);
    run(['commit', '--allow-empty', '--quiet', '-m', 'baseline']);
    const baseline = run(['rev-parse', 'HEAD']);

    const postDir = path.join(temp, 'content', 'posts');
    const postPath = path.join(postDir, 'real-git.md');
    fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(postPath, article('approved'), 'utf8');
    run(['add', 'content/posts/real-git.md']);
    run(['commit', '--quiet', '-m', 'approved']);
    const approved = run(['rev-parse', 'HEAD']);

    fs.writeFileSync(postPath, article('published'), 'utf8');
    run(['add', 'content/posts/real-git.md']);
    run(['commit', '--quiet', '-m', 'published']);
    const published = run(['rev-parse', 'HEAD']);

    const git = createGit(temp);
    const approvedDecision = decide({ env: env({ CACHED_COMMIT_REF: baseline, COMMIT_REF: approved }), git });
    const publishedDecision = decide({ env: env({ CACHED_COMMIT_REF: approved, COMMIT_REF: published }), git });
    assert(approvedDecision.skip, '本物の git: approved の新規追加 → 飛ばす');
    assert(!publishedDecision.skip && publishedDecision.reason.includes('content/posts/real-git.md'), '本物の git: approved → published → ビルド');
  } catch (error) {
    assert(false, `本物の git の確認（${String(error.message).replace(/\s+/g, ' ')}）`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
