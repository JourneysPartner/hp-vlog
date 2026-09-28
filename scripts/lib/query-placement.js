'use strict';

const fs = require('fs');
const path = require('path');
const { tokenizeQuery } = require('./target-query');

let cachedSynonyms;
let warned = false;

function readSynonyms() {
  if (cachedSynonyms !== undefined) return cachedSynonyms;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'query-synonyms.json'), 'utf8'));
    if (!Array.isArray(parsed.groups)) throw new Error('groups が配列ではありません');
    cachedSynonyms = parsed.groups;
  } catch (error) {
    cachedSynonyms = [];
    if (!warned) {
      console.warn(`[query-placement] 同義語を読み込めません: ${error.message}`);
      warned = true;
    }
  }
  return cachedSynonyms;
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function containsAll(value, tokens, synonyms) {
  const text = normalizeText(value);
  return tokens.length > 0 && tokens.every(token => {
    const normalized = normalizeText(token);
    const group = synonyms.find(items => Array.isArray(items)
      && items.some(item => normalizeText(item) === normalized));
    return (group || [normalized]).some(item => text.includes(normalizeText(item)));
  });
}

/**
 * 検索語の全トークンが、記事のどこにあるかを返す。
 * 複数箇所にある場合は、題名 → h2 → 本文の順で優先する。
 */
function locateQuery(query, { title = '', headings = [], body = '' } = {}, options = {}) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 'none';
  const supplied = options.synonyms;
  const synonyms = supplied === undefined ? readSynonyms() : Array.isArray(supplied) ? supplied : (supplied && supplied.groups) || [];
  if (containsAll(title, tokens, synonyms)) return 'title';
  const headingTexts = Array.isArray(headings) ? headings : String(headings || '').split(/\r?\n/);
  if (headingTexts.some(heading => containsAll(heading, tokens, synonyms))) return 'h2';
  if (containsAll(body, tokens, synonyms)) return 'body';
  return 'none';
}

module.exports = { locateQuery };
