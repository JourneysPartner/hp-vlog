'use strict';

/**
 * ローカルの国税庁カタログから、topic に近いタックスアンサーを決定論で順位付けする。
 * ネットワークには接続しない。カタログ障害は例外を外へ出さず fail-closed で返す。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_INDEX_PATH = path.join(ROOT, 'data', 'nta-sources', 'index.json');

const TAX_CATEGORY_CODES = Object.freeze({
  consumption_tax: ['shohi'],
  income_tax: ['shotoku'],
  withholding: ['gensen', 'shotoku'],
  bookkeeping_expenses: ['shotoku'],
  invoice_system: ['shohi'],
  inheritance_tax: ['sozoku', 'zoyo', 'hyoka'],
  overseas_transactions: ['shohi'],
});

const STOP_WORDS = new Set([
  'について', '場合', 'とは', '制度', '取扱い', '取り扱い', '取扱', '方法', '手続', '手続き',
  '消費税', '所得税', '相続税', '贈与税', '法人税', '源泉所得税', '国税庁', 'タックスアンサー',
  'こと', 'もの', 'ため', 'など', '等', '及び', 'または', 'より', 'よる', 'する', 'した', 'して',
  'the', 'and', 'for', 'with', 'from', 'tax',
]);

const INSTITUTION_TERMS = [
  '高額特定資産', '簡易課税', '事業区分', 'みなし仕入率', '納税義務', '仕入税額控除',
  '課税売上割合', '個別対応方式', '一括比例配分方式', '居住用賃貸建物', '適格請求書',
  'インボイス', '輸出取引', '国外事業者', '特定課税仕入れ', '特定役務', '軽減税率',
  '小規模宅地', '配偶者控除', '相続時精算課税', '住宅取得等資金', '源泉徴収',
  '減価償却', '必要経費', '青色申告', '白色申告', '事業所得',
];

const PAIN_ALIASES = Object.freeze({
  'high-value-asset-3year-restriction': ['高額特定資産', '納税義務', '免除', '特例'],
  'simplified-tax-business-category': ['簡易課税', '事業区分', 'みなし仕入率'],
  'consumption-tax-judgement': ['納税義務', '免税', '課税事業者', '簡易課税'],
  'taxable-sales-ratio': ['課税売上割合'],
  'individual-vs-proportional-method': ['個別対応方式', '一括比例配分方式'],
  'residential-rental-input-tax-restriction': ['居住用賃貸建物', '仕入税額控除'],
  'travel-expense-input-tax': ['旅費', '交通費', '仕入税額控除'],
});

// 出典探しに使う記事側の項目。
// tax_terms は、記事を書く前に作る概要から入る（generate-draft.js の buildOutline）。
// 企画の言葉は「読者の場面のことば」（オンライン講座・セット販売）で、
// 国税庁ページは「税務の概念のことば」（前受金・譲渡等の時期）で書かれているため、
// 企画の言葉だけでは概念に届かない。その橋渡しをするのが tax_terms。
//
// 章立てそのものは入れない。実測すると章立ては雑音の方が多く、
// 論点語だけを渡したとき1位だった正解が、章立ても渡すと4位まで下がった。
const TOPIC_TEXT_FIELDS = [
  'search_intent', 'primary_question', 'reader_problem', 'topic', 'pain_point', 'subcluster',
  'tax_terms',
];

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function addToken(out, token) {
  const t = normalizeText(token).trim();
  if (!t || t.length < 2 || STOP_WORDS.has(t)) return;
  out.add(t);
}

/** matcher 専用トークナイザ。漢字連続は語全体と 2-gram の両方を返す。 */
function tokenizeForMatcher(value) {
  const text = normalizeText(value);
  const out = new Set();

  for (const m of text.matchAll(/[\p{Script=Han}々ヶ]+/gu)) {
    const word = m[0];
    addToken(out, word);
    if (word.length >= 2) {
      for (let i = 0; i < word.length - 1; i++) addToken(out, word.slice(i, i + 2));
    }
  }
  for (const m of text.matchAll(/[\p{Script=Katakana}ー]+/gu)) addToken(out, m[0]);
  for (const m of text.matchAll(/[a-z0-9]+/g)) addToken(out, m[0]);

  return out;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

function topicText(topic) {
  return TOPIC_TEXT_FIELDS.map(k => topic && topic[k]).filter(Boolean).join(' ');
}

function matchingInstitutions(topicRaw, titleRaw) {
  const topicNorm = normalizeText(topicRaw);
  const titleNorm = normalizeText(titleRaw);
  const wanted = INSTITUTION_TERMS.filter(term => topicNorm.includes(normalizeText(term)));
  if (wanted.length === 0) return 0;
  const matched = wanted.filter(term => titleNorm.includes(normalizeText(term))).length;
  return matched / wanted.length;
}

function painKeywords(topic) {
  const pain = String((topic && (topic.pain_point || topic.pain)) || '');
  const aliases = PAIN_ALIASES[pain] || [];
  return new Set([
    ...tokenizeForMatcher(pain),
    ...aliases.flatMap(v => [...tokenizeForMatcher(v)]),
  ]);
}

function keywordCoverage(keywords, titleTokens) {
  if (!keywords.size) return 0;
  let matched = 0;
  for (const token of keywords) if (titleTokens.has(token)) matched++;
  return matched / keywords.size;
}

// ── 語の珍しさ（出典探しの採点で使う）──────────────────────────
// 「課税」は672ページ中360ページに出てくるので、記事と出典ページでこの語が
// 一致してもそのページを選ぶ理由にならない。「前受金」は3ページにしか出ない
// ので、一致すれば強い手がかりになる。この差を採点に反映させる。
// 表は scripts/build-nta-token-df.js が作る。無ければ珍しさを使わず従来どおり動く。
const TOKEN_DF_PATH = path.join(__dirname, '..', '..', 'data', 'nta-sources', 'token-df.json');
let _tokenDf; // { docs, min_df, df } | null

function loadTokenDf() {
  if (_tokenDf !== undefined) return _tokenDf;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKEN_DF_PATH, 'utf8'));
    _tokenDf = (parsed && parsed.df && parsed.docs > 0) ? parsed : null;
  } catch (_) {
    _tokenDf = null;
  }
  return _tokenDf;
}

