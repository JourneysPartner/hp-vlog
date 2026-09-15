'use strict';

/**
 * シナリオ展開で使う「軸」の定義。
 *
 * 各軸は { id, label, order? } の配列。
 * id は slug 用（kebab-case）、label は title / 検索意図 用（日本語）。
 *
 * 重要: ここに定義された軸の組み合わせから daily-draft 候補が動的に生成される。
 * 既存記事の重複判定にも、これらの軸を比較して使う。
 */

// ── 事業ステージ（物販 / インフルエンサー / サロン / 一般事業者）
const BUSINESS_STAGES = [
  { id: 'pre-opening',       label: '開業前',         order: 1 },
  { id: 'just-opened',       label: '開業直後',       order: 2 },
  { id: 'side-business',     label: '副業期',         order: 3 },
  { id: 'growth',            label: '売上拡大期',     order: 4 },
  { id: 'hiring',            label: 'スタッフ雇用期', order: 5 },
  { id: 'incorporation',     label: '法人成り検討期', order: 6 },
];

// ── 人生イベントステージ（相続贈与）
const LIFE_STAGES = [
  { id: 'pre-planning',         label: '生前準備期',                   order: 1 },
  { id: 'cognitive-decline',    label: '判断能力の低下が気になる時期', order: 2 },
  { id: 'critical-immediate',   label: '危篤・逝去直後',             order: 3 },
  { id: 'within-7days',         label: '7日以内（葬儀直後）',        order: 4 },
  { id: 'within-4months',       label: '4ヶ月以内（準確定申告期限）', order: 5 },
  { id: 'within-10months',      label: '10ヶ月以内（相続税申告期限）', order: 6 },
  { id: 'after-filing',         label: '申告後',                       order: 7 },
  { id: 'second-inheritance',   label: '二次相続検討期',               order: 8 },
  { id: 'multi-year-review',    label: '数年後の見直し期',             order: 9 },
];

// ── 相続人の立場（heir_role）— 相続記事内の差別化に使う
// 注: primary_persona は validate.js 互換で 'inheritance_client' を維持。
//     heir_role は記事ごとの細分化（タイトル / 検索意図向け）に使う。
const HEIR_ROLES = [
  { id: 'spouse',             label: '配偶者' },
  { id: 'child',              label: '子ども' },
  { id: 'one-of-heirs',       label: '相続人の一人' },
  { id: 'sole-heir',          label: '相続人が少ない方' },
  { id: 'sibling',            label: '兄弟相続の家族' },
  { id: 'remarried-family',   label: '再婚家庭' },
  { id: 'no-child-couple',    label: '子どもがいない夫婦' },
  { id: 'business-owner-family', label: '会社オーナー家族' },
  { id: 'sole-proprietor-family', label: '個人事業主の遺族' },
  { id: 'real-estate-heir',   label: '不動産を相続する家族' },
];

// ── 取引パターン
const TRANSACTION_PATTERNS = [
  { id: 'single-sale',        label: '単発売上' },
  { id: 'subscription',       label: '継続課金' },
  { id: 'overseas-sale',      label: '海外売上' },
  { id: 'return-refund',      label: '返品・返金' },
  { id: 'cancel',             label: 'キャンセル' },
  { id: 'outsourcing',        label: '外注利用' },
  { id: 'pr-deal',            label: 'PR・タイアップ案件' },
  { id: 'affiliate',          label: 'アフィリエイト' },
  { id: 'tipping-gift',       label: '投げ銭・ギフト' },
  { id: 'product-sales',      label: '物販売上' },
  { id: 'service-sales',      label: '役務売上（施術）' },
  { id: 'prepaid-ticket',     label: '回数券・前受金' },
  { id: 'platform-payout',    label: 'プラットフォーム入金' },
];

// ── 手続きステージ
const PROCEDURE_STAGES = [
  { id: 'opening-notification', label: '開業届' },
  { id: 'blue-return-application', label: '青色申告承認申請' },
  { id: 'bookkeeping',          label: '帳簿付け' },
  { id: 'invoice-registration', label: 'インボイス登録' },
  { id: 'consumption-tax-judgement', label: '消費税課税事業者判定' },
  { id: 'year-end-adjust',      label: '年末調整' },
  { id: 'final-return',         label: '確定申告' },
  { id: 'quasi-final-return',   label: '準確定申告' },
  { id: 'inheritance-filing',   label: '相続税申告' },
  { id: 'estate-division',      label: '遺産分割協議' },
  { id: 'real-estate-registration', label: '相続登記' },
  { id: 'tax-audit-prep',       label: '税務調査対応' },
  { id: 'amendment-return',     label: '修正申告・更正の請求' },
  { id: 'initial-immediate',    label: '初動（最初の手続き）' },
  { id: 'bank-procedure',       label: '銀行口座の解約・凍結解除' },
  // 相続実務向けに追加
  { id: 'document-collection',  label: '戸籍・残高証明・評価資料の収集' },
  { id: 'valuation-check',      label: '財産評価' },
  { id: 'second-inheritance-review', label: '二次相続の見直し' },
];

