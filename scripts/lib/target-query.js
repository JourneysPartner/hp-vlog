'use strict';

const { TOO_GENERIC } = require('./tax-terms');

const VALID_INTENTS = new Set(['answer', 'decide', 'guide']);
const FORBIDDEN_SLUG_PREFIXES = ['newseg-', 'deepdive-', 'shitsugi-', 'suggest-', 'gsc-'];

const SYSTEM = [
  'あなたは検索意図を記事設計へ変換する編集者です。記事ごとに狙う検索語とURL用の語を決めます。',
  '重要な制約:',
  '- target_query は検索窓に打つ形の2〜4語。助詞を入れない。',
  '- 読者が実際に使う言い方にする。業種名・商品名・プラットフォーム名を含めてよい。',
  '- secondary_queries は主検索語の言い換えではなく、h2やFAQで扱う別の切り口を2〜5個。',
  '- intent_type は answer / decide / guide のいずれか。',
  '- slug_words は主検索語の意味を表す英語3〜6語のkebab-case。',
  '- slug_words を newseg- / deepdive- / shitsugi- / suggest- / gsc- で始めない。',
  '- 確信がない項目は空にする。',
  '出力はJSONのみ:',
  '{"target_query":"","secondary_queries":[],"intent_type":"","slug_words":""}',
].join('\n');

function tokenizeQuery(q) {
  return String(q || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s・、／/]+/u)
    .map(token => token.trim())
    .filter(Boolean);
}

function normalizeQuery(q) {
  return tokenizeQuery(q).sort((a, b) => a.localeCompare(b, 'ja')).join(' ');
}

function deriveIntentType(query) {
  const q = String(query || '').normalize('NFKC').toLowerCase();
  const answer = [
    /勘定科目/, /仕訳/, /税率/, /期限/, /いつまで/, /いつから/, /いくらから/,
    /とは/, /できる/, /かかる/, /必要か/, /なるか?/, /何種/,
  ];
  const decide = [/どっち/, /違い/, /有利/, /すべき/, /必要[?？]/, /比較/, /メリット/, /向いて/];
  const guide = [/やり方/, /手順/, /流れ/, /確定申告/, /還付/, /申告/, /計算方法/, /始め方/];
  if (answer.some(re => re.test(q))) return 'answer';
  if (decide.some(re => re.test(q))) return 'decide';
  if (guide.some(re => re.test(q))) return 'guide';
  return 'decide';
}

function prefillTargetQuery(topic = {}) {
  const evidence = topic.demand_evidence || {};
  if (!['search-suggest', 'gsc'].includes(evidence.kind)) return null;
  const phrases = Array.isArray(evidence.phrases)
    ? evidence.phrases.map(v => String(v || '').trim()).filter(Boolean)
    : [];
  if (phrases.length === 0) return null;
  return {
    target_query: phrases[0],
    secondary_queries: uniqueSecondary(phrases.slice(1), phrases[0]),
    intent_type: deriveIntentType(phrases[0]),
    slug_words: '',
  };
}

function buildUserPrompt(topic = {}) {
  const lines = ['# 記事の企画'];
  if (topic.title) lines.push(`参考タイトル: ${topic.title}`);
  if (topic.primary_question) lines.push(`中心疑問: ${topic.primary_question}`);
  if (topic.reader_problem) lines.push(`読者の課題: ${topic.reader_problem}`);
  if (topic.search_intent) lines.push(`検索意図: ${topic.search_intent}`);
  if (topic.persona) lines.push(`想定読者: ${topic.persona}`);
  if (topic.tax_domain) lines.push(`税目: ${topic.tax_domain}`);
  const phrases = topic.demand_evidence && Array.isArray(topic.demand_evidence.phrases)
    ? topic.demand_evidence.phrases.filter(Boolean) : [];
  if (phrases.length > 0) {
    lines.push('', '# 実際に検索されている語', ...phrases.map(p => `- ${p}`));
  }
  lines.push('', 'この記事の主検索語・副検索語・意図の型・URL用の語を決めてください。');
  return lines.join('\n');
}

function extractJson(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (_) { return null; }
}

