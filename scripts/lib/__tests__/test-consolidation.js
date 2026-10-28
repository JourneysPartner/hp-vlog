'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const matter = require('gray-matter');
const { main: buildSite } = require('../../build');
const { getExistingSlugs } = require('../../generate-draft');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
// Windows のチェックアウトは CRLF になる（core.autocrlf）。比較は LF に揃えて行う。
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

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
  {
    keep: 'ebay-taxable-vs-exempt-business',
    merged: 'ebay-just-opened-consumption-tax-judgement-practice',
    heading: 'eBayの売上に消費税はいつから関係する？課税事業者の判断基準｜手続きの進め方',
    moved: [
      'eBay売上の消費税課税事業者の判断基準を時系列で整理',
      '準備期間：eBayセラーが最初に確認する判定資料',
      '書類作成：必要書類の一覧と入手先',
      '提出：いつまでに、何を、どこに出すか',
      '事後確認：申告前に見直すべきミスと防止策',
      '期限に遅れた場合のペナルティと救済の考え方',
      '自分で進めやすいケースと、相談した方がよい境目',
    ],
    compareMain: true,
  },
  {
    keep: 'ebay-export-invoice-system-impact',
    merged: 'ebay-just-opened-invoice-judgement-guide',
    heading: 'eBayセラーはインボイス登録すべき？判断のポイント｜基本を整理',
    moved: [
      'eBayセラーのインボイス登録判断の全体像',
      '誰がインボイス登録を検討すべきか',
      'eBayセラー向け インボイス登録のセルフチェック',
      'よくある誤解と実務上の注意点',
      '開業直後のeBayセラーは何をすればよいか',
    ],
    compareMain: true,
  },
  {
    keep: 'ebay-growth-incorporation-threshold-guide',
    merged: 'ebay-growth-incorporation-threshold-practice',
    heading: 'eBay法人成り「いつから法人で売上計上するか」で迷わないための実務整理',
    moved: [
      'よくある誤解とその実態',
      '設立日を境にした実務処理の整理',
      '実務上の注意点：個人の廃業届と法人設立届は別に動く',
      '自分で判断できる範囲と、専門家に確認すべき範囲',
    ],
    compareMain: true,
  },
  {
    keep: 'ebay-growth-expense-grayzone-guide',
    merged: 'ebay-growth-expense-grayzone-practice',
    heading: 'eBay経費のグレーゾーン、実務でどう記録・判断する？保存書類と処理手順',
    moved: [
      'グレーゾーン経費の実務処理、核心は「証跡と按分根拠の記録」',
      'グレーゾーン経費の種類と実務処理フロー',
      '保存すべき書類の一覧チェックリスト',
      'よくある処理ミスと対策',
    ],
    compareMain: true,
  },
];

let passed = 0;
let failed = 0;
let skipped = 0;
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
      const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
      const parsed = matter(raw);
      return { file, raw, data: parsed.data, content: parsed.content };
    });
}

function extractH2(content, title) {
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) return '';
  let end = lines.findIndex((line, index) => index > start && (
    line.startsWith('## ') || /^「?本記事は情報提供を目的として/.test(line)
  ));
  if (end === -1) end = lines.length;
  return lines.slice(start, end)
    .map(line => /^#{1,6} /.test(line) ? `#${line}` : line)
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

// ビルドで出力する公開 HTML だけを再帰的に調べる。
function listHtmlFiles(directory) {
  const absolute = path.join(ROOT, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return listHtmlFiles(relative);
    return entry.isFile() && entry.name.endsWith('.html') ? [relative] : [];
  });
}
// build は非公開になった記事の古い出力を消さない。統合元の古い出力は公開されないので対象外にする。
const staleMergedDirs = pairs.map(pair => path.join('blog', pair.merged) + path.sep);
const publicHtmlFiles = ['index.html', ...['blog', 'services', 'area', 'pricing', 'tools'].flatMap(listHtmlFiles)]
  .filter(file => !staleMergedDirs.some(dir => file.startsWith(dir)));
const publicHtml = publicHtmlFiles.map(file => ({ file, html: read(file) }));
console.log(`公開 HTML の検査対象: ${publicHtml.length} ファイル`);
for (const pair of pairs) {
  const removedPath = `/blog/${pair.merged}/`;
  const linkedFiles = publicHtml
    .filter(({ html }) => html.includes(`href="${removedPath}"`) || html.includes(`href='/blog/${pair.merged}/'`))
    .map(({ file }) => file);
  assert(linkedFiles.length === 0, `${pair.merged}: すべての公開 HTML に統合元へのリンクがない${linkedFiles.length ? ': ' + linkedFiles.join(', ') : ''}`);
}
console.log(`sitemap.xml の URL 数: ${(sitemap.match(/<loc>/g) || []).length}`);

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

console.log('\n=== 5. 統合先のメタデータを main と比較 ===');
const mainPairs = pairs.filter(pair => pair.compareMain);
const mainFields = ['title', 'slug', 'related_slug', 'source_url'];
let mainPosts;
try {
  mainPosts = mainPairs.map(pair => {
    const keep = bySlug.get(pair.keep);
    const mainRaw = execFileSync('git', ['show', `origin/main:content/posts/${keep.file}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10000,
    });
    return { keep, main: matter(mainRaw).data };
  });
} catch (error) {
  // CI の浅いチェックアウトには origin/main が無い。git が使えない・参照が無いときは比較を飛ばす。
  skipped += mainPairs.length * mainFields.length;
  console.log(`  飛ばした: origin/main を読めないため main との比較を省略（${skipped} 項目、${String(error.message).split('\n')[0]}）`);
}
if (mainPosts) {
  for (const { keep, main } of mainPosts) {
    for (const field of mainFields) {
      assert(keep.data[field] === main[field], `${keep.data.slug}: ${field} は main と同じ`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
