'use strict';

/**
 * 大分類（macro category）レベルでの偏り是正ロジック。
 *
 * 直近の記事分布を見て、出しすぎカテゴリのトピックにペナルティを付ける。
 * 出力は「スコア」（高いほど望ましい）で、選定時の補助として使う。
 *
 * 具体的には:
 *   - 直近 7 / 14 / 30 日で macro 別の出現比率を集計
 *   - 当該 macro の比率が設定された目標比率を超える場合、超過分に応じたペナルティ
 *   - ハードキャップ:
 *       直近 7 日で macro ごとの上限を超え、かつ 14 日の実績が 4 本以上ならその macro はその日 NG
 *       目標比率 0 の macro は、他の候補がある限り選ばない
 */

const fs = require('fs');
const path = require('path');
const { ALL_MACROS, resolveCluster } = require('./cluster-taxonomy');
const { readPostsWithinDays, postReferenceDate } = require('./site-corpus');
const TARGET_RATIOS = Object.freeze(require('../../data/macro-target-ratios.json'));
const QUOTA_PATH = path.join(__dirname, '../../data/macro-quota.json');
const INACTIVE_STATUSES = new Set(['skipped', 'rejected', 'merged']);

const WINDOWS = [
  { days: 7,  weight: 1.0 },
  { days: 14, weight: 0.7 },
  { days: 30, weight: 0.4 },
];

function validateTargetRatios(targets = TARGET_RATIOS) {
  const unknown = Object.keys(targets).filter(macro => !ALL_MACROS.includes(macro));
  const invalid = Object.entries(targets).filter(([, ratio]) => !Number.isFinite(ratio) || ratio < 0 || ratio > 1);
  const total = Object.values(targets).reduce((sum, ratio) => sum + ratio, 0);
  return {
    valid: unknown.length === 0 && invalid.length === 0 && Math.abs(total - 1) <= 0.01,
    unknown,
    invalid,
    total,
  };
}

const targetValidation = validateTargetRatios();
if (!targetValidation.valid) {
  throw new Error(`macro 目標比率が不正です（合計=${targetValidation.total}, 未知=${targetValidation.unknown.join(',')}）`);
}

function loadMacroQuota(configPath = QUOTA_PATH, warn = console.warn) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || !Array.isArray(config.strict_macros)
      || !Number.isFinite(config.window_days) || config.window_days <= 0
      || !Number.isFinite(config.planned_per_window) || config.planned_per_window <= 0) {
      throw new Error('invalid config');
    }
  } catch (_) {
    warn('[macro-quota] 警告: 設定ファイルを読めないため、本数の上限なしで続行します。');
    return null;
  }
  const unknown = config.strict_macros.filter(macro => !Object.hasOwn(TARGET_RATIOS, macro));
  if (unknown.length > 0) {
    throw new Error(`macro 上限設定の分類が不正です（未知=${unknown.join(',')}）`);
  }
  return config;
}

const MACRO_QUOTA = loadMacroQuota();

function targetRatioFor(macro) {
  return Number(TARGET_RATIOS[macro]) || 0;
}

function hardCapFor(macro) {
  return Math.min(0.9, targetRatioFor(macro) * 1.6 + 0.05);
}

function quotaLimitFor(macro, config = MACRO_QUOTA) {
  return config ? Math.max(1, Math.ceil(targetRatioFor(macro) * config.planned_per_window)) : null;
}

function isActivePost(post) {
  return !INACTIVE_STATUSES.has(String(post.review_status || '').toLowerCase());
}

function windowCorpus(days, now, extraCorpus, excludeInactive = false) {
  const main = readPostsWithinDays(days, now);
  const posts = excludeInactive ? main.filter(isActivePost) : main.slice();
  const seen = new Set(main.map(post => post.slug));
  const threshold = now.getTime() - days * 24 * 60 * 60 * 1000;
  for (const post of extraCorpus) {
    if (!post || !post.slug || seen.has(post.slug) || !isActivePost(post)) continue;
    const normalized = { ...post, file: post.file || `${post.slug}.md` };
    if (postReferenceDate(normalized).getTime() < threshold) continue;
    seen.add(post.slug);
    posts.push({ ...normalized, macro: resolveCluster(normalized).macro });
  }
  return posts;
}

