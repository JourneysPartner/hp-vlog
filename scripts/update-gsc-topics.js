#!/usr/bin/env node
'use strict';

/**
 * Search Console の実測から新記事候補を作る。
 * 抽出後の LLM 選別はサジェスト候補と同じプロンプトを使う。
 * 候補は週次 PR で人が検収し、マージ後に日次生成プールへ入る。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeQuery, tokenizeQuery } = require('./lib/target-query');
const { locateQuery } = require('./lib/query-placement');
const { readAllPosts } = require('./lib/site-corpus');
const { loadDenylist, findMatchingEntry } = require('./lib/denylist');
const { validateTopic } = require('./lib/gsc-topics');
const { selectTopicProposals } = require('./lib/search-topic-selector');
const { articleSlug, readPublishedPostContents } = require('./report-search-console');

const ROOT = path.join(__dirname, '..');
const SEARCH_ROOT = path.join(ROOT, 'data', 'search-console');
const TOPICS_FILE = path.join(ROOT, 'data', 'gsc-topics.json');
const ARTICLE_POSITION_MIN = 30;
const NON_ARTICLE_POSITION_MIN = 20;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function slugFor(primaryPhrase) {
  const hash = crypto.createHash('sha1').update(String(primaryPhrase || '')).digest('hex').slice(0, 8);
  return `gsc-${hash}`;
}

function compactQuery(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s・、／/]+/gu, '');
}

function queryVariantMatch(left, right) {
  if (normalizeQuery(left) === normalizeQuery(right)) return true;
  const leftCompact = compactQuery(left);
  const rightCompact = compactQuery(right);
  const leftTokens = tokenizeQuery(left);
  const rightTokens = tokenizeQuery(right);
  if (!leftCompact || !rightCompact || leftTokens.length === 0 || rightTokens.length === 0) return false;
  return leftTokens.every(token => rightCompact.includes(token))
    || rightTokens.every(token => leftCompact.includes(token));
}

function bestRankedPage(query, queryPages) {
  const key = normalizeQuery(query);
  const rows = (Array.isArray(queryPages) ? queryPages : [])
    .filter(row => row && normalizeQuery(row.query) === key && row.page);
  const exact = rows.filter(row => String(row.query).trim() === String(query).trim());
  return (exact.length ? exact : rows)
    .sort((a, b) => {
      const aPosition = Number(a.position) > 0 ? Number(a.position) : Infinity;
      const bPosition = Number(b.position) > 0 ? Number(b.position) : Infinity;
      return aPosition - bPosition || Number(b.impressions || 0) - Number(a.impressions || 0);
    })[0] || null;
}

function contentForSlug(postContents, slug) {
  if (postContents instanceof Map) return postContents.get(slug);
  return postContents && postContents[slug];
}

function resolveMergedSlug(slug, posts) {
  const bySlug = new Map((Array.isArray(posts) ? posts : []).map(post => [post.slug, post]));
  let current = slug;
  const visited = new Set([slug]);
  for (let depth = 0; depth < 5; depth++) {
    const post = bySlug.get(current);
    if (!post || post.review_status !== 'merged' || !post.merged_into) break;
    if (visited.has(post.merged_into)) break;
    current = post.merged_into;
    visited.add(current);
  }
  return current;
}

function isKnownPhrase(query, topics) {
  return (Array.isArray(topics) ? topics : []).some(topic => (
    (Array.isArray(topic && topic.phrases) ? topic.phrases : [])
      .some(phrase => queryVariantMatch(query, phrase))
  ));
}

function deniedQuery(query, denylist, now) {
  return Boolean(findMatchingEntry({
    slug: '',
    title: query,
    search_intent: query,
    primary_question: query,
    reader_problem: query,
  }, denylist, now));
}

function extractGscCandidates({
  queries = [],
  queryPages = [],
  posts = [],
  postContents = new Map(),
  existingTopics = [],
  denylist = { entries: [] },
  now = new Date(),
} = {}) {
  const targetQueries = new Set((Array.isArray(posts) ? posts : [])
    .map(post => normalizeQuery(post && post.target_query))
    .filter(Boolean));
  const individuals = [];

  for (const row of Array.isArray(queries) ? queries : []) {
    const query = String((row && row.query) || '').trim();
    const impressions = Number(row && row.impressions || 0);
    if (!query || impressions < 10) continue;
    if (targetQueries.has(normalizeQuery(query))) continue;
    if (isKnownPhrase(query, existingTopics)) continue;
    if (deniedQuery(query, denylist, now)) continue;

    const page = bestRankedPage(query, queryPages);
    if (!page) continue;
    const position = Number(page.position || 0);
    const slug = articleSlug(page.page);
    let location = 'none';
    if (slug) {
      const content = contentForSlug(postContents, resolveMergedSlug(slug, posts));
      if (content) location = locateQuery(query, content);
    }
    if (slug) {
      if (!(position > ARTICLE_POSITION_MIN && location !== 'title' && location !== 'h2')) continue;
    } else if (!(position > NON_ARTICLE_POSITION_MIN)) continue;
    individuals.push({
      query,
      impressions,
      position,
      page: page.page,
    });
  }

  const groups = [];
  for (const item of individuals.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query, 'ja'))) {
    let group = groups.find(candidate => candidate.phrases.some(phrase => queryVariantMatch(phrase, item.query)));
    if (!group) {
      group = { phrases: [], evidence: [] };
      groups.push(group);
    }
    if (!group.phrases.includes(item.query)) group.phrases.push(item.query);
    group.evidence.push(item);
  }

  return groups.map(group => {
    const primary = group.evidence[0];
    const impressions = group.evidence.reduce((sum, item) => sum + item.impressions, 0);
    const weightedPosition = impressions
      ? group.evidence.reduce((sum, item) => sum + item.position * item.impressions, 0) / impressions
      : primary.position;
    return {
      id: slugFor(primary.query),
      phrases: group.phrases,
      impressions,
      position: Number(weightedPosition.toFixed(1)),
      page: primary.page,
      persona_hint: '',
    };
  }).sort((a, b) => b.impressions - a.impressions || a.phrases[0].localeCompare(b.phrases[0], 'ja'));
}

async function selectTopics(options = {}) {
  const candidates = Array.isArray(options.candidates) ? options.candidates : [];
  const callLLM = options.callLLM;
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const topicsFile = options.topicsFile || TOPICS_FILE;
  const logger = options.logger === undefined ? console : options.logger;
  const nowFn = options.nowFn || (() => new Date().toISOString());
  const log = message => { if (logger && typeof logger.log === 'function') logger.log(message); };
  const warn = message => { if (logger && typeof logger.warn === 'function') logger.warn(message); };

  const existing = readJson(topicsFile, { version: 1, topics: [] });
  if (!Array.isArray(existing.topics)) existing.topics = [];
  const knownSlugs = new Set(existing.topics.map(topic => topic.slug));
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const selected = await selectTopicProposals(candidates, {
    callLLM,
    logger,
    prefix: 'gsc-topics',
  });
  const stats = {
    proposed: 0,
    accepted: 0,
    invalid: 0,
    duplicate: 0,
    skippedBatches: selected.skippedBatches,
    acceptedTopics: [],
  };

  for (const proposal of selected.proposals) {
    stats.proposed++;
    const evidence = byId.get(String(proposal.seed_id || ''));
    const phrases = evidence ? evidence.phrases.slice(0, 10) : [];
    const candidate = {
      slug: slugFor(phrases[0] || ''),
      phrases,
      impressions: evidence ? evidence.impressions : 0,
      position: evidence ? evidence.position : 0,
      page: evidence ? evidence.page : '',
      persona: proposal.persona,
      tax_domain: proposal.tax_domain,
      category: proposal.category,
      article_type: proposal.article_type,
      primary_question: String(proposal.primary_question || '').trim(),
      reader_problem: String(proposal.reader_problem || '').trim(),
      selected_at: nowFn(),
    };
    const problem = validateTopic(candidate);
    if (problem) {
      stats.invalid++;
      warn(`[gsc-topics] 提案を却下 (${problem}): ${phrases[0] || '?'}`);
      continue;
    }
    if (knownSlugs.has(candidate.slug)) {
      stats.duplicate++;
      continue;
    }
    knownSlugs.add(candidate.slug);
    stats.acceptedTopics.push(candidate);
    stats.accepted++;
  }

  if (stats.acceptedTopics.length > 0) {
    existing.version = existing.version || 1;
    existing.topics = existing.topics.concat(stats.acceptedTopics);
    existing.updated_at = nowFn();
    fs.mkdirSync(path.dirname(topicsFile), { recursive: true });
    fs.writeFileSync(topicsFile, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  }
  log(`[gsc-topics] 選別完了: 提案 ${stats.proposed} → 採用 ${stats.accepted} `
    + `(形式不正 ${stats.invalid} / 既出 ${stats.duplicate} / スキップしたバッチ ${stats.skippedBatches})`);
  return stats;
}

function loadInputs(options = {}) {
  const searchRoot = options.searchRoot || SEARCH_ROOT;
  const latest = readJson(path.join(searchRoot, 'latest.json'), {});
  const queryRel = latest.files && latest.files.queries;
  const queryPageRel = latest.files && latest.files['query-page'];
  const queries = Array.isArray(queryRel)
    ? queryRel
    : ((typeof queryRel === 'string' && readJson(path.join(searchRoot, queryRel), {})) || {}).rows || [];
  const queryPages = Array.isArray(queryPageRel)
    ? queryPageRel
    : ((typeof queryPageRel === 'string' && readJson(path.join(searchRoot, queryPageRel), {})) || {}).rows || [];
  return { queries, queryPages };
}

function formatPrSummary(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return '（新規候補なし）';
  const escape = value => String(value || '').replace(/\|/g, '｜');
  return [
    '| 語 | 表示 | 順位 | 提案 persona |',
    '|---|---:|---:|---|',
    ...topics.map(topic => `| ${escape(topic.phrases[0])} | ${topic.impressions} | ${topic.position} | ${escape(topic.persona)} |`),
  ].join('\n');
}

function writeWorkflowSummary(file, topics) {
  if (!file) return;
  fs.appendFileSync(file, `summary<<GSC_TOPICS_EOF\n${formatPrSummary(topics)}\nGSC_TOPICS_EOF\n`, 'utf8');
}

async function run(options = {}) {
  const logger = options.logger === undefined ? console : options.logger;
  const log = message => { if (logger && typeof logger.log === 'function') logger.log(message); };
  const loaded = loadInputs(options);
  const topicsFile = options.topicsFile || TOPICS_FILE;
  const existingData = readJson(topicsFile, { topics: [] });
  const queries = options.queries === undefined ? loaded.queries : options.queries;
  const queryPages = options.queryPages === undefined ? loaded.queryPages : options.queryPages;
  const posts = options.posts === undefined ? readAllPosts() : options.posts;
  const postContents = options.postContents === undefined ? readPublishedPostContents() : options.postContents;
  const existingTopics = options.existingTopics === undefined ? existingData.topics || [] : options.existingTopics;
  const denylist = options.denylist === undefined ? loadDenylist() : options.denylist;
  const candidates = extractGscCandidates({
    queries, queryPages, posts, postContents, existingTopics, denylist, now: options.now || new Date(),
  });
  log(`[gsc-topics] 選別前の候補: ${candidates.length} 件`);
  for (const candidate of candidates) {
    log(`[gsc-topics] - ${candidate.phrases.join(' / ')}（表示 ${candidate.impressions}・${candidate.position}位） ${candidate.page}`);
  }

  const env = options.env || process.env;
  if (!env.OPENAI_API_KEY && typeof options.callLLM !== 'function') {
    log('[gsc-topics] OPENAI_API_KEY が未設定のため、LLM 選別と書き出しをスキップします');
    return { status: 'skipped', candidates, acceptedTopics: [] };
  }
  let callLLM = options.callLLM;
  if (typeof callLLM !== 'function') {
    const { makeOpenAILuna } = require('./lib/llm-source-selector');
    process.env.LLM_SOURCE_SELECT_MODEL = env.LLM_GSC_MODEL || env.LLM_SUGGEST_MODEL || 'gpt-5.6-luna';
    callLLM = makeOpenAILuna();
  }
  const stats = await selectTopics({
    candidates, callLLM, topicsFile, logger, nowFn: options.nowFn,
  });
  return { status: 'selected', candidates, stats, acceptedTopics: stats.acceptedTopics };
}

async function main() {
  const result = await run();
  writeWorkflowSummary(process.env.GITHUB_OUTPUT, result.acceptedTopics || []);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[gsc-topics] 失敗: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ROOT,
  SEARCH_ROOT,
  TOPICS_FILE,
  slugFor,
  queryVariantMatch,
  bestRankedPage,
  extractGscCandidates,
  resolveMergedSlug,
  selectTopics,
  loadInputs,
  formatPrSummary,
  writeWorkflowSummary,
  run,
};
