'use strict';

/** 出典一致ゲート。信頼済みの explicit / curated だけを aligned とする。 */

const { DEFAULT_SOURCE_BY_PAIN, NEEDS_SOURCE_REVIEW } = require('./tax-authority-refs');

function sourceFamily(url = '') {
  if (!url) return '';
  if (!/nta\.go\.jp/.test(url)) return 'external';
  const m = url.match(/\/(sozoku|zoyo|hyoka|shohi|shotoku|gensen|josetsu)\//);
  if (m) return m[1] === 'gensen' ? 'shotoku' : m[1];
  if (/invoice|keigenzeiritsu|\/pamph\/shohi\//.test(url)) return 'shohi';
  return 'nta_other';
}

function sourcePage(url = '') {
  try {
    const pathname = url.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
    return pathname.replace(/\/$/, '');
  } catch (_error) {
    return url;
  }
}

// ── 出典差し替え時のレガシー許容 ─────────────────────────────────
// 「期待する出典を新しいURLに移したが、旧URLの記事が既に公開済み」という
// ケースで、既存記事を書き換えずに済ませるための対応表。
// key: 新しい期待出典（現行）, value: 同等とみなす旧出典の集合
const LEGACY_EQUIVALENT_SOURCES = {
  // インボイス制度: 概要ページ → No.6498（2026-08-16 に差し替え）
  '/taxes/shiraberu/taxanswer/shohi/6498.htm': new Set([
    '/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm',
  ]),
};

function isLegacyEquivalent(expectedUrl, actualUrl) {
  const legacy = LEGACY_EQUIVALENT_SOURCES[sourcePage(expectedUrl)];
  return !!legacy && legacy.has(sourcePage(actualUrl));
}

// ── llm-auto を条件つきで信頼する ───────────────────────────────
//
// Luna（LLM）は自由に出典を選べるわけではなく、検証済みカタログから作った
// 候補リストの番号を選ぶだけ。実在しないページを出典にする事故は構造的に起きない。
// それでも一律で人の確認を必須にしていたため、対応表に無い論点の記事が
// すべて承認ブロックになっていた（2026-08-20 のリース／修繕費の2本）。
//
// 次を全て満たすときだけ信頼する:
//   1. 確信度が LLM_AUTO_MIN_CONFIDENCE 以上
//   2. URL がカタログ収録のタックスアンサーであること
//   3. カタログ上で削除されていないこと
//
// 「税目の一致」は条件にしない。リース取引のタックスアンサーは法人税にしか
// 存在せず（No.5700〜5705／消費税の No.6163 のみ）、個人事業主向けの記事でも
// 法人税のページを引くほかない。税目一致を必須にすると正しい選定を弾いてしまう。
// 代わりに、税目が記事と異なる場合は「ブロックしない注意書き」を残す。
const LLM_AUTO_MIN_CONFIDENCE = 0.9;

let _catalogIndex = null;
function catalogEntryFor(url) {
  if (_catalogIndex === null) {
    _catalogIndex = new Map();
    try {
      const idx = require('../../data/nta-sources/index.json');
      const list = Array.isArray(idx) ? idx : (idx.entries || idx.items || []);
      for (const e of list) {
        if (e && e.url) _catalogIndex.set(sourcePage(e.url), e);
      }
    } catch (_error) { /* カタログが無い環境では条件を満たさない扱いになる */ }
  }
  return _catalogIndex.get(sourcePage(url)) || null;
}

/**
 * llm-auto の出典が信頼できるかを判定する。
 * @returns {{ok: boolean, reason: string, entry: Object|null}}
 */
function evaluateLlmAutoSource(topic = {}) {
  const url = topic.source_url || '';
  const conf = Number(topic.source_confidence);
  if (!url) return { ok: false, reason: '出典が未設定', entry: null };
  if (!Number.isFinite(conf) || conf < LLM_AUTO_MIN_CONFIDENCE) {
    return { ok: false, reason: `LLM選定の確信度が低い（${Number.isFinite(conf) ? conf : '不明'} < ${LLM_AUTO_MIN_CONFIDENCE}）`, entry: null };
  }
  const entry = catalogEntryFor(url);
  if (!entry) return { ok: false, reason: 'LLM選定の出典がカタログ未収録', entry: null };
  if (entry.deleted === true) return { ok: false, reason: 'LLM選定の出典がカタログ上で削除済み', entry: null };
  return { ok: true, reason: '', entry };
}

// 記事の tax_domain と、タックスアンサーの税目カテゴリの対応。
// ここに載らない組み合わせは「注意書きを出すが承認はブロックしない」。
const DOMAIN_TO_TAX_CATEGORY = {
  income_tax: ['所得税', '源泉所得税', '譲渡所得'],
  bookkeeping_expenses: ['所得税', '法人税'],
  consumption_tax: ['消費税'],
  invoice_system: ['消費税'],
  inheritance_tax: ['相続税', '贈与税', '財産評価'],
  corporate_tax: ['法人税'],
};

/** 税目が記事と食い違う場合の注意書き（ブロックはしない） */
function taxCategoryNote(topic, entry) {
  if (!entry || !entry.tax_category) return '';
  const allowed = DOMAIN_TO_TAX_CATEGORY[topic.tax_domain];
  if (!allowed || allowed.includes(entry.tax_category)) return '';
  return `出典は${entry.tax_category}のページです（記事の税目: ${topic.tax_domain}）。個人事業者向けの記述として妥当か確認してください`;
}

function expectedSourceFor(topic = {}) {
  const painId = topic.pain_point || topic.pain || '';
  const provenance = topic.source_provenance || 'unknown';

  if (provenance === 'explicit' && topic.source_url) {
    return {
      entry: { url: topic.source_url, title: topic.source_title || topic.source_url },
      byPain: false,
      provenance,
      trusted: true,
    };
  }
  if (provenance === 'curated' && painId && DEFAULT_SOURCE_BY_PAIN[painId]) {
    return {
      entry: DEFAULT_SOURCE_BY_PAIN[painId],
      byPain: true,
      provenance,
      trusted: true,
    };
  }
  if (provenance === 'curated' && topic.source_url) {
    return {
      entry: { url: topic.source_url, title: topic.source_title || topic.source_url },
      byPain: false,
      provenance,
      trusted: true,
    };
  }
  if (provenance === 'llm-auto' && topic.source_url) {
    const judged = evaluateLlmAutoSource(topic);
    if (judged.ok) {
      return {
        entry: { url: topic.source_url, title: topic.source_title || topic.source_url },
        byPain: false,
        provenance,
        trusted: true,
        catalogEntry: judged.entry,
      };
    }
    return { entry: null, byPain: false, provenance, trusted: false, llmAutoReason: judged.reason };
  }
  return { entry: null, byPain: false, provenance, trusted: false };
}

function result(values) {
  return {
    aligned: false,
    score: 3,
    severity: 'soft',
    expectedTitle: '',
    reason: '',
    needs_source_review: true,
    provenance: 'unknown',
    ...values,
  };
}

function checkSourceAlignment(topic = {}) {
  const url = topic.source_url || '';
  const pain = topic.pain_point || topic.pain || '';
  const provenance = topic.source_provenance || 'unknown';
  const { entry: expected, byPain, trusted, catalogEntry, llmAutoReason } = expectedSourceFor(topic);

  if (!url) {
    return result({ score: 2, expectedTitle: expected ? expected.title : '', reason: '出典が未設定', provenance });
  }

  // 汎用fallbackや自動候補は、URLが偶然既定値と一致しても承認しない。
  if (!trusted) {
    const explicitlyHeld = pain && NEEDS_SOURCE_REVIEW && NEEDS_SOURCE_REVIEW.has(pain);
    return result({
      provenance,
      reason: explicitlyHeld
        ? 'この論点は個別出典が未確定（人による出典確認が必要）'
        : (llmAutoReason || `出典の由来が未確認（source_provenance=${provenance}）`),
    });
  }

  // llm-auto は候補リストからの選定であり、カタログ収録・未削除・高確信度を
  // 満たしたものだけがここに来る。現在のURL自体を正本とする。
  // 税目が記事と食い違う場合だけ、ブロックしない注意書きを添える。
  if (provenance === 'llm-auto') {
    const note = taxCategoryNote(topic, catalogEntry);
    return result({
      aligned: true, score: note ? 4 : 5, severity: 'ok',
      expectedTitle: expected.title, reason: note,
      needs_source_review: false, provenance,
    });
  }

  // explicit は人が指定した現在のURL自体を正本とする。
  if (provenance === 'explicit') {
    return result({ aligned: true, score: 5, severity: 'ok', expectedTitle: expected.title,
      reason: '', needs_source_review: false, provenance });
  }

  // 出典を差し替えた際、既に公開済みの記事まで「不一致」になるのを防ぐ。
  // 2026-08-16: インボイス制度の概要ページを使用禁止にし No.6498 へ移したが、
  // 概要ページを出典にした公開済み記事が15件あった。既存記事は変更しない方針
  // （公開済みの内容を後から書き換えない）のため、旧出典は同等として許容する。
  // ※新規生成では tax-authority-refs 側で概要ページが選ばれないので、
  //   この許容が新しい記事に効くことはない。
  if (isLegacyEquivalent(expected.url, url)) {
    return result({ aligned: true, score: 5, severity: 'ok', expectedTitle: expected.title,
      reason: '', needs_source_review: false, provenance });
  }

  const ef = sourceFamily(expected.url);
  const af = sourceFamily(url);
  if (af === 'external') {
    return result({ score: 2, expectedTitle: expected.title, reason: '出典が国税庁系外', provenance });
  }
  if (af === 'nta_other' || ef === 'nta_other') {
    if (sourcePage(expected.url) === sourcePage(url)) {
      return result({ aligned: true, score: 5, severity: 'ok', expectedTitle: expected.title,
        reason: '', needs_source_review: false, provenance });
    }
    return result({ expectedTitle: expected.title, reason: '主論点の出典と不一致', provenance });
  }
  if (af !== ef) {
    return result({
      score: 1,
      severity: 'hard',
      expectedTitle: expected.title,
      reason: `税目カテゴリ不一致（期待:${ef} / 実際:${af}）主出典が主論点と別税目`,
      provenance,
    });
  }
  if (byPain && sourcePage(expected.url) !== sourcePage(url)) {
    return result({ expectedTitle: expected.title,
      reason: `主論点の出典と不一致（期待: ${expected.title}）`, provenance });
  }
  return result({ aligned: true, score: 5, severity: 'ok', expectedTitle: expected.title,
    reason: '', needs_source_review: false, provenance });
}

module.exports = {
  LLM_AUTO_MIN_CONFIDENCE,
  evaluateLlmAutoSource,
  taxCategoryNote, sourceFamily, sourcePage, expectedSourceFor, checkSourceAlignment };
