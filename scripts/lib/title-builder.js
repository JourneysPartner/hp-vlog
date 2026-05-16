'use strict';

/**
 * 自然な日本語タイトル生成エンジン。
 *
 * scenario-expansion.js から呼び出され、軸（life_stage / asset_type / heir_role /
 * procedure_stage / pain_point / business_stage / platform 等）の組合せから
 * 検索者が実際に検索しそうな自然なタイトルを返す。
 *
 * 方針:
 *   - 軸ラベルをそのまま連結しない（"〇〇に押さえる△△の基本"のような機械感を排除）
 *   - pain_point / procedure_stage / asset_type から「lead（記事の主題）」を選び、
 *     article_type から「closer（記事の役割を示す結句）」を選ぶ
 *   - 必要に応じて life_stage / heir_role / asset_type を文脈として混ぜる
 *
 * 公開関数:
 *   buildTitle(ctx) — ctx から自然なタイトル文字列を返す
 */

const { lookup, LIFE_STAGES, HEIR_ROLES, ASSET_TYPES, PROCEDURE_STAGES,
        PAIN_POINTS, BUSINESS_STAGES, RETAIL_PLATFORMS, INFLUENCER_CHANNELS,
        SALON_TYPES } = require('./scenario-axes');

// ── 決定論的ハッシュ（同じ slug は常に同じ closer を選ぶ）─────────
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function pick(arr, key) {
  if (!arr || arr.length === 0) return '';
  return arr[hashStr(key) % arr.length];
}

// ════════════════════════════════════════════════════════════════
//  共通の「closer（記事タイプ別の結句）」
// ════════════════════════════════════════════════════════════════
const CLOSERS = {
  basic_explainer:     ['判断ポイントを整理', '基本を整理', '確認したいポイント', '初動を整理'],
  comparison_decision: ['家族で確認したい判断ポイント', '比較して考えるポイント', '判断の整理'],
  filing_practice:     ['必要書類と手続きの流れ', '必要書類と注意点', '手続きの進め方'],
  misconception_fix:   ['よくある誤解を整理', '誤解しやすい点を整理'],
  edge_case:           ['判断に迷うときの整理', '注意したいケース'],
  case_study:          ['事例で考えるポイント', '判断の流れを事例で解説'],
  industry_example:    ['業種別に確認したいポイント', '具体例で確認したい注意点'],
};

function closerFor(article_type, key) {
  const list = CLOSERS[article_type] || CLOSERS.basic_explainer;
  return pick(list, key);
}

// ════════════════════════════════════════════════════════════════
//  【相続贈与】の lead パターン
// ════════════════════════════════════════════════════════════════
// pain_point → 自然な lead 文字列を返す関数
const INHERITANCE_LEAD_BY_PAIN = {
  'bank-frozen':              () => '相続で銀行口座が凍結されたらどうする？',
  'small-residential-land':   (ctx) => ctx.asset_type === 'home'
    ? '自宅を相続したとき小規模宅地等の特例は使える？'
    : '小規模宅地等の特例を使えるケースとは？',
  'spouse-reduction':         (ctx) => ctx.life_stage === 'second-inheritance' || ctx.life_stage === 'multi-year-review'
    ? '配偶者が多く相続するのは本当に有利？二次相続まで見て考える'
    : '相続税の配偶者の税額軽減はどう使う？',
  'real-estate-valuation':    (ctx) => {
    if (ctx.asset_type === 'rental-property') return '賃貸不動産はどう評価する？相続税の計算で気をつけたい点';
    if (ctx.asset_type === 'vacant-house')    return '空き家を相続したときの評価と選択肢';
    if (ctx.asset_type === 'home')            return '自宅の評価で迷ったときに確認したいこと';
    return '相続不動産の評価で迷ったときに確認したいこと';
  },
  'family-dispute':           (ctx) => ctx.life_stage === 'pre-planning'
    ? '相続で家族間の意見が割れそうなときに備えること'
    : '遺産分割で家族の意見が割れたときの整理',
  'name-deposits-concern':    () => '名義預金とみなされやすいケースとは？',
  'lifetime-gift-addback':    () => '生前贈与が相続財産に戻るケースとは？',
  'life-insurance-exemption': () => '生命保険金の非課税枠はどこまで使える？',
  'funeral-debt-deduction':   (ctx) => ctx.heir_role === 'sole-proprietor-family' ||
                                       (ctx.life_stage === 'within-4months' && ctx.procedure_stage === 'quasi-final-return')
    ? '個人事業主が亡くなったときの準確定申告'
    : '相続で借入金や葬式費用はどう控除する？',
  'second-inheritance-loss':  () => '二次相続で損しないために配偶者相続をどう考える？',
  'heir-confirmation':        (ctx) => ctx.heir_role === 'no-child-couple'
    ? '子どもがいない夫婦の相続｜相続人は誰になる？'
    : '相続人を確定する戸籍収集はどう進める？',
  'company-shares-valuation': () => '会社オーナーの相続で自社株はどう評価する？',
  'real-estate-registration-pain': () => '相続登記はいつまでに？必要書類と進め方',
  'amendment-needed':         () => '相続税の修正申告・更正の請求が必要なケース',
  'rental-property-treatment': () => '賃貸不動産を相続したときの評価と申告のポイント',
  'vacant-house-handling':    () => '空き家を相続したらどうする？売却・保有・解体の判断',
  'tax-applicable-or-not':    (ctx) => ctx.life_stage === 'pre-planning'
    ? 'うちは相続税がかかる？生前に確認したい判断ライン'
    : '相続税申告が必要か分からないときの判断基準',
  'business-succession':      (ctx) => ctx.heir_role === 'sole-proprietor-family'
    ? '個人事業をどう引き継ぐ？相続前後で家族が確認すべきこと'
    : '事業承継で家族が確認すべき税務のポイント',
  'what-first':               (ctx) => {
    if (ctx.life_stage === 'critical-immediate' || ctx.life_stage === 'within-7days')
      return '親が亡くなった直後にまずやること';
    if (ctx.life_stage === 'cognitive-decline')
      return '親の判断力が落ち始めたら家族が確認したいこと';
    return '相続手続きは何から始める？';
  },
  'deadline-pressure':        () => '相続税申告の10か月期限に間に合わせるコツ',
};

