'use strict';

const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const { linkCitations, applyExternalLinkRenderer } = require('./lib/citation-linker');
const { agencyLinksForTopic } = require('./lib/official-sources');
const { CATEGORIES, MACROS, getCategoryMeta, getCategorySlug, getMacroMeta, getMacroSlug } =
  require('./lib/blog-taxonomy');
const { generateSimulatorPublishing, validatePublishConfig } = require('./lib/publish-prep');
const { generateSimulatorCta } = require('./lib/simulator-cta');
const { generateRobotsTxt, generateSitemapXml, EXCLUDED_STATIC_PAGES } = require('./lib/sitemap');
const {
  BASE_URL, organizationSchema, personSchema, websiteSchema,
  breadcrumbSchema, faqSchema, articleSchema, serviceSchema, jsonLdScripts,
} = require('./lib/site-schema');
const { extractFaq, extractFaqFromHtml } = require('./lib/faq-extractor');
const { assignHubMacro, hubMacroOf } = require('./lib/hub-membership');
const { execFileSync } = require('child_process');

// ビルドログ用（R11: FAQ を出した記事数・執筆者欄を付けた記事数・業種の振り分け）
const buildStats = { faqPosts: 0, authorBoxPosts: 0 };

// 外部リンクに target="_blank" rel="noopener noreferrer" を付与する
// renderer 拡張を一度だけ適用する（marked は module singleton）。
applyExternalLinkRenderer(marked);

const POSTS_PER_PAGE = 12;

const ROOT         = path.join(__dirname, '..');
const POSTS_DIR    = path.join(ROOT, 'content', 'posts');
const TEMPLATES    = path.join(ROOT, 'templates');
const PARTIALS     = path.join(TEMPLATES, 'partials');
const PAGES_DIR    = path.join(TEMPLATES, 'pages');
const BLOG_OUT     = path.join(ROOT, 'blog');
const PUBLISH_CONFIG_PATH = path.join(ROOT, 'data', 'tax-simulator', 'publish-config.json');

const ANALYTICS_BEACON = `
<script>
(() => {
  if (location.hostname !== 'mori-zeirishi.net' || navigator.doNotTrack === '1') return;
  const data = { p: location.pathname };
  // 問い合わせページでは、どのページから来たか（サイト内のみ）を添える。
  // どの記事が問い合わせにつながったかを実測するため。
  if (location.pathname === '/contact.html' && document.referrer) {
    try {
      const from = new URL(document.referrer);
      if (from.hostname === location.hostname) data.r = from.pathname;
    } catch (e) {}
  }
  const body = JSON.stringify(data);
  if (!navigator.sendBeacon('/track', body)) {
    fetch('/track', { method: 'POST', body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  }
})();
</script>`;

// ── 共通パーシャル読み込み ──────────────────────────────────────
const HEADER_HTML = fs.readFileSync(path.join(PARTIALS, 'header.html'), 'utf8');
const FOOTER_HTML = fs.readFileSync(path.join(PARTIALS, 'footer.html'), 'utf8');
// <head> の共通部分（canonical / OG）。ページごとの値は buildStaticPages で埋める。
const HEAD_COMMON_TPL = fs.readFileSync(path.join(PARTIALS, 'head-common.html'), 'utf8');
// 記事末尾の執筆者欄。全記事に同じものを付ける（記事本文は変更しない）。
const AUTHOR_BOX_HTML = fs.readFileSync(path.join(PARTIALS, 'author-box.html'), 'utf8');

// ── テンプレート読み込み ─────────────────────────────────────────
function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
}

// ── パーシャルを注入（{{HEADER}} / {{FOOTER}} を置換）─────────
function injectPartials(html) {
  return html
    .replace(/\{\{HEADER\}\}/g, HEADER_HTML)
    .replace(/\{\{FOOTER\}\}/g, FOOTER_HTML)
    .replace(/\{\{AUTHOR_BOX_HTML\}\}/g, AUTHOR_BOX_HTML);
}

function injectAnalyticsBeacon(html) {
  if (html.includes("navigator.sendBeacon('/track'")) return html;
  if (!html.includes('</body>')) throw new Error('計測ビーコンを注入できません: </body> がありません');
  return html.replace('</body>', `${ANALYTICS_BEACON}\n</body>`);
}

// ── シンプルなテンプレート置換（{{KEY}} → value）────────────────
function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return vars[key] != null ? String(vars[key]) : '';
  });
}

// ── 日付フォーマット（日本語表示用）────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo',
  });
}

// ── ISO 8601 文字列化（タイムゾーン保持）───────────────────────
function toISO(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toISOString();
}

// ── 公開判定 ────────────────────────────────────────────────────
// 1. review_status === 'published' であること
// 2. publish_at が現在時刻以前であること（未来の予約記事はビルドしない）
// approve 時は review_status='approved' / publish_at=翌日11時台 に予約され、
// publish-scheduled ワークフローが due 記事だけを 'published' に昇格させる。
function isPublished(fm) {
  if (fm.review_status !== 'published') return false;
  if (!fm.publish_at) return false;
  return new Date(fm.publish_at) <= new Date();
}

