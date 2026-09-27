'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const build = require(path.join(ROOT, 'scripts/build.js'));
const { HUB_CONTENT } = require(path.join(ROOT, 'scripts/lib/hub-content'));
const { SERVICE_PAGES } = require(path.join(ROOT, 'scripts/lib/service-links'));

const results = Object.fromEntries(['R1', 'R2', 'R3', 'R4'].map(key => [key, { passed: 0, failed: 0 }]));

function check(group, condition, label) {
  if (condition) {
    results[group].passed++;
    console.log(`  PASS [${group}] ${label}`);
  } else {
    results[group].failed++;
    console.error(`  FAIL [${group}] ${label}`);
  }
}

function quiet(action) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};
    return action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function sitemapUrls(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

const config = JSON.parse(read('data/service-segments.json'));
const serviceEntries = Object.entries(config).filter(([slug]) => slug !== '_note');
const segments = serviceEntries.flatMap(([serviceSlug, entries]) =>
  entries.map(entry => ({ serviceSlug, ...entry })));
const sitemapBefore = sitemapUrls(read('sitemap.xml'));

console.log('\n=== 07-R1: サービス区分の設定 ===');
check('R1', serviceEntries.every(([slug, entries]) => SERVICE_PAGES[slug] && Array.isArray(entries)),
  'サービス slug はすべて service-links.js に定義済み');
check('R1', segments.every(entry => HUB_CONTENT[entry.hub]), 'hub はすべて実在する');
check('R1', segments.every(entry => !/\d/.test(entry.label) && !/\d/.test(entry.blurb)),
  'label / blurb に数値を含めない');
check('R1', segments.every(entry => entry.label.trim() && entry.blurb.trim()), 'label / blurb は空でない');

const warnings = [];
const preparedWithInvalid = build.prepareServiceSegments({
  ...config,
  'unknown-service': [{ label: '未知', blurb: '未知', hub: 'construction' }],
  'tax-return': [...config['tax-return'], { label: '未知ハブ', blurb: '未知ハブ', hub: 'missing-hub' }],
}, message => warnings.push(message));
check('R1', !preparedWithInvalid['unknown-service']
  && !preparedWithInvalid['tax-return'].some(entry => entry.hub === 'missing-hub')
  && warnings.length === 2,
'未知のサービスとハブは警告して飛ばす');

console.log('\n=== 07-R2: サービスページの節 ===');
const templateSlugs = Object.keys(SERVICE_PAGES);
check('R2', templateSlugs.every((slug) => {
  const html = read(`templates/pages/services/${slug}.html`);
  const token = html.indexOf('{{SERVICE_SEGMENTS_HTML}}');
  return token > html.indexOf('>できること</h2>') && token < html.indexOf('>進め方</h2>')
    && (html.match(/\{\{SERVICE_SEGMENTS_HTML\}\}/g) || []).length === 1;
}), '全サービスのテンプレートで「できること」の直後・「進め方」の前に置く');

const prepared = build.prepareServiceSegments(config, () => {});
const rendered = build.renderServiceSegmentsHtml('tax-return', prepared);
check('R2', rendered.includes('<span class="section-label">For You</span>')
  && rendered.includes('対応している業種・働き方')
  && rendered.includes('divider-orange'), '既存の節見出し部品を使う');
check('R2', rendered.includes('class="service-card"') && rendered.includes('class="service-link"')
  && !rendered.includes('<script'), '既存カードを再利用し JavaScript を足さない');
check('R2', build.renderServiceSegmentsHtml('ebay-export', prepared) === '',
  '設定が空のサービスは節を出さない');

let emptyBuildOk = true;
let emptyTaxReturnHtml = '';
try {
  const emptyConfig = { ...config, 'tax-return': [] };
  quiet(() => build.buildStaticPages([], undefined, { serviceSegments: emptyConfig, warn() {} }));
  emptyTaxReturnHtml = read('services/tax-return/index.html');
} catch (error) {
  emptyBuildOk = false;
  console.error(`  空配列ビルドの詳細: ${error.message}`);
}
check('R2', emptyBuildOk && !emptyTaxReturnHtml.includes('対応している業種・働き方'),
  '空配列でもビルドが成功し、節を丸ごと出さない');

let fullBuildOk = true;
try {
  quiet(() => build.main());
} catch (error) {
  fullBuildOk = false;
  console.error(`  通常ビルドの詳細: ${error.message}`);
}
check('R2', fullBuildOk, '通常設定のビルドが成功する');

const taxReturnHtml = read('services/tax-return/index.html');
const ebayHtml = read('services/ebay-export/index.html');
check('R2', taxReturnHtml.includes('一人親方・建設業')
  && taxReturnHtml.includes('インフルエンサー・クリエイター・YouTuber')
  && taxReturnHtml.includes('href="/blog/macro/construction/"')
  && taxReturnHtml.includes('href="/blog/macro/influencer/"'),
'確定申告ページに対象区分とハブへのリンクが出る');
check('R2', !ebayHtml.includes('対応している業種・働き方'), 'eBay 輸出ページには節が出ない');

console.log('\n=== 07-R3: 業種ハブからサービスへの導線 ===');
const requiredServices = {
  construction: ['tax-return', 'bookkeeping'],
  content: ['online-seller', 'tax-return'],
  influencer: ['tax-return', 'startup'],
  youtube: ['tax-return'],
};
check('R3', Object.entries(requiredServices).every(([hub, services]) =>
  services.every(service => HUB_CONTENT[hub].services.includes(service))),
'指定されたハブが必要なサービスをすべて含む');
check('R3', Object.entries(requiredServices).every(([hub, services]) => HUB_CONTENT[hub].services[0] === services[0]),
  '記事対応と同じサービスを各ハブの先頭にする');
const constructionHtml = read('blog/macro/construction/index.html');
check('R3', constructionHtml.includes('href="/services/tax-return/"'),
  '建設ハブに確定申告サービスへのリンクが出る');

console.log('\n=== 07-R4: 回帰確認 ===');
const sitemapAfter = sitemapUrls(read('sitemap.xml'));
check('R4', JSON.stringify(sitemapAfter) === JSON.stringify(sitemapBefore),
  'sitemap.xml の URL 数と一覧が変わらない');
const packageJson = JSON.parse(read('package.json'));
check('R4', packageJson.scripts['masters:test'].includes('test-service-segments.js'),
  'test-service-segments.js を masters:test に登録する');

const passed = Object.values(results).reduce((sum, value) => sum + value.passed, 0);
const failed = Object.values(results).reduce((sum, value) => sum + value.failed, 0);
console.log('\n=== 結果 ===');
for (const [group, value] of Object.entries(results)) {
  console.log(`${group}: PASS ${value.passed} / FAIL ${value.failed}`);
}
console.log(`合計: PASS ${passed} / FAIL ${failed}`);
process.exit(failed === 0 ? 0 : 1);
