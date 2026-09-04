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
 *   4. cooldown を適用（subcluster / pain_point / 同slug）
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
const { readAllPostsSorted, postReferenceDate } = require('./site-corpus');
const { findSimilarInCorpus, similarityScore } = require('./topic-similarity');
const { filterByCooldown, filterByTopicIdentity } = require('./cooldown');
const { computeMacroRatios, applyBalance, balanceScore } = require('./category-balance');
const { loadDenylist, isTopicDenied, findMatchingEntry, isTimeLimitedExpired } = require('./denylist');
const {
  isNaturalCombination, deriveSegment, rejectionReason, evaluateTopicFit, scoreLeadValue,
} = require('./customer-relevance');
const { seasonBoost, matchingSeasonEntries } = require('./tax-calendar');
const { inquirySignalFor } = require('./inquiry-signals');

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

// 役割判定ヘルパー
function isMain(topic) { return MAIN_TYPES.has(topic.article_type); }
function isSupport(topic) { return !MAIN_TYPES.has(topic.article_type); }

// main と support の類似度を測る（slug ベース）
function pairSim(a, b) {
  return similarityScore(
    { ...a, slug: a.slug },
    { ...b, primary_persona: b.persona }
  ).score;
}

function isShitsugiTopic(topic = {}) {
  return topic.demand_evidence && topic.demand_evidence.kind === 'nta-shitsugi';
}

// ── cluster の「散らし」（2026-09-04 導入）────────────────────────
//
// cluster / persona×category の cooldown は粗すぎて別論点まで巻き添えに止めるため
// 廃止した（cooldown.js 冒頭を参照）。ただしあれは副次的に「同じ cluster が
// 何日も続かない」という散らしの役目も果たしていた。そこをブロックではなく
// スコアの減点で置き換える。候補は減らないので枯渇はしない。
//
//   直近 CLUSTER_RECENCY_DAYS 日以内に同じ cluster を出していたら、
//   新しいほど大きく priority を下げる（当日 -1.5 → 14日前 -0）。
//   需要の証拠（最大 +3）の方が重いので、飛び抜けて強い候補は依然として勝てる。
const CLUSTER_RECENCY_DAYS = 14;
const CLUSTER_RECENCY_WEIGHT = 1.5;

/**
 * cluster ごとに「何日前に最後に出したか」を集計する。
 * @returns {Map<string, number>} cluster → 経過日数（直近 CLUSTER_RECENCY_DAYS 日以内のみ）
 */
function buildClusterRecency(corpus, now = new Date()) {
  const lastSeen = new Map();
  for (const post of corpus) {
    if (!post || !post.cluster) continue;
    const postDate = postReferenceDate(post);
    if (isNaN(postDate)) continue;
    const diffDays = Math.floor((now - postDate) / (24 * 60 * 60 * 1000));
    if (diffDays < 0 || diffDays >= CLUSTER_RECENCY_DAYS) continue;
    const prev = lastSeen.get(post.cluster);
    if (prev == null || diffDays < prev) lastSeen.set(post.cluster, diffDays);
  }
  return lastSeen;
}

function clusterRecencyPenalty(topic, clusterRecency) {
  if (!clusterRecency || !topic || !topic.cluster) return 0;
  const days = clusterRecency.get(topic.cluster);
  if (days == null) return 0;
  return (1 - days / CLUSTER_RECENCY_DAYS) * CLUSTER_RECENCY_WEIGHT;
}

function priorityBreakdown(topic, now, clusterRecency = null) {
  // 需要の証拠に点数（質疑応答候補の自動採点 0〜100）がある場合はそれを反映し、
  // 高得点の候補から先に使われるようにする。点数の無い証拠は従来どおり 1。
  // 例: 91点→0.91×3=2.73、72点→0.72×3=2.16。いずれも季節ブースト(2)を上回るので
  // 「需要の証拠が最優先」という設計は変わらない。
  const evidence = topic.demand_evidence;
  const evidenceScore = evidence ? Number(evidence.score) : NaN;
  const demand = evidence
    ? (Number.isFinite(evidenceScore) ? Math.max(0, Math.min(1, evidenceScore / 100)) : 1)
    : 0;
  const season = seasonBoost(topic, now);
  const seasonEntries = season ? matchingSeasonEntries(topic, now) : [];
  const lead = (scoreLeadValue(topic) - 2) / 3;
  // 問い合わせ実績: 実際に問い合わせページへの遷移を生んだ記事と同じ・近い論点なら 1。
  // 重みは季節と同じ 2（実測の転換実績は時宜と同等以上に重い）。需要の証拠（×3）は超えない。
  const inquiry = inquirySignalFor(topic);
  const clusterRecent = clusterRecencyPenalty(topic, clusterRecency);
  return {
    demand,
    season,
    lead,
    inquiry,
    clusterRecent,
    priority: demand * 3 + season * 2 + inquiry * 2 + lead - clusterRecent,
    seasonLabels: seasonEntries.map(entry => entry.label),
  };
}

