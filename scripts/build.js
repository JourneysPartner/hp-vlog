'use strict';

const fs   = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const ROOT         = path.join(__dirname, '..');
const POSTS_DIR    = path.join(ROOT, 'content', 'posts');
const TEMPLATES    = path.join(ROOT, 'templates');
const PARTIALS     = path.join(TEMPLATES, 'partials');
const PAGES_DIR    = path.join(TEMPLATES, 'pages');
const BLOG_OUT     = path.join(ROOT, 'blog');

// ── 共通パーシャル読み込み ──────────────────────────────────────
const HEADER_HTML = fs.readFileSync(path.join(PARTIALS, 'header.html'), 'utf8');
const FOOTER_HTML = fs.readFileSync(path.join(PARTIALS, 'footer.html'), 'utf8');

// ── テンプレート読み込み ─────────────────────────────────────────
function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
}

// ── パーシャルを注入（{{HEADER}} / {{FOOTER}} を置換）─────────
function injectPartials(html) {
  return html
    .replace(/\{\{HEADER\}\}/g, HEADER_HTML)
    .replace(/\{\{FOOTER\}\}/g, FOOTER_HTML);
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

// ── ブログ一覧ページ生成 ────────────────────────────────────────
function generateList(posts, tpl) {
  let postsHtml;
  if (posts.length === 0) {
    postsHtml = `<div class="blog-empty"><p>現在公開中の記事はありません。</p></div>`;
  } else {
    const cards = posts.map(p => {
      const date = formatDate(p.publish_at);
      return `
    <article class="blog-card" data-aos="fade-up">
      <a href="/blog/${escHtml(p.slug)}/" class="blog-card-link">
        <div class="blog-card-meta">
          <span class="blog-card-category">${escHtml(p.category || '')}</span>
          <time class="blog-card-date" datetime="${escAttr(toISO(p.publish_at))}">${date}</time>
        </div>
        <h2 class="blog-card-title">${escHtml(p.title)}</h2>
        <p class="blog-card-summary">${escHtml(p.summary || '')}</p>
        <span class="blog-card-more">続きを読む <i class="bi bi-arrow-right"></i></span>
      </a>
    </article>`;
    }).join('\n');
    postsHtml = `<div class="blog-list-grid">\n${cards}\n</div>`;
  }

  return render(tpl, { POSTS_HTML: postsHtml });
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
function generatePost(post, tpl, postsMap) {
  const htmlBody = marked(post._body)
    .replace(/<table>/g, '<div class="table-wrapper"><table>')
    .replace(/<\/table>/g, '</table></div>');
  const publishDateISO = toISO(post.publish_at);
  const updatedDateISO = toISO(post.updated_at || post.publish_at);
  const publishDate    = formatDate(post.publish_at);
  const updatedDate    = formatDate(post.updated_at);

  const updatedDateHtml = updatedDate && updatedDate !== publishDate
    ? `<span>更新日：${updatedDate}</span>`
    : '';

  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.summary || '',
    datePublished: publishDateISO,
    dateModified: updatedDateISO,
    author: {
      '@type': 'Person',
      name: '毛利順活',
    },
    publisher: {
      '@type': 'Organization',
      name: '毛利順活税理士事務所',
      url: 'https://mori-zeirishi.net',
    },
  });

  const relatedArticleHtml = buildRelatedArticleHtml(post, postsMap);

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
    SOURCE_URL:       escAttr(post.source_url || ''),
    SOURCE_TITLE:     escHtml(post.source_title || post.source_url || ''),
    STRUCTURED_DATA:  structuredData,
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

// ── 静的ページ生成 ──────────────────────────────────────────────
function buildStaticPages() {
  if (!fs.existsSync(PAGES_DIR)) return;

  const pages = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.html'));
  console.log(`[build] 静的ページ: ${pages.length} 件`);

  for (const page of pages) {
    const src = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8');
    const html = injectPartials(src);
    fs.writeFileSync(path.join(ROOT, page), html, 'utf8');
    console.log(`[build]   → ${page}`);
  }
}

// ── エントリポイント ────────────────────────────────────────────
function main() {
  // 1. 静的ページ生成（テンプレートにパーシャルを注入してルートへ出力）
  console.log('[build] 静的ページを生成しています...');
  buildStaticPages();

  // 2. ブログ記事生成
  console.log('[build] ブログ記事を生成しています...');

  fs.mkdirSync(BLOG_OUT, { recursive: true });

  // テンプレート読み込み → パーシャル注入
  const listTpl = injectPartials(readTemplate('blog-list.html'));
  const postTpl = injectPartials(readTemplate('blog-post.html'));

  const posts = loadPublishedPosts();
  console.log(`[build] 公開済み記事: ${posts.length} 件`);

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
    const html = generatePost(post, postTpl, postsMap);
    fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
    console.log(`[build]   → blog/${post.slug}/index.html`);
  }

  // 一覧ページ
  const listHtml = generateList(posts, listTpl);
  fs.writeFileSync(path.join(BLOG_OUT, 'index.html'), listHtml, 'utf8');
  console.log('[build]   → blog/index.html');

  console.log('[build] 完了');
}

main();
