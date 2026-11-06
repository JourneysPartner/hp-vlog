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

function protectedRanges(markdown, { protectLead = false } = {}) {
  const ranges = [];
  const text = String(markdown || '');
  let offset = 0;
  let inFrontmatter = false;
  let inFence = false;
  let fenceMarker = '';
  let firstHeading = text.length;
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
    if (!inFence && /^## /.test(lineBody) && firstHeading === text.length) firstHeading = offset;
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
  if (protectLead) pushRange(ranges, 0, firstHeading);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isProtected(position, ranges, length = 1) {
  return ranges.some(([start, end]) => position < end && position + length > start);
}

// protectedRanges の既定動作を変えず、内部リンクだけリード文を守る。
function internalLinkRanges(markdown) {
  return protectedRanges(markdown, { protectLead: true });
}

function firstLinkableIndex(markdown, term, occurrence = 1) {
  if (!term) return -1;
  const ranges = internalLinkRanges(markdown);
  let from = 0;
  let count = 0;
  for (;;) {
    const index = markdown.indexOf(term, from);
    if (index === -1) return -1;
    if (!isProtected(index, ranges, term.length) && ++count === occurrence) return index;
    from = index + term.length;
  }
}

function blogLinkTargets(markdown) {
  const targets = new Set();
  let inFrontmatter = false;
  let fenceMarker = '';
  const text = String(markdown || '').split(/(?<=\n)/).map((line, index) => {
    if (index === 0 && line.trim() === '---') { inFrontmatter = true; return ''; }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      return '';
    }
    const fence = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[1][0];
      else if (fenceMarker === fence[1][0]) fenceMarker = '';
      return '';
    }
    return fenceMarker ? '' : line;
  }).join('').replace(/`+[^\n]*?`+/g, '');
  const links = /(?<!!)\[[^\]\n]*\]\(([^\n)]*)\)|<[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  for (const match of text.matchAll(links)) {
    const slug = (match[1] || match[2] || match[3] || match[4] || '').match(/\/blog\/([^/\s?#]+)\//);
    if (slug) targets.add(slug[1]);
  }
  return targets;
}

function linkTerms(markdown, {
  terms = [],
  post = {},
  postsMap = new Map(),
  isPublished = () => false,
  hubMacroOf = () => '',
  coreSlugs = new Set(),
  maxLinks = 4,
} = {}) {
  const stats = { linked: 0, skipped: {}, linkedTargets: new Set() };
  let output = typeof markdown === 'string' ? markdown : '';
  const usedTargets = blogLinkTargets(output);
  if (!Array.isArray(terms) || terms.length === 0 || !output) return { markdown: output, stats };

  const ownMacro = hubMacroOf(post);
  const sorted = terms
    .map((entry, index) => ({ ...entry, _index: index }))
    .sort((a, b) => String(b.term || '').length - String(a.term || '').length || a._index - b._index);

  for (const entry of sorted) {
    if (stats.linked >= Math.min(4, maxLinks)) {
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

    if (usedTargets.has(slug)) {
      bump(stats, 'duplicateTarget');
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
    stats.linkedTargets.add(slug);
    usedTargets.add(slug);
  }
  return { markdown: output, stats };
}

function linkPlacements(markdown, {
  placements = [], post = {}, postsMap = new Map(), isPublished = () => false,
  logger = console,
} = {}) {
  let output = typeof markdown === 'string' ? markdown : '';
  const stats = { linked: 0, skipped: {}, linkedTargets: new Set(), linkedIds: new Set() };
  const usedTargets = blogLinkTargets(output);
  for (const entry of Array.isArray(placements) ? placements : []) {
    if (!entry || entry.source !== post.slug || entry.enabled === false) continue;
    if (entry.target === post.slug) { bump(stats, 'self'); continue; }
    const target = postsMap.get(entry.target);
    if (!target || !isPublished(target)) {
      bump(stats, 'unpublished');
      logger.warn(`[build] 指定リンク先が存在しないか未公開: ${post.slug} (${entry.id}) → ${entry.target}`);
      continue;
    }
    if (stats.linked >= 3) { bump(stats, 'limit'); continue; }
    if (usedTargets.has(entry.target)) { bump(stats, 'duplicateTarget'); continue; }
    const index = firstLinkableIndex(output, entry.anchor, entry.occurrence === undefined ? 1 : entry.occurrence);
    if (index === -1) {
      bump(stats, 'notFound');
      logger.warn(`[build] 指定リンクの言い回しが見つかりません: ${post.slug} (${entry.id})`);
      continue;
    }
    output = output.slice(0, index) + `[${entry.anchor}](/blog/${entry.target}/)` + output.slice(index + entry.anchor.length);
    stats.linked++;
    stats.linkedTargets.add(entry.target);
    stats.linkedIds.add(entry.id);
    usedTargets.add(entry.target);
  }
  return { markdown: output, stats };
}

function linkInternal(markdown, options = {}) {
  const placed = linkPlacements(markdown, options);
  const terms = linkTerms(placed.markdown, { ...options, maxLinks: Math.min(4, 5 - placed.stats.linked) });
  return {
    markdown: terms.markdown,
    stats: {
      linked: placed.stats.linked + terms.stats.linked,
      placements: placed.stats,
      terms: terms.stats,
      linkedTargets: new Set([...placed.stats.linkedTargets, ...terms.stats.linkedTargets]),
    },
  };
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function validatePlacements(config, { postsMap, isPublished = () => false } = {}) {
  const errors = [];
  const warnings = [];
  if (!config || !Array.isArray(config.placements)) {
    return { errors: ['placements は配列である必要があります'], warnings };
  }
  const ids = new Set();
  const sources = new Map();
  for (const [index, entry] of config.placements.entries()) {
    const label = `指定リンク ${entry && entry.id || index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: 行はオブジェクトである必要があります`);
      continue;
    }
    const before = errors.length;
    for (const key of ['id', 'source', 'anchor', 'target', 'added_at']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) errors.push(`${label}: 必須項目が未設定か文字列ではありません: ${key}`);
    }
    if (ids.has(entry.id)) errors.push(`${label}: id が重複しています`);
    ids.add(entry.id);
    if (entry.source === entry.target) errors.push(`${label}: source と target が同じです`);
    if (typeof entry.anchor === 'string' && Array.from(entry.anchor).length > 40) errors.push(`${label}: anchor は40字以内です`);
    if (entry.occurrence !== undefined && (!Number.isInteger(entry.occurrence) || entry.occurrence < 1)) errors.push(`${label}: occurrence は1以上の整数です`);
    if (!validDate(entry.added_at)) errors.push(`${label}: added_at は YYYY-MM-DD の日付です`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') errors.push(`${label}: enabled は真偽値です`);
    if (entry.enabled !== false) {
      const targets = sources.get(entry.source) || [];
      if (targets.includes(entry.target)) errors.push(`${label}: 同じ source の target が重複しています`);
      targets.push(entry.target);
      sources.set(entry.source, targets);
      if (targets.length === 4) errors.push(`${label}: 同じ source の enabled は最大3行です`);
    }
    if (!(postsMap instanceof Map)) continue;
    for (const key of ['source', 'target']) {
      const post = postsMap.get(entry[key]);
      if (!post) errors.push(`${label}: ${key} の記事が存在しません: ${entry[key]}`);
      else if (!isPublished(post)) warnings.push(`${label}: ${key} が未公開・統合済み・取り下げです: ${entry[key]}`);
    }
    const source = postsMap.get(entry.source);
    if (errors.length === before && source) {
      const { normalizeBold } = require('./cjk-bold');
      if (firstLinkableIndex(normalizeBold(source._body || ''), entry.anchor, entry.occurrence === undefined ? 1 : entry.occurrence) === -1) {
        warnings.push(`${label}: ${entry.source} のリンクできる場所に anchor が見つかりません`);
      }
    }
  }
  return { errors, warnings };
}

function readInternalLinkPlacements(filePath, logger = console) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { errors } = validatePlacements(parsed);
    if (errors.length) throw new Error(errors.join(' / '));
    return parsed.placements;
  } catch (error) {
    if (!warnedDictionaries.has(filePath)) {
      warnedDictionaries.add(filePath);
      logger.warn(`[build] 指定リンクを使えないため 0 件で続行: ${error.message}`);
    }
    return [];
  }
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

module.exports = Object.freeze({
  linkTerms, linkPlacements, linkInternal, readInternalLinkTerms, readInternalLinkPlacements,
  protectedRanges, firstLinkableIndex, blogLinkTargets, validatePlacements,
});
