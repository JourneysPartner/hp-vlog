'use strict';

/**
 * 大分類（macro category）レベルでの偏り是正ロジック。
 *
 * 直近の記事分布を見て、出しすぎカテゴリのトピックにペナルティを付ける。
 * 出力は「スコア」（高いほど望ましい）で、選定時の補助として使う。
 *
 * 具体的には:
 *   - 直近 7 / 14 / 30 日で macro 別の出現比率を集計
 *   - 当該 macro の比率が「均等分布」を超える場合、超過分に応じたペナルティ
 *   - ハードキャップ:
 *       直近 7 日で macro が全体の 30% を超えていたら、その macro はその日 NG（候補があれば差し替え）
 *       直近 14 日で macro が全体の 50% を超えていたら、強いペナルティ
 *
 * 大分類の数を N とすると、均等比率は 1/N。
 */

const { ALL_MACROS } = require('./cluster-taxonomy');
const { readPostsWithinDays, postReferenceDate } = require('./site-corpus');

// 2026-09-04: 7日ハードキャップを 60% → 30% に。
//   cluster / persona×category の cooldown を廃止（cooldown.js 冒頭を参照）したことで、
//   それが副次的に担っていた「大分類が偏らない」効果が失われ、シミュレーションでは
//   相続贈与が 14 日中 61% を占めた。偏り是正は本来こちらの担当なので、緩すぎた
//   上限（大分類 11 種に対し 60% ＝ 均等 9% の 6.6 倍）を締める。
//   ブロックされた大分類の候補が全滅した場合は applyBalance 側でブロック解除される。
const WINDOWS = [
  { days: 7,  weight: 1.0, hardCap: 0.30 },  // 直近1週: 出しすぎはハードブロック
  { days: 14, weight: 0.7, hardCap: null  },  // 直近2週: スコアペナルティ
  { days: 30, weight: 0.4, hardCap: null  },  // 直近1月: 弱いペナルティ
];

/**
 * 各 window で macro 別の比率を集計する。
 *
 * @returns {Object} { 7: { macro: ratio, ... }, 14: {...}, 30: {...}, totals: { 7: count, ... } }
 */
function computeMacroRatios(now = new Date()) {
  const ratios = {};
  const totals = {};

  for (const w of WINDOWS) {
    const posts = readPostsWithinDays(w.days, now);
    const counts = Object.fromEntries(ALL_MACROS.map(m => [m, 0]));
    for (const p of posts) {
      if (counts[p.macro] != null) counts[p.macro]++;
    }
    const total = posts.length;
    totals[w.days] = total;

    if (total === 0) {
      ratios[w.days] = Object.fromEntries(ALL_MACROS.map(m => [m, 0]));
    } else {
      ratios[w.days] = Object.fromEntries(
        ALL_MACROS.map(m => [m, counts[m] / total])
      );
    }
  }

  return { ratios, totals };
}

const FAIR_RATIO = 1 / ALL_MACROS.length;  // 均等分布

/**
 * 候補トピックの macro に対する偏り補正スコアを算出する。
 *
 * @param {string} macro
 * @param {Object} ratiosResult - computeMacroRatios() の結果
 * @returns {Object} { score: -1..+1, hardBlocked: boolean, reasons: [...] }
 *   score:
 *     +1 → 大幅に未充足（積極的に選ぶべき）
 *     0  → 均等
 *     -1 → 大幅に出しすぎ（避けるべき）
 */
function balanceScore(macro, ratiosResult = computeMacroRatios()) {
  const reasons = [];
  let score = 0;
  let totalWeight = 0;
  let hardBlocked = false;

  for (const w of WINDOWS) {
    const ratio = ratiosResult.ratios[w.days][macro] || 0;
    const total = ratiosResult.totals[w.days];

    // 過小評価防止: total が小さい window は影響を弱める
    if (total < 2) continue;

    const deviation = FAIR_RATIO - ratio;  // +ならunder, -ならover
    const normalized = Math.max(-1, Math.min(1, deviation / FAIR_RATIO));

    score += normalized * w.weight;
    totalWeight += w.weight;

    if (w.hardCap != null && ratio > w.hardCap && total >= 3) {
      hardBlocked = true;
      reasons.push(`直近${w.days}日: ${macro} が ${(ratio * 100).toFixed(0)}% (上限${(w.hardCap * 100).toFixed(0)}%)`);
    }

    if (deviation < -0.1) {
      reasons.push(`直近${w.days}日: ${macro} 出しすぎ（${(ratio * 100).toFixed(0)}% / 均等${(FAIR_RATIO * 100).toFixed(0)}%）`);
    } else if (deviation > 0.1) {
      reasons.push(`直近${w.days}日: ${macro} 出し不足（${(ratio * 100).toFixed(0)}% / 均等${(FAIR_RATIO * 100).toFixed(0)}%）`);
    }
  }

  if (totalWeight > 0) score /= totalWeight;
  return { score, hardBlocked, reasons };
}

/**
 * トピック群を balanceScore でランク付けし、ハードブロックされたものは除外する。
 * candidates は { macro, ... } を持つ前提（cluster-taxonomy.resolveCluster で付与済み）。
 */
function applyBalance(candidates, ratiosResult = computeMacroRatios()) {
  const scored = [];
  const blocked = [];

  for (const t of candidates) {
    const macro = t.macro || (t._cluster && t._cluster.macro);
    if (!macro) {
      // macro が未解決のものはスコア中立
      scored.push({ topic: t, balance: 0, balanceReasons: [], hardBlocked: false });
      continue;
    }
    const { score, hardBlocked, reasons } = balanceScore(macro, ratiosResult);
    if (hardBlocked) {
      blocked.push({ topic: t, reasons });
    } else {
      scored.push({ topic: t, balance: score, balanceReasons: reasons, hardBlocked: false });
    }
  }

  // balance score の降順
  scored.sort((a, b) => b.balance - a.balance);

  return { scored, blocked, ratios: ratiosResult };
}

module.exports = {
  WINDOWS,
  FAIR_RATIO,
  computeMacroRatios,
  balanceScore,
  applyBalance,
};
