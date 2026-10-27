'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { reasonText } = require('./freshness-refresh');
const { writeGithubOutputs } = require('./github-output');

const ROOT = path.join(__dirname, '..', '..');
const CANDIDATES_FILE = path.join(ROOT, 'data', 'freshness', 'candidates.json');

function findRefreshCandidate(data, slug) {
  if (!/^[a-z0-9_-]+$/.test(String(slug || ''))) return { valid: false, reason: 'slug の形式が正しくありません。' };
  const candidate = (data && Array.isArray(data.candidates) ? data.candidates : [])
    .find(item => item && item.slug === slug);
  if (!candidate) return { valid: false, reason: '更新候補に記事がありません。' };
  if (candidate.refreshable !== true) return { valid: false, reason: '更新対象になる理由がありません。' };
  if (!/^[\w-]+\.md$/.test(String(candidate.file || ''))) {
    return { valid: false, reason: '候補ファイル名が正しくありません。' };
  }
  const filepath = path.join(ROOT, 'content', 'posts', candidate.file);
  if (!fs.existsSync(filepath)) return { valid: false, reason: '記事ファイルが見つかりません。' };
  let parsed;
  try {
    parsed = matter(fs.readFileSync(filepath, 'utf8'));
  } catch (_) {
    return { valid: false, reason: '記事の frontmatter を読み取れません。' };
  }
  if (parsed.data.slug !== slug || parsed.data.review_status !== 'published') {
    return { valid: false, reason: 'main の記事が公開中ではありません。' };
  }
  return {
    valid: true,
    candidate,
    filepath,
    expiredTheme: require('./freshness-refresh').isExpiredRefreshTheme(parsed.data),
  };
}

function formatDiff(diff, limit = 600) {
  return (diff || []).map(section => {
    const changedBefore = section.changedParagraphs && section.changedParagraphs.before;
    const changedAfter = section.changedParagraphs && section.changedParagraphs.after;
    const before = Array.isArray(changedBefore)
      ? changedBefore.filter(row => row && row.changed).map(row => String(row.text || '').trim()).filter(Boolean).join('\n\n')
      : String(section.before || '').trim();
    const after = Array.isArray(changedAfter)
      ? changedAfter.filter(row => row && row.changed).map(row => String(row.text || '').trim()).filter(Boolean).join('\n\n')
      : String(section.after || '').trim();
    const header = `### ${section.heading}\n変更前:\n`;
    const middle = '\n変更後:\n';
    const isTruncated = header.length + middle.length + before.length + after.length > limit;
    const suffix = isTruncated ? '…（この節は一部省略）' : '';
    const budget = Math.max(0, limit - header.length - middle.length - suffix.length);
    const beforeBudget = Math.ceil(budget / 2);
    const afterBudget = Math.floor(budget / 2);
    const beforeText = before.length > beforeBudget ? before.slice(0, beforeBudget) + '…' : before;
    const afterText = after.length > afterBudget ? after.slice(0, afterBudget) + '…' : after;
    const formatted = `${header}${beforeText}${middle}${afterText}${suffix}`;
    return formatted.length > limit ? `${formatted.slice(0, Math.max(0, limit - 1))}…` : formatted;
  }).join('\n\n');
}

function buildPullRequestBody({ reasons, diff, reviewUrl, expiredTheme = false }) {
  const sections = formatDiff(diff);
  return [
    '> **このPRはマージしないでください。** 反映はレビュー画面の「更新を反映する」から行います（マージすると記事が下書きの状態で main に入り、サイトから消えます）。',
    '',
    '## 更新理由',
    reasonText(reasons),
    '',
    '## 変更箇所',
    sections || '変更箇所を取得できませんでした。',
    '',
    `## レビュー画面\n${reviewUrl}`,
    '',
    ...(expiredTheme ? ['期限切れのテーマです。更新ではなく公開停止も検討してください', ''] : []),
    '承認すると公開中の記事にすぐ反映されます。公開日は変わらず、更新日が付きます。',
  ].join('\n');
}

function writeOutputs(rows) {
  if (!process.env.GITHUB_OUTPUT) return;
  writeGithubOutputs(process.env.GITHUB_OUTPUT, rows);
}

function prepare(slug) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8')); } catch (_) { /* 読み込みに失敗した場合は候補不正として扱う */ }
  const result = findRefreshCandidate(data, slug);
  if (!result.valid) {
    writeOutputs({ valid: 'false', reason: result.reason });
    return result;
  }
  const reasons = result.candidate.reasons || [];
  const reasonsFile = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), `refresh-reasons-${process.pid}.json`);
  fs.writeFileSync(reasonsFile, JSON.stringify(reasons), 'utf8');
  const title = String(result.candidate.title || result.candidate.slug);
  writeOutputs({
    valid: 'true',
    filename: result.candidate.file,
    title,
    reason: reasonText(reasons),
    expired_theme: result.expiredTheme ? 'true' : 'false',
    reasons_file: reasonsFile,
  });
  return { ...result, reasonsFile };
}

function writePullRequestBody({ reasonsFile, diffFile, reviewUrl, expiredTheme = false, bodyFile }) {
  const reasons = JSON.parse(fs.readFileSync(reasonsFile, 'utf8'));
  const diff = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
  fs.writeFileSync(bodyFile, buildPullRequestBody({ reasons, diff, reviewUrl, expiredTheme }), 'utf8');
}

if (require.main === module) {
  const [, , command] = process.argv;
  if (command === 'prepare') {
    prepare(process.env.SLUG || '');
  } else if (command === 'pr-body') {
    writePullRequestBody({
      reasonsFile: process.env.REASONS_FILE,
      diffFile: process.env.DIFF_FILE,
      reviewUrl: process.env.REVIEW_URL,
      expiredTheme: process.env.EXPIRED_THEME === 'true',
      bodyFile: process.env.BODY_FILE,
    });
  } else {
    console.error('コマンドを指定してください。');
    process.exitCode = 1;
  }
}

module.exports = { findRefreshCandidate, formatDiff, buildPullRequestBody, prepare, writePullRequestBody };
