'use strict';
/**
 * 依頼前の疑問に答えるサービスページ（クロール改善 08）
 *
 * 生成物を対象に、共通の進め方・料金案内とページ別追記が
 * FAQ 構造化データを含めて反映されることを確認する。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { personSchema } = require('../site-schema');

const ROOT = path.join(__dirname, '..', '..', '..');
const normalizeLf = (value) => String(value || '').replace(/\r\n?/g, '\n');
const read = (rel) => normalizeLf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function jsonLd(html) {
  const values = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    try { values.push(JSON.parse(match[1])); } catch (_) { values.push({ __invalid: true }); }
  }
  return values;
}

const SERVICES = ['ebay-export', 'online-seller', 'tax-return', 'bookkeeping', 'startup', 'tax-audit', 'inheritance'];
const FLOW = ['お問い合わせ（フォーム・LINE・電話）', '30 分の無料オンライン面談', 'お見積り', 'ご契約', '資料の受け渡し'];
const ADDED_FAQ = {
  'ebay-export': ['免税事業者ですが、還付は受けられますか。', '還付金はいつ入りますか。', '入金データや売上明細は何を用意すればよいですか。', 'eBay 以外の越境 EC も頼めますか。', '料金はいくらですか。'],
  'online-seller': ['どのプラットフォームに対応していますか。', '売上の集計はどこまでやってもらえますか。', '副業（会社員）でも頼めますか。', 'note や Kindle、オンラインサロンの収入も同じページの対象ですか。', '会計ソフトは何を使いますか。'],
  'tax-return': ['申告だけ（スポット）で頼めますか。', '何年も申告していません。相談できますか。', '一人親方ですが、何を用意すればよいですか。', 'YouTube や PR 案件の収入はどう申告しますか。'],
  bookkeeping: ['毎月の流れを教えてください。', '予約システムや POS のデータは使えますか。', '会計ソフトは何を使いますか。'],
  startup: ['設立の手続きはどこまでやってもらえますか。', '法人化すると得ですか。'],
  'tax-audit': ['調査の前に何をすればよいですか。'],
  inheritance: ['生前の相談もできますか。'],
};

console.log('=== 0. 生成物 ===');
assert(SERVICES.every(slug => fs.existsSync(path.join(ROOT, 'services', slug, 'index.html'))), '7ページの生成物がある');

console.log('');
console.log('=== 1. 共通部品 ===');
for (const slug of SERVICES) {
  const html = read(`services/${slug}/index.html`);
  const flowPositions = FLOW.map(label => html.indexOf(`<h4>${label}</h4>`));
  assert(flowPositions.every(pos => pos >= 0) && flowPositions.every((pos, i) => i === 0 || flowPositions[i - 1] < pos), `${slug}: 進め方が指定の5段階・順序`);
  assert((html.match(/class="flow-step"/g) || []).length === 5, `${slug}: 進め方は5段階だけ`);
  assert(html.includes('料金の目安と見積り') && html.includes('href="/pricing/">料金ページ</a>'), `${slug}: 料金案内と料金ページへのリンク`);
  assert(html.indexOf('料金の目安と見積り') > html.indexOf('進め方'), `${slug}: 料金案内は進め方の直後`);
  assert(html.includes('担当は国税局で法人税・所得税・消費税・相続税など主要な税目を 20 年余り扱ってきた税理士です。全国オンラインで対応しています。'), `${slug}: CTA 前に事務所紹介`);
}

console.log('');
console.log('=== 2. ページ別の内容と FAQ 構造化データ ===');
for (const slug of SERVICES) {
  const html = read(`services/${slug}/index.html`);
  const faq = jsonLd(html).find(item => item && item['@type'] === 'FAQPage');
  const questions = faq ? (faq.mainEntity || []).map(item => item.name) : [];
  const missing = ADDED_FAQ[slug].filter(question => !questions.includes(question));
  assert(!!faq && missing.length === 0, `${slug}: 追加 FAQ が FAQPage に含まれる`);

  const examples = html.match(/<h2 class="section-heading">ご相談の例（想定）<\/h2>([\s\S]*?)<\/section>/);
  const exampleCount = examples ? (examples[1].match(/<li>/g) || []).length : 0;
  assert(exampleCount === 2, `${slug}: 「ご相談の例（想定）」が2件`);
}
{
  const ebay = read('services/ebay-export/index.html');
  assert(ebay.includes('還付申告をお受けする条件') && ebay.includes('免税事業者'), 'ebay-export: 還付申告の条件と免税事業者の説明');
  const startup = read('services/startup/index.html');
  assert(startup.includes('法人化を判断する目安') && startup.includes('href="/tools/hojinnari-simulator/"'), 'startup: 法人成りシミュレーターへのリンク');
}

console.log('');
console.log('=== 3. 禁止数値・経歴文・URL ===');
{
  const sourceFiles = SERVICES.map(slug => `templates/pages/services/${slug}.html`).concat([
    'templates/pages/services/_shared/flow.html',
    'templates/pages/services/_shared/pricing-estimate.html',
    'templates/pages/services/_shared/office-intro.html',
  ]);
  const source = sourceFiles.map(read).join('\n');
  const yenAmounts = source.match(/[0-9０-９][0-9０-９,，]*\s*万?円/g) || [];
  const caseCounts = source.match(/[0-9０-９]+\s*件/g) || [];
  assert(JSON.stringify(yenAmounts) === JSON.stringify(['65万円']) && caseCounts.length === 0, '金額・件数は変更前からある「65万円」以外に増えていない');
}
{
  const career = '国税局で法人税・所得税・消費税・相続税など主要な税目を 20 年余り担当し、税理士として独立。ネット販売・個人事業主・相続の税務を全国オンラインで支援しています。';
  assert(read('about.html').includes(career), '事務所紹介に経歴文がある');
  assert(read('templates/partials/author-box.html').includes(career), '執筆者欄に経歴文がある');
  assert(personSchema().description === career, 'Person の description が経歴文と一致');
}
{
  const sitemap = read('sitemap.xml');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  const urlHash = crypto.createHash('sha256').update(urls.join('\n')).digest('hex');
  assert(urls.length === 308 && urlHash === '110b031913d6afdc2cfdf39ec255cbc5b91ae34edde54c98488b7e58d46f488d', 'sitemap.xml の URL と件数が変更前と同じ');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
