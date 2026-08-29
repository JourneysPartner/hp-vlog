'use strict';
/**
 * 検索サジェスト由来の記事候補（段階3改）
 *
 * 「世の中で実際に検索されている語」を需要の証拠として持つ候補を、
 * data/search-suggest-topics.json から日次生成プールに接続する。
 *
 * なぜ必要か:
 *   当サイトはまだアクセスがほぼ無く、Search Console に貯まる自サイトの
 *   検索実測は分母として機能しない。Google サジェスト（検索窓の補完＝実際に
 *   打ち込まれている語）から候補を起こし、検索需要の側から記事を作る。
 *
 * データは scripts/update-suggest-topics.js（週次 workflow）が作り、
 * 選別結果は PR として人の検収を経てマージされる。ここでは読み込みと
 * 妥当性確認だけを行う。
 */

const fs = require('fs');
const path = require('path');
const { MACRO_BY_PERSONA } = require('./shitsugi-topics');

const ROOT = path.join(__dirname, '..', '..');
const TOPICS_FILE = path.join(ROOT, 'data', 'search-suggest-topics.json');

// 候補が名乗れる値の一覧。選別 LLM の出力はここに無い値を使えない。
const ALLOWED_TAX_DOMAINS = new Set([
  'consumption_tax', 'income_tax', 'invoice_system', 'bookkeeping_expenses',
  'inheritance_tax', 'overseas_transactions', 'withholding',
]);
const ALLOWED_CATEGORIES = new Set([
  '消費税', 'インボイス', '帳簿・経費', '所得税', '相続', '海外取引', '源泉徴収', '法人税',
]);
const ALLOWED_ARTICLE_TYPES = new Set(['basic_explainer', 'comparison_decision', 'case_study']);

// 需要の証拠の点数: 裏づけになった検索語の数が多いほど高い。
// 70始まり（質疑応答候補の最低点と同じ水準）、上限90（質疑応答の最高点91の直下）。
function scoreForPhrases(phraseCount) {
  return Math.min(90, 70 + 4 * Math.max(0, phraseCount - 1));
}

let lastStats = { total: 0, included: 0, invalid: 0, disabled: false };

function validateTopic(t) {
  if (!t || typeof t !== 'object') return '形式が不正';
  if (!/^suggest-[a-z0-9-]+$/.test(String(t.slug || ''))) return 'slug が不正';
  if (!MACRO_BY_PERSONA[t.persona]) return `persona が不明 (${t.persona})`;
  if (!ALLOWED_TAX_DOMAINS.has(t.tax_domain)) return `tax_domain が不明 (${t.tax_domain})`;
  if (!ALLOWED_CATEGORIES.has(t.category)) return `category が不明 (${t.category})`;
  if (!ALLOWED_ARTICLE_TYPES.has(t.article_type)) return `article_type が不明 (${t.article_type})`;
  if (!Array.isArray(t.phrases) || t.phrases.length === 0) return '検索語の裏づけが無い';
  if (!t.primary_question || !t.reader_problem) return '企画メタが不足';
  return null;
}

/** data ファイルの候補1件を、日次生成プールのトピック形式へ変換する */
function toPoolTopic(t) {
  return {
    slug: t.slug,
    title: '',
    macro: MACRO_BY_PERSONA[t.persona],
    persona: t.persona,
    article_type: t.article_type,
    category: t.category,
    tax_domain: t.tax_domain,
    cluster: `suggest-${t.tax_domain}`,
    subcluster: t.slug,
    pain_point: t.slug,
    // 出典は持たせない。既存の出典解決（対応表→照合→LLM選定→ガード）に委ねる。
    search_intent: t.phrases.join(' '),
    reader_problem: t.reader_problem,
    primary_question: t.primary_question,
    // success_outcome は記事バリデーションの必須項目（未設定だと承認後に ERROR）。
    // 選別時に用意されていればそれを使い、無ければ読者の問いから組み立てる。
    success_outcome: t.success_outcome
      || `${String(t.primary_question || '').replace(/[？?]$/, '')}がわかり、自分のケースで判断できる`,
    demand_evidence: {
      kind: 'search-suggest',
      score: scoreForPhrases(t.phrases.length),
      phrases: t.phrases.slice(0, 10),
    },
  };
}

function expandSuggestTopics(options = {}) {
  const logger = options.logger === undefined ? console : options.logger;
  const topicsFile = options.topicsFile || TOPICS_FILE;
  const stats = { total: 0, included: 0, invalid: 0, disabled: process.env.DISABLE_SUGGEST_TOPICS === 'true' };

  if (stats.disabled) {
    lastStats = stats;
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(topicsFile, 'utf8'));
  } catch (error) {
    // ファイルが無い（まだ一度も選別していない）のは正常。壊れている場合だけ警告。
    if (error.code !== 'ENOENT' && logger && typeof logger.warn === 'function') {
      logger.warn(`[suggest-topics] 読込失敗（候補なしで続行）: ${error.message}`);
    }
    lastStats = stats;
    return [];
  }

  const list = Array.isArray(parsed.topics) ? parsed.topics : [];
  stats.total = list.length;
  const out = [];
  for (const t of list) {
    const problem = validateTopic(t);
    if (problem) {
      stats.invalid++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[suggest-topics] ${(t && t.slug) || '不明'} をスキップ: ${problem}`);
      }
      continue;
    }
    out.push(toPoolTopic(t));
  }
  stats.included = out.length;
  lastStats = stats;
  return out;
}

function getLastSuggestStats() {
  return { ...lastStats };
}

module.exports = {
  expandSuggestTopics,
  getLastSuggestStats,
  validateTopic,
  toPoolTopic,
  scoreForPhrases,
  ALLOWED_TAX_DOMAINS,
  ALLOWED_CATEGORIES,
  ALLOWED_ARTICLE_TYPES,
  TOPICS_FILE,
};
