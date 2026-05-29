'use strict';

/**
 * 差し戻し分類器 + 部分再生成ユーティリティのテスト。
 *   node scripts/lib/__tests__/test-partial-revise.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { classifyRevision } = require(path.join(ROOT, 'scripts/lib/revision-classifier'));
const partial = require(path.join(ROOT, 'scripts/lib/partial-revise'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 分類: title_only ───────────────────────────────────────
console.log('\n=== Test 1: タイトル修正 → title_only ===');
{
  const r = classifyRevision('タイトルが硬いので自然にしてください');
  assert(r.type === 'title_only' && r.scope === 'frontmatter', `type=${r.type} scope=${r.scope}`);
}

// ── 2. 分類: table_fix ────────────────────────────────────────
console.log('\n=== Test 2: 表の指摘 → table_fix(section) ===');
{
  const r = classifyRevision('登録する場合・しない場合の比較を表にしてください');
  assert(r.type === 'table_fix' && r.scope === 'section', `type=${r.type} scope=${r.scope}`);
}

// ── 3. 分類: add_section ──────────────────────────────────────
console.log('\n=== Test 3: 章追加 → add_section(section) ===');
{
  const r = classifyRevision('よくある誤解のセクションも追加してください');
  assert(r.type === 'add_section' && r.scope === 'section', `type=${r.type} scope=${r.scope}`);
}

// ── 4. 分類: full_regenerate（テーマ変更）────────────────────
console.log('\n=== Test 4: 構成変更 → full_regenerate ===');
{
  const r = classifyRevision('全体的に構成を見直して書き直してください');
  assert(r.type === 'full_regenerate' && r.scope === 'full', `type=${r.type} scope=${r.scope}`);
}

// ── 5. 分類: suppression（今後書かない）→ full + denySuppression ─
console.log('\n=== Test 5: 今後書かない → full + denySuppression ===');
{
  const r = classifyRevision('このテーマは今後書かないでください');
  assert(r.type === 'full_regenerate' && r.denySuppression === true, `type=${r.type} deny=${r.denySuppression}`);
}

// ── 6. 分類: 軽微な未分類コメント → targeted（最小修正）────────
console.log('\n=== Test 6: 軽微コメント → targeted（部分修正優先）===');
{
  const r = classifyRevision('語尾を少し丁寧にしてください');
  assert(r.scope === 'targeted', `scope=${r.scope}（全文再生成にしない）`);
}

// ── 7. 分類: 長文コメント → full ──────────────────────────────
console.log('\n=== Test 7: 長い差し戻しコメント → full ===');
{
  const long = 'この記事は'.repeat(30); // 150文字
  const r = classifyRevision(long);
  assert(r.type === 'full_regenerate', `type=${r.type}（長文は full）`);
}

// ── 8. splitSections / joinSections の往復 ────────────────────
console.log('\n=== Test 8: セクション分割・再合成 ===');
{
  const body = `導入文です。

## 第1章
本文1

## 第2章
本文2

## まとめ
結び`;
  const { intro, sections } = partial.splitSections(body);
  assert(/導入文/.test(intro), 'intro 抽出');
  assert(sections.length === 3, `3セクション（実: ${sections.length}）`);
  assert(sections[2].heading === 'まとめ', '見出し抽出');
  const joined = partial.joinSections(intro, sections);
  assert(/## 第1章/.test(joined) && /## まとめ/.test(joined), '再合成で見出し保持');
}

// ── 9. findTargetSectionIndex: 表を含むセクションを特定 ─────────
console.log('\n=== Test 9: 表セクションの特定 ===');
{
  const sections = [
    { heading: '概要', body: 'テキスト' },
    { heading: '比較', body: '| A | B |\n|---|---|\n| 1 | 2 |' },
  ];
  const idx = partial.findTargetSectionIndex(sections, '', 'table_fix');
  assert(idx === 1, `表を含むセクション index=${idx}`);
}

// ── 10. applyTitleOnly: 本文を変えず title/summary だけ更新 ─────
console.log('\n=== Test 10: applyTitleOnly は本文を保持 ===');
{
  const original = `---
title: "旧タイトル"
slug: "x"
summary: "旧サマリー"
review_status: "needs_revision"
updated_at: "2020-01-01"
---

## 本文
これは本文です。変わってはいけません。`;
  const out = partial.applyTitleOnly(original, { title: '新タイトル', summary: '新サマリー' }, '2026-05-25T00:00:00Z');
  assert(/title: "新タイトル"/.test(out), 'title 更新');
  assert(/summary: "新サマリー"/.test(out), 'summary 更新');
  assert(/これは本文です。変わってはいけません。/.test(out), '本文は保持');
  assert(/review_status: "draft"/.test(out), 'review_status → draft');
}

// ── 11. findTargetSectionIndex: hint で見出し特定 ─────────────
console.log('\n=== Test 11: sectionHint で見出し特定 ===');
{
  const sections = [
    { heading: '消費税の基本', body: 'a' },
    { heading: 'インボイスの判断', body: 'b' },
  ];
  const idx = partial.findTargetSectionIndex(sections, 'インボイス', 'section_only');
  assert(idx === 1, `hint一致 index=${idx}`);
}

// ── 12. extractDirectTitleSwap: コメントから新タイトル直接抽出 ───
// 実ユーザーケース: 「タイトルの「旧」を「新」に変更して。」
console.log('\n=== Test 12: extractDirectTitleSwap ===');
{
  // パターンA: 旧→新 を両方提示（ユーザー実コメント）
  const c1 = 'タイトルの「メルカリは法人化を考えるべき売上ライン？」を「メルカリ販売で法人化を考えるべき売上ラインは？」に変更して。';
  const r1 = partial.extractDirectTitleSwap(c1);
  assert(r1 !== null, 'A: 抽出成功');
  assert(r1 && r1.oldTitle === 'メルカリは法人化を考えるべき売上ライン？', 'A: 旧タイトル抽出');
  assert(r1 && r1.newTitle === 'メルカリ販売で法人化を考えるべき売上ラインは？', 'A: 新タイトル抽出');

  // パターンB: 新のみ提示
  const c2 = 'タイトルを「新しい言い回し」に変更して。';
  const r2 = partial.extractDirectTitleSwap(c2);
  assert(r2 !== null, 'B: 抽出成功');
  assert(r2 && r2.newTitle === '新しい言い回し', 'B: 新タイトル抽出');

  // パターンC: 「直して」表現
  const c3 = 'タイトルを「新案」に直してください。';
  const r3 = partial.extractDirectTitleSwap(c3);
  assert(r3 !== null && r3.newTitle === '新案', 'C: 「直して」表現');

  // パターンD: 抽出不可（自由文 → LLM へ）
  const c4 = 'タイトルが硬いので柔らかくしてください。';
  const r4 = partial.extractDirectTitleSwap(c4);
  assert(r4 === null, 'D: 自由文は抽出不可（LLM へ委ねる）');

  // パターンE: 本文系コメントは抽出されない
  const c5 = '本文全体を見直して。';
  const r5 = partial.extractDirectTitleSwap(c5);
  assert(r5 === null, 'E: 本文系コメントは抽出されない');
}

// ── 13. buildTitleOnlyPrompt: 新タイトル明示時は強い指示を入れる ─
console.log('\n=== Test 13: buildTitleOnlyPrompt が直接指定を尊重 ===');
{
  const meta = { title: '旧', summary: '旧サマリー' };
  const c = 'タイトルを「新タイトル候補」に変更して。';
  const { user } = partial.buildTitleOnlyPrompt(meta, c);
  assert(/新タイトル候補/.test(user), '新タイトル候補がプロンプトに含まれる');
  assert(/採用してください/.test(user), '直接採用の指示が含まれる');
}

// ── 14b. isBodyShrinkageSuspicious: 本文激減の検出 ─────────────
// targeted 再生成で LLM が本文を ASCII フローチャート等に書き換える事故
// （実例 2026-05-29）を防ぐためのガード。
console.log('\n=== Test 14b: isBodyShrinkageSuspicious ===');
{
  const longBody = '## 章1\n本文です。'.repeat(50);  // 約 600 文字
  // 通常: 同程度の長さ → suspicious=false
  const g1 = partial.isBodyShrinkageSuspicious(longBody, longBody);
  assert(!g1.suspicious, '同じ本文は suspicious=false');

  // 短縮 50% → 閾値 60% を割っているので suspicious=true
  const shortBody = longBody.slice(0, Math.floor(longBody.length * 0.4));
  const g2 = partial.isBodyShrinkageSuspicious(longBody, shortBody);
  assert(g2.suspicious, '40% に縮んだ本文は suspicious=true');
  assert(/40%/.test(g2.reason) || /40\b/.test(g2.reason), 'reason に短縮率を含む');

  // h2 激減: 元が 4 章、新が 1 章 → suspicious
  const orig4Sections = '## 1\nA\n## 2\nB\n## 3\nC\n## 4\nD';
  const new1Section   = '## 1\nA\n（あれこれ書く）'.repeat(20);  // 文字数は十分ある
  const g3 = partial.isBodyShrinkageSuspicious(orig4Sections, new1Section);
  // 文字数だけ見ると suspicious=false かもしれないが、h2 半減で trigger
  assert(g3.suspicious, 'h2 章数が半減未満は suspicious');

  // 元が空 → チェック不能で false
  const g4 = partial.isBodyShrinkageSuspicious('', 'something');
  assert(!g4.suspicious, '元本文が空ならチェック不能で suspicious=false');
}

// ── 14. 部分一致時のサフィックス保持（実ユーザーケース）───────────
// 現タイトル: 「メルカリは法人化を考えるべき売上ライン？｜初動を整理」
// ユーザー指定: 旧=「メルカリは法人化を考えるべき売上ライン？」（｜初動を整理 を含まない）
//                新=「メルカリ販売で法人化を考えるべき売上ラインは？」
// 期待挙動: cur.replace(old, new) で「｜初動を整理」を保持して置換
console.log('\n=== Test 14: 旧タイトルが現タイトルの部分一致 → サフィックス保持 ===');
{
  const cur = 'メルカリは法人化を考えるべき売上ライン？｜初動を整理';
  const oldT = 'メルカリは法人化を考えるべき売上ライン？';
  const newT = 'メルカリ販売で法人化を考えるべき売上ラインは？';
  // ロジック検証: 文字列の単純置換が期待通り動く
  const finalTitle = cur.replace(oldT, newT);
  assert(finalTitle === 'メルカリ販売で法人化を考えるべき売上ラインは？｜初動を整理',
    `サフィックス保持置換: "${finalTitle}"`);
  // 部分一致判定の境界
  assert(cur.includes(oldT) && cur !== oldT, '現タイトルが旧を含み完全一致しない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
