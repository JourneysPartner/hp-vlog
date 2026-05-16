'use strict';

/**
 * シナリオ展開エンジン
 *
 * 「業種別シナリオ + 軸」から、daily-draft 候補となる topic 群を動的に展開する。
 *
 * 各 SCENARIO_BASE は「業種 / 事業者像」を 1 つ表し、
 *   - どの軸を持つか
 *   - その軸でどの値を取り得るか
 *   - 軸の組み合わせで生まれる candidate に何の article_type を割り当てるか
 *   - title / search_intent / reader_problem / primary_question をどう組み立てるか
 * を持つ。
 *
 * 展開後の各 topic は cluster-taxonomy / cooldown / similarity / denylist /
 * category-balance と同じ key（slug / subcluster / cluster / macro）を持つので、
 * 既存のフィルタロジックがそのまま使える。
 */

const {
  BUSINESS_STAGES, LIFE_STAGES, TRANSACTION_PATTERNS, PROCEDURE_STAGES,
  PAIN_POINTS, ASSET_TYPES, RETAIL_PLATFORMS, INFLUENCER_CHANNELS, SALON_TYPES,
  MAIN_ARTICLE_TYPES, lookup,
} = require('./scenario-axes');

// ── 文字列ヘルパー ────────────────────────────────────────────────
function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{([a-zA-Z_]+)\}/g, (_, k) => vars[k] != null ? vars[k] : `{${k}}`);
}

// 確定的（決定論的）に article_type を割り当てる
// 軸の組み合わせから安定したインデックスを作る → 同じ軸セットなら同じ type
function deterministicTypeIndex(slug, types) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return types[h % types.length];
}

// pair_group をシナリオ単位で付与（同じ base + 同じ primary axis 値の topic をペアにする）
function pairKey(base, primaryAxisValue) {
  return `${base.cluster}-${primaryAxisValue}`;
}

// ── 物販シナリオ ──────────────────────────────────────────────────
// 軸: platform × business_stage × pain_point
// 物販は「事業者像」が共通なので、プラットフォーム × 事業ステージ × 痛点 で展開
const RETAIL_PAINS = [
  'consumption-tax-judgement', 'invoice-judgement', 'incorporation-threshold',
  'platform-fee-treatment', 'return-refund-entry', 'inventory-balance',
  'expense-grayzone', 'family-employment',
];
const RETAIL_PAINS_OVERSEAS = [...RETAIL_PAINS, 'overseas-tax-uncertain', 'tax-refund-eligibility'];
const RETAIL_STAGES = ['just-opened', 'side-business', 'growth', 'incorporation'];

// ── インフルエンサーシナリオ ──────────────────────────────────────
// 軸: channel × business_stage × pain_point
const INFLUENCER_PAINS = [
  'income-classification', 'expense-grayzone', 'recognition-timing',
  'withholding-treatment', 'invoice-judgement', 'incorporation-threshold',
  'platform-fee-treatment',
];
const INFLUENCER_STAGES = ['side-business', 'just-opened', 'growth', 'incorporation'];

// ── サロンシナリオ ────────────────────────────────────────────────
// 軸: salon_type × business_stage × pain_point
const SALON_PAINS = [
  'prepayment-recognition', 'staff-employment', 'cash-management',
  'expense-grayzone', 'invoice-judgement', 'incorporation-threshold',
  'family-employment', 'return-refund-entry',
];
const SALON_STAGES = ['pre-opening', 'just-opened', 'growth', 'hiring', 'incorporation'];

// ── 相続シナリオ ──────────────────────────────────────────────────
// 軸: life_stage × pain_point（asset_type は任意で 1 軸追加）
const INHERITANCE_PAINS = [
  'what-first', 'tax-applicable-or-not', 'spouse-reduction',
  'small-residential-land', 'real-estate-valuation', 'deadline-pressure',
  'family-dispute', 'bank-frozen', 'business-succession',
];
const INHERITANCE_STAGES = [
  'pre-planning', 'cognitive-decline', 'critical-immediate',
  'within-7days', 'within-4months', 'within-10months',
  'after-filing', 'second-inheritance',
];
// life_stage と pain_point の「自然な組み合わせ」だけを許容
// （例: 認知機能低下 × 銀行凍結 は不自然なので組まない）
const INHERITANCE_STAGE_PAIN_MATRIX = {
  'pre-planning':         ['tax-applicable-or-not', 'spouse-reduction', 'business-succession', 'family-dispute'],
  'cognitive-decline':    ['what-first', 'family-dispute', 'business-succession'],
  'critical-immediate':   ['what-first', 'bank-frozen', 'deadline-pressure'],
  'within-7days':         ['what-first', 'bank-frozen'],
  'within-4months':       ['deadline-pressure', 'what-first'],
  'within-10months':      ['tax-applicable-or-not', 'spouse-reduction', 'small-residential-land',
                           'real-estate-valuation', 'deadline-pressure', 'family-dispute', 'bank-frozen'],
  'after-filing':         ['real-estate-valuation', 'family-dispute'],
  'second-inheritance':   ['tax-applicable-or-not', 'spouse-reduction', 'small-residential-land'],
};

