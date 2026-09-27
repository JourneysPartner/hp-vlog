'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { resolveTaxDomain } = require('./cluster-taxonomy');

const SITE_ORIGIN = 'https://mori-zeirishi.net';
const SIGNAL_WEIGHTS = Object.freeze({
  source_updated: 3,
  tax_reform: 2,
  fiscal_year: 2,
  search_decline: 1,
});
const MAX_CANDIDATES = 30;
const MAX_SOURCE_AGE_DAYS = 62;
const MAX_REFORM_AGE_DAYS = 62;
const MAX_SEARCH_AGE_DAYS = 14;

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysOld(value, now) {
  const date = validDate(value);
  if (!date) return Infinity;
  return (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000);
}

function isRecent(value, now, maxDays) {
  const age = daysOld(value, now);
  return age >= -2 && age <= maxDays;
}

function japanDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const get = type => Number((parts.find(part => part.type === type) || {}).value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function currentTaxYear(now, calendar) {
  if (!calendar || !Array.isArray(calendar.entries)) return null;
  const { year, month } = japanDateParts(now);
  if (!year || !month) return null;
  const filing = calendar.entries.find(entry => entry && entry.id === 'kakutei-shinkoku');
  const filingMonths = filing && Array.isArray(filing.boost_months) ? filing.boost_months : [];
  return filingMonths.includes(month) && month <= 3 ? year - 1 : year;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''), SITE_ORIGIN);
    url.hash = '';
    url.search = '';
    let pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (pathname !== '/' && !pathname.endsWith('/')) pathname += '/';
    return `${url.origin.toLowerCase()}${pathname}`;
  } catch (_) {
    return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/?$/, '/');
  }
}

function articleUrl(slug) {
  return `${SITE_ORIGIN}/blog/${slug}/`;
}

function articleDate(post) {
  for (const value of [post.published_at, post.publish_at, post.updated_at, post.created_at]) {
    const date = validDate(value);
    if (date) return date;
  }
  const match = String(post.file || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? validDate(`${match[1]}T00:00:00+09:00`) : null;
}

function supplementalUrls(meta) {
  const urls = [];
  if (Array.isArray(meta.source_supplements)) {
    for (const source of meta.source_supplements) {
      if (source && source.url) urls.push(source.url);
    }
  }
  for (let index = 2; index <= 20; index++) {
    if (meta[`source_${index}_url`]) urls.push(meta[`source_${index}_url`]);
  }
  return urls;
}

function readPosts(postsDir) {
  if (!fs.existsSync(postsDir)) return [];
  const posts = [];
  for (const file of fs.readdirSync(postsDir).filter(name => name.endsWith('.md')).sort()) {
    try {
      const raw = fs.readFileSync(path.join(postsDir, file), 'utf8');
      const parsed = matter(raw);
      const meta = parsed.data || {};
      if (!meta.slug) continue;
      posts.push({
        ...meta,
        file,
        title: String(meta.title || ''),
        slug: String(meta.slug),
        category: String(meta.category || ''),
        tax_domain: resolveTaxDomain(meta),
        review_status: String(meta.review_status || ''),
        source_urls: [meta.source_url, ...supplementalUrls(meta)].filter(Boolean),
        body: parsed.content || '',
        url: articleUrl(meta.slug),
      });
    } catch (_) {
      // 壊れた記事は候補判定から外し、週次処理自体は継続する。
    }
  }
  return posts;
}

function readNtaEntries(ntaDir, now) {
  if (!fs.existsSync(ntaDir)) return [];
  const meta = safeReadJson(path.join(ntaDir, 'meta.json'));
  const index = safeReadJson(path.join(ntaDir, 'index.json'));
  const entries = index && Array.isArray(index.entries) ? index.entries : [];
  const newestEntryDate = entries.reduce((newest, entry) => {
    const date = validDate(entry.last_checked_at || entry.fetched_at);
    return date && (!newest || date > newest) ? date : newest;
  }, null);
  const datasetDate = meta && (meta.last_crawl_finished_at || meta.last_crawl_started_at);
  if (!isRecent(datasetDate || newestEntryDate, now, MAX_SOURCE_AGE_DAYS)) return [];
  return entries.filter(entry => entry && entry.url && !entry.deleted);
}

function readTaxReform(file, now, taxYear) {
  const outline = safeReadJson(file);
  if (!outline || Number(outline.year) !== Number(taxYear)) return null;
  if (!isRecent(outline.checked_at, now, MAX_REFORM_AGE_DAYS)) return null;
  return outline;
}

function readSearchSnapshots(searchDir, now) {
  if (!fs.existsSync(searchDir)) return [];
  const snapshots = [];
  const dirs = fs.readdirSync(searchDir).filter(name => /^\d{8}$/.test(name)).sort().reverse();
  for (const dir of dirs) {
    const data = safeReadJson(path.join(searchDir, dir, 'pages.json'));
    if (data && Array.isArray(data.rows)) snapshots.unshift({ dir, ...data });
    if (snapshots.length === 4) break;
  }
  if (snapshots.length === 0) return [];
  const latest = snapshots[snapshots.length - 1];
  const latestDate = latest.range && latest.range.end
    ? `${latest.range.end}T23:59:59+09:00`
    : `${latest.dir.slice(0, 4)}-${latest.dir.slice(4, 6)}-${latest.dir.slice(6, 8)}T23:59:59+09:00`;
  return isRecent(latestDate, now, MAX_SEARCH_AGE_DAYS) ? snapshots : [];
}

function readInputs(root, now = new Date()) {
  const calendar = safeReadJson(path.join(root, 'data', 'tax-calendar.json'));
  const taxYear = currentTaxYear(now, calendar);
  return {
    posts: readPosts(path.join(root, 'content', 'posts')),
    sources: readNtaEntries(path.join(root, 'data', 'nta-sources'), now),
    reform: taxYear ? readTaxReform(path.join(root, 'data', 'tax-reform-outline.json'), now, taxYear) : null,
    calendar,
    searchSnapshots: readSearchSnapshots(path.join(root, 'data', 'search-console'), now),
    pickupConfig: safeReadJson(path.join(root, 'data', 'pickup-posts.json')) || {},
  };
}

function formatDate(value) {
  const date = validDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sourceLabel(entry) {
  if (entry.title_full) return entry.title_full;
  if (entry.type === 'taxanswer' && entry.id) return `No.${entry.id}${entry.title ? `「${entry.title}」` : ''}`;
  return entry.title || entry.url;
}

function sourceReason(post, sourceByUrl) {
  const published = articleDate(post);
  if (!published) return null;
  const sourceUrls = Array.isArray(post.source_urls)
    ? post.source_urls
    : [post.source_url, ...supplementalUrls(post)].filter(Boolean);
  const matches = sourceUrls
    .map(url => sourceByUrl.get(normalizeUrl(url)))
    .filter(Boolean)
    .filter(entry => {
      const changed = validDate(entry.fetched_at);
      return changed && changed > published;
    })
    .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at));
  if (!matches.length) return null;
  const entry = matches[0];
  return {
    kind: 'source_updated',
    detail: `${sourceLabel(entry)}が ${formatDate(entry.fetched_at)} に更新`,
    where: '出典欄',
  };
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '');
}

