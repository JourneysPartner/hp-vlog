'use strict';
/**
 * 全ページの基本情報・執筆者欄・パンくず・FAQ・404・共有画像・業種紐づけ（2026-09-03 段階1）
 *
 * 何が無かったか:
 *   トップ・事務所紹介・取扱業務・お客様の声・お問い合わせに、正規URL・共有情報・
 *   構造化データが無かった。記事は「記事」型だけで、パンくず・FAQ・執筆者が無かった。
 *   404 の実体が無く、画像が1枚も無く、61本の記事がどの業種ページにも載っていなかった。
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

/** <script type="application/ld+json"> をすべて取り出して JSON にする */
function jsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch (_) { out.push({ __invalid: m[1].slice(0, 80) }); }
  }
  return out;
}
const hasType = (list, type) => list.some(o => {
  const t = o && o['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
});

console.log('=== 0. ビルド ===');
{
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { ok = false; console.log(String(e.stderr || e.message).slice(0, 600)); }
  assert(ok, 'npm run build 相当が成功する');
}

const STATIC = ['index.html', 'about.html', 'services.html', 'voice.html', 'contact.html', 'privacy.html'];

console.log('');
console.log('=== 1. 静的ページに正規URL・共有情報・事務所の構造化データがある ===');
for (const page of STATIC) {
  const html = read(page);
  const ld = jsonLd(html);
  const canonicalPath = page === 'index.html' ? '/' : `/${page}`;
  assert(html.includes(`<link rel="canonical" href="https://mori-zeirishi.net${canonicalPath}">`), `${page}: canonical が自分のURL`);
  assert(/<meta property="og:title" content="[^"]+"/.test(html), `${page}: og:title`);
  assert(html.includes('og:image" content="https://mori-zeirishi.net/assets/images/og-default.png"'), `${page}: og:image`);
  assert(hasType(ld, 'Organization') && hasType(ld, 'AccountingService'), `${page}: Organization（AccountingService）の構造化データ`);
  assert(hasType(ld, 'Person'), `${page}: Person の構造化データ`);
  assert(!html.includes('{{'), `${page}: 未置換のプレースホルダが無い`);
}
{
  const ld = jsonLd(read('index.html'));
  assert(hasType(ld, 'WebSite'), 'index.html: WebSite の構造化データ');
  const org = ld.find(o => Array.isArray(o['@type']) && o['@type'].includes('Organization'));
  assert(org && !org.address, '事務所の構造化データに住所が無い（決定事項）');
  assert(org && Array.isArray(org.sameAs) && org.sameAs.length === 1
    && org.sameAs[0] === 'https://www.instagram.com/guardian_tax_ac/', 'sameAs は毛利から受け取った Instagram の URL だけ（追跡用の引数なし）');
  assert(!jsonLd(read('about.html')).some(o => o['@type'] === 'WebSite'), 'WebSite はトップだけ');
}

console.log('');
console.log('=== 2. 404 ページ ===');
{
  assert(exists('404.html'), '404.html が生成される');
  const html = exists('404.html') ? read('404.html') : '';
  assert(/<meta name="robots" content="noindex">/.test(html), 'noindex がある');
  assert(!/rel="canonical"/.test(html), 'canonical が無い');
  assert(/お探しのページは見つかりませんでした/.test(html), '見出しがある');
  assert(/href="\/services\.html"/.test(html) && /href="\/blog\/"/.test(html) && /href="\/contact\.html"/.test(html), '主要ページへのリンクがある');
}

console.log('');
console.log('=== 3. 記事ページ（全件）===');
{
  const blogDir = path.join(ROOT, 'blog');
  const slugs = fs.readdirSync(blogDir).filter(d =>
    !['category', 'macro', 'page'].includes(d) && fs.existsSync(path.join(blogDir, d, 'index.html')));
  assert(slugs.length > 200, `記事ページを読める（${slugs.length}本）`);

  let okCanonical = 0, okOg = 0, okArticle = 0, okAuthorId = 0, okCrumbNav = 0, okCrumbLd = 0, okAuthorBox = 0, okNoPlaceholder = 0;
  let faqPosts = 0, faqAnswersWithTag = 0, faqAnswersTotal = 0;
  for (const slug of slugs) {
    const html = read(`blog/${slug}/index.html`);
    const ld = jsonLd(html);
    if (html.includes(`<link rel="canonical" href="https://mori-zeirishi.net/blog/${slug}/">`)) okCanonical++;
    if (html.includes('og:image" content="https://mori-zeirishi.net/assets/images/og-default.png"')) okOg++;
    const article = ld.find(o => o['@type'] === 'Article');
    if (article) okArticle++;
    if (article && article.author && article.author['@id'] === 'https://mori-zeirishi.net/#person'
      && article.publisher && article.publisher['@id'] === 'https://mori-zeirishi.net/#organization') okAuthorId++;
    if (/<nav class="breadcrumb-custom" aria-label="パンくず">/.test(html) && /税務コラム<\/a>/.test(html)) okCrumbNav++;
    if (hasType(ld, 'BreadcrumbList')) okCrumbLd++;
    if (html.includes('class="author-box"') && html.includes('この記事を書いた人')) okAuthorBox++;
    if (!html.includes('{{')) okNoPlaceholder++;
    const faq = ld.find(o => o['@type'] === 'FAQPage');
    if (faq) {
      faqPosts++;
      for (const q of faq.mainEntity || []) {
        faqAnswersTotal++;
        if (/<|>/.test(q.acceptedAnswer.text) || /\*\*/.test(q.acceptedAnswer.text)) faqAnswersWithTag++;
      }
    }
  }
  const n = slugs.length;
  assert(okCanonical === n, `canonical が自分のURL（${okCanonical}/${n}）`);
  assert(okOg === n, `og:image がある（${okOg}/${n}）`);
  assert(okArticle === n, `Article の構造化データがある（${okArticle}/${n}）`);
  assert(okAuthorId === n, `author / publisher が #person / #organization を参照する（${okAuthorId}/${n}）`);
  assert(okCrumbNav === n, `パンくずが表示される（${okCrumbNav}/${n}）`);
  assert(okCrumbLd === n, `BreadcrumbList がある（${okCrumbLd}/${n}）`);
  assert(okAuthorBox === n, `執筆者欄がある（${okAuthorBox}/${n}）`);
  assert(okNoPlaceholder === n, `未置換のプレースホルダが無い（${okNoPlaceholder}/${n}）`);

  console.log('');
  console.log('=== 4. FAQ の構造化データ ===');
  assert(faqPosts >= 30, `FAQPage を持つ記事が30本以上（${faqPosts}本）`);
  assert(faqAnswersTotal > 0 && faqAnswersWithTag === 0, `回答にタグや記法が残っていない（${faqAnswersTotal}件中 ${faqAnswersWithTag}件に混入）`);
}

console.log('');
console.log('=== 5. FAQ 解析器の単体 ===');
{
  const { extractFaq } = require(path.join(ROOT, 'scripts/lib/faq-extractor'));
  const ok = extractFaq('## 本文\n\n## よくある質問\n### 質問A？\n回答Aです。**強調**あり。\n\n### 質問B？\n回答B [リンク](https://x) です。\n## まとめ\n');
  assert(ok.length === 2 && ok[0].question === '質問A？' && ok[0].answer === '回答Aです。強調あり。', '### 形式を取れる（記法を落とす）');
  assert(ok[1].answer === '回答B リンク です。', 'リンクは文字だけ残す');
  assert(extractFaq('## よくある質問\n### 直後に空行が無い\n回答\n').length === 1, '見出し直後に空行が無くても取れる');
  let threw = false, bold = [];
  try { bold = extractFaq('## よくある質問\n**Q. 太字の質問？**\n回答\n## まとめ'); } catch (_) { threw = true; }
  assert(!threw && bold.length === 0, '太字形式は「取れない」として空を返す（例外を出さない）');
  assert(extractFaq('## よくある誤解\n### 誤解1\n説明\n').length === 0, '「よくある誤解」は対象外');
  assert(extractFaq('').length === 0 && extractFaq(null).length === 0, '空・null でも落ちない');
}

console.log('');
console.log('=== 6. 業種ハブへの振り分け ===');
{
  const { hubMacroFor } = require(path.join(ROOT, 'scripts/lib/hub-membership'));
  const { MACROS } = require(path.join(ROOT, 'scripts/lib/blog-taxonomy'));
  const { parseFrontmatterMeta } = require(path.join(ROOT, 'scripts/lib/source-guard'));
  const macroSet = new Set(MACROS.map(m => m.ja));
  const postsDir = path.join(ROOT, 'content', 'posts');
  const published = fs.readdirSync(postsDir).filter(f => f.endsWith('.md'))
    .map(f => parseFrontmatterMeta(fs.readFileSync(path.join(postsDir, f), 'utf8')))
    .filter(m => m.review_status === 'published');
  assert(published.every(m => macroSet.has(hubMacroFor(m))), `公開記事 ${published.length} 本すべてがいずれかの業種を返す`);
  assert(hubMacroFor({ primary_persona: 'beauty_salon_owner', macro: '' }) === 'サロン', 'macro 空・美容サロン → サロン');
  assert(hubMacroFor({ primary_persona: 'general_individual_proprietor', macro: '税目実務' }) === '一般事業者', '税目実務・一般個人事業主 → 一般事業者');
  assert(hubMacroFor({ primary_persona: 'domestic_ec_seller', macro: '税目実務' }) === '物販', '税目実務でもペルソナが物販なら物販');
  assert(hubMacroFor({ primary_persona: '', macro: '相続贈与' }) === '相続贈与', 'ペルソナ無しなら macro');
  assert(hubMacroFor({}) === '一般事業者', '何も無ければ一般事業者');
  const emptyMacro = published.filter(m => !m.macro);
  assert(emptyMacro.length > 0 && emptyMacro.every(m => macroSet.has(hubMacroFor(m))), `macro 空の ${emptyMacro.length} 本も振り分けられる`);
}

console.log('');
console.log('=== 7. sitemap / 計測ページ表 ===');
{
  const xml = read('sitemap.xml');
  const { MACROS } = require(path.join(ROOT, 'scripts/lib/blog-taxonomy'));
  assert(!xml.includes('/404.html'), 'sitemap に 404 が無い');
  const hubDirs = fs.existsSync(path.join(ROOT, 'blog', 'macro')) ? fs.readdirSync(path.join(ROOT, 'blog', 'macro')) : [];
  assert(hubDirs.length >= 9, `業種ページが生成される（${hubDirs.length}種）`);
  assert(hubDirs.every(slug => xml.includes(`<loc>https://mori-zeirishi.net/blog/macro/${slug}/</loc>`)), '生成した業種ページがすべて sitemap にある');
  assert(hubDirs.includes('general'), '一般事業者のハブがある（macro 空の記事の受け皿）');
  const map = JSON.parse(read('analytics-page-map.json'));
  assert(!map['/404.html'], '計測ページ表に 404 が無い');
  assert(hubDirs.every(slug => map[`/blog/macro/${slug}/`]), '計測ページ表に業種ページがある');
}

console.log('');
console.log('=== 8. 生成物に【要確認】が残っていない ===');
{
  const targets = [...STATIC, '404.html', 'sitemap.xml'];
  const blogDir = path.join(ROOT, 'blog');
  for (const d of fs.readdirSync(blogDir)) {
    const f = path.join(blogDir, d, 'index.html');
    if (fs.existsSync(f)) targets.push(`blog/${d}/index.html`);
  }
  const leaked = targets.filter(t => /【要確認】|【要用意】/.test(read(t)));
  assert(leaked.length === 0, `【要確認】【要用意】が無い（${targets.length} ファイル確認）`);
}

console.log('');
console.log('=== 9. 画像 ===');
for (const img of ['og-default.png', 'logo.png', 'author-mori.png']) {
  const p = path.join(ROOT, 'assets', 'images', img);
  const ok = fs.existsSync(p) && fs.readFileSync(p).slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert(ok, `assets/images/${img} が PNG として存在する`);
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
