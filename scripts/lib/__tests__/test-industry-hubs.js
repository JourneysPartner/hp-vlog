'use strict';
/**
 * 業種別の柱ページと、記事からの自動リンク（2026-09-03 段階3）
 *
 * 何が無かったか:
 *   記事は業種（ペルソナ）で書かれているのに、業種ページは一文と記事カードだけの薄い一覧で、
 *   「美容室 税理士」「せどり 確定申告」のような業種軸の検索を受ける柱になっていなかった。
 *   記事から業種ページ・サービスページへのリンクも無かった。
 *
 * このテストはビルド後の生成物を読んで確認する（冒頭でビルドを実行する）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function jsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch (_) { out.push({ __invalid: true }); }
  }
  return out;
}
const hasType = (list, type) => list.some(o => {
  const t = o && o['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
});

const { MACROS } = require(path.join(ROOT, 'scripts/lib/blog-taxonomy'));
const { HUB_CONTENT } = require(path.join(ROOT, 'scripts/lib/hub-content'));
const { serviceSlugForPost, SERVICE_PAGES } = require(path.join(ROOT, 'scripts/lib/service-links'));

console.log('=== 0. ビルド ===');
{
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { ok = false; console.log(String(e.stderr || e.message).slice(0, 600)); }
  assert(ok, 'ビルドが成功する');
}

const hubSlugs = MACROS.map(m => m.slug).filter(s => exists(`blog/macro/${s}/index.html`));

console.log('');
console.log('=== 1. 業種別ガイドの入口 /blog/macro/ ===');
{
  assert(exists('blog/macro/index.html'), 'blog/macro/index.html が生成される');
  const html = read('blog/macro/index.html');
  assert(hubSlugs.length >= 9 && hubSlugs.every(s => html.includes(`href="/blog/macro/${s}/"`)), `各ハブへリンクする（${hubSlugs.length}件）`);
  assert(html.includes('<link rel="canonical" href="https://mori-zeirishi.net/blog/macro/">'), 'canonical');
  assert(hasType(jsonLd(html), 'BreadcrumbList'), 'パンくずの構造化データ');
  assert(!html.includes('{{'), '未置換のプレースホルダが無い');
}

console.log('');
console.log('=== 2. 各ハブの1ページ目が柱ページになっている ===');
for (const slug of hubSlugs) {
  const html = read(`blog/macro/${slug}/index.html`);
  const hub = HUB_CONTENT[slug];
  const ld = jsonLd(html);
  assert(!!hub, `${slug}: 文章が定義されている`);
  if (!hub) continue;
  assert(html.includes(`<h1 class="page-hero-title">${hub.h1}</h1>`), `${slug}: H1 が指示書どおり`);
  assert(html.includes(hub.lead), `${slug}: リードが指示書どおり`);
  assert(hub.points.every(p => html.includes(p)), `${slug}: よくある論点がすべて載る`);
  // テンプレートのコメント行にも「まず読む記事」があるので、見出しの閉じタグで区切る
  const featured = (html.split('まず読む記事</h2>')[1] || '').split('関連するサービス</h2>')[0];
  assert((featured.match(/class="post-card"/g) || []).length === 3, `${slug}: まず読む記事が3本`);
  assert(hub.services.every(s => html.includes(`href="/services/${s}/"`)), `${slug}: 関連サービスへリンクする`);
  assert(hub.faq.every(q => html.includes(q.question)), `${slug}: FAQ が載る`);
  const faq = ld.find(o => o['@type'] === 'FAQPage');
  assert(!!faq && faq.mainEntity.length === hub.faq.length, `${slug}: FAQPage の構造化データ`);
  assert(html.includes('記事一覧') && /class="blog-card/.test(html), `${slug}: 記事一覧が続く`);
  assert(!html.includes('{{'), `${slug}: 未置換のプレースホルダが無い`);
}

console.log('');
console.log('=== 3. 2ページ目以降は従来の一覧 ===');
{
  const withPage2 = hubSlugs.find(s => exists(`blog/macro/${s}/page/2/index.html`));
  assert(!!withPage2, `2ページ目を持つハブがある（${withPage2 || 'なし'}）`);
  if (withPage2) {
    const html = read(`blog/macro/${withPage2}/page/2/index.html`);
    assert(!html.includes('まず読む記事') && !hasType(jsonLd(html), 'FAQPage'), '2ページ目には柱の節と FAQPage が無い');
  }
}

console.log('');
console.log('=== 4. 「まず読む記事」の自動選定 ===');
{
  const build = require(path.join(ROOT, 'scripts/build.js'));
  assert(typeof build.pickFeaturedPosts === 'function', 'pickFeaturedPosts が公開されている');
  if (typeof build.pickFeaturedPosts === 'function') {
    const posts = [
      { slug: 'a', customer_fit_score: 3, lead_value_score: 2 }, // 5
      { slug: 'b', customer_fit_score: 5, lead_value_score: 4 }, // 9
      { slug: 'c', customer_fit_score: 5, lead_value_score: 4 }, // 9（同点は先に並ぶ方＝新しい方）
      { slug: 'd' },                                              // 0
    ];
    const auto = build.pickFeaturedPosts(posts, [], 3).map(p => p.slug);
    assert(JSON.stringify(auto) === JSON.stringify(['b', 'c', 'a']), `指定が無ければ点数の高い順・同点は新しい順（実: ${auto.join(',')}）`);
    const fixed = build.pickFeaturedPosts(posts, ['d', 'zzz'], 3).map(p => p.slug);
    assert(fixed[0] === 'd' && fixed.length === 3 && !fixed.includes('zzz'), `hub-config の指定を先頭に、無い slug は無視して残りを自動で埋める（実: ${fixed.join(',')}）`);
  }
  const cfg = JSON.parse(read('data/hub-config.json'));
  assert(hubSlugs.every(s => cfg[s] && Array.isArray(cfg[s].featured)), 'hub-config.json に全ハブの featured がある');
}

console.log('');
console.log('=== 5. 記事 → サービスの対応表 ===');
{
  assert(serviceSlugForPost({ primary_persona: 'ebay_export_seller' }) === 'ebay-export', 'eBay → ebay-export');
  assert(serviceSlugForPost({ primary_persona: 'domestic_ec_seller' }) === 'online-seller', '国内EC → online-seller');
  assert(serviceSlugForPost({ primary_persona: 'inheritance_client' }) === 'inheritance', '相続 → inheritance');
  assert(serviceSlugForPost({ primary_persona: 'beauty_salon_owner' }) === 'bookkeeping', 'サロン → bookkeeping');
  assert(serviceSlugForPost({ tax_domain: 'overseas_transactions' }) === 'ebay-export', '税目 海外取引 → ebay-export');
  assert(serviceSlugForPost({ category: '相続' }) === 'inheritance', 'カテゴリ 相続 → inheritance');
  assert(serviceSlugForPost({ primary_persona: 'beauty_salon_owner', title: '美容室に税務調査が来たら' }) === 'tax-audit', '「税務調査」を含む記事は tax-audit を最優先');
  assert(serviceSlugForPost({ primary_persona: 'domestic_ec_seller', search_intent: 'せどり 法人成り タイミング' }) === 'startup', '「法人成り」を含む記事は startup を最優先');
  assert(serviceSlugForPost({}) === 'tax-return', '何も無ければ tax-return');
  assert(Object.keys(SERVICE_PAGES).every(s => exists(`services/${s}/index.html`)), '対応表のサービスページがすべて実在する');
}

console.log('');
console.log('=== 6. 全記事に業種ハブとサービスへのリンクがある ===');
{
  const blogDir = path.join(ROOT, 'blog');
  const slugs = fs.readdirSync(blogDir).filter(d =>
    !['category', 'macro', 'page'].includes(d) && fs.existsSync(path.join(blogDir, d, 'index.html')));
  let ok = 0, bad = [];
  for (const slug of slugs) {
    const html = read(`blog/${slug}/index.html`);
    const m = html.match(/<div class="blog-hub-links">([\s\S]*?)<\/div>/);
    if (!m) { bad.push(slug); continue; }
    const hrefs = [...m[1].matchAll(/href="([^"]+)"/g)].map(x => x[1]);
    const hubOk = hrefs.some(h => /^\/blog\/macro\/[a-z-]+\/$/.test(h) && exists(`${h.slice(1)}index.html`));
    const svcOk = hrefs.some(h => /^\/services\/[a-z-]+\/$/.test(h) && exists(`${h.slice(1)}index.html`));
    if (hubOk && svcOk) ok++; else bad.push(slug);
  }
  assert(bad.length === 0, `全記事にハブとサービスへの実在するリンクがある（${ok}/${slugs.length}${bad.length ? '、不足: ' + bad.slice(0, 3).join(',') : ''}）`);
}

console.log('');
console.log('=== 7. 導線・sitemap・計測表 ===');
{
  assert(read('templates/partials/header.html').includes('href="/blog/macro/"'), 'ヘッダーに業種別ガイド');
  assert(read('templates/partials/footer.html').includes('href="/blog/macro/"'), 'フッターに業種別ガイド');
  const index = read('index.html');
  assert((index.match(/class="hub-guide-link"/g) || []).length === hubSlugs.length, `トップの業種別ガイドが ${hubSlugs.length} 枚`);
  const list = read('blog/index.html');
  assert(list.includes('業種別ガイド') && hubSlugs.every(s => list.includes(`href="/blog/macro/${s}/"`)), '一覧のサイドバーに業種別ガイド');
  const xml = read('sitemap.xml');
  assert(xml.includes('<loc>https://mori-zeirishi.net/blog/macro/</loc>'), 'sitemap に /blog/macro/');
  assert(JSON.parse(read('analytics-page-map.json'))['/blog/macro/'] === '業種別ガイド', '計測表に /blog/macro/');
}

console.log('');
console.log('=== 8. 生成物に【要確認】が無い ===');
{
  const targets = ['blog/macro/index.html', 'index.html'].concat(hubSlugs.map(s => `blog/macro/${s}/index.html`));
  const leaked = targets.filter(t => /【要確認】|【要用意】/.test(read(t)));
  assert(leaked.length === 0, `【要確認】【要用意】が無い（${targets.length} ファイル）`);
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