// ── 痛点（pain point）— 業種横断で使える
const PAIN_POINTS = [
  // 物販
  { id: 'overseas-tax-uncertain',    label: '海外取引の消費税扱いが分からない',     macros: ['物販'] },
  { id: 'platform-fee-treatment',    label: 'プラットフォーム手数料の処理',         macros: ['物販', 'インフルエンサー'] },
  { id: 'return-refund-entry',       label: '返品・返金の仕訳が分からない',         macros: ['物販', 'サロン'] },
  { id: 'inventory-balance',         label: '在庫管理・棚卸の処理',                 macros: ['物販'] },
  { id: 'tax-refund-eligibility',    label: '消費税還付が受けられるか',             macros: ['物販'] },
  // インフルエンサー
  { id: 'income-classification',     label: '事業所得か雑所得か判断できない',       macros: ['インフルエンサー', '一般事業者'] },
  { id: 'expense-grayzone',          label: '経費のグレーゾーン判断',               macros: ['インフルエンサー', 'サロン', '物販', '一般事業者'] },
  { id: 'recognition-timing',        label: '売上認識のタイミング',                 macros: ['インフルエンサー', 'サロン'] },
  { id: 'withholding-treatment',     label: '源泉徴収の処理',                       macros: ['インフルエンサー', 'サロン', '税目実務'] },
  // サロン
  { id: 'prepayment-recognition',    label: '前受金（回数券）の売上計上',           macros: ['サロン'] },
  { id: 'staff-employment',          label: 'スタッフ雇用と源泉・社保',             macros: ['サロン', '一般事業者'] },
  { id: 'cash-management',           label: '現金売上の管理',                       macros: ['サロン'] },
  // 相続
  { id: 'what-first',                label: '何から始めればよいか',                 macros: ['相続贈与'] },
  { id: 'tax-applicable-or-not',     label: '相続税がかかるか分からない',           macros: ['相続贈与'] },
  { id: 'spouse-reduction',          label: '配偶者の税額軽減の使い方',             macros: ['相続贈与'] },
  { id: 'small-residential-land',    label: '小規模宅地等の特例の適用可否',         macros: ['相続贈与'] },
  { id: 'real-estate-valuation',     label: '不動産評価',                           macros: ['相続贈与'] },
  { id: 'deadline-pressure',         label: '申告期限に間に合うか',                 macros: ['相続贈与'] },
  { id: 'family-dispute',            label: '家族間で揉めそう',                     macros: ['相続贈与'] },
  { id: 'bank-frozen',               label: '銀行口座の凍結対応',                   macros: ['相続贈与'] },
  { id: 'business-succession',       label: '事業承継の進め方',                     macros: ['相続贈与', '一般事業者'] },
  // 相続系（追加）
  { id: 'name-deposits-concern',     label: '名義預金とみなされる不安',             macros: ['相続贈与'] },
  { id: 'lifetime-gift-addback',     label: '生前贈与が相続税に戻るか不安',         macros: ['相続贈与'] },
  { id: 'life-insurance-exemption',  label: '生命保険金の非課税枠の使い方',         macros: ['相続贈与'] },
  { id: 'funeral-debt-deduction',    label: '借入金・葬式費用の控除',               macros: ['相続贈与'] },
  { id: 'second-inheritance-loss',   label: '二次相続で損しないか',                 macros: ['相続贈与'] },
  { id: 'heir-confirmation',         label: '相続人の確定（戸籍収集）',             macros: ['相続贈与'] },
  { id: 'company-shares-valuation',  label: '自社株（未上場株式）の評価と承継',     macros: ['相続贈与'] },
  { id: 'real-estate-registration-pain', label: '相続登記の進め方',                 macros: ['相続贈与'] },
  { id: 'amendment-needed',          label: '評価額や控除の見直し（修正申告）',     macros: ['相続贈与'] },
  { id: 'rental-property-treatment', label: '賃貸不動産の評価と相続税',             macros: ['相続贈与'] },
  { id: 'vacant-house-handling',     label: '空き家相続の選択肢',                   macros: ['相続贈与'] },
  // 法人成り・税目実務
  { id: 'incorporation-threshold',   label: '法人成りのタイミング',                 macros: ['物販', 'インフルエンサー', 'サロン', '一般事業者'] },
  { id: 'consumption-tax-judgement', label: '消費税課税事業者の判定',               macros: ['物販', 'インフルエンサー', 'サロン', '一般事業者', '税目実務'] },
  { id: 'invoice-judgement',         label: 'インボイス登録の判断',                 macros: ['物販', 'インフルエンサー', 'サロン', '一般事業者', '税目実務'] },
  { id: 'family-employment',         label: '家族を従業員にするときの注意',         macros: ['一般事業者', 'サロン', '物販'] },
  { id: 'social-insurance-misconception', label: '社会保険の扶養と税の扶養の違い', macros: ['一般事業者'] },
];

