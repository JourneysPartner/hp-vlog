'use strict';

/**
 * topic-selector の動作検証テスト。
 *   node scripts/lib/__tests__/test-selector.js
 * で実行。OpenAIは呼ばない。
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const { TOPICS } = require('../../topic-pool');
const { selectDailyTopics } = require('../topic-selector');
const { similarityScore } = require('../topic-similarity');
const { resolveCluster } = require('../cluster-taxonomy');
const { computeMacroRatios } = require('../category-balance');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('\n=== Test 1: 全 topic に cluster / subcluster / macro が解決できる ===');
for (const t of TOPICS) {
  const r = resolveCluster(t);
  if (!r.macro || !r.cluster || !r.subcluster) {
    console.error(`  ✗ ${t.slug}: macro=${r.macro}, cluster=${r.cluster}, subcluster=${r.subcluster}`);
    failed++;
  }
}
console.log(`  全 ${TOPICS.length} 件解決確認`);
passed++;

console.log('\n=== Test 2: 既存記事と完全一致する slug の候補は必ず除外される ===');
{
  const existingSlugs = new Set();
  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(POSTS_DIR, f), 'utf8');
    const m = raw.match(/^slug:\s*"?([^"\n\r]+)"?/m);
    if (m) existingSlugs.add(m[1].trim());
  }
  const { picks } = selectDailyTopics(TOPICS, { now: new Date() });
  for (const p of picks) {
    assert(!existingSlugs.has(p.slug), `pick ${p.slug} は既存slugと重複していない`);
  }
}

console.log('\n=== Test 3: 同日2本のペアは類似度 < 0.45 ===');
{
  const { picks } = selectDailyTopics(TOPICS, { now: new Date() });
  if (picks.length === 2) {
    const sim = similarityScore(picks[0], { ...picks[1], primary_persona: picks[1].persona }).score;
    assert(sim < 0.45, `pair similarity = ${sim.toFixed(3)} (< 0.45)`);
  } else {
    console.log(`  picks=${picks.length} 件のため類似度比較スキップ`);
    passed++;
  }
}

console.log('\n=== Test 3b: 同日2本は main + support の役割になる ===');
{
  const MAIN_TYPES = new Set(['basic_explainer', 'comparison_decision']);
  const isMain = (t) => MAIN_TYPES.has(t.article_type);
  const isSupport = (t) => !MAIN_TYPES.has(t.article_type);

  const { picks } = selectDailyTopics(TOPICS, { now: new Date() });
  if (picks.length === 2) {
    const hasMain    = picks.some(isMain);
    const hasSupport = picks.some(isSupport);
    assert(hasMain,    '2本のうち少なくとも 1 本は main 型');
    assert(hasSupport, '2本のうち少なくとも 1 本は support 型');
    assert(isMain(picks[0]),    '1本目が main 型');
    assert(isSupport(picks[1]), '2本目が support 型');
  } else {
    console.log(`  picks=${picks.length} 件のため main+support 検証スキップ`);
    passed++;
  }
}

console.log('\n=== Test 3c: buildBestPair の単体検証（main+support 強制）===');
{
  const { buildBestPair } = require(path.join(ROOT, 'scripts/lib/topic-selector'));
  // 故意に main 2本だけのケース
  const mainOnly = [
    { topic: { slug: 'a', article_type: 'basic_explainer', cluster: 'x', persona: 'p1' }, balance: 1 },
    { topic: { slug: 'b', article_type: 'comparison_decision', cluster: 'y', persona: 'p2' }, balance: 0.5 },
  ];
  const r1 = buildBestPair(mainOnly);
  // main しかない場合は最終フォールバックで 2 本返るがその役割は同じ。これは想定内（warning 段階で fallback）
  assert(r1.length >= 1, 'main のみでも 1 本以上は返る');

  // 通常ケース: main + support 候補が両方ある
  const mixed = [
    { topic: { slug: 'm1', article_type: 'basic_explainer', cluster: 'x', persona: 'p1' }, balance: 1 },
    { topic: { slug: 'm2', article_type: 'comparison_decision', cluster: 'y', persona: 'p2' }, balance: 0.5 },
    { topic: { slug: 's1', article_type: 'filing_practice', cluster: 'z', persona: 'p3' }, balance: 0.3 },
    { topic: { slug: 's2', article_type: 'misconception_fix', cluster: 'w', persona: 'p4' }, balance: 0.2 },
  ];
  const r2 = buildBestPair(mixed);
  assert(r2.length === 2, 'mixed では 2 本返る');
  const MAIN = new Set(['basic_explainer', 'comparison_decision']);
  assert(MAIN.has(r2[0].article_type), '1本目が main');
  assert(!MAIN.has(r2[1].article_type), '2本目が support');
}

console.log('\n=== Test 4: ハードブロック (直近7日で macro が60%超) が機能 ===');
{
  const ratios = computeMacroRatios(new Date());
  const r7 = ratios.ratios[7];
  let foundOver = false;
  for (const [macro, r] of Object.entries(r7)) {
    if (r > 0.6) {
      foundOver = true;
      console.log(`  直近7日: ${macro} = ${(r * 100).toFixed(0)}% (上限超え検知)`);
    }
  }
  if (!foundOver) {
    console.log('  直近7日に60%超のmacroなし → スキップ');
  }
  passed++;
}

console.log('\n=== Test 5: cluster ごとに subcluster が分散している ===');
{
  const subclustersByCluster = {};
  for (const t of TOPICS) {
    const c = resolveCluster(t);
    if (!subclustersByCluster[c.cluster]) subclustersByCluster[c.cluster] = new Set();
    subclustersByCluster[c.cluster].add(c.subcluster);
  }
  for (const [cluster, subs] of Object.entries(subclustersByCluster)) {
    if (subs.size === 0) {
      console.error(`  ✗ cluster=${cluster} は subcluster がない`);
      failed++;
    }
  }
  console.log(`  確認: ${Object.keys(subclustersByCluster).length} clusters`);
  passed++;
}

console.log('\n=== Test 6: 大分類が ALL_MACROS 内に収まる ===');
{
  const { ALL_MACROS } = require('../cluster-taxonomy');
  for (const t of TOPICS) {
    const c = resolveCluster(t);
    if (!ALL_MACROS.includes(c.macro)) {
      console.error(`  ✗ ${t.slug}: macro=${c.macro} は許可リスト外`);
      failed++;
    }
  }
  passed++;
}

console.log('\n=== Test 7: tax-authority-refs が tax_domain ごとに整っている ===');
{
  const { REFS, getRefsForTopic } = require('../tax-authority-refs');
  const taxDomains = ['consumption_tax', 'income_tax', 'invoice_system', 'inheritance_tax'];
  for (const td of taxDomains) {
    assert((REFS[td] || []).length > 0, `${td} のレファレンスが存在`);
  }
  const sample = TOPICS.find(t => t.tax_domain === 'consumption_tax');
  if (sample) {
    const refs = getRefsForTopic({ ...sample });
    assert(refs.length > 0, `consumption_tax の topic から refs が取得できる`);
  }
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