// ── Markdown ファイルを読み込み、公開済みのものを返す ──────────
function loadPublishedPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];

  const files = fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();

  const posts = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { data: fm, content: body } = matter(raw);
    if (!isPublished(fm)) continue;
    posts.push({ ...fm, _body: body, _file: file });
  }

  // 公開日の降順
  posts.sort((a, b) => new Date(b.publish_at) - new Date(a.publish_at));
  return posts;
}

// ── カード HTML（白本体のみ。サマリー表示、ホバーで影） ──────
// カテゴリラベルには色トークンクラス（category--<slug>）を当て、
// チップ色だけでカテゴリ識別を保てるようにする。
function renderArticleCard(p, { headingLevel = 'h2' } = {}) {
  const date = formatDate(p.publish_at);
  const cat  = getCategoryMeta(p.category);
  const slug = cat ? cat.slug : 'misc';
  const label = p.category || '記事';
  const H = headingLevel;
  return `
    <article class="blog-card category--${slug}" data-aos="fade-up">
      <a href="/blog/${escAttr(p.slug)}/" class="blog-card-link">
        <div class="blog-card-body">
          <div class="blog-card-meta">
            <span class="blog-card-category">${escHtml(label)}</span>
            <time class="blog-card-date" datetime="${escAttr(toISO(p.publish_at))}">${date}</time>
          </div>
          <${H} class="blog-card-title">${escHtml(p.title)}</${H}>
          <p class="blog-card-summary">${escHtml(p.summary || '')}</p>
          <span class="blog-card-more">続きを読む <i class="bi bi-arrow-right"></i></span>
        </div>
      </a>
    </article>`;
}

// ── フィルタ pills（業種マクロ + 展開で全カテゴリ）──────────────
// 構造:
//   [すべて] [物販] [サロン] ... [一般事業者] [もっと見る ▾]
//   ── ここから展開時に表示 ──
//   ｜カテゴリーから探す｜ [所得税] [消費税] ... [海外取引]
// 展開トグルは JS（main.js）で aria-expanded を切り替え、
// hidden 属性で .blog-pills-extra の表示/非表示を制御する。
function renderMacroPills(allPosts, { activeSlug = null, allRoot = false, activeCategorySlug = null } = {}) {
  const macroCounts = new Map();
  const catCounts   = new Map();
  for (const p of allPosts) {
    // 業種の件数は「業種ページに載る記事」と一致させる（ペルソナ由来の所属を使う）
    const hub = hubMacroOf(p);
    if (hub)        macroCounts.set(hub,        (macroCounts.get(hub) || 0) + 1);
    if (p.category) catCounts.set(p.category,   (catCounts.get(p.category) || 0) + 1);
  }

  // ── マクロ（常時表示）──────────────────────────────
  const baseItems = [];
  baseItems.push(`<a href="/blog/" class="blog-pill ${allRoot ? 'is-active' : ''}">
    <span>すべて</span><span class="blog-pill-count">${allPosts.length}</span>
  </a>`);
  for (const m of MACROS) {
    const c = macroCounts.get(m.ja) || 0;
    if (c === 0) continue;
    const active = m.slug === activeSlug ? 'is-active' : '';
    baseItems.push(`<a href="/blog/macro/${m.slug}/" class="blog-pill ${active}">
      <i class="bi ${m.icon}"></i><span>${escHtml(m.ja)}</span><span class="blog-pill-count">${c}</span>
    </a>`);
  }

  // ── カテゴリ（展開時に表示）─────────────────────────
  const catItems = [];
  for (const c of CATEGORIES) {
    const cnt = catCounts.get(c.ja) || 0;
    if (cnt === 0) continue;
    const active = c.slug === activeCategorySlug ? 'is-active' : '';
    catItems.push(`<a href="/blog/category/${c.slug}/" class="blog-pill blog-pill--cat category--${c.slug} ${active}">
      <i class="bi ${c.icon}"></i><span>${escHtml(c.ja)}</span><span class="blog-pill-count">${cnt}</span>
    </a>`);
  }

  const toggle = catItems.length === 0 ? '' : `
    <button type="button" class="blog-pills-toggle"
            aria-expanded="false" aria-controls="blog-pills-extra"
            data-label-open="もっと見る" data-label-close="閉じる">
      <span class="blog-pills-toggle-label">もっと見る</span>
      <i class="bi bi-chevron-down" aria-hidden="true"></i>
    </button>`;

  const extra = catItems.length === 0 ? '' : `
    <div class="blog-pills-extra" id="blog-pills-extra" hidden>
      <span class="blog-pills-extra-label">カテゴリーから探す</span>
      ${catItems.join('\n')}
    </div>`;

  return `<nav class="blog-pills-nav" aria-label="フィルタ">
    <div class="blog-pills">
      ${baseItems.join('\n')}
      ${toggle}
    </div>
    ${extra}
  </nav>`;
}

// ── サイドバー（おすすめ + カテゴリ一覧）─────────────────────
// おすすめ = article_role='main' を優先し、公開日新しい順で4件
//          （priority/featured フィールドは未導入のため main role を採用）
function pickRecommended(allPosts, n = 4) {
  const mains = allPosts.filter(p => p.article_role === 'main');
  const pool = mains.length >= n ? mains : allPosts;
  return pool.slice(0, n);
}

