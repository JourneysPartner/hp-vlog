'use strict';

/**
 * タックスアンサー（国税庁）ページのパーサ
 *
 * 入力: HTML 文字列（UTF-8 デコード済）
 * 出力: 構造化された JSON エントリ
 *
 * URL 例:
 *   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm
 *
 * 構造（実 HTML を調査済）:
 *   <div id="bodyArea">
 *     <ol class="breadcrumb">...</ol>             ← 除去
 *     <div class="page-header"><h1>No.XXXX タイトル</h1></div>
 *     [令和X年X月X日現在法令等]                    ← law_version
 *     <h2>対象税目</h2>
 *     <p>消費税</p>
 *     <h2>概要</h2>
 *     <h3>...</h3>
 *     <p>本文...</p>
 *     <h2>根拠法令等</h2>
 *     ...
 *   </div>
 */

// ── タックスアンサーのカテゴリコード → 税目名 ────────────────────
// プラン (b) で取得対象とする 8 カテゴリ。
const TAX_CATEGORY_MAP = {
  shohi:   '消費税',
  shotoku: '所得税',
  sozoku:  '相続税',
  zoyo:    '贈与税',
  hojin:   '法人税',
  gensen:  '源泉所得税',
  joto:    '譲渡所得',
  hyoka:   '財産評価',
};

// プラン (b) でスコープ外（取得しない）
const EXCLUDED_CATEGORIES = ['inshi', 'hotei', 'osirase', 'saigai', 'fufuku'];

// ── HTML パース ────────────────────────────────────────────────
// bodyArea を抽出（外側のサイドナビ等を除去）。
// div の入れ子を数えて、id="bodyArea" の div に対応する閉じタグを探す。
// regex では nested を扱えないため、ステートマシン的に走査する。
function extractBodyArea(html) {
  const startMatch = html.match(/<div[^>]*id="bodyArea"[^>]*>/);
  if (!startMatch) return '';
  const startPos = startMatch.index;
  let pos = startPos + startMatch[0].length;
  let depth = 1;
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = pos;
  while (depth > 0) {
    const m = tagRe.exec(html);
    if (!m) break;
    if (m[1] === '/') depth--;
    else depth++;
    pos = m.index + m[0].length;
  }
  return html.slice(startPos, pos);
}

// タイトル抽出（"No.6501 納税義務の免除" → title="納税義務の免除", id="6501", titleFull="No.6501 納税義務の免除"）
function extractTitle(bodyArea) {
  // page-header div の h1 から
  const m = bodyArea.match(/<div\s+class="page-header"[^>]*>\s*<h1[^>]*>([\s\S]+?)<\/h1>/);
  if (!m) return { id: null, title: null, titleFull: null };

  // <span class="active">N</span>o.6501 ... のような span 装飾を除去
  const cleaned = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const noMatch = cleaned.match(/^No\.(\d+)\s*(.+)$/);
  if (noMatch) {
    return { id: noMatch[1], title: noMatch[2].trim(), titleFull: cleaned };
  }
  return { id: null, title: cleaned, titleFull: cleaned };
}

// 法令バージョン抽出（[令和7年4月1日現在法令等]）
function extractLawVersion(bodyArea) {
  const m = bodyArea.match(/\[(\s*[令和平成昭和][^\]]*?(?:法令|通達)[^\]]*?)\]/);
  return m ? m[1].trim() : null;
}

// h2 セクションごとに本文を分割
// 戻り値: { '対象税目': '消費税', '概要': '...', ... }
function extractSections(bodyArea) {
  // h2 とその直後の内容を抽出
  // <h2>セクション名</h2>...次の <h2> または bodyArea 終端まで
  const sections = {};
  const h2Pattern = /<h2[^>]*>([\s\S]+?)<\/h2>([\s\S]+?)(?=<h2[^>]*>|<p\s+class="red">|$)/g;
  let match;
  while ((match = h2Pattern.exec(bodyArea)) !== null) {
    const heading = stripHtmlTags(match[1]).trim();
    const body = stripHtmlTags(match[2]).replace(/\s+/g, ' ').trim();
    if (heading && body) {
      sections[heading] = body;
    }
  }
  return sections;
}

// h1 を除いた本文プレーンテキスト（n-gram 検知用）
function extractPlainBody(bodyArea) {
  // breadcrumb（パンくず）と最初の h1（タイトル繰り返し）を除去
  let cleaned = bodyArea
    .replace(/<ol\s+class="breadcrumb"[\s\S]+?<\/ol>/g, '')
    .replace(/<div\s+class="page-header"[\s\S]+?<\/div>/g, '');
  cleaned = stripHtmlTags(cleaned).replace(/\s+/g, ' ').trim();
  return cleaned;
}

// HTML タグを除去
function stripHtmlTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

// ── メインパース関数 ───────────────────────────────────────────
/**
 * @param {string} html UTF-8 デコード済の HTML
 * @param {string} url 元の URL
 * @returns {Object} 構造化エントリ
 */
function parseTaxAnswerHtml(html, url) {
  const bodyArea = extractBodyArea(html);
  if (!bodyArea) {
    throw new Error(`bodyArea が見つかりません: ${url}`);
  }

  const { id, title, titleFull } = extractTitle(bodyArea);
  if (!id) {
    throw new Error(`タイトルから ID を抽出できません: ${url}`);
  }

  // URL からカテゴリコード抽出
  const catMatch = url.match(/\/taxanswer\/(\w+)\//);
  const categoryCode = catMatch ? catMatch[1] : null;
  const taxCategory = TAX_CATEGORY_MAP[categoryCode] || '不明';

  const lawVersion = extractLawVersion(bodyArea);
  const sections = extractSections(bodyArea);
  const body = extractPlainBody(bodyArea);

  return {
    id,
    type: 'taxanswer',
    tax_category: taxCategory,
    tax_category_code: categoryCode,
    url,
    title,
    title_full: titleFull,
    law_version: lawVersion,
    sections,
    body,
    char_count_body: body.length,
  };
}

// ── スコープ判定 ───────────────────────────────────────────────
function isIncludedCategory(categoryCode) {
  return Object.prototype.hasOwnProperty.call(TAX_CATEGORY_MAP, categoryCode);
}

function isExcludedCategory(categoryCode) {
  return EXCLUDED_CATEGORIES.includes(categoryCode);
}

module.exports = {
  TAX_CATEGORY_MAP,
  EXCLUDED_CATEGORIES,
  parseTaxAnswerHtml,
  extractBodyArea,
  extractTitle,
  extractLawVersion,
  extractSections,
  extractPlainBody,
  stripHtmlTags,
  isIncludedCategory,
  isExcludedCategory,
};
