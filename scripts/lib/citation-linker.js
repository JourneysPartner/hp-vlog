'use strict';

/**
 * 本文中の国税庁タックスアンサー番号などをクリック可能なリンクに変換する。
 *
 * 方針:
 *   - 過去記事のソース .md は一切変更しない（ビルド時に Markdown 文字列に対して変換）
 *   - 国税庁タックスアンサー番号（例: 「No.1350」「No.2080」）を主な対象とする
 *   - カタログ収録番号 → 確定 URL
 *   - 未収録だが番号レンジから推定できる場合 → 推定 URL（後でカタログ拡張時に警告ログを出す）
 *   - 既に [...](url) で markdown リンク化されている範囲はスキップ（二重リンク防止）
 *   - 法令単体（「消費税法第9条」など）はリンク化しない（公式 e-Gov URL を捏造しないため）
 *
 * 出力は Markdown 文字列。marked() が後段でリンクを <a> に展開する。
 * 外部リンクへの target="_blank" rel="noopener noreferrer" 付与は
 * marked のレンダラ拡張側（applyExternalLinkRenderer）で一括して処理する。
 */

const { resolveNtaUrlByNumber } = require('./tax-authority-refs');

// 既存の markdown リンク `[text](url)` の範囲を列挙
// → これらの内部にある「No.XXXX」はリンク化対象から除外する
function findExistingLinkRanges(md) {
  const ranges = [];
  // 画像 ![alt](url) もスキップ対象に含める
  const re = /!?\[[^\]]*\]\([^)]+\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInsideRanges(pos, ranges) {
  for (const [s, e] of ranges) {
    if (pos >= s && pos < e) return true;
  }
  return false;
}

// 「国税庁タックスアンサー No.1350」「タックスアンサー No.2080「白色申告...」」
// 「No.6501」のような表記を検出する。
// グループ:
//   1: 接頭辞（「国税庁」「タックスアンサー」など、省略可）
//   2: 番号（3〜4桁）
//   3: 鉤括弧タイトル（任意, 「...」）
const CITATION_RE =
  /(国税庁(?:タックスアンサー)?\s*|タックスアンサー\s*)?No\.\s*(\d{3,4})(\s*「[^」]+」)?/g;

/**
 * Markdown 本文中の出典表記をリンク化する。
 * @param {string} markdown
 * @param {Object} [opts]
 * @param {Function} [opts.onMiss] - 未収録番号（推定 URL 使用）を通知するコールバック
 * @returns {{ markdown: string, stats: { linked: number, fromCatalog: number, guessed: number, missing: string[] } }}
 */
function linkCitations(markdown, opts = {}) {
  if (!markdown || typeof markdown !== 'string') {
    return { markdown: markdown || '', stats: { linked: 0, fromCatalog: 0, guessed: 0, missing: [] } };
  }

  const ranges = findExistingLinkRanges(markdown);
  const stats = { linked: 0, fromCatalog: 0, guessed: 0, missing: [] };

  let out = '';
  let last = 0;
  let m;
  CITATION_RE.lastIndex = 0;

  while ((m = CITATION_RE.exec(markdown)) !== null) {
    const start = m.index;
    const end = start + m[0].length;

    // 既存リンク内ならスキップ（そのまま出力）
    if (isInsideRanges(start, ranges)) continue;

    const no = m[2];
    const resolved = resolveNtaUrlByNumber(no);

    // 解決不可なら警告ログだけ出してリンク化しない（捏造防止）
    if (!resolved) {
      stats.missing.push(no);
      if (typeof opts.onMiss === 'function') opts.onMiss({ no, matched: m[0] });
      continue;
    }

    // matched 文字列をそのまま表示テキストに使う
    const display = m[0];
    const linkMd = `[${display}](${resolved.url})`;

    out += markdown.slice(last, start) + linkMd;
    last = end;

    stats.linked++;
    if (resolved.fromCatalog) stats.fromCatalog++;
    else stats.guessed++;
  }
  out += markdown.slice(last);

  return { markdown: out, stats };
}

// ── marked レンダラ拡張: 外部 https:// リンクに target/rel を付与 ─────
// 内部リンク（/ や # で始まる相対、もしくは mori-zeirishi.net 同一ドメイン）は通常通り。
function applyExternalLinkRenderer(markedInstance) {
  // marked v9 系: marked.use({ renderer: ... }) で renderer 上書き可能
  markedInstance.use({
    renderer: {
      link(href, title, text) {
        const isExternal = /^https?:\/\//.test(href || '') &&
          !/^https?:\/\/([^/]+\.)?mori-zeirishi\.net(\/|$)/i.test(href);
        const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
        if (isExternal) {
          return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
        return `<a href="${href}"${titleAttr}>${text}</a>`;
      },
    },
  });
}

module.exports = {
  linkCitations,
  applyExternalLinkRenderer,
  findExistingLinkRanges,
  CITATION_RE,
};