// ── 一般事業者シナリオ ────────────────────────────────────────────
// 軸: persona × business_stage × pain_point（personaは個人事業主全般を想定）
const GENERAL_PAINS = [
  'income-classification', 'incorporation-threshold', 'family-employment',
  'social-insurance-misconception', 'expense-grayzone', 'consumption-tax-judgement',
  'invoice-judgement', 'staff-employment',
];
const GENERAL_STAGES = ['pre-opening', 'just-opened', 'side-business', 'growth', 'hiring', 'incorporation'];
// 一般事業者は persona としては既存ペルソナを使い、cluster は業種横断のものを当てる
const GENERAL_PERSONAS_FOR_PAIN = {
  'income-classification':        ['influencer_creator', 'reseller_marketplace_seller'],
  'incorporation-threshold':      ['domestic_ec_seller', 'beauty_salon_owner', 'influencer_creator'],
  'family-employment':            ['domestic_ec_seller', 'beauty_salon_owner'],
  'social-insurance-misconception': ['reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner'],
  'expense-grayzone':             ['influencer_creator', 'beauty_salon_owner'],
  'consumption-tax-judgement':    ['domestic_ec_seller', 'beauty_salon_owner', 'reseller_marketplace_seller'],
  'invoice-judgement':            ['domestic_ec_seller', 'beauty_salon_owner', 'influencer_creator'],
  'staff-employment':             ['beauty_salon_owner', 'domestic_ec_seller'],
};

// ── 税目実務シナリオ ──────────────────────────────────────────────
// 軸: tax_domain × procedure_stage × pain_point
const TAX_DOMAIN_BASES = [
  { tax_domain: 'consumption_tax',     cluster: 'consumption-tax-basics', label: '消費税' },
  { tax_domain: 'income_tax',          cluster: 'income-tax-basics',      label: '所得税' },
  { tax_domain: 'withholding',         cluster: 'withholding',            label: '源泉徴収' },
  { tax_domain: 'bookkeeping_expenses',cluster: 'bookkeeping',            label: '帳簿・経費' },
];
const TAX_PROCEDURES = ['final-return', 'consumption-tax-judgement', 'invoice-registration', 'year-end-adjust', 'bookkeeping'];
const TAX_PAINS = ['consumption-tax-judgement', 'invoice-judgement', 'withholding-treatment', 'expense-grayzone'];