function renderSidebar(allPosts, { activeCategorySlug = null } = {}) {
  const counts = new Map();
  for (const p of allPosts) {
    if (!p.category) continue;
    counts.set(p.category, (counts.get(p.category) || 0) + 1);
  }
  const recs = pickRecommended(allPosts, 4);
  const recItems = recs.map(p => {
    const cat = getCategoryMeta(p.category);
    const slug = cat ? cat.slug : 'misc';
    return `
    <li class="blog-side-rec">
      <a href="/blog/${escAttr(p.slug)}/" class="blog-side-rec-link">
        <span class="blog-side-rec-mark category--${slug}" aria-hidden="true"></span>
        <span class="blog-side-rec-body">
          <span class="blog-side-rec-cat">${escHtml(p.category || '')}</span>
          <span class="blog-side-rec-title">${escHtml(p.title)}</span>
        </span>
      </a>
    </li>`;
  }).join('\n');

  const catItems = CATEGORIES.map(c => {
    const cnt = counts.get(c.ja) || 0;
    if (cnt === 0) return '';
    const active = c.slug === activeCategorySlug ? 'is-active' : '';
    return `
    <li class="blog-side-cat-item ${active}">
      <a href="/blog/category/${c.slug}/" class="blog-side-cat-link">
        <span class="blog-side-cat-dot category--${c.slug}" aria-hidden="true"></span>
        <span class="blog-side-cat-name">${escHtml(c.ja)}</span>
        <span class="blog-side-cat-count">${cnt}</span>
      </a>
    </li>`;
  }).filter(Boolean).join('\n');

  return `
  <aside class="blog-sidebar" aria-label="ブログサイドバー">
    <section class="blog-side-block">
      <h2 class="blog-side-heading"><i class="bi bi-star-fill"></i> おすすめ記事</h2>
      <ul class="blog-side-rec-list">${recItems}</ul>
    </section>

    <section class="blog-side-block">
      <h2 class="blog-side-heading"><i class="bi bi-folder"></i> カテゴリーから探す</h2>
      <ul class="blog-side-cat-list">${catItems}</ul>
    </section>
  </aside>`;
}

// ── ページネーション ─────────────────────────────────────────
// basePath は末尾 / で終わる前提（例: '/blog/', '/blog/category/shotoku/'）。
// page=1 は basePath そのもの、それ以降は basePath + 'page/N/'。
function paginate(posts, perPage = POSTS_PER_PAGE) {
  const pages = [];
  for (let i = 0; i < posts.length; i += perPage) {
    pages.push(posts.slice(i, i + perPage));
  }
  if (pages.length === 0) pages.push([]); // 0件でも 1ページは出す
  return pages;
}

function pageUrl(basePath, pageNum) {
  if (pageNum <= 1) return basePath;
  return `${basePath}page/${pageNum}/`;
}

function renderPagination(currentPage, totalPages, basePath) {
  if (totalPages <= 1) return '';
  const prev = currentPage > 1
    ? `<a class="blog-pg-link" href="${pageUrl(basePath, currentPage - 1)}" rel="prev"><i class="bi bi-chevron-left"></i> 前へ</a>`
    : `<span class="blog-pg-link is-disabled"><i class="bi bi-chevron-left"></i> 前へ</span>`;
  const next = currentPage < totalPages
    ? `<a class="blog-pg-link" href="${pageUrl(basePath, currentPage + 1)}" rel="next">次へ <i class="bi bi-chevron-right"></i></a>`
    : `<span class="blog-pg-link is-disabled">次へ <i class="bi bi-chevron-right"></i></span>`;

  const nums = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === currentPage) {
      nums.push(`<span class="blog-pg-num is-active" aria-current="page">${i}</span>`);
    } else {
      nums.push(`<a class="blog-pg-num" href="${pageUrl(basePath, i)}">${i}</a>`);
    }
  }
  return `
  <nav class="blog-pagination" aria-label="ページネーション">
    ${prev}
    <span class="blog-pg-nums">${nums.join('')}</span>
    ${next}
  </nav>`;
}

// ── 一覧グリッド HTML（カード + 空表示） ────────────────────────
function renderListGrid(posts) {
  if (posts.length === 0) {
    return `<div class="blog-empty"><p>該当する記事はまだありません。</p></div>`;
  }
  return `<div class="blog-list-grid">\n${posts.map(p => renderArticleCard(p)).join('\n')}\n</div>`;
}