function rankBySelectionPriority(scored, now, clusterRecency = null) {
  return scored
    .map(entry => {
      const priorityParts = priorityBreakdown(entry.topic, now, clusterRecency);
      return { ...entry, priority: priorityParts.priority, priorityParts };
    })
    .sort((a, b) => {
      const priorityDiff = (b.priority || 0) - (a.priority || 0);
      return priorityDiff || (b.balance || 0) - (a.balance || 0);
    });
}

function selectionReason(topic, parts) {
  const reasons = [];
  if (parts.demand) {
    const evidence = topic.demand_evidence || {};
    reasons.push(`需要の証拠あり(${evidence.kind || '不明'}${evidence.score == null ? '' : ` score=${evidence.score}`})`);
  }
  if (parts.season) reasons.push(`季節(${parts.seasonLabels.join('・') || '該当月'})`);
  if (parts.inquiry) reasons.push('問い合わせ実績のある論点');
  if (parts.lead > 0) reasons.push(`問い合わせ近接度(${parts.lead.toFixed(2)})`);
  if (reasons.length === 0) reasons.push('カテゴリバランス');
  return `${reasons.join(' + ')} で優先`;
}

function explainPick(topic, scored) {
  const entry = scored.find(s => s.topic === topic || s.topic.slug === topic.slug);
  const parts = entry ? entry.priorityParts : { demand: 0, season: 0, lead: 0, priority: 0, seasonLabels: [] };
  return {
    slug: topic.slug, title: topic.title,
    macro: topic.macro, cluster: topic.cluster, subcluster: topic.subcluster,
    persona: topic.persona, category: topic.category,
    article_type: topic.article_type,
    article_role: MAIN_TYPES.has(topic.article_type) ? 'main' : 'support',
    priority: Number((parts.priority || 0).toFixed(3)),
    priority_breakdown: {
      demand: parts.demand || 0,
      season: parts.season || 0,
      inquiry: parts.inquiry || 0,
      cluster_recent: Number((parts.clusterRecent || 0).toFixed(3)),
      lead: Number((parts.lead || 0).toFixed(3)),
      balance: Number(((entry && entry.balance) || 0).toFixed(3)),
    },
    season_labels: parts.seasonLabels || [],
    reason: selectionReason(topic, parts),
  };
}

function demandKindOf(topic = {}) {
  return (topic.demand_evidence && topic.demand_evidence.kind) || null;
}

// 需要の証拠の「種類」ごとに1日最大1件（質疑応答・検索需要とも同じ流儀）。
// 同じ種類が2件になったら、優先度の低い方を別種の次点へ差し替える。
function enforceDemandKindDailyLimit(picks, scored) {
  const limited = picks.slice();
  const byKind = new Map();
  for (const topic of limited) {
    const kind = demandKindOf(topic);
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(topic);
  }
  for (const [kind, topics] of byKind) {
    if (topics.length <= 1) continue;
    topics.sort((x, y) => {
      const xe = scored.find(s => s.topic === x);
      const ye = scored.find(s => s.topic === y);
      return ((ye && ye.priority) || 0) - ((xe && xe.priority) || 0);
    });
    const keep = topics[0];
    const replaceIndex = limited.findIndex(topic => topic !== keep && demandKindOf(topic) === kind);
    const remaining = limited.filter((_, index) => index !== replaceIndex);
    const replacement = scored.find(entry => {
      if (demandKindOf(entry.topic) === kind || remaining.includes(entry.topic)) return false;
      return remaining.every(topic => pairSim(topic, entry.topic) < SIM_THRESHOLD_BETWEEN_PAIR);
    });
    if (replacement) limited[replaceIndex] = replacement.topic;
    else limited.splice(replaceIndex, 1);
  }
  return limited;
}

// 後方互換: 既存テスト・既存コードは旧名を参照している
const enforceShitsugiDailyLimit = enforceDemandKindDailyLimit;

