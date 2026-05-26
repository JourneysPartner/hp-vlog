'use strict';

/**
 * citation-linker のテスト。
 *   node scripts/lib/__tests__/test-citation-linker.js
 *
 * 本文中の「国税庁タックスアンサー No.XXXX」表記が、
 * カタログ/レンジ推定で URL に変換され Markdown リンク化されることを確認する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { linkCitations, applyExternalLinkRenderer, findExistingLinkRanges } =
  require(path.join(ROOT, 'scripts/lib/citation-linker'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. カタログ収録番号 ─────────────────────────────────────────
console.log('\n=== Test 1: カタログ収録番号がリンク化される ===');
{
  const src = '詳しくは国税庁タックスアンサー No.1350 を参照してください。';
  const { markdown, stats } = linkCitations(src);
  assert(/\[国税庁タックスアンサー No\.1350\]\(https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/shotoku\/1350\.htm\)/.test(markdown),
    'No.1350 が事業所得ページのリンクに変換');
  assert(stats.linked === 1 && stats.fromCatalog === 1, 'fromCatalog=1');
}

// ── 2. 鉤括弧タイトル付き ──────────────────────────────────────
console.log('\n=== Test 2: 鉤括弧タイトル付きをまるごとリンク化 ===');
{
  const src = '国税庁タックスアンサー No.2080「白色申告者の記帳・帳簿等の保存」が根拠です。';
  const { markdown, stats } = linkCitations(src);
  assert(/\[国税庁タックスアンサー No\.2080「白色申告者の記帳・帳簿等の保存」\]\(https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/shotoku\/2080\.htm\)/.test(markdown),
    '鉤括弧タイトル込みで一つのリンク');
  assert(stats.fromCatalog === 1, 'カタログ命中');
}

// ── 3. 接頭辞なし「No.XXXX」だけ ────────────────────────────────
console.log('\n=== Test 3: 接頭辞なし No.XXXX だけでも検出 ===');
{
  const src = 'No.6501 を参照。';
  const { markdown, stats } = linkCitations(src);
  assert(/\[No\.6501\]\(https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/shohi\/6501\.htm\)/.test(markdown),
    'No.6501（納税義務の免除）');
  assert(stats.fromCatalog === 1, 'カタログ命中');
}

// ── 4. カタログ未収録だがレンジ推定可 ──────────────────────────
console.log('\n=== Test 4: 未収録番号はレンジ推定でリンク化 ===');
{
  // 1350 はカタログにある。1100 はカタログ未登録だが 1xxx → shotoku
  const src = 'No.1100 についても確認しましょう。';
  let missed = null;
  const { markdown, stats } = linkCitations(src, { onMiss: (info) => { missed = info; } });
  assert(/\[No\.1100\]\(https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/shotoku\/1100\.htm\)/.test(markdown),
    '1xxx → shotoku に推定リンク');
  assert(stats.guessed === 1 && stats.fromCatalog === 0, 'guessed=1');
  assert(missed === null, 'リンク化できたので onMiss は呼ばれない');
}

// ── 5. 既存リンク内はスキップ（二重リンク防止）─────────────────
console.log('\n=== Test 5: 既存リンク内の No.XXXX はスキップ ===');
{
  const src = '参考：[国税庁タックスアンサー No.1350](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm)';
  const { markdown, stats } = linkCitations(src);
  assert(markdown === src, '既存リンクは変更されない');
  assert(stats.linked === 0, 'リンク化数 0');
}

// ── 6. 複数出現 ───────────────────────────────────────────────
console.log('\n=== Test 6: 同じ段落に複数の出典 ===');
{
  const src = 'No.1350 と No.2080 と No.6501 を確認します。';
  const { markdown, stats } = linkCitations(src);
  assert(stats.linked === 3, '3 箇所リンク化');
  assert(/\[No\.1350\]\(/.test(markdown) &&
         /\[No\.2080\]\(/.test(markdown) &&
         /\[No\.6501\]\(/.test(markdown), '全て個別にリンク化');
}

// ── 7. 解決不能（レンジ外）はリンク化しない ─────────────────────
console.log('\n=== Test 7: レンジ外番号はリンク化せず onMiss を呼ぶ ===');
{
  const src = 'No.999 は存在しません。';
  const missed = [];
  const { markdown, stats } = linkCitations(src, { onMiss: (info) => missed.push(info) });
  assert(!/\[No\.999\]\(/.test(markdown), 'リンク化しない（捏造防止）');
  assert(stats.linked === 0 && stats.missing.includes('999'), 'missing に記録');
  assert(missed.length === 1 && missed[0].no === '999', 'onMiss コール');
}

// ── 8. findExistingLinkRanges ───────────────────────────────────
console.log('\n=== Test 8: findExistingLinkRanges ===');
{
  const md = 'a [text](url) b [t2](u2) c';
  const ranges = findExistingLinkRanges(md);
  assert(ranges.length === 2, '2 件検出');
  // 画像リンクも同様にスキップ対象
  const md2 = '![alt](img.png) 文章 No.1350';
  const ranges2 = findExistingLinkRanges(md2);
  assert(ranges2.length === 1, '画像リンクも 1 件として検出');
}

// ── 9. applyExternalLinkRenderer の出力 ─────────────────────────
console.log('\n=== Test 9: marked 拡張で外部リンクに target=_blank が付く ===');
{
  // marked を毎回新規 import すると共有状態に影響するため、isolated 環境で。
  // 簡易に: 新しい marked インスタンス相当として require.cache から消す
  const mPath = require.resolve(path.join(ROOT, 'node_modules/marked'));
  delete require.cache[mPath];
  const { marked } = require(mPath);
  applyExternalLinkRenderer(marked);

  const html = marked('[外部](https://www.nta.go.jp/x.htm) [内部](/blog/y/)');
  assert(/href="https:\/\/www\.nta\.go\.jp\/x\.htm"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(html),
    '外部リンクに target/rel 付与');
  assert(/href="\/blog\/y\/"(?![^>]*target=)/.test(html),
    '内部リンクには target なし');

  // 同ドメインは内部扱い
  const html2 = marked('[同ドメ](https://mori-zeirishi.net/blog/foo/)');
  assert(/href="https:\/\/mori-zeirishi\.net\/blog\/foo\/"(?![^>]*target=)/.test(html2),
    'mori-zeirishi.net は内部扱い');
}

// ── 10. 全体統合: linkCitations → marked → HTML ────────────────
console.log('\n=== Test 10: linkCitations → marked パイプライン ===');
{
  const mPath = require.resolve(path.join(ROOT, 'node_modules/marked'));
  delete require.cache[mPath];
  const { marked } = require(mPath);
  applyExternalLinkRenderer(marked);

  const src = '本文中の根拠：国税庁タックスアンサー No.1350 を参照。';
  const { markdown } = linkCitations(src);
  const html = marked(markdown);
  assert(/href="https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/shotoku\/1350\.htm"[^>]*target="_blank"/.test(html),
    '出典が <a target=_blank> 付きでクリック可能に');
  assert(/国税庁タックスアンサー No\.1350/.test(html), '表示テキスト保持');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
