'use strict';

const { CATEGORIES, MACROS } = require('./blog-taxonomy');
const { TOOL_DEFINITIONS } = require('./publish-prep');

const BASE_URL = 'https://mori-zeirishi.net';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function datePart(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function urlEntry(pathname, lastmod) {
  const lines = ['  <url>', `    <loc>${escapeXml(`${BASE_URL}${pathname}`)}</loc>`];
  if (lastmod) lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
  lines.push('  </url>');
  return lines.join('\n');
}

// 業種ページの所属は、ビルド側が付けた _hubMacro（ペルソナ由来）を優先する。
// frontmatter の macro が空の記事もハブに載るようにするため（2026-09-03）。
function hubMacroOfPost(post) {
  return post._hubMacro || post.macro;
}

function generatedTaxonomyPaths(posts) {
  const categories = CATEGORIES
    .filter(category => posts.some(post => post.category === category.ja))
    .map(category => `/blog/category/${category.slug}/`)
    .sort();
  const macros = MACROS
    .filter(macro => posts.some(post => hubMacroOfPost(post) === macro.ja))
    .map(macro => `/blog/macro/${macro.slug}/`)
    .sort();
  // 業種別ガイドの入口（/blog/macro/）は業種ページが1つでもあれば出す
  const hubIndex = macros.length > 0 ? ['/blog/macro/'] : [];
  return [...categories, ...hubIndex, ...macros];
}

// 検索対象にしない静的ページ（404 は netlify.toml が /404.html を指すために生成するだけ）
const EXCLUDED_STATIC_PAGES = new Set(['index.html', '404.html']);

function generateSitemapXml({
  posts = [],
  staticPageFiles = [],
  staticLastmod = {},
  // 2026-09-03 段階2: サブディレクトリ出力（/services/<slug>/ など）に対応するため、
  // ファイル名ではなくURLの一覧でも受ける。指定があればこちらを使う。
  staticPages = null,
  indexLastmod = '',
  publishConfig = {},
  correctionsGenerated = false,
} = {}) {
  const paths = [];

  paths.push({ pathname: '/', lastmod: datePart(indexLastmod || staticLastmod['index.html']) });
  if (Array.isArray(staticPages)) {
    const sorted = staticPages
      .filter(p => p && p.pathname && p.pathname !== '/' && p.pathname !== '/404.html')
      .sort((a, b) => a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0);
    for (const p of sorted) paths.push({ pathname: p.pathname, lastmod: datePart(p.lastmod) });
  } else {
    const staticPaths = staticPageFiles
      .filter(file => file.endsWith('.html') && !EXCLUDED_STATIC_PAGES.has(file))
      .sort();
    for (const file of staticPaths) {
      paths.push({ pathname: `/${file}`, lastmod: datePart(staticLastmod[file]) });
    }
  }

  paths.push({ pathname: '/blog/' });
  for (const pathname of generatedTaxonomyPaths(posts)) paths.push({ pathname });

  const articleEntries = posts
    .filter(post => post.slug)
    .map(post => ({
      pathname: `/blog/${post.slug}/`,
      lastmod: datePart(post.updated_at || post.publish_at),
    }))
    .sort((a, b) => a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0);
  paths.push(...articleEntries);

  const toolEntries = Object.entries(TOOL_DEFINITIONS)
    .filter(([type]) => publishConfig[type] &&
      publishConfig[type].enabled === true && publishConfig[type].indexable === true)
    .map(([type, tool]) => ({
      pathname: `/tools/${tool.slug}/`,
      lastmod: datePart(publishConfig[type].lastContentUpdateOn),
    }))
    .sort((a, b) => a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0);
  paths.push(...toolEntries);

  if (correctionsGenerated) paths.push({ pathname: '/tools/corrections/' });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map(({ pathname, lastmod }) => urlEntry(pathname, lastmod)),
    '</urlset>',
    '',
  ].join('\n');
}

function generateRobotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    `Sitemap: ${BASE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

module.exports = Object.freeze({
  BASE_URL,
  EXCLUDED_STATIC_PAGES,
  escapeXml,
  generateRobotsTxt,
  generateSitemapXml,
});