function nearestHeading(body, index) {
  const before = String(body || '').slice(0, Math.max(0, index));
  const headings = [...before.matchAll(/^#{2,6}\s+(.+)$/gm)];
  return headings.length ? headings[headings.length - 1][0].trim() : '本文';
}

function outlineItems(outline) {
  const items = [];
  for (const chapter of Object.values((outline && outline.chapters) || {})) {
    const domains = Array.isArray(chapter.tax_domains) ? chapter.tax_domains : [];
    for (const item of Array.isArray(chapter.items) ? chapter.items : []) {
      if (item && item.title && item.status !== 'not_applicable') {
        items.push({ ...item, domains, chapter: chapter.label || '' });
      }
    }
  }
  return items;
}

function taxReformReason(post, items, outlineYear) {
  const normalizedBody = normalizeText(post.body);
  const taxDomain = resolveTaxDomain(post);
  for (const item of items) {
    if (!item.domains.includes(taxDomain)) continue;
    const needle = normalizeText(item.title);
    if (!needle || !normalizedBody.includes(needle)) continue;
    const rawIndex = post.body.indexOf(item.title);
    return {
      kind: 'tax_reform',
      detail: `${outlineYear}年度税制改正「${item.title}」に一致`,
      where: nearestHeading(post.body, rawIndex >= 0 ? rawIndex : 0),
    };
  }
  return null;
}

function toAsciiDigits(value) {
  return String(value || '').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xFEE0));
}

