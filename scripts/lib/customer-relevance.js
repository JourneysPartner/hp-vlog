'use strict';

/**
 * 顧客カテゴリ（customer_segment）関連性ゲート
 *
 * 目的:
 *   「税務論点 → ペルソナに機械展開 → 記事化」ではなく、
 *   「顧客カテゴリ → 実際の取引/生活イベント → 悩み → 税務論点 → 記事化」
 *   にするための、関連性判定を 1 箇所に集約する。
 *
 *   税務論点として正しくても、その読者カテゴリにとって現実味がない
 *   組み合わせ（例: 美容サロン × 海外アーティスト報酬のリバースチャージ）は
 *   isNaturalCombination() が false を返し、生成対象から外す。
 *
 * 設計方針（Phase 1）:
 *   - 既存の persona / macro を壊さず、その上に customer_segment を重ねる。
 *   - deep-dive など「論点起点」で作られる topic には allowed_customer_segments を
 *     持たせ、適合しない segment には展開しない。
 *   - REJECT_MATRIX は curated topic なども含めた最終安全網（segment × 論点/税目）。
 *   - 事業者向け（消費税・インボイス等）と相続贈与（生活イベント）は
 *     税目レベルで相互に混在させない。
 *
 * このモジュールは副作用のない純関数のみを公開し、他の lib に依存しない
 * （循環 require を避けるため leaf モジュールに保つ）。
 */

const { checkSourceAlignment } = require('./source-alignment');

// ── 顧客カテゴリ定義（既存 persona / macro を正規化）─────────────
// Phase 1 で扱う segment。新カテゴリ（youtuber / content_seller /
// construction_solo / retail_store / wholesale）は Phase 4 で追加する。
const CUSTOMER_SEGMENTS = {
  ec_seller: {
    label: 'EC物販',
    macro: '物販',
    personas: ['ebay_export_seller', 'domestic_ec_seller', 'reseller_marketplace_seller'],
    kind: 'business',
  },
  beauty_salon: {
    label: '美容・サロン',
    macro: 'サロン',
    personas: ['beauty_salon_owner'],
    kind: 'business',
  },
  creator: {
    label: 'インフルエンサー・クリエイター',
    macro: 'インフルエンサー',
    personas: ['influencer_creator'],
    kind: 'business',
  },
  general_business: {
    label: '一般事業者',
    macro: '一般事業者',
    personas: ['general_individual_proprietor', 'general_corporation'],
    kind: 'business',
  },
  inheritance_gift: {
    label: '相続・贈与',
    macro: '相続贈与',
    personas: ['inheritance_client'],
    kind: 'life_event',
  },
};

// segment → deep-dive 展開に使う代表 persona 群
const SEGMENT_PERSONAS = Object.fromEntries(
  Object.entries(CUSTOMER_SEGMENTS).map(([seg, def]) => [seg, def.personas])
);

// persona → segment 逆引き
const PERSONA_TO_SEGMENT = {};
for (const [seg, def] of Object.entries(CUSTOMER_SEGMENTS)) {
  for (const p of def.personas) PERSONA_TO_SEGMENT[p] = seg;
}

// macro → segment（persona が取れないときのフォールバック）
const MACRO_TO_SEGMENT = {
  '物販': 'ec_seller',
  'サロン': 'beauty_salon',
  'インフルエンサー': 'creator',
  '相続贈与': 'inheritance_gift',
  '一般事業者': 'general_business',
  '税目実務': 'general_business',
};

// 事業者向けの税目（相続贈与カテゴリには出さない）
const BUSINESS_TAX_DOMAINS = ['consumption_tax', 'bookkeeping_expenses', 'invoice_system', 'withholding'];

