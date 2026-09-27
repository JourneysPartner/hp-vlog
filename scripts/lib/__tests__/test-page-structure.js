'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { Marked } = require('marked');
const {
  main: buildSite,
  generatePost,
  buildRelatedArticlesHtml,
  isPublished,
} = require('../../build');
const {
  slugifyHeading,
  createHeadingState,
  applyHeadingIdRenderer,
  buildTocHtml,
} = require('../heading-anchors');
const { linkTerms } = require('../internal-linker');
const { applyExternalLinkRenderer } = require('../citation-linker');
const { assignHubMacro } = require('../hub-membership');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const counts = new Map();
let passed = 0;
let failed = 0;
function check(group, condition, label) {
  if (!counts.has(group)) counts.set(group, { passed: 0, failed: 0 });
  const result = counts.get(group);
  if (condition) {
    passed++;
    result.passed++;
    console.log(`  PASS [${group}] ${label}`);
  } else {
    failed++;
    result.failed++;
    console.error(`  FAIL [${group}] ${label}`);
  }
}

function quietly(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function loadPublishedPosts() {
  const posts = fs.readdirSync(POSTS_DIR)
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => {
      const { data, content } = matter(fs.readFileSync(path.join(POSTS_DIR, file), 'utf8'));
      return { ...data, _body: content, _file: file };
    })
    .filter(isPublished)
    .sort((a, b) => new Date(b.publish_at) - new Date(a.publish_at));
  assignHubMacro(posts);
  return posts;
}

