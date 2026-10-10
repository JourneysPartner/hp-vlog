'use strict';

const { tokenizeForMatcher } = require('./nta-source-matcher');

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 論点に近い段落を優先し、原文内の順序を保った抜粋。 */
function excerptText(raw, query, maxChars) {
  const text = String(raw || '').trim();
  if (text.length <= maxChars) return text;
  const tokens = [...tokenizeForMatcher(query)];
  const paragraphs = text.match(/[^。\n]+[。\n]?/g) || [text];
  const ranked = paragraphs.map((value, index) => ({
    value, index, score: tokens.reduce((sum, token) => sum + (value.normalize('NFKC').toLowerCase().includes(token) ? token.length : 0), 0),
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let used = 0;
  for (const row of ranked) {
    const separator = selected.length ? 1 : 0;
    if (used + separator + row.value.length > maxChars) continue;
    selected.push(row);
    used += separator + row.value.length;
  }
  // 1段落自体が上限を超える場合は、語のある位置の前後だけを残す。
  if (!selected.length) {
    const best = ranked[0].value;
    const at = tokens.map(t => best.normalize('NFKC').toLowerCase().indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] || 0;
    const start = Math.max(0, at - Math.floor(maxChars / 4));
    return best.slice(start, start + maxChars);
  }
  return selected.sort((a, b) => a.index - b.index).map(r => r.value).join('\n');
}

module.exports = { excerptText, positiveLimit };