// ── REJECT_MATRIX: 明らかに不自然な (segment × 論点/税目) の最終安全網 ──
// pain_points: その segment に出してはいけない deep-dive 論点 id
// tax_domains:  その segment に出してはいけない税目
//
// ※ deep-dive topic は allowed_customer_segments で一次的に制御されるため、
//   ここは curated topic や取りこぼしを止めるための二重防御。
//   （例: 美容サロンの「海外広告/SaaS」= b2b-electronic-services は
//    ユーザー方針で許可なので beauty_salon の reject には入れない）
const REJECT_MATRIX = {
  beauty_salon: {
    pain_points: [
      'specified-services',              // 海外アーティスト・選手
      'foreign-business-consumption-tax',// 国外事業者一般
      'import-tax-refund-detail',        // 輸入消費税還付
      'b2c-electronic-services',         // プラットフォーマー課税
      'customs-duty-treatment',          // 関税
      'ec-inventory-fba-fbm',            // EC在庫
    ],
    tax_domains: ['inheritance_tax'],
  },
  creator: {
    pain_points: [
      'specified-services',
      'foreign-business-consumption-tax',
      'import-tax-refund-detail',
      'customs-duty-treatment',
      'ec-inventory-fba-fbm',
      'salon-prepayment-ticket',
      'salon-product-service-distinction',
      'construction-progress-method',
      'restaurant-cash-management',
    ],
    tax_domains: ['inheritance_tax'],
  },
  ec_seller: {
    pain_points: [
      'salon-prepayment-ticket',
      'salon-product-service-distinction',
      'influencer-pr-product-revenue',
      'creator-royalty-income',
      'affiliate-withholding-judgment',
      'construction-progress-method',
      'restaurant-cash-management',
    ],
    tax_domains: ['inheritance_tax'],
  },
  general_business: {
    pain_points: [
      'salon-prepayment-ticket',
      'salon-product-service-distinction',
      'ec-inventory-fba-fbm',
      'influencer-pr-product-revenue',
      'creator-royalty-income',
    ],
    tax_domains: ['inheritance_tax'],
  },
  // 相続贈与カテゴリには事業者向けの税目・論点を一切混ぜない
  inheritance_gift: {
    pain_points: [],
    tax_domains: BUSINESS_TAX_DOMAINS,
  },
};

// ── segment 導出 ─────────────────────────────────────────────
function deriveSegment(topic = {}) {
  if (topic.customer_segment && CUSTOMER_SEGMENTS[topic.customer_segment]) {
    return {
      customer_segment: topic.customer_segment,
      sub_segment: topic.sub_segment || topic.cluster || '',
      life_event_segment: topic.life_event_segment || topic.life_stage || '',
    };
  }
  const persona = topic.persona || topic.primary_persona || '';
  let seg = PERSONA_TO_SEGMENT[persona] || MACRO_TO_SEGMENT[topic.macro] || '';
  return {
    customer_segment: seg,
    sub_segment: topic.cluster || '',
    life_event_segment: seg === 'inheritance_gift' ? (topic.life_stage || '') : '',
  };
}

// topic の主要テキスト（forbidden_context 判定用）
function topicText(topic = {}) {
  return [
    topic.title, topic.topic, topic.search_intent,
    topic.primary_question, topic.reader_problem, topic.q,
  ].filter(Boolean).join(' ');
}

// ── 関連性ゲート本体 ─────────────────────────────────────────
// その topic を、対象 customer_segment の記事として生成してよいか。
function isNaturalCombination(topic = {}) {
  const { customer_segment: seg } = deriveSegment(topic);
  if (!seg) return true; // segment 不明のものは止めない（既存挙動を壊さない）

  // 1) allowed_customer_segments が指定されていれば、そこに含まれる必要がある
  const allowed = topic.allowed_customer_segments;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(seg)) {
    return false;
  }
  // 2) excluded_customer_segments
  const excluded = topic.excluded_customer_segments;
  if (Array.isArray(excluded) && excluded.includes(seg)) {
    return false;
  }
  // 3) REJECT_MATRIX（pain_point / tax_domain）
  const rm = REJECT_MATRIX[seg];
  if (rm) {
    if (topic.pain_point && rm.pain_points && rm.pain_points.includes(topic.pain_point)) {
      return false;
    }
    if (topic.tax_domain && rm.tax_domains && rm.tax_domains.includes(topic.tax_domain)) {
      return false;
    }
  }
  // 4) forbidden_context（topic に明示されている場合のみ・安全網）
  if (Array.isArray(topic.forbidden_context) && topic.forbidden_context.length > 0) {
    const text = topicText(topic);
    if (topic.forbidden_context.some(term => term && text.includes(term))) {
      return false;
    }
  }
  return true;
}

