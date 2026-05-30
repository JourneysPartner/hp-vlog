'use strict';

/**
 * updateFrontmatter / escapeYamlDoubleQuoted の YAML 安全性テスト。
 *   node scripts/lib/__tests__/test-yaml-escape-fm.js
 *
 * 実ユーザー事故: 改行入り review_comment が YAML 不正となり、validate が失敗
 * （npm run validate が「a multiline key may not be an implicit key」で死亡）。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const matter = require(path.join(ROOT, 'node_modules/gray-matter'));
const { updateFrontmatter, escapeYamlDoubleQuoted } =
  require(path.join(ROOT, 'netlify/functions/lib/github-api'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const BASE = `---
title: "テスト記事"
slug: "test"
review_status: "draft"
review_comment: ""
approved_at: ""
---

## 本文
本文です。`;

// ── 1. escapeYamlDoubleQuoted の基本動作 ──────────────────────
console.log('\n=== Test 1: escapeYamlDoubleQuoted ===');
{
  assert(escapeYamlDoubleQuoted('plain') === 'plain', 'plain 文字列はそのまま');
  assert(escapeYamlDoubleQuoted('with "quote"') === 'with \\"quote\\"', 'ダブルクォート escape');
  assert(escapeYamlDoubleQuoted('with \\back') === 'with \\\\back', 'バックスラッシュ escape');
  assert(escapeYamlDoubleQuoted('line1\nline2') === 'line1\\nline2', 'LF → \\n');
  assert(escapeYamlDoubleQuoted('line1\r\nline2') === 'line1\\nline2', 'CRLF → \\n');
  assert(escapeYamlDoubleQuoted('a\tb') === 'a\\tb', 'タブ → \\t');
}

// ── 2. 改行入り review_comment（実ユーザー事故ケース）────────
console.log('\n=== Test 2: 改行入りコメントが YAML 妥当 ===');
{
  const userComment = '「原則をまず3行で押さえる」→「重要ポイントを整理💡」に変更して。\n\n今後、「原則をまず3行で押さえる」という文言や、原則を◯行で押さえる、というような文言は書かないでください。';
  const updated = updateFrontmatter(BASE, {
    review_status: 'needs_revision',
    review_comment: userComment,
  });
  // gray-matter（js-yaml）でパース可能か
  let parsed, threw = null;
  try { parsed = matter(updated); } catch (e) { threw = e; }
  assert(!threw, `gray-matter で再パース可能（実: ${threw && threw.message}）`);
  if (parsed) {
    assert(parsed.data.review_status === 'needs_revision', 'review_status 更新');
    assert(parsed.data.review_comment === userComment, '改行込みコメントが復元可能');
  }
}

// ── 3. ダブルクォート入り値 ─────────────────────────────────
console.log('\n=== Test 3: ダブルクォート入り値 ===');
{
  const value = 'AさんがBさんに「やめて」と言った。';
  const updated = updateFrontmatter(BASE, { review_comment: value });
  let parsed, threw = null;
  try { parsed = matter(updated); } catch (e) { threw = e; }
  assert(!threw, 'パース可能');
  assert(parsed && parsed.data.review_comment === value, 'ダブルクォート込みで復元可能');
}

// ── 4. バックスラッシュ + 改行 + クォートの複合 ─────────────────
console.log('\n=== Test 4: 複合エスケープ ===');
{
  const value = 'パス: C:\\\\Users\\\\foo\\n"file"';  // 元文字列に意図的に \, ", \n を含む
  const updated = updateFrontmatter(BASE, { review_comment: value });
  let parsed, threw = null;
  try { parsed = matter(updated); } catch (e) { threw = e; }
  assert(!threw, 'パース可能');
  assert(parsed && parsed.data.review_comment === value, '復元可能');
}

// ── 5. 既存フィールドが無いと append ──────────────────────────
console.log('\n=== Test 5: 既存フィールド無しは追加 ===');
{
  const updated = updateFrontmatter(BASE, { new_field: 'value with\nnewline' });
  let parsed, threw = null;
  try { parsed = matter(updated); } catch (e) { threw = e; }
  assert(!threw, '新フィールド追加でもパース可能');
  assert(parsed && parsed.data.new_field === 'value with\nnewline', '改行込みで復元');
}

// ── 6. 絵文字（マルチバイト）─────────────────────────────────
console.log('\n=== Test 6: 絵文字 ===');
{
  const value = '重要ポイントを整理💡';
  const updated = updateFrontmatter(BASE, { review_comment: value });
  let parsed, threw = null;
  try { parsed = matter(updated); } catch (e) { threw = e; }
  assert(!threw, '絵文字込みでパース可能');
  assert(parsed && parsed.data.review_comment === value, '絵文字復元');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
