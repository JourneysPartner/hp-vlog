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

function generatedTaxonomyPaths(posts) {
  const categories = CATEGORIES
    .filter(category => posts.some(post => post.category === category.ja))
    .map(category => `/blog/category/${category.slug}/`)
    .sort();
  const macros = MACROS
    .filter(macro => posts.some(post => post.macro === macro.ja))
    .map(macro => `/blog/macro/${macro.slug}/`)
    .sort();
  return [...categories, ...macros];
}

function generateSitemapXml({
  posts = [],
  staticPageFiles = [],
  publishConfig = {},
  correctionsGenerated = false,
} = {}) {
  const paths = [];

  paths.push({ pathname: '/' });
  const staticPaths = staticPageFiles
    .filter(file => file.endsWith('.html') && file !== 'index.html')
    .map(file => `/${file}`)
    .sort();
  for (const pathname of staticPaths) paths.push({ pathname });

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
  escapeXml,
  generateRobotsTxt,
  generateSitemapXml,
});
