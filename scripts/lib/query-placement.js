'use strict';

const { tokenizeQuery } = require('./target-query');

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function containsAll(value, tokens) {
  const text = normalizeText(value);
  return tokens.length > 0 && tokens.every(token => text.includes(token));
}

/**
 * 検索語の全トークンが、記事のどこにあるかを返す。
 * 複数箇所にある場合は、題名 → h2 → 本文の順で優先する。
 */
function locateQuery(query, { title = '', headings = [], body = '' } = {}) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 'none';
  if (containsAll(title, tokens)) return 'title';
  const headingTexts = Array.isArray(headings) ? headings : String(headings || '').split(/\r?\n/);
  if (headingTexts.some(heading => containsAll(heading, tokens))) return 'h2';
  if (containsAll(body, tokens)) return 'body';
  return 'none';
}

module.exports = { locateQuery };
