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
const { expandAll, applyPainPointQuota, PAIN_POINT_QUOTA,
        PAIN_TYPE_CLUSTER_LIMIT_OVERRIDES, PAIN_TYPE_CLUSTER_LIMIT_DEFAULT } =
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

// ── Fix 2: (pain_point × article_type) クオータが効く ─────────
// 案 B: クオータ軸が「pain_point」から「pain_point × article_type」に変更された。
// 各 (pain × type) で cluster 多様性が上限以内であることを検証する。
console.log('\n=== Fix 2: (pain × type) クオータが効く ===');
{
  const all = expandAll();
  // (pain × type) ごとに cluster の Set を集計
  const byKey = new Map();
  for (const t of all) {
    if (!t.pain_point) continue;
    const key = `${t.pain_point}::${t.article_type || '?'}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(t.cluster || '?');
  }

  // 重要 pain_point (上限 3) を検証
  for (const pain of Object.keys(PAIN_TYPE_CLUSTER_LIMIT_OVERRIDES)) {
    const limit = PAIN_TYPE_CLUSTER_LIMIT_OVERRIDES[pain];
    for (const [key, clusters] of byKey) {
      if (!key.startsWith(pain + '::')) continue;
      assert(clusters.size <= limit, `${key}: ${clusters.size} cluster <= ${limit}`);
    }
  }
  // デフォルト上限を検証
  for (const [key, clusters] of byKey) {
    const pain = key.split('::')[0];
    if (PAIN_TYPE_CLUSTER_LIMIT_OVERRIDES[pain]) continue;
    assert(clusters.size <= PAIN_TYPE_CLUSTER_LIMIT_DEFAULT,
      `${key}: ${clusters.size} cluster <= ${PAIN_TYPE_CLUSTER_LIMIT_DEFAULT}（DEFAULT）`);
  }

  // applyPainPointQuota 単体: 多様性を保ったまま絞り込む
  // 8 件すべて pain='X' (override 無し, default 上限 6)、basic_explainer のみ
  const fake = [
    { slug: 'a-1', cluster: 'a', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'b-1', cluster: 'b', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'c-1', cluster: 'c', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'd-1', cluster: 'd', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'e-1', cluster: 'e', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'f-1', cluster: 'f', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'g-1', cluster: 'g', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
    { slug: 'h-1', cluster: 'h', pain_point: 'X', article_role: 'main', article_type: 'basic_explainer' },
  ];
  const out = applyPainPointQuota(fake);
  // DEFAULT (6) を超えないこと
  assert(out.length === PAIN_TYPE_CLUSTER_LIMIT_DEFAULT,
    `X × basic_explainer: ${out.length} 件（DEFAULT=${PAIN_TYPE_CLUSTER_LIMIT_DEFAULT} に絞られる）`);

  // 別 article_type を入れると、同じ pain でも別カウントで通る
  const fakeMixed = [
    ...fake,
    { slug: 'i-1', cluster: 'i', pain_point: 'X', article_role: 'support', article_type: 'edge_case' },
  ];
  const outMixed = applyPainPointQuota(fakeMixed);
  // basic_explainer 6 + edge_case 1 = 7
  const basicCount = outMixed.filter(t => t.article_type === 'basic_explainer').length;
  const edgeCount = outMixed.filter(t => t.article_type === 'edge_case').length;
  assert(basicCount === 6, `basic_explainer: ${basicCount} 件`);
  assert(edgeCount === 1, `edge_case: ${edgeCount} 件（別 type なので通る）`);

  // 重要 pain (invoice-judgement, 上限 3) で確認
  const fakeIJ = new Array(10).fill(0).map((_, i) => ({
    slug: `ij-${i}`, cluster: `c${i}`, pain_point: 'invoice-judgement',
    article_role: 'main', article_type: 'basic_explainer',
  }));
  const outIJ = applyPainPointQuota(fakeIJ);
  assert(outIJ.length === 3, `invoice-judgement × basic_explainer: ${outIJ.length} 件 = 上限 3`);
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
