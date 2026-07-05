'use strict';

/**
 * 大分類 / cluster / subcluster の定義
 *
 * 大分類（macro）:
 *   - 物販
 *   - インフルエンサー
 *   - サロン
 *   - 相続贈与
 *   - 一般事業者
 *   - 税目実務
 *
 * cluster / subcluster はテーマ選定時の偏り判定・cooldown 判定に使う。
 * topic-pool.js の各 topic は cluster / subcluster を明示する。
 * 未指定の場合は persona / category / slug から自動推定する（fallback）。
 */

const MACRO = {
  RETAIL:      '物販',
  INFLUENCER:  'インフルエンサー',
  SALON:       'サロン',
  INHERITANCE: '相続贈与',
  GENERAL:     '一般事業者',
  TAX_DOMAIN:  '税目実務',
  // Phase 4 で追加した新カテゴリ
  YOUTUBE:      'YouTube',
  CONTENT:      'コンテンツ販売',
  CONSTRUCTION: '建設',
  RETAIL_STORE: '小売',
  WHOLESALE:    '卸売',
};

// ペルソナ → 大分類のデフォルト紐付け（未指定時のfallback）
const PERSONA_TO_MACRO = {
  ebay_export_seller:          MACRO.RETAIL,
  domestic_ec_seller:          MACRO.RETAIL,
  reseller_marketplace_seller: MACRO.RETAIL,
  influencer_creator:          MACRO.INFLUENCER,
  beauty_salon_owner:          MACRO.SALON,
  inheritance_client:          MACRO.INHERITANCE,
  youtuber:                    MACRO.YOUTUBE,
  content_seller:              MACRO.CONTENT,
  construction_solo:           MACRO.CONSTRUCTION,
  retail_store:                MACRO.RETAIL_STORE,
  wholesale:                   MACRO.WHOLESALE,
};

// slug プレフィックスで cluster を推定（cluster未指定時のfallback）
const SLUG_TO_CLUSTER = [
  // 物販系プラットフォーム
  { match: /^ebay-/,                           cluster: 'ebay',          macro: MACRO.RETAIL },
  { match: /^amazon-/,                         cluster: 'amazon',        macro: MACRO.RETAIL },
  { match: /^yahoo-shopping-/,                 cluster: 'yahoo-shopping',macro: MACRO.RETAIL },
  { match: /^yahoo-flea-|^yahoo-fleamarket-/,  cluster: 'yahoo-flea',    macro: MACRO.RETAIL },
  { match: /^yahoo-auction-|^yahoo-auctions-/, cluster: 'yahoo-auction', macro: MACRO.RETAIL },
  { match: /^mercari-/,                        cluster: 'mercari',       macro: MACRO.RETAIL },
  { match: /^shopify-/,                        cluster: 'shopify',       macro: MACRO.RETAIL },
  { match: /^reseller-|^side-job-resell|^reselling-/, cluster: 'reseller-general', macro: MACRO.RETAIL },
  { match: /^flea-market-/,                    cluster: 'flea-general',  macro: MACRO.RETAIL },
  { match: /^ec-/,                             cluster: 'ec-general',    macro: MACRO.RETAIL },

  // インフルエンサー系プラットフォーム
  { match: /^instagram-/,                      cluster: 'instagram',     macro: MACRO.INFLUENCER },
  { match: /^tiktok-/,                         cluster: 'tiktok',        macro: MACRO.INFLUENCER },
  { match: /^youtube-|^youtuber-|^side-youtuber-/, cluster: 'youtube',   macro: MACRO.INFLUENCER },
  { match: /^influencer-/,                     cluster: 'influencer-general', macro: MACRO.INFLUENCER },
  { match: /^creator-/,                        cluster: 'creator-general',    macro: MACRO.INFLUENCER },
  { match: /^affiliate-|^pr-/,                 cluster: 'affiliate-pr',  macro: MACRO.INFLUENCER },

  // サロン系業種
  { match: /^beauty-salon-|^hair-salon-/,      cluster: 'hair-salon',    macro: MACRO.SALON },
  { match: /^nail-salon-/,                     cluster: 'nail-salon',    macro: MACRO.SALON },
  { match: /^eyelash-|^matsueku-/,             cluster: 'eyelash',       macro: MACRO.SALON },
  { match: /^hair-removal-|^datsumou-/,        cluster: 'hair-removal',  macro: MACRO.SALON },
  { match: /^esthetic-|^este-/,                cluster: 'esthetic',      macro: MACRO.SALON },

  // 相続贈与
  { match: /^inheritance-/,                    cluster: 'inheritance',   macro: MACRO.INHERITANCE },
  { match: /^gift-|^lifetime-gift-|^housing-fund-gift-|^small-residential-/, cluster: 'gift', macro: MACRO.INHERITANCE },

  // 税目実務
  { match: /^kaigyou-|^opening-notification-|^blue-return-/, cluster: 'opening-notification', macro: MACRO.TAX_DOMAIN },
  { match: /^withholding-/,                    cluster: 'withholding',   macro: MACRO.TAX_DOMAIN },
  { match: /^bookkeeping-/,                    cluster: 'bookkeeping',   macro: MACRO.TAX_DOMAIN },
  { match: /^tax-bookkeeping-/,                cluster: 'bookkeeping',   macro: MACRO.TAX_DOMAIN },
  { match: /^tax-consumption-tax-/,            cluster: 'consumption-tax-basics', macro: MACRO.TAX_DOMAIN },
  { match: /^tax-withholding-/,                cluster: 'withholding',   macro: MACRO.TAX_DOMAIN },

  // 一般事業者
  { match: /^general-business-incorporation/,  cluster: 'incorporation',    macro: MACRO.GENERAL },
  { match: /^general-side-income-/,            cluster: 'income-classification', macro: MACRO.GENERAL },
  { match: /^general-sole-proprietor-/,        cluster: 'social-insurance', macro: MACRO.GENERAL },
  { match: /^general-family-employment-/,      cluster: 'family-employment', macro: MACRO.GENERAL },
];

