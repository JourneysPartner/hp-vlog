'use strict';

const { preflightCheck } = require('../preflight-check');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const raw = `---
title: "検索語を含まない十分な長さの記事タイトルです"
slug: "seo-test"
category: "消費税"
primary_persona: "general_individual_proprietor"
summary: "検索語を含まない要約です"
source_url: "https://example.com/source"
source_title: "出典"
target_query: "塗料 勘定科目"
secondary_queries: "塗料 仕訳"
---

導入です。

## 別の見出し

本文です。個別事情により異なります。`;

const r = preflightCheck(raw);
assert(r.warnings.some(v => /^SEO: title_missing_query/.test(v)), 'SEO fail を warning として追加');
assert(r.warnings.some(v => /^SEO: /.test(v)), 'SEO warning も追加');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
