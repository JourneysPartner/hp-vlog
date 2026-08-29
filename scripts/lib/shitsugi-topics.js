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

// corrected_persona（選別時の読者想定の補正）から macro を引くための対応表。
// 既存トピックプールの実際の persona→macro を集計して作成（主たる macro を採用）。
const MACRO_BY_PERSONA = {
  ebay_export_seller: '物販',
  domestic_ec_seller: '物販',
  reseller_marketplace_seller: '物販',
  influencer_creator: 'インフルエンサー',
  beauty_salon_owner: 'サロン',
  inheritance_client: '相続贈与',
  general_individual_proprietor: '税目実務',
  general_corporation: '税目実務',
  youtuber: 'YouTube',
  content_seller: 'コンテンツ販売',
  construction_solo: '建設',
  retail_store: '小売',
  wholesale: '卸売',
};

let lastStats = {
  adopted: 0,
  included: 0,
  skipped: 0,
  unreadable: 0,
  relevanceRejected: 0,
  triaged: 0,
  disabled: false,
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sourceFileFor(candidate, sourceRoot = SOURCE_ROOT) {
  const relative = String(candidate.file_path || '').replace(/[\\/]+/g, path.sep);
  const resolved = path.resolve(sourceRoot, relative);
  const rootPrefix = `${path.resolve(sourceRoot)}${path.sep}`;
  return resolved.startsWith(rootPrefix) ? resolved : '';
}

function toTopic(candidate, sourceEntry) {
  const code = String(candidate.tax_category_code || '');
  const section = String(candidate.section || '');
  const id = String(candidate.id || '');
  const slug = `shitsugi-${code}-${section}-${id}`;
  const proposed = candidate.proposed || {};
  // LLM 選別が読者想定を補正した場合はそれを使い、macro も対応表で引き直す。
  const triage = candidate.llm_triage || null;
  const persona = (triage && triage.corrected_persona) || proposed.persona;
  const macro = (triage && triage.corrected_persona)
    ? MACRO_BY_PERSONA[triage.corrected_persona]
    : proposed.macro;
  if (!persona || !macro) {
    throw new Error(`読者想定を解決できません (persona=${persona || '無し'})`);
  }
  const question = normalizeText(sourceEntry.shokai_yoshi);
  const targetSegments = Array.isArray(candidate.target_segments)
    ? candidate.target_segments.filter(Boolean).join(' ')
    : '';

  return {
    slug,
    title: '',
    macro,
    persona,
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
    // success_outcome は記事バリデーションの必須項目。空だと承認後に main で
    // ERROR になり、翌日以降の日次生成がバリデーションごと落ちる（2026-08-28/29）。
    success_outcome: `${candidate.shitsugi_title}について、国税庁の質疑応答事例に沿って自分のケースの取扱いを判断できる`,
    demand_evidence: {
      kind: 'nta-shitsugi',
      score: candidate.score,
      search_need: candidate.score_breakdown && candidate.score_breakdown.search_need,
      judgment: candidate.score_breakdown && candidate.score_breakdown.judgment_ambiguity,
    },
  };
}

// 接続対象の決め方:
//   LLM 選別（llm_triage）が済んでいる候補は decision === 'adopt' のものだけを使う。
//   まだ選別されていない候補は、従来の手動採用フラグ（adopted === true）を使う。
//   → 選別が途中でも壊れず、全件選別が済めば手動採用は自然に役目を終える。
function isConnectable(candidate) {
  if (!candidate) return false;
  const triage = candidate.llm_triage;
  if (triage && triage.decision) return triage.decision === 'adopt';
  return candidate.adopted === true;
}

function expandShitsugiTopics(options = {}) {
  const filterRelevance = options.filterRelevance !== false;
  const logger = options.logger === undefined ? console : options.logger;
  // candidateFile / sourceRoot はテスト用の注入口。通常は既定のまま。
  const candidateFile = options.candidateFile || CANDIDATE_FILE;
  const sourceRoot = options.sourceRoot || SOURCE_ROOT;
  const stats = {
    adopted: 0,
    included: 0,
    skipped: 0,
    unreadable: 0,
    relevanceRejected: 0,
    triaged: 0,
    disabled: process.env.DISABLE_SHITSUGI_TOPICS === 'true',
  };

  if (stats.disabled) {
    lastStats = stats;
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  const allCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  stats.triaged = allCandidates.filter(c => c && c.llm_triage && c.llm_triage.decision).length;
  const adopted = allCandidates
    .filter(isConnectable)
    .sort((a, b) => {
      const highDiff = Number(b.article_potential === 'high') - Number(a.article_potential === 'high');
      return highDiff || (Number(b.score) || 0) - (Number(a.score) || 0);
    });
  stats.adopted = adopted.length;

  const topics = [];
  for (const candidate of adopted) {
    const file = sourceFileFor(candidate, sourceRoot);
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
  isConnectable,
  MACRO_BY_PERSONA,
  CATEGORY_BY_TAX_CATEGORY,
  TAX_DOMAIN_BY_CODE,
  CANDIDATE_FILE,
  SOURCE_ROOT,
};
