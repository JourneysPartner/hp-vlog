'use strict';

/**
 * 周辺処理ルーティング + ルールベース処理（表lint / preflight）のテスト。
 *   node scripts/lib/__tests__/test-aux-task-routing.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { AUX_TASKS, summary } = require(path.join(ROOT, 'scripts/lib/aux-task-routing'));
const { lintTables, hasAnyTable } = require(path.join(ROOT, 'scripts/lib/markdown-table-lint'));
const { preflightCheck } = require(path.join(ROOT, 'scripts/lib/preflight-check'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 全タスクに tier / status / impl がある ────────────────
console.log('\n=== Test 1: AUX_TASKS の整合 ===');
{
  let ok = true;
  for (const t of AUX_TASKS) {
    if (!t.id || !t.tier || !t.status || !t.label) { ok = false; console.error('  ✗ 不備:', t.id); }
    if (!['A','B','C','D'].includes(t.tier)) { ok = false; console.error('  ✗ tier 不正:', t.id, t.tier); }
  }
  assert(ok, `全 ${AUX_TASKS.length} タスクに tier/status/label`);
}

// ── 2. 本文生成だけが D ─────────────────────────────────────
console.log('\n=== Test 2: 本文生成のみ tier D ===');
{
  const dTasks = AUX_TASKS.filter(t => t.tier === 'D');
  assert(dTasks.length === 1 && dTasks[0].id === 'article_body_generation', '本文生成のみ D');
}

// ── 3. source_url 補完 / title lint / cooldown 等は rule_based_done ─
console.log('\n=== Test 3: 主要周辺処理がルールベース実装済み ===');
{
  const doneIds = AUX_TASKS.filter(t => t.status === 'rule_based_done').map(t => t.id);
  for (const id of ['source_url_fill', 'title_lint', 'dup_similarity_cooldown_denylist',
                    'main_support_pair_check', 'frontmatter_fill', 'slug_generation']) {
    assert(doneIds.includes(id), `${id} は rule_based_done`);
  }
}

// ── 4. summary の集計 ────────────────────────────────────────
console.log('\n=== Test 4: tier 集計 ===');
{
  const s = summary();
  assert(s.A.length >= 8, `tier A が8件以上（実: ${s.A.length}）`);
  assert(s.D.length === 1, 'tier D は1件');
}

// ── 5. Markdown 表 lint: 正常な表は問題なし ──────────────────
console.log('\n=== Test 5: 正常な GFM 表は lint 通過 ===');
{
  const body = `説明文です。

| 項目 | 内容 |
|---|---|
| A | 1 |
| B | 2 |

続きの文。`;
  const issues = lintTables(body);
  assert(hasAnyTable(body), '表を検出');
  assert(issues.length === 0, `問題なし（実: ${issues.length}）`);
}

// ── 6. Markdown 表 lint: 列数不一致を検出 ────────────────────
console.log('\n=== Test 6: 列数不一致を検出 ===');
{
  const body = `text

| A | B | C |
|---|---|
| 1 | 2 |

end`;
  const issues = lintTables(body);
  assert(issues.length > 0, `不整合を検出（${issues.length}件）`);
}

// ── 7. preflight: 正常記事は ok ──────────────────────────────
console.log('\n=== Test 7: preflight 正常記事 ===');
{
  const raw = `---
title: "Amazonの手数料はどう経理する？仕訳と保存資料の基本"
slug: "amazon-x"
category: "消費税"
primary_persona: "domestic_ec_seller"
summary: "FBA手数料は課税仕入として処理でき、保存資料の整理がポイントです。"
source_url: "https://www.nta.go.jp/x"
source_title: "国税庁X"
---

## はじめに
結論として、手数料は課税仕入です。

## 手数料の処理

| 種類 | 区分 |
|---|---|
| FBA | 課税 |

## まとめ
本記事は情報提供を目的として作成しており、個別事情によって結論が異なる場合があります。`;
  const r = preflightCheck(raw);
  assert(r.ok, `ok=true（errors: ${JSON.stringify(r.errors)}）`);
}

// ── 8. preflight: source_url 無しを検出 ──────────────────────
console.log('\n=== Test 8: preflight source_url 欠落を検出 ===');
{
  const raw = `---
title: "テスト"
slug: "x"
category: "消費税"
primary_persona: "domestic_ec_seller"
summary: "サマリー"
source_url: ""
---

## 章
本文。`;
  const r = preflightCheck(raw);
  assert(!r.ok, 'ok=false');
  assert(r.errors.some(e => /source_url/.test(e)), 'source_url 欠落を errors に');
}

// ── 9. preflight: 禁止フレーズタイトルを検出 ─────────────────
console.log('\n=== Test 9: preflight 禁止タイトルを検出 ===');
{
  const raw = `---
title: "相続税に押さえる基本"
slug: "x"
category: "相続"
primary_persona: "inheritance_client"
summary: "サマリー"
source_url: "https://www.nta.go.jp/x"
source_title: "国税庁X"
macro: "相続贈与"
---

## 章
本文。`;
  const r = preflightCheck(raw);
  assert(r.errors.some(e => /title/.test(e)), '「に押さえる」を title エラーに');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
