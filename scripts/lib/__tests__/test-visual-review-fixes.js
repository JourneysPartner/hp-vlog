'use strict';
/**
 * 目視レビュー反映（2026-09-04）
 *
 * 毛利がプレビュー（PR #560）を見て指摘した点の再発防止:
 *   1. ヘッダーのメニューが「ホー／ム」のように途中で折り返さない（white-space: nowrap）
 *   2. 強みのリード文が PC で1行に収まる幅（.section-lead--wide）
 *   3. 強みカード04は「「自利利他」の」／「経営理念」で改行
 *   4. お問い合わせフォームは送信後に /contact-thanks.html（noindex・sitemap 対象外）へ
 *   5. 事務所概要の表と代表メッセージの署名がスマホで1行（CSS）
 *   6. スマホの「取扱業務」は一覧を開かず /services.html へ移動する（PC はドロップダウン）
 *
 * ビルド後の生成物とテンプレート・CSS を読んで確認する。
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
// CSS から「セレクタ { … }」のブロックを取り出す（メディアクエリ内も含めて最初の一致）
function cssBlock(css, selector) {
  const idx = css.indexOf(selector + ' {');
  if (idx < 0) return '';
  return css.slice(idx, css.indexOf('}', idx) + 1);
}

console.log('=== 0. ビルド ===');
{
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { ok = false; console.log(String(e.stderr || e.message).slice(0, 600)); }
  assert(ok, 'ビルドが成功する');
}

const css = read('assets/css/style.css');
const header = read('templates/partials/header.html');
const index = read('index.html');

console.log('');
console.log('=== 1. ヘッダー: メニューを折り返さない・スマホの取扱業務は移動する ===');
{
  assert(/white-space:\s*nowrap/.test(cssBlock(css, '#header .nav-link')), '.nav-link に white-space: nowrap');
  assert(css.includes('@media (min-width: 992px) and (max-width: 1199.98px)') && css.includes('@media (min-width: 1200px) and (max-width: 1399.98px)'), '992〜1199px・1200〜1399px で文字と余白を詰める段階がある');
  assert(!/btn-header-cta ms-lg-3/.test(header), 'ボタンの余白は CSS 側で持つ（ms-lg-3 を使わない）');
  assert(/class="nav-link dropdown-toggle d-none d-lg-block" href="\/services\.html"[^>]*data-bs-toggle="dropdown"/.test(header), 'PC 用の「取扱業務」はドロップダウン（lg 以上だけ表示）');
  assert(/class="nav-link d-lg-none" href="\/services\.html"/.test(header), 'スマホ用の「取扱業務」は /services.html への通常リンク');
  const mobileLink = header.match(/<a class="nav-link d-lg-none"[^>]*>/)[0];
  assert(!/data-bs-toggle/.test(mobileLink), 'スマホ用リンクにドロップダウンの属性が無い');
  assert((index.match(/href="\/services\.html"[^>]*>取扱業務<\/a>/g) || []).length === 2, '生成物にも PC 用・スマホ用の2本が出る');
}

console.log('');
console.log('=== 2. トップ: 強みのリード1行・04カードの改行位置 ===');
{
  assert(index.includes('<p class="section-lead section-lead--wide">国税局出身の税理士として、公的機関での実務経験を活かした信頼性の高いサービスを提供します。</p>'), '強みのリードに section-lead--wide');
  assert(/\.section-lead--wide \{ max-width: 8\d\dpx; \}/.test(css), '.section-lead--wide は 800px 台');
  assert(index.includes('<h3>「自利利他」の<br>経営理念</h3>'), '04カードは「自利利他」の／経営理念 で改行');
}

console.log('');
console.log('=== 3. お問い合わせ: 送信後は自前の完了ページへ ===');
{
  const contact = read('contact.html');
  assert(/<form method="POST" action="\/contact-thanks\.html" data-netlify="true" name="contact-hp"/.test(contact), 'フォームの action が /contact-thanks.html');
  assert(exists('contact-thanks.html'), 'contact-thanks.html が生成される');
  const thanks = exists('contact-thanks.html') ? read('contact-thanks.html') : '';
  assert(thanks.includes('<meta name="robots" content="noindex">'), '完了ページは noindex');
  assert(!thanks.includes('rel="canonical"'), '完了ページに canonical を出さない');
  assert(!thanks.includes('{{'), '完了ページに未置換のプレースホルダが無い');
  assert(!read('sitemap.xml').includes('contact-thanks'), 'sitemap に完了ページを載せない');
  assert(read('.gitignore').split(/\r?\n/).includes('/contact-thanks.html'), '生成物の完了ページは git 管理外');
}

console.log('');
console.log('=== 4. 事務所紹介: 概要表と署名はスマホでも1行 ===');
{
  const about = read('about.html');
  assert(about.includes('<span class="about-signature">毛利順活税理士事務所　毛利 順活</span>'), '署名に about-signature');
  assert(/white-space:\s*nowrap/.test(cssBlock(css, '.about-signature')), '署名は折り返さない');
  const mobile = css.slice(css.indexOf('.about-signature { font-size: clamp('));
  assert(/\.about-table th, \.about-table td \{ padding: 14px 12px; font-size: 0\.95rem; \}/.test(mobile) && /\.about-table th \{ width: auto; \}/.test(mobile), 'スマホでは表の見出し列と余白を詰める');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
