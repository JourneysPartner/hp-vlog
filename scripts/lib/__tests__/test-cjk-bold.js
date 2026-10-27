'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const { normalizeBold } = require('../cjk-bold');
const { main: buildSite } = require('../../build');

const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const cases = [
  ['日本語の括弧', '取引先が**適格請求書（インボイス）**の保存', '取引先が<strong>適格請求書（インボイス）</strong>の保存'],
  ['HTML リンク', '消費税の**<a href="/blog/x/">輸出免税</a>**の対象', '消費税の<strong><a href="/blog/x/">輸出免税</a></strong>の対象'],
  ['複数の対', '**A**と**B**', '<strong>A</strong>と<strong>B</strong>'],
  ['半角空白', 'a ** b ** c', 'a ** b ** c'],
  ['開始側の空白', '** a**', '** a**'],
  ['終了側の空白', '**a **', '**a **'],
  ['タブ', '**\ta**と**b\t**', '**\ta**と**b\t**'],
  ['全角空白', '**　a**と**b　**', '**　a**と**b　**'],
  ['途中の空白', '**a b**', '<strong>a b</strong>'],
  ['片方だけの記号', '**片方だけ', '**片方だけ'],
  ['奇数個の記号', '**A**と**片方だけ', '<strong>A</strong>と**片方だけ'],
  ['行内コード', '`**code**` と **太字**', '`**code**` と <strong>太字</strong>'],
  ['複数バッククォートのコード', '`` `**code**` `` と **太字**', '`` `**code**` `` と <strong>太字</strong>'],
  ['行内コードを含む太字', '**前 `**code**` 後**', '<strong>前 `**code**` 後</strong>'],
  ['閉じていないバッククォート', '`未完 **太字**', '`未完 <strong>太字</strong>'],
  ['バッククォートのブロック', '```\n**x**\n```', '```\n**x**\n```'],
  ['チルダのブロック', '~~~js\n**x**\n~~~\n**外**', '~~~js\n**x**\n~~~\n<strong>外</strong>'],
  ['長いフェンスと内側の短いフェンス', '````md\n```\n**x**\n````\n**外**', '````md\n```\n**x**\n````\n<strong>外</strong>'],
  ['異なるフェンスでは閉じない', '```\n~~~\n**x**\n```\n**外**', '```\n~~~\n**x**\n```\n<strong>外</strong>'],
  ['字下げしたフェンス', '   ```js\n**x**\n   ```\n**外**', '   ```js\n**x**\n   ```\n<strong>外</strong>'],
  ['長い閉じフェンス', '~~~\n**x**\n~~~~\n**外**', '~~~\n**x**\n~~~~\n<strong>外</strong>'],
  ['文字付きフェンスでは閉じない', '```\n```text\n**x**\n```', '```\n```text\n**x**\n```'],
  ['閉じていないフェンス', '```\n**x**', '```\n**x**'],
  ['表のセル', '| **全額経費** | 説明 |', '| <strong>全額経費</strong> | 説明 |'],
  ['星が3個', '***強調***', '***強調***'],
  ['星が4個', '****強調****', '****強調****'],
  ['空の対', '****', '****'],
  ['長い星の並びを含む対', '**前***後**', '**前***後**'],
  ['長い星の対の後', '***強調***と**太字**', '***強調***と<strong>太字</strong>'],
  ['空白の対の後', '** 空白**と**太字**', '** 空白**と<strong>太字</strong>'],
  ['行をまたぐ記号', '行1**\n**行2', '行1**\n**行2'],
  ['CRLF の2行', '**a**\r\n**b**', '<strong>a</strong>\r\n<strong>b</strong>'],
  ['CRLF のコードブロック', '```\r\n**x**\r\n```\r\n**外**\r\n', '```\r\n**x**\r\n```\r\n<strong>外</strong>\r\n'],
  ['混在する改行', '**a**\r\n**b**\n**c**\r', '<strong>a</strong>\r\n<strong>b</strong>\n<strong>c</strong>\r'],
  ['Markdown リンク', '**[輸出免税](/blog/x/)**', '<strong>[輸出免税](/blog/x/)</strong>'],
  ['HTML の内容保持', '**<span>内容 &amp; 値</span>**', '<strong><span>内容 &amp; 値</span></strong>'],
  ['既存の strong', '<strong>既存</strong>と**追加**', '<strong>既存</strong>と<strong>追加</strong>'],
  ['空文字', '', ''],
];

