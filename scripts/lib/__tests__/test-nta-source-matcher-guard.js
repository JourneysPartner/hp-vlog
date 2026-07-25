'use strict';

const assert = require('assert');
const matter = require('gray-matter');
const {
  tokenizeForMatcher,
  rankSources,
  selectSource,
} = require('../nta-source-matcher');
const { resolveSourceForTopic } = require('../tax-authority-refs');
const {
  evaluateSourceGuard,
  restoreSourceGuardFields,
} = require('../source-guard');
const { evaluateTopicFit } = require('../customer-relevance');
const { normalizeGeneratedDraft } = require('../draft-normalizer');
const { selectDailyTopics } = require('../topic-selector');
const { approvalSourceGuard } = require('../../../netlify/functions/review-approve-background');
const { publicationSourceGuard } = require('../../publish-due');
const { CURATED_TOPICS, TOPICS } = require('../../topic-pool');

const U6501 = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm';
const U6502 = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6502.htm';

assert.strictEqual(CURATED_TOPICS.length, 54);
assert(CURATED_TOPICS.every(topic => topic.source_provenance === 'explicit'));
assert(TOPICS.every(topic => topic.source_url && topic.source_provenance),
  'every completed topic must be resolved before selection');

const matchTopic = {
  tax_domain: 'consumption_tax',
  pain_point: 'unmapped-high-value-case',
  search_intent: '高額特定資産を取得した場合の納税義務免除の特例',
  primary_question: '高額特定資産を取得した場合の3年縛りはどうなるか',
};

const tokens = tokenizeForMatcher('高額特定資産を取得した場合');
assert(tokens.has('高額'));
assert(tokens.has('特定'));

const ranking = rankSources(matchTopic);
assert.strictEqual(ranking.errorCode, null);
assert.strictEqual(ranking.candidates.length, 5);
assert.strictEqual(ranking.top1.no, '6502');
assert(ranking.top1.score >= 0.45);
assert(ranking.margin >= 0.12);
assert.strictEqual(selectSource(ranking).url, U6502);
assert.deepStrictEqual(rankSources(matchTopic), ranking, 'ranking must be deterministic');

const unavailable = rankSources(matchTopic, { indexPath: 'missing-index.json' });
assert.deepStrictEqual(unavailable, {
  candidates: [], top1: null, top2: null, margin: 0, errorCode: 'catalog_unavailable',
});

const ambiguous = rankSources({ tax_domain: 'consumption_tax', search_intent: '同一制度' }, {
  entries: [
    { id: '1', type: 'taxanswer', tax_category_code: 'shohi', title: '同一制度', url: 'https://example.test/1' },
    { id: '2', type: 'taxanswer', tax_category_code: 'shohi', title: '同一制度', url: 'https://example.test/2' },
  ],
});
assert.strictEqual(ambiguous.margin, 0);
assert.strictEqual(selectSource(ambiguous), null);

const explicit = resolveSourceForTopic({
  ...matchTopic,
  source_url: 'https://www.nta.go.jp/example-explicit',
  source_title: 'Human override',
  source_provenance: 'explicit',
});
assert.strictEqual(explicit.provenance, 'explicit');
assert.strictEqual(explicit.url, 'https://www.nta.go.jp/example-explicit');

const curated = resolveSourceForTopic({
  tax_domain: 'consumption_tax',
  pain_point: 'high-value-asset-3year-restriction',
});
assert.strictEqual(curated.provenance, 'curated');
assert.strictEqual(curated.url, U6502);

const automatic = resolveSourceForTopic(matchTopic);
assert.strictEqual(automatic.provenance, 'auto');
assert.strictEqual(automatic.url, U6502);

const fallback = resolveSourceForTopic({
  tax_domain: 'inheritance_tax',
  search_intent: '互いに関係のない曖昧な相談',
});
assert.strictEqual(fallback.provenance, 'domain-fallback');

const curatedMeta = {
  review_status: 'draft',
  source_guard_version: 1,
  source_provenance: 'curated',
  pain_point: 'high-value-asset-3year-restriction',
  tax_domain: 'consumption_tax',
  source_url: U6502,
};
assert.strictEqual(evaluateSourceGuard(curatedMeta, { stage: 'approve' }).allowed, true);
assert.strictEqual(evaluateSourceGuard({ ...curatedMeta, source_url: U6501 }, { stage: 'approve' }).blocked, true,
  'current URL must be rechecked even if a stored score was 5');
