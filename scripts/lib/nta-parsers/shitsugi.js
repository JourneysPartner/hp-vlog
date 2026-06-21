'use strict';

/**
 * 質疑応答事例（国税庁）ページのパーサ
 *
 * 入力: HTML 文字列（Shift_JIS デコード済）
 * 出力: 構造化された JSON エントリ
 *
 * URL 例:
 *   https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm
 *   （shohi=消費税、02=セクション番号、01=事例番号）
 *
 * 構造（実 HTML を調査済）:
 *   <div id="bodyArea">
 *     <ol class="breadcrumb">...</ol>             ← 除去
 *     <div class="page-header"><h1>タイトル</h1></div>
 *     <h2>【照会要旨】</h2>
 *     <p>照会内容...</p>
 *     <h2>【回答要旨】</h2>
 *     <p>回答内容...</p>
 *     <h2>【関係法令通達】</h2>
 *     <p>消費税法第2条第1項第8号、消費税法基本通達5-1-1</p>
 *     <p class="red"><strong>注記<br>令和7年8月1日現在の法令・通達等に基づいて作成しています。...</strong></p>
 *   </div>
 *
 * 共通ヘルパーは taxanswer.js から再利用する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const taxanswer = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));

// ── 質疑応答事例のカテゴリコード → 税目名 ─────────────────────
// プラン (b) で取得対象とする 7 カテゴリ。
// 注: タックスアンサーと違い、相続と贈与は sozoku に統合、財産評価は別カテゴリ hyoka。
const SHITSUGI_CATEGORY_MAP = {
  shotoku: '所得税',
  gensen:  '源泉所得税',
  joto:    '譲渡所得',
  sozoku:  '相続税・贈与税',
  hyoka:   '財産の評価',
  hojin:   '法人税',
  shohi:   '消費税',
};

// プラン (b) でスコープ外
const EXCLUDED_CATEGORIES = ['inshi', 'hotei', 'shinki'];

// ── HTML パース ────────────────────────────────────────────────
// bodyArea 抽出は taxanswer.js のヘルパーを再利用
const { extractBodyArea, stripHtmlTags } = taxanswer;

// タイトル抽出（page-header div の h1 から）
function extractTitle(bodyArea) {
  const m = bodyArea.match(/<div\s+class="page-header"[^>]*>\s*<h1[^>]*>([\s\S]+?)<\/h1>/);
  if (!m) return null;
  return stripHtmlTags(m[1]).replace(/\s+/g, ' ').trim();
}

// 各 h2 ラベルの後ろにある内容を抽出する。
// 例: 【照会要旨】<h2>【照会要旨】</h2> の直後の <p> ブロック全部
function extractByLabel(bodyArea, label) {
  // <h2>【照会要旨】</h2>...次の <h2> または <p class="red"> または </div> まで
  // ラベル内の <span> 等を許容するため正規表現で flexible に
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<h2[^>]*>\\s*${escaped}\\s*<\\/h2>([\\s\\S]+?)(?=<h2[^>]*>|<p\\s+class="red"|<\\/div>\\s*<\\/div>)`,
    'i'
  );
  const m = bodyArea.match(re);
  if (!m) return null;
  return stripHtmlTags(m[1]).replace(/\s+/g, ' ').trim();
}

// 関係法令通達（ラベル名のバリエーションあり：関係法令通達 / 関係法令）
function extractKankeiHourei(bodyArea) {
  return extractByLabel(bodyArea, '【関係法令通達】') ||
         extractByLabel(bodyArea, '【関係法令】') ||
         extractByLabel(bodyArea, '【根拠法令通達】') ||
         null;
}

// law_version 抽出（注記ブロックから「令和X年X月X日現在の法令・通達等」）
function extractLawVersion(bodyArea) {
  // <p class="red">注記...令和X年X月X日現在の法令・通達等...</p>
  const noteMatch = bodyArea.match(/<p\s+class="red"[\s\S]+?<\/p>/);
  if (!noteMatch) return null;
  const noteText = stripHtmlTags(noteMatch[0]).replace(/\s+/g, ' ').trim();
  // 元号は (令和|平成|昭和|大正|明治) のグループとして扱う（文字クラスだと 2 文字目を誤マッチする）
  // 末尾は「...等」までで止める（後続「に基づいて...」を取り込まない）
  const lvMatch = noteText.match(/((?:令和|平成|昭和|大正|明治)\d+年\d+月\d+日現在の[^。\s]*?等)/);
  return lvMatch ? lvMatch[1].trim() : null;
}

// 照会要旨と回答要旨を結合したプレーン本文（n-gram 検知用）
function extractBodyCombined(shokai, kaitou) {
  return [shokai, kaitou].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ── メインパース関数 ───────────────────────────────────────────
/**
 * @param {string} html Shift_JIS デコード済の HTML
 * @param {string} url 元の URL（カテゴリ/section/id を抽出）
 * @returns {Object} 構造化エントリ
 */
function parseShitsugiHtml(html, url) {
  const bodyArea = extractBodyArea(html);
  if (!bodyArea) {
    throw new Error(`bodyArea が見つかりません: ${url}`);
  }

  // URL からカテゴリ・セクション・id を抽出
  // 例: /law/shitsugi/shohi/02/01.htm → category=shohi, section=02, id=01
  const urlMatch = url.match(/\/law\/shitsugi\/(\w+)\/(\d+)\/(\d+)\.htm/);
  if (!urlMatch) {
    throw new Error(`URL 形式が想定外: ${url}`);
  }
  const [, categoryCode, section, id] = urlMatch;
  const taxCategory = SHITSUGI_CATEGORY_MAP[categoryCode] || '不明';

  const title = extractTitle(bodyArea);
  if (!title) {
    throw new Error(`タイトルが抽出できません: ${url}`);
  }

  const shokaiYoshi = extractByLabel(bodyArea, '【照会要旨】');
  const kaitouYoshi = extractByLabel(bodyArea, '【回答要旨】');
  const kankeiHourei = extractKankeiHourei(bodyArea);
  const lawVersion = extractLawVersion(bodyArea);
  const bodyCombined = extractBodyCombined(shokaiYoshi, kaitouYoshi);

  return {
    id,
    section,
    type: 'shitsugi',
    tax_category: taxCategory,
    tax_category_code: categoryCode,
    url,
    title,
    shokai_yoshi: shokaiYoshi,
    kaitou_yoshi: kaitouYoshi,
    kankei_hourei: kankeiHourei,
    law_version: lawVersion,
    body_combined: bodyCombined,
    char_count_body: bodyCombined.length,
  };
}

// ── スコープ判定 ───────────────────────────────────────────────
function isIncludedCategory(categoryCode) {
  return Object.prototype.hasOwnProperty.call(SHITSUGI_CATEGORY_MAP, categoryCode);
}

function isExcludedCategory(categoryCode) {
  return EXCLUDED_CATEGORIES.includes(categoryCode);
}

module.exports = {
  SHITSUGI_CATEGORY_MAP,
  EXCLUDED_CATEGORIES,
  parseShitsugiHtml,
  extractTitle,
  extractByLabel,
  extractKankeiHourei,
  extractLawVersion,
  extractBodyCombined,
  isIncludedCategory,
  isExcludedCategory,
};
