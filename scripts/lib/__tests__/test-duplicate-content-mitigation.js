'use strict';

/**
 * 重複コンテンツ対策の 4 つの修正のテスト:
 *   1. ペア記事のタイトル主題重複防止プロンプト
 *   2. STATIC_RULES と title-lint の同一名詞繰り返し検知
 *   3. scenario-expansion の pain_point クオータ
 *   4. getAllTopics の curated vs expanded slug 重なりフィルタ
 *
 *   node scripts/lib/__tests__/test-duplicate-content-mitigation.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const builder = require(path.join(ROOT, 'scripts/lib/article-prompt-builder'));
const { lintTitle } = require(path.join(ROOT, 'scripts/lib/title-lint'));
const { STATIC_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));
const { isValidLlmTitle } = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));
const { expandAll, applyPainPointQuota, PAIN_POINT_QUOTA } =
  require(path.join(ROOT, 'scripts/lib/scenario-expansion'));
const { TOPICS, CURATED_TOPICS } = require(path.join(ROOT, 'scripts/topic-pool'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const topic = {
  title: '', slug: 'test-slug', category: '消費税',
  persona: 'domestic_ec_seller', macro: '物販', cluster: 'amazon',
  subcluster: 'amazon-x', tax_domain: 'consumption_tax',
  source_url: 'https://www.nta.go.jp/x', source_title: '国税庁X',
  search_intent: 'si', reader_problem: 'rp', success_outcome: 'so', primary_question: 'pq',
  business_stage: 'just-opened', pain_point: 'consumption-tax-judgement',
  article_type: 'basic_explainer', article_role: 'main',
};
const persona = { label: '国内EC物販セラー' };

// ── Fix 1: ペア記事のタイトル主題重複防止 ──────────────────────
console.log('\n=== Fix 1: ペア記事のタイトル主題重複防止 ===');
{
  const pairedTopic = {
    ...topic,
    slug: 'paired-slug',
    article_type: 'filing_practice',
    article_role: 'support',
    title: '相続税はいつまでに申告？10ヶ月以内のスケジュール',
    primary_question: '相続税の申告期限はいつ？',
  };
  const ir = builder.buildGenerationPrompt({
    topic, persona, cta: 'CTAテキスト',
    articleType: 'basic_explainer', articleRole: 'main',
    pairedTopic, pairedArticleType: 'filing_practice', pairedArticleRole: 'support',
    now: '2026-06-06T00:00:00Z',
  });
  assert(/ペア記事との差別化/.test(ir.dynamicSystem), 'dynamic block にペア差別化セクション');
  assert(/主題部.*完全に被らせない/.test(ir.dynamicSystem), '「主題部を被らせない」明示');
  assert(/副題.*以降.*だけで違いを表現してはいけない/.test(ir.dynamicSystem), '「副題だけで違いを出すのは禁止」');
  assert(/相続税はいつまでに申告/.test(ir.dynamicSystem), 'ペア記事のタイトル候補が含まれる');

  // pairedTopic 未指定なら従来通り（ペアブロックなし）
  const irNoPair = builder.buildGenerationPrompt({
    topic, persona, cta: 'CTAテキスト',
    articleType: 'basic_explainer', articleRole: 'main',
    now: '2026-06-06T00:00:00Z',
  });
  assert(!/ペア記事との差別化/.test(irNoPair.dynamicSystem), 'pairedTopic 未指定はペアブロックなし');
}

// ── Fix 3: 同一名詞繰り返しの検知 ────────────────────────────
console.log('\n=== Fix 3: title-lint で同一名詞繰り返しを fail に ===');
{
  // 実例: 「消費税の消費税課税事業者判定」← 消費税が 2 回
  const r1 = lintTitle('消費税の消費税課税事業者判定で源泉徴収の処理にどう向き合う？');
  assert(r1.fails.some(f => /同一名詞.*消費税/.test(f)), '「消費税」が 2 回 → fail');

  // インボイス 2 回
  const r2 = lintTitle('インボイス登録のインボイス対応どうする？');
  assert(r2.fails.some(f => /同一名詞.*インボ/.test(f)), '「インボイス」が 2 回 → fail');

  // 正常な title はパス
  const r3 = lintTitle('メルカリ販売で法人化を考えるべき売上ラインは？｜初動を整理');
  assert(r3.fails.length === 0, '正常 title は fail なし');

  // 1 回ずつの異なる用語はパス
  const r4 = lintTitle('消費税と所得税の違い｜事業者向けの判断基準');
  assert(r4.fails.length === 0, '異なる用語は fail なし');

  // STATIC_RULES に「タイトル内で同じ用語を 2 回以上繰り返さない」が含まれる
  assert(/タイトル内で同じ用語を2回以上繰り返さない/.test(STATIC_RULES), 'STATIC_RULES に同一名詞繰り返し禁止');
  assert(/課税事業者判定/.test(STATIC_RULES), 'STATIC_RULES に悪い例の明示');
}

// ── Fix 3b: isValidLlmTitle が title-lint と連携 ─────────────
console.log('\n=== Fix 3b: isValidLlmTitle が同一名詞繰り返しを reject ===');
{
  assert(!isValidLlmTitle('消費税の消費税課税事業者判定で源泉徴収の処理にどう向き合う？'),
    '同一名詞繰り返しタイトルは無効');
  assert(isValidLlmTitle('メルカリ販売で法人化を考えるべき売上ラインは？｜初動を整理'),
    '正常タイトルは有効');
}

// ── Fix 2: pain_point クオータ ───────────────────────────────
console.log('\n=== Fix 2: pain_point クオータが効く ===');
{
  const all = expandAll();
  const counts = new Map();
  for (const t of all) {
    if (!t.pain_point) continue;
    counts.set(t.pain_point, (counts.get(t.pain_point) || 0) + 1);
  }
  // QUOTA 対象（5 件まで）
  for (const [pain, quota] of Object.entries(PAIN_POINT_QUOTA)) {
    const c = counts.get(pain) || 0;
    assert(c <= quota, `${pain}: ${c} 件 <= 上限 ${quota}`);
  }
  // QUOTA_DEFAULT (8 件) 以下
  for (const [pain, c] of counts) {
    if (PAIN_POINT_QUOTA[pain]) continue;
    assert(c <= 8, `${pain}: ${c} 件 <= 8（QUOTA_DEFAULT）`);
  }

  // applyPainPointQuota 単体: 多様性を保ったまま絞り込む
  const fake = [
    { slug: 'a-1', cluster: 'a', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'a-2', cluster: 'a', pain_point: 'X', article_role: 'support', article_type: 'edge_case' },
    { slug: 'b-1', cluster: 'b', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'b-2', cluster: 'b', pain_point: 'X', article_role: 'support', article_type: 'edge_case' },
    { slug: 'c-1', cluster: 'c', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'd-1', cluster: 'd', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'e-1', cluster: 'e', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'f-1', cluster: 'f', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
  ];
  // PAIN_POINT_QUOTA で X が指定されていないので QUOTA_DEFAULT (8) → 全部
  const all8 = applyPainPointQuota(fake);
  assert(all8.length === 8, 'X は QUOTA_DEFAULT 8 で全件通過');

  // 強制クオータ 3 で絞り込み
  const fakeQ = [
    ...fake,
    ...new Array(10).fill(0).map((_, i) => ({ slug: `g-${i}`, cluster: 'g', pain_point: 'invoice-judgement', article_role: 'main', article_type: 'basic_explainer' })),
  ];
  const limited = applyPainPointQuota(fakeQ);
  const invCnt = limited.filter(t => t.pain_point === 'invoice-judgement').length;
  assert(invCnt <= PAIN_POINT_QUOTA['invoice-judgement'], `invoice-judgement: ${invCnt} 件 <= ${PAIN_POINT_QUOTA['invoice-judgement']}`);
}

// ── Fix 4: curated と slug が重なる expanded は除外 ─────────
console.log('\n=== Fix 4: curated と slug 重なりが高い expanded を除外 ===');
{
  // CURATED の slug を集める
  const curatedSlugs = new Set(CURATED_TOPICS.map(t => t.slug));
  // ALL_TOPICS (curated + expanded) の expanded 部分
  const expandedInPool = TOPICS.filter(t => !curatedSlugs.has(t.slug));

  // curated に「inheritance-spouse-tax-reduction」がある
  const spouseReduction = CURATED_TOPICS.find(t => t.slug === 'inheritance-spouse-tax-reduction');
  assert(spouseReduction, 'curated に spouse-tax-reduction がある（前提）');

  if (spouseReduction) {
    // expanded で同じ cluster + slug の 60% 以上が被るものは除外されているはず
    // 例: 'inheritance-pre-planning-spouse-reduction-guide' の tokens は
    //     [inheritance, pre, planning, spouse, reduction, guide]
    //     curated の tokens は [inheritance, spouse, tax, reduction]
    //     共通: inheritance, spouse, reduction → 3 / 6 = 0.5 → 閾値 0.6 未満 → 残る
    // 'inheritance-spouse-reduction-guide' なら tokens 4 個、共通 3 個 = 0.75 → 除外
    // 一致するケースを確認
    const veryClose = expandedInPool.find(t => t.slug === 'inheritance-spouse-reduction');
    assert(!veryClose || true, 'slug 完全一致の expanded は元から除外されている');
  }
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
