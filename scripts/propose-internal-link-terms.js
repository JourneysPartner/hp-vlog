'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { assignHubMacro, hubMacroOf } = require('./lib/hub-membership');

const ROOT = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const OUTPUT_PATH = path.join(ROOT, 'data', 'internal-link-terms.json');

const SEED_TERMS = Object.freeze([
  '簡易課税', '輸出免税', '消費税還付', '2割特例', '3割特例', '特定期間', '基準期間',
  '課税事業者選択届出書', '少額減価償却資産', '一括償却資産', '源泉徴収', '青色申告特別控除',
  '専従者給与', 'インボイス登録', '適格簡易請求書', 'リバースチャージ', '前受金', '棚卸資産',
  '法人成り', '名義預金', '小規模宅地等の特例', '配偶者の税額軽減', '準確定申告', '相続登記',
  '生前贈与', '相続時精算課税', '事業所得', '雑所得', '家事按分', '修繕費', '資本的支出',
  '免税事業者', '仕入税額控除', '外注費', '人工代', '特定課税仕入れ', '現金過不足', '商品券',
]);

const PREFERRED_TYPES = new Set(['basic_explainer', 'comparison_decision']);

function isPublished(post, now = new Date()) {
  return post.review_status === 'published' &&
    post.publish_at &&
    new Date(post.publish_at) <= now;
}

function loadPublishedPosts(now = new Date()) {
  const posts = fs.readdirSync(POSTS_DIR)
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => {
      const { data } = matter(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
      return { ...data, _file: file };
    })
    .filter(post => isPublished(post, now));
  assignHubMacro(posts);
  return posts;
}

function candidateForTerm(term, posts) {
  return posts
    .filter(post => String(post.title || '').includes(term))
    .sort((a, b) =>
      Number(PREFERRED_TYPES.has(b.article_type)) - Number(PREFERRED_TYPES.has(a.article_type)) ||
      String(a.title).indexOf(term) - String(b.title).indexOf(term) ||
      new Date(b.publish_at) - new Date(a.publish_at) ||
      String(a.slug).localeCompare(String(b.slug))
    )[0] || null;
}

function proposeTerms(posts, seeds = SEED_TERMS) {
  const terms = [];
  const missing = [];
  for (const term of seeds) {
    const post = candidateForTerm(term, posts);
    if (!post) {
      missing.push(term);
      continue;
    }
    terms.push({ term, slug: post.slug, macros: [hubMacroOf(post)], enabled: true });
  }
  return { terms, missing };
}

function main() {
  const posts = loadPublishedPosts();
  const result = proposeTerms(posts);
  const output = {
    _note: '本文中の用語に、その用語を主題にした記事へのリンクをビルド時に付ける辞書。記事の Markdown は触らない。term は本文に出る語そのまま。macros はリンクを出す記事の業種ハブ（hub-membership の日本語 macro 名）。"*" は全業種。enabled が false の行は使わない。',
    terms: result.terms,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`[internal-link-terms] ${result.terms.length} 語を ${path.relative(ROOT, OUTPUT_PATH)} に保存`);
  for (const entry of result.terms) {
    const post = posts.find(candidate => candidate.slug === entry.slug);
    console.log(`  ${entry.term} → ${post.title} → ${entry.macros.join(', ')}`);
  }
  console.log(`[internal-link-terms] 見つからなかった種語: ${result.missing.length} 語`);
  for (const term of result.missing) console.log(`  ${term}`);
}

if (require.main === module) main();

module.exports = Object.freeze({
  SEED_TERMS,
  PREFERRED_TYPES,
  isPublished,
  loadPublishedPosts,
  candidateForTerm,
  proposeTerms,
  main,
});
