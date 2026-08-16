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
  const { entry: expected, byPain, trusted } = expectedSourceFor(topic);

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
        : `出典の由来が未確認（source_provenance=${provenance}）`,
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

module.exports = { sourceFamily, sourcePage, expectedSourceFor, checkSourceAlignment };
