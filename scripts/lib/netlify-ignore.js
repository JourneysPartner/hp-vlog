'use strict';

const SUPPORTED_CONTEXTS = new Set(['production', 'deploy-preview', 'branch-deploy']);
const IGNORED_PREFIXES = ['docs/', '.github/', 'scripts/lib/__tests__/', '.claude/', '.codex/'];
const IGNORED_ROOT_FILES = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md']);
const IGNORED_FILES = new Set(['data/withdrawn-topics.json']);

function result(skip, reason) {
  return { skip, reason };
}

function parseReviewStatus(content) {
  if (typeof content !== 'string') return null;

  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return null;

  const end = lines.indexOf('---', 1);
  if (end === -1) return null;

  for (let index = 1; index < end; index++) {
    const match = lines[index].match(/^\s*review_status\s*:\s*(.*?)\s*$/);
    if (!match) continue;

    let value = match[1].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1).trim();
      }
    }
    return value || null;
  }

  return null;
}

function isIgnoredLocation(file) {
  return IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix)) || IGNORED_ROOT_FILES.has(file) || IGNORED_FILES.has(file);
}

function isNonPublishedArticle(file, base, head, git) {
  if (!file.startsWith('content/posts/') || !file.endsWith('.md')) return false;

  const oldContent = git.show(base, file);
  const newContent = git.show(head, file);
  if (oldContent === null && newContent === null) return false;

  for (const content of [oldContent, newContent]) {
    if (content === null) continue;
    const status = parseReviewStatus(content);
    if (status === null || status === 'published') return false;
  }

  return true;
}

function withoutReviewedAt(content) {
  const match = String(content || '').match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) return null;
  const nl = match[1].includes('\r\n') ? '\r\n' : '\n';
  const frontmatter = match[2].split(/\r?\n/).filter(line => !/^\s*reviewed_at\s*:/.test(line)).join(nl);
  return match[1] + frontmatter + match[3] + match[4];
}

function isOnlyReviewedAtChange(file, base, head, git) {
  if (!file.startsWith('content/posts/') || !file.endsWith('.md')) return false;
  const oldContent = git.show(base, file);
  const newContent = git.show(head, file);
  if (oldContent === null || newContent === null) return false;
  if (parseReviewStatus(oldContent) !== 'published' || parseReviewStatus(newContent) !== 'published') return false;
  const withoutOldReviewedAt = withoutReviewedAt(oldContent);
  const withoutNewReviewedAt = withoutReviewedAt(newContent);
  return withoutOldReviewedAt !== null && withoutOldReviewedAt === withoutNewReviewedAt;
}

function decide({ env, git }) {
  const commitRef = env.COMMIT_REF;
  const cachedCommitRef = env.CACHED_COMMIT_REF;

  if (!commitRef || !cachedCommitRef) {
    return result(false, '比較対象のコミットが無い');
  }

  if (commitRef === cachedCommitRef) {
    return result(false, 'キャッシュ無し・手動デプロイ・初回のため常にビルド');
  }

  if (env.INCOMING_HOOK_URL || env.INCOMING_HOOK_TITLE) {
    return result(false, 'ビルドフック経由');
  }

  if (!SUPPORTED_CONTEXTS.has(env.CONTEXT)) {
    return result(false, '想定外の文脈');
  }

  const branch = env.HEAD || env.BRANCH || '';
  if ((env.CONTEXT === 'deploy-preview' || env.CONTEXT === 'branch-deploy') && branch.startsWith('draft/')) {
    return result(true, '下書きブランチの試しビルドは使われない');
  }

  if (!git.hasCommit(cachedCommitRef) && !git.fetchCommit(cachedCommitRef)) {
    return result(false, '比較対象のコミットを取得できない');
  }

  let changedFiles;
  try {
    changedFiles = git.changedFiles(cachedCommitRef, commitRef);
  } catch (_) {
    return result(false, '差分の取得に失敗');
  }

  if (changedFiles.length === 0) {
    return result(true, '変更なし（Netlify 標準と同じ）');
  }

  const affectingFiles = [];
  for (const file of changedFiles) {
    if (isIgnoredLocation(file)) continue;
    if (isNonPublishedArticle(file, cachedCommitRef, commitRef, git)) continue;
    if (isOnlyReviewedAtChange(file, cachedCommitRef, commitRef, git)) continue;
    affectingFiles.push(file);
  }

  if (affectingFiles.length === 0) {
    const examples = changedFiles.slice(0, 3).join('、');
    return result(true, `変更はすべて表示に影響しない（${changedFiles.length}件、代表例: ${examples}）`);
  }

  return result(false, `表示に影響する変更あり（${affectingFiles.slice(0, 3).join('、')}）`);
}

module.exports = { decide };
