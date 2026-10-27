'use strict';

/**
 * 公開済みの置き換え記事を、旧記事の統合先として反映する手動ツール。
 * 公開ワークフローからは呼び出さない。
 *
 *   node scripts/apply-replaces.js --slug <new-slug> [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { normalizeReplacementSlugs } = require('./lib/replaces');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PATHS = {
  postsDir: path.join(ROOT, 'content', 'posts'),
  netlifyPath: path.join(ROOT, 'netlify.toml'),
  pickupPath: path.join(ROOT, 'data', 'pickup-posts.json'),
  hubConfigPath: path.join(ROOT, 'data', 'hub-config.json'),
};

class ApplyReplacesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApplyReplacesError';
  }
}

function parseArgs(argv) {
  const options = { dryRun: false };
  const valueOptions = {
    '--slug': 'slug',
    '--posts-dir': 'postsDir',
    '--netlify': 'netlifyPath',
    '--pickup': 'pickupPath',
    '--hub-config': 'hubConfigPath',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const key = valueOptions[arg];
    if (!key) throw new ApplyReplacesError(`未知の引数です: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new ApplyReplacesError(`${arg} の値が必要です`);
    options[key] = value;
  }
  return options;
}

function resolvePaths(options = {}, env = process.env) {
  return {
    postsDir: path.resolve(options.postsDir || env.REPLACES_POSTS_DIR || DEFAULT_PATHS.postsDir),
    netlifyPath: path.resolve(options.netlifyPath || env.REPLACES_NETLIFY_PATH || DEFAULT_PATHS.netlifyPath),
    pickupPath: path.resolve(options.pickupPath || env.REPLACES_PICKUP_PATH || DEFAULT_PATHS.pickupPath),
    hubConfigPath: path.resolve(options.hubConfigPath || env.REPLACES_HUB_CONFIG_PATH || DEFAULT_PATHS.hubConfigPath),
  };
}

function assertSlug(slug, label) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug || '')) {
    throw new ApplyReplacesError(`${label}の slug が不正です: ${slug || '（空）'}`);
  }
}

function findPostBySlug(postsDir, slug) {
  let files;
  try {
    files = fs.readdirSync(postsDir).filter(file => file.endsWith('.md'));
  } catch (error) {
    throw new ApplyReplacesError(`記事ディレクトリを読めません: ${error.message}`);
  }

  const matches = [];
  for (const file of files) {
    const filePath = path.join(postsDir, file);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      const parsed = matter(raw);
      if (String(parsed.data.slug || '').trim() === slug) {
        matches.push({ filePath, raw, data: parsed.data, body: parsed.content });
      }
    } catch (error) {
      throw new ApplyReplacesError(`記事を読めません: ${filePath}: ${error.message}`);
    }
  }

  if (matches.length === 0) throw new ApplyReplacesError(`記事が見つかりません: ${slug}`);
  if (matches.length > 1) throw new ApplyReplacesError(`同じ slug の記事が複数あるため中止: ${slug}`);
  return matches[0];
}

function parseReplaces(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return normalizeReplacementSlugs(list);
}

function markPostMerged(raw, newSlug) {
  const parsed = matter(raw);
  if (parsed.data.review_status === 'merged') return { content: raw, changed: false };

  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new ApplyReplacesError('frontmatter が見つかりません');
  const eol = match[2].includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  const reviewIndex = lines.findIndex(line => /^review_status\s*:/.test(line));
  if (reviewIndex < 0) throw new ApplyReplacesError('review_status が見つかりません');

  lines[reviewIndex] = 'review_status: "merged"';
  const mergedIntoIndex = lines.findIndex(line => /^merged_into\s*:/.test(line));
  if (mergedIntoIndex >= 0) lines[mergedIntoIndex] = `merged_into: "${newSlug}"`;
  else lines.splice(reviewIndex + 1, 0, `merged_into: "${newSlug}"`);

  return {
    content: `${match[1]}${lines.join(eol)}${match[3]}${match[4]}`,
    changed: true,
  };
}

function redirectBlock(oldSlug, newSlug, eol) {
  return [
    '[[redirects]]',
    `  from = "/blog/${oldSlug}/"`,
    `  to = "/blog/${newSlug}/"`,
    '  status = 301',
  ].join(eol);
}

function addRedirects(raw, oldSlugs, newSlug) {
  const existingFrom = new Set(
    [...raw.matchAll(/^\s*from\s*=\s*"([^"]+)"\s*$/gm)].map(match => match[1]),
  );
  const added = oldSlugs.filter(slug => !existingFrom.has(`/blog/${slug}/`));
  if (added.length === 0) return { content: raw, added };

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const blocks = added.map(slug => redirectBlock(slug, newSlug, eol)).join(`${eol}${eol}`);
  const marker = '# 統合した双子記事は、評価を残す本命記事へ恒久転送する。';
  const markerIndex = raw.indexOf(marker);
  let insertAt = -1;

  if (markerIndex >= 0) {
    const nextComment = /^#\s+.+$/gm;
    nextComment.lastIndex = markerIndex + marker.length;
    const match = nextComment.exec(raw);
    insertAt = match ? match.index : raw.length;
  } else {
    insertAt = raw.indexOf('[[redirects]]');
    if (insertAt < 0) insertAt = raw.length;
  }

  const before = raw.slice(0, insertAt);
  const after = raw.slice(insertAt);
  const leading = before.length > 0 && !before.endsWith(eol) ? eol : '';
  const separator = before.endsWith(`${eol}${eol}`) ? '' : eol;
  const trailing = after.length > 0 ? `${eol}${eol}` : eol;
  return {
    content: `${before}${leading}${separator}${blocks}${trailing}${after}`,
    added,
  };
}

function replaceSlugInList(list, oldSlug, newSlug) {
  if (!Array.isArray(list) || !list.includes(oldSlug)) return { list, changed: false };
  const relevantIndexes = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === oldSlug || list[i] === newSlug) relevantIndexes.push(i);
  }
  const firstIndex = Math.min(...relevantIndexes);
  const next = [];
  for (let i = 0; i < list.length; i++) {
    if (i === firstIndex) next.push(newSlug);
    if (list[i] !== oldSlug && list[i] !== newSlug) next.push(list[i]);
  }
  return { list: next, changed: true };
}

function updatePickup(raw, oldSlugs, newSlug) {
  const data = JSON.parse(raw);
  let list = data.netshop_core;
  const replaced = [];
  for (const oldSlug of oldSlugs) {
    const result = replaceSlugInList(list, oldSlug, newSlug);
    if (result.changed) replaced.push(oldSlug);
    list = result.list;
  }
  if (replaced.length === 0) return { content: raw, replaced };
  data.netshop_core = list;
  return { content: `${JSON.stringify(data, null, 2)}\n`, replaced };
}

function updateHubConfig(raw, oldSlugs, newSlug) {
  const data = JSON.parse(raw);
  const replaced = [];
  for (const [hubName, hub] of Object.entries(data)) {
    if (!hub || typeof hub !== 'object' || !Array.isArray(hub.featured)) continue;
    let list = hub.featured;
    for (const oldSlug of oldSlugs) {
      const result = replaceSlugInList(list, oldSlug, newSlug);
      if (result.changed) replaced.push(`${hubName}.featured: ${oldSlug}`);
      list = result.list;
    }
    hub.featured = list;
  }
  if (replaced.length === 0) return { content: raw, replaced };
  return { content: `${JSON.stringify(data, null, 2)}\n`, replaced };
}

function displayPath(filePath) {
  const rel = path.relative(ROOT, filePath);
  return (rel && !rel.startsWith('..') ? rel : filePath).replace(/\\/g, '/');
}

function applyReplaces(options = {}) {
  const slug = String(options.slug || '').trim();
  assertSlug(slug, '新記事');
  const paths = resolvePaths(options, options.env || process.env);
  const newPost = findPostBySlug(paths.postsDir, slug);
  if (newPost.data.review_status !== 'published') {
    throw new ApplyReplacesError(`未公開のため中止: ${slug} (review_status=${newPost.data.review_status || '未設定'})`);
  }

  const oldSlugs = parseReplaces(newPost.data.replaces);
  for (const oldSlug of oldSlugs) assertSlug(oldSlug, '置き換え対象');

  const writes = new Map();
  const details = new Map();
  const addDetail = (filePath, detail) => {
    if (!details.has(filePath)) details.set(filePath, []);
    details.get(filePath).push(detail);
  };

  for (const oldSlug of oldSlugs) {
    const oldPost = findPostBySlug(paths.postsDir, oldSlug);
    const merged = markPostMerged(oldPost.raw, slug);
    if (merged.changed) {
      writes.set(oldPost.filePath, merged.content);
      addDetail(oldPost.filePath, `review_status="merged", merged_into="${slug}"`);
    }
  }

  let netlifyRaw;
  let pickupRaw;
  let hubRaw;
  try {
    netlifyRaw = fs.readFileSync(paths.netlifyPath, 'utf8');
    pickupRaw = fs.readFileSync(paths.pickupPath, 'utf8');
    hubRaw = fs.readFileSync(paths.hubConfigPath, 'utf8');
  } catch (error) {
    throw new ApplyReplacesError(`設定ファイルを読めません: ${error.message}`);
  }

  const redirects = addRedirects(netlifyRaw, oldSlugs, slug);
  if (redirects.added.length > 0) {
    writes.set(paths.netlifyPath, redirects.content);
    for (const oldSlug of redirects.added) {
      addDetail(paths.netlifyPath, `/blog/${oldSlug}/ → /blog/${slug}/ (301) を追加`);
    }
  }

  let pickup;
  let hubs;
  try {
    pickup = updatePickup(pickupRaw, oldSlugs, slug);
    hubs = updateHubConfig(hubRaw, oldSlugs, slug);
  } catch (error) {
    throw new ApplyReplacesError(`JSON 設定を読めません: ${error.message}`);
  }
  if (pickup.replaced.length > 0) {
    writes.set(paths.pickupPath, pickup.content);
    for (const oldSlug of pickup.replaced) addDetail(paths.pickupPath, `netshop_core: ${oldSlug} → ${slug}`);
  }
  if (hubs.replaced.length > 0) {
    writes.set(paths.hubConfigPath, hubs.content);
    for (const item of hubs.replaced) addDetail(paths.hubConfigPath, `${item} → ${slug}`);
  }

  if (!options.dryRun) {
    for (const [filePath, content] of writes) fs.writeFileSync(filePath, content, 'utf8');
  }

  const lines = [
    `[apply-replaces] ${options.dryRun ? '--dry-run（書き込みなし）' : '反映完了'}: ${slug}`,
    '変更したファイルと内容:',
  ];
  if (details.size === 0) lines.push('- 変更なし');
  for (const [filePath, fileDetails] of details) {
    lines.push(`- ${displayPath(filePath)}`);
    for (const detail of fileDetails) lines.push(`  - ${detail}`);
  }
  return { changedFiles: [...writes.keys()], lines, oldSlugs, dryRun: !!options.dryRun };
}

function main(argv = process.argv.slice(2), runtime = {}) {
  const log = runtime.log || console.log;
  const error = runtime.error || console.error;
  try {
    const options = parseArgs(argv);
    const result = applyReplaces(options);
    for (const line of result.lines) log(line);
    return 0;
  } catch (err) {
    error(`[apply-replaces] ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ApplyReplacesError,
  DEFAULT_PATHS,
  parseArgs,
  resolvePaths,
  findPostBySlug,
  parseReplaces,
  markPostMerged,
  addRedirects,
  replaceSlugInList,
  updatePickup,
  updateHubConfig,
  applyReplaces,
  main,
};