/**
 * scored リストから、anchor と "役割が逆かつ類似度が低い" 候補を探す。
 * 役割逆 > 異 cluster > 低 sim の優先順位で best を返す。
 */
function findComplement(anchor, scored, excludeSet) {
  const anchorIsMain = isMain(anchor);
  let best = null;
  let bestRank = -1;
  for (const s of scored) {
    if (excludeSet.has(s.topic)) continue;
    const sim = pairSim(anchor, s.topic);
    if (sim >= SIM_THRESHOLD_BETWEEN_PAIR) continue;  // 類似度が高いものは除外
    // ランクを段階的に: 役割逆 + 異cluster (3) > 役割逆 + 同cluster (2) > 同役割 + 異cluster (1) > 同役割 + 同cluster (0)
    const oppositeRole = isMain(s.topic) !== anchorIsMain;
    const differentCluster = s.topic.cluster !== anchor.cluster;
    const rank = (oppositeRole ? 2 : 0) + (differentCluster ? 1 : 0);
    // 同ランクなら sim が低い方を優先
    if (rank > bestRank || (rank === bestRank && (best == null || sim < pairSim(anchor, best.topic)))) {
      bestRank = rank;
      best = s;
    }
  }
  return best;
}

/**
 * 同じ persona / category / pair_group / cluster でペアになる候補を組む。
 *
 * 優先順位:
 *   1. pair_group full pair（main + support が同じ pair_group に揃う）
 *   2. scored 上位から anchor を選び、役割逆 + 低 sim の complement を探す
 *      - anchor が main → support を探す
 *      - anchor が support → main を探す
 *      - 役割逆候補がなければ最後に同役割で妥協
 *
 * 戻り値: [main, support] または [main]（順序は main → support に並べる）
 */
function buildBestPair(scored, candidatesAll) {
  if (scored.length === 0) return [];
  if (scored.length === 1) return [scored[0].topic];

  // 1. 複合優先度が最も高い候補を anchor にする。同じ pair_group に
  //    役割が逆の相方がいれば、既存の本命+補強ペアを維持する。
  const anchor = scored[0];
  if (anchor.topic.pair_group) {
    const paired = scored.find(s => (
      s !== anchor
      && s.topic.pair_group === anchor.topic.pair_group
      && isMain(s.topic) !== isMain(anchor.topic)
      && pairSim(anchor.topic, s.topic) < SIM_THRESHOLD_BETWEEN_PAIR
    ));
    if (paired) {
      return isMain(anchor.topic)
        ? [anchor.topic, paired.topic]
        : [paired.topic, anchor.topic];
    }
  }

  // 2. pair_group が組めない場合も、最上位 anchor の相補候補を探す。
  const comp = findComplement(anchor.topic, scored, new Set([anchor.topic]));
  if (comp && isMain(anchor.topic) !== isMain(comp.topic)) {
    return isMain(anchor.topic)
      ? [anchor.topic, comp.topic]
      : [comp.topic, anchor.topic];
  }

  // 3. 役割逆ペアが見つからない → main を 1 つと support を 1 つ（最も balance スコア高いもの）
  const bestMain    = scored.find(s => isMain(s.topic));
  const bestSupport = scored.find(s => isSupport(s.topic));
  if (bestMain && bestSupport && pairSim(bestMain.topic, bestSupport.topic) < SIM_THRESHOLD_BETWEEN_PAIR) {
    return [bestMain.topic, bestSupport.topic];
  }

  // 4. それでも見つからない → 上位 2 件（役割重複の可能性あり、最終フォールバック）
  if (scored.length >= 2 && pairSim(scored[0].topic, scored[1].topic) < SIM_THRESHOLD_BETWEEN_PAIR) {
    return [scored[0].topic, scored[1].topic];
  }

  // 5. 1 本だけ
  return [scored[0].topic];
}

/**
 * メイン関数: 与えられたトピックプールから今日の 2 本を選ぶ。
 *
 * @param {Array} topics - topic-pool.TOPICS
 * @param {Object} options - { explain: bool, dryRun: bool, now: Date, requireTwo: bool }
 * @returns {Object} { picks: Topic[], explanation: object }
 */
/**
 * extraCorpus（未マージ下書き）を site-corpus の post 形状に正規化する。
 * postReferenceDate が post.file を参照するため、file を必ず補完する。
 */
function normalizeExtraCorpus(extra) {
  if (!Array.isArray(extra)) return [];
  return extra
    .filter(p => p && p.slug)
    .map(p => ({ ...p, file: p.file || `${p.slug}.md` }));
}