// ── 各 article_type へのタイトルテンプレート ───────────────────────
// 各 macro / persona に共通で使える汎用テンプレート
const TITLE_TPL = {
  basic_explainer: {
    retail:      '{platform}セラーが{stage}に押さえる{pain}の基本',
    influencer:  '{channel}運用で{stage}に押さえる{pain}の基本',
    salon:       '{salon_type}の{stage}に必要な{pain}の基本',
    inheritance: '{life_stage}に押さえる{pain}の基本',
    general:     '個人事業主の{stage}における{pain}の基本',
    tax_domain:  '{tax_label}の基本｜{procedure}で必要になる{pain}を整理',
  },
  comparison_decision: {
    retail:      '{platform}セラーが{stage}で{pain}を判断する基準',
    influencer:  '{channel}運用で{stage}に{pain}を判断する基準',
    salon:       '{salon_type}が{stage}で{pain}を判断する基準',
    inheritance: '{life_stage}に{pain}を判断する基準と進め方',
    general:     '個人事業主が{stage}で{pain}をどう判断するか',
    tax_domain:  '{tax_label}における{pain}の判断軸を整理',
  },
  filing_practice: {
    retail:      '{platform}セラーの{stage}における{pain}の実務手順',
    influencer:  '{channel}運用者が{stage}で{pain}を進める実務手順',
    salon:       '{salon_type}の{stage}における{pain}の実務手順',
    inheritance: '{life_stage}にやるべき{pain}の実務手順',
    general:     '個人事業主が{stage}で{pain}を進める実務手順',
    tax_domain:  '{tax_label}の{procedure}での{pain}の実務手順',
  },
  misconception_fix: {
    retail:      '{platform}セラーが誤解しやすい{pain}の正しい考え方',
    influencer:  '{channel}運用で誤解しやすい{pain}の正しい考え方',
    salon:       '{salon_type}で誤解しやすい{pain}の正しい考え方',
    inheritance: '{life_stage}でよくある{pain}の誤解と正しい考え方',
    general:     '個人事業主が誤解しやすい{pain}の正しい考え方',
    tax_domain:  '{tax_label}でよくある{pain}の誤解と正しい考え方',
  },
  edge_case: {
    retail:      '{platform}セラーが迷う{pain}のグレーゾーン判断',
    influencer:  '{channel}運用者が迷う{pain}のグレーゾーン判断',
    salon:       '{salon_type}が迷う{pain}のグレーゾーン判断',
    inheritance: '{life_stage}に{pain}で判断に迷うケースの整理',
    general:     '個人事業主が{pain}で判断に迷うケースの整理',
    tax_domain:  '{tax_label}における{pain}のグレーゾーン整理',
  },
  industry_example: {
    retail:      '{platform}セラー特有の{pain}の具体例',
    influencer:  '{channel}運用特有の{pain}の具体例',
    salon:       '{salon_type}特有の{pain}の具体例',
    inheritance: '{life_stage}の具体事例で見る{pain}',
    general:     '業種別に見る{pain}の具体例',
    tax_domain:  '{tax_label}の業種別具体例｜{pain}',
  },
  case_study: {
    retail:      '【想定事例】{platform}セラーが{pain}に直面したケース',
    influencer:  '【想定事例】{channel}運用者が{pain}に直面したケース',
    salon:       '【想定事例】{salon_type}オーナーが{pain}に直面したケース',
    inheritance: '【想定事例】{life_stage}に{pain}に直面したケース',
    general:     '【想定事例】個人事業主が{pain}に直面したケース',
    tax_domain:  '【想定事例】{tax_label}で{pain}に直面したケース',
  },
};

// ── 候補生成のコア関数 ────────────────────────────────────────────
// tax_domain → 既存 validate.js が受理する category へのマッピング
const TAX_DOMAIN_TO_CATEGORY = {
  consumption_tax:       '消費税',
  income_tax:            '所得税',
  invoice_system:        'インボイス',
  bookkeeping_expenses:  '帳簿・経費',
  inheritance_tax:       '相続',
  overseas_transactions: '海外取引',
  withholding:           '所得税',
};

function buildTopic({ macro, cluster, persona, tax_domain, subclusterParts,
                       slugParts, title, search_intent, reader_problem,
                       success_outcome, primary_question, hint,
                       article_type, article_role, pair_group,
                       business_stage, life_stage, pain_point,
                       procedure_stage, transaction_pattern, asset_type,
                       freshness_sensitive, priority, source_url, source_title }) {
  const subcluster = subclusterParts.filter(Boolean).map(kebab).join('-');
  const slug       = slugParts.filter(Boolean).map(kebab).join('-');
  return {
    macro,
    cluster,
    subcluster,
    persona,
    tax_domain,
    category: TAX_DOMAIN_TO_CATEGORY[tax_domain] || '所得税',
    business_stage,
    life_stage,
    pain_point,
    procedure_stage,
    transaction_pattern,
    asset_type,
    article_type,
    article_role,
    pair_group,
    quality: priority === 'high' ? 'high' : 'standard',
    priority: priority || 'medium',
    freshness_sensitive: !!freshness_sensitive,
    title,
    slug,
    source_url: source_url || '',
    source_title: source_title || '',
    hint: hint || '',
    search_intent,
    reader_problem,
    success_outcome,
    primary_question,
    _origin: 'scenario-expansion',
  };
}

function articleRoleFor(type) {
  return MAIN_ARTICLE_TYPES.includes(type) ? 'main' : 'support';
}