assert.strictEqual(evaluateSourceGuard({ ...curatedMeta, source_provenance: 'auto' }, { stage: 'approve' }).blocked, true);
// 未承認ドラフト（draft/needs_review/needs_revision）は validate では警告に留め、生成させる
// （承認/公開で保留する設計。ペアの片方が出典保留でも daily-draft バッチ全体を落とさない）。
assert.strictEqual(evaluateSourceGuard({ ...curatedMeta, source_provenance: 'auto' }, { stage: 'validate' }).blocked, false);
assert.strictEqual(evaluateSourceGuard({ ...curatedMeta, source_provenance: 'auto' }, { stage: 'validate' }).level, 'warning');
// ただし approved 等 LIVE ステータスは validate でもブロック（誤って公開させない）
assert.strictEqual(evaluateSourceGuard({ ...curatedMeta, source_provenance: 'auto', review_status: 'approved' }, { stage: 'validate' }).blocked, true);
// NEEDS_SOURCE_REVIEW の論点（例: retail-point-discount）の未承認ドラフトも validate は警告
assert.strictEqual(evaluateSourceGuard({ review_status: 'draft', source_guard_version: 1, source_provenance: 'curated', pain_point: 'retail-point-discount', tax_domain: 'invoice_system', source_url: 'https://www.nta.go.jp/x' }, { stage: 'validate' }).blocked, false);
assert.strictEqual(evaluateSourceGuard({ review_status: 'published' }, { stage: 'validate' }).allowed, true);
assert.strictEqual(evaluateSourceGuard({ review_status: 'draft' }, { stage: 'validate' }).allowed, true);
assert.strictEqual(evaluateSourceGuard({ review_status: 'draft' }, { stage: 'approve' }).blocked, true);
assert.strictEqual(evaluateSourceGuard({ review_status: 'needs_revision' }, { stage: 'approve' }).blocked, true);
assert.strictEqual(evaluateSourceGuard({ review_status: 'scheduled' }, { stage: 'validate' }).blocked, true);
assert.strictEqual(evaluateSourceGuard({ review_status: 'scheduled' }, { stage: 'publish' }).blocked, true);
const staleScoreArticle = `---
review_status: "needs_review"
source_guard_version: 1
source_provenance: "curated"
pain_point: "high-value-asset-3year-restriction"
tax_domain: "consumption_tax"
source_url: "${U6501}"
source_alignment_score: 5
recommendation: "publish"
---
body`;
assert.strictEqual(approvalSourceGuard(staleScoreArticle).blocked, true,
  'approval must recheck a curated URL changed after score 5 was saved');
assert.strictEqual(publicationSourceGuard(staleScoreArticle).blocked, true,
  'publication must recheck a curated URL changed after score 5 was saved');

const before = `---
source_url: "${U6502}"
source_title: "No.6502"
source_provenance: "auto"
source_confidence: 0.7
source_guard_version: 1
pain_point: "high-value-asset-3year-restriction"
tax_domain: "consumption_tax"
---
old`;
const tampered = `---
source_url: "${U6501}"
source_title: "changed"
source_provenance: "explicit"
source_confidence: 1
source_guard_version: 99
pain_point: "changed"
tax_domain: "income_tax"
---
new`;
for (const route of ['full', 'section', 'targeted', 'title_only']) {
  const restored = matter(restoreSourceGuardFields(before, tampered, { resolveSource: resolveSourceForTopic })).data;
  assert.strictEqual(restored.source_url, U6502, route);
  assert.strictEqual(restored.source_title, 'No.6502', route);
  assert.strictEqual(restored.source_provenance, 'auto', route);
  assert.strictEqual(restored.source_confidence, 0.7, route);
  assert.strictEqual(restored.source_guard_version, 1, route);
  assert.strictEqual(restored.pain_point, 'high-value-asset-3year-restriction', route);
  assert.strictEqual(restored.tax_domain, 'consumption_tax', route);
}

const autoTopic = {
  ...matchTopic,
  macro: '高額特定資産',
  cluster: 'high-value-asset',
  subcluster: 'source-matcher',
  title: '高額特定資産を取得した場合の消費税の判断',
  slug: 'matcher-source-hold-test',
  category: '消費税',
  persona: 'general_corporation',
  customer_segment: 'general_business',
  allowed_customer_segments: ['general_business'],
  article_type: 'basic_explainer',
  article_role: 'main',
  source_url: automatic.url,
  source_title: automatic.title,
  source_provenance: 'auto',
  source_confidence: automatic.confidence,
  reader_problem: '高額特定資産の取得後に免税へ戻れる時期が分からない',
  success_outcome: '納税義務の免除の特例を判断できる',
};
const fit = evaluateTopicFit(autoTopic);
assert.strictEqual(fit.decision, 'revise');
assert.strictEqual(fit.source_hold, true);
assert.strictEqual(fit.selection_eligible, true);
const selection = selectDailyTopics([autoTopic], { now: new Date('2026-07-19T00:00:00Z') });
const qualityStep = selection.explanation.steps.find(step => step.step === 'filter-quality-fit');
assert.strictEqual(qualityStep.remaining, 1, 'source-only hold must remain generation-eligible');

const generated = normalizeGeneratedDraft('## 要点\n本文\n## 判断\n本文', autoTopic, {
  now: '2026-07-19T00:00:00Z',
});
const generatedMeta = matter(generated.content).data;
assert.strictEqual(generatedMeta.source_provenance, 'auto');
assert.strictEqual(generatedMeta.source_guard_version, 1);
assert.strictEqual(generatedMeta.recommendation, 'revise');
assert.strictEqual(generatedMeta.source_hold, undefined);
assert.strictEqual(generatedMeta.selection_eligible, undefined);

console.log('PASS: matcher, resolver, source guard, regeneration guard, and source hold');