// ── 資産タイプ（主に相続）
const ASSET_TYPES = [
  { id: 'cash-deposits',     label: '預金' },
  { id: 'home',              label: '自宅' },
  { id: 'rental-property',   label: '賃貸不動産' },
  { id: 'vacant-house',      label: '空き家' },
  { id: 'listed-stocks',     label: '上場株式' },
  { id: 'unlisted-stocks',   label: '未上場株式（自社株）' },
  { id: 'life-insurance',    label: '生命保険金' },
  { id: 'retirement-money',  label: '退職金' },
  { id: 'business-assets',   label: '事業資産' },
  { id: 'borrowings',        label: '借入金（負債）' },
  { id: 'name-deposits',     label: '名義預金' },
  { id: 'pre-gifted',        label: '生前贈与済み財産' },
];

// ── 取引相手の種類
const COUNTERPARTY_TYPES = [
  { id: 'general-customer',   label: '一般顧客（個人）' },
  { id: 'business-customer',  label: '法人顧客' },
  { id: 'overseas-platform',  label: '海外プラットフォーム' },
  { id: 'outsourcing-target', label: '外注先' },
  { id: 'family-member',      label: '家族' },
  { id: 'heir-other',         label: '他の相続人' },
  { id: 'tax-authority',      label: '税務署' },
];

// ── 物販プラットフォーム（cluster と対応）
const RETAIL_PLATFORMS = [
  { id: 'ebay',            cluster: 'ebay',            label: 'eBay',              persona: 'ebay_export_seller',          overseas: true },
  { id: 'amazon',          cluster: 'amazon',          label: 'Amazon',            persona: 'domestic_ec_seller',          overseas: false },
  { id: 'yahoo-shopping',  cluster: 'yahoo-shopping',  label: 'ヤフーショッピング', persona: 'domestic_ec_seller',          overseas: false },
  { id: 'yahoo-flea',      cluster: 'yahoo-flea',      label: 'ヤフーフリマ',       persona: 'reseller_marketplace_seller', overseas: false },
  { id: 'yahoo-auction',   cluster: 'yahoo-auction',   label: 'ヤフオク',           persona: 'reseller_marketplace_seller', overseas: false },
  { id: 'mercari',         cluster: 'mercari',         label: 'メルカリ',           persona: 'reseller_marketplace_seller', overseas: false },
  { id: 'shopify',         cluster: 'shopify',         label: 'Shopify',            persona: 'domestic_ec_seller',          overseas: true },
];

// ── インフルエンサー媒体（cluster と対応）
const INFLUENCER_CHANNELS = [
  { id: 'youtube',     cluster: 'youtube',           label: 'YouTube',     persona: 'influencer_creator' },
  { id: 'instagram',   cluster: 'instagram',         label: 'Instagram',   persona: 'influencer_creator' },
  { id: 'tiktok',      cluster: 'tiktok',            label: 'TikTok',      persona: 'influencer_creator' },
  { id: 'blog',        cluster: 'affiliate-pr',      label: 'ブログ・アフィリエイト', persona: 'influencer_creator' },
  { id: 'x-twitter',   cluster: 'influencer-general',label: 'X（旧Twitter）', persona: 'influencer_creator' },
];

// ── サロン業種（cluster と対応）
const SALON_TYPES = [
  { id: 'hair-salon',    cluster: 'hair-salon',    label: '美容室',         persona: 'beauty_salon_owner' },
  { id: 'nail-salon',    cluster: 'nail-salon',    label: 'ネイルサロン',   persona: 'beauty_salon_owner' },
  { id: 'eyelash',       cluster: 'eyelash',       label: 'まつエクサロン', persona: 'beauty_salon_owner' },
  { id: 'hair-removal',  cluster: 'hair-removal',  label: '脱毛サロン',     persona: 'beauty_salon_owner' },
  { id: 'esthetic',      cluster: 'esthetic',      label: 'エステサロン',   persona: 'beauty_salon_owner' },
];

// ── 記事タイプの役割
const MAIN_ARTICLE_TYPES = ['basic_explainer', 'comparison_decision'];
const SUPPORT_ARTICLE_TYPES = ['edge_case', 'industry_example', 'filing_practice', 'misconception_fix', 'case_study'];

// id でルックアップする関数
function lookup(arr, id) {
  return arr.find(x => x.id === id) || null;
}

module.exports = {
  BUSINESS_STAGES,
  LIFE_STAGES,
  HEIR_ROLES,
  TRANSACTION_PATTERNS,
  PROCEDURE_STAGES,
  PAIN_POINTS,
  ASSET_TYPES,
  COUNTERPARTY_TYPES,
  RETAIL_PLATFORMS,
  INFLUENCER_CHANNELS,
  SALON_TYPES,
  MAIN_ARTICLE_TYPES,
  SUPPORT_ARTICLE_TYPES,
  lookup,
};