function computeMacroQuota(now = new Date(), { extraCorpus = [], config = MACRO_QUOTA } = {}) {
  if (!config) return {};
  const posts = windowCorpus(config.window_days, now, extraCorpus, true);
  return Object.fromEntries(config.strict_macros.map(macro => {
    const count = posts.filter(post => post.macro === macro).length;
    const limit = quotaLimitFor(macro, config);
    const target = targetRatioFor(macro);
    return [macro, {
      count, limit, target, windowDays: config.window_days,
      blocked: count >= limit,
      reason: `${macro}: 直近${config.window_days}日で ${count} 本（上限 ${limit} 本・目標 ${(target * 100).toFixed(0)}%）`,
    }];
  }));
}

function applyMacroQuota(candidates, quota = computeMacroQuota()) {
  const passed = [];
  const blocked = [];
  for (const topic of candidates) {
    const macro = topic.macro || (topic._cluster && topic._cluster.macro);
    if (quota[macro] && quota[macro].blocked) {
      blocked.push({ topic, macro, ...quota[macro] });
    } else {
      passed.push(topic);
    }
  }
  return { passed, blocked };
}

/**
 * 各 window で macro 別の比率を集計する。
 *
 * @returns {Object} { 7: { macro: ratio, ... }, 14: {...}, 30: {...}, totals: { 7: count, ... } }
 */
function computeMacroRatios(now = new Date(), { extraCorpus = [] } = {}) {
  const ratios = {};
  const totals = {};

  for (const w of WINDOWS) {
    // main の従来の集計は保ち、承認待ち下書きだけを重複なく追加する。
    const posts = windowCorpus(w.days, now, extraCorpus);
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

/**
 * 候補トピックの macro に対する偏り補正スコアを算出する。
 *
 * @param {string} macro
 * @param {Object} ratiosResult - computeMacroRatios() の結果
 * @returns {Object} { score: -1..+1, hardBlocked: boolean, reasons: [...] }
 *   score:
 *     +1 → 大幅に未充足（積極的に選ぶべき）
 *     0  → 目標どおり
 *     -1 → 大幅に出しすぎ（避けるべき）
 */
function balanceScore(macro, ratiosResult = computeMacroRatios()) {
  const reasons = [];
  let score = 0;
  let totalWeight = 0;
  let hardBlocked = false;
  const target = targetRatioFor(macro);

  // 配分表にない macro は通常候補から外す。候補が全滅した場合は、呼び出し側の
  // 既存フォールバックでブロックが解除されるため、元に戻す経路も保たれる。
  if (target === 0) {
    return {
      score: -1,
      hardBlocked: true,
      reasons: [`${macro} は目標比率 0%（他の候補がある間は選定しない）`],
    };
  }

  for (const w of WINDOWS) {
    const ratio = ratiosResult.ratios[w.days][macro] || 0;
    const total = ratiosResult.totals[w.days];

    // 過小評価防止: total が小さい window は影響を弱める
    if (total < 2) continue;

    const deviation = target - ratio;  // +ならunder, -ならover
    const normalized = Math.max(-1, Math.min(1, deviation / target));

    score += normalized * w.weight;
    totalWeight += w.weight;

    const hardCap = hardCapFor(macro);
    if (w.days === 7 && ratio > hardCap && ratiosResult.totals[14] >= 4) {
      hardBlocked = true;
      reasons.push(`直近${w.days}日: ${macro} が ${(ratio * 100).toFixed(0)}% (上限${(hardCap * 100).toFixed(0)}%)`);
    }

    if (deviation < -0.1) {
      reasons.push(`直近${w.days}日: ${macro} 出しすぎ（${(ratio * 100).toFixed(0)}% / 目標${(target * 100).toFixed(0)}%）`);
    } else if (deviation > 0.1) {
      reasons.push(`直近${w.days}日: ${macro} 出し不足（${(ratio * 100).toFixed(0)}% / 目標${(target * 100).toFixed(0)}%）`);
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
  TARGET_RATIOS,
  validateTargetRatios,
  targetRatioFor,
  hardCapFor,
  loadMacroQuota,
  quotaLimitFor,
  computeMacroQuota,
  applyMacroQuota,
  computeMacroRatios,
  balanceScore,
  applyBalance,
};
