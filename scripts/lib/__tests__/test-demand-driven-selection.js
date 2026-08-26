'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const {
  expandShitsugiTopics,
  CATEGORY_BY_TAX_CATEGORY,
  TAX_DOMAIN_BY_CODE,
} = require('../shitsugi-topics');
const { isNaturalCombination } = require('../customer-relevance');
const { loadSourceBody, buildSourceBodyBlock, parseShitsugiUrl } = require('../nta-source-body');
const { seasonBoost, loadEntries, monthInJapan } = require('../tax-calendar');
const {
  rankBySelectionPriority,
  enforceShitsugiDailyLimit,
  isShitsugiTopic,
} = require('../topic-selector');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const candidateData = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'data', 'nta-shitsugi-topics-candidate.json'),
  'utf8',
));
// 2026-08-26 の LLM 全件選別後は、接続対象が「手動採用276件」から
// 「選別で adopt になった候補」に変わった（isConnectable）。
const { isConnectable } = require(path.join(ROOT, 'scripts/lib/shitsugi-topics'));
const adopted = candidateData.candidates.filter(isConnectable);
const topics = expandShitsugiTopics({ logger: null, filterRelevance: false });

console.log('\n=== R6-1: 質疑応答候補の変換 ===');
assert(adopted.length >= 500, `接続対象は選別 adopt の候補（実際 ${adopted.length} 件）`);
assert(candidateData.candidates.every(c => c.llm_triage && c.llm_triage.decision), '全982件が LLM 選別済み');
assert(topics.length >= adopted.length - 5 && topics.length <= adopted.length,
  `接続対象のほぼ全件を変換できる（変換 ${topics.length} / 対象 ${adopted.length}）`);
assert(new Set(topics.map(topic => topic.slug)).size === topics.length, 'slug が一意');
assert(topics.every(topic => /^shitsugi-[a-z]+-[a-z0-9_-]+-[a-z0-9_-]+$/i.test(topic.slug)),
  'slug が質疑応答専用形式');
assert(topics.every(topic => topic.source_provenance === 'explicit' && topic.source_confidence === 1),
  '出典が explicit / confidence=1');
assert(topics.every(topic => topic.title === '' && topic.pair_group === undefined),
  'title は空で pair_group は付けない');
assert(topics.every(topic => topic.demand_evidence && topic.demand_evidence.kind === 'nta-shitsugi'),
  '需要の証拠が選定メタデータに入る');

const adoptedBySlug = new Map(candidateData.candidates.map(candidate => [
  `shitsugi-${candidate.tax_category_code}-${candidate.section}-${candidate.id}`,
  candidate,
]));
assert(topics.every(topic => {
  const source = adoptedBySlug.get(topic.slug);
  return source
    && topic.category === CATEGORY_BY_TAX_CATEGORY[source.tax_category]
    && topic.tax_domain === TAX_DOMAIN_BY_CODE[source.tax_category_code];
}), 'category / tax_domain が変換表どおり');

const sample = topics.find(topic => topic.slug === 'shitsugi-shohi-19-18');
const sampleBody = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'data', 'nta-sources', 'shitsugi', 'shohi', '19', '18.json'),
  'utf8',
));
assert(sample.reader_problem === sampleBody.shokai_yoshi.replace(/\s+/g, ' ').trim(),
  '照会要旨から reader_problem を組み立てる');
assert(sample.primary_question === sample.reader_problem, '照会要旨が primary_question に入る');

console.log('\n=== R6-2: 関連性ゲート通過率 ===');
const relevancePassed = topics.filter(isNaturalCombination).length;
const relevanceRate = topics.length > 0 ? relevancePassed / topics.length : 0;
console.log(`  関連性ゲート: ${relevancePassed}/${topics.length} (${(relevanceRate * 100).toFixed(2)}%)`);
assert(relevanceRate >= 0.9, '関連性ゲート通過率が90%以上');

console.log('\n=== R6-3: 質疑応答事例の出典本文 ===');
const parsedUrl = parseShitsugiUrl(sample.source_url);
assert(parsedUrl && parsedUrl.category === 'shohi' && parsedUrl.section === '19' && parsedUrl.id === '18',
  '質疑応答URLをパースできる');