// ── 1 ページぶんの HTML を組み立てる（共通） ────────────────────
// vars: { TITLE, PAGE_HEADING, META_DESCRIPTION, FILTER_HINT, CANONICAL, ... }
function buildListPageHtml({
  tpl, allPosts, pagePosts, currentPage, totalPages, basePath,
  vars, activeCategorySlug = null, activeMacroSlug = null,
}) {
  // 「すべて」を active 表示するのは /blog/ ルート（カテゴリ/マクロ未適用）に限る
  const allRoot = activeCategorySlug == null && activeMacroSlug == null;
  const pills    = renderMacroPills(allPosts, {
    activeSlug: activeMacroSlug, allRoot, activeCategorySlug,
  });
  const sidebar  = renderSidebar(allPosts, { activeCategorySlug });
  const grid     = renderListGrid(pagePosts);
  const pg       = renderPagination(currentPage, totalPages, basePath);
  const canonical = vars.CANONICAL || pageUrl(basePath, currentPage);

  // パンくず: ホーム › 税務コラム › {見出し}（/blog/ 自体は2段）
  const crumbs = [{ name: 'ホーム', url: '/' }, { name: '税務コラム', url: '/blog/' }];
  if (basePath !== '/blog/') crumbs.push({ name: stripTags(vars.PAGE_HEADING), url: basePath });
  const structured = jsonLdScripts([
    organizationSchema(),
    personSchema(),
    breadcrumbSchema(crumbs),
  ]);

  return render(tpl, {
    PAGE_TITLE:        vars.PAGE_TITLE,
    PAGE_HEADING:      vars.PAGE_HEADING,
    PAGE_LEAD:         vars.PAGE_LEAD || '',
    META_DESCRIPTION:  vars.META_DESCRIPTION,
    SECTION_LABEL:     vars.SECTION_LABEL || 'Tax Column',
    FILTER_HINT:       vars.FILTER_HINT || '',
    CANONICAL_URL:     canonical,
    PILLS_HTML:        pills,
    SIDEBAR_HTML:      sidebar,
    POSTS_HTML:        grid,
    PAGINATION_HTML:   pg,
    BREADCRUMB_HTML:   breadcrumbHtml(crumbs),
    STRUCTURED_DATA:   structured,
  });
}

// ── 関連記事HTML生成（公開済みの場合のみ表示）─────────────────
function buildRelatedArticleHtml(post, postsMap) {
  if (!post.related_slug) return '';
  const related = postsMap.get(post.related_slug);
  if (!related) return '';

  const linkText = post.related_link_text || 'あわせて読みたい';
  const title    = related.title;
  const summary  = related.summary || '';

  return `
    <div class="blog-related-article">
      <h3><i class="bi bi-link-45deg"></i> ${escHtml(linkText)}</h3>
      <a href="/blog/${escAttr(related.slug)}/" class="blog-related-link">
        <span class="blog-related-title">${escHtml(title)}</span>
        <span class="blog-related-summary">${escHtml(summary)}</span>
        <span class="blog-related-more">この記事を読む <i class="bi bi-arrow-right"></i></span>
      </a>
    </div>`;
}

// ── 記事ページ生成 ──────────────────────────────────────────────
function generatePost(post, tpl, postsMap, publishConfig) {
  // 本文中の「国税庁タックスアンサー No.XXXX」をクリック可能リンクに変換
  // （過去記事のソース .md は変更せず、ビルド時の HTML 生成段階で適用）
  // 税以外の論点（社会保険など）に触れる記事では、本文中の官庁名も
  // その記事に適用された非税出典（official-sources.js）へリンクする。
  // frontmatter の source_url はテンプレートが1件しか表示しないため、
  // これが無いと読者は社会保険側の出典に辿れない。
  const { markdown: linkedBody, stats } = linkCitations(post._body, {
    agencyLinks: agencyLinksForTopic(post),
    onMiss: ({ no, matched }) => {
      console.warn(`[build]   ⚠ 出典番号がカタログ未収録: ${matched} (${post.slug}) — tax-authority-refs.js への追加を検討`);
    },
  });
  if (stats.guessed > 0) {
    console.log(`[build]   ℹ ${post.slug}: 出典リンク化 ${stats.linked} 件（うち推定 ${stats.guessed} 件 → カタログ追加候補）`);
  }
  if (stats.agenciesLinked > 0) {
    console.log(`[build]   ℹ ${post.slug}: 官庁名リンク化 ${stats.agenciesLinked} 件（${stats.agencies.join(' / ')}）`);
  }
  const htmlBody = marked(linkedBody)
    .replace(/<table>/g, '<div class="table-wrapper"><table>')
    .replace(/<\/table>/g, '</table></div>');
  const publishDateISO = toISO(post.publish_at);
  const updatedDateISO = toISO(post.updated_at || post.publish_at);
  const publishDate    = formatDate(post.publish_at);
  const updatedDate    = formatDate(post.updated_at);

  const updatedDateHtml = updatedDate && updatedDate !== publishDate
    ? `<span>更新日：${updatedDate}</span>`
    : '';

  const postUrl = `${BASE_URL}/blog/${post.slug}/`;

  // 記事の構造化データ。publisher / author は事務所・代表の @id を参照する。
  const structuredData = JSON.stringify(articleSchema({
    title: post.title,
    description: post.summary || '',
    url: postUrl,
    datePublished: publishDateISO,
    dateModified: updatedDateISO,
  })).replace(/</g, '\\u003c');

  // パンくず: ホーム › 税務コラム › {カテゴリ} › {記事}。
  // カテゴリが一覧の定義に無い（例: 法人税）ときはカテゴリ段を省く。
  const catMeta = getCategoryMeta(post.category);
  const crumbs = [{ name: 'ホーム', url: '/' }, { name: '税務コラム', url: '/blog/' }];
  if (catMeta) crumbs.push({ name: catMeta.ja, url: `/blog/category/${catMeta.slug}/` });
  crumbs.push({ name: post.title, url: `/blog/${post.slug}/` });

  // FAQ（「## よくある質問」節がある記事だけ）
  const faq = extractFaq(post._body);
  if (faq.length > 0) buildStats.faqPosts++;
  buildStats.authorBoxPosts++;

  const extraStructuredData = jsonLdScripts([
    organizationSchema(),
    personSchema(),
    breadcrumbSchema(crumbs),
    faqSchema(faq),
  ]);

  const relatedArticleHtml = buildRelatedArticleHtml(post, postsMap);
  const simulatorCtaHtml = generateSimulatorCta(post, publishConfig);

  return render(tpl, {
    TITLE:            escHtml(post.title),
    META_DESCRIPTION: escHtml(post.summary || ''),
    SLUG:             escAttr(post.slug),
    CATEGORY:         escHtml(post.category || ''),
    PUBLISH_DATE:     publishDate,
    UPDATED_DATE_HTML: updatedDateHtml,
    PUBLISH_AT_ISO:   publishDateISO,
    UPDATED_AT_ISO:   updatedDateISO,
    BODY:             htmlBody,
    SIMULATOR_CTA_HTML: simulatorCtaHtml,
    SOURCE_URL:       escAttr(post.source_url || ''),
    SOURCE_TITLE:     escHtml(post.source_title || post.source_url || ''),
    STRUCTURED_DATA:  structuredData,
    EXTRA_STRUCTURED_DATA: extraStructuredData,
    BREADCRUMB_HTML:  breadcrumbHtml(crumbs),
    RELATED_ARTICLE_HTML: relatedArticleHtml,
  });
}

