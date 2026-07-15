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
const { deriveSegment } = require('./customer-relevance');

// 意味的な同一テーマ（customer_segment × pain_point）の重複を長期間ブロックする日数。
// subcluster / slug / タイトルが違っても、読者にとって同じ論点なら「既出」とみなす。
// 例: ec_seller × consumption-tax-judgement は税目(消費税/所得税/帳簿)や手続きの
//     切り口を変えても同じ「自分は課税事業者？」という読者ニーズなので重複扱いにする。
const IDENTITY_COOLDOWN_DAYS = 180;

// cooldown 日数（短縮版）
//   - 同 slug は永久ブロック（変更なし）
//   - subcluster / cluster / persona×category は短縮し、候補が必要以上に減らないようにする
//   - 同 slug の永久ブロック + similarity / time-limited / denylist が十分なフィルタになっているため、
//     ここでは「近すぎるテーマの連発を防ぐ」程度の短い間隔で十分
const DEFAULT_COOLDOWN = {
  slug:           Infinity,  // 同 slug は永久 NG
  subcluster:     30,        // 旧: 90日 → 短縮
  cluster:        14,        // 旧: 45日 → 短縮
  personaCategory: 7,        // 旧: 21日 → 短縮
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

/**
 * 意味的な同一テーマ（customer_segment × pain_point）が既出かどうかを判定する。
 *
 * subcluster / slug の文字列や生成後のタイトルに依存せず、
 * 「誰の（customer_segment）どの悩み（pain_point）か」だけで重複を見る。
 * これにより:
 *   - 税目/手続きの切り口だけ変えた実質同一テーマ（例: 消費税課税事業者判定を
 *     income_tax / bookkeeping_expenses / consumption_tax の別軸で焼き直したもの）を止める。
 *   - 選定時点で title が空のトピック（scenario 展開由来）でも確実に効く
 *     （類似度フィルタは title 依存で、選定時は 0.55 未満に沈んで素通りしていた）。
 *
 * @returns {Object|null}  既出ヒット時の理由、それ以外は null
 */
function checkTopicIdentity(candidate, corpus, now = new Date(), windowDays = IDENTITY_COOLDOWN_DAYS) {
  const seg  = deriveSegment(candidate).customer_segment;
  const pain = candidate.pain_point;
  // segment / pain が取れない候補は対象外（curated topic など既存挙動を壊さない）
  if (!seg || !pain) return null;

  for (const post of corpus) {
    if (!post.pain_point || post.pain_point !== pain) continue;
    if (deriveSegment(post).customer_segment !== seg) continue;
    const postDate = postReferenceDate(post);
    if (isNaN(postDate)) continue;
    const diffDays = Math.floor((now - postDate) / (24 * 60 * 60 * 1000));
    if (diffDays < windowDays) {
      return {
        level: 'identity',
        reason: `customer_segment '${seg}' × pain_point '${pain}' は既出（${diffDays}日前に ${post.slug}）`,
        post: post.slug,
        days: diffDays,
        cooldownDays: windowDays,
      };
    }
  }
  return null;
}

/**
 * 意味的重複（segment × pain）で候補をフィルタする。
 * cooldown（soft・全滅時フォールバックあり）とは別の "ハードゲート" として使う想定。
 */
function filterByTopicIdentity(topics, corpus, now = new Date()) {
  const passed = [];
  const blocked = [];
  for (const t of topics) {
    const hit = checkTopicIdentity(t, corpus, now);
    if (hit) blocked.push({ topic: t, hit });
    else passed.push(t);
  }
  return { passed, blocked };
}

module.exports = {
  DEFAULT_COOLDOWN,
  IDENTITY_COOLDOWN_DAYS,
  checkCooldown,
  filterByCooldown,
  checkTopicIdentity,
  filterByTopicIdentity,
};
