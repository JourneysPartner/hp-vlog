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
  // ── Phase 4 で追加した新カテゴリ ──────────────────────────
  // ※ sub_segments の ID は scenario-new-segments.js の subLabels のキーと一致させる
  youtuber: {
    label: 'YouTuber',
    macro: 'YouTube',
    personas: ['youtuber'],
    kind: 'business',
    sub_segments: ['gaming', 'education', 'vlog', 'live', 'review'],
  },
  content_seller: {
    label: 'コンテンツ販売',
    macro: 'コンテンツ販売',
    personas: ['content_seller'],
    kind: 'business',
    sub_segments: ['note', 'course', 'membership', 'ebook', 'template'],
  },
  construction_solo: {
    label: '1人親方・職人',
    macro: '建設',
    personas: ['construction_solo'],
    kind: 'business',
    sub_segments: ['interior', 'electrical', 'plumbing', 'painting', 'carpenter'],
  },
  retail_store: {
    label: '小売店',
    macro: '小売',
    personas: ['retail_store'],
    kind: 'business',
    sub_segments: ['apparel', 'food', 'variety', 'select', 'souvenir'],
  },
  wholesale: {
    label: '卸売',
    macro: '卸売',
    personas: ['wholesale'],
    kind: 'business',
    sub_segments: ['food', 'apparel', 'material', 'general'],
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
  'YouTube': 'youtuber',
  'コンテンツ販売': 'content_seller',
  '建設': 'construction_solo',
  '小売': 'retail_store',
  '卸売': 'wholesale',
};

