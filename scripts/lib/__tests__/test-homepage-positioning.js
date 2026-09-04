'use strict';
/**
 * トップの看板差し替えと「対応地域」ページ（2026-09-03 段階4）
 *
 * 決定事項（毛利・2026-09-03）:
 *   看板を「eBay輸出専門」から「ネット販売・個人事業主・相続に強い、国税局出身の税理士」に
 *   広げ、eBay輸出は筆頭の得意分野として残す。住所は出さず「対応地域」ページで受ける。
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
const orgOf = (ld) => ld.find(o => Array.isArray(o['@type']) && o['@type'].includes('Organization'));

console.log('=== 0. ビルド ===');
{
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { ok = false; console.log(String(e.stderr || e.message).slice(0, 600)); }
  assert(ok, 'ビルドが成功する');
}

console.log('');
console.log('=== 1. トップの看板 ===');
{
  const html = read('index.html');
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
  assert(/ネット販売・個人事業主・相続/.test(h1), 'H1 に「ネット販売・個人事業主・相続」がある');
  assert(/国税局出身/.test(h1), 'H1 に「国税局出身」が残る');
  assert(/eBay輸出/.test(html), 'eBay輸出はページ内に残る（筆頭の得意分野）');
  assert(/<title>毛利順活税理士事務所｜国税局出身・ネット販売と個人事業主に強い税理士｜全国オンライン対応<\/title>/.test(html), 'title が指示書どおり');
  assert(html.includes('eBay輸出・越境ECに特に強い'), 'ヒーローのバッジに eBay輸出・越境EC');
  assert(html.includes('事務所の筆頭の得意分野です'), 'リードに「筆頭の得意分野」');
  assert(html.includes('親が亡くなり、<strong>相続税がかかるのか</strong>'), 'お悩みに相続の項目');
  assert(html.includes('ネット販売や自分の業種を理解してくれない'), 'お悩みの締めが業種軸');
  assert(html.includes('<h3>業種に合わせた実務</h3>'), '強み②が「業種に合わせた実務」');
  assert(!html.includes('国税局出身×eBay輸出専門'), '旧の締め文言が残っていない');
  assert(!html.includes('<h3>eBay輸出セラー専門</h3>'), '旧の強み②が残っていない');
  // サービスカード7枚・リンク先が専用ページ
  const cards = html.match(/<div class="service-card">[\s\S]*?<\/div>\s*<\/div>/g) || [];
  const links = (html.match(/<a href="(\/services\/[a-z-]+\/)" class="service-link">/g) || []);
  assert(links.length === 7, `サービスカードが7枚（実: ${links.length}）`);
  assert(html.includes('<div class="service-title">ネット販売・副業の税務</div>'), 'ネット販売のカードがある');
  assert(html.includes('<div class="service-title">相続税申告・生前対策</div>') && html.includes('<div class="service-title">創業・法人化</div>'), '相続・創業のカード名が新しい');
  assert(html.includes('href="/services.html" class="btn-outline-navy">すべてのサービスを見る'), '「すべてのサービスを見る」は /services.html のまま');
  assert(html.includes('業種ごとの税務の論点を、記事と実務の両面から整理しています。'), '業種別ガイドの一文');
  assert(html.includes('data-count="200"') && html.includes('data-count="47"') && html.includes('data-count="50"'), '実績カウンタの数値は不変');
  assert(html.includes('eBayセラー支援実績'), 'カウンタのラベルは不変');
  // 節の目印（<!-- ========== NAME ========== -->）が減っていないこと。
  // 段階3で INDUSTRY GUIDE が増えて13節（HERO〜CTA）
  const sections = html.match(/<!-- ========== /g) || [];
  assert(sections.length >= 13, `節の並びが保たれている（${sections.length}節）`);
  assert(html.indexOf('<!-- ========== HERO') < html.indexOf('<!-- ========== WORRIES')
    && html.indexOf('<!-- ========== WORRIES') < html.indexOf('<!-- ========== STRENGTHS')
    && html.indexOf('<!-- ========== STRENGTHS') < html.indexOf('<!-- ========== SERVICES')
    && html.indexOf('<!-- ========== LATEST COLUMN') < html.indexOf('<!-- ========== INDUSTRY GUIDE')
    && html.indexOf('<!-- ========== INDUSTRY GUIDE') < html.indexOf('<!-- ========== FAQ'), '節の順序が変わっていない');
}

console.log('');
console.log('=== 2. 対応地域ページ ===');
{
  assert(exists('area/index.html'), 'area/index.html が生成される');
  const html = exists('area/index.html') ? read('area/index.html') : '';
  assert(/<h1[^>]*>対応地域（全国オンライン対応）<\/h1>/.test(html), 'H1');
  assert(html.includes('<link rel="canonical" href="https://mori-zeirishi.net/area/">'), 'canonical が /area/');
  const org = orgOf(jsonLd(html));
  assert(!!org && Array.isArray(org.areaServed) && org.areaServed.length === 47, 'areaServed が47件');
  assert(!!org && org.areaServed.every(a => a['@type'] === 'AdministrativeArea' && /[都道府県]$/.test(a.name)), '47件が AdministrativeArea・都道府県名');
  assert(!!org && !org.address, '住所が無い（決定事項）');
  const body = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  assert(!/県のお客様|市の方|県の方|市のお客様/.test(body), '地域の実績を示す記述が無い');
  assert(html.includes('47都道府県、どこにお住まいでも'), 'リードが指示書どおり');
  assert(/FAQPage/.test(html) && /BreadcrumbList/.test(html), 'FAQ とパンくずの構造化データ');
  assert(!html.includes('{{'), '未置換のプレースホルダが無い');
  // 他のページの areaServed は国のまま
  const top = orgOf(jsonLd(read('index.html')));
  assert(!!top && !Array.isArray(top.areaServed) && top.areaServed.name === 'JP', 'トップの areaServed は JP のまま');
}

console.log('');
console.log('=== 3. 事務所紹介・フッター ===');
{
  const about = read('about.html');
  assert(about.includes('href="/area/"'), '事務所紹介から /area/ へリンク');
  assert(about.includes('ネット販売・個人事業主・相続に強い'), 'プロフィールのバッジが新しい');
  assert(about.includes('事務所の筆頭の得意分野です'), 'プロフィール本文が指示書どおり');
  assert(about.includes('ネット販売・副業の税務支援'), '業務内容にネット販売');
  assert(!about.includes('eBay輸出セラー専門'), '旧バッジが残っていない');
  const footer = read('templates/partials/footer.html');
  assert(footer.includes('href="/area/">対応地域'), 'フッターに対応地域');
  assert(footer.includes('ネット販売・個人事業主・相続に強い、国税局出身の税理士。全国オンライン対応。'), 'フッターの説明文が指示書どおり');
  assert(footer.includes('営業時間：平日 9:00〜18:00'), '営業時間の行は維持');
}

console.log('');
console.log('=== 4. sitemap・計測表・【要確認】 ===');
{
  const xml = read('sitemap.xml');
  assert(xml.includes('<loc>https://mori-zeirishi.net/area/</loc>'), 'sitemap に /area/');
  assert(JSON.parse(read('analytics-page-map.json'))['/area/'], '計測表に /area/');
  const leaked = ['index.html', 'about.html', 'area/index.html'].filter(t => /【要確認】|【要用意】/.test(read(t)));
  assert(leaked.length === 0, '【要確認】【要用意】が無い');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
