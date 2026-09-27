'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  resolveDraftCount,
  resolveForcedTopics,
  generateFromTemplate,
  getExistingSlugs,
} = require('../../generate-draft');
const { selectByCount, selectDailyTopics } = require('../topic-selector');
const {
  TARGET_RATIOS,
  validateTargetRatios,
  hardCapFor,
  balanceScore,
  applyBalance,
} = require('../category-balance');
const { ALL_MACROS } = require('../cluster-taxonomy');
const {
  expandShitsugiTopics,
  loadPersonaAllowlist,
} = require('../shitsugi-topics');
const { TOPICS, CURATED_TOPICS } = require('../../topic-pool');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

console.log('=== 1. 生成本数 ===');
assert(resolveDraftCount() === 1 && resolveDraftCount('1') === 1, 'DRAFT_COUNT の既定値は 1');
assert(resolveDraftCount('2') === 2, 'DRAFT_COUNT=2 のときだけ 2 本モードになる');

const scored = [
  { topic: { slug: 'support-first', article_type: 'filing_practice' }, balance: 1 },
  { topic: { slug: 'main-second', article_type: 'basic_explainer' }, balance: 0.5 },
];
const single = selectByCount(scored, scored.map(entry => entry.topic), 1);
assert(single.length === 1 && single[0].slug === 'main-second', '1 本モードは本命だけを 1 本選ぶ');

const actualSingle = selectDailyTopics(TOPICS, { now: new Date('2026-09-27T09:05:00+09:00'), count: 1 }).picks;
assert(actualSingle.length === 1 && ['basic_explainer', 'comparison_decision'].includes(actualSingle[0].article_type), '実際の topic-pool でも本命を 1 本だけ選ぶ');

const completeGuide = CURATED_TOPICS.find(topic => topic.slug === 'ebay-export-consumption-tax-refund-complete-guide');
const draft = matter(generateFromTemplate('2026-09-27', completeGuide, null));
assert(draft.data.article_role === 'main', '1 本モードの生成物は article_role=main');
assert(draft.data.related_slug === '' && draft.data.related_title === '', 'pairedTopic=null なら関連記事メタは空');

const workflow = read(path.join('.github', 'workflows', 'daily-draft.yml'));
assert(/count:\s*\n\s+description:[\s\S]*?default: '1'[\s\S]*?options:\s*\n\s+- '1'\s*\n\s+- '2'/.test(workflow), '手動入力 count は既定 1、選択肢 1/2');
assert(workflow.includes("DRAFT_COUNT: ${{ inputs.count || '1' }}"), 'workflow が count を DRAFT_COUNT に渡す');
assert(workflow.includes("if: inputs.count == '2' && steps.prep.outputs.skipped != 'true' && steps.prep.outputs.basename2 == ''"), '2 本目不足の通知は count=2 のときだけ');

console.log('\n=== 2. 月・水・金の実行 ===');
const netlify = read('netlify.toml');
assert(/\[functions\."scheduler-daily-draft"\]\s*\n\s*schedule = "5 0 \* \* 1,3,5"/.test(netlify), '下書き生成 cron は月・水・金の JST 9:05');
assert(/\[functions\."scheduler-publish"\]\s*\n\s*schedule = "0 3 \* \* \*"/.test(netlify), '昼の予約公開 cron は変更しない');
assert(/\[functions\."scheduler-publish-evening"\]\s*\n\s*schedule = "0 9 \* \* \*"/.test(netlify), '夕方の予約公開 cron は変更しない');

console.log('\n=== 3. macro 目標比率 ===');
const validation = validateTargetRatios();
assert(validation.valid && Math.abs(validation.total - 1) <= 0.01, '目標比率の合計は 1.0 ± 0.01');
assert(Object.keys(TARGET_RATIOS).every(macro => ALL_MACROS.includes(macro)), '配分表に ALL_MACROS 外の名前がない');
assert(TARGET_RATIOS['物販'] === 0.5 && TARGET_RATIOS['相続贈与'] === 0.02, '物販 50%、相続贈与 2% を既定値にする');
assert(Math.abs(hardCapFor('物販') - 0.85) < 1e-9 && Math.abs(hardCapFor('建設') - 0.21) < 1e-9, 'macro ごとの 7 日上限を計算する');