function fiscalMatches(body) {
  const patterns = [
    {
      regex: /令和\s*([0-9０-９]+)\s*年分/g,
      year: match => Number(toAsciiDigits(match[1])) + 2018,
    },
    {
      regex: /(20[0-9０-９]{2})\s*年分/g,
      year: match => Number(toAsciiDigits(match[1])),
    },
    {
      regex: /(20[0-9０-９]{2})\s*年\s*[0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日\s*(?:以後|以前)/g,
      year: match => Number(toAsciiDigits(match[1])),
    },
  ];
  const matches = [];
  for (const pattern of patterns) {
    for (const match of String(body || '').matchAll(pattern.regex)) {
      matches.push({ text: match[0], index: match.index || 0, year: pattern.year(match) });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

function fiscalYearReason(post, taxYear) {
  if (!taxYear) return null;
  const match = fiscalMatches(post.body).find(item => item.year < taxYear);
  if (!match) return null;
  return {
    kind: 'fiscal_year',
    detail: `「${match.text.replace(/\s+/g, '')}」を含む`,
    where: nearestHeading(post.body, match.index),
  };
}

function rowsByUrl(snapshot) {
  const map = new Map();
  for (const row of (snapshot && snapshot.rows) || []) {
    if (!row || !row.page) continue;
    map.set(normalizeUrl(row.page), Number(row.impressions || 0));
  }
  return map;
}

function searchData(snapshots) {
  const maps = snapshots.map(rowsByUrl);
  const latest = maps.length ? maps[maps.length - 1] : new Map();
  const declines = new Map();
  if (maps.length === 4) {
    const urls = new Set(maps.flatMap(map => [...map.keys()]));
    for (const url of urls) {
      const values = maps.map(map => Number(map.get(url) || 0));
      const baseline = (values[0] + values[1]) / 2;
      if (baseline >= 20 && values[2] <= baseline / 2 && values[3] <= baseline / 2) {
        declines.set(url, { values, baseline });
      }
    }
  }
  return { latest, declines };
}

function searchDeclineReason(post, declines) {
  const decline = declines.get(normalizeUrl(post.url || articleUrl(post.slug)));
  if (!decline) return null;
  return {
    kind: 'search_decline',
    detail: `表示回数が ${decline.values.join(' → ')} と低下`,
    where: '検索結果',
  };
}

function rankMultipliers(posts, latestImpressions, pickupSlugs) {
  const ranked = posts.map(post => ({
    slug: post.slug,
    impressions: Number(latestImpressions.get(normalizeUrl(post.url || articleUrl(post.slug))) || 0),
  })).sort((a, b) => b.impressions - a.impressions || a.slug.localeCompare(b.slug));
  const positive = ranked.filter(item => item.impressions > 0);
  const result = new Map();
  for (let index = 0; index < positive.length; index++) {
    const multiplier = positive.length === 1 ? 2 : 2 - (index / (positive.length - 1));
    result.set(positive[index].slug, Number(multiplier.toFixed(2)));
  }
  for (const post of posts) {
    if (!result.has(post.slug)) result.set(post.slug, 1);
    if (pickupSlugs.has(post.slug)) result.set(post.slug, 2);
  }
  return result;
}

function buildCandidates(inputs, options = {}) {
  const now = options.now || new Date();
  const published = (inputs.posts || []).filter(post => post.review_status === 'published');
  const sourceByUrl = new Map((inputs.sources || []).map(entry => [normalizeUrl(entry.url), entry]));
  const reformItems = outlineItems(inputs.reform);
  const taxYear = currentTaxYear(now, inputs.calendar);
  const search = searchData(inputs.searchSnapshots || []);
  const pickupSlugs = new Set(Array.isArray(inputs.pickupConfig && inputs.pickupConfig.netshop_core)
    ? inputs.pickupConfig.netshop_core : []);
  const multipliers = rankMultipliers(published, search.latest, pickupSlugs);

  const candidates = [];
  for (const post of published) {
    const reasons = [
      sourceReason(post, sourceByUrl),
      inputs.reform ? taxReformReason(post, reformItems, inputs.reform.year) : null,
      fiscalYearReason(post, taxYear),
      searchDeclineReason(post, search.declines),
    ].filter(Boolean);
    if (!reasons.length) continue;
    const baseScore = [...new Set(reasons.map(reason => reason.kind))]
      .reduce((sum, kind) => sum + (SIGNAL_WEIGHTS[kind] || 0), 0);
    const multiplier = multipliers.get(post.slug) || 1;
    candidates.push({
      slug: post.slug,
      url: post.url || articleUrl(post.slug),
      title: post.title,
      score: Number((baseScore * multiplier).toFixed(2)),
      impressions28d: Number(search.latest.get(normalizeUrl(post.url || articleUrl(post.slug))) || 0),
      reasons,
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || b.impressions28d - a.impressions28d || a.slug.localeCompare(b.slug))
    .slice(0, options.limit || MAX_CANDIDATES);
}

function buildOutput(inputs, options = {}) {
  const now = options.now || new Date();
  return { generatedAt: now.toISOString(), candidates: buildCandidates(inputs, { ...options, now }) };
}

function reasonText(candidate) {
  return (candidate.reasons || []).map(reason => `${reason.detail}（${reason.where}）`).join('／');
}

function buildFreshnessNotification(candidates, prUrl = '') {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const lines = candidates.slice(0, 5).map((candidate, index) => [
    `${index + 1}. ${candidate.title}（スコア ${candidate.score}、表示 ${candidate.impressions28d} 回）`,
    `   ${candidate.url}`,
    `   理由: ${reasonText(candidate)}`,
  ].join('\n'));
  return {
    event: 'freshness_candidates',
    title: `記事の更新候補 ${candidates.length} 件`,
    summary: lines.join('\n\n'),
    prUrl,
  };
}

module.exports = {
  SITE_ORIGIN,
  SIGNAL_WEIGHTS,
  MAX_CANDIDATES,
  MAX_SOURCE_AGE_DAYS,
  MAX_REFORM_AGE_DAYS,
  MAX_SEARCH_AGE_DAYS,
  safeReadJson,
  currentTaxYear,
  normalizeUrl,
  readPosts,
  readNtaEntries,
  readTaxReform,
  readSearchSnapshots,
  readInputs,
  nearestHeading,
  fiscalMatches,
  fiscalYearReason,
  searchData,
  rankMultipliers,
  buildCandidates,
  buildOutput,
  reasonText,
  buildFreshnessNotification,
};
