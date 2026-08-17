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

// ── 官庁名のリンク化 ──────────────────────────────────────────────
// 「日本年金機構」「厚生労働省」のような官庁名を、その記事に適用された
// 非税出典（official-sources.js）の URL へリンクする。
//
// 背景（2026-08-17）: 社会保険の論点を日本年金機構の原文で裏付けても、
// 読者がその出典に辿れなかった。frontmatter の source_url はテンプレートが
// 1件しか表示しないため、税以外の出典はページ上のどこにも現れなかった。
//
// 方針:
//   - リンクするのは各官庁名の「最初の1回」だけ。本文中に4〜5回出てくるため
//     毎回リンクにすると読みづらい（タックスアンサー番号と違い、官庁名は
//     固有の出典を指す表記ではない）。
//   - 既存リンク内はスキップ（二重リンク防止）。
//   - リンク先は記事に適用された出典セットからのみ引く。官庁名を無条件に
//     固定 URL へ飛ばすと、別テーマの記事で無関係なページに飛ばしてしまう。
function linkAgencies(markdown, agencyLinks) {
  if (!markdown || !Array.isArray(agencyLinks) || agencyLinks.length === 0) {
    return { markdown: markdown || '', linked: 0, agencies: [] };
  }

  let out = markdown;
  let linked = 0;
  const agencies = [];

  // 長い名前から先に処理する（部分一致で短い方が先に食わないように）
  const sorted = [...agencyLinks].sort((a, b) => String(b.agency).length - String(a.agency).length);

  for (const { agency, url } of sorted) {
    if (!agency || !url) continue;
    const ranges = findExistingLinkRanges(out);

    // 官庁名の出現位置を集め、既存リンク内か外かを判定する。
    const inside = [];
    const outside = [];
    for (let from = 0; ; ) {
      const idx = out.indexOf(agency, from);
      if (idx === -1) break;
      (isInsideRanges(idx, ranges) ? inside : outside).push(idx);
      from = idx + agency.length;
    }

    // 既にどこかでリンクになっているなら何もしない。
    // ここで「リンク外の最初の1件」を足すと、同じ官庁へのリンクが
    // 記事内に2つできてしまう。
    if (inside.length > 0) continue;
    if (outside.length === 0) continue;
    const pos = outside[0];
    out = out.slice(0, pos) + `[${agency}](${url})` + out.slice(pos + agency.length);
    linked++;
    agencies.push(agency);
  }

  return { markdown: out, linked, agencies };
}

/**
 * Markdown 本文中の出典表記をリンク化する。
 * @param {string} markdown
 * @param {Object} [opts]
 * @param {Function} [opts.onMiss] - 未収録番号（推定 URL 使用）を通知するコールバック
 * @param {Array<{agency: string, url: string}>} [opts.agencyLinks] - 官庁名 → URL（official-sources.agencyLinksForTopic）
 * @returns {{ markdown: string, stats: { linked: number, fromCatalog: number, guessed: number, missing: string[], agenciesLinked: number, agencies: string[] } }}
 */
function linkCitations(markdown, opts = {}) {
  if (!markdown || typeof markdown !== 'string') {
    return {
      markdown: markdown || '',
      stats: { linked: 0, fromCatalog: 0, guessed: 0, missing: [], agenciesLinked: 0, agencies: [] },
    };
  }

  const ranges = findExistingLinkRanges(markdown);
  const stats = { linked: 0, fromCatalog: 0, guessed: 0, missing: [], agenciesLinked: 0, agencies: [] };

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

  // タックスアンサーのリンク化を終えてから官庁名を処理する。
  // こうすると官庁名の走査時にタックスアンサーのリンクが「既存リンク」として
  // 見えるので、二重リンクにならない。
  const ag = linkAgencies(out, opts.agencyLinks);
  out = ag.markdown;
  stats.agenciesLinked = ag.linked;
  stats.agencies = ag.agencies;

  return { markdown: out, stats };
}

// ── marked レンダラ拡張: 外部 https:// リンクに target/rel を付与 ─────
// 内部リンク（/ や # で始まる相対、もしくは mori-zeirishi.net 同一ドメイン）は通常通り。
// href を属性値として安全な形にする。
// 厚生労働省の通達 URL のようにクエリ文字列を含む出典を扱うようになったため、
// 生の `&` をそのまま出すと HTML の「曖昧なアンパサンド」になる
// （例: ?dataId=...&dataType=1&pageNo=1）。実体参照になっていない & だけを
// &amp; に直す。既に &amp; などになっているものは二重変換しない。
function escapeHref(href) {
  return String(href || '')
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function applyExternalLinkRenderer(markedInstance) {
  // marked v9 系: marked.use({ renderer: ... }) で renderer 上書き可能
  markedInstance.use({
    renderer: {
      link(href, title, text) {
        const isExternal = /^https?:\/\//.test(href || '') &&
          !/^https?:\/\/([^/]+\.)?mori-zeirishi\.net(\/|$)/i.test(href);
        const safeHref = escapeHref(href);
        const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
        if (isExternal) {
          return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
        return `<a href="${safeHref}"${titleAttr}>${text}</a>`;
      },
    },
  });
}

module.exports = {
  linkCitations,
  linkAgencies,
  escapeHref,
  applyExternalLinkRenderer,
  findExistingLinkRanges,
  CITATION_RE,
};
