'use strict';
/**
 * 表示速度の基本（2026-09-03 並行B）
 *
 * 何をやめたか:
 *   外部CSSを3か所（Bootstrap・Bootstrap Icons・AOS）から読み、Webフォントを6ウェイト読み、
 *   見出しがアニメーション待ちで表示されていた。
 *   AOS は廃止、アイコンは使っている分だけの SVG スプライトを同梱、フォントは2ウェイト、
 *   スクリプトは defer、CSS/JS/画像にキャッシュ設定。
 *
 * このテストはビルド後の生成物を読んで確認する（冒頭でビルドを実行する）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

console.log('=== 0. ビルド ===');
{
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { ok = false; console.log(String(e.stderr || e.message).slice(0, 600)); }
  assert(ok, 'ビルドが成功する');
}

// 検査対象: 静的ページ・一覧・業種ハブ・記事（tools/ は対象外）
const blogDir = path.join(ROOT, 'blog');
const postSlugs = fs.readdirSync(blogDir).filter(d => !['category', 'macro', 'page'].includes(d) && fs.existsSync(path.join(blogDir, d, 'index.html')));
const targets = [
  'index.html', 'about.html', 'services.html', 'voice.html', 'contact.html', 'privacy.html', '404.html',
  'pricing/index.html', 'area/index.html', 'services/ebay-export/index.html',
  'blog/index.html', 'blog/macro/index.html', 'blog/macro/salon/index.html', 'blog/category/shotoku/index.html',
  ...postSlugs.slice(0, 5).map(s => `blog/${s}/index.html`),
].filter(t => fs.existsSync(path.join(ROOT, t)));

console.log('');
console.log(`=== 1. AOS が無い（${targets.length} ファイル）===`);
{
  const bad = targets.filter(t => /data-aos|unpkg\.com\/aos/.test(read(t)));
  assert(bad.length === 0, `data-aos と aos.css / aos.js が無い${bad.length ? '（' + bad.slice(0, 3).join(', ') + '）' : ''}`);
  assert(!/AOS\.init/.test(read('assets/js/main.js')), 'main.js に AOS.init が無い');
  assert(!/\[data-aos\]/.test(read('assets/css/style.css')), 'style.css に [data-aos] の規則が無い');
}

console.log('');
console.log('=== 2. フォントは2ウェイト ===');
{
  const bad = targets.filter(t => {
    const m = read(t).match(/fonts\.googleapis\.com\/css2\?([^"]+)"/);
    return !m || !m[1].includes('Noto+Sans+JP:wght@400;700') || !m[1].includes('Zen+Old+Mincho:wght@700') || /wght@400;500|;900/.test(m[1]);
  });
  assert(bad.length === 0, `Noto Sans JP 400/700・Zen Old Mincho 700 だけを読む${bad.length ? '（' + bad.slice(0, 3).join(', ') + '）' : ''}`);
  const css = read('assets/css/style.css') + read('assets/css/blog.css');
  assert(!/font-weight:\s*(500|900)\b/.test(css), 'CSS に font-weight 500 / 900 が残っていない');
}

console.log('');
console.log('=== 3. スクリプトは defer ===');
{
  const bad = targets.filter(t => {
    const html = read(t);
    const bs = html.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@[^"]+"[^>]*>/);
    const mj = html.match(/<script src="\/assets\/js\/main\.js"[^>]*>/);
    return !bs || !/\bdefer\b/.test(bs[0]) || !mj || !/\bdefer\b/.test(mj[0]);
  });
  assert(bad.length === 0, `bootstrap.bundle と main.js に defer がある${bad.length ? '（' + bad.slice(0, 3).join(', ') + '）' : ''}`);
}

console.log('');
console.log('=== 4. アイコンは同梱の SVG スプライト ===');
{
  assert(fs.existsSync(path.join(ROOT, 'templates', 'partials', 'icons.svg')), 'templates/partials/icons.svg がある');
  const sprite = read('templates/partials/icons.svg');
  const names = new Set([...sprite.matchAll(/id="bi-([a-z0-9-]+)"/g)].map(m => m[1]));
  assert(names.size >= 70, `スプライトに ${names.size} 種のアイコン`);
  const noCss = targets.filter(t => /bootstrap-icons/.test(read(t)));
  assert(noCss.length === 0, `Bootstrap Icons の CSS を読んでいない${noCss.length ? '（' + noCss.slice(0, 3).join(', ') + '）' : ''}`);
  const noSprite = targets.filter(t => !/class="icon-sprite"/.test(read(t)));
  assert(noSprite.length === 0, `各ページにスプライトが1回入る${noSprite.length ? '（' + noSprite.slice(0, 3).join(', ') + '）' : ''}`);
  let emptyI = 0, svgI = 0, unknown = new Set();
  for (const t of targets) {
    const html = read(t);
    for (const m of html.matchAll(/<i class="bi bi-([a-z0-9-]+)[^"]*"[^>]*>(<\/i>|<svg><use href="#bi-([a-z0-9-]+)"\/><\/svg><\/i>)/g)) {
      if (m[2] === '</i>') { emptyI++; unknown.add(m[1]); } else svgI++;
    }
  }
  assert(svgI > 100 && emptyI === 0, `<i class="bi …"> がすべて SVG 入りになる（SVG入り ${svgI}、空のまま ${emptyI}${unknown.size ? '：' + [...unknown].join(',') : ''}）`);
  assert(/i\.bi\s*>\s*svg/.test(read('assets/css/style.css')), 'style.css に i.bi > svg の寸法指定がある');
}

console.log('');
console.log('=== 5. キャッシュ設定 ===');
{
  const toml = read('netlify.toml');
  assert(/for = "\/assets\/css\/\*"[\s\S]*?max-age=3600, must-revalidate/.test(toml), '/assets/css/* に 1時間・再検証');
  assert(/for = "\/assets\/js\/main\.js"[\s\S]*?max-age=3600, must-revalidate/.test(toml), '/assets/js/main.js に 1時間・再検証');
  assert(/for = "\/assets\/images\/\*"[\s\S]*?max-age=604800/.test(toml), '/assets/images/* に 1週間');
  assert(/for = "\/assets\/js\/tax-simulator\.\*\.js"[\s\S]*?immutable/.test(toml), 'シミュレーターの設定は不変');
}

console.log('');
console.log('=== 6. 画像の属性 ===');
{
  const post = read(`blog/${postSlugs[0]}/index.html`);
  assert(/<img src="\/assets\/images\/author-mori\.png"[^>]*width="96"[^>]*height="96"[^>]*loading="lazy"/.test(post), '執筆者の画像に width / height / loading="lazy"');
}

console.log('');
console.log('=== 7. tools/ は触っていない ===');
{
  const tools = fs.existsSync(path.join(ROOT, 'templates', 'pages', 'tools'))
    ? fs.readdirSync(path.join(ROOT, 'templates', 'pages', 'tools')) : [];
  assert(tools.length > 0, 'templates/pages/tools がそのまま存在する');
}

console.log('');
console.log('=== 8. フォント CSS は非同期・CDN は先に接続 ===');
{
  function htmlFiles(dir) {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return ['tools', '_shared'].includes(entry.name) ? [] : htmlFiles(rel);
      }
      return entry.name.endsWith('.html') ? [rel] : [];
    });
  }

  const pageTemplates = htmlFiles('templates/pages');
  const fontTemplates = [
    ...pageTemplates,
    'templates/blog-list.html', 'templates/blog-post.html',
    'templates/blog-hub.html', 'templates/blog-hub-index.html',
  ];
  const staticPages = pageTemplates.map(t => {
    const rel = t.replace('templates/pages/', '');
    return rel.includes('/') || ['pricing.html', 'area.html'].includes(rel)
      ? rel.replace(/\.html$/, '/index.html') : rel;
  });
  // 既存の標本検査は残し、追加分は全テンプレート・全生成ページを調べる。
  const fontTargets = [...fontTemplates, ...staticPages, ...htmlFiles('blog')];
  const fontUrl = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&family=Zen+Old+Mincho:wght@700&display=swap';
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const checks = [
    ['全ページのフォント stylesheet に media="print" と onload がある', (html, active, links) =>
      links.length === 1 && attr(links[0], 'href') === fontUrl &&
      attr(links[0], 'media') === 'print' && attr(links[0], 'onload') === "this.media='all'"],
    ['同じフォント URL の preload as="style" がある', (html, active) =>
      (active.match(/<link\b[^>]*>/g) || []).some(tag =>
        attr(tag, 'rel') === 'preload' && attr(tag, 'href') === fontUrl && attr(tag, 'as') === 'style')],
    ['同じフォント URL の noscript stylesheet がある', html =>
      (html.match(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/g) || []).some(block =>
        (block.match(/<link\b[^>]*>/g) || []).some(tag =>
          attr(tag, 'rel') === 'stylesheet' && attr(tag, 'href') === fontUrl && attr(tag, 'media') === null))],
    // JavaScript 無効時だけ有効な noscript は、表示を止める通常の link から除く。
    ['noscript 以外に media の無いフォント stylesheet が無い', (html, active, links) =>
      links.every(tag => attr(tag, 'media') !== null)],
    ['Bootstrap CSS より前に jsDelivr の preconnect がある', (html, active) => {
      const tags = active.match(/<link\b[^>]*>/g) || [];
      const preconnect = tags.findIndex(tag => attr(tag, 'rel') === 'preconnect' && attr(tag, 'href') === 'https://cdn.jsdelivr.net');
      const bootstrap = tags.findIndex(tag => attr(tag, 'rel') === 'stylesheet' && /^https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@/.test(attr(tag, 'href') || ''));
      return preconnect >= 0 && bootstrap > preconnect;
    }],
  ];
  for (const [label, check] of checks) {
    const bad = fontTargets.filter(t => {
      if (!fs.existsSync(path.join(ROOT, t))) return true;
      const html = read(t);
      const active = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/g, '');
      const links = (active.match(/<link\b[^>]*>/g) || []).filter(tag =>
        attr(tag, 'rel') === 'stylesheet' && /^https:\/\/fonts\.googleapis\.com\/css2\?/.test(attr(tag, 'href') || ''));
      return !check(html, active, links);
    });
    assert(bad.length === 0, `${label}（${fontTargets.length} ファイル）${bad.length ? '：' + bad.slice(0, 3).join(', ') : ''}`);
  }

  const css = read('assets/css/style.css');
  for (const [name, expected] of [
    ['--font-family', "'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif"],
    ['--font-display', "'Zen Old Mincho', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', serif"],
  ]) {
    const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
    assert(m && m[1].trim() === expected, `${name} の先頭書体を保ち、指定の代替書体を順に含む`);
  }
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
