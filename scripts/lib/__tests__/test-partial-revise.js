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

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
