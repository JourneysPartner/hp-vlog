'use strict';

/**
 * 生成出力の正規化テスト（Sonnet 4.6 出力が崩れても frontmatter を保証）。
 *   node scripts/lib/__tests__/test-generate-draft-output-normalization.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const matter = require(path.join(ROOT, 'node_modules/gray-matter'));

const { normalizeGeneratedDraft, stripCodeFences, extractFrontmatterAndBody, parseYamlish }
  = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const TOPIC = {
  title: 'Amazonは法人化を考えるべき売上ライン？｜判断の整理',
  slug: 'amazon-just-opened-incorporation-threshold-guide',
  category: '消費税', persona: 'domestic_ec_seller',
  article_type: 'comparison_decision',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm',
  source_title: '国税庁タックスアンサー No.2260 所得税の税率',
  macro: '物販', cluster: 'amazon', subcluster: 'just-opened-incorporation-threshold',
  tax_domain: 'consumption_tax', business_stage: 'just-opened', pain_point: 'incorporation-threshold',
  search_intent: 'si', reader_problem: 'rp', success_outcome: 'so', primary_question: 'pq',
};

const REQUIRED = ['title', 'slug', 'category', 'primary_persona', 'summary', 'review_status', 'source_url'];

function assertValidFm(content, label) {
  const { data } = matter(content);
  let ok = true;
  for (const f of REQUIRED) {
    if (!data[f]) { ok = false; console.error(`    ✗ ${label}: ${f} 欠落`); }
  }
  assert(ok, `${label}: 必須frontmatter全充足`);
  assert(data.review_status === 'draft', `${label}: review_status=draft`);
  assert(/nta\.go\.jp/.test(data.source_url || ''), `${label}: source_url が国税庁`);
  return data;
}

// ── 1. コードブロック付き ───────────────────────────────────
console.log('\n=== Test 1: ```markdown コードブロックで囲まれた出力 ===');
{
  const raw = '```markdown\n---\ntitle: "X"\nslug: "y"\n---\n\n## 章1\n本文\n\n## 章2\n本文\n```';
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  assertValidFm(n.content, 'codeblock');
  const { data } = matter(n.content);
  assert(data.title === TOPIC.title, 'title は topic 由来（LLMの"X"で上書きしない）');
}

// ── 2. frontmatter 前に説明文 ───────────────────────────────
console.log('\n=== Test 2: frontmatter 前に説明文 ===');
{
  const raw = 'こちらが記事です。\n\n---\ntitle: "X"\nslug: "y"\nsummary: "妥当な要約で十分な長さがあります。"\n---\n\n## 章1\n本文\n## 章2\n本文\n## 章3\n本文';
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  const data = assertValidFm(n.content, 'leading-text');
  assert(!/こちらが記事です/.test(n.content), '前置き説明文が除去される');
  assert(data.summary === '妥当な要約で十分な長さがあります。', '妥当なLLM summary を採用');
}

// ── 3. frontmatter 欠落（本文だけ）─────────────────────────
console.log('\n=== Test 3: frontmatter 欠落（本文だけ）===');
{
  const raw = '## 法人化の判断基準\n本文です。\n\n## メリットとデメリット\n説明。\n\n## まとめ\n結び。';
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  assertValidFm(n.content, 'no-frontmatter');
  assert(n.hadFrontmatter === false, 'hadFrontmatter=false');
  assert(/## 法人化の判断基準/.test(n.content), '本文は保持');
  const { data } = matter(n.content);
  assert(data.summary && data.summary.length >= 10, '本文/topicからsummary補完');
}

// ── 4. 必須項目の一部欠落（LLM が一部しか出さない）──────────
console.log('\n=== Test 4: LLM frontmatter の一部欠落 ===');
{
  const raw = '---\ntitle: "X"\n---\n\n## 章1\n本文\n## 章2\n本文\n## 章3\n本文';
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  // topic 由来で全項目が埋まる
  assertValidFm(n.content, 'partial-fm');
  const { data } = matter(n.content);
  assert(data.slug === TOPIC.slug, 'slug は topic 由来で補完');
  assert(data.category === '消費税', 'category 補完');
  assert(data.primary_persona === 'domestic_ec_seller', 'primary_persona 補完');
}

// ── 5. h2見出し0個 → bodyH2Count=0 を検出 ───────────────────
console.log('\n=== Test 5: h2見出し0個の検出 ===');
{
  const raw = '---\ntitle: "X"\nslug: "y"\n---\n\n見出しのない本文だけです。';
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  assert(n.bodyH2Count === 0, 'bodyH2Count=0 を検出（retry トリガ）');
  assertValidFm(n.content, 'no-h2');  // frontmatter は保証される
}

// ── 6. single quote / block scalar ─────────────────────────
console.log('\n=== Test 6: single quote / block scalar ===');
{
  const raw = "---\ntitle: 'X'\nslug: y\nsummary: >-\n  ブロックスカラーで\n  複数行のサマリー\n---\n\n## 章1\n本文\n## 章2\n本文\n## 章3\n本文";
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  assertValidFm(n.content, 'quote-styles');
}

// ── 7. stripCodeFences 単体 ─────────────────────────────────
console.log('\n=== Test 7: stripCodeFences ===');
{
  assert(stripCodeFences('```markdown\nABC\n```') === 'ABC', 'markdown フェンス除去');
  assert(stripCodeFences('```\nABC\n```') === 'ABC', 'プレーンフェンス除去');
  assert(stripCodeFences('ABC') === 'ABC', 'フェンス無しはそのまま');
}

// ── 8. parseYamlish の quote 解釈 ──────────────────────────
console.log('\n=== Test 8: parseYamlish ===');
{
  const m = parseYamlish('title: "ダブル"\nslug: \'シングル\'\nbare: 裸値\nreview_status: draft');
  assert(m.title === 'ダブル', 'double quote');
  assert(m.slug === 'シングル', 'single quote');
  assert(m.bare === '裸値', 'bare value');
}

// ── 9. 出力が gray-matter で安全にパースできる（YAML 妥当性）──
console.log('\n=== Test 9: 出力が gray-matter で再パース可能 ===');
{
  const raw = '## 章1\n本文\n## 章2\n本文\n## 章3\n本文';
  const n = normalizeGeneratedDraft(raw, TOPIC, { now: '2026-05-25T00:00:00Z' });
  let threw = false;
  try { matter(n.content); } catch { threw = true; }
  assert(!threw, 'gray-matter でパースエラーにならない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