// ── 業種特化の論点 → 所属 customer_segment ───────────────────────
// これらの論点はその業種の記事にしか出さない（他業種に流用しない）。
// 例: 回数券は美容サロンのみ、AdSense収益は YouTuber のみ。
const INDUSTRY_PAIN_SEGMENT = {
  'salon-prepayment-ticket': 'beauty_salon',
  'salon-product-service-distinction': 'beauty_salon',
  'ec-inventory-fba-fbm': 'ec_seller',
  'influencer-pr-product-revenue': 'creator',
  'creator-royalty-income': 'creator',
  'affiliate-withholding-judgment': 'creator',
  // 新カテゴリの論点（生成は Phase 4b。所属をここで先に定義）
  'youtube-adsense-revenue': 'youtuber',
  'youtube-membership': 'youtuber',
  'youtube-superchat': 'youtuber',
  'youtube-equipment-expense': 'youtuber',
  'content-note-revenue': 'content_seller',
  'content-online-course': 'content_seller',
  'construction-labor-cost': 'construction_solo',
  'construction-material-cost': 'construction_solo',
  'retail-register-sales': 'retail_store',
  'retail-reduced-tax-rate': 'retail_store',
  'wholesale-accounts-receivable': 'wholesale',
  'wholesale-inventory-valuation': 'wholesale',
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
  // 3) 業種特化の論点は所属 segment 以外に出さない（回数券=サロン、AdSense=YouTuber 等）
  const owner = INDUSTRY_PAIN_SEGMENT[topic.pain_point];
  if (owner && owner !== seg) {
    return false;
  }
  // 4) 事業者向け ⇔ 相続贈与 の税目分離（kind ベース。新カテゴリも自動で対象）
  const def = CUSTOMER_SEGMENTS[seg];
  if (def) {
    if (def.kind === 'business' && topic.tax_domain === 'inheritance_tax') return false;
    if (def.kind === 'life_event' && BUSINESS_TAX_DOMAINS.includes(topic.tax_domain)) return false;
  }
  // 5) REJECT_MATRIX（既存カテゴリの pain_point / tax_domain の明示リスト）
  const rm = REJECT_MATRIX[seg];
  if (rm) {
    if (topic.pain_point && rm.pain_points && rm.pain_points.includes(topic.pain_point)) {
      return false;
    }
    if (topic.tax_domain && rm.tax_domains && rm.tax_domains.includes(topic.tax_domain)) {
      return false;
    }
  }
  // 6) forbidden_context（topic に明示されている場合のみ・安全網）
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
  const owner = INDUSTRY_PAIN_SEGMENT[topic.pain_point];
  if (owner && owner !== seg) {
    return `論点「${topic.pain_point}」は ${owner} 専用（${seg} には不自然）`;
  }
  const def = CUSTOMER_SEGMENTS[seg];
  if (def) {
    if (def.kind === 'business' && topic.tax_domain === 'inheritance_tax') {
      return `事業者カテゴリ ${seg} に相続税の論点は不適合`;
    }
    if (def.kind === 'life_event' && BUSINESS_TAX_DOMAINS.includes(topic.tax_domain)) {
      return `相続贈与カテゴリに事業者税目「${topic.tax_domain}」は不適合`;
    }
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
// 実務・生活イベントに直結する語（検索意図/実用性の判定に使う）
const REAL_WORLD_WORDS = /売上|仕入|在庫|棚卸|手数料|送料|返品|値引|ポイント|経費|報酬|源泉|家賃|給与|外注|人工|材料|工具|回数券|前受金|キャンセル|現金|決済|レジ|軽減税率|売掛|買掛|リベート|機材|編集|旅費|按分|AdSense|収益|収入|スーパーチャット|メンバーシップ|投げ銭|講座|サブスク|返金|note|輸出|輸入|還付|インボイス|相続|贈与|申告|名義預金|生命保険|小規模宅地|住宅取得|準確定|消費税|所得税|法人税|課税|減価償却|デジタル|PDF|前受|棚卸/;
// 読者の悩み・行動語（税務専門用語だけで終わらせない）
const WORRY_WORDS = /いつ|どう|どこ|どちら|必要|できる|なる|いくら|判断|判定|計算|仕訳|確認|注意|扱い|処理|対象|タイミング|方法|ケース|べき|ますか|の？|\?/;
// 相談につながりやすい（判断が割れる・期限・金額影響）
const JUDGMENT_WORDS = /判定|判断|迷|どちら|べき|分かれ/;
const DEADLINE_WORDS = /期限|いつまで|申告|準確定|相続/;
const AMOUNT_WORDS = /還付|節税|税率|控除|万円|軽減|特例|納税/;

function clamp(n) { return Math.min(5, Math.max(1, n)); }

function scoreSearchIntent(topic) {
  const si = String(topic.search_intent || '');
  if (!si) return 1;
  const seg = deriveSegment(topic).customer_segment;
  const segLabel = (CUSTOMER_SEGMENTS[seg] && CUSTOMER_SEGMENTS[seg].label) || '';
  // 業種/カテゴリ名が入っているか（segment ラベル or macro or 業種語）
  const hasSegment = (segLabel && si.includes(segLabel)) || (topic.macro && si.includes(topic.macro));
  // 実際の取引・生活イベントが入っているか
  const hasTransaction = REAL_WORLD_WORDS.test(si);
  // 読者の悩み・行動語が入っているか（キーワード型検索では無い場合もある）
  const hasWorry = WORRY_WORDS.test(si);
  let s = 2;                                       // 非空の基本点
  if (si.length >= 8) s += 1;                      // 具体性
  if (hasSegment || hasTransaction) s += 1;        // 業種 or 実取引が入っている
  if (hasWorry || (hasSegment && hasTransaction)) s += 1; // 悩み語 or 業種×取引の両方
  return clamp(s);
}

function scorePractical(topic) {
  let p = 1;
  if (topic.reader_problem) p += 1;
  if (topic.success_outcome) p += 1;
  const q = String(topic.primary_question || '');
  if (q.length >= 8 && (WORRY_WORDS.test(q) || REAL_WORLD_WORDS.test(q))) p += 1;
  if (topic.pain_point) p += 1;
  return clamp(p);
}

function scoreLeadValue(topic) {
  const text = [topic.primary_question, topic.search_intent, topic.reader_problem, topic.pain_point, topic.topic]
    .filter(Boolean).join(' ');
  let l = 2;
  if (JUDGMENT_WORDS.test(text)) l += 1;                                  // 判断が分かれる
  if (DEADLINE_WORDS.test(text) || topic.tax_domain === 'inheritance_tax') l += 1; // 期限がある
  if (AMOUNT_WORDS.test(text)) l += 1;                                    // 金額影響
  return clamp(l);
}

function evaluateTopicFit(topic = {}) {
  const natural = isNaturalCombination(topic);
  const { customer_segment: seg } = deriveSegment(topic);

  // customer_fit_score
  let customer_fit_score;
  if (!natural) customer_fit_score = 1;
  else if (Array.isArray(topic.allowed_customer_segments) && topic.allowed_customer_segments.includes(seg)) customer_fit_score = 5;
  else if (seg) customer_fit_score = 4;
  else customer_fit_score = 3;

  const search_intent_score = scoreSearchIntent(topic);

  // source_alignment_score（出典一致ゲート。主論点と主出典が一致しているか）
  const sa = checkSourceAlignment(topic);
  const source_alignment_score = sa.score;

  const practical_usefulness_score = natural ? scorePractical(topic) : 2;
  const lead_value_score = natural ? scoreLeadValue(topic) : 2;
  const tax_risk_score = topic.tax_domain === 'inheritance_tax' ? 4 : 3;

  // ── 判定（厳格化）─────────────────────────────────────────
  // hard 不一致 = reject / soft or 出典スコア<=3 = revise /
  // approve は fit>=4 かつ 検索意図>=4 かつ 出典一致>=4 を満たす場合のみ。
  let decision;
  if (!natural) {
    decision = 'reject';
  } else if (sa.severity === 'hard') {
    decision = 'reject';
  } else if (sa.severity === 'soft' || source_alignment_score <= 3) {
    decision = 'revise';
  } else if (customer_fit_score >= 4 && search_intent_score >= 4 && source_alignment_score >= 4) {
    decision = 'approve';
  } else {
    decision = 'revise';
  }

  // reason には出典一致の理由を必ず含める
  const parts = [];
  if (!natural) parts.push(rejectionReason(topic) || '関連性なし');
  if (sa.reason) parts.push(`出典: ${sa.reason}`);
  if (decision !== 'approve' && natural && search_intent_score < 4) parts.push('検索意図が弱い（読者の悩み語・業種名を含めて具体化）');
  const reason = parts.join(' / ');

  // 出典だけが保留理由なら、公開判定は revise のまま維持しつつ生成対象には残す。
  // source_hold / selection_eligible は選定時だけの一時フラグで frontmatter には保存しない。
  const source_hold = decision === 'revise'
    && natural
    && sa.severity !== 'hard'
    && customer_fit_score >= 4
    && search_intent_score >= 4
    && (sa.needs_source_review === true || source_alignment_score <= 3);
  const selection_eligible = source_hold;

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
    source_hold,
    selection_eligible,
    reason,
  };
}

function recommendationForDecision(decision) {
  return decision === 'approve' ? 'publish' : decision;
}

// ── 承認・公開ゲート（frontmatter の recommendation / スコアで判定）─────────
// 承認処理・公開処理・validate が共通で使う。
// recommendation 未設定（スコア無しのレガシー記事）は対象外＝ブロックしない。
// 返り値: ブロック理由の配列（空ならブロックしない）。
function publishGateReasons(meta = {}) {
  const rec = meta.recommendation;
  if (!rec) return [];
  const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  const cf = num(meta.customer_fit_score);
  const si = num(meta.search_intent_score);
  const sa = num(meta.source_alignment_score);
  const reasons = [];
  if (rec === 'reject') reasons.push('recommendation=reject');
  if (rec === 'revise') reasons.push('recommendation=revise');
  if (cf != null && cf <= 3) reasons.push(`customer_fit_score=${cf}`);
  if (si != null && si <= 3) reasons.push(`search_intent_score=${si}`);
  if (sa != null && sa <= 3) reasons.push(`source_alignment_score=${sa}`);
  return reasons;
}

module.exports = {
  CUSTOMER_SEGMENTS,
  SEGMENT_PERSONAS,
  PERSONA_TO_SEGMENT,
  MACRO_TO_SEGMENT,
  REJECT_MATRIX,
  INDUSTRY_PAIN_SEGMENT,
  BUSINESS_TAX_DOMAINS,
  deriveSegment,
  isNaturalCombination,
  rejectionReason,
  evaluateTopicFit,
  recommendationForDecision,
  publishGateReasons,
};
