'use strict';

/**
 * 論点（subcluster / pain_point）と slug 単位の cooldown 判定。
 *
 * ルール:
 *   - 同じ slug:        無期限（永久に再出力しない）
 *   - 同じ subcluster:  30 日 cooldown（トピック側 `cooldown_days` で上書き可）
 *   - 同じ pain_point:  30 日 cooldown（読者の悩みが同じものを短期間で連発しない）
 *
 * cluster / persona×category では判定しない（2026-09-04 廃止）:
 *   cluster は「税目・シナリオ群」レベルの粗いラベルで、中身は全く別の論点である。
 *   例えば cluster 'shitsugi-shotoku' の 173 件は国税庁 質疑応答事例 173 個＝別々の
 *   法令論点だが、cluster cooldown はこれを 1 テーマとみなし、1 本出すと残り 172 論点を
 *   14 日間まとめて止めていた。persona×category（例 inheritance_client×相続 = 453 件・
 *   論点 453 種）も同様。結果、2026-09-04 の日次生成は候補が 8 件まで削られ、
 *   本命記事 1 本しか作れず補強記事が生成されなかった。
 *   論点の重複は subcluster（1,618 種）/ pain_point（803 種）/ checkTopicIdentity（180 日）
 *   /類似度フィルタで見て、大分類の偏りは category-balance（直近7日60%上限）で見る。
 */

const { postReferenceDate } = require('./site-corpus');
const { deriveSegment } = require('./customer-relevance');

// 意味的な同一テーマ（customer_segment × pain_point）の重複を長期間ブロックする日数。
// subcluster / slug / タイトルが違っても、読者にとって同じ論点なら「既出」とみなす。
// 例: ec_seller × consumption-tax-judgement は税目(消費税/所得税/帳簿)や手続きの
//     切り口を変えても同じ「自分は課税事業者？」という読者ニーズなので重複扱いにする。
const IDENTITY_COOLDOWN_DAYS = 180;

// cooldown 日数
//   - 同 slug は永久ブロック
//   - subcluster / pain_point は「同じ論点・同じ悩みの連発」を防ぐ実単位
//   - cluster / persona×category は粗すぎて別論点を巻き添えにするため使わない（上のコメント参照）
const DEFAULT_COOLDOWN = {
  slug:       Infinity,  // 同 slug は永久 NG
  subcluster: 30,
  painPoint:  30,
};

/**
 * 指定 topic が cooldown 期間中かどうか判定する。
 *
 * @param {Object} candidate  - 候補 topic（slug, subcluster, pain_point, cooldown_days）
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

    // 2. 同 subcluster → 30日（カスタム指定があればそれを優先）
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

    // 3. 同 pain_point → 30日
    //    checkTopicIdentity は customer_segment × pain_point を 180 日見るが、
    //    こちらは segment をまたいで「同じ悩み」が短期間に並ぶのを防ぐ。
    if (candidate.pain_point && post.pain_point &&
        candidate.pain_point === post.pain_point &&
        diffDays < DEFAULT_COOLDOWN.painPoint) {
      return {
        level: 'painPoint',
        reason: `pain_point '${candidate.pain_point}' は ${DEFAULT_COOLDOWN.painPoint} 日 cooldown`,
        post: post.slug,
        days: diffDays,
        cooldownDays: DEFAULT_COOLDOWN.painPoint,
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

// 相続の life_stage を「読者の問い」が同じになる大区分にまとめる。
// 生前（準備）／逝去後（手続き）／申告後（見直し）の 3 つ。
// 逝去後の 4 段階（危篤・逝去直後／7日以内／4ヶ月以内／10ヶ月以内）は、同じ手続きなら
// 読者にとって同じ記事。scenario-axes.LIFE_STAGES の id と対応させる。
const LIFE_STAGE_PHASE = {
  'pre-planning':       'before-death',
  'cognitive-decline':  'before-death',
  'critical-immediate': 'after-death',
  'within-7days':       'after-death',
  'within-4months':     'after-death',
  'within-10months':    'after-death',
  'after-filing':       'after-filing',
  'second-inheritance': 'after-filing',
  'multi-year-review':  'after-filing',
};
function lifeStagePhase(lifeStage) {
  return LIFE_STAGE_PHASE[lifeStage] || null;
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
  // pain_point を第一キーにする。相続など pain_point が空の論点
  // （life_stage / subcluster で表現されるテーマ）は subcluster を代替キーにする。
  // 代替キーは candidate 側で決めた同じフィールドを post 側でも参照するため、
  // pain と subcluster が名前空間を跨いで誤マッチすることはない。
  // 2026-09-08: pain_point が空のシナリオ論点（相続の life_stage × procedure_stage 格子）は
  // subcluster の文字列で照合していたため、ラベルが違えば別論点扱いになり、
  // 「亡くなった後に最初に何をするか」が critical-immediate / within-7days / within-4months と
  // 名前を変えて繰り返し生成された（9/8 の本命記事が 4/18・8/13・8/22 と重複）。
  // procedure_stage を持つ候補は「時期の大区分 × 手続き」を鍵にし、格子の隣のセルを同一視する。
  const identityKeyOf = (t) => {
    if (t.pain_point) return { field: 'pain_point', key: t.pain_point };
    const phase = lifeStagePhase(t.life_stage);
    if (phase && t.procedure_stage) return { field: 'stage', key: `${phase}:${t.procedure_stage}` };
    return { field: 'subcluster', key: t.subcluster };
  };
  const { field: keyField, key } = identityKeyOf(candidate);
  // segment / キーが取れない候補は対象外（curated topic など既存挙動を壊さない）
  if (!seg || !key) return null;

  // 既存記事側は「候補が使う鍵」で読む。候補が段階を持たない（curated 等）なら
  // 従来どおり subcluster で照合し、既存記事に段階があっても無視する。
  const postKeyFor = (post) => {
    if (keyField === 'pain_point') return post.pain_point;
    if (keyField === 'stage') {
      const phase = lifeStagePhase(post.life_stage);
      return (phase && post.procedure_stage) ? `${phase}:${post.procedure_stage}` : '';
    }
    return post.subcluster;
  };
  for (const post of corpus) {
    const postKey = postKeyFor(post);
    if (!postKey || postKey !== key) continue;
    if (deriveSegment(post).customer_segment !== seg) continue;
    const postDate = postReferenceDate(post);
    if (isNaN(postDate)) continue;
    const diffDays = Math.floor((now - postDate) / (24 * 60 * 60 * 1000));
    if (diffDays < windowDays) {
      return {
        level: 'identity',
        reason: `customer_segment '${seg}' × ${keyField} '${key}' は既出（${diffDays}日前に ${post.slug}）`,
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
  lifeStagePhase,
  filterByTopicIdentity,
};
