'use strict';

/**
 * テーマ選定オーケストレーター。
 *
 * 入力: topic pool（topic-pool.js の TOPICS）
 * 出力: その日に生成すべき 1〜2 本のトピック（main + support のペア）
 *
 * 処理フロー:
 *   1. cluster / subcluster / tax_domain を全候補に解決
 *   2. 既存記事コーパス読み込み（site-corpus）
 *   3. 既存 slug を除外
 *   4. cooldown を適用（subcluster / cluster / persona×category）
 *   5. 類似度フィルタ: 既存記事との類似度が高すぎるものを除外
 *   6. カテゴリ偏り是正: balance スコアでハードブロック・スコアリング
 *   7. ペアリング: 同 pair_group 内、または異 cluster の本命+補強で組む
 *   8. 同日 2 本の最終類似度チェック（似すぎていれば 2 本目を別候補に）
 *
 * 候補が枯渇した場合のフォールバック:
 *   - 1 本だけでも出す（無理に 2 本目を出さない）
 *   - 全フィルタを通過する候補がない場合は、cooldown を緩和して再試行
 */

const { resolveCluster, resolveTaxDomain, MACRO } = require('./cluster-taxonomy');
const { readAllPostsSorted } = require('./site-corpus');
const { findSimilarInCorpus, similarityScore } = require('./topic-similarity');
const { filterByCooldown } = require('./cooldown');
const { computeMacroRatios, applyBalance, balanceScore } = require('./category-balance');
const { loadDenylist, isTopicDenied, findMatchingEntry, isTimeLimitedExpired } = require('./denylist');

const SIM_THRESHOLD_VS_CORPUS  = 0.55;
const SIM_THRESHOLD_BETWEEN_PAIR = 0.45;

const MAIN_TYPES = new Set(['basic_explainer', 'comparison_decision']);

/**
 * トピックに cluster / subcluster / tax_domain を付与する（破壊的）。
 */
function enrichTopic(topic) {
  if (topic._enriched) return topic;
  const cluster = resolveCluster({
    slug: topic.slug,
    persona: topic.persona,
    cluster: topic.cluster,
    subcluster: topic.subcluster,
    macro: topic.macro,
  });
  topic.macro      = cluster.macro;
  topic.cluster    = cluster.cluster;
  topic.subcluster = cluster.subcluster;
  topic.tax_domain = topic.tax_domain || resolveTaxDomain(topic);
  topic._enriched  = true;
  return topic;
}

/**
 * 同じ persona / category / pair_group / cluster でペアになる候補を組む。
 *
 * 戻り値: [main, support] または [main]
 */
function buildBestPair(scored, candidatesAll) {
  if (scored.length === 0) return [];
  if (scored.length === 1) return [scored[0].topic];

  // 1. 同 pair_group が揃っているか
  const groups = {};
  for (const s of scored) {
    const g = s.topic.pair_group;
    if (!g) continue;
    (groups[g] = groups[g] || []).push(s);
  }
  const fullPairs = Object.entries(groups).filter(([, arr]) => arr.length >= 2);
  if (fullPairs.length > 0) {
    // balance score の合計が最も高いペアを選ぶ
    let best = null;
    for (const [, arr] of fullPairs) {
      const main = arr.find(s => MAIN_TYPES.has(s.topic.article_type)) || arr[0];
      const support = arr.find(s => s !== main) || arr[1];
      const total = (main.balance || 0) + (support.balance || 0);
      if (!best || total > best.total) {
        best = { main, support, total };
      }
    }
    if (best) return [best.main.topic, best.support.topic];
  }

  // 2. ペアグループが組めない → 本命+補強の組み合わせをスコア順で探索
  // 上位から本命候補を選び、それと「異 cluster かつ補強型」のものを 2 本目に
  for (let i = 0; i < scored.length; i++) {
    const main = scored[i];
    const candidates = scored.slice(0, i).concat(scored.slice(i + 1));

    // 役割が逆になる候補を優先
    const mainIsMainType = MAIN_TYPES.has(main.topic.article_type);
    const roleCandidates = candidates.filter(s => MAIN_TYPES.has(s.topic.article_type) !== mainIsMainType);

    // cluster が異なる候補を優先
    const diffCluster = (roleCandidates.length ? roleCandidates : candidates)
      .filter(s => s.topic.cluster !== main.topic.cluster);

    // 類似度が低いもの優先
    const pool = diffCluster.length > 0 ? diffCluster : (roleCandidates.length ? roleCandidates : candidates);
    let support = null;
    let bestSim = Infinity;
    for (const s of pool) {
      const sim = similarityScore(
        { ...main.topic, slug: main.topic.slug },
        { ...s.topic, primary_persona: s.topic.persona }
      ).score;
      if (sim < SIM_THRESHOLD_BETWEEN_PAIR && sim < bestSim) {
        bestSim = sim;
        support = s;
      }
    }

    if (support) return [main.topic, support.topic];
  }

  // 3. それでも 2 本目が見つからない → 1 本目だけ
  return [scored[0].topic];
}

