'use strict';

/**
 * 記事がどの業種ハブ（/blog/macro/<slug>/）に属するかを決める。
 *
 * なぜ必要か（2026-09-03）:
 *   frontmatter の macro が空の記事が61本、「税目実務」の記事が40本あり、
 *   どの業種ページにも載っていなかった。記事は業種（ペルソナ）で書かれているので、
 *   ペルソナから業種を引けば全記事をいずれかのハブに載せられる。
 *
 * 記事（content/posts）は変更しない。ビルド時にこの関数で所属を決める。
 *
 * 優先順:
 *   1. primary_persona → PERSONA_TO_MACRO（cluster-taxonomy.js の既定対応）
 *      general_individual_proprietor は '一般事業者'
 *   2. frontmatter の macro（MACROS に載っているものだけ）
 *   3. どちらも無ければ '一般事業者'
 */

const { PERSONA_TO_MACRO } = require('./cluster-taxonomy');
const { MACROS, getMacroSlug } = require('./blog-taxonomy');

const GENERAL = '一般事業者';
const HUB_MACROS = new Set(MACROS.map(m => m.ja));

const PERSONA_OVERRIDES = {
  general_individual_proprietor: GENERAL,
};

function hubMacroFor(post) {
  const persona = String((post && (post.primary_persona || post.persona)) || '').trim();
  if (persona) {
    const byPersona = PERSONA_OVERRIDES[persona] || PERSONA_TO_MACRO[persona];
    if (byPersona && HUB_MACROS.has(byPersona)) return byPersona;
  }
  const macro = String((post && post.macro) || '').trim();
  if (macro && HUB_MACROS.has(macro)) return macro;
  return GENERAL;
}

/** ビルド時に一度だけ付ける。以後は _hubMacro を読む。 */
function assignHubMacro(posts) {
  const counts = new Map();
  for (const post of posts || []) {
    post._hubMacro = hubMacroFor(post);
    counts.set(post._hubMacro, (counts.get(post._hubMacro) || 0) + 1);
  }
  return counts;
}

/** _hubMacro が付いていればそれを、無ければその場で判定する */
function hubMacroOf(post) {
  if (!post) return GENERAL;
  return post._hubMacro || hubMacroFor(post);
}

function hubSlugOf(post) {
  return getMacroSlug(hubMacroOf(post));
}

module.exports = Object.freeze({ hubMacroFor, assignHubMacro, hubMacroOf, hubSlugOf, GENERAL, HUB_MACROS });