function selectDailyTopics(topics, options = {}) {
  const now = options.now || new Date();
  const explanation = { steps: [] };

  // 0. 全候補を enrich
  const enriched = topics.map(enrichTopic);

  // 1. コーパス読込（main の content/posts）＋ 未マージ下書き（extraCorpus）
  //    extraCorpus は承認前の下書き（draft/* ブランチ）を重複検知に含めるための追加分。
  //    これが無いと、前日の下書きが未承認のまま溜まったときに同一トピックを再生成する。
  const pending = normalizeExtraCorpus(options.extraCorpus);
  const corpus = readAllPostsSorted().concat(pending);
  explanation.steps.push({ step: 'corpus', count: corpus.length, pending: pending.length });

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

  // 2.8. 顧客カテゴリ関連性ゲート（安全装置・必ず効く）
  // 生成プール（expandAll）側でも除外しているが、curated topic や取りこぼしを
  // 選定時にも止める。
  // 【重要】不適合候補は絶対に復活させない。全滅した場合は「ゲート無視で継続」せず、
  // picks を空にして生成しない（危険な記事を作らないための安全装置）。
  const relevanceExcluded = [];
  const afterRelevance = candidates.filter(t => {
    if (isNaturalCombination(t)) return true;
    relevanceExcluded.push({
      slug: t.slug,
      segment: deriveSegment(t).customer_segment,
      reason: rejectionReason(t),
    });
    return false;
  });
  explanation.steps.push({
    step: 'filter-relevance',
    blocked: relevanceExcluded.length,
    remaining: afterRelevance.length,
    blockedDetails: relevanceExcluded.slice(0, 5),
  });
  candidates = afterRelevance; // 不適合は必ず除外（フォールバックしない）

  if (candidates.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat([
      relevanceExcluded.length > 0
        ? '関連性ゲートで全候補が除外されたため生成しない（不適合記事を作らない安全装置）'
        : 'denylist / 単年限定で候補が枯渇しました',
    ]);
    return { picks: [], explanation };
  }

  // 2.9. 品質ゲート（evaluateTopicFit の approve 判定だけを選定対象にする）
  // revise / reject 候補は「生成してから承認ゲートで止まる」無駄を生むため、
  // 選定段階で除外する（特に revise は search_intent 不足など topic 由来が多く、
  // 再生成しても revise になりやすい）。全滅時はフォールバックせず picks を空にする。
  const qualityExcluded = [];
  const afterQuality = candidates.filter(t => {
    const fit = evaluateTopicFit(t);
    if (fit.decision === 'approve' || fit.selection_eligible === true) return true;
    qualityExcluded.push({
      slug: t.slug,
      decision: fit.decision,
      source_hold: fit.source_hold,
      selection_eligible: fit.selection_eligible,
      customer_fit_score: fit.customer_fit_score,
      search_intent_score: fit.search_intent_score,
      source_alignment_score: fit.source_alignment_score,
      reason: fit.reason,
    });
    return false;
  });
  explanation.steps.push({
    step: 'filter-quality-fit',
    blocked: qualityExcluded.length,
    remaining: afterQuality.length,
    blockedDetails: qualityExcluded.slice(0, 5),
  });
  candidates = afterQuality; // approve 以外は必ず除外（フォールバックしない）

  if (candidates.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat([
      '品質ゲートで全候補が除外されたため生成しない（approve 判定の記事だけを生成する安全装置）',
    ]);
    return { picks: [], explanation };
  }

  // 2.95. 意味的重複ゲート（customer_segment × pain_point の既出を除外）
  // subcluster / slug / タイトルが違っても、読者にとって同じ論点なら重複として止める。
  // タイトル非依存なので、選定時に title が空のトピック（scenario 展開由来）でも確実に効く。
  // 【重要】既出テーマは絶対に復活させない。全滅した場合はフォールバックせず picks を
  // 空にして生成しない（実質同一の記事を量産しないための安全装置）。
  const { passed: afterIdentity, blocked: identityBlocked } = filterByTopicIdentity(candidates, corpus, now);
  explanation.steps.push({
    step: 'filter-topic-identity',
    blocked: identityBlocked.length,
    remaining: afterIdentity.length,
    blockedDetails: identityBlocked.slice(0, 5).map(b => ({
      slug: b.topic.slug, existing: b.hit.post, days: b.hit.days, reason: b.hit.reason,
    })),
  });
  candidates = afterIdentity; // 既出（segment×pain）は必ず除外（フォールバックしない）

  if (candidates.length === 0) {
    explanation.warnings = (explanation.warnings || []).concat([
      '意味的重複ゲート（segment×pain）で全候補が除外されたため生成しない（既出テーマの焼き直しを作らない安全装置）',
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
  // タイトルが違っても "場面として同じ" なら高スコアになるよう、シナリオ軸も渡す
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
      business_stage:   t.business_stage,
      life_stage:       t.life_stage,
      pain_point:       t.pain_point,
      procedure_stage:  t.procedure_stage,
      tax_domain:       t.tax_domain,
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

  // 需要の証拠 > 季節 > 問い合わせ近接度で並べ、同点時だけ balance を使う。
  // 直近で出した cluster は減点して散らす（ブロックではないので候補は減らない）。
  scored = rankBySelectionPriority(scored, now, buildClusterRecency(corpus, now));
  explanation.topCandidates = scored.slice(0, 8).map(s => ({
    slug: s.topic.slug,
    macro: s.topic.macro,
    cluster: s.topic.cluster,
    persona: s.topic.persona,
    category: s.topic.category,
    article_type: s.topic.article_type,
    priority: Number((s.priority || 0).toFixed(3)),
    demand: s.priorityParts.demand,
    season: s.priorityParts.season,
    lead: Number(s.priorityParts.lead.toFixed(3)),
    balance: Number((s.balance || 0).toFixed(3)),
    reasons: s.balanceReasons || [],
  }));

  // 6. ペアリング
  const picks = buildBestPair(scored, candidates);
  explanation.picks = picks.map(p => explainPick(p, scored));

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
      // 2本目を差し替え: 役割が逆（picks[0] が main なら support、逆も同様）かつ低 sim を優先
      const wantRoleIsMain = !isMain(picks[0]);  // 2本目に求める役割: main の逆
      const finder = (preferOppositeRole) => scored.find(s => {
        if (s.topic === picks[0] || s.topic === picks[1]) return false;
        if (preferOppositeRole && isMain(s.topic) !== wantRoleIsMain) return false;
        return pairSim(picks[0], s.topic) < SIM_THRESHOLD_BETWEEN_PAIR;
      });
      // まず役割逆で探す → 見つからなければ役割無視で探す
      const replacement = finder(true) || finder(false);
      if (replacement) {
        picks[1] = replacement.topic;
        explanation.picks[1] = explainPick(picks[1], scored);
      } else {
        // 差し替え候補がない → 1本だけにする
        explanation.warnings.push('代替候補が見つからないため 2 本目を取り下げ、1 本のみ生成します');
        picks.pop();
        explanation.picks.pop();
      }
    }
  }

  // 8. 需要の証拠の種類ごとに1日最大1件（質疑応答・検索需要とも同じ流儀）。
  const kindsBefore = picks.map(demandKindOf).filter(Boolean);
  const hadDuplicateKind = new Set(kindsBefore).size < kindsBefore.length;
  const limitedPicks = enforceDemandKindDailyLimit(picks, scored);
  if (hadDuplicateKind) {
    explanation.warnings = (explanation.warnings || []).concat([
      limitedPicks.length === picks.length
        ? '同じ需要の証拠が2件になったため、低優先度側を別種の次点へ差し替え'
        : '同じ需要の証拠が2件になり代替候補がないため、低優先度側を取り下げ',
    ]);
  }
  picks.splice(0, picks.length, ...limitedPicks);

  // 9. 最終整列: main を 1 本目、support を 2 本目になるよう並べ替える
  //    （差し替えなどで順序が逆転している場合に対応）
  if (picks.length === 2 && isSupport(picks[0]) && isMain(picks[1])) {
    [picks[0], picks[1]] = [picks[1], picks[0]];
    [explanation.picks[0], explanation.picks[1]] = [explanation.picks[1], explanation.picks[0]];
  }

  explanation.picks = picks.map(p => explainPick(p, scored));

  return { picks, explanation };
}

module.exports = {
  selectDailyTopics,
  enrichTopic,
  buildBestPair,
  priorityBreakdown,
  rankBySelectionPriority,
  buildClusterRecency,
  CLUSTER_RECENCY_DAYS,
  enforceShitsugiDailyLimit,
  enforceDemandKindDailyLimit,
  demandKindOf,
  isShitsugiTopic,
  SIM_THRESHOLD_VS_CORPUS,
  SIM_THRESHOLD_BETWEEN_PAIR,
};