/**
 * メイン関数: 与えられたトピックプールから今日の 2 本を選ぶ。
 *
 * @param {Array} topics - topic-pool.TOPICS
 * @param {Object} options - { explain: bool, dryRun: bool, now: Date, requireTwo: bool }
 * @returns {Object} { picks: Topic[], explanation: object }
 */
function selectDailyTopics(topics, options = {}) {
  const now = options.now || new Date();
  const explanation = { steps: [] };

  // 0. 全候補を enrich
  const enriched = topics.map(enrichTopic);

  // 1. コーパス読込
  const corpus = readAllPostsSorted();
  explanation.steps.push({ step: 'corpus', count: corpus.length });

  // 2. 既存 slug 除外
  const existingSlugs = new Set(corpus.map(p => p.slug));
  let candidates = enriched.filter(t => !existingSlugs.has(t.slug));
  explanation.steps.push({
    step: 'filter-existing-slugs',
    excluded: enriched.length - candidates.length,
    remaining: candidates.length,
  });

  if (candidates.length === 0) {
    explanation.warnings = ['すべてのトピックが既存slugと重複（pool枯渇）'];
    return { picks: [], explanation };
  }

  // 2.5. 単年限定・期限切れトピックを除外（historical_only / valid_to / disabled）
  const timeLimitedExcluded = [];
  candidates = candidates.filter(t => {
    const r = isTimeLimitedExpired(t, now);
    if (r.expired) {
      timeLimitedExcluded.push({ slug: t.slug, reason: r.reason });
      return false;
    }
    return true;
  });
  explanation.steps.push({
    step: 'filter-time-limited',
    blocked: timeLimitedExcluded.length,
    remaining: candidates.length,
    blockedDetails: timeLimitedExcluded.slice(0, 5),
  });

  // 2.7. グローバル denylist（topic-denylist.json）でフィルタ
  const denylist = loadDenylist();
  const denylistExcluded = [];
  candidates = candidates.filter(t => {
    const hit = findMatchingEntry(t, denylist, now);
    if (hit) {
      denylistExcluded.push({
        slug: t.slug,
        denyType: hit.type,
        denyValue: hit.value,
        reason: hit.reason,
      });
      return false;
    }
    return true;
  });
  explanation.steps.push({
    step: 'filter-denylist',
    blocked: denylistExcluded.length,
    remaining: candidates.length,
    blockedDetails: denylistExcluded.slice(0, 5),
  });

  if (candidates.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat([
      'denylist / 単年限定で候補が枯渇しました',
    ]);
    return { picks: [], explanation };
  }

  // 3. cooldown 適用
  const { passed: afterCooldown, blocked: cooldownBlocked } = filterByCooldown(candidates, corpus, now);
  explanation.steps.push({
    step: 'filter-cooldown',
    blocked: cooldownBlocked.length,
    remaining: afterCooldown.length,
    blockedDetails: cooldownBlocked.slice(0, 5).map(b => ({
      slug: b.topic.slug, level: b.hit.level, reason: b.hit.reason, days: b.hit.days,
    })),
  });

  let working = afterCooldown.length > 0 ? afterCooldown : candidates;
  if (afterCooldown.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat(['cooldownで全滅 → cooldown無視で再選定']);
  }

  // 4. 類似度フィルタ（vs コーパス）
  const afterSim = [];
  const simBlocked = [];
  for (const t of working) {
    const candidateForSim = {
      slug: t.slug,
      title: t.title,
      search_intent: t.search_intent,
      reader_problem: t.reader_problem,
      success_outcome: t.success_outcome,
      primary_question: t.primary_question,
      cluster: t.cluster,
      subcluster: t.subcluster,
      persona: t.persona,
      category: t.category,
    };
    const hit = findSimilarInCorpus(candidateForSim, corpus, SIM_THRESHOLD_VS_CORPUS);
    if (hit) {
      simBlocked.push({ topic: t, hit });
    } else {
      afterSim.push(t);
    }
  }
  explanation.steps.push({
    step: 'filter-similarity',
    blocked: simBlocked.length,
    remaining: afterSim.length,
    blockedDetails: simBlocked.slice(0, 5).map(b => ({
      slug: b.topic.slug,
      similarTo: b.hit.post.slug,
      score: Number(b.hit.score.toFixed(3)),
    })),
  });

  working = afterSim.length > 0 ? afterSim : working;
  if (afterSim.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat(['類似度フィルタで全滅 → フィルタ緩和']);
  }

  // 5. カテゴリ偏り是正 + balance scoring
  const ratios = computeMacroRatios(now);
  const { scored: balanceScored, blocked: balanceBlocked } = applyBalance(working, ratios);
  explanation.steps.push({
    step: 'apply-balance',
    blocked: balanceBlocked.length,
    remaining: balanceScored.length,
    macroRatios7: ratios.ratios[7],
    macroRatios14: ratios.ratios[14],
    blockedDetails: balanceBlocked.slice(0, 5).map(b => ({
      slug: b.topic.slug, macro: b.topic.macro, reasons: b.reasons,
    })),
  });

  let scored = balanceScored.length > 0 ? balanceScored : working.map(t => ({
    topic: t, balance: 0, balanceReasons: [], hardBlocked: false,
  }));

  if (balanceScored.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat(['カテゴリ偏りハードブロックで全滅 → ブロック解除']);
  }

  // balance のスコア順でソート
  scored.sort((a, b) => (b.balance || 0) - (a.balance || 0));
  explanation.topCandidates = scored.slice(0, 8).map(s => ({
    slug: s.topic.slug,
    macro: s.topic.macro,
    cluster: s.topic.cluster,
    persona: s.topic.persona,
    category: s.topic.category,
    article_type: s.topic.article_type,
    balance: Number((s.balance || 0).toFixed(3)),
    reasons: s.balanceReasons || [],
  }));

  // 6. ペアリング
  const picks = buildBestPair(scored, candidates);
  explanation.picks = picks.map(p => ({
    slug: p.slug, title: p.title,
    macro: p.macro, cluster: p.cluster, subcluster: p.subcluster,
    persona: p.persona, category: p.category,
    article_type: p.article_type,
    article_role: MAIN_TYPES.has(p.article_type) ? 'main' : 'support',
  }));

  // 7. 同日 2 本の最終類似度チェック
  if (picks.length === 2) {
    const sim = similarityScore(
      { ...picks[0], slug: picks[0].slug },
      { ...picks[1], primary_persona: picks[1].persona }
    );
    explanation.pairSimilarity = Number(sim.score.toFixed(3));
    if (sim.score >= SIM_THRESHOLD_BETWEEN_PAIR) {
      explanation.warnings = (explanation.warnings || []).concat([
        `2本目との類似度が高い (${sim.score.toFixed(2)}) → 2本目を差し替え`,
      ]);
      // 2本目をリストの中から差し替え
      const replacement = scored.find(s =>
        s.topic !== picks[0] && s.topic !== picks[1] &&
        similarityScore(
          { ...picks[0], slug: picks[0].slug },
          { ...s.topic, primary_persona: s.topic.persona }
        ).score < SIM_THRESHOLD_BETWEEN_PAIR
      );
      if (replacement) {
        picks[1] = replacement.topic;
        explanation.picks[1] = {
          slug: picks[1].slug, title: picks[1].title,
          macro: picks[1].macro, cluster: picks[1].cluster, subcluster: picks[1].subcluster,
          persona: picks[1].persona, category: picks[1].category,
          article_type: picks[1].article_type,
          article_role: MAIN_TYPES.has(picks[1].article_type) ? 'main' : 'support',
        };
      } else {
        // 差し替え候補がない → 1本だけにする
        explanation.warnings.push('代替候補が見つからないため 2 本目を取り下げ、1 本のみ生成します');
        picks.pop();
        explanation.picks.pop();
      }
    }
  }

  return { picks, explanation };
}

module.exports = {
  selectDailyTopics,
  enrichTopic,
  buildBestPair,
  SIM_THRESHOLD_VS_CORPUS,
  SIM_THRESHOLD_BETWEEN_PAIR,
};
