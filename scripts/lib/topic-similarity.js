'use strict';

/**
 * トピック同士の類似度スコアリング。
 *
 * スコアは 0〜1（高いほど類似）。重複生成防止のため、しきい値を超える候補は除外する。
 *
 * 計算ロジック:
 *   - slug 文字列の類似度（トークン重なり）
 *   - title トークン重なり
 *   - search_intent / reader_problem / primary_question のキーワード重なり
 *   - cluster / subcluster の一致
 *   - persona / category の一致
 *
 * シンプルに保つため、形態素解析は使わず以下で代替:
 *   - 英字: kebab-case の hyphen 分解
 *   - 日本語: 2-gram + 主要キーワード抽出（カタカナ語・漢字連続）
 */

// ── トークナイザ ────────────────────────────────────────────────
function tokenizeSlug(slug) {
  if (!slug) return [];
  return slug.toLowerCase().split(/[-_]+/).filter(Boolean);
}

function extractJapaneseTokens(text) {
  if (!text) return [];
  const tokens = new Set();
  // カタカナ連続（2文字以上）
  for (const m of text.matchAll(/[゠-ヿー]{2,}/g)) tokens.add(m[0]);
  // 漢字連続（2文字以上）
  for (const m of text.matchAll(/[一-鿿]{2,}/g)) tokens.add(m[0]);
  // 英数字単語
  for (const m of text.matchAll(/[a-zA-Z0-9]{2,}/g)) tokens.add(m[0].toLowerCase());
  return [...tokens];
}

function tokenizeText(text) {
  if (!text) return [];
  const slug = tokenizeSlug(text);
  const ja   = extractJapaneseTokens(text);
  return [...new Set([...slug, ...ja])];
}

// ── Jaccard 係数（集合の重なり率）──────────────────────────────
function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

// ── トピック⇄記事間の類似度スコア ──────────────────────────────
/**
 * @param {Object} candidate - 評価対象の topic（slug, title, search_intent, ...）
 * @param {Object} existing  - 既存記事（同様の項目を持つ）
 * @returns {Object} { score: 0..1, breakdown: {...} }
 */
function similarityScore(candidate, existing) {
  // slug の完全一致 → 1.0（最大類似）
  if (candidate.slug && existing.slug && candidate.slug === existing.slug) {
    return { score: 1.0, breakdown: { reason: 'slug exact match' } };
  }

  const breakdown = {};

  // 1. slug トークン Jaccard
  const slugSim = jaccard(tokenizeSlug(candidate.slug), tokenizeSlug(existing.slug));
  breakdown.slug = slugSim;

  // 2. title トークン Jaccard
  const titleSim = jaccard(tokenizeText(candidate.title || ''), tokenizeText(existing.title || ''));
  breakdown.title = titleSim;

  // 3. search_intent / reader_problem / primary_question 全体のキーワード重なり
  const candIntent = [
    candidate.search_intent, candidate.reader_problem,
    candidate.primary_question, candidate.success_outcome,
  ].filter(Boolean).join(' ');
  const existIntent = [
    existing.search_intent, existing.reader_problem,
    existing.primary_question, existing.success_outcome,
  ].filter(Boolean).join(' ');
  const intentSim = jaccard(tokenizeText(candIntent), tokenizeText(existIntent));
  breakdown.intent = intentSim;

  // 4. cluster / subcluster 一致
  const clusterMatch = candidate.cluster && existing.cluster && candidate.cluster === existing.cluster ? 1 : 0;
  const subMatch     = candidate.subcluster && existing.subcluster && candidate.subcluster === existing.subcluster ? 1 : 0;
  breakdown.cluster = clusterMatch;
  breakdown.subcluster = subMatch;

  // 5. persona × category 一致
  const personaMatch = candidate.persona && existing.primary_persona && candidate.persona === existing.primary_persona ? 1 : 0;
  const categoryMatch = candidate.category && existing.category && candidate.category === existing.category ? 1 : 0;
  breakdown.personaCategory = personaMatch && categoryMatch ? 1 : 0;

  // 重み付けスコア（合計 1.0 に正規化）
  // slug と intent の重なりが最重要、persona×category は弱い背景情報
  const score =
    0.30 * slugSim +
    0.25 * titleSim +
    0.25 * intentSim +
    0.10 * subMatch +
    0.05 * clusterMatch +
    0.05 * breakdown.personaCategory;

  return { score, breakdown };
}

/**
 * トピックがコーパス内のいずれかの記事と過度に類似しているか判定する。
 *
 * @param {Object} candidate
 * @param {Array} corpus  - 既存記事の配列（site-corpus.readAllPosts() の結果）
 * @param {number} threshold - 類似と判定する閾値（デフォルト 0.55）
 * @returns {Object|null} 類似する既存記事と breakdown、なければ null
 */
function findSimilarInCorpus(candidate, corpus, threshold = 0.55) {
  let best = null;
  for (const existing of corpus) {
    const { score, breakdown } = similarityScore(candidate, existing);
    if (score >= threshold && (!best || score > best.score)) {
      best = { post: existing, score, breakdown };
    }
  }
  return best;
}

module.exports = {
  similarityScore,
  findSimilarInCorpus,
  tokenizeSlug,
  tokenizeText,
  extractJapaneseTokens,
  jaccard,
};
