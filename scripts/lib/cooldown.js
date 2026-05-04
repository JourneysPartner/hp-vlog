'use strict';

/**
 * cluster / subcluster / slug 単位の cooldown 判定。
 *
 * ルール:
 *   - 同じ subcluster: デフォルト 90 日 cooldown（強）
 *   - 同じ cluster:    デフォルト 45 日 cooldown（中）
 *   - 同じ slug:        無期限（永久に再出力しない）
 *   - 同じ persona×category 組み合わせ: 21 日 cooldown（弱）
 *
 * トピック側で `cooldown_days` を明示指定している場合はそちらを優先する。
 */

const { postReferenceDate } = require('./site-corpus');

const DEFAULT_COOLDOWN = {
  slug:           Infinity,  // 同 slug は永久 NG
  subcluster:     90,
  cluster:        45,
  personaCategory: 21,
};

/**
 * 指定 topic が cooldown 期間中かどうか判定する。
 *
 * @param {Object} candidate  - 候補 topic（cluster, subcluster, persona, category, slug, cooldown_days）
 * @param {Array}  corpus     - 既存記事（site-corpus.readAllPostsSorted() の結果）
 * @param {Date}   now        - 現在時刻
 * @returns {Object|null}  cooldown ヒット時の理由オブジェクト、それ以外は null
 */
function checkCooldown(candidate, corpus, now = new Date()) {
  const customSubclusterDays = candidate.cooldown_days;

  for (const post of corpus) {
    const postDate = postReferenceDate(post);
    if (isNaN(postDate)) continue;
    const diffDays = Math.floor((now - postDate) / (24 * 60 * 60 * 1000));

    // 1. 同 slug → 常時ブロック
    if (candidate.slug && post.slug === candidate.slug) {
      return {
        level: 'slug',
        reason: '同一 slug は再生成しません',
        post: post.slug,
        days: diffDays,
        cooldownDays: Infinity,
      };
    }

    // 2. 同 subcluster → 90日（カスタム指定があればそれを優先）
    const subclusterCooldown = customSubclusterDays != null
      ? customSubclusterDays
      : DEFAULT_COOLDOWN.subcluster;
    if (candidate.subcluster && post.subcluster &&
        candidate.subcluster === post.subcluster &&
        diffDays < subclusterCooldown) {
      return {
        level: 'subcluster',
        reason: `subcluster '${candidate.subcluster}' は ${subclusterCooldown} 日 cooldown`,
        post: post.slug,
        days: diffDays,
        cooldownDays: subclusterCooldown,
      };
    }

    // 3. 同 cluster → 45日
    if (candidate.cluster && post.cluster &&
        candidate.cluster === post.cluster &&
        diffDays < DEFAULT_COOLDOWN.cluster) {
      return {
        level: 'cluster',
        reason: `cluster '${candidate.cluster}' は ${DEFAULT_COOLDOWN.cluster} 日 cooldown`,
        post: post.slug,
        days: diffDays,
        cooldownDays: DEFAULT_COOLDOWN.cluster,
      };
    }

    // 4. 同 persona × category → 21日（弱い目安）
    if (candidate.persona && post.primary_persona &&
        candidate.persona === post.primary_persona &&
        candidate.category && post.category &&
        candidate.category === post.category &&
        diffDays < DEFAULT_COOLDOWN.personaCategory) {
      return {
        level: 'personaCategory',
        reason: `persona×category 同一は ${DEFAULT_COOLDOWN.personaCategory} 日 cooldown`,
        post: post.slug,
        days: diffDays,
        cooldownDays: DEFAULT_COOLDOWN.personaCategory,
      };
    }
  }

  return null;
}

/**
 * cooldown を考慮した topic フィルタリング。
 * cooldown 中のトピックは除外し、除外理由を summary に記録する。
 */
function filterByCooldown(topics, corpus, now = new Date()) {
  const passed = [];
  const blocked = [];

  for (const t of topics) {
    const hit = checkCooldown(t, corpus, now);
    if (hit) {
      blocked.push({ topic: t, hit });
    } else {
      passed.push(t);
    }
  }

  return { passed, blocked };
}

module.exports = {
  DEFAULT_COOLDOWN,
  checkCooldown,
  filterByCooldown,
};