/** テスト用に珍しさ表を差し替える。null を渡すと珍しさを使わない状態にできる。 */
function setTokenDfForTest(table) { _tokenDf = table === undefined ? undefined : table; }

function rarityOf(token, table) {
  // 表に無い語は min_df 未満、つまり最も珍しい部類として扱う。
  const n = table.df[token] || (table.min_df - 1);
  return Math.log(table.docs / n);
}

/**
 * 記事側の語のうち、珍しい語ほど重く数えて、何割がページ名に含まれるかを返す。
 * 語の重なり割合（jaccard）と違い、渡す語が増えても薄まりにくい。
 */
function rarityCoverage(topicTokens, titleTokens, table) {
  if (!table || !topicTokens.size) return 0;
  let hit = 0;
  let total = 0;
  for (const token of topicTokens) {
    const w = rarityOf(token, table);
    total += w;
    if (titleTokens.has(token)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

// 語の重なり割合と珍しさ重視の混ぜ具合。人が出典を確定した57記事で測って決めた。
const RARITY_WEIGHT = 0.3;

function roundScore(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;
}

// 使用禁止の出典（制度の入口ページ・税目全体の総論ページ）は候補にも載せない。
// 候補に残っていると、論点に合うページが無いときに LLM がそれを選んでしまい、
// 総論の本文がそのまま記事の根拠になる。tax-authority-refs との循環を避けるため
// 遅延読み込みし、読めなければ従来どおり全件を候補にする。
let _isDenied = null;
function isDeniedUrl(url) {
  if (_isDenied === null) {
    try {
      _isDenied = require('./tax-authority-refs').isDeniedSource;
    } catch (_error) {
      _isDenied = () => false;
    }
  }
  try { return _isDenied(url); } catch (_error) { return false; }
}

function unavailable(errorCode = 'catalog_unavailable') {
  return { candidates: [], top1: null, top2: null, margin: 0, errorCode };
}

function loadEntries(indexPath) {
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error('invalid catalog shape');
  return parsed.entries;
}

/**
 * 採用可否に関係なく上位5件を返す。
 * テスト用に options.entries / options.indexPath を受けられるが、通常は topic のみを渡す。
 */
function rankSources(topic = {}, options = {}) {
  try {
    // allCategories=true のときは税目カテゴリの縛りを外し、taxanswer 全体から探す。
    // LLM 出典選定の「C（深掘り）」で、税目カテゴリ外の正本（例: bookkeeping_expenses
    // の論点に対する hojin/5433）も候補に載せるために使う。
    const allCategories = options.allCategories === true;
    const categories = TAX_CATEGORY_CODES[topic.tax_domain];
    if (!allCategories && (!Array.isArray(categories) || categories.length === 0)) return unavailable();

    const entries = Array.isArray(options.entries)
      ? options.entries
      : loadEntries(options.indexPath || DEFAULT_INDEX_PATH);
    const pool = entries.filter(entry => entry && entry.type === 'taxanswer' && entry.deleted !== true
      && entry.title && entry.url
      && (allCategories || categories.includes(entry.tax_category_code)))
      .filter(entry => !isDeniedUrl(entry.url));
    if (pool.length === 0) return unavailable();

    const raw = topicText(topic);
    const topicTokens = tokenizeForMatcher(raw);
    const painTokens = painKeywords(topic);
    const tokenDf = options.tokenDf !== undefined ? options.tokenDf : loadTokenDf();
    const candidates = pool.map(entry => {
      const titleTokens = tokenizeForMatcher(entry.title);
      const title_overlap = jaccard(topicTokens, titleTokens);
      // 語の重なり割合だけだと、渡す語が増えたとき肝心の一語が薄まる。
      // 珍しい語ほど重く数える指標を混ぜて、その薄まりを補う。
      const rarity_hit = rarityCoverage(topicTokens, titleTokens, tokenDf);
      const similarity = tokenDf
        ? title_overlap * (1 - RARITY_WEIGHT) + rarity_hit * RARITY_WEIGHT
        : title_overlap;
      const institution_hit = matchingInstitutions(raw, entry.title);
      const pain_keyword_hit = keywordCoverage(painTokens, titleTokens);
      const score = roundScore(similarity * 0.6 + institution_hit * 0.3 + pain_keyword_hit * 0.1);
      return {
        no: String(entry.id || entry.no || ''),
        title: entry.title,
        url: entry.url,
        tax_category_code: entry.tax_category_code,
        score,
      };
    }).sort((a, b) => b.score - a.score
      || a.no.localeCompare(b.no, 'en', { numeric: true })
      || a.url.localeCompare(b.url));

    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5;
    const top = candidates.slice(0, limit);
    const top1 = top[0] || null;
    const top2 = top[1] || null;
    const margin = top1 ? roundScore(top1.score - (top2 ? top2.score : 0)) : 0;
    return { candidates: top, top1, top2, margin, errorCode: null };
  } catch (_error) {
    return unavailable();
  }
}

function selectSource(ranking) {
  if (!ranking || ranking.errorCode || !ranking.top1) return null;
  if (ranking.top1.score < 0.45 || ranking.margin < 0.12) return null;
  return {
    url: ranking.top1.url,
    title: ranking.top1.title,
    no: ranking.top1.no,
    tax_category_code: ranking.top1.tax_category_code,
    confidence: ranking.top1.score,
    margin: ranking.margin,
  };
}

module.exports = {
  TAX_CATEGORY_CODES,
  STOP_WORDS,
  INSTITUTION_TERMS,
  DEFAULT_INDEX_PATH,
  tokenizeForMatcher,
  rankSources,
  rarityCoverage,
  setTokenDfForTest,
  RARITY_WEIGHT,
  selectSource,
};

