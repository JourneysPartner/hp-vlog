'use strict';

const assert = require('assert');
const { generateRobotsTxt, generateSitemapXml } = require('../sitemap');

const posts = [
  {
    slug: 'zeta-post',
    category: '相続',
    macro: '相続財産',
    publish_at: '2026-07-01T11:00:00+09:00',
    updated_at: '2026-08-02T09:30:00+09:00',
  },
  {
    slug: 'a&b',
    category: '消費税',
    macro: '物販',
    publish_at: '2026-06-03T11:00:00+09:00',
  },
];

const publishConfig = {
  hojinnari: { enabled: true, indexable: true, lastContentUpdateOn: '2026-09-01' },
  shohizei: { enabled: true, indexable: false, lastContentUpdateOn: '2026-09-02' },
  sozoku: { enabled: false, indexable: true, lastContentUpdateOn: '2026-09-03' },
  yakuin_hoshu: { enabled: true, indexable: true, lastContentUpdateOn: '2026-09-04' },
};

const options = {
  posts,
  staticPageFiles: ['services.html', 'index.html', 'about.html'],
  publishConfig,
  correctionsGenerated: true,
};

let passed = 0;
function check(label, action) {
  action();
  process.stdout.write(`  ✓ ${label}\n`);
  passed++;
}

process.stdout.write('\n=== sitemap.xml / robots.txt ===\n');

const xml = generateSitemapXml(options);

check('記事・カテゴリ・マクロ・enabledかつindexableなツールを収録する', () => {
  assert(xml.includes('<loc>https://mori-zeirishi.net/blog/zeta-post/</loc>'));
  assert(xml.includes('<loc>https://mori-zeirishi.net/blog/category/sozoku/</loc>'));
  assert(xml.includes('<loc>https://mori-zeirishi.net/blog/macro/retail/</loc>'));
  assert(xml.includes('<loc>https://mori-zeirishi.net/tools/hojinnari-simulator/</loc>'));
  assert(xml.includes('<loc>https://mori-zeirishi.net/tools/yakuin-hoshu-simulator/</loc>'));
  assert(xml.includes('<loc>https://mori-zeirishi.net/tools/corrections/</loc>'));
});

check('indexable=falseまたはenabled=falseのツールは収録しない', () => {
  assert(!xml.includes('/tools/shohizei-simulator/'));
  assert(!xml.includes('/tools/sozokuzei-simulator/'));
});

check('lastmodは日付部分だけを使い、updated_atを優先する', () => {
  const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(match => match[1]);
  assert(lastmods.length >= 4);
  assert(lastmods.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value)));
  const zetaEntry = xml.slice(xml.indexOf('/blog/zeta-post/'), xml.indexOf('</url>', xml.indexOf('/blog/zeta-post/')));
  assert(zetaEntry.includes('<lastmod>2026-08-02</lastmod>'));
});

check('XML特殊文字をエスケープし、末尾はLF改行にする', () => {
  assert(xml.includes('/blog/a&amp;b/'));
  assert(!xml.includes('/blog/a&b/'));
  assert(xml.endsWith('\n'));
  assert(!xml.includes('\r\n'));
});

check('種別内を安定ソートし、2回生成しても完全に同じになる', () => {
  assert.strictEqual(generateSitemapXml(options), xml);
  assert(xml.indexOf('/about.html') < xml.indexOf('/services.html'));
  assert(xml.indexOf('/blog/a&amp;b/') < xml.indexOf('/blog/zeta-post/'));
  assert(xml.indexOf('/tools/hojinnari-simulator/') < xml.indexOf('/tools/yakuin-hoshu-simulator/'));
});

check('robots.txtにサイトマップURLを含む', () => {
  const robots = generateRobotsTxt();
  assert(robots.includes('User-agent: *\nAllow: /\n'));
  assert(robots.includes('Sitemap: https://mori-zeirishi.net/sitemap.xml'));
  assert(robots.endsWith('\n'));
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
