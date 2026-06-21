'use strict';

/**
 * 質疑応答事例のインデックスからカテゴリ別 URL 一覧を取得する。
 *
 * インデックスソース（カテゴリ別）:
 *   https://www.nta.go.jp/law/shitsugi/<category>/01.htm
 *
 * カテゴリは shitsugi.js の SHITSUGI_CATEGORY_MAP に従う。
 * 各カテゴリ index は Shift_JIS。
 *
 * 個別事例 URL の形式:
 *   /law/shitsugi/<category>/<section>/<id>.htm
 *   section/id は 2 桁ゼロ詰めが一般的だが、3 桁も許容
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const crawler = require(path.join(ROOT, 'scripts/lib/nta-crawler'));
const shitsugiParser = require(path.join(ROOT, 'scripts/lib/nta-parsers/shitsugi'));

const BASE_URL = 'https://www.nta.go.jp';

function categoryIndexUrl(categoryCode) {
  return `${BASE_URL}/law/shitsugi/${categoryCode}/01.htm`;
}

/**
 * 全カテゴリの index ページから対象 URL を取得する。
 *
 * @param {Object} options
 *   @param {string[]} [options.categories] 対象カテゴリの絞り込み
 *   @param {number}   [options.maxEntries] 全体最大件数（テスト用）
 * @returns {Promise<Array<{id, section, category, url, label}>>}
 */
async function fetchShitsugiIndex(options = {}) {
  const targetCategories = options.categories
    ? options.categories.filter(c => shitsugiParser.isIncludedCategory(c))
    : Object.keys(shitsugiParser.SHITSUGI_CATEGORY_MAP);

  const rl = new crawler.RateLimiter(1000);
  const allEntries = [];

  for (const cat of targetCategories) {
    await rl.wait();
    const url = categoryIndexUrl(cat);
    const result = await crawler.fetchPage(url);
    if (!result.ok) {
      console.warn(`[shitsugi-index] ${cat}: 取得失敗 reason=${result.reason}`);
      continue;
    }
    const entries = parseShitsugiCategoryIndex(result.html, cat);
    allEntries.push(...entries);
    if (options.maxEntries && allEntries.length >= options.maxEntries) {
      return allEntries.slice(0, options.maxEntries);
    }
  }
  return allEntries;
}

/**
 * 単一カテゴリの index ページ HTML から URL 一覧を抽出する。
 * テスト用に HTML を直接渡せる。
 */
function parseShitsugiCategoryIndex(html, categoryCode) {
  const entries = [];
  const seen = new Set();
  // /law/shitsugi/<cat>/<section>/<id>.htm のリンクを抽出
  const linkRe = new RegExp(
    `href="(\\/law\\/shitsugi\\/${categoryCode}\\/(\\d+)\\/(\\d+)\\.htm)"[^>]*>([\\s\\S]+?)<\\/a>`,
    'g'
  );
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const relUrl = match[1];
    const section = match[2];
    const id = match[3];
    const label = stripTags(match[4]).replace(/\s+/g, ' ').trim();
    const url = BASE_URL + relUrl;
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ id, section, category: categoryCode, url, label });
  }
  return entries;
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}

module.exports = {
  BASE_URL,
  categoryIndexUrl,
  fetchShitsugiIndex,
  parseShitsugiCategoryIndex,
};
