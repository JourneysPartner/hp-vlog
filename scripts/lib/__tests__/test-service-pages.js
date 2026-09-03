'use strict';
/**
 * サービス専用ページ7本＋料金ページ（2026-09-03 段階2）
 *
 * 何が無かったか:
 *   取扱業務は1ページに6サービスが小見出しで並ぶだけで、専用ページも料金ページも無かった。
 *   「税理士 記帳代行 料金」「eBay 消費税還付 税理士」のような依頼に近い検索語を受ける
 *   ページが1つも無かった。
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

const SERVICES = ['ebay-export', 'online-seller', 'bookkeeping', 'tax-return', 'inheritance', 'tax-audit', 'startup'];

console.log('=== 0. ビルド ===');
{
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { ok = false; console.log(String(e.stderr || e.message).slice(0, 600)); }
  assert(ok, 'ビルドが成功する');
}

console.log('');
console.log('=== 1. 8ページが生成される ===');
for (const slug of SERVICES) assert(exists(`services/${slug}/index.html`), `services/${slug}/index.html`);
assert(exists('pricing/index.html'), 'pricing/index.html');
assert(exists('services.html'), '従来の services.html も残る');

console.log('');
console.log('=== 2. 各サービスページの中身 ===');
for (const slug of SERVICES) {
  const html = read(`services/${slug}/index.html`);
  const ld = jsonLd(html);
  const h1s = html.match(/<h1[^>]*>/g) || [];
  assert(h1s.length === 1, `${slug}: H1 が1つ`);
  assert(html.includes(`<link rel="canonical" href="https://mori-zeirishi.net/services/${slug}/">`), `${slug}: canonical が自分のURL`);
  assert(html.includes(`og:url" content="https://mori-zeirishi.net/services/${slug}/"`), `${slug}: og:url`);
  const svc = ld.find(o => o['@type'] === 'Service');
  assert(!!svc && svc.url === `https://mori-zeirishi.net/services/${slug}/` && svc.provider && svc.provider['@id'] === 'https://mori-zeirishi.net/#organization', `${slug}: Service の構造化データ（provider は事務所）`);
  const faq = ld.find(o => o['@type'] === 'FAQPage');
  assert(!!faq && faq.mainEntity.length >= 3 && faq.mainEntity.every(q => !/<|>/.test(q.acceptedAnswer.text)), `${slug}: FAQPage（3問以上・タグ無し）`);
  const bc = ld.find(o => o['@type'] === 'BreadcrumbList');
  assert(!!bc && bc.itemListElement.length === 3 && bc.itemListElement[1].item === 'https://mori-zeirishi.net/services.html', `${slug}: パンくず（ホーム › 取扱業務 › 本ページ）`);
  assert(hasType(ld, 'Organization') && hasType(ld, 'Person'), `${slug}: 事務所・代表の構造化データ`);
  assert(!html.includes('{{') && !html.includes('x-related-posts'), `${slug}: プレースホルダと内部用メタが残っていない`);
  assert(/class="post-card"/.test(html), `${slug}: 関連記事のカードがある`);
  assert(/href="\/contact\.html"/.test(html), `${slug}: 相談導線がある`);
}

console.log('');
console.log('=== 3. 料金ページ（第1版は金額なし）===');
{
  const html = read('pricing/index.html');
  const body = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  assert(/<h1[^>]*>料金の考え方<\/h1>/.test(html), 'H1 が「料金の考え方」');
  assert(!/[0-9０-９,]+\s*(円|万円)/.test(body), '金額表記（円・万円）が無い');
  assert(html.includes('<!-- PRICE_TABLE:'), '金額追記用のコメントがある');
  assert(html.includes('<link rel="canonical" href="https://mori-zeirishi.net/pricing/">'), 'canonical が /pricing/');
  const ld = jsonLd(html);
  assert(hasType(ld, 'FAQPage') && hasType(ld, 'BreadcrumbList'), 'FAQ とパンくずの構造化データ');
  assert(!hasType(ld, 'Service'), '料金ページには Service を付けない');
  for (const slug of ['bookkeeping', 'tax-return', 'inheritance', 'tax-audit', 'startup']) {
    assert(html.includes(`href="/services/${slug}/"`), `含まれるものの表から /services/${slug}/ へリンク`);
  }
}

console.log('');
console.log('=== 4. 導線 ===');
{
  const services = read('services.html');
  for (const slug of SERVICES) assert(services.includes(`href="/services/${slug}/"`), `services.html → /services/${slug}/`);
  assert(services.includes('href="/pricing/"'), 'services.html → 料金ページ');
  assert(services.includes('ネット販売・副業の税務'), 'services.html にネット販売のカードがある');

  const footer = read('templates/partials/footer.html');
  const footerServiceLinks = footer.match(/<div class="footer-heading">サービス<\/div>[\s\S]*?<\/ul>/)[0];
  assert(!/href="\/services\.html"/.test(footerServiceLinks), 'フッターの「サービス」列が /services.html 以外を指す');
  assert(footerServiceLinks.includes('/pricing/'), 'フッターに料金の考え方がある');

  const header = read('templates/partials/header.html');
  assert(/dropdown-menu/.test(header) && SERVICES.every(s => header.includes(`/services/${s}/`)), 'ヘッダーのドロップダウンに7本すべてある');
  assert(/href="\/services\.html"[^>]*data-bs-toggle="dropdown"/.test(header) || /data-bs-toggle="dropdown"[^>]*href="\/services\.html"/.test(header) || header.includes('<a class="nav-link dropdown-toggle" href="/services.html"'), 'JS無しでも「取扱業務」は /services.html に飛ぶ');

  const index = read('index.html');
  const cardLinks = index.match(/class="service-link"/g) || [];
  const cardLinksToTop = (index.match(/<a href="\/services\.html" class="service-link">/g) || []).length;
  assert(cardLinks.length >= 6 && cardLinksToTop === 0, `トップのサービスカードが専用ページを指す（${cardLinks.length}枚）`);
}

console.log('');
console.log('=== 5. sitemap / 計測ページ表 ===');
{
  const xml = read('sitemap.xml');
  for (const slug of SERVICES) assert(xml.includes(`<loc>https://mori-zeirishi.net/services/${slug}/</loc>`), `sitemap に /services/${slug}/`);
  assert(xml.includes('<loc>https://mori-zeirishi.net/pricing/</loc>'), 'sitemap に /pricing/');
  assert(xml.includes('<loc>https://mori-zeirishi.net/services.html</loc>'), 'sitemap に従来の services.html');
  const map = JSON.parse(read('analytics-page-map.json'));
  assert(SERVICES.every(s => map[`/services/${s}/`]) && map['/pricing/'], '計測ページ表に新ページがある');
}

console.log('');
console.log('=== 6. 生成物に【要確認】が無い ===');
{
  const targets = SERVICES.map(s => `services/${s}/index.html`).concat(['pricing/index.html', 'services.html', 'index.html']);
  const leaked = targets.filter(t => /【要確認】|【要用意】/.test(read(t)));
  assert(leaked.length === 0, `【要確認】【要用意】が無い（${targets.length} ファイル）`);
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
