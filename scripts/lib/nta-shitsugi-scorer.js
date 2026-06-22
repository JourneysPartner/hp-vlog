'use strict';

/**
 * 質疑応答事例の topic 候補化スコアリング (Phase E)
 *
 * 仕様（仕様書 v2 セクション 5-2）:
 *   - ペルソナ適合度        (+30)
 *   - 検索ニーズ推定        (+20)
 *   - 改正・廃止リスク      (+10)
 *   - 判断の曖昧さ          (+15)
 *   - タックスアンサー補強可能性 (+25)
 *   - 満点 100、70 点以上で候補化
 */

// ── 税目 → ペルソナのマッピング ───────────────────────────────
// 既存 PERSONA_MAP (generate-draft.js 50 行目相当) を参考に
// 各ペルソナの「主な税目（categories）」と shitsugi tax_category_code の対応を構築
const PERSONA_BY_TAX_CATEGORY = {
  shohi: [
    { persona: 'domestic_ec_seller',          weight: 30, macro: '物販' },
    { persona: 'ebay_export_seller',          weight: 30, macro: '物販' },
    { persona: 'beauty_salon_owner',          weight: 25, macro: 'サロン' },
  ],
  shotoku: [
    { persona: 'reseller_marketplace_seller', weight: 30, macro: '物販' },
    { persona: 'influencer_creator',          weight: 30, macro: 'インフルエンサー' },
    { persona: 'beauty_salon_owner',          weight: 20, macro: 'サロン' },
  ],
  gensen: [
    { persona: 'influencer_creator',          weight: 25, macro: 'インフルエンサー' },
    { persona: 'beauty_salon_owner',          weight: 25, macro: 'サロン' },
  ],
  sozoku: [
    { persona: 'inheritance_client',          weight: 30, macro: '相続贈与' },
  ],
  hyoka: [
    { persona: 'inheritance_client',          weight: 30, macro: '相続贈与' },
  ],
  joto: [
    { persona: 'inheritance_client',          weight: 20, macro: '相続贈与' },
    { persona: 'domestic_ec_seller',          weight: 15, macro: '物販' },
  ],
  hojin: [
    // 法人税系は読者ペルソナとの直接マッチが弱い
    // 既存 PERSONA に汎用ペルソナが無いため、最も近い物販系で部分一致
    { persona: 'domestic_ec_seller',          weight: 15, macro: '物販' },
    { persona: 'beauty_salon_owner',          weight: 15, macro: 'サロン' },
  ],
};

// ── 本文キーワードでペルソナを補強 ────────────────────────────
// 上記の税目ベース wifght に対し、本文中のキーワード一致でブーストする
const PERSONA_KEYWORD_BOOST = {
  domestic_ec_seller:          ['EC', '物販', '通信販売', '販売', '在庫', 'Amazon', '楽天', 'Yahoo', 'Shopify', 'メルカリ', 'ヤフオク'],
  ebay_export_seller:          ['輸出', '海外', '免税', '還付', 'eBay', '越境', '国外', '非居住者'],
  reseller_marketplace_seller: ['フリマ', '転売', 'せどり', 'リサイクル', '中古'],
  influencer_creator:          ['広告', 'インフルエンサー', 'YouTube', 'PR', 'タイアップ', 'クリエイター', 'アフィリエイト', 'コンテンツ', '報酬', '原稿料'],
  beauty_salon_owner:          ['美容', '理容', 'サロン', 'ネイル', 'エステ', '回数券', '前受金', 'スタッフ', '雇用', '個人事業'],
  inheritance_client:          ['相続', '贈与', '遺産', '配偶者', '生前', '名義', '保険', '不動産', '評価', '土地', '株式'],
};

// ── 検索ニーズキーワード ──────────────────────────────────────
const HIGH_NEED_KEYWORDS = ['経費', '課税', '贈与', '控除', '申告', 'インボイス', '還付', '損益', '確定申告', '事業所得', '雑所得', '取得費'];
const MID_NEED_KEYWORDS  = ['取扱', '判定', '適用', '計算', '区分', '範囲', '時期'];
const LOW_NEED_KEYWORDS  = ['通則', '規定', '原則'];

// ── 判断の曖昧さキーワード ────────────────────────────────────
const AMBIGUITY_KEYWORDS_HIGH = ['総合的に判断', '事実関係による', '実態による', '実情に応じ'];
const AMBIGUITY_KEYWORDS_MID  = ['ケースによる', '個別', '一概に', '場合により'];

// ── タックスアンサーで補強できる法令 ──────────────────────────
// 質疑応答事例の kankei_hourei にこれらが含まれていれば、補強可能と判定
const TAXANSWER_LAW_NAMES = ['消費税法', '所得税法', '法人税法', '相続税法', '贈与税法', '租税特別措置法'];

// ── スコアリング個別関数 ──────────────────────────────────────

/**
 * ペルソナ適合度（最大 30）
 * 戻り値: { score, persona, macro }
 */