// ── HTML エスケープ ──────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function stripTags(str) {
  return String(str || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ── パンくず（表示用）────────────────────────────────────────────
// style.css の .breadcrumb-custom（濃色背景向け）をそのまま使う。
// 最後の要素は現在ページなのでリンクにしない。
function breadcrumbHtml(items) {
  const list = (items || []).filter(i => i && i.name);
  if (list.length === 0) return '';
  const parts = list.map((item, i) => {
    const last = i === list.length - 1;
    return last
      ? `<span aria-current="page">${escHtml(item.name)}</span>`
      : `<a href="${escAttr(item.url)}">${escHtml(item.name)}</a>`;
  });
  return `<nav class="breadcrumb-custom" aria-label="パンくず">${parts.join('<span class="sep">›</span>')}</nav>`;
}

// ── 静的ページの最終更新日（sitemap の lastmod 用）──────────────
// git の最終コミット日を使う。取れない環境（浅いクローンなど）では空にして省略する。
function gitLastCommitDate(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', relPath], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : '';
  } catch (_error) {
    return '';
  }
}

// ── 静的ページの <head> 共通部分 ─────────────────────────────────
// canonical / OG をページごとの値で埋める。404 は検索対象外なので canonical を出さない。
function renderHeadCommon(entry, src) {
  const titleMatch = src.match(/<title>([\s\S]*?)<\/title>/i);
  const descMatch  = src.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  let head = render(HEAD_COMMON_TPL, {
    CANONICAL_PATH:  entry.pathname,
    OG_TYPE:         'website',
    OG_TITLE:        titleMatch ? titleMatch[1].trim() : '毛利順活税理士事務所',
    OG_DESCRIPTION:  descMatch ? descMatch[1] : '',
  });
  if (entry.src === '404.html') {
    head = head.split('\n').filter(line => !/rel="canonical"/.test(line)).join('\n');
  }
  return head.trim();
}

// ── トップページ用: 最新記事カード（style.css の .post-card を使用）──
function renderLatestPostCard(p, delay) {
  const date = formatDate(p.publish_at);
  return `
      <div class="col-md-4" data-aos="fade-up" data-aos-delay="${delay}">
        <article class="post-card">
          <a href="/blog/${escAttr(p.slug)}/" class="post-card-link">
            <div class="post-card-meta">
              <span class="post-card-category">${escHtml(p.category || '記事')}</span>
              <time class="post-card-date" datetime="${escAttr(toISO(p.publish_at))}">${date}</time>
            </div>
            <h3 class="post-card-title">${escHtml(p.title)}</h3>
            <p class="post-card-summary">${escHtml(p.summary || '')}</p>
            <span class="post-card-more">続きを読む <i class="bi bi-arrow-right"></i></span>
          </a>
        </article>
      </div>`;
}

function renderLatestPostsHtml(posts, n = 3) {
  const latest = posts.slice(0, n);
  if (latest.length === 0) {
    return `<div class="col-12 text-center"><p style="color:var(--color-text-muted);">記事は準備中です。</p></div>`;
  }
  return latest.map((p, i) => renderLatestPostCard(p, 100 + i * 50)).join('\n');
}

