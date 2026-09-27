'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const {
  main: buildSite,
  buildStaticPages,
  resolvePickupContext,
  renderPickupPostsHtml,
  buildPickupBoxHtml,
  buildRelatedArticleHtml,
} = require('../../build');
const { assignHubMacro } = require('../hub-membership');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pickupConfig = JSON.parse(read(path.join('data', 'pickup-posts.json')));

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function quietly(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function loadPublishedPosts() {
  const now = new Date();
  const posts = fs.readdirSync(POSTS_DIR)
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => {
      const { data, content } = matter(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
      return { ...data, _body: content, _file: file };
    })
    .filter(post => post.review_status === 'published' && post.publish_at && new Date(post.publish_at) <= now)
    .sort((a, b) => new Date(b.publish_at) - new Date(a.publish_at));
  assignHubMacro(posts);
  return posts;
}

function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

function pickupBoxOf(html) {
  const match = html.match(/<aside class="blog-related-article blog-pickup-box"[\s\S]*?<\/aside>/);
  return match ? match[0] : '';
}

function hrefsOf(html) {
  return [...String(html).matchAll(/href="([^"]+)"/g)].map(match => match[1]);
}

const sitemapBefore = sitemapUrls(read('sitemap.xml'));
const posts = loadPublishedPosts();
const bySlug = new Map(posts.map(post => [post.slug, post]));
const context = resolvePickupContext(posts, pickupConfig);
const postsMap = new Map(posts.map(post => [post.slug, post]));

console.log('=== 0. ビルド ===');
let buildOk = true;
try {
  quietly(buildSite);
} catch (error) {
  buildOk = false;
  console.log(String(error.message).slice(0, 800));
}
assert(buildOk, 'pickup 設定を使ってサイトをビルドできる');

console.log('\n=== 1. 設定と公開状態 ===');
assert(context.corePosts.length === 5, '中核 5 本がすべて公開中');
for (const slug of pickupConfig.netshop_core) {
  assert(Boolean(bySlug.get(slug)), `${slug}: 公開中の記事が存在する`);
}
for (const slug of pickupConfig.netshop_services) {
  assert(fs.existsSync(path.join(ROOT, 'services', slug, 'index.html')), `${slug}: サービスページが生成される`);
}
const warnings = [];
const missingContext = resolvePickupContext(posts, {
  netshop_core: [pickupConfig.netshop_core[0], 'not-published-or-missing'],
  netshop_services: ['not-defined'],
}, { warn: message => warnings.push(message) });
assert(missingContext.corePosts.length === 1 && warnings.length === 2, '不存在・未公開の記事と未定義サービスは警告してスキップする');

console.log('\n=== 2. トップページ ===');
const topHtml = read('index.html');
const topPickup = (topHtml.match(/<section class="section-py bg-white" data-pickup-posts>[\s\S]*?<\/section>/) || [''])[0];
assert(Boolean(topPickup), 'トップに「まず読む」枠がある');
let lastPosition = -1;
for (const slug of pickupConfig.netshop_core) {
  const position = topPickup.indexOf(`/blog/${slug}/`);
  assert(position > lastPosition, `${slug}: 設定順でトップに出る`);
  lastPosition = position;
}
for (const slug of pickupConfig.netshop_services) {
  assert(topPickup.includes(`/services/${slug}/`), `${slug}: トップのサービスボタンがある`);
}

console.log('\n=== 3. 記事内の案内枠 ===');
const retailSlug = 'ebay-growth-platform-fee-treatment-guide';
const retailHtml = read(path.join('blog', retailSlug, 'index.html'));
const retailBox = pickupBoxOf(retailHtml);
assert(Boolean(retailBox), '物販記事に案内枠がある');
assert(!retailBox.includes(`/blog/${retailSlug}/`), '物販記事の案内枠に自分自身へのリンクがない');
assert(hrefsOf(retailBox).filter(href => href.startsWith('/blog/')).length <= 4, '中核記事リンクは最大 4 本');
assert(retailBox.includes('/services/ebay-export/'), 'eBay セラーには eBay 輸出サービスを案内する');

const inheritanceSlug = 'inheritance-tax-basic-deduction-guide';
const inheritanceHtml = read(path.join('blog', inheritanceSlug, 'index.html'));
assert(!inheritanceHtml.includes('data-pickup-box'), '相続記事には案内枠がない');
const emptyContext = resolvePickupContext(posts, { netshop_core: [], netshop_services: [] });
const inheritancePost = bySlug.get(inheritanceSlug);
assert(
  buildPickupBoxHtml(inheritancePost, context) === buildPickupBoxHtml(inheritancePost, emptyContext) &&
  buildRelatedArticleHtml(inheritancePost, postsMap, context) === buildRelatedArticleHtml(inheritancePost, postsMap, emptyContext),
  '物販以外の記事は pickup 設定の有無で生成部品が変わらない'
);

const coreSlug = 'ebay-export-consumption-tax-refund-guide';
const coreHtml = read(path.join('blog', coreSlug, 'index.html'));
const coreBox = pickupBoxOf(coreHtml);
const corePickupLinks = new Set(hrefsOf(coreBox).filter(href => href.startsWith('/blog/')));
const relatedMatch = coreHtml.match(/<a href="([^"]+)" class="blog-related-link">/);
assert(Boolean(relatedMatch) && !corePickupLinks.has(relatedMatch[1]), '物販の関連記事と中核案内のリンク先が重複しない');
assert(!coreBox.includes(`/blog/${coreSlug}/`), '中核記事自身は案内枠から除外する');

console.log('\n=== 4. 物販ハブと sitemap ===');
const retailHub = read(path.join('blog', 'macro', 'retail', 'index.html'));
const featured = (retailHub.match(/まず読む記事[\s\S]*?<\/div>\s*<\/div>\s*<div class="hub-block">/) || [''])[0];
for (const slug of pickupConfig.netshop_core.slice(0, 3)) {
  assert(featured.includes(`/blog/${slug}/`), `${slug}: 物販ハブの固定枠に出る`);
}
const sitemapAfter = sitemapUrls(read('sitemap.xml'));
assert(sitemapAfter.length === 308, 'sitemap.xml は 01 適用後の 308 URL のまま');
assert(JSON.stringify(sitemapAfter) === JSON.stringify(sitemapBefore), '内部リンク変更の前後で sitemap.xml の URL 一覧が変わらない');

console.log('\n=== 5. 空設定 ===');
assert(renderPickupPostsHtml(emptyContext) === '', '中核が空ならトップ枠を描画しない');
let emptyBuildOk = true;
try {
  quietly(() => buildStaticPages(posts, emptyContext));
  assert(!read('index.html').includes('data-pickup-posts'), '空設定の静的ページ build ではトップ枠が出ない');
} catch (error) {
  emptyBuildOk = false;
  console.log(String(error.message).slice(0, 800));
} finally {
  quietly(() => buildStaticPages(posts, context));
}
assert(emptyBuildOk, '空設定でも build が失敗しない');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
