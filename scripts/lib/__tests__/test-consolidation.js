'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { main: buildSite } = require('../../build');
const { getExistingSlugs } = require('../../generate-draft');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const pairs = [
  {
    keep: 'affiliate-pr-incorporation-incorporation-threshold-guide',
    merged: 'affiliate-pr-incorporation-incorporation-threshold-practice',
    heading: 'ブログ・アフィリエイトの法人成り、実務で迷うタイミングの処理はどうする？',
    moved: ['実務でつまずきやすい3つのケース', '結論が変わる分岐点まとめ'],
  },
  {
    keep: 'affiliate-pr-growth-invoice-judgement-guide',
    merged: 'affiliate-pr-growth-invoice-judgement-practice',
    heading: 'インボイス登録、実際どうすれば？手続きの流れとつまずきポイントを整理',
    moved: ['登録申請の全体フロー', '申請に必要なもの・手元に準備するもの', '登録後に保存・管理すべき書類', 'つまずきやすいポイントと対処法'],
  },
  {
    keep: 'youtube-side-business-withholding-treatment-guide',
    merged: 'youtube-side-business-withholding-treatment-practice',
    heading: 'YouTube収益の源泉徴収、実務でどう処理する？よくある誤解と正しい対応',
    moved: ['よくある誤解と正しい理解', '実務での具体的な処理ステップ'],
  },
  {
    keep: 'shopify-growth-overseas-tax-uncertain-practice',
    merged: 'shopify-growth-overseas-tax-uncertain-guide',
    heading: 'Shopifyで海外に販売したら消費税はどうなる？輸出免税の判断軸と実務の注意点',
    moved: ['輸出免税とは何か', '免税事業者と課税事業者で何が変わるか', '輸出免税が認められるための主な条件', '判断フロー：自分はどのケースか', '自分で確認できるチェックリスト'],
  },
];

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

function loadPosts() {
  return fs.readdirSync(POSTS_DIR)
    .filter(file => file.endsWith('.md'))
    .map(file => {
      const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
      const parsed = matter(raw);
      return { file, raw, data: parsed.data, content: parsed.content };
    });
}

function extractH2(content, title) {
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) return '';
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end === -1) end = lines.length;
  return lines.slice(start, end)
    .map(line => line.startsWith('#') ? `#${line}` : line)
    .join('\n')
    .trim();
}

console.log('=== 0. ビルド ===');
let buildOk = true;
try {
  const originalLog = console.log;
  console.log = () => {};
  try {
    buildSite();
  } finally {
    console.log = originalLog;
  }
} catch (error) {
  buildOk = false;
  console.log(String(error.message).slice(0, 800));
}
assert(buildOk, '統合後のサイトをビルドできる');

const posts = loadPosts();
const bySlug = new Map(posts.map(post => [post.data.slug, post]));

console.log('\n=== 1. 統合先と統合元の状態 ===');
for (const pair of pairs) {
  const keep = bySlug.get(pair.keep);
  const merged = bySlug.get(pair.merged);
  assert(Boolean(keep && keep.content.includes(`## 実務編：${pair.heading}`)), `${pair.keep}: 実務編を含む`);
  assert(Boolean(merged && merged.data.review_status === 'merged'), `${pair.merged}: review_status=merged`);
  assert(Boolean(merged && merged.data.merged_into === pair.keep), `${pair.merged}: merged_into が統合先を指す`);
  for (const title of pair.moved) {
    const original = merged ? extractH2(merged.content, title) : '';
    assert(Boolean(original && keep && keep.content.includes(original)), `${pair.keep}: 「${title}」の本文は見出し階層以外を変えていない`);
  }
}

console.log('\n=== 2. 統合元を公開導線から除外 ===');
const sitemap = read('sitemap.xml');
const blogIndex = read(path.join('blog', 'index.html'));
const hubHtml = fs.readdirSync(path.join(ROOT, 'blog', 'macro'), { recursive: true })
  .filter(file => String(file).endsWith('.html'))
  .map(file => fs.readFileSync(path.join(ROOT, 'blog', 'macro', file), 'utf8'))
  .join('\n');
for (const pair of pairs) {
  const removedPath = `/blog/${pair.merged}/`;
  const keepHtml = read(path.join('blog', pair.keep, 'index.html'));
  assert(!sitemap.includes(removedPath), `${pair.merged}: sitemap.xml に出ない`);
  assert(!blogIndex.includes(removedPath), `${pair.merged}: blog/index.html に出ない`);
  assert(!hubHtml.includes(removedPath), `${pair.merged}: 業種ハブに出ない`);
  assert(!keepHtml.includes(removedPath), `${pair.merged}: 統合先の関連記事欄に出ない`);
}

console.log('\n=== 3. 301 リダイレクト ===');
const netlify = read('netlify.toml');
for (const pair of pairs) {
  const block = [
    '[[redirects]]',
    `  from = "/blog/${pair.merged}/"`,
    `  to = "/blog/${pair.keep}/"`,
    '  status = 301',
  ].join('\n');
  assert(netlify.includes(block), `${pair.merged}: 統合先への 301 がある`);
}

console.log('\n=== 4. slug の重複と再生成防止 ===');
const slugFiles = new Map();
for (const post of posts) {
  if (!post.data.slug) continue;
  const files = slugFiles.get(post.data.slug) || [];
  files.push(post.file);
  slugFiles.set(post.data.slug, files);
}
const duplicates = [...slugFiles.entries()].filter(([, files]) => files.length > 1);
assert(duplicates.length === 0, `同じ slug の記事ファイルが重複しない${duplicates.length ? `: ${duplicates.map(([slug]) => slug).join(', ')}` : ''}`);

const existingSlugs = getExistingSlugs();
for (const pair of pairs) {
  assert(existingSlugs.has(pair.merged), `${pair.merged}: 生成側で使用済み slug として扱う`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
