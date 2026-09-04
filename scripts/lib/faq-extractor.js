'use strict';

/**
 * 記事本文（markdown）の「## よくある質問」節から、質問と回答を取り出す。
 *
 * 目的: FAQPage の構造化データを出す（2026-09-03 段階1 R4）。
 *
 * 対象の形（現在の記事33本すべてがこの形）:
 *   ## よくある質問
 *   ### 質問文
 *   回答の段落…
 *   ### 次の質問文
 *   …
 *   ## まとめ            ← 次の ## で節が終わる
 *
 * 取れない形（例外を出さず空を返す）:
 *   - 「## よくある質問」が無い（「## よくある誤解」「## よくある間違い」は別物なので対象外）
 *   - 質問が ### でなく **太字** などで書かれている
 */

const FAQ_HEADING = /^##\s*よくある質問\s*$/;

/** markdown・HTML の記法を落としてプレーンテキストにする */
function toPlainText(md) {
  return String(md || '')
    .replace(/<[^>]+>/g, '')                       // HTMLタグ
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // 画像
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // リンク → 文字だけ
    .replace(/`([^`]*)`/g, '$1')                   // インラインコード
    .replace(/(\*\*|__)(.+?)\1/g, '$2')            // 太字
    .replace(/(\*|_)(.+?)\1/g, '$2')               // 斜体
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '') // 箇条書き・番号
    .replace(/^\s{0,3}>\s?/gm, '')                 // 引用
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')            // 見出し
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, ' ')                // 段落の切れ目は空白1つに
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * @param {string} markdown 記事本文
 * @returns {Array<{question: string, answer: string}>}
 */
function extractFaq(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(l => FAQ_HEADING.test(l.trim()));
  if (start < 0) return [];

  // 節の終わり = 次の「## 」見出し（### は含まない）
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+[^#]/.test(lines[i])) { end = i; break; }
  }

  const items = [];
  let current = null;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const q = line.match(/^###\s+(.+?)\s*$/);
    if (q) {
      if (current) items.push(current);
      current = { question: toPlainText(q[1]), answerLines: [] };
      continue;
    }
    if (current) current.answerLines.push(line);
  }
  if (current) items.push(current);

  return items
    .map(i => ({ question: i.question, answer: toPlainText(i.answerLines.join('\n')) }))
    .filter(i => i.question && i.answer);
}

module.exports = Object.freeze({ extractFaq, toPlainText, FAQ_HEADING });