// カテゴリ → tax_domain のデフォルト紐付け
const CATEGORY_TO_TAX_DOMAIN = {
  '消費税':       'consumption_tax',
  '所得税':       'income_tax',
  'インボイス':   'invoice_system',
  '帳簿・経費':   'bookkeeping_expenses',
  '相続':         'inheritance_tax',
  '海外取引':     'overseas_transactions',
};

/**
 * トピック（または記事 frontmatter）から cluster 情報を解決する。
 * 明示指定があればそれを優先、なければ persona / slug から推定する。
 */
function resolveCluster(topic) {
  // 1. 明示指定が最優先
  if (topic.cluster && topic.macro) {
    return { macro: topic.macro, cluster: topic.cluster, subcluster: topic.subcluster || topic.cluster };
  }
  if (topic.cluster) {
    const macro = topic.macro || PERSONA_TO_MACRO[topic.persona || topic.primary_persona] || MACRO.GENERAL;
    return { macro, cluster: topic.cluster, subcluster: topic.subcluster || topic.cluster };
  }

  // 2. slug プレフィックスから推定
  const slug = String(topic.slug || '').toLowerCase();
  for (const rule of SLUG_TO_CLUSTER) {
    if (rule.match.test(slug)) {
      return {
        macro: rule.macro,
        cluster: rule.cluster,
        subcluster: topic.subcluster || rule.cluster,
      };
    }
  }

  // 3. persona から推定
  const persona = topic.persona || topic.primary_persona || '';
  const macroFromPersona = PERSONA_TO_MACRO[persona];
  if (macroFromPersona) {
    return {
      macro: macroFromPersona,
      cluster: persona,
      subcluster: topic.subcluster || persona,
    };
  }

  // 4. デフォルト
  return { macro: MACRO.GENERAL, cluster: 'unknown', subcluster: 'unknown' };
}

function resolveTaxDomain(topic) {
  if (topic.tax_domain) return topic.tax_domain;
  return CATEGORY_TO_TAX_DOMAIN[topic.category] || 'general';
}

const ALL_MACROS = Object.values(MACRO);

module.exports = {
  MACRO,
  ALL_MACROS,
  PERSONA_TO_MACRO,
  CATEGORY_TO_TAX_DOMAIN,
  resolveCluster,
  resolveTaxDomain,
};