const loadedBody = loadSourceBody(sample.source_url);
assert(loadedBody && loadedBody.kind === 'shitsugi', '質疑応答本文をカタログから取得できる');
assert(loadedBody.body.includes('土地と建物を一括して1億円で譲渡'), '取得本文に照会要旨が含まれる');
const sourceBlock = buildSourceBodyBlock(sample, []);
assert(sourceBlock.includes('国税庁 質疑応答事例'), 'プロンプト用の質疑応答本文ブロックを生成できる');
assert(sourceBlock.includes('土地と建物を一括して1億円で譲渡'), '本文ブロックに実際の照会要旨が入る');

console.log('\n=== R6-4: 税務カレンダーの季節判定 ===');
const calendarEntries = loadEntries();
assert(calendarEntries.length === 8, '付録1の8エントリを読み込める');
for (const entry of calendarEntries) {
  const targetMonth = entry.boost_months[0];
  const outsideMonth = Array.from({ length: 12 }, (_, index) => index + 1)
    .find(month => !entry.boost_months.includes(month));
  const topic = { tax_domain: '__keyword_only__', search_intent: entry.keywords[0] };
  const targetNow = new Date(Date.UTC(2026, targetMonth - 1, 15, 3));
  const outsideNow = new Date(Date.UTC(2026, outsideMonth - 1, 15, 3));
  assert(seasonBoost(topic, targetNow) === 1, `${entry.label}: 対象月は1`);
  assert(seasonBoost(topic, outsideNow) === 0, `${entry.label}: 対象外月は0`);
}
assert(monthInJapan(new Date('2026-01-31T15:30:00.000Z')) === 2,
  '月判定はUTCではなく日本時間');

console.log('\n=== R6-5: 複合優先度と balance の同点決着 ===');
const priorityNow = new Date('2026-02-15T03:00:00.000Z');
const demandTopic = {
  slug: 'priority-demand', search_intent: '一般的な税務',
  demand_evidence: { kind: 'nta-shitsugi', score: 80 },
};
const seasonTopic = { slug: 'priority-season', search_intent: '確定申告' };
const plainTopic = { slug: 'priority-plain', search_intent: '一般的な税務' };
const ranked = rankBySelectionPriority([
  { topic: plainTopic, balance: 10 },
  { topic: seasonTopic, balance: 10 },
  { topic: demandTopic, balance: -10 },
], priorityNow);
assert(ranked.map(entry => entry.topic.slug).join(',') === 'priority-demand,priority-season,priority-plain',
  '需要の証拠あり > 季節一致のみ > どちらも無し');

const balanceRanked = rankBySelectionPriority([
  { topic: { slug: 'balance-low', search_intent: '一般的な税務' }, balance: 1 },
  { topic: { slug: 'balance-high', search_intent: '一般的な税務' }, balance: 2 },
], priorityNow);
assert(balanceRanked[0].topic.slug === 'balance-high', 'priority 同点時は balance 降順');

console.log('\n=== R6-6: 質疑応答由来は1日最大1件 ===');
const shitsugiOnly = [1, 2, 3].map(index => ({
  slug: `shitsugi-test-${index}-item`,
  article_type: 'case_study',
  demand_evidence: { kind: 'nta-shitsugi', score: 90 - index },
}));
const shitsugiScored = shitsugiOnly.map((topic, index) => ({ topic, priority: 4 - index }));
const limitedOnly = enforceShitsugiDailyLimit(shitsugiOnly.slice(0, 2), shitsugiScored);
assert(limitedOnly.filter(isShitsugiTopic).length <= 1, '質疑応答候補だけでも picks は最大1件');

const ordinary = { slug: 'ordinary-replacement-topic', article_type: 'basic_explainer' };
const limitedWithReplacement = enforceShitsugiDailyLimit(shitsugiOnly.slice(0, 2), [
  ...shitsugiScored,
  { topic: ordinary, priority: 0 },
]);
assert(limitedWithReplacement.length === 2 && limitedWithReplacement.filter(isShitsugiTopic).length === 1,
  '非質疑応答の次点があれば2本目を差し替える');

console.log('\n=== R6-7: 無効化フラグ ===');
withEnv('DISABLE_SHITSUGI_TOPICS', 'true', () => {
  assert(expandShitsugiTopics({ logger: null }).length === 0, 'DISABLE_SHITSUGI_TOPICS=true で候補0件');
});
withEnv('DISABLE_SEASON_BOOST', 'true', () => {
  assert(seasonBoost({ tax_domain: 'income_tax' }, priorityNow) === 0,
    'DISABLE_SEASON_BOOST=true で常に0');
});

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