function sitemapUrls(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

function hrefSlugs(html) {
  return [...String(html).matchAll(/href="\/blog\/([^/]+)\/"/g)].map(match => match[1]);
}

function publishedPost(slug, options = {}) {
  return {
    slug,
    title: options.title || `${slug} 共通テーマの解説`,
    summary: `${slug} の概要`,
    review_status: options.review_status || 'published',
    publish_at: options.publish_at || '2020-01-01T00:00:00+09:00',
    _hubMacro: options.hub || 'サロン',
    primary_persona: options.persona || 'beauty_salon_owner',
    category: '所得税',
    cluster: 'common-cluster',
    subcluster: 'common-subcluster',
    search_intent: '共通テーマ 判断 手順',
    primary_question: '共通テーマをどう判断するか',
  };
}

function fakePost(slug, body) {
  return {
    ...publishedPost(slug),
    title: '見出しテスト記事',
    _body: body,
    source_url: 'https://www.nta.go.jp/',
    source_title: '国税庁',
  };
}

function htmlFilesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...htmlFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

console.log('=== R1 見出し id ===');
check('R1', slugifyHeading('【①】 見出し（テスト）！', new Set()) === '見出しテスト', '記号と丸数字を除去する');
check('R1', slugifyHeading('英字   と 日本語', new Set()) === '英字-と-日本語', '空白をハイフン 1 つにまとめる');
const duplicateIds = new Set();
check('R1', slugifyHeading('Same', duplicateIds) === 'same' && slugifyHeading('Same', duplicateIds) === 'same-2', '英字を小文字化して重複に連番を付ける');
check('R1', slugifyHeading('■■●▶', new Set()) === 'section', '空の見出しは section にする');
check('R1', slugifyHeading('2026 年の確認', new Set()) === 's-2026-年の確認', '数字始まりに s- を付ける');

const markedForHeadings = new Marked();
const localHeadingState = createHeadingState();
applyHeadingIdRenderer(markedForHeadings, localHeadingState);
localHeadingState.reset();
const headingHtml = markedForHeadings.parse('## 同じ見出し\n\n### 小見出し\n\n## 同じ見出し');
const headingIds = [...headingHtml.matchAll(/<h[23] id="([^"]+)"/g)].map(match => match[1]);
check('R1', headingIds.length === 3 && new Set(headingIds).size === 3, 'h2・h3 の id が記事内で重複しない');

console.log('\n=== R2 目次 ===');
const fourBody = 'リード文です。\n\n## 同じ見出し\n\n### 小見出し\n\n## 同じ見出し\n\n## 第三\n\n## 第四';
const fourPost = fakePost('toc-four', fourBody);
const fourHtml = quietly(() => generatePost(
  fourPost, '{{BODY}}', new Map([[fourPost.slug, fourPost]]), {},
  { coreSlugs: new Set(), allPosts: [fourPost] }
));
const bodyH2Ids = [...fourHtml.matchAll(/<h2 id="([^"]+)"/g)].map(match => match[1]);
const tocHtml = (fourHtml.match(/<nav class="blog-toc"[\s\S]*?<\/nav>/) || [''])[0];
const tocIds = [...tocHtml.matchAll(/href="#([^"]+)"/g)].map(match => match[1]);
check('R2', bodyH2Ids.length === 4 && JSON.stringify(tocIds) === JSON.stringify(bodyH2Ids), '目次のアンカーが全 h2 の id と一致する');
check('R2', fourHtml.indexOf('class="blog-toc"') < fourHtml.indexOf('<h2'), '目次が最初の h2 より前にある');
const threeBody = 'リード\n\n## 一\n\n## 二\n\n## 三';
const threePost = fakePost('toc-three', threeBody);
const threeHtml = quietly(() => generatePost(
  threePost, '{{BODY}}', new Map([[threePost.slug, threePost]]), {},
  { coreSlugs: new Set(), allPosts: [threePost] }
));
check('R2', !threeHtml.includes('class="blog-toc"'), 'h2 が 3 本以下なら目次を出さない');
check('R2', buildTocHtml('<h2 id="a">A</h2>', { minH2: 1 }).includes('href="#a"'), '描画済み HTML から目次を作れる');

console.log('\n=== R3 関連記事 ===');
const current = publishedPost('current');
current.related_slug = 'pair';
current.related_link_text = '比較はこちら';
const relatedPosts = [
  current,
  publishedPost('pair', { publish_at: '2020-01-02T00:00:00+09:00' }),
  publishedPost('same-hub-new', { publish_at: '2020-01-04T00:00:00+09:00' }),
  publishedPost('same-hub-old', { publish_at: '2020-01-03T00:00:00+09:00' }),
  publishedPost('other-hub', { hub: '建設', persona: 'construction_solo' }),
  publishedPost('draft', { review_status: 'draft' }),
];
const relatedMap = new Map(relatedPosts.map(post => [post.slug, post]));
const relatedHtml = buildRelatedArticlesHtml(current, relatedMap, { coreSlugs: new Set(), allPosts: relatedPosts });
const relatedSlugs = hrefSlugs(relatedHtml);
check('R3', relatedSlugs.length <= 3, '関連記事は最大 3 本');
check('R3', relatedSlugs[0] === 'pair', '公開中のペアを 1 本目にする');
check('R3', !relatedSlugs.includes('current') && !relatedSlugs.includes('draft'), '自分自身と未公開記事を除く');
check('R3', new Set(relatedSlugs).size === relatedSlugs.length, '関連記事に重複がない');
check('R3', relatedHtml.includes('<small>比較はこちら</small>'), 'ペアに related_link_text を添える');

const netshop = publishedPost('netshop-current', { hub: '物販', persona: 'domestic_ec_seller' });
netshop.related_slug = 'core-pair';
const corePair = publishedPost('core-pair', { hub: '物販', persona: 'domestic_ec_seller' });
const replacement = publishedPost('replacement', { hub: '物販', persona: 'domestic_ec_seller' });
const netshopPosts = [netshop, corePair, replacement];
const netshopHtml = buildRelatedArticlesHtml(
  netshop,
  new Map(netshopPosts.map(post => [post.slug, post])),
  { coreSlugs: new Set(['core-pair']), allPosts: netshopPosts }
);
const netshopSlugs = hrefSlugs(netshopHtml);
check('R3', netshopSlugs[0] === 'replacement' && !netshopSlugs.includes('core-pair'), '物販では中核枠を除き別の物販記事へ差し替える');

console.log('\n=== R4 文脈リンク ===');
const basePost = publishedPost('source-post', { title: '別テーマの記事' });
const termTarget = publishedPost('simple-tax-target', { title: '簡易課税の解説' });
const termMap = new Map([[basePost.slug, basePost], [termTarget.slug, termTarget]]);
const protectedMarkdown = [
  '# 簡易課税',
  '| 簡易課税 |',
  '[簡易課税](/already/)',
  '![簡易課税](/image.png)',
  '`簡易課税`',
  '<strong data-term="簡易課税">簡易課税</strong>',
  '本文の簡易課税です。',
].join('\n\n');
const linked = linkTerms(protectedMarkdown, {
  terms: [{ term: '簡易課税', slug: termTarget.slug, macros: ['サロン'], enabled: true }],
  post: basePost,
  postsMap: termMap,
  isPublished,
  hubMacroOf: post => post._hubMacro,
  coreSlugs: new Set(),
});
check('R4', linked.stats.linked === 1 && (linked.markdown.match(/\/blog\/simple-tax-target\//g) || []).length === 1, '用語は初出のリンク可能な 1 回だけリンクする');
check('R4', linked.markdown.includes('# 簡易課税') && linked.markdown.includes('| 簡易課税 |'), '見出し行と表の行を変更しない');
check('R4', linked.markdown.includes('[簡易課税](/already/)') && linked.markdown.includes('![簡易課税](/image.png)') && linked.markdown.includes('`簡易課税`'), '既存リンク・画像・インラインコードを変更しない');
check('R4', linked.markdown.includes('data-term="簡易課税"') && linked.markdown.includes('<strong data-term="簡易課税">[簡易課税]'), 'HTML 属性を守り、タグの中身はリンクできる');

const manyTerms = ['用語甲', '用語乙', '用語丙', '用語丁', '用語戊'];
const manyTargets = manyTerms.map((term, index) => publishedPost(`target-${index}`, { title: `${term}の解説` }));
const manyMap = new Map([[basePost.slug, basePost], ...manyTargets.map(post => [post.slug, post])]);
const manyLinked = linkTerms(manyTerms.join(' '), {
  terms: manyTerms.map((term, index) => ({ term, slug: `target-${index}`, macros: ['サロン'], enabled: true })),
  post: basePost,
  postsMap: manyMap,
  isPublished,
  hubMacroOf: post => post._hubMacro,
  coreSlugs: new Set(),
});
check('R4', manyLinked.stats.linked === 4 && (manyLinked.markdown.match(/\]\(\/blog\//g) || []).length === 4, '1 記事の文脈リンクを最大 4 本にする');

const overlapTargets = [
  publishedPost('small-asset', { title: '少額減価償却資産の解説' }),
  publishedPost('depreciation', { title: '減価償却の解説' }),
];
const overlap = linkTerms('少額減価償却資産を確認します。', {
  terms: [
    { term: '減価償却', slug: 'depreciation', macros: ['サロン'], enabled: true },
    { term: '少額減価償却資産', slug: 'small-asset', macros: ['サロン'], enabled: true },
  ],
  post: basePost,
  postsMap: new Map([[basePost.slug, basePost], ...overlapTargets.map(post => [post.slug, post])]),
  isPublished,
  hubMacroOf: post => post._hubMacro,
  coreSlugs: new Set(),
});
check('R4', overlap.stats.linked === 1 && overlap.markdown.includes('/blog/small-asset/'), '重なる用語は長い語を先に処理してリンク内を除外する');

const excluded = quietly(() => linkTerms('簡易課税 免税事業者 商品券', {
  terms: [
    { term: '簡易課税', slug: termTarget.slug, macros: ['建設'], enabled: true },
    { term: '免税事業者', slug: 'disabled-target', macros: ['サロン'], enabled: false },
    { term: '商品券', slug: 'missing-target', macros: ['サロン'], enabled: true },
  ],
  post: basePost,
  postsMap: termMap,
  isPublished,
  hubMacroOf: post => post._hubMacro,
  coreSlugs: new Set(),
}));
check('R4', excluded.stats.linked === 0 && excluded.markdown === '簡易課税 免税事業者 商品券', 'macros 外・無効・未公開の対象を使わない');
const ownTitle = linkTerms('簡易課税を本文でも説明します。', {
  terms: [{ term: '簡易課税', slug: termTarget.slug, macros: ['サロン'], enabled: true }],
  post: { ...basePost, title: '簡易課税の主題記事' },
  postsMap: termMap,
  isPublished,
  hubMacroOf: post => post._hubMacro,
  coreSlugs: new Set(),
});
check('R4', ownTitle.stats.linked === 0, '自分の題名に含む用語はリンクしない');
const emptyTerms = linkTerms('本文はそのままです。', { terms: [] });
check('R4', emptyTerms.markdown === '本文はそのままです。' && emptyTerms.stats.linked === 0, '辞書が空でも失敗しない');
const markedForLinks = new Marked();
applyExternalLinkRenderer(markedForLinks);
const internalLinkHtml = markedForLinks.parse(linked.markdown);
check('R4', internalLinkHtml.includes('href="/blog/simple-tax-target/"') && !internalLinkHtml.match(/href="\/blog\/simple-tax-target\/"[^>]*target=/), '内部リンクに target=_blank を付けない');

console.log('\n=== R5 title ===');
const postTemplate = read(path.join('templates', 'blog-post.html'));
check('R5', postTemplate.includes('<title>{{TITLE}}｜毛利税理士事務所</title>'), '記事 title の事務所名を短縮する');
check('R5', postTemplate.includes('<meta property="og:title" content="{{TITLE}}｜毛利税理士事務所">'), '記事 og:title の事務所名を短縮する');

console.log('\n=== R6 回帰確認 ===');
const posts = loadPublishedPosts();
const articlePaths = new Set(posts.map(post => path.join(ROOT, 'blog', post.slug, 'index.html')));
const nonArticleFiles = htmlFilesUnder(ROOT).filter(file => {
  const relative = path.relative(ROOT, file);
  if (relative.startsWith(`node_modules${path.sep}`)) return false;
  if (relative.startsWith(`content${path.sep}`)) return false;
  return !articlePaths.has(file);
});
const nonArticleBefore = new Map(nonArticleFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));
const sitemapBefore = sitemapUrls(read('sitemap.xml'));
let buildError = null;
try {
  quietly(buildSite);
} catch (error) {
  buildError = error;
}
check('R6', buildError === null, `ビルド関数を直接実行できる${buildError ? `: ${buildError.message}` : ''}`);
const sitemapAfter = sitemapUrls(read('sitemap.xml'));
check('R6', sitemapBefore.length === sitemapAfter.length && JSON.stringify(sitemapBefore) === JSON.stringify(sitemapAfter), 'sitemap.xml の URL 数と一覧が変わらない');
const changedNonArticles = [...nonArticleBefore].filter(([file, html]) => fs.readFileSync(file, 'utf8') !== html);
check('R6', changedNonArticles.length === 0, `一覧・ハブ・静的ページの HTML が変わらない${changedNonArticles.length ? `: ${changedNonArticles.map(([file]) => path.relative(ROOT, file)).join(', ')}` : ''}`);
const inheritanceHtml = read(path.join('blog', 'inheritance-within-10months-inheritance-filing-guide', 'index.html'));
check('R6', inheritanceHtml.includes('<h2 id=') && inheritanceHtml.includes('class="blog-toc"') && inheritanceHtml.includes('class="blog-related-list"'), '相続の代表記事に見出し id・目次・関連記事がある');
const packageJson = JSON.parse(read('package.json'));
check('R6', packageJson.scripts['masters:test'].includes('test-page-structure.js'), 'test-page-structure.js を masters:test に登録する');

console.log('\n=== 結果 ===');
for (const [group, result] of counts) console.log(`${group}: PASS ${result.passed} / FAIL ${result.failed}`);
console.log(`合計: PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
