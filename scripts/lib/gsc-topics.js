'use strict';

const fs = require('fs');
const path = require('path');
const { MACRO_BY_PERSONA } = require('./shitsugi-topics');
const {
  ALLOWED_TAX_DOMAINS, ALLOWED_CATEGORIES, ALLOWED_ARTICLE_TYPES,
} = require('./suggest-topics');

const ROOT = path.join(__dirname, '..', '..');
const TOPICS_FILE = path.join(ROOT, 'data', 'gsc-topics.json');

function scoreForImpressions(impressions) {
  return Math.min(95, 80 + Math.floor(Math.max(0, Number(impressions || 0)) / 10));
}

function validateTopic(topic) {
  if (!topic || typeof topic !== 'object') return '形式が不正';
  if (!/^gsc-[a-f0-9]+$/.test(String(topic.slug || ''))) return 'slug が不正';
  if (!MACRO_BY_PERSONA[topic.persona]) return `persona が不明 (${topic.persona})`;
  if (!ALLOWED_TAX_DOMAINS.has(topic.tax_domain)) return `tax_domain が不明 (${topic.tax_domain})`;
  if (!ALLOWED_CATEGORIES.has(topic.category)) return `category が不明 (${topic.category})`;
  if (!ALLOWED_ARTICLE_TYPES.has(topic.article_type)) return `article_type が不明 (${topic.article_type})`;
  if (!Array.isArray(topic.phrases) || topic.phrases.length === 0) return '検索語の裏づけが無い';
  if (!topic.primary_question || !topic.reader_problem) return '企画メタが不足';
  if (!Number.isFinite(Number(topic.impressions)) || Number(topic.impressions) < 0) return '表示回数が不正';
  if (!Number.isFinite(Number(topic.position)) || Number(topic.position) <= 0) return '順位が不正';
  if (!String(topic.page || '').trim()) return '根拠ページが無い';
  return null;
}

function toPoolTopic(topic) {
  return {
    slug: topic.slug,
    title: '',
    macro: MACRO_BY_PERSONA[topic.persona],
    persona: topic.persona,
    article_type: topic.article_type,
    category: topic.category,
    tax_domain: topic.tax_domain,
    cluster: `gsc-${topic.tax_domain}`,
    subcluster: topic.slug,
    pain_point: topic.slug,
    search_intent: topic.phrases.join(' '),
    reader_problem: topic.reader_problem,
    primary_question: topic.primary_question,
    success_outcome: topic.success_outcome
      || `${String(topic.primary_question || '').replace(/[？?]$/, '')}がわかり、自分のケースで判断できる`,
    demand_evidence: {
      kind: 'gsc',
      score: scoreForImpressions(topic.impressions),
      phrases: topic.phrases.slice(0, 10),
      impressions: Number(topic.impressions),
      position: Number(topic.position),
    },
  };
}

let lastStats = { total: 0, included: 0, invalid: 0, disabled: false };

function expandGscTopics(options = {}) {
  const logger = options.logger === undefined ? console : options.logger;
  const topicsFile = options.topicsFile || TOPICS_FILE;
  const stats = {
    total: 0,
    included: 0,
    invalid: 0,
    disabled: process.env.DISABLE_GSC_TOPICS === 'true',
  };
  if (stats.disabled) {
    lastStats = stats;
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(topicsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && logger && typeof logger.warn === 'function') {
      logger.warn(`[gsc-topics] 読込失敗（候補なしで続行）: ${error.message}`);
    }
    lastStats = stats;
    return [];
  }

  const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
  stats.total = topics.length;
  const out = [];
  for (const topic of topics) {
    const problem = validateTopic(topic);
    if (problem) {
      stats.invalid++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[gsc-topics] ${(topic && topic.slug) || '不明'} をスキップ: ${problem}`);
      }
      continue;
    }
    out.push(toPoolTopic(topic));
  }
  stats.included = out.length;
  lastStats = stats;
  return out;
}

function getLastGscStats() {
  return { ...lastStats };
}

module.exports = {
  TOPICS_FILE,
  scoreForImpressions,
  validateTopic,
  toPoolTopic,
  expandGscTopics,
  getLastGscStats,
};