// procedure_stage → lead（pain がない D seed 用）
const INHERITANCE_LEAD_BY_PROCEDURE = {
  'initial-immediate':         '相続発生直後にやるべきこと',
  'bank-procedure':            '相続で銀行口座を扱うときの手続き',
  'document-collection':       '相続手続きで必要な書類の集め方',
  'quasi-final-return':        '準確定申告の進め方と注意点',
  'estate-division':           '遺産分割協議をスムーズに進めるコツ',
  'inheritance-filing':        '相続税申告の準備と提出までの流れ',
  'real-estate-registration':  '相続登記の進め方と必要書類',
  'valuation-check':           '相続財産の評価で迷ったときの確認ポイント',
  'amendment-return':          '相続税の修正申告・更正の請求',
  'second-inheritance-review': '二次相続を見据えた相続税対策',
};

// life_stage → ヒント（重複を避けるための追加コンテキスト）
const LIFE_STAGE_CONTEXT = {
  'pre-planning':        '生前にできる準備',
  'cognitive-decline':   '判断力が落ち始めたら',
  'critical-immediate':  '亡くなった直後',
  'within-7days':        '葬儀直後',
  'within-4months':      '4か月以内',
  'within-10months':     '10か月以内',
  'after-filing':        '申告後',
  'second-inheritance':  '二次相続を見据えて',
  'multi-year-review':   '数年後の見直し',
};

function buildInheritanceTitle(ctx, key) {
  const { article_type, pain_point, procedure_stage } = ctx;

  // 1. lead を決める
  let lead = '';
  if (pain_point && INHERITANCE_LEAD_BY_PAIN[pain_point]) {
    lead = INHERITANCE_LEAD_BY_PAIN[pain_point](ctx);
  } else if (procedure_stage && INHERITANCE_LEAD_BY_PROCEDURE[procedure_stage]) {
    lead = INHERITANCE_LEAD_BY_PROCEDURE[procedure_stage];
  } else {
    // フォールバック: life_stage + pain で汎用
    const stageLbl = lookup(LIFE_STAGES, ctx.life_stage)?.label || '相続';
    const painLbl  = lookup(PAIN_POINTS, pain_point)?.label || '相続税の論点';
    lead = `${stageLbl}に確認したい${painLbl}`;
  }

  // 2. closer
  const closer = closerFor(article_type, key);

  // 3. ベース結合（lead が既に十分な文脈を持つので closer はシンプルに付ける）
  const title = `${lead}｜${closer}`;
  return title;
}

// ════════════════════════════════════════════════════════════════
//  【物販】の lead パターン
// ════════════════════════════════════════════════════════════════
const RETAIL_LEAD_BY_PAIN = {
  'consumption-tax-judgement': (ctx) => `${ctx.platform_label}の売上に消費税はいつから関係する？課税事業者の判断基準`,
  'invoice-judgement':         (ctx) => `${ctx.platform_label}セラーはインボイス登録すべき？判断のポイント`,
  'overseas-tax-uncertain':    (ctx) => `${ctx.platform_label}の海外売上は消費税でどう扱う？`,
  'tax-refund-eligibility':    (ctx) => `${ctx.platform_label}輸出で消費税還付は受けられる？確認したい条件`,
  'platform-fee-treatment':    (ctx) => `${ctx.platform_label}の手数料はどう経理する？仕訳と保存資料の基本`,
  'return-refund-entry':       (ctx) => `${ctx.platform_label}の返品・返金はどう処理する？`,
  'inventory-balance':         (ctx) => `${ctx.platform_label}の在庫管理と棚卸｜確定申告までに整えたいこと`,
  'expense-grayzone':          (ctx) => `${ctx.platform_label}の経費はどこまで？判断に迷いやすい項目を整理`,
  'family-employment':         (ctx) => `${ctx.platform_label}で家族に手伝ってもらうときの注意点`,
  'incorporation-threshold':   (ctx) => `${ctx.platform_label}は法人化を考えるべき売上ライン？`,
};

