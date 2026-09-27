'use strict';

const fs = require('fs');

const warnedDictionaries = new Set();
const warnedTargets = new Set();

function bump(stats, reason) {
  stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
}

function pushRange(ranges, start, end) {
  if (end > start) ranges.push([start, end]);
}

function protectedRanges(markdown) {
  const ranges = [];
  const text = String(markdown || '');
  let offset = 0;
  let inFrontmatter = false;
  let inFence = false;
  let fenceMarker = '';
  const lines = text.split(/(?<=\n)/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineBody = line.replace(/[\r\n]+$/, '');
    const trimmed = lineBody.trimStart();

    if (index === 0 && lineBody.trim() === '---') {
      inFrontmatter = true;
      pushRange(ranges, offset, offset + line.length);
      offset += line.length;
      continue;
    }
    if (inFrontmatter) {
      pushRange(ranges, offset, offset + line.length);
      if (lineBody.trim() === '---') inFrontmatter = false;
      offset += line.length;
      continue;
    }

    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      pushRange(ranges, offset, offset + line.length);
      offset += line.length;
      continue;
    }
    if (inFence || /^#{1,6}(?:\s|$)/.test(trimmed) || /^\|/.test(trimmed)) {
      pushRange(ranges, offset, offset + line.length);
    }
    offset += line.length;
  }

  const inlinePatterns = [
    /!?\[[^\]]*\]\([^\n)]*\)/g,
    /`+[^\n]*?`+/g,
    /<[^>]*>/g,
  ];
  for (const pattern of inlinePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      pushRange(ranges, match.index, match.index + match[0].length);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isProtected(position, ranges) {
  return ranges.some(([start, end]) => position >= start && position < end);
}

function firstLinkableIndex(markdown, term) {
  const ranges = protectedRanges(markdown);
  let from = 0;
  for (;;) {
    const index = markdown.indexOf(term, from);
    if (index === -1) return -1;
    if (!isProtected(index, ranges)) return index;
    from = index + term.length;
  }
}

function linkTerms(markdown, {
  terms = [],
  post = {},
  postsMap = new Map(),
  isPublished = () => false,
  hubMacroOf = () => '',
  coreSlugs = new Set(),
} = {}) {
  const stats = { linked: 0, skipped: {} };
  let output = typeof markdown === 'string' ? markdown : '';
  if (!Array.isArray(terms) || terms.length === 0 || !output) return { markdown: output, stats };

  const ownMacro = hubMacroOf(post);
  const sorted = terms
    .map((entry, index) => ({ ...entry, _index: index }))
    .sort((a, b) => String(b.term || '').length - String(a.term || '').length || a._index - b._index);

  for (const entry of sorted) {
    if (stats.linked >= 4) {
      bump(stats, 'limit');
      continue;
    }
    const term = String(entry.term || '');
    const slug = String(entry.slug || '');
    if (!term || !slug) {
      bump(stats, 'invalid');
      continue;
    }
    if (entry.enabled === false) {
      bump(stats, 'disabled');
      continue;
    }
    const macros = Array.isArray(entry.macros) ? entry.macros : [];
    if (!macros.includes('*') && !macros.includes(ownMacro)) {
      bump(stats, 'macro');
      continue;
    }
    if (slug === post.slug) {
      bump(stats, 'self');
      continue;
    }
    if (String(post.title || '').includes(term)) {
      bump(stats, 'ownTitle');
      continue;
    }
    if (coreSlugs instanceof Set && coreSlugs.has(slug)) {
      bump(stats, 'pickup');
      continue;
    }

    const target = postsMap instanceof Map ? postsMap.get(slug) : null;
    if (!target || !isPublished(target)) {
      bump(stats, 'unpublished');
      if (!warnedTargets.has(slug)) {
        warnedTargets.add(slug);
        console.warn(`[build] 文脈リンク先が存在しないか未公開のためスキップ: ${slug}`);
      }
      continue;
    }

    const index = firstLinkableIndex(output, term);
    if (index === -1) {
      bump(stats, 'notFound');
      continue;
    }
    const link = `[${term}](/blog/${slug}/)`;
    output = output.slice(0, index) + link + output.slice(index + term.length);
    stats.linked++;
  }
  return { markdown: output, stats };
}

function readInternalLinkTerms(filePath, logger = console) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.terms) || parsed.terms.length === 0) {
      throw new Error('terms が空か配列ではありません');
    }
    return parsed.terms;
  } catch (error) {
    if (!warnedDictionaries.has(filePath)) {
      warnedDictionaries.add(filePath);
      logger.warn(`[build] 文脈リンク辞書を使えないため 0 件で続行: ${error.message}`);
    }
    return [];
  }
}

module.exports = Object.freeze({ linkTerms, readInternalLinkTerms, protectedRanges });
