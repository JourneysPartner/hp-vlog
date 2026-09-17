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
 * @returns {{ primary: Object|null, supplements: Array }}
 */
function splitPrimaryAndSupplements(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { primary: null, supplements: [] };
  }
  const sorted = results
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.confidence) - Number(a.item.confidence) || a.index - b.index)
    .map(({ item }) => item);
  return { primary: sorted[0], supplements: sorted.slice(1, 4) };
}

module.exports = {
  narrowTopicToTerm,
  selectSourcesPerTerm,
  splitPrimaryAndSupplements,
};
