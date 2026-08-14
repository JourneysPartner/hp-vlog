'use strict';

/**
 * 本文長の計測と下限判定。
 *
 * 記事タイプ別の目標レンジは article-prompt-static.js の WORD_COUNT_RANGE が
 * 単一の情報源。ここはその判定ロジックだけを持つ。
 *
 * generate-draft.js に直接書かない理由:
 *   generate-draft.js は require された時点で main() が走るため、
 *   そこに export したヘルパーはテストから安全に読み込めない。
 */

const { WORD_COUNT_RANGE, WORD_COUNT_FLOOR_RATIO } = require('./article-prompt-static');

/**
 * frontmatter を除いた本文の文字数を返す。
 *
 * 本文中にも区切りの `---` が現れるため、先頭の frontmatter ブロックだけを
 * 取り除く。`split('---')` で数えると本文が途中で切れて過小評価になる。
 *
 * @param {string} content frontmatter を含む記事全体
 * @returns {number} 本文の文字数（前後の空白を除く）
 */
function measureBodyLength(content) {
  if (!content || typeof content !== 'string') return 0;
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return (m ? m[1] : content).trim().length;
}

/**
 * 本文長が記事タイプの下限を割っていないか判定する。
 *
 * LLM に厳密な字数制御はできないため、下限そのものではなく
 * 下限 × WORD_COUNT_FLOOR_RATIO を実際のしきい値にする。
 *
 * @param {string} content frontmatter を含む記事全体
 * @param {string} articleType 記事タイプ
 * @returns {{ok:boolean, produced:number, min:number|null, floor:number|null}}
 */
function checkBodyLength(content, articleType) {
  const produced = measureBodyLength(content);
  const range = WORD_COUNT_RANGE[articleType];
  // 未知の記事タイプは判定対象外（既存挙動を壊さない）
  if (!range) return { ok: true, produced, min: null, floor: null };
  const floor = Math.floor(range.min * WORD_COUNT_FLOOR_RATIO);
  return { ok: produced >= floor, produced, min: range.min, floor };
}

module.exports = { measureBodyLength, checkBodyLength };