// ── 物販の展開 ────────────────────────────────────────────────────
function expandRetail() {
  const out = [];
  for (const platform of RETAIL_PLATFORMS) {
    const pains = platform.overseas ? RETAIL_PAINS_OVERSEAS : RETAIL_PAINS;
    for (const stageId of RETAIL_STAGES) {
      const stage = lookup(BUSINESS_STAGES, stageId); if (!stage) continue;
      for (const painId of pains) {
        const pain = lookup(PAIN_POINTS, painId); if (!pain) continue;
        if (!pain.macros.includes('物販')) continue;

        // 1 シナリオから 2 candidates（main + support）を作る
        const slugPrefix = `${platform.cluster}-${kebab(stageId)}-${kebab(painId)}`;
        const mainType = deterministicTypeIndex(slugPrefix + '-m', ['basic_explainer', 'comparison_decision']);
        const supType  = deterministicTypeIndex(slugPrefix + '-s', ['filing_practice', 'misconception_fix', 'edge_case', 'industry_example']);
        const pg = pairKey({ cluster: platform.cluster }, `${stage.id}-${pain.id}`);

        const baseVars = { platform: platform.label, stage: stage.label, pain: pain.label };
        out.push(buildTopic({
          macro: '物販', cluster: platform.cluster, persona: platform.persona, tax_domain: 'consumption_tax',
          subclusterParts: [stage.id, pain.id],
          slugParts: [platform.cluster, stage.id, pain.id, 'guide'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: mainType, article_role: articleRoleFor(mainType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[mainType].retail, baseVars),
          search_intent: `${platform.label}で${stage.label}にいる事業者が${pain.label}を理解したい`,
          reader_problem: pain.label,
          success_outcome: `${pain.label}を整理し、自分のケースで判断できる`,
          primary_question: `${platform.label}セラーが${stage.label}で${pain.label}にどう向き合うべきか？`,
          hint: `${platform.label} の ${pain.label} を ${stage.label} 視点で整理`,
        }));
        out.push(buildTopic({
          macro: '物販', cluster: platform.cluster, persona: platform.persona, tax_domain: 'consumption_tax',
          subclusterParts: [stage.id, pain.id, 'support'],
          slugParts: [platform.cluster, stage.id, pain.id, 'practice'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: supType, article_role: articleRoleFor(supType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[supType].retail, baseVars),
          search_intent: `${platform.label}セラーが${pain.label}の実務でつまずく場面を解消したい`,
          reader_problem: `${pain.label} の実務処理が不安`,
          success_outcome: `${pain.label}を実務上どう処理するか具体的に分かる`,
          primary_question: `${pain.label}を実務でどう処理するか？`,
          hint: `${platform.label} で ${pain.label} に遭遇したときの実務対応`,
        }));
      }
    }
  }
  return out;
}

// ── インフルエンサーの展開 ────────────────────────────────────────
function expandInfluencer() {
  const out = [];
  for (const ch of INFLUENCER_CHANNELS) {
    for (const stageId of INFLUENCER_STAGES) {
      const stage = lookup(BUSINESS_STAGES, stageId); if (!stage) continue;
      for (const painId of INFLUENCER_PAINS) {
        const pain = lookup(PAIN_POINTS, painId); if (!pain) continue;
        if (!pain.macros.includes('インフルエンサー')) continue;

        const slugPrefix = `${ch.cluster}-${kebab(stageId)}-${kebab(painId)}`;
        const mainType = deterministicTypeIndex(slugPrefix + '-m', ['basic_explainer', 'comparison_decision']);
        const supType  = deterministicTypeIndex(slugPrefix + '-s', ['filing_practice', 'misconception_fix', 'edge_case', 'industry_example']);
        const pg = pairKey({ cluster: ch.cluster }, `${stage.id}-${pain.id}`);
        const baseVars = { channel: ch.label, stage: stage.label, pain: pain.label };

        out.push(buildTopic({
          macro: 'インフルエンサー', cluster: ch.cluster, persona: ch.persona, tax_domain: 'income_tax',
          subclusterParts: [stage.id, pain.id],
          slugParts: [ch.cluster, stage.id, pain.id, 'guide'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: mainType, article_role: articleRoleFor(mainType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[mainType].influencer, baseVars),
          search_intent: `${ch.label}運用で${stage.label}にいるクリエイターが${pain.label}を理解したい`,
          reader_problem: pain.label,
          success_outcome: `${pain.label}を自分のケースで判断できる`,
          primary_question: `${ch.label}運用者は${stage.label}で${pain.label}にどう向き合うか？`,
          hint: `${ch.label} の ${pain.label} を ${stage.label} 視点で整理`,
        }));
        out.push(buildTopic({
          macro: 'インフルエンサー', cluster: ch.cluster, persona: ch.persona, tax_domain: 'income_tax',
          subclusterParts: [stage.id, pain.id, 'support'],
          slugParts: [ch.cluster, stage.id, pain.id, 'practice'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: supType, article_role: articleRoleFor(supType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[supType].influencer, baseVars),
          search_intent: `${ch.label}運用者が${pain.label}の実務でつまずく場面を解消したい`,
          reader_problem: `${pain.label} の実務処理が不安`,
          success_outcome: `${pain.label}を実務上どう処理するか具体的に分かる`,
          primary_question: `${pain.label}を実務でどう処理するか？`,
          hint: `${ch.label} で ${pain.label} に遭遇したときの実務対応`,
        }));
      }
    }
  }
  return out;
}

// ── サロンの展開 ──────────────────────────────────────────────────
function expandSalon() {
  const out = [];
  for (const sa of SALON_TYPES) {
    for (const stageId of SALON_STAGES) {
      const stage = lookup(BUSINESS_STAGES, stageId); if (!stage) continue;
      for (const painId of SALON_PAINS) {
        const pain = lookup(PAIN_POINTS, painId); if (!pain) continue;
        if (!pain.macros.includes('サロン')) continue;

        const slugPrefix = `${sa.cluster}-${kebab(stageId)}-${kebab(painId)}`;
        const mainType = deterministicTypeIndex(slugPrefix + '-m', ['basic_explainer', 'comparison_decision']);
        const supType  = deterministicTypeIndex(slugPrefix + '-s', ['filing_practice', 'misconception_fix', 'edge_case', 'industry_example']);
        const pg = pairKey({ cluster: sa.cluster }, `${stage.id}-${pain.id}`);
        const baseVars = { salon_type: sa.label, stage: stage.label, pain: pain.label };

        out.push(buildTopic({
          macro: 'サロン', cluster: sa.cluster, persona: sa.persona, tax_domain: 'income_tax',
          subclusterParts: [stage.id, pain.id],
          slugParts: [sa.cluster, stage.id, pain.id, 'guide'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: mainType, article_role: articleRoleFor(mainType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[mainType].salon, baseVars),
          search_intent: `${sa.label}オーナーが${stage.label}にいるときの${pain.label}を整理したい`,
          reader_problem: pain.label,
          success_outcome: `${pain.label}を自分のサロンで判断できる`,
          primary_question: `${sa.label}オーナーは${stage.label}で${pain.label}にどう向き合うか？`,
          hint: `${sa.label} の ${pain.label} を ${stage.label} 視点で整理`,
        }));
        out.push(buildTopic({
          macro: 'サロン', cluster: sa.cluster, persona: sa.persona, tax_domain: 'income_tax',
          subclusterParts: [stage.id, pain.id, 'support'],
          slugParts: [sa.cluster, stage.id, pain.id, 'practice'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: supType, article_role: articleRoleFor(supType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[supType].salon, baseVars),
          search_intent: `${sa.label}が${pain.label}の実務でつまずく場面を解消したい`,
          reader_problem: `${pain.label} の実務処理が不安`,
          success_outcome: `${pain.label}を実務上どう処理するか具体的に分かる`,
          primary_question: `${pain.label}を実務でどう処理するか？`,
          hint: `${sa.label} で ${pain.label} に遭遇したときの実務対応`,
        }));
      }
    }
  }
  return out;
}

// ── 相続贈与の展開 ────────────────────────────────────────────────
function expandInheritance() {
  const out = [];
  for (const stageId of INHERITANCE_STAGES) {
    const stage = lookup(LIFE_STAGES, stageId); if (!stage) continue;
    const pains = INHERITANCE_STAGE_PAIN_MATRIX[stageId] || [];
    for (const painId of pains) {
      const pain = lookup(PAIN_POINTS, painId); if (!pain) continue;
      const slugPrefix = `inheritance-${kebab(stageId)}-${kebab(painId)}`;
      const mainType = deterministicTypeIndex(slugPrefix + '-m', ['basic_explainer', 'comparison_decision']);
      const supType  = deterministicTypeIndex(slugPrefix + '-s', ['filing_practice', 'misconception_fix', 'edge_case', 'case_study']);
      const pg = pairKey({ cluster: 'inheritance' }, `${stage.id}-${pain.id}`);
      const baseVars = { life_stage: stage.label, pain: pain.label };

      out.push(buildTopic({
        macro: '相続贈与', cluster: 'inheritance', persona: 'inheritance_client', tax_domain: 'inheritance_tax',
        subclusterParts: [stage.id, pain.id],
        slugParts: ['inheritance', stage.id, pain.id, 'guide'],
        life_stage: stage.id, pain_point: pain.id,
        article_type: mainType, article_role: articleRoleFor(mainType), pair_group: pg,
        priority: 'high',
        title: fillTemplate(TITLE_TPL[mainType].inheritance, baseVars),
        search_intent: `相続の${stage.label}にあって${pain.label}に向き合う方が、判断軸を理解したい`,
        reader_problem: pain.label,
        success_outcome: `${stage.label}に${pain.label}をどう進めるか判断できる`,
        primary_question: `${stage.label}に${pain.label}にどう向き合うべきか？`,
        hint: `相続 ${stage.label} における ${pain.label} の整理`,
      }));
      out.push(buildTopic({
        macro: '相続贈与', cluster: 'inheritance', persona: 'inheritance_client', tax_domain: 'inheritance_tax',
        subclusterParts: [stage.id, pain.id, 'support'],
        slugParts: ['inheritance', stage.id, pain.id, 'practice'],
        life_stage: stage.id, pain_point: pain.id,
        article_type: supType, article_role: articleRoleFor(supType), pair_group: pg,
        priority: 'high',
        title: fillTemplate(TITLE_TPL[supType].inheritance, baseVars),
        search_intent: `相続${stage.label}に${pain.label}で実務に詰まる場面を解消したい`,
        reader_problem: `${pain.label} の進め方が分からない`,
        success_outcome: `${pain.label}の具体的な進め方を理解できる`,
        primary_question: `${stage.label}に${pain.label}を実務でどう進めるか？`,
        hint: `相続 ${stage.label} の ${pain.label} の手順`,
      }));
    }
  }
  return out;
}

// ── 一般事業者の展開 ──────────────────────────────────────────────
function expandGeneral() {
  const out = [];
  for (const painId of GENERAL_PAINS) {
    const pain = lookup(PAIN_POINTS, painId); if (!pain) continue;
    const personas = GENERAL_PERSONAS_FOR_PAIN[painId] || [];
    for (const persona of personas) {
      for (const stageId of GENERAL_STAGES) {
        const stage = lookup(BUSINESS_STAGES, stageId); if (!stage) continue;
        const slugPrefix = `general-${kebab(painId)}-${kebab(persona)}-${kebab(stageId)}`;
        const mainType = deterministicTypeIndex(slugPrefix + '-m', ['basic_explainer', 'comparison_decision']);
        const supType  = deterministicTypeIndex(slugPrefix + '-s', ['filing_practice', 'misconception_fix', 'edge_case']);
        const pg = pairKey({ cluster: 'general-business' }, `${stage.id}-${pain.id}-${persona}`);
        const baseVars = { stage: stage.label, pain: pain.label };

        out.push(buildTopic({
          macro: '一般事業者', cluster: 'general-business', persona, tax_domain: 'income_tax',
          subclusterParts: [pain.id, stage.id, persona],
          slugParts: ['general', pain.id, persona.replace(/_/g, '-'), stage.id, 'guide'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: mainType, article_role: articleRoleFor(mainType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[mainType].general, baseVars),
          search_intent: `${stage.label}にいる個人事業主が${pain.label}を理解したい`,
          reader_problem: pain.label,
          success_outcome: `${pain.label}を自分のケースで判断できる`,
          primary_question: `${stage.label}の個人事業主は${pain.label}にどう向き合うか？`,
          hint: `${stage.label} における ${pain.label} の判断軸`,
        }));
        out.push(buildTopic({
          macro: '一般事業者', cluster: 'general-business', persona, tax_domain: 'income_tax',
          subclusterParts: [pain.id, stage.id, persona, 'support'],
          slugParts: ['general', pain.id, persona.replace(/_/g, '-'), stage.id, 'practice'],
          business_stage: stage.id, pain_point: pain.id,
          article_type: supType, article_role: articleRoleFor(supType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[supType].general, baseVars),
          search_intent: `${stage.label}の個人事業主が${pain.label}の実務でつまずく場面を解消したい`,
          reader_problem: `${pain.label} の実務処理が不安`,
          success_outcome: `${pain.label}を実務上どう処理するか具体的に分かる`,
          primary_question: `${pain.label}を実務でどう処理するか？`,
          hint: `${stage.label} で ${pain.label} に遭遇したときの実務対応`,
        }));
      }
    }
  }
  return out;
}

// ── 税目実務の展開 ────────────────────────────────────────────────
function expandTaxDomain() {
  const out = [];
  for (const td of TAX_DOMAIN_BASES) {
    for (const procId of TAX_PROCEDURES) {
      const proc = lookup(PROCEDURE_STAGES, procId); if (!proc) continue;
      for (const painId of TAX_PAINS) {
        const pain = lookup(PAIN_POINTS, painId); if (!pain) continue;
        if (!pain.macros.includes('税目実務')) continue;
        const slugPrefix = `tax-${kebab(td.tax_domain)}-${kebab(procId)}-${kebab(painId)}`;
        const mainType = deterministicTypeIndex(slugPrefix + '-m', ['basic_explainer', 'comparison_decision']);
        const supType  = deterministicTypeIndex(slugPrefix + '-s', ['filing_practice', 'misconception_fix', 'edge_case']);
        const pg = pairKey({ cluster: td.cluster }, `${proc.id}-${pain.id}`);
        const baseVars = { tax_label: td.label, procedure: proc.label, pain: pain.label };

        out.push(buildTopic({
          macro: '税目実務', cluster: td.cluster,
          persona: painId === 'withholding-treatment' ? 'beauty_salon_owner' : 'domestic_ec_seller',
          tax_domain: td.tax_domain,
          subclusterParts: [proc.id, pain.id],
          slugParts: ['tax', td.tax_domain, proc.id, pain.id, 'guide'],
          procedure_stage: proc.id, pain_point: pain.id,
          article_type: mainType, article_role: articleRoleFor(mainType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[mainType].tax_domain, baseVars),
          search_intent: `${td.label}の${proc.label}で${pain.label}に向き合いたい`,
          reader_problem: pain.label,
          success_outcome: `${td.label}の${proc.label}での${pain.label}の判断軸を理解できる`,
          primary_question: `${td.label}における${pain.label}は${proc.label}でどう扱うべきか？`,
          hint: `${td.label} × ${proc.label} × ${pain.label} の整理`,
        }));
        out.push(buildTopic({
          macro: '税目実務', cluster: td.cluster,
          persona: painId === 'withholding-treatment' ? 'beauty_salon_owner' : 'domestic_ec_seller',
          tax_domain: td.tax_domain,
          subclusterParts: [proc.id, pain.id, 'support'],
          slugParts: ['tax', td.tax_domain, proc.id, pain.id, 'practice'],
          procedure_stage: proc.id, pain_point: pain.id,
          article_type: supType, article_role: articleRoleFor(supType), pair_group: pg,
          title: fillTemplate(TITLE_TPL[supType].tax_domain, baseVars),
          search_intent: `${td.label}の${proc.label}に関する${pain.label}の実務でつまずく場面を解消したい`,
          reader_problem: `${pain.label} の処理に自信がない`,
          success_outcome: `${pain.label}を実務上どう処理するか具体的に分かる`,
          primary_question: `${pain.label}を${proc.label}で実務上どう扱うか？`,
          hint: `${td.label} の ${proc.label} で ${pain.label} に遭遇したときの対応`,
        }));
      }
    }
  }
  return out;
}

// ── 全展開 ────────────────────────────────────────────────────────
function expandAll() {
  return [
    ...expandRetail(),
    ...expandInfluencer(),
    ...expandSalon(),
    ...expandInheritance(),
    ...expandGeneral(),
    ...expandTaxDomain(),
  ];
}

module.exports = {
  expandAll,
  expandRetail,
  expandInfluencer,
  expandSalon,
  expandInheritance,
  expandGeneral,
  expandTaxDomain,
  kebab,
};
