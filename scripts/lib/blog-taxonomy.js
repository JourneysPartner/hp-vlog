'use strict';

/**
 * ブログ一覧/カテゴリ/マクロ ページのタクソノミ・スラグ・カラー定義。
 *
 * - category は日本語表記が直に frontmatter に入っている（例: '所得税'）。
 *   URL スラグは英字で安定化する必要があるため、ここで日本語→slug を一元管理する。
 * - macro も同様。
 * - カテゴリカラー（A案: 画像の代替となる色ブロック）もここで一元管理する。
 *   build と CSS の整合を取るため、CSS は class 名（category--<slug>）で参照する。
 */

// ── カテゴリ（日本語 → slug, color, icon, accent） ───────────────
const CATEGORIES = [
  { ja: '所得税',     slug: 'shotoku',     color: '#4f7fc2', icon: 'bi-cash-coin' },
  { ja: '消費税',     slug: 'shouhi',      color: '#e8924c', icon: 'bi-receipt' },
  { ja: '帳簿・経費', slug: 'bookkeeping', color: '#5cb888', icon: 'bi-journal-text' },
  { ja: '相続',       slug: 'sozoku',      color: '#b86bb8', icon: 'bi-people' },
  { ja: 'インボイス', slug: 'invoice',     color: '#d96b6b', icon: 'bi-file-text' },
  { ja: '海外取引',   slug: 'overseas',    color: '#2fa8a8', icon: 'bi-globe' },
];

const CATEGORY_BY_JA = new Map(CATEGORIES.map(c => [c.ja, c]));

function getCategoryMeta(ja) {
  return CATEGORY_BY_JA.get(ja) || null;
}

function getCategorySlug(ja) {
  const c = CATEGORY_BY_JA.get(ja);
  return c ? c.slug : null;
}

// ── マクロ（業種/ペルソナ軸）───────────────────────────────────
// frontmatter macro が空の記事もあるため、表示は条件付き。
const MACROS = [
  { ja: '物販',             slug: 'retail',       icon: 'bi-box-seam' },
  { ja: 'サロン',           slug: 'salon',        icon: 'bi-scissors' },
  { ja: 'インフルエンサー', slug: 'influencer',   icon: 'bi-camera-video' },
  { ja: '相続贈与',         slug: 'inheritance',  icon: 'bi-people' },
  { ja: '一般事業者',       slug: 'general',      icon: 'bi-briefcase' },
  // Phase 4 で追加した新カテゴリ
  { ja: 'YouTube',          slug: 'youtube',      icon: 'bi-youtube' },
  { ja: 'コンテンツ販売',   slug: 'content',      icon: 'bi-file-earmark-text' },
  { ja: '建設',             slug: 'construction', icon: 'bi-hammer' },
  { ja: '小売',             slug: 'retail-store', icon: 'bi-shop' },
  { ja: '卸売',             slug: 'wholesale',    icon: 'bi-boxes' },
];

const MACRO_BY_JA = new Map(MACROS.map(m => [m.ja, m]));

function getMacroMeta(ja) {
  return MACRO_BY_JA.get(ja) || null;
}

function getMacroSlug(ja) {
  const m = MACRO_BY_JA.get(ja);
  return m ? m.slug : null;
}

module.exports = {
  CATEGORIES,
  MACROS,
  getCategoryMeta,
  getCategorySlug,
  getMacroMeta,
  getMacroSlug,
};
