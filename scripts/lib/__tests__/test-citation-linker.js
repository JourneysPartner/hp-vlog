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
  // 1350 はカタログにある。1001 は国税庁カタログにも REFS にも無いが 1xxx → shotoku
  // （2026-09-04: 番号解決が国税庁カタログ優先になり、以前使っていた 1100 は
  //   カタログ収録済みで「推定」にならなくなったため、未収録の番号に変更）
  const src = 'No.1001 についても確認しましょう。';
  let missed = null;
  const { markdown, stats } = linkCitations(src, { onMiss: (info) => { missed = info; } });
  assert(/\[No\.1001\]\(https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/shotoku\/1001\.htm\)/.test(markdown),
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

// ── 11. 官庁名のリンク化 ────────────────────────────────────────
// 2026-08-17: 社会保険の論点を日本年金機構の原文で裏付けても、読者が
// その出典に辿れなかった。frontmatter の source_url はテンプレートが1件しか
// 表示しないため、税以外の出典がページ上のどこにも現れなかった。
console.log('\n=== Test 11: 官庁名のリンク化 ===');
{
  const { linkAgencies } = require(path.join(ROOT, 'scripts/lib/citation-linker'));
  const { agencyLinksForTopic } = require(path.join(ROOT, 'scripts/lib/official-sources'));

  const NENKIN = 'https://www.nenkin.go.jp/service/kounen/tekiyo/hihokensha1/20141202.html';
  const links = [
    { agency: '日本年金機構', url: NENKIN },
    { agency: '厚生労働省', url: 'https://www.mhlw.go.jp/web/t_doc?dataId=00tb0189&dataType=1&pageNo=1' },
  ];

  // 最初の1回だけリンクする（本文に何度も出るため）
  const body = '日本年金機構の案内によると要件は…。さらに日本年金機構は…。また日本年金機構では…。';
  const r1 = linkAgencies(body, links);
  assert((r1.markdown.match(/\[日本年金機構\]\(/g) || []).length === 1,
    '同じ官庁名は最初の1回だけリンク（実装は3回出現）');
  assert(r1.markdown.startsWith(`[日本年金機構](${NENKIN})`), '最初の出現がリンクになる');
  assert(r1.linked === 1 && r1.agencies[0] === '日本年金機構', 'stats が正しい');

  // 既存リンク内はスキップ
  const withLink = `[日本年金機構](${NENKIN})の案内。加えて日本年金機構の通達も。`;
  const r2 = linkAgencies(withLink, links);
  assert((r2.markdown.match(/\[日本年金機構\]\(/g) || []).length === 1,
    '既にリンク済みなら2つ目をリンクしない（二重リンク防止）');

  // 出現しない官庁はリンクしない
  const r3 = linkAgencies('国税庁の資料によると。', links);
  assert(r3.linked === 0, '本文に出てこない官庁はリンクしない');

  // タックスアンサーのリンクと共存し、入れ子にならない
  const mixed = '国税庁タックスアンサー No.1190 と日本年金機構の両方を根拠にします。';
  const { markdown: both, stats } = linkCitations(mixed, { agencyLinks: links });
  assert(stats.linked === 1 && stats.agenciesLinked === 1, '両方リンクされる');
  assert(!/\[[^\]]*\[/.test(both) && !/\]\([^)]*\)\]\(/.test(both), '入れ子リンクにならない');

  // agencyLinks 未指定でも従来どおり動く（後方互換）
  const { markdown: noAg, stats: st2 } = linkCitations(mixed);
  assert(st2.agenciesLinked === 0, 'agencyLinks 未指定なら官庁リンクは0件');
  assert(/\[国税庁タックスアンサー No\.1190\]\(/.test(noAg), 'タックスアンサーは従来どおりリンク');

  // 記事の非税出典セットから引く（無関係な記事にはリンクを出さない）
  const siPost = { pain_point: 'social-insurance-misconception', title: '社会保険の扶養と税の扶養' };
  const siLinks = agencyLinksForTopic(siPost);
  assert(siLinks.length === 2, '社会保険記事 → 2官庁');
  assert(siLinks[0].agency === '日本年金機構' && siLinks[0].url === NENKIN,
    '日本年金機構は被扶養者ページに向く');
  assert(/t_doc\?dataId=00tb0189/.test(siLinks[1].url),
    '厚生労働省は同じ官庁の先頭 entry（庁保発第9号の通達）に向く');
  assert(agencyLinksForTopic({ pain_point: 'invoice-registration', title: 'インボイス登録' }).length === 0,
    '無関係な記事には官庁リンクを出さない');
  assert(agencyLinksForTopic({}).length === 0, '空トピックは空配列');
}

// ── 12. href のアンパサンドを実体参照にする ─────────────────────
// 厚生労働省の通達 URL のようにクエリ文字列を含む出典を扱うようになったため。
console.log('\n=== Test 12: href の & エスケープ ===');
{
  const { escapeHref } = require(path.join(ROOT, 'scripts/lib/citation-linker'));
  assert(escapeHref('https://x.go.jp/a?b=1&c=2') === 'https://x.go.jp/a?b=1&amp;c=2',
    '生の & は &amp; になる');
  assert(escapeHref('https://x.go.jp/a?b=1&amp;c=2') === 'https://x.go.jp/a?b=1&amp;c=2',
    '既に &amp; なら二重変換しない');
  assert(escapeHref('https://x.go.jp/a?b=1&lt;c') === 'https://x.go.jp/a?b=1&lt;c',
    '他の実体参照も保つ');
  assert(escapeHref('https://x.go.jp/a?b=1&#39;c') === 'https://x.go.jp/a?b=1&#39;c',
    '数値実体参照も保つ');
  assert(escapeHref('https://x.go.jp/a"b') === 'https://x.go.jp/a&quot;b', '引用符も escape');
  assert(escapeHref(null) === '', 'null は空文字');

  const mPath = require.resolve(path.join(ROOT, 'node_modules/marked'));
  delete require.cache[mPath];
  const { marked } = require(mPath);
  applyExternalLinkRenderer(marked);
  const html = marked('[厚生労働省](https://www.mhlw.go.jp/web/t_doc?dataId=00tb0189&dataType=1&pageNo=1)');
  assert(/dataId=00tb0189&amp;dataType=1&amp;pageNo=1/.test(html), 'HTML 出力で & が escape される');
  assert(!/&(?!amp;|quot;|lt;|gt;|#)/.test(html.match(/href="([^"]*)"/)[1]),
    'href に裸の & が残らない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