async function main() {
  console.log('=== 太字の前処理 ===');
  for (const [label, input, expected] of cases) {
    const actual = normalizeBold(input);
    assert(actual === expected, label);
    if (actual !== expected) console.error(JSON.stringify({ expected, actual }));
  }
  for (const input of [undefined, null, 0, false, {}, [], new String('**a**')]) {
    assert(normalizeBold(input) === '', `文字列以外は空文字（${Object.prototype.toString.call(input)}）`);
  }
  assert(marked(normalizeBold('**[輸出免税](/blog/x/)**')) ===
    '<p><strong><a href="/blog/x/">輸出免税</a></strong></p>\n', '太字の内側の Markdown も変換する');
  assert(marked(normalizeBold('**通常の太字**')) === marked('**通常の太字**'), '従来の太字の HTML は変わらない');

  console.log('\n=== ビルドの結合テスト ===');
  let buildOk = true;
  const originalLog = console.log;
  try {
    console.log = () => {};
    buildSite();
  } catch (error) {
    buildOk = false;
    console.error(error.stack || String(error));
  } finally {
    console.log = originalLog;
  }
  assert(buildOk, 'main でサイトをビルドできる');
  if (!buildOk) return;

  const posts = fs.readdirSync(path.join(ROOT, 'content', 'posts'))
    .filter(file => file.endsWith('.md'))
    .map(file => ({ file, ...matter(fs.readFileSync(path.join(ROOT, 'content', 'posts', file), 'utf8')).data }))
    .filter(post => post.review_status === 'published');
  assert(posts.length > 0, '公開済みの記事を検査対象に含む');
  let missing = 0;
  let remaining = 0;
  for (const post of posts) {
    const htmlPath = path.join(ROOT, 'blog', post.slug, 'index.html');
    const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
    const article = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/);
    if (!article) {
      missing++;
      console.error(`${post.slug}: 記事 HTML または article 要素がありません`);
      continue;
    }
    const matches = [...article[0].matchAll(/\*\*/g)];
    if (matches.length) remaining++;
    for (const match of matches) {
      console.error(`${post.slug}: ${article[0].slice(Math.max(0, match.index - 30), match.index + 32)}`);
    }
  }
  assert(missing === 0, '公開済み全記事に article 要素がある');
  assert(remaining === 0, `公開済み ${posts.length} 記事の本文に ** が残らない（残存 ${remaining} 記事）`);
  const example = posts.find(post => post.slug === 'ebay-export-invoice-system-impact');
  const exampleHtml = fs.readFileSync(path.join(ROOT, 'blog', 'ebay-export-invoice-system-impact', 'index.html'), 'utf8');
  assert(exampleHtml.includes('<strong>国内取引の仕入税額控除</strong>'), '国内取引の仕入税額控除を strong で囲む');

  console.log('\n=== レビュー画面 ===');
  const reviewPage = require('../../../netlify/functions/review-page');
  const diffHtml = reviewPage.renderReviewPage('test.md', { refresh_of: 'published' }, '', '', {
    available: true,
    diff: [{ heading: '確認', changedParagraphs: {
      before: [{ text: '以前は**旧制度（控除）**の対象', changed: true }],
      after: [{ text: '今は**新制度（控除）**の対象', changed: true }],
    } }],
  });
  assert(diffHtml.includes('<strong>旧制度（控除）</strong>') && diffHtml.includes('<strong>新制度（控除）</strong>'),
    '差分の変更前・変更後の両方を前処理する');

  const api = require('../../../netlify/functions/lib/github-api');
  const { authenticatedEvent } = require('./review-auth-test-helpers');
  const originalGetFile = api.getFile;
  try {
    // 本文は既存のローカル記事から読み、付帯記録の取得はネットワークに出さない。
    api.getFile = async () => { throw new Error('404 not found'); };
    const response = await reviewPage.handler(authenticatedEvent({
      httpMethod: 'GET', queryStringParameters: { file: example.file },
    }));
    assert(response.statusCode === 200 && response.body.includes('<strong>国内取引の仕入税額控除</strong>'),
      'レビュー本文も前処理して表示する');
  } finally {
    api.getFile = originalGetFile;
  }
}

main().catch(error => {
  assert(false, 'テスト実行中に予期しないエラーがない');
  console.error(error.stack || String(error));
}).finally(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
