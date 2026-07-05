'use strict';

/**
 * 質疑応答事例候補の自動一次選別（triage）
 *
 * 目的: 候補が多すぎて全件を人手で見るのが大変なので、AI/ルールで一次選別し、
 * 人間は「迷うもの（review）」だけを見れば済むようにする。
 *
 * 各候補に付与するフィールド:
 *   - auto_score: 0〜100（既存 score をベースに調整）
 *   - auto_decision: 'recommend' | 'review' | 'reject'
 *   - auto_reasons: string[]
 *   - target_segments: customer_segment[]（対象読者カテゴリ）
 *   - article_potential: 'high' | 'medium' | 'low'
 *
 * 判定目安: 85+ = recommend / 55〜84 = review / 54- = reject。
 * ただし「現在のブログ読者に合いにくい特殊論点」は score に関わらず reject。
 *
 * ※ adopted / rejected / notes / proposed などの手動編集は変更しない（呼び出し側で保持）。
 */

const { PERSONA_TO_SEGMENT, MACRO_TO_SEGMENT } = require('./customer-relevance');

// 現在のブログ読者（個人事業者・小規模事業者・相続贈与の個人）に合いにくい特殊論点。
// これらは score に関わらず auto_decision='reject'。
const OUT_OF_SCOPE = [
  { re: /連結納税|グループ通算/, label: '連結・グループ通算（大法人向け）' },
  { re: /組織再編|合併|分割型|会社分割|株式交換|株式移転|現物出資|事業譲受け/, label: '組織再編（大法人向け）' },
  { re: /公益社団|公益財団|公益法人|一般社団|一般財団|宗教法人|学校法人|社会福祉法人|協同組合|信用金庫|農業協同組合/, label: '公益・特殊法人向け' },
  { re: /デリバティブ|有価証券の評価|先物|オプション取引|ストックオプション|新株予約権|社債|公社債|投資信託|匿名組合/, label: '金融商品・有価証券' },
  { re: /信託|SPC|特定目的会社|受益権/, label: '信託・ストラクチャード' },
  { re: /移転価格|外国税額控除|恒久的施設|タックスヘイブン|外国子会社合算|過少資本/, label: '国際課税（大法人向け）' },
  { re: /連結財務諸表|上場|IPO|新規上場/, label: '上場・大企業特有' },
];

// 記事化しにくい（一般化しづらい）シグナル
const HARD_TO_GENERALIZE = /特殊|極めて限定的|個別通達|文理解釈|遡及適用/;

function detectOutOfScope(text) {
  for (const o of OUT_OF_SCOPE) if (o.re.test(text)) return o.label;
  return null;
}

// proposed.persona / macro / tax_category から対象 customer_segment を推定
function inferSegments(c) {
  const segs = new Set();
  const persona = c.proposed && c.proposed.persona;
  if (persona && PERSONA_TO_SEGMENT[persona]) segs.add(PERSONA_TO_SEGMENT[persona]);
  const macro = c.proposed && c.proposed.macro;
  if (macro && MACRO_TO_SEGMENT[macro]) segs.add(MACRO_TO_SEGMENT[macro]);
  // 税目からの補助推定
  if ((c.tax_category || '').match(/相続|贈与/)) segs.add('inheritance_gift');
  return [...segs];
}

/**
 * @param {Object} c 候補（shitsugi_title / tax_category / score / score_breakdown / proposed 等）
 * @returns {{auto_score:number, auto_decision:string, auto_reasons:string[],
 *            target_segments:string[], article_potential:string}}
 */
function triageCandidate(c = {}) {
  const title = c.shitsugi_title || '';
  const text = `${title} ${c.tax_category || ''} ${(c.kankei_hourei || '')}`;
  const reasons = [];

  const base = Number.isFinite(c.score) ? c.score : parseInt(c.score, 10) || 0;
  const bd = c.score_breakdown || {};
  const target_segments = inferSegments(c);

  // 対象読者カテゴリが推定できないと集客に結びつきにくい
  let auto_score = base;
  if (target_segments.length === 0) { auto_score -= 10; reasons.push('対象読者カテゴリが不明確'); }
  if (bd.persona_match != null && bd.persona_match >= 25) reasons.push('読者カテゴリ適合が高い');
  if (bd.search_need != null && bd.search_need >= 15) reasons.push('検索需要が見込める');
  if (bd.judgment_ambiguity != null && bd.judgment_ambiguity >= 5) reasons.push('判断が分かれ相談につながりやすい');
  if (bd.taxanswer_support != null && bd.taxanswer_support >= 20) reasons.push('出典が使いやすい');
  if (HARD_TO_GENERALIZE.test(text)) { auto_score -= 10; reasons.push('一般化しにくい（記事化が難しい）'); }
  auto_score = Math.max(0, Math.min(100, auto_score));

  // 記事化ポテンシャル
  const article_potential = auto_score >= 85 ? 'high' : (auto_score >= 65 ? 'medium' : 'low');

  // 対象外（特殊論点）は score に関わらず reject
  const oos = detectOutOfScope(text);
  let auto_decision;
  if (oos) {
    auto_decision = 'reject';
    reasons.unshift(`対象外: ${oos}（現在のブログ読者に不適合）`);
  } else if (auto_score >= 85) {
    auto_decision = 'recommend';
  } else if (auto_score >= 55) {
    auto_decision = 'review';
  } else {
    auto_decision = 'reject';
    reasons.push('スコアが低い（読者価値・記事化ポテンシャルが不足）');
  }

  return { auto_score, auto_decision, auto_reasons: reasons, target_segments, article_potential };
}

// 候補配列に triage フィールドを付与（手動編集フィールドは変更しない）
function applyTriage(candidates = []) {
  const counts = { recommend: 0, review: 0, reject: 0 };
  for (const c of candidates) {
    const t = triageCandidate(c);
    c.auto_score = t.auto_score;
    c.auto_decision = t.auto_decision;
    c.auto_reasons = t.auto_reasons;
    c.target_segments = t.target_segments;
    c.article_potential = t.article_potential;
    counts[t.auto_decision] = (counts[t.auto_decision] || 0) + 1;
  }
  return counts;
}

module.exports = { triageCandidate, applyTriage, OUT_OF_SCOPE };
