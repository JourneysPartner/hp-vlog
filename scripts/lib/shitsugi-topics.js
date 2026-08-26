'use strict';

const fs = require('fs');
const path = require('path');
const { isNaturalCombination } = require('./customer-relevance');

const ROOT = path.join(__dirname, '..', '..');
const CANDIDATE_FILE = path.join(ROOT, 'data', 'nta-shitsugi-topics-candidate.json');
const SOURCE_ROOT = path.join(ROOT, 'data', 'nta-sources');

const CATEGORY_BY_TAX_CATEGORY = {
  '消費税': '消費税',
  '所得税': '所得税',
  '譲渡所得': '所得税',
  '源泉所得税': '源泉徴収',
  '相続税・贈与税': '相続',
  '財産の評価': '相続',
  '法人税': '法人税',
};

const TAX_DOMAIN_BY_CODE = {
  shohi: 'consumption_tax',
  shotoku: 'income_tax',
  joto: 'income_tax',
  gensen: 'withholding',
  sozoku: 'inheritance_tax',
  hyoka: 'inheritance_tax',
  hojin: 'bookkeeping_expenses',
};

let lastStats = {
  adopted: 0,
  included: 0,
  skipped: 0,
  unreadable: 0,
  relevanceRejected: 0,
  disabled: false,
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sourceFileFor(candidate) {
  const relative = String(candidate.file_path || '').replace(/[\\/]+/g, path.sep);
  const resolved = path.resolve(SOURCE_ROOT, relative);
  const rootPrefix = `${path.resolve(SOURCE_ROOT)}${path.sep}`;
  return resolved.startsWith(rootPrefix) ? resolved : '';
}

function toTopic(candidate, sourceEntry) {
  const code = String(candidate.tax_category_code || '');
  const section = String(candidate.section || '');
  const id = String(candidate.id || '');
  const slug = `shitsugi-${code}-${section}-${id}`;
  const proposed = candidate.proposed || {};
  const question = normalizeText(sourceEntry.shokai_yoshi);
  const targetSegments = Array.isArray(candidate.target_segments)
    ? candidate.target_segments.filter(Boolean).join(' ')
    : '';

  return {
    slug,
    title: '',
    macro: proposed.macro,
    persona: proposed.persona,
    article_type: proposed.article_type,
    category: CATEGORY_BY_TAX_CATEGORY[candidate.tax_category],
    tax_domain: TAX_DOMAIN_BY_CODE[code],
    cluster: `shitsugi-${code}`,
    subcluster: slug,
    pain_point: slug,
    source_url: candidate.shitsugi_url,
    source_title: candidate.shitsugi_title,
    source_provenance: 'explicit',
    source_confidence: 1,
    search_intent: [candidate.shitsugi_title, candidate.tax_category, targetSegments]
      .filter(Boolean)
      .join(' '),
    reader_problem: question,
    primary_question: question,
    demand_evidence: {
      kind: 'nta-shitsugi',
      score: candidate.score,
      search_need: candidate.score_breakdown && candidate.score_breakdown.search_need,
      judgment: candidate.score_breakdown && candidate.score_breakdown.judgment_ambiguity,
    },
  };
}

function expandShitsugiTopics(options = {}) {
  const filterRelevance = options.filterRelevance !== false;
  const logger = options.logger === undefined ? console : options.logger;
  const stats = {
    adopted: 0,
    included: 0,
    skipped: 0,
    unreadable: 0,
    relevanceRejected: 0,
    disabled: process.env.DISABLE_SHITSUGI_TOPICS === 'true',
  };

  if (stats.disabled) {
    lastStats = stats;
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'));
  const adopted = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
    .filter(candidate => candidate && candidate.adopted === true)
    .sort((a, b) => {
      const highDiff = Number(b.article_potential === 'high') - Number(a.article_potential === 'high');
      return highDiff || (Number(b.score) || 0) - (Number(a.score) || 0);
    });
  stats.adopted = adopted.length;

  const topics = [];
  for (const candidate of adopted) {
    const file = sourceFileFor(candidate);
    try {
      if (!file || !fs.existsSync(file)) throw new Error('本文ファイルがありません');
      const sourceEntry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!normalizeText(sourceEntry.shokai_yoshi)) throw new Error('照会要旨が空です');
      const topic = toTopic(candidate, sourceEntry);
      if (!topic.category || !topic.tax_domain || !topic.slug || !topic.persona || !topic.macro) {
        throw new Error('必須の変換項目が不足しています');
      }
      if (filterRelevance && !isNaturalCombination(topic)) {
        stats.relevanceRejected++;
        continue;
      }
      topics.push(topic);
    } catch (error) {
      stats.unreadable++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[shitsugi-topics] ${candidate.file_path || candidate.shitsugi_url || '不明'} をスキップ: ${error.message}`);
      }
    }
  }

  stats.included = topics.length;
  stats.skipped = stats.unreadable + stats.relevanceRejected;
  lastStats = stats;
  return topics;
}

function getLastExpansionStats() {
  return { ...lastStats };
}

module.exports = {
  expandShitsugiTopics,
  getLastExpansionStats,
  CATEGORY_BY_TAX_CATEGORY,
  TAX_DOMAIN_BY_CODE,
  CANDIDATE_FILE,
  SOURCE_ROOT,
};
