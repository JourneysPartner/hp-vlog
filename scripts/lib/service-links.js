'use strict';

/**
 * 記事 → サービス専用ページの対応（2026-09-03 段階3 R4）
 *
 * 記事の末尾に「このサービスについて相談する」を出すための対応表。
 * 記事本文は変更しない（ビルド時にテンプレートの外へ付ける）。
 *
 * 引く順:
 *   1. 語の最優先: 題名か検索意図に「税務調査」→ tax-audit、「法人化」「法人成り」→ startup
 *   2. primary_persona
 *   3. tax_domain
 *   4. category
 *   5. どれにも当たらなければ tax-return
 */

const SERVICE_PAGES = {
  'ebay-export':   { name: 'eBay輸出・越境ECの税務と消費税還付', short: 'eBay輸出・越境ECの税務',
    description: 'eBay輸出の消費税還付・輸出免税・外貨取引・Payoneerの経理まで、輸出セラー特有の税務をまとめて任せられます。', icon: 'bi-globe-americas' },
  'online-seller': { name: 'ネット販売・せどり・フリマの税務を丸ごと任せる', short: 'ネット販売・副業の税務',
    description: 'Amazon・メルカリ・ヤフオク・BASEなどのネット販売、せどり・転売の記帳から確定申告、インボイス対応まで。', icon: 'bi-bag-check' },
  'bookkeeping':   { name: '記帳代行（クラウド会計対応）', short: '記帳代行',
    description: '領収書・請求書の整理から仕訳、月次試算表まで。freee・マネーフォワード・弥生に対応。', icon: 'bi-journal-text' },
  'tax-return':    { name: '決算・確定申告（個人・法人）', short: '決算・確定申告',
    description: '個人の確定申告（青色・白色）、法人の決算・法人税申告、消費税申告まで。電子申告で対応。', icon: 'bi-file-earmark-bar-graph' },
  'inheritance':   { name: '相続税申告と生前の対策', short: '相続税申告・生前対策',
    description: '相続税の申告、財産の評価、遺産分割の税務、生前贈与や相続時精算課税の対策まで。', icon: 'bi-house-heart' },
  'tax-audit':     { name: '税務調査の対応（事前準備から立会い・事後対応まで）', short: '税務調査対応',
    description: '税務調査の通知が来たら。事前準備・当日の立会い・修正申告や更正の請求まで一貫して対応。', icon: 'bi-shield-check' },
  'startup':       { name: '創業と法人化のサポート', short: '創業・法人化',
    description: '開業届・法人設立・創業融資・事業計画から、法人化の損益分岐の試算まで。', icon: 'bi-graph-up-arrow' },
};

const BY_PERSONA = {
  ebay_export_seller: 'ebay-export',
  domestic_ec_seller: 'online-seller',
  reseller_marketplace_seller: 'online-seller',
  inheritance_client: 'inheritance',
  construction_solo: 'tax-return',
  beauty_salon_owner: 'bookkeeping',
  influencer_creator: 'tax-return',
  youtuber: 'tax-return',
  content_seller: 'online-seller',
  retail_store: 'bookkeeping',
  wholesale: 'bookkeeping',
  general_individual_proprietor: 'tax-return',
};

const BY_TAX_DOMAIN = {
  inheritance_tax: 'inheritance',
  overseas_transactions: 'ebay-export',
  bookkeeping_expenses: 'bookkeeping',
  consumption_tax: 'tax-return',
  income_tax: 'tax-return',
  invoice_system: 'tax-return',
  corporate_tax: 'tax-return',
  withholding: 'tax-return',
};

const BY_CATEGORY = {
  '所得税': 'tax-return',
  '消費税': 'tax-return',
  '帳簿・経費': 'bookkeeping',
  '相続': 'inheritance',
  'インボイス': 'tax-return',
  '海外取引': 'ebay-export',
  '法人税': 'tax-return',
};

const DEFAULT_SERVICE = 'tax-return';

function serviceSlugForPost(post = {}) {
  const strong = `${post.title || ''} ${post.search_intent || ''}`;
  if (/税務調査/.test(strong)) return 'tax-audit';
  if (/法人化|法人成り/.test(strong)) return 'startup';
  const persona = post.primary_persona || post.persona || '';
  if (BY_PERSONA[persona]) return BY_PERSONA[persona];
  if (BY_TAX_DOMAIN[post.tax_domain]) return BY_TAX_DOMAIN[post.tax_domain];
  if (BY_CATEGORY[post.category]) return BY_CATEGORY[post.category];
  return DEFAULT_SERVICE;
}

function serviceForPost(post = {}) {
  const slug = serviceSlugForPost(post);
  return { slug, url: `/services/${slug}/`, ...SERVICE_PAGES[slug] };
}

function serviceInfo(slug) {
  const s = SERVICE_PAGES[slug];
  return s ? { slug, url: `/services/${slug}/`, ...s } : null;
}

module.exports = Object.freeze({
  SERVICE_PAGES, BY_PERSONA, BY_TAX_DOMAIN, BY_CATEGORY, DEFAULT_SERVICE,
  serviceSlugForPost, serviceForPost, serviceInfo,
});
