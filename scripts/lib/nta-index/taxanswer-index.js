'use strict';

/**
 * タックスアンサーのインデックスページからカテゴリ別 URL 一覧を取得する。
 *
 * インデックスソース:
 *   https://www.nta.go.jp/taxes/shiraberu/taxanswer/code/index.htm
 *   （タックスアンサーコード一覧、全カテゴリの個別ページへのリンクを網羅）
 *
 * 実装方針:
 *   - 上記 URL を fetchPage で取得
 *   - href="/taxes/shiraberu/taxanswer/<category>/<id>.htm" を抽出
 *   - プラン (b) スコープのカテゴリのみ filter する
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const crawler = require(path.join(ROOT, 'scripts/lib/nta-crawler'));
const taxanswerParser = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));

const TAXANSWER_INDEX_URL = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/code/index.htm';
const BASE_URL = 'https://www.nta.go.jp';

/**
 * インデックスページを fetch し、対象カテゴリの全 URL を返す。
 *
 * @param {Object} options
 *   @param {string[]} [options.categories] 対象カテゴリの絞り込み（未指定なら全 included）
 *   @param {number}   [options.maxEntries] 最大件数（テスト用）
 * @returns {Promise<Array<{id, category, url, label}>>}
 */
async function fetchTaxAnswerIndex(options = {}) {
  const result = await crawler.fetchPage(TAXANSWER_INDEX_URL);
  if (!result.ok) {
    throw new Error(`タックスアンサー index 取得失敗: ${result.reason} (status=${result.status})`);
  }
  return parseTaxAnswerIndex(result.html, options);
}

/**
 * HTML から URL 一覧を抽出する（テスト時は HTML 文字列を直接渡せる）。
 */
function parseTaxAnswerIndex(html, options = {}) {
  const entries = [];
  const seen = new Set();
  // <a href="/taxes/shiraberu/taxanswer/<cat>/<id>.htm" ...>テキスト</a>
  const linkPattern = /<a\s+[^>]*href="(\/taxes\/shiraberu\/taxanswer\/(\w+)\/(\d+)\.htm)"[^>]*>([\s\S]+?)<\/a>/g;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const category = match[2];
    const id = match[3];
    const label = taxanswerParser.stripHtmlTags(match[4]).replace(/\s+/g, ' ').trim();

    if (!taxanswerParser.isIncludedCategory(category)) continue;
    if (options.categories && !options.categories.includes(category)) continue;

    const url = BASE_URL + relUrl;
    if (seen.has(url)) continue;
    seen.add(url);

    entries.push({ id, category, url, label });

    if (options.maxEntries && entries.length >= options.maxEntries) break;
  }
  return entries;
}

module.exports = {
  TAXANSWER_INDEX_URL,
  fetchTaxAnswerIndex,
  parseTaxAnswerIndex,
};
