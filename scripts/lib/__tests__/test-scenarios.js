'use strict';

/**
 * シナリオ展開エンジンのテスト。
 *   node scripts/lib/__tests__/test-scenarios.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { expandAll, expandRetail, expandInfluencer, expandSalon,
        expandInheritance, expandGeneral, expandTaxDomain }
  = require(path.join(ROOT, 'scripts/lib/scenario-expansion'));
const { getAllTopics, CURATED_TOPICS } = require(path.join(ROOT, 'scripts/topic-pool'));

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. expandAll が大量に展開する ───────────────────────────────
console.log('\n=== Test 1: expandAll で大量候補が生成される ===');
{
  const topics = expandAll();
  assert(topics.length >= 1000, `topics.length=${topics.length} >= 1000`);
}

// ── 2. 各 macro が十分な候補数を持つ ────────────────────────────
console.log('\n=== Test 2: 各macroで候補数が十分（>=20）===');
{
  const topics = expandAll();
  const byMacro = {};
  for (const t of topics) byMacro[t.macro] = (byMacro[t.macro] || 0) + 1;
  for (const macro of ['物販', 'インフルエンサー', 'サロン', '相続贈与', '一般事業者', '税目実務']) {
    assert((byMacro[macro] || 0) >= 20, `${macro}: ${byMacro[macro]||0} 件 >= 20`);
  }
}

// ── 3. 相続の life_stage 別の展開 ────────────────────────────────
console.log('\n=== Test 3: 相続が life_stage 別に展開される ===');
{
  const inh = expandInheritance();
  const stages = new Set(inh.map(t => t.life_stage));
  assert(stages.size >= 6, `life_stage の種類: ${stages.size} >= 6`);
  // 各 life_stage で複数候補
  const byStage = {};
  for (const t of inh) byStage[t.life_stage] = (byStage[t.life_stage] || 0) + 1;
  const minPerStage = Math.min(...Object.values(byStage));
  assert(minPerStage >= 2, `1 life_stage あたり最低 ${minPerStage} 件 >= 2`);
}

// ── 4. 物販のプラットフォーム × stage × pain ─────────────────────
console.log('\n=== Test 4: 物販のプラットフォーム別展開 ===');
{
  const r = expandRetail();
  const platforms = new Set(r.map(t => t.cluster));
  assert(platforms.size >= 6, `platform 数: ${platforms.size} >= 6 (eBay/Amazon/Yahoo*/Mercari/Shopify)`);
  assert(r.some(t => t.cluster === 'ebay'),    'eBay 候補あり');
  assert(r.some(t => t.cluster === 'amazon'),  'Amazon 候補あり');
  assert(r.some(t => t.cluster === 'mercari'), 'メルカリ 候補あり');
  assert(r.some(t => t.cluster === 'shopify'), 'Shopify 候補あり');
}

// ── 5. インフルエンサーの channel 別展開 ──────────────────────────
console.log('\n=== Test 5: インフルエンサーの media 別展開 ===');
{
  const inf = expandInfluencer();
  const clusters = new Set(inf.map(t => t.cluster));
  assert(clusters.has('youtube'),   'YouTube あり');
  assert(clusters.has('instagram'), 'Instagram あり');
  assert(clusters.has('tiktok'),    'TikTok あり');
}

// ── 6. サロンの業種別展開 ────────────────────────────────────────
console.log('\n=== Test 6: サロンの業種別展開 ===');
{
  const sa = expandSalon();
  const clusters = new Set(sa.map(t => t.cluster));
  for (const c of ['hair-salon', 'nail-salon', 'eyelash', 'hair-removal', 'esthetic']) {
    assert(clusters.has(c), `${c} あり`);
  }
}

// ── 7. 全 topic に必須フィールドがある ──────────────────────────
console.log('\n=== Test 7: 全 topic に必須フィールドがある ===');
{
  const topics = expandAll();
  const required = ['macro', 'cluster', 'subcluster', 'persona', 'tax_domain',
                    'category', 'article_type', 'article_role', 'title', 'slug',
                    'search_intent', 'primary_question'];
  let allOk = true;
  for (const t of topics) {
    for (const f of required) {
      if (!t[f]) {
        allOk = false;
        console.error(`  ✗ ${t.slug}: ${f} 未設定`);
        failed++;
        break;
      }
    }
    if (!allOk) break;
  }
  if (allOk) { console.log(`  ✓ 全 ${topics.length} 件で必須フィールド充足`); passed++; }
}

// ── 7b. 全 topic に source_url / source_title がある（validate.js 互換）─
console.log('\n=== Test 7b: 全 topic に source_url / source_title がある ===');
{
  const topics = expandAll();
  const missing = topics.filter(t => !t.source_url || !t.source_title);
  assert(missing.length === 0,
    `source 未設定: ${missing.length}/${topics.length}` +
    (missing.length > 0 ? ` 例: ${missing[0].slug}` : ''));
  // 国税庁 URL であること
  const ntaCount = topics.filter(t => /nta\.go\.jp/.test(t.source_url)).length;
  assert(ntaCount === topics.length, `全 ${topics.length} 件が国税庁 URL（実: ${ntaCount}）`);
}

// ── 8. title にテンプレートプレースホルダが残っていない ─────────
console.log('\n=== Test 8: title に未充足プレースホルダがない ===');
{
  const topics = expandAll();
  const broken = topics.filter(t => /\{[a-zA-Z_]+\}/.test(t.title));
  if (broken.length === 0) {
    console.log(`  ✓ 全 ${topics.length} 件で title 充足`);
    passed++;
  } else {
    console.error(`  ✗ ${broken.length} 件で未充足: ${broken.slice(0, 3).map(t => t.title).join(' | ')}`);
    failed++;
  }
}

// ── 9. slug がユニーク（拡張内 + curated とも重複しない）────────
console.log('\n=== Test 9: 展開済 slug がユニーク ===');
{
  const topics = expandAll();
  const slugs = topics.map(t => t.slug);
  const dup = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  assert(dup.length === 0, `展開内重複: ${dup.length} 件`);
}

// ── 10. getAllTopics: curated + expanded がマージされる ─────────
console.log('\n=== Test 10: topic-pool が curated と expanded をマージ ===');
{
  const all = getAllTopics();
  assert(all.length > CURATED_TOPICS.length, `合計 ${all.length} > curated ${CURATED_TOPICS.length}`);
  assert(all.length >= 1000, `合計 ${all.length} >= 1000（候補空間が大きい）`);
  // curated の代表 slug が含まれる
  assert(all.some(t => t.slug === 'ebay-export-consumption-tax-refund-guide'), 'curated slug を含む');
  // expanded の代表 slug が含まれる
  assert(all.some(t => t._origin === 'scenario-expansion'), 'expanded topic を含む');
}

// ── 11. シナリオ展開で main + support のペアが組める ────────────
console.log('\n=== Test 11: 各 pair_group に main+support が揃う ===');
{
  const topics = expandAll();
  const byPair = {};
  for (const t of topics) {
    if (!t.pair_group) continue;
    (byPair[t.pair_group] = byPair[t.pair_group] || []).push(t);
  }
  const samplePairs = Object.values(byPair).slice(0, 50);
  let okPairs = 0;
  for (const arr of samplePairs) {
    const hasMain = arr.some(t => t.article_role === 'main');
    const hasSup  = arr.some(t => t.article_role === 'support');
    if (hasMain && hasSup) okPairs++;
  }
  assert(okPairs >= samplePairs.length * 0.9, `${okPairs}/${samplePairs.length} のペアで main+support 揃う`);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
