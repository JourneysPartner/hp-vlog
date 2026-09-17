'use strict';

const path = require('path');
const matter = require('gray-matter');
const ROOT = path.join(__dirname, '..', '..', '..');
const { buildCanonicalFrontmatter } = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));
const {
  restoreMissingSystemFields,
  restoreSourceGuardFields,
} = require(path.join(ROOT, 'scripts/lib/source-guard'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const topic = {
  slug: 'multi-source-test',
  category: '相続税',
  persona: 'inheritance_client',
  article_type: 'basic_explainer',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm',
  source_title: '相続時精算課税の選択',
  source_provenance: 'llm-auto',
  source_confidence: 0.97,
  source_term: '相続時精算課税',
  tax_domain: 'inheritance_tax',
  pain_point: 'property-gift',
  search_intent: '土地 贈与 税金 手続き',
  primary_question: '土地の生前贈与はどう進める？',
  customer_segment: 'inheritance_client',
  source_supplements: [
    {
      url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4602.htm',
      title: '土地"家屋"の評価',
      term: '不動産の贈与税評価額',
      confidence: 0.95,
    },
    {
      url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',
      title: '贈与税の計算と税率（暦年課税）',
      term: '暦年課税',
      confidence: 0.96,
    },
  ],
};
const options = {
  llmMeta: {
    title: '土地や家を生前贈与するときの税金と手続き',
    summary: '土地や家の生前贈与について、課税制度と評価、登記の要点を整理します。',
  },
  now: '2026-09-17T00:00:00.000Z',
};

console.log('\n=== Test 1: frontmatter の書き出し ===');
const out = buildCanonicalFrontmatter(topic, options);
{
  assert(/^source_2_url:/m.test(out) && /^source_3_url:/m.test(out),
    '補助2件なら source_2 と source_3 が出る');
  assert(!/^source_4_/m.test(out), '未使用の source_4 は出ない');

  const withoutSupplements = buildCanonicalFrontmatter({
    ...topic,
    source_term: '',
    source_supplements: [],
  }, options);
  assert(!/^source_2_/m.test(withoutSupplements), '補助0件なら source_2 は出ない');
  assert(/^source_term: ""$/m.test(withoutSupplements), '論点語が無い経路では source_term が空');

  let parsed;
  try { parsed = matter(out).data; } catch (_error) { parsed = null; }
  assert(!!parsed, 'gray-matter で解析できる');
  const fmLines = out.split(/\r?\n/).filter(line => line && line !== '---');
  assert(fmLines.every(line => /^[a-zA-Z_0-9]+:/.test(line)), 'frontmatter は全て平坦な1行キー');
  assert(parsed && parsed.source_2_title === '土地"家屋"の評価', 'タイトル内のダブルクォートを保全する');
}

console.log('\n=== Test 2: 素朴な解析器で読める ===');
{
  const parsed = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
    if (m) parsed[m[1]] = m[2];
  }
  assert(parsed.source_2_url === topic.source_supplements[0].url,
    'review-page と同じ正規表現で source_2_url を読める');
}

console.log('\n=== Test 3: 再生成での保全 ===');
{
  const before = `${out}\n\n## 本文\n元の本文`;
  const afterMissing = before.replace(/^source_2_url:.*\r?\n/m, '');
  const restoredMissing = restoreMissingSystemFields(before, afterMissing);
  assert(restoredMissing.restored.includes('source_2_url')
    && restoredMissing.content.includes(`source_2_url: "${topic.source_supplements[0].url}"`),
  'restoreMissingSystemFields が欠けた source_2_url を復元する');

  const legacyBefore = [
    '---',
    'title: "既存記事"',
    'source_url: "' + topic.source_url + '"',
    'source_title: "相続時精算課税の選択"',
    'source_provenance: "llm-auto"',
    'source_confidence: 0.97',
    'source_guard_version: 1',
    'pain_point: "property-gift"',
    'tax_domain: "inheritance_tax"',
    '---',
    '',
    '## 本文',
  ].join('\n');
  const legacyAfter = legacyBefore.replace('title: "既存記事"', 'title: "再生成記事"');
  const restoredLegacy = restoreSourceGuardFields(legacyBefore, legacyAfter);
  assert(!/^source_2_/m.test(restoredLegacy), '元に無い source_2 の空キーを作らない');

  let restoredParsed = null;
  try { restoredParsed = matter(restoredMissing.content).data; } catch (_error) {}
  assert(restoredParsed && restoredParsed.source_2_url === topic.source_supplements[0].url,
    '復元後も gray-matter で解析できる');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