const retailRatios = {
  ratios: { 7: { '物販': 0.8 }, 14: { '物販': 0.45 }, 30: { '物販': 0.5 } },
  totals: { 7: 3, 14: 4, 30: 12 },
};
assert(balanceScore('物販', retailRatios).hardBlocked === false, '物販が 14 日で 45% でもブロックしない');

const inheritanceRatios = {
  ratios: { 7: { '相続贈与': 0.15 }, 14: { '相続贈与': 0.15 }, 30: { '相続贈与': 0.1 } },
  totals: { 7: 3, 14: 20, 30: 30 },
};
assert(balanceScore('相続贈与', inheritanceRatios).hardBlocked === true, '相続贈与が 15% なら 7 日上限でブロックする');
const sparseRatios = { ...inheritanceRatios, totals: { ...inheritanceRatios.totals, 14: 3 } };
assert(balanceScore('相続贈与', sparseRatios).hardBlocked === false, '14 日の実績が 4 本未満なら 7 日上限を適用しない');

const zeroRatios = {
  ratios: { 7: {}, 14: {}, 30: {} },
  totals: { 7: 0, 14: 0, 30: 0 },
};
const balanced = applyBalance([{ slug: 'tax', macro: '税目実務' }, { slug: 'retail', macro: '物販' }], zeroRatios);
assert(balanced.scored.some(entry => entry.topic.slug === 'retail') && balanced.blocked.some(entry => entry.topic.slug === 'tax'), '目標 0% の macro は他候補がある間ブロックする');

console.log('\n=== 4. 質疑応答 persona allowlist ===');
const allowlist = loadPersonaAllowlist();
const expectedAllowlist = [
  'ebay_export_seller', 'domestic_ec_seller', 'reseller_marketplace_seller',
  'construction_solo', 'content_seller', 'influencer_creator',
];
assert(JSON.stringify(allowlist) === JSON.stringify(expectedAllowlist), 'allowlist の既定値が指示どおり');

const limitedShitsugi = expandShitsugiTopics({ logger: null, filterRelevance: false });
assert(limitedShitsugi.length > 0 && limitedShitsugi.every(topic => allowlist.includes(topic.persona)), 'allowlist 外の質疑応答候補を出力しない');
const unlimitedShitsugi = expandShitsugiTopics({ logger: null, filterRelevance: false, personaAllowlist: [] });
assert(unlimitedShitsugi.length > limitedShitsugi.length && unlimitedShitsugi.some(topic => !allowlist.includes(topic.persona)), '空配列なら persona 制限を解除する');
const poolShitsugi = TOPICS.filter(topic => topic.demand_evidence && topic.demand_evidence.kind === 'nta-shitsugi');
assert(poolShitsugi.every(topic => allowlist.includes(topic.persona)), 'topic-pool に allowlist 外の質疑応答候補がない');

console.log('\n=== 5. eBay 消費税還付の中核トピック ===');
assert(Boolean(completeGuide), '中核トピックが curated pool にある');
assert(completeGuide && completeGuide.persona === 'ebay_export_seller' && completeGuide.macro === '物販', '中核トピックの persona / macro が正しい');
assert(completeGuide && completeGuide.article_type === 'basic_explainer' && completeGuide.article_role === 'main', '中核トピックは本命の基本解説');
assert(completeGuide && Array.isArray(completeGuide.source_supplements)
  && completeGuide.source_supplements.some(source => source.no === '6613')
  && completeGuide.source_supplements.some(source => source.no === '6615'), '出典候補に No.6613 と申告書・添付書類ページがある');
// 完全ガイドは 2026-09-27 に生成・承認済みなので、slug が記事に使われていることはもう前提。ここでは確認しない。
const forced = resolveForcedTopics([completeGuide.slug], TOPICS);
assert(forced.length === 1 && forced[0].slug === completeGuide.slug, '--force-slug は類似度選定を通さず中核トピックを指定できる');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
