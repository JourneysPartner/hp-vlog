'use strict';

/**
 * 論点1語に絞ったトピックを作る。
 * 記事全体の語（検索意図・読者の悩み）は1論点の問いを薄めるので落とす。
 * 税目と顧客カテゴリは候補プールの決定に要るので残す。
 */
function narrowTopicToTerm(topic, term) {
  return {
    ...topic,
    tax_terms: term,
    pain_point: term,
    title: term,
    search_intent: '',
    reader_problem: '',
    primary_question: '',
    subcluster: '',
  };
}

/**
 * 論点語ごとに出典を選ぶ。
 * 1論点の失敗で記事全体の生成を止めないため、失敗した論点だけを除外する。
 * @param {Object} topic
 * @param {string[]} terms
 * @param {Function} resolveSource
 * @returns {Promise<Array>} [{ term, url, title, no, confidence, tier, reason }]
 */
async function selectSourcesPerTerm(topic, terms, resolveSource) {
  const selected = [];
  const list = Array.isArray(terms) ? terms : [];

  for (let i = 0; i < list.length; i++) {
    const term = String(list[i] || '').trim();
    if (!term) continue;
    try {
      const picked = await resolveSource(narrowTopicToTerm(topic, term));
      if (!picked || !picked.url) continue;
      selected.push({ term, ...picked, _termOrder: i });
    } catch (error) {
      console.warn(`[source] 論点別選定失敗: ${term}: ${error.message}`);
    }
  }

  const byUrl = new Map();
  for (const item of selected) {
    const current = byUrl.get(item.url);
    if (!current || Number(item.confidence) > Number(current.confidence)) {
      byUrl.set(item.url, item);
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => Number(b.confidence) - Number(a.confidence) || a._termOrder - b._termOrder)
    .map(({ _termOrder, ...item }) => item);
}

/**
 * 論点ごとの結果から、frontmatter の正本と補助出典を分ける。
 * 同点では論点語の重要順である入力順を崩さない。
 *
 * 正本は「承認時の出典ガードを通る候補」の中から最も確信度が高いものにする。
 * #806（2026-11-23）ではカタログ外の段 D（No.9205）が最高確信度になり、そのまま
 * 正本にすると承認段階のガードで必ず止まった。判定は承認時と同じ
 * evaluateLlmAutoSource を使い、基準を二重に持たない。
 * 資格のある候補が 1 つも無ければ、これまでどおり最高確信度を正本にする。
 *
 * @param {Array} results [{ term, no, url, confidence, ... }]
 * @param {{ isEligiblePrimary?: Function }} options 試験用に資格判定を差し替えられる
 * @returns {{ primary: Object|null, supplements: Array, skipped: Array }}
 *   skipped は正本より前（高確信度）で飛ばした候補。飛ばしていなければ空配列。
 */
function splitPrimaryAndSupplements(results, options = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return { primary: null, supplements: [], skipped: [] };
  }
  const sorted = results
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.confidence) - Number(a.item.confidence) || a.index - b.index)
    .map(({ item }) => item);

  const isEligiblePrimary = typeof options.isEligiblePrimary === 'function'
    ? options.isEligiblePrimary
    // 遅延 require: source-alignment は tax-authority-refs・law-sources を読むだけで、
    // このファイルは読まないため循環しない。
    : (item) => require('./source-alignment')
      .evaluateLlmAutoSource({ source_url: item.url, source_confidence: item.confidence }).ok;

  let primaryIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    let eligible = false;
    try {
      eligible = Boolean(isEligiblePrimary(sorted[i]));
    } catch (_error) {
      // 判定の失敗で生成を止めない。その候補は資格なしとして次を見る。
      eligible = false;
    }
    if (eligible) { primaryIndex = i; break; }
  }
  // 資格のある候補が無ければ従来どおり最高確信度を正本にする。
  if (primaryIndex < 0) primaryIndex = 0;

  const primary = sorted[primaryIndex];
  const supplements = sorted.filter((_, i) => i !== primaryIndex).slice(0, 3);
  return { primary, supplements, skipped: sorted.slice(0, primaryIndex) };
}

module.exports = {
  narrowTopicToTerm,
  selectSourcesPerTerm,
  splitPrimaryAndSupplements,
};
