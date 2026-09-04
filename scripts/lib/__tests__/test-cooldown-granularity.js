'use strict';

/**
 * cooldown の判定単位が「論点」であることのテスト。
 *   node scripts/lib/__tests__/test-cooldown-granularity.js
 *
 * 背景: 2026-09-04 の日次生成で補強記事が作られなかった。
 *   cooldown が cluster（14日）と persona×category（7日）で判定しており、
 *   これらは「税目・シナリオ群」レベルの粗いラベルで中身は別論点である。
 *   例: cluster 'shitsugi-shotoku' の 173 件は国税庁 質疑応答事例 173 個＝別々の法令論点。
 *   1 本公開すると残り 172 論点が 14 日間止まり、候補が 8 件まで枯れて 1 本しか作れなかった。
 *   そこで cluster / persona×category での判定を廃止し、subcluster / pain_point / slug で見る。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  checkCooldown, filterByCooldown, DEFAULT_COOLDOWN,
} = require(path.join(ROOT, 'scripts/lib/cooldown'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const NOW = new Date('2026-09-04T00:06:00+09:00');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

console.log('\n=== Test: 粗いラベル（cluster / persona×category）では止めない ===');

// 2日前に公開した「所得税の質疑応答事例 04-08」
const yesterdaysShitsugi = {
  slug: 'shitsugi-shotoku-04-08',
  file: '2026-09-02-shitsugi-shotoku-04-08.md',
  primary_persona: 'general_individual_proprietor',
  category: '所得税',
  cluster: 'shitsugi-shotoku',
  subcluster: 'shitsugi-shotoku-04-08',
  pain_point: 'shitsugi-shotoku-04-08',
  published_at: daysAgo(2),
};

// 同じ cluster・同じ persona×category だが、全く別の法令論点
const otherShitsugi = {
  slug: 'shitsugi-shotoku-05-74',
  persona: 'general_individual_proprietor',
  category: '所得税',
  cluster: 'shitsugi-shotoku',
  subcluster: 'shitsugi-shotoku-05-74',
  pain_point: 'shitsugi-shotoku-05-74',
};

assert(checkCooldown(otherShitsugi, [yesterdaysShitsugi], NOW) === null,
  '同 cluster・同 persona×category でも、論点が違えば通る');

// 相続: persona×category が同じで論点が違うケース
const inheritancePost = {
  slug: 'suggest-souzoku-ikura-5998df',
  file: '2026-09-02-suggest-souzoku-ikura-5998df.md',
  primary_persona: 'inheritance_client',
  category: '相続',
  cluster: 'suggest-inheritance_tax',
  subcluster: 'suggest-inheritance_tax-ikura',
  pain_point: 'inheritance-tax-amount',
  published_at: daysAgo(2),
};
const inheritanceCandidate = {
  slug: 'inheritance-critical-immediate-bank-procedure-guide',
  persona: 'inheritance_client',
  category: '相続',
  cluster: 'inheritance',
  subcluster: 'critical-immediate-bank-procedure',
  pain_point: 'bank-procedure',
};
assert(checkCooldown(inheritanceCandidate, [inheritancePost], NOW) === null,
  '相続で 1 本出しても、別論点の相続テーマは止まらない');

console.log('\n=== Test: 論点が同じなら止める ===');

assert((checkCooldown({ ...otherShitsugi, subcluster: 'shitsugi-shotoku-04-08' },
  [yesterdaysShitsugi], NOW) || {}).level === 'subcluster',
  '同 subcluster は 30 日 cooldown でブロック');

assert(checkCooldown({ ...otherShitsugi, subcluster: 'shitsugi-shotoku-04-08' },
  [{ ...yesterdaysShitsugi, published_at: daysAgo(31) }], NOW) === null,
  '同 subcluster でも 31 日経てば通る');

assert((checkCooldown({ ...inheritanceCandidate, persona: 'beauty_salon_owner', pain_point: 'inheritance-tax-amount' },
  [inheritancePost], NOW) || {}).level === 'painPoint',
  '同 pain_point はペルソナが違っても 30 日 cooldown でブロック');

assert((checkCooldown({ slug: 'suggest-souzoku-ikura-5998df' },
  [{ ...inheritancePost, published_at: daysAgo(900) }], NOW) || {}).level === 'slug',
  '同 slug は何日経ってもブロック');

assert((checkCooldown({ ...otherShitsugi, subcluster: 'shitsugi-shotoku-04-08', cooldown_days: 1 },
  [yesterdaysShitsugi], NOW)) === null,
  'トピック側の cooldown_days 上書きが効く');

console.log('\n=== Test: 設定に粗いキーが復活していない ===');

assert(DEFAULT_COOLDOWN.cluster === undefined, 'DEFAULT_COOLDOWN に cluster が無い');
assert(DEFAULT_COOLDOWN.personaCategory === undefined, 'DEFAULT_COOLDOWN に personaCategory が無い');
assert(DEFAULT_COOLDOWN.subcluster === 30 && DEFAULT_COOLDOWN.painPoint === 30,
  'subcluster / pain_point は 30 日');

console.log('\n=== Test: 1 本公開しても同クラスタの候補が枯れない ===');

// 質疑応答クラスタを模した 173 論点。うち 1 本を 2 日前に公開済みとする。
const cluster173 = Array.from({ length: 173 }, (_, i) => ({
  slug: `shitsugi-shotoku-${i}`,
  persona: 'general_individual_proprietor',
  category: '所得税',
  cluster: 'shitsugi-shotoku',
  subcluster: `shitsugi-shotoku-${i}`,
  pain_point: `shitsugi-shotoku-${i}`,
}));
const corpus1 = [{
  slug: 'shitsugi-shotoku-0',
  file: '2026-09-02-shitsugi-shotoku-0.md',
  primary_persona: 'general_individual_proprietor',
  category: '所得税',
  cluster: 'shitsugi-shotoku',
  subcluster: 'shitsugi-shotoku-0',
  pain_point: 'shitsugi-shotoku-0',
  published_at: daysAgo(2),
}];
const { passed: survived } = filterByCooldown(cluster173, corpus1, NOW);
assert(survived.length === 172,
  `1 本公開後も残り 172 論点が候補に残る（実測 ${survived.length} 件）`);

console.log('\n=== Test: cluster の連投はブロックではなくスコア減点で散らす ===');

const { buildClusterRecency, priorityBreakdown, CLUSTER_RECENCY_DAYS } =
  require(path.join(ROOT, 'scripts/lib/topic-selector'));

const recency = buildClusterRecency([
  { slug: 'a', file: '2026-09-03-a.md', cluster: 'shitsugi-shotoku', published_at: daysAgo(1) },
  { slug: 'b', file: '2026-08-25-b.md', cluster: 'inheritance',      published_at: daysAgo(10) },
  { slug: 'c', file: '2026-07-01-c.md', cluster: 'ebay',             published_at: daysAgo(65) },
], NOW);

assert(recency.get('shitsugi-shotoku') === 1 && recency.get('inheritance') === 10,
  '直近に出した cluster の経過日数を集計する');
assert(recency.get('ebay') === undefined,
  CLUSTER_RECENCY_DAYS + ' 日より前の cluster は減点対象にしない');

const evidence = { demand_evidence: { kind: 'nta-shitsugi', score: 80 } };
const fresh  = priorityBreakdown({ ...evidence, cluster: 'shitsugi-shotoku' }, NOW, recency);
const stale  = priorityBreakdown({ ...evidence, cluster: 'inheritance' },      NOW, recency);
const unused = priorityBreakdown({ ...evidence, cluster: 'ebay' },             NOW, recency);

assert(fresh.priority < stale.priority && stale.priority < unused.priority,
  '昨日出した cluster < 10日前の cluster < 未使用の cluster の順に priority が上がる');
assert(unused.clusterRecent === 0 && fresh.clusterRecent > 0,
  '未使用 cluster は減点 0、連投 cluster は減点あり');
assert(priorityBreakdown({ ...evidence, cluster: 'shitsugi-shotoku' }, NOW).priority === unused.priority,
  'clusterRecency を渡さなければ従来どおり減点しない（後方互換）');
assert(fresh.priority > 0,
  '連投減点があっても、需要の証拠が強い候補は正の priority を保つ（減点であってブロックではない）');

console.log('\n=== Test: 大分類の偏り是正キャップ（直近7日30%）===');

const { balanceScore } = require(path.join(ROOT, 'scripts/lib/category-balance'));
const ratiosFor = r => ({
  ratios: { 7: { 相続贈与: r }, 14: { 相続贈与: r }, 30: { 相続贈与: r } },
  totals: { 7: 14, 14: 28, 30: 60 },
});
assert(balanceScore('相続贈与', ratiosFor(0.35)).hardBlocked === true,
  '直近7日で 35% を占める大分類はハードブロックされる');
assert(balanceScore('相続贈与', ratiosFor(0.25)).hardBlocked === false,
  '25% ならブロックしない');
console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