function validTargetQuery(value) {
  const query = String(value || '').trim().replace(/\s+/g, ' ');
  const tokens = tokenizeQuery(query);
  if (query.length < 2 || query.length > 30 || tokens.length === 0 || tokens.length > 4) return '';
  if (tokens.every(token => TOO_GENERIC.has(token))) return '';
  return query;
}

function uniqueSecondary(values, targetQuery) {
  const targetKey = normalizeQuery(targetQuery);
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const query = String(value || '').trim().replace(/\s+/g, ' ');
    const key = normalizeQuery(query);
    if (!query || !key || key === targetKey || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length >= 5) break;
  }
  return out;
}

function validSlugWords(value, existingSlugs) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+){2,5}$/.test(slug)) return '';
  if (FORBIDDEN_SLUG_PREFIXES.some(prefix => slug.startsWith(prefix))) return '';
  const existing = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs || []);
  if (existing.has(slug)) return '';
  return slug;
}

function queryMatchesEvidence(candidate, targetQuery) {
  const targetKey = normalizeQuery(targetQuery);
  if (!targetKey) return false;
  if (normalizeQuery(candidate) === targetKey) return true;
  const normalizedCandidate = String(candidate || '').normalize('NFKC').toLowerCase();
  return tokenizeQuery(targetQuery).every(token => normalizedCandidate.includes(token));
}

function collectEvidence(targetQuery, suggestRaw, gscQueries) {
  const suggest = [];
  const seenSuggest = new Set();
  const seeds = suggestRaw && Array.isArray(suggestRaw.seeds) ? suggestRaw.seeds : [];
  for (const seed of seeds) {
    for (const phrase of Array.isArray(seed && seed.phrases) ? seed.phrases : []) {
      const text = String(phrase || '').trim();
      if (!text || seenSuggest.has(text) || !queryMatchesEvidence(text, targetQuery)) continue;
      seenSuggest.add(text);
      suggest.push(text);
    }
  }

  const gsc = [];
  for (const row of Array.isArray(gscQueries) ? gscQueries : []) {
    if (!row || !queryMatchesEvidence(row.query, targetQuery)) continue;
    gsc.push({ query: row.query, impressions: row.impressions, position: row.position });
  }
  return { suggest, gsc };
}

function withEvidence(result, options) {
  return {
    ...result,
    evidence: collectEvidence(result.target_query, options.suggestRaw, options.gscQueries),
  };
}

async function resolveTargetQuery(topic, callLLM, options = {}) {
  const fallback = prefillTargetQuery(topic);
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  try {
    const raw = await callLLM({ system: SYSTEM, user: buildUserPrompt(topic) });
    const parsed = extractJson(raw);
    const targetQuery = parsed && validTargetQuery(parsed.target_query);
    if (!targetQuery) return fallback ? withEvidence(fallback, options) : null;
    const intentType = VALID_INTENTS.has(parsed.intent_type)
      ? parsed.intent_type : deriveIntentType(targetQuery);
    return withEvidence({
      target_query: targetQuery,
      secondary_queries: uniqueSecondary(parsed.secondary_queries, targetQuery),
      intent_type: intentType,
      slug_words: validSlugWords(parsed.slug_words, options.existingSlugs),
    }, options);
  } catch (_) {
    return fallback ? withEvidence(fallback, options) : null;
  }
}

// 取り下げ（skipped / rejected）や統合済み（merged）の記事は所有者に数えない。
// 数えると、一度捨てた下書きの主検索語が以後ずっと再挑戦できなくなる。
const INACTIVE_STATUSES = new Set(['skipped', 'rejected', 'merged']);

function findTargetQueryOwner(key, corpus) {
  const wanted = normalizeQuery(key);
  if (!wanted) return null;
  return (Array.isArray(corpus) ? corpus : []).find(post => (
    post && post.target_query
    && !INACTIVE_STATUSES.has(String(post.review_status || '').toLowerCase())
    && normalizeQuery(post.target_query) === wanted
  )) || null;
}

module.exports = {
  SYSTEM,
  tokenizeQuery,
  normalizeQuery,
  deriveIntentType,
  prefillTargetQuery,
  resolveTargetQuery,
  findTargetQueryOwner,
  buildUserPrompt,
};