// 除外理由（ログ・レビュー表示用）
function rejectionReason(topic = {}) {
  const { customer_segment: seg } = deriveSegment(topic);
  if (!seg) return null;
  const allowed = topic.allowed_customer_segments;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(seg)) {
    return `${seg} は許可カテゴリ [${allowed.join(', ')}] に含まれない`;
  }
  const excluded = topic.excluded_customer_segments;
  if (Array.isArray(excluded) && excluded.includes(seg)) {
    return `${seg} は excluded に指定されている`;
  }
  const rm = REJECT_MATRIX[seg];
  if (rm) {
    if (topic.pain_point && rm.pain_points && rm.pain_points.includes(topic.pain_point)) {
      return `${seg} × 論点「${topic.pain_point}」は不自然`;
    }
    if (topic.tax_domain && rm.tax_domains && rm.tax_domains.includes(topic.tax_domain)) {
      return `${seg} に税目「${topic.tax_domain}」は不適合`;
    }
  }
  if (Array.isArray(topic.forbidden_context) && topic.forbidden_context.length > 0) {
    const text = topicText(topic);
    const hit = topic.forbidden_context.find(term => term && text.includes(term));
    if (hit) return `禁止コンテキスト「${hit}」を含む`;
  }
  return null;
}

// ── 適合スコア評価 ───────────────────────────────────────────
// Phase 1 は customer_fit / search_intent を実装。source_alignment は
// 暫定（tax_domain / source_url の粗評価）で、厳密版は Phase 3。
function evaluateTopicFit(topic = {}) {
  const natural = isNaturalCombination(topic);
  const { customer_segment: seg } = deriveSegment(topic);

  // customer_fit_score
  let customer_fit_score;
  if (!natural) customer_fit_score = 1;
  else if (Array.isArray(topic.allowed_customer_segments) && topic.allowed_customer_segments.includes(seg)) customer_fit_score = 5;
  else if (seg) customer_fit_score = 4;
  else customer_fit_score = 3;

  // search_intent_score（検索意図が具体的に書かれているか）
  const si = String(topic.search_intent || '');
  const search_intent_score = si.length >= 12 ? 4 : (si.length > 0 ? 3 : 2);

  // source_alignment_score（出典一致ゲート。主論点と主出典が一致しているか）
  const sa = checkSourceAlignment(topic);
  const source_alignment_score = sa.score;

  // その他（Phase 1 既定値。後続で精緻化）
  const practical_usefulness_score = natural ? 4 : 2;
  const lead_value_score = natural ? 4 : 2;
  const tax_risk_score = topic.tax_domain === 'inheritance_tax' ? 4 : 3;

  let decision = 'approve';
  if (!natural || customer_fit_score <= 2) {
    decision = 'reject';
  } else if (customer_fit_score <= 3 || search_intent_score <= 3 || sa.severity === 'hard') {
    decision = 'revise';
  }

  let reason = '';
  if (!natural) reason = rejectionReason(topic) || '関連性なし';
  else if (sa.severity === 'hard') reason = sa.reason;

  return {
    customer_segment: seg || '',
    customer_fit_score,
    search_intent_score,
    practical_usefulness_score,
    source_alignment_score,
    source_alignment_reason: sa.reason,
    lead_value_score,
    tax_risk_score,
    decision,
    reason,
  };
}

module.exports = {
  CUSTOMER_SEGMENTS,
  SEGMENT_PERSONAS,
  PERSONA_TO_SEGMENT,
  MACRO_TO_SEGMENT,
  REJECT_MATRIX,
  BUSINESS_TAX_DOMAINS,
  deriveSegment,
  isNaturalCombination,
  rejectionReason,
  evaluateTopicFit,
};
