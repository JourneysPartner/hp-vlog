'use strict';

const { tokenizeQuery } = require('./target-query');

function normalizedText(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function meaningfulTokens(query) {
  return tokenizeQuery(query).filter(token => token.length >= 2);
}

function includesAny(text, tokens) {
  const normalized = normalizedText(text);
  return tokens.some(token => normalized.includes(token));
}

function includesAll(text, tokens) {
  const normalized = normalizedText(text);
  return tokens.every(token => normalized.includes(token));
}

function lintSeo({ title, summary, body, target_query, secondary_queries } = {}) {
  const fails = [];
  const warns = [];
  if (!String(target_query || '').trim()) return { fails, warns };

  const tokens = meaningfulTokens(target_query);
  if (tokens.length === 0) return { fails, warns };
  const titleText = normalizedText(title);

  const titleHasAll = tokens.every(token => titleText.includes(token));
  if (!titleHasAll) {
    fails.push('title_missing_query');
  } else {
    const lastPosition = Math.max(...tokens.map(token => titleText.indexOf(token)));
    if (lastPosition > 15) warns.push('title_query_late');
  }
  if (String(title || '').length > 45) fails.push('title_too_long');
  if (String(title || '').length < 28) warns.push('title_too_short');

  if (!includesAny(String(summary || '').slice(0, 60), tokens)) fails.push('summary_missing_query');
  if (String(summary || '').length > 120) warns.push('summary_too_long');

  const bodyText = String(body || '');
  const firstH2 = bodyText.search(/^##\s+/m);
  const lead = firstH2 >= 0 ? bodyText.slice(0, firstH2) : bodyText;
  if (!includesAny(lead, tokens)) warns.push('lead_missing_query');

  const h2s = (bodyText.match(/^##\s+.*$/gm) || []).join('\n');
  if (!includesAny(h2s, tokens)) warns.push('h2_missing_query');

  const headings = (bodyText.match(/^#{2,3}\s+.*$/gm) || []).join('\n');
  const secondary = Array.isArray(secondary_queries)
    ? secondary_queries
    : String(secondary_queries || '').split(',').map(v => v.trim()).filter(Boolean);
  for (const query of secondary) {
    const secondaryTokens = meaningfulTokens(query);
    if (secondaryTokens.length > 0 && !includesAny(headings, secondaryTokens)) {
      warns.push(`secondary_not_covered:${query}`);
    }
  }

  const paragraphs = bodyText.split(/\r?\n\s*\r?\n/)
    .map(v => v.trim())
    .filter(v => v && !/^#{1,6}\s/.test(v) && !/^---$/.test(v));
  if (paragraphs.length > 0) {
    const stuffed = paragraphs.filter(paragraph => includesAll(paragraph, tokens)).length;
    if (stuffed / paragraphs.length > 0.6) warns.push('keyword_stuffing');
  }

  return { fails, warns };
}

module.exports = { lintSeo };
