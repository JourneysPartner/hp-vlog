'use strict';

/**
 * 法令解釈通達（基本通達）のページを解析する。
 *
 * 国税庁の通達ページの構造:
 *   <h2>（物品切手等の発行）</h2>
 *   <p class="indent1"><strong>6－4－5　</strong>事業者が、…</p>
 *
 * 所得税基本通達は条番号が <strong> 2つに分かれる:
 *   <p class="indent1"><strong>37</strong><strong>－13　</strong>一の修理、…</p>
 *
 * そのため、見出しの直後の <p> から <strong> を連結して条番号を取り出す。
 *
 * 文字コードは Shift_JIS。呼び出し側でデコードしてから渡すこと。
 */

// 全角ハイフン（－ U+FF0D、‐ U+2010、− U+2212、‒、–、—）を半角に寄せる
const DASHES = /[－‐‑‒–—―−]/g;

/** 条番号の表記ゆれを吸収する（6－4－5 → 6-4-5） */
function normalizeProvisionNo(raw) {
  return String(raw || '')
    .replace(DASHES, '-')
    .replace(/[\s　]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .trim();
}

function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 条番号として妥当な形か。
// 相続税法基本通達は「・」で複数条にまたがり、「共」で共通関係を示す。
//   1の2-1            通常形
//   1の3・1の4共-1     第1条の3と第1条の4の共通関係
//   2・2の2共-1        第2条と第2条の2の共通関係
// 「の」は章・節・枝番のどこにも入りうる。
//   37-13      所得税の一般形
//   6-4-5      消費税の一般形
//   37-14の2   枝番（末尾）
//   12の5-1-1  章番号に「の」（法人税のリース取引。第12章の5）
//   7-6の2-1   節番号に「の」
// 2026-08-21: 末尾の「の」しか許していなかったため、リース取引の条文を
// 9条まるごと取りこぼしていた。各要素に「のN」を許す形に直す。
const PROVISION_NO_RE = /^\d{1,3}(?:の\d{1,2})?(?:・\d{1,3}(?:の\d{1,2})?)*共?(?:-\d{1,3}(?:の\d{1,2})?(?:・\d{1,3}(?:の\d{1,2})?)*共?){1,3}$/;
function looksLikeProvisionNo(s) {
  return PROVISION_NO_RE.test(normalizeProvisionNo(s));
}

/**
 * 通達の1ページから条文を抽出する。
 *
 * @param {string} html   Shift_JIS からデコード済みの HTML
 * @param {Object} [opts] { url, circular }
 * @returns {{sectionTitle: string, provisions: Array<{no,title,body,url,circular}>}}
 */
function parseTsutatsuPage(html, opts = {}) {
  const src = String(html || '');
  const sectionTitle = stripTags((src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');

  const provisions = [];
  // <h2>見出し</h2> と、それに続く本文ブロックを順に拾う
  const blocks = src.split(/<h2[^>]*>/).slice(1);
  for (const block of blocks) {
    const headEnd = block.indexOf('</h2>');
    if (headEnd < 0) continue;
    const title = stripTags(block.slice(0, headEnd));
    const rest = block.slice(headEnd + 5);

    // 見出し直後の最初の <p> を条番号の行とみなす
    const pMatch = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!pMatch) continue;

    // 先頭に連続する <strong> を連結して条番号にする
    const strongs = [];
    const strongRe = /^\s*<strong[^>]*>([\s\S]*?)<\/strong>/;
    let head = pMatch[1];
    for (;;) {
      const m = head.match(strongRe);
      if (!m) break;
      strongs.push(stripTags(m[1]));
      head = head.slice(m[0].length);
    }
    if (strongs.length === 0) continue;

    const no = normalizeProvisionNo(strongs.join(''));
    if (!looksLikeProvisionNo(no)) continue;

    // 条番号の後ろから、次の <h2> までを本文とする
    const bodyHtml = head + rest.slice(pMatch[0].length);
    const body = stripTags(bodyHtml);
    if (!body) continue;

    provisions.push({
      no,
      title,
      body,
      url: opts.url || '',
      circular: opts.circular || '',
    });
  }

  return { sectionTitle, provisions };
}

/** 目次ページから節ページの URL を集める */
function parseIndexPage(html, circularKey, baseUrl) {
  const src = String(html || '');
  // 相続税は 01/01.htm#a-1_1_2_1 のようにアンカー付きで並ぶため、
  // アンカーを落として重複を潰す。
  const re = new RegExp(`href="([^"]*?/kihon/${circularKey}/[^"]*?\\.htm)(?:#[^"]*)?"`, 'g');
  const seen = new Set();
  const urls = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    let href = m[1];
    if (href.startsWith('/')) href = `https://www.nta.go.jp${href}`;
    else if (!/^https?:/.test(href)) href = new URL(href, baseUrl).toString();
    // 目次自身は除く
    if (/\/01\.htm$/.test(href) && href.split('/').length <= 8) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

module.exports = {
  normalizeProvisionNo,
  looksLikeProvisionNo,
  stripTags,
  parseTsutatsuPage,
  parseIndexPage,
  PROVISION_NO_RE,
};