function scorePersonaMatch(entry) {
  const candidates = PERSONA_BY_TAX_CATEGORY[entry.tax_category_code] || [];
  if (candidates.length === 0) return { score: 0, persona: null, macro: null };

  // 本文（body_combined または body）でキーワードブースト
  const body = entry.body_combined || entry.body || '';
  const title = entry.title || '';
  const haystack = title + ' ' + body;

  let bestScore = 0;
  let bestPersona = candidates[0].persona;
  let bestMacro = candidates[0].macro;

  for (const c of candidates) {
    let score = c.weight;
    // キーワードブースト（最大 +10）
    const kws = PERSONA_KEYWORD_BOOST[c.persona] || [];
    const hits = kws.filter(kw => haystack.includes(kw)).length;
    if (hits >= 3)      score = Math.min(30, score + 10);
    else if (hits >= 1) score = Math.min(30, score + 5);

    if (score > bestScore) {
      bestScore = score;
      bestPersona = c.persona;
      bestMacro = c.macro;
    }
  }
  return { score: bestScore, persona: bestPersona, macro: bestMacro };
}

/**
 * 検索ニーズ推定（最大 20）
 */
function scoreSearchNeed(entry) {
  const title = entry.title || '';
  const body  = entry.body_combined || entry.body || '';
  const haystack = title + ' ' + body;

  const highHits = HIGH_NEED_KEYWORDS.filter(k => haystack.includes(k)).length;
  const midHits  = MID_NEED_KEYWORDS.filter(k  => haystack.includes(k)).length;
  const lowHits  = LOW_NEED_KEYWORDS.filter(k  => haystack.includes(k)).length;

  // タイトルにあるかどうかでブースト
  const titleHasHigh = HIGH_NEED_KEYWORDS.some(k => title.includes(k));
  const titleHasMid  = MID_NEED_KEYWORDS.some(k  => title.includes(k));

  let score = 0;
  if (highHits >= 2 || titleHasHigh) score = 20;
  else if (highHits >= 1 || (midHits >= 2 && titleHasMid)) score = 15;
  else if (midHits >= 1) score = 10;
  else if (lowHits >= 1) score = 3;
  else score = 5;  // ベースライン
  return Math.min(20, score);
}

/**
 * 改正・廃止リスク（最大 10、新しいほど高い）
 * law_version の元号と年を抽出して判定
 */
function scoreFreshness(entry, currentYearReiwa = 7) {
  const lv = entry.law_version || '';
  // 元号と数字を抽出（例: "令和7年8月1日現在の法令・通達等"）
  const m = lv.match(/(令和|平成|昭和)(\d+)年/);
  if (!m) return 5;  // 不明な場合は中間値

  const era = m[1];
  const year = parseInt(m[2], 10);

  // 平成・昭和 → 古い → 低い
  if (era === '昭和') return 0;
  if (era === '平成') return 2;

  // 令和: 現年 vs n の差で判定
  if (era === '令和') {
    const diff = currentYearReiwa - year;
    if (diff <= 0) return 10;   // 当年または将来
    if (diff <= 1) return 9;
    if (diff <= 2) return 7;
    if (diff <= 3) return 5;
    return 3;
  }
  return 5;
}

/**
 * 判断の曖昧さ（最大 15）
 */
function scoreAmbiguity(entry) {
  const body = (entry.body_combined || entry.body || '') + ' ' + (entry.kaitou_yoshi || '');
  let score = 0;
  for (const kw of AMBIGUITY_KEYWORDS_HIGH) {
    if (body.includes(kw)) { score += 8; break; }
  }
  for (const kw of AMBIGUITY_KEYWORDS_MID) {
    if (body.includes(kw)) { score += 4; break; }
  }
  // 「〜場合があります」「〜することができます」のような選択肢提示も曖昧さ材料
  const optionalCount = (body.match(/場合があります|することができます|することがあります/g) || []).length;
  score += Math.min(3, optionalCount);
  return Math.min(15, score);
}

/**
 * タックスアンサー補強可能性（最大 25）
 */
function scoreTaxAnswerSupport(entry) {
  const hourei = entry.kankei_hourei || '';
  if (!hourei) return 0;

  let score = 0;
  for (const law of TAXANSWER_LAW_NAMES) {
    if (hourei.includes(law)) {
      score = 25;
      break;
    }
  }
  if (score === 0) {
    // 通達のみ参照されている場合は中スコア
    if (/基本通達|個別通達|通達/.test(hourei)) score = 10;
    else score = 5;
  }
  return score;
}

// ── トップレベル: 単一エントリを評価 ──────────────────────────
function scoreEntry(entry, options = {}) {
  const currentYearReiwa = options.currentYearReiwa || 7;
  const persona = scorePersonaMatch(entry);
  const searchNeed = scoreSearchNeed(entry);
  const freshness = scoreFreshness(entry, currentYearReiwa);
  const ambiguity = scoreAmbiguity(entry);
  const support = scoreTaxAnswerSupport(entry);

  const total = persona.score + searchNeed + freshness + ambiguity + support;

  return {
    score: total,
    breakdown: {
      persona_match: persona.score,
      search_need: searchNeed,
      freshness,
      judgment_ambiguity: ambiguity,
      taxanswer_support: support,
    },
    proposed: {
      persona: persona.persona,
      macro: persona.macro,
      article_type: 'case_study',  // 候補のデフォルト、後でレビュー時に編集可
    },
  };
}

module.exports = {
  PERSONA_BY_TAX_CATEGORY,
  PERSONA_KEYWORD_BOOST,
  HIGH_NEED_KEYWORDS,
  MID_NEED_KEYWORDS,
  LOW_NEED_KEYWORDS,
  AMBIGUITY_KEYWORDS_HIGH,
  AMBIGUITY_KEYWORDS_MID,
  TAXANSWER_LAW_NAMES,
  scorePersonaMatch,
  scoreSearchNeed,
  scoreFreshness,
  scoreAmbiguity,
  scoreTaxAnswerSupport,
  scoreEntry,
};