function buildRetailTitle(ctx, key) {
  const platform = lookup(RETAIL_PLATFORMS, ctx.platform_id || ctx.cluster);
  const platformLabel = platform?.label || ctx.platform_label || ctx.cluster;
  const enriched = { ...ctx, platform_label: platformLabel };
  const pain = ctx.pain_point;

  let lead = '';
  if (pain && RETAIL_LEAD_BY_PAIN[pain]) {
    lead = RETAIL_LEAD_BY_PAIN[pain](enriched);
  } else {
    const painLbl = lookup(PAIN_POINTS, pain)?.label || '税務上の論点';
    lead = `${platformLabel}で気になる${painLbl}`;
  }

  const closer = closerFor(ctx.article_type, key);
  return `${lead}｜${closer}`;
}

// ════════════════════════════════════════════════════════════════
//  【インフルエンサー】の lead パターン
// ════════════════════════════════════════════════════════════════
const INFLUENCER_LEAD_BY_PAIN = {
  'income-classification':     (ctx) => `${ctx.channel_label}の収益は事業所得か雑所得か？判断に迷うポイント`,
  'expense-grayzone':          (ctx) => `${ctx.channel_label}の経費はどこまで？衣装・美容代・機材の判断基準`,
  'recognition-timing':        (ctx) => `${ctx.channel_label}のPR・アフィリエイト収入はいつ計上する？`,
  'withholding-treatment':     (ctx) => `${ctx.channel_label}の案件報酬で源泉徴収はどう扱う？`,
  'invoice-judgement':         (ctx) => `${ctx.channel_label}運用者はインボイス登録すべき？企業案件への影響`,
  'incorporation-threshold':   (ctx) => `${ctx.channel_label}運用者は法人化を考えるべき？判断のポイント`,
  'platform-fee-treatment':    (ctx) => `${ctx.channel_label}のプラットフォーム手数料はどう経理する？`,
};

function buildInfluencerTitle(ctx, key) {
  const ch = lookup(INFLUENCER_CHANNELS, ctx.channel_id || ctx.cluster);
  const channelLabel = ch?.label || ctx.channel_label || ctx.cluster;
  const enriched = { ...ctx, channel_label: channelLabel };
  const pain = ctx.pain_point;

  let lead = '';
  if (pain && INFLUENCER_LEAD_BY_PAIN[pain]) {
    lead = INFLUENCER_LEAD_BY_PAIN[pain](enriched);
  } else {
    const painLbl = lookup(PAIN_POINTS, pain)?.label || '税務上の論点';
    lead = `${channelLabel}運用で気になる${painLbl}`;
  }

  const closer = closerFor(ctx.article_type, key);
  return `${lead}｜${closer}`;
}

// ════════════════════════════════════════════════════════════════
//  【サロン】の lead パターン
// ════════════════════════════════════════════════════════════════
const SALON_LEAD_BY_PAIN = {
  'prepayment-recognition':    (ctx) => `${ctx.salon_label}の回数券・前受金はいつ売上にする？`,
  'staff-employment':          (ctx) => `${ctx.salon_label}でスタッフを雇うときの源泉徴収と社会保険`,
  'cash-management':           (ctx) => `${ctx.salon_label}の現金売上はどう管理する？帳簿と税務調査`,
  'expense-grayzone':          (ctx) => `${ctx.salon_label}の経費はどこまで？備品・消耗品・研修費の扱い`,
  'invoice-judgement':         (ctx) => `${ctx.salon_label}でインボイス登録は必要？お客様の構成で考える`,
  'incorporation-threshold':   (ctx) => `${ctx.salon_label}は法人化を考えるべき売上ライン？`,
  'family-employment':         (ctx) => `${ctx.salon_label}で家族を雇うときの注意点`,
  'return-refund-entry':       (ctx) => `${ctx.salon_label}でのキャンセル料・返金はどう処理する？`,
};

