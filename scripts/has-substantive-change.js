'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TIMESTAMP_KEY_RE = /^(?:.*_at|last_crawl_duration_seconds)$/;
const MAX_BUFFER = 100 * 1024 * 1024;

function stripTimestamps(value, removedKeys) {
  if (Array.isArray(value)) {
    return value.map(item => stripTimestamps(item, removedKeys));
  }
  if (value === null || typeof value !== 'object') return value;

  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (TIMESTAMP_KEY_RE.test(key)) {
      if (removedKeys) removedKeys.add(key);
      continue;
    }
    copy[key] = stripTimestamps(child, removedKeys);
  }
  return copy;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== 'object') return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortObjectKeys(value[key]);
  }
  return sorted;
}

function isSameContent(before, after) {
  const normalizedBefore = sortObjectKeys(stripTimestamps(before));
  const normalizedAfter = sortObjectKeys(stripTimestamps(after));
  return JSON.stringify(normalizedBefore) === JSON.stringify(normalizedAfter);
}

function runGit(args, cwd, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.toString('utf8').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function nulSeparated(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function toGitPath(repoRoot, inputPath) {
  const absolute = path.resolve(repoRoot, inputPath);
  const relative = path.relative(repoRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside the repository: ${inputPath}`);
  }
  return relative.split(path.sep).join('/');
}

function listChangedFiles(repoRoot, pathspecs) {
  const diff = runGit(
    ['diff', '--name-only', '-z', 'HEAD', '--', ...pathspecs],
    repoRoot,
  );
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs],
    repoRoot,
  );
  return [...new Set([...nulSeparated(diff.stdout), ...nulSeparated(untracked.stdout)])].sort();
}

function readHeadFile(repoRoot, gitPath) {
  const result = runGit(['show', `HEAD:${gitPath}`], repoRoot, true);
  return result.status === 0 ? result.stdout : null;
}

function describeRemovedKeys(keys) {
  const names = [...keys].sort();
  return names.length > 0 ? names.join(', ') : 'JSON の表記';
}

function hasSubstantiveChange(repoRoot, inputPaths) {
  const pathspecs = inputPaths.map(inputPath => toGitPath(repoRoot, inputPath));
  const changedFiles = listChangedFiles(repoRoot, pathspecs);
  let changed = false;

  for (const gitPath of changedFiles) {
    const beforeBuffer = readHeadFile(repoRoot, gitPath);
    const worktreePath = path.join(repoRoot, ...gitPath.split('/'));

    if (beforeBuffer === null) {
      console.error(`[change] ${gitPath}  追跡外の新規ファイル`);
      changed = true;
      continue;
    }
    if (!fs.existsSync(worktreePath)) {
      console.error(`[change] ${gitPath}  ファイルが削除された`);
      changed = true;
      continue;
    }
    if (path.extname(gitPath).toLowerCase() !== '.json') {
      console.error(`[change] ${gitPath}  JSON 以外のファイルに差分`);
      changed = true;
      continue;
    }

    let before;
    let after;
    try {
      before = JSON.parse(beforeBuffer.toString('utf8'));
      after = JSON.parse(fs.readFileSync(worktreePath, 'utf8'));
    } catch (error) {
      console.error(`[change] ${gitPath}  JSON として読めないため変更扱い（${error.message}）`);
      changed = true;
      continue;
    }

    if (!isSameContent(before, after)) {
      console.error(`[change] ${gitPath}  中身に差分`);
      changed = true;
      continue;
    }

    const removedKeys = new Set();
    stripTimestamps(before, removedKeys);
    stripTimestamps(after, removedKeys);
    console.error(`[skip]   ${gitPath}  時刻のみ（${describeRemovedKeys(removedKeys)}）`);
  }

  if (!changed) {
    console.error('■ 変更なし（時刻のみ更新のため PR は作成しません）');
  }
  return changed;
}

function main(argv) {
  try {
    if (argv.length === 0) throw new Error('比較するパスを1つ以上指定してください');
    const rootResult = runGit(['rev-parse', '--show-toplevel'], process.cwd());
    const repoRoot = rootResult.stdout.toString('utf8').trim();
    const changed = hasSubstantiveChange(repoRoot, argv);
    process.stdout.write(`changed=${changed}\n`);
  } catch (error) {
    console.error(`[change] 判定に失敗したため変更扱い: ${error.message}`);
    process.stdout.write('changed=true\n');
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  TIMESTAMP_KEY_RE,
  stripTimestamps,
  isSameContent,
};