// ── 静的ページの一覧 ─────────────────────────────────────────────
// 出力先の規則（2026-09-03 段階2）:
//   templates/pages/<name>.html        → /<name>.html        （従来。既存URLを壊さない）
//   templates/pages/<dir>/<name>.html  → /<dir>/<name>/       （例: /services/ebay-export/）
//   DIR_OUTPUT_PAGES に載る直下のファイル → /<name>/            （例: /pricing/ /area/）
// templates/pages/tools/ はシミュレーター用で対象外（publish-prep が扱う）。
const DIR_OUTPUT_PAGES = new Set(['pricing.html', 'area.html']);
const EXCLUDED_PAGE_DIRS = new Set(['tools']);

function listStaticPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  const entries = [];
  for (const name of fs.readdirSync(PAGES_DIR).sort()) {
    const full = path.join(PAGES_DIR, name);
    const stat = fs.statSync(full);
    if (stat.isFile() && name.endsWith('.html')) {
      const base = name.replace(/\.html$/, '');
      if (DIR_OUTPUT_PAGES.has(name)) {
        entries.push({ src: name, out: path.join(base, 'index.html'), pathname: `/${base}/` });
      } else {
        entries.push({ src: name, out: name, pathname: name === 'index.html' ? '/' : `/${name}` });
      }
    } else if (stat.isDirectory() && !EXCLUDED_PAGE_DIRS.has(name)) {
      for (const sub of fs.readdirSync(full).filter(f => f.endsWith('.html')).sort()) {
        const base = sub.replace(/\.html$/, '');
        entries.push({ src: `${name}/${sub}`, out: path.join(name, base, 'index.html'), pathname: `/${name}/${base}/` });
      }
    }
  }
  return entries;
}

// 従来の呼び出し互換（直下の *.html だけ）
function listStaticPageFiles() {
  return listStaticPages().filter(e => !e.src.includes('/')).map(e => e.src);
}

// ── 静的ページ内の記述から拾うもの ──────────────────────────────
// パンくず（<div class="breadcrumb-custom">…</div>）を読み、BreadcrumbList の材料にする。
function parseStaticBreadcrumb(src) {
  const m = String(src || '').match(/<div class="breadcrumb-custom">([\s\S]*?)<\/div>/);
  if (!m) return [];
  const inner = m[1];
  const items = [];
  const linkRe = /<a href="([^"]*)">([\s\S]*?)<\/a>/g;
  let lm;
  let lastIndex = 0;
  while ((lm = linkRe.exec(inner)) !== null) {
    items.push({ name: stripTags(lm[2]), url: lm[1] });
    lastIndex = linkRe.lastIndex;
  }
  const tail = stripTags(inner.slice(lastIndex).replace(/<span class="sep">[\s\S]*?<\/span>/g, ' '));
  if (tail) items.push({ name: tail });
  return items;
}

// 関連記事の条件（<meta name="x-related-posts" content="...">）。
//   tax_domain=a,b;persona=x;pain=p;keyword=語1,語2   … どれか1つでも当たれば対象
function parseRelatedSpec(src) {
  const m = String(src || '').match(/<meta name="x-related-posts" content="([^"]*)">/);
  if (!m) return null;
  const spec = { tax_domain: [], persona: [], pain: [], keyword: [] };
  for (const part of m[1].split(';')) {
    const [key, value] = part.split('=').map(s => (s || '').trim());
    if (!key || !value || !(key in spec)) continue;
    spec[key] = value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return spec;
}

