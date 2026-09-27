'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const DEFAULT_POSTS_DIR = path.join(__dirname, '..', '..', 'content', 'posts');

function normalizeReplacementSlugs(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(slug => String(slug || '').trim()).filter(Boolean))];
}

function formatReplacementFrontmatter(replaces) {
  const slugs = normalizeReplacementSlugs(replaces);
  return slugs.length > 0 ? `\nreplaces: "${slugs.join(',')}"` : '';
}

function readReplacementOutlines(replaces, postsDir = DEFAULT_POSTS_DIR) {
  const wanted = new Set(normalizeReplacementSlugs(replaces));
  if (wanted.size === 0) return [];

  let files;
  try {
    files = fs.readdirSync(postsDir).filter(file => file.endsWith('.md'));
  } catch (_) {
    return [];
  }

  const found = new Map();
  for (const file of files) {
    try {
      const parsed = matter(fs.readFileSync(path.join(postsDir, file), 'utf8'));
      const slug = String(parsed.data.slug || '').trim();
      if (!wanted.has(slug) || found.has(slug)) continue;
      const headings = parsed.content
        .split(/\r?\n/)
        .filter(line => /^##\s+/.test(line))
        .map(line => line.replace(/^##\s+/, '').trim())
        .filter(Boolean);
      found.set(slug, {
        slug,
        title: String(parsed.data.title || '').trim(),
        headings,
      });
    } catch (_) {
      // 読めない記事は生成を止めず、指示どおり黙って飛ばす。
    }
  }

  return normalizeReplacementSlugs(replaces).map(slug => found.get(slug)).filter(Boolean);
}

function buildReplacementOutlineBlock(topic, postsDir = DEFAULT_POSTS_DIR) {
  const outlines = readReplacementOutlines(topic && topic.replaces, postsDir);
  if (outlines.length === 0) return '';

  const items = outlines.map(outline => {
    const headings = outline.headings.length > 0
      ? outline.headings.map(heading => `  - H2: ${heading}`).join('\n')
      : '  - H2: （見出しなし）';
    return `- ${outline.title || outline.slug}（${outline.slug}）\n${headings}`;
  }).join('\n');

  return `\n\n═══ 置き換える既存記事 ═══
ここで扱っている論点は漏れなく含めること。記事本文そのものはコピーせず、タイトルと見出しを構成の確認にだけ使うこと。
${items}`;
}

module.exports = {
  DEFAULT_POSTS_DIR,
  normalizeReplacementSlugs,
  formatReplacementFrontmatter,
  readReplacementOutlines,
  buildReplacementOutlineBlock,
};