function buildSalonTitle(ctx, key) {
  const sa = lookup(SALON_TYPES, ctx.salon_id || ctx.cluster);
  const salonLabel = sa?.label || ctx.salon_label || ctx.cluster;
  const enriched = { ...ctx, salon_label: salonLabel };
  const pain = ctx.pain_point;

  let lead = '';
  if (pain && SALON_LEAD_BY_PAIN[pain]) {
    lead = SALON_LEAD_BY_PAIN[pain](enriched);
  } else {
    const painLbl = lookup(PAIN_POINTS, pain)?.label || '税務上の論点';
    lead = `${salonLabel}で気になる${painLbl}`;
  }

  const closer = closerFor(ctx.article_type, key);
  return `${lead}｜${closer}`;
}

// ════════════════════════════════════════════════════════════════
//  【一般事業者】の lead パターン
// ════════════════════════════════════════════════════════════════
const GENERAL_LEAD_BY_PAIN = {
  'income-classification':         () => '副業収入は事業所得か雑所得か？判断に迷うポイント',
  'incorporation-threshold':       () => '個人事業主が法人化を考えるべき売上ライン',
  'family-employment':             () => '家族に給料を払うときの注意点｜青色専従者と外注の違い',
  'social-insurance-misconception': () => '社会保険の扶養と税の扶養の違い',
  'expense-grayzone':              () => '個人事業主の経費はどこまで？判断に迷いやすい項目',
  'consumption-tax-judgement':     () => '消費税の課税事業者になる基準｜売上1000万円の判定',
  'invoice-judgement':             () => 'インボイス登録は本当に必要？個人事業主が判断するポイント',
  'staff-employment':              () => 'スタッフを雇うときの源泉徴収と社会保険の準備',
};

function buildGeneralTitle(ctx, key) {
  const pain = ctx.pain_point;
  let lead = pain && GENERAL_LEAD_BY_PAIN[pain]
    ? GENERAL_LEAD_BY_PAIN[pain]()
    : `個人事業主が確認したい${lookup(PAIN_POINTS, pain)?.label || '税務論点'}`;
  const closer = closerFor(ctx.article_type, key);
  return `${lead}｜${closer}`;
}

// ════════════════════════════════════════════════════════════════
//  【税目実務】の lead パターン
// ════════════════════════════════════════════════════════════════
const TAX_DOMAIN_LABELS = {
  consumption_tax:        '消費税',
  income_tax:             '所得税',
  invoice_system:         'インボイス制度',
  bookkeeping_expenses:   '帳簿・経費',
  inheritance_tax:        '相続税',
  overseas_transactions:  '海外取引',
  withholding:            '源泉徴収',
};

function buildTaxDomainTitle(ctx, key) {
  const taxLabel = TAX_DOMAIN_LABELS[ctx.tax_domain] || '税目';
  const proc     = lookup(PROCEDURE_STAGES, ctx.procedure_stage)?.label || '手続き';
  const pain     = lookup(PAIN_POINTS, ctx.pain_point)?.label || '判断ポイント';

  const closer = closerFor(ctx.article_type, key);
  // pain が procedure と意味的に近い場合は冗長にならないようにする
  const lead = `${taxLabel}の${proc}で${pain}にどう向き合う？`;
  return `${lead}｜${closer}`;
}

// ════════════════════════════════════════════════════════════════
//  公開関数
// ════════════════════════════════════════════════════════════════
/**
 * @param {Object} ctx
 *   macro, article_type, cluster, persona,
 *   business_stage, life_stage, heir_role,
 *   asset_type, procedure_stage, pain_point,
 *   platform_id, channel_id, salon_id, tax_domain,
 *   slug (variety hash 用、未指定なら他フィールドから生成)
 */
function buildTitle(ctx) {
  const key = ctx.slug || JSON.stringify({
    m: ctx.macro, a: ctx.article_type, c: ctx.cluster,
    bs: ctx.business_stage, ls: ctx.life_stage, hr: ctx.heir_role,
    at: ctx.asset_type, ps: ctx.procedure_stage, pp: ctx.pain_point,
  });

  switch (ctx.macro) {
    case '物販':           return buildRetailTitle(ctx, key);
    case 'インフルエンサー': return buildInfluencerTitle(ctx, key);
    case 'サロン':          return buildSalonTitle(ctx, key);
    case '相続贈与':        return buildInheritanceTitle(ctx, key);
    case '一般事業者':      return buildGeneralTitle(ctx, key);
    case '税目実務':        return buildTaxDomainTitle(ctx, key);
    default:               return `${lookup(PAIN_POINTS, ctx.pain_point)?.label || ctx.cluster || 'テーマ'}｜${closerFor(ctx.article_type, key)}`;
  }
}

module.exports = {
  buildTitle,
  closerFor,
  INHERITANCE_LEAD_BY_PAIN,
  INHERITANCE_LEAD_BY_PROCEDURE,
  RETAIL_LEAD_BY_PAIN,
  INFLUENCER_LEAD_BY_PAIN,
  SALON_LEAD_BY_PAIN,
  GENERAL_LEAD_BY_PAIN,
};