function selectRelatedPosts(posts, spec, n = 3) {
  if (!spec) return [];
  // 当たり方に強弱を付ける。題名・検索意図に語がある記事を先に、本文だけの記事は後に。
  //   3: tax_domain / persona / pain の一致、または題名・検索意図に語がある
  //   2: 要約に語がある
  //   1: 本文に語がある
  const score = (p) => {
    if (spec.tax_domain.includes(p.tax_domain)) return 3;
    if (spec.persona.includes(p.primary_persona)) return 3;
    if (spec.pain.includes(p.pain_point)) return 3;
    if (spec.keyword.length === 0) return 0;
    const strong = `${p.title || ''} ${p.search_intent || ''}`;
    if (spec.keyword.some(k => strong.includes(k))) return 3;
    if (spec.keyword.some(k => String(p.summary || '').includes(k))) return 2;
    if (spec.keyword.some(k => String(p._body || '').includes(k))) return 1;
    return 0;
  };
  // posts は公開日の降順に並んでいる（同点なら新しい順のまま）
  return posts
    .map((p, i) => ({ p, s: score(p), i }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map(x => x.p);
}

function renderRelatedPostsHtml(posts, spec) {
  const picked = selectRelatedPosts(posts, spec, 3);
  if (picked.length === 0) {
    return `<div class="col-12 text-center"><p style="color:var(--color-text-muted);">記事は準備中です。</p></div>`;
  }
  return picked.map((p, i) => renderLatestPostCard(p, 100 + i * 50)).join('\n');
}

// ── 静的ページ生成 ──────────────────────────────────────────────
function buildStaticPages(posts) {
  if (!fs.existsSync(PAGES_DIR)) return;

  const pages = listStaticPages();
  console.log(`[build] 静的ページ: ${pages.length} 件`);

  const latestPostsHtml = renderLatestPostsHtml(posts || []);

  for (const entry of pages) {
    const src = fs.readFileSync(path.join(PAGES_DIR, entry.src), 'utf8');
    const titleMatch = src.match(/<title>([\s\S]*?)<\/title>/i);
    const descMatch  = src.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    const h1Match    = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const pageUrlAbs = `${BASE_URL}${entry.pathname}`;

    // 事務所・代表の構造化データを全ページに。トップだけ WebSite も付ける。
    // パンくず・FAQ はページ内の記述から拾う。サービス専用ページには Service も付ける。
    const schemas = [organizationSchema(), personSchema()];
    if (entry.src === 'index.html') schemas.push(websiteSchema());
    schemas.push(breadcrumbSchema(parseStaticBreadcrumb(src)));
    schemas.push(faqSchema(extractFaqFromHtml(src)));
    if (entry.pathname.startsWith('/services/')) {
      schemas.push(serviceSchema({
        name: h1Match ? stripTags(h1Match[1]) : (titleMatch ? titleMatch[1].trim() : ''),
        description: descMatch ? descMatch[1] : '',
        url: pageUrlAbs,
      }));
    }
    const structured = `  ${jsonLdScripts(schemas)}\n</head>`;

    const relatedSpec = parseRelatedSpec(src);
    const html = injectAnalyticsBeacon(injectPartials(src))
      .replace(/\s*<meta name="x-related-posts" content="[^"]*">/, '')
      .replace(/\{\{HEAD_COMMON\}\}/g, renderHeadCommon(entry, src))
      .replace(/\{\{LATEST_POSTS_HTML\}\}/g, latestPostsHtml)
      .replace(/\{\{RELATED_POSTS_HTML\}\}/g, () => renderRelatedPostsHtml(posts || [], relatedSpec))
      .replace('</head>', structured);

    const outPath = path.join(ROOT, entry.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`[build]   → ${entry.out.replace(/\\/g, '/')}`);
  }
}

function writeAnalyticsPageMap(posts) {
  const map = {};
  // 404 は計測対象にしない（検索対象外・存在しないURLへのアクセス）
  for (const entry of listStaticPages().filter(e => e.src !== '404.html')) {
    const raw = fs.readFileSync(path.join(PAGES_DIR, entry.src), 'utf8');
    const match = raw.match(/<title>([\s\S]*?)<\/title>/i);
    const title = match ? match[1].trim().replace(/｜毛利順活税理士事務所$/, '') : entry.src;
    map[entry.pathname] = title;
  }
  map['/blog/'] = '税務コラム';
  for (const post of posts) if (post.slug) map[`/blog/${post.slug}/`] = post.title || post.slug;
  for (const category of CATEGORIES) {
    if (posts.some(post => post.category === category.ja)) map[`/blog/category/${category.slug}/`] = `${category.ja}の記事一覧`;
  }
  for (const macro of MACROS) {
    if (posts.some(post => hubMacroOf(post) === macro.ja)) map[`/blog/macro/${macro.slug}/`] = `${macro.ja}向けの記事`;
  }
  fs.writeFileSync(path.join(ROOT, 'analytics-page-map.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  console.log(`[build]   → analytics-page-map.json (${Object.keys(map).length} 件)`);
}

// ── エントリポイント ────────────────────────────────────────────
function main() {
  const posts = loadPublishedPosts();
  const publishConfig = validatePublishConfig(JSON.parse(
    fs.readFileSync(PUBLISH_CONFIG_PATH, 'utf8')
  ));
  console.log(`[build] 公開済み記事: ${posts.length} 件`);

  // 業種ハブへの所属を決める（frontmatter は変更しない。ペルソナ→業種で全記事を振り分ける）
  const hubCounts = assignHubMacro(posts);
  const hubSummary = [...hubCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ');
  console.log(`[build] 業種ハブへの振り分け: ${posts.length} 件（${hubSummary}）`);

  // 1. 静的ページ生成（テンプレートにパーシャルと最新記事を注入してルートへ出力）
  console.log('[build] 静的ページを生成しています...');
  buildStaticPages(posts);

  // 2. ブログ記事生成
  console.log('[build] ブログ記事を生成しています...');

  fs.mkdirSync(BLOG_OUT, { recursive: true });

  // テンプレート読み込み → パーシャル注入
  const listTpl = injectAnalyticsBeacon(injectPartials(readTemplate('blog-list.html')));
  const postTpl = injectAnalyticsBeacon(injectPartials(readTemplate('blog-post.html')));

  // slug → post のマップ（関連記事リンク用）
  const postsMap = new Map();
  for (const post of posts) {
    if (post.slug) postsMap.set(post.slug, post);
  }

  // 記事ページ
  for (const post of posts) {
    if (!post.slug) {
      console.warn(`[build] slug が未設定のためスキップ: ${post._file}`);
      continue;
    }
    const dir = path.join(BLOG_OUT, post.slug);
    fs.mkdirSync(dir, { recursive: true });
    const html = generatePost(post, postTpl, postsMap, publishConfig);
    fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
    console.log(`[build]   → blog/${post.slug}/index.html`);
  }

  // 一覧ページ（全件 + ページネーション）
  writePaginatedListing({
    tpl: listTpl,
    allPosts: posts,
    targetPosts: posts,
    basePath: '/blog/',
    outDir: BLOG_OUT,
    vars: {
      PAGE_TITLE:       '税務コラム｜毛利順活税理士事務所',
      PAGE_HEADING:     '税務コラム',
      PAGE_LEAD:        'eBay輸出・EC物販・クリエイター・相続など、<br class="d-none d-md-inline">実務に役立つ税務情報をお届けします。',
      META_DESCRIPTION: 'eBay輸出・EC物販・フリーランス・相続など、実務に役立つ税務情報をお届けします。毛利順活税理士事務所の税務コラム。',
    },
  });

  // カテゴリ別ページ
  for (const c of CATEGORIES) {
    const filtered = posts.filter(p => p.category === c.ja);
    if (filtered.length === 0) continue;
    writePaginatedListing({
      tpl: listTpl,
      allPosts: posts,
      targetPosts: filtered,
      basePath: `/blog/category/${c.slug}/`,
      outDir: path.join(BLOG_OUT, 'category', c.slug),
      activeCategorySlug: c.slug,
      vars: {
        PAGE_TITLE:       `${c.ja}に関する記事一覧｜税務コラム`,
        PAGE_HEADING:     `${c.ja}の記事一覧`,
        PAGE_LEAD:        `${c.ja}に関する実務情報をまとめてお届けします。`,
        META_DESCRIPTION: `${c.ja}に関する実務情報の一覧。毛利順活税理士事務所の税務コラム。`,
        SECTION_LABEL:    'Category',
      },
    });
  }

  // マクロ（業種）別ページ
  for (const m of MACROS) {
    const filtered = posts.filter(p => hubMacroOf(p) === m.ja);
    if (filtered.length === 0) continue;
    writePaginatedListing({
      tpl: listTpl,
      allPosts: posts,
      targetPosts: filtered,
      basePath: `/blog/macro/${m.slug}/`,
      outDir: path.join(BLOG_OUT, 'macro', m.slug),
      activeMacroSlug: m.slug,
      vars: {
        PAGE_TITLE:       `${m.ja}向け税務記事一覧｜税務コラム`,
        PAGE_HEADING:     `${m.ja}向けの記事`,
        PAGE_LEAD:        `${m.ja}に関わる方への実務情報をまとめています。`,
        META_DESCRIPTION: `${m.ja}向けの税務実務情報の一覧。毛利順活税理士事務所の税務コラム。`,
        SECTION_LABEL:    'Industry',
      },
    });
  }

  writeAnalyticsPageMap(posts);

  // 全ツールOFFでも、停止判定用statusと訂正履歴は常に更新する。
  console.log('[build] シミュレーター公開ファイルを生成しています...');
  const simulatorPublishing = generateSimulatorPublishing({ config: publishConfig });
  console.log(`[build]   → tools/simulator-status.json（公開 ${simulatorPublishing.enabledTypes.length} 件）`);
  console.log('[build]   → tools/corrections/index.html');

  // サイトマップは、上で実際に生成した固定ページ・記事・公開ツールだけを収録する。
  // 静的ページの lastmod は git の最終コミット日（取れなければ省略）。
  const allStatic = listStaticPages();
  const staticPages = allStatic
    .filter(e => e.src !== '404.html' && e.src !== 'index.html')
    .map(e => ({ pathname: e.pathname, lastmod: gitLastCommitDate(`templates/pages/${e.src}`) }));
  const sitemapXml = generateSitemapXml({
    posts,
    staticPages,
    indexLastmod: gitLastCommitDate('templates/pages/index.html'),
    publishConfig,
    correctionsGenerated: fs.existsSync(path.join(ROOT, 'tools', 'corrections', 'index.html')),
  });
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemapXml, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'robots.txt'), generateRobotsTxt(), 'utf8');
  console.log('[build]   → sitemap.xml / robots.txt');

  console.log(`[build] FAQ の構造化データ: ${buildStats.faqPosts} 件 ／ 執筆者欄: ${buildStats.authorBoxPosts} 件`);
  console.log('[build] 完了');
}

// ── ページネーション付き一覧書き出し ────────────────────────────
function writePaginatedListing({
  tpl, allPosts, targetPosts, basePath, outDir, vars,
  activeCategorySlug = null, activeMacroSlug = null,
}) {
  const pages = paginate(targetPosts, POSTS_PER_PAGE);
  for (let i = 0; i < pages.length; i++) {
    const currentPage = i + 1;
    const html = buildListPageHtml({
      tpl, allPosts, pagePosts: pages[i], currentPage, totalPages: pages.length,
      basePath, vars, activeCategorySlug, activeMacroSlug,
    });
    let writeDir;
    if (currentPage === 1) {
      writeDir = outDir;
    } else {
      writeDir = path.join(outDir, 'page', String(currentPage));
    }
    fs.mkdirSync(writeDir, { recursive: true });
    fs.writeFileSync(path.join(writeDir, 'index.html'), html, 'utf8');
    const relDir = path.relative(ROOT, writeDir).replace(/\\/g, '/');
    console.log(`[build]   → ${relDir}/index.html (${pages[i].length} 件)`);
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ main, buildStaticPages, generatePost, buildListPageHtml });
