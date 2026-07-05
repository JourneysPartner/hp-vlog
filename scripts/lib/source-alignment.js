'use strict';

/**
 * 出典一致ゲート（source alignment）
 *
 * 「税目が近いだけ」の出典を主出典に使うのを防ぐ。primary_source は記事の
 * 主論点そのものと一致している必要がある。
 *
 * 判定は 2 段階:
 *   1) カテゴリ（国税庁URLのセクション: sozoku/zoyo/hyoka/shohi/shotoku/gensen）
 *      が期待と違う → 強い不一致（税目カテゴリ違い。例: 相続税申告要否の記事に
 *      贈与税ページ、リバースチャージ記事に相続税ページ）。
 *   2) 同カテゴリでも、pain_point に対応する「期待される具体ページ」と別ページ
 *      → 弱い不一致（同じ消費税でも 主論点と別の No。例: 小規模宅地の記事に
 *      基礎控除ページ、リバースチャージ記事に納税義務免除ページ）。
 *
 * 期待出典は tax-authority-refs.js の DEFAULT_SOURCE_BY_PAIN / _BY_TAX_DOMAIN を
 * 唯一の情報源とする（番号を新たに捏造しない）。
 */

const {
  DEFAULT_SOURCE_BY_PAIN, DEFAULT_SOURCE_BY_TAX_DOMAIN, NEEDS_SOURCE_REVIEW,
} = require('./tax-authority-refs');

// 国税庁URL → カテゴリ（セクション）
function sourceFamily(url = '') {
  if (!url) return '';
  if (!/nta\.go\.jp/.test(url)) return 'external';
  const m = url.match(/\/(sozoku|zoyo|hyoka|shohi|shotoku|gensen|josetsu)\//);
  if (m) return m[1];
  if (/invoice|keigenzeiritsu/.test(url)) return 'shohi'; // インボイス特設は消費税
  return 'nta_other';
}

// 国税庁URL → ページ識別（同カテゴリ内での具体ページ比較用）
function sourcePage(url = '') {
  try {
    const path = url.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
    return path.replace(/\/$/, '');
  } catch { return url; }
}

// topic の「期待される出典」を返す（pain 優先 → tax_domain）
function expectedSourceFor(topic = {}) {
  const painId = topic.pain_point || topic.pain || '';
  const taxDomain = topic.tax_domain || '';
  if (painId && DEFAULT_SOURCE_BY_PAIN[painId]) {
    return { entry: DEFAULT_SOURCE_BY_PAIN[painId], byPain: true };
  }
  if (taxDomain && DEFAULT_SOURCE_BY_TAX_DOMAIN[taxDomain]) {
    return { entry: DEFAULT_SOURCE_BY_TAX_DOMAIN[taxDomain], byPain: false };
  }
  return { entry: null, byPain: false };
}

/**
 * @returns {{aligned:boolean, score:number(1-5), severity:'ok'|'soft'|'hard'|'unknown',
 *            expectedTitle:string, reason:string}}
 */
function checkSourceAlignment(topic = {}) {
  const url = topic.source_url || '';
  const pain = topic.pain_point || topic.pain || '';

  // 個別出典を確定できない論点は、汎用フォールバックで score=5 にせず revise 扱い。
  if (pain && NEEDS_SOURCE_REVIEW && NEEDS_SOURCE_REVIEW.has(pain)) {
    return { aligned: false, score: 3, severity: 'soft', expectedTitle: '',
      reason: 'この論点は個別出典が未確定（tax_domain 汎用出典のため要確認）' };
  }

  const { entry: expected, byPain } = expectedSourceFor(topic);

  if (!url) {
    return { aligned: false, score: 2, severity: 'soft', expectedTitle: expected ? expected.title : '', reason: '出典が未設定' };
  }
  if (!expected) {
    return { aligned: true, score: 3, severity: 'unknown', expectedTitle: '', reason: '期待出典を判定できない（pain/tax_domain 未登録）' };
  }

  const ef = sourceFamily(expected.url);
  const af = sourceFamily(url);

  if (af === 'external') {
    return { aligned: false, score: 2, severity: 'soft', expectedTitle: expected.title, reason: '出典が国税庁体系外' };
  }
  // どちらかがセクション判別不可（国税庁だが taxanswer 外の一般ページ等）は
  // 断定せず不明扱い（hard にしない＝誤検知を避ける）。
  if (af === 'nta_other' || ef === 'nta_other') {
    return { aligned: true, score: 3, severity: 'unknown', expectedTitle: expected.title, reason: '出典のカテゴリを判別できない' };
  }
  if (af !== ef) {
    return {
      aligned: false, score: 1, severity: 'hard', expectedTitle: expected.title,
      reason: `税目カテゴリ不一致（期待:${ef} / 実際:${af}）主出典が主論点と別税目`,
    };
  }
  // 同カテゴリ。pain 特定の期待ページと別ページなら弱い不一致
  if (byPain && sourcePage(expected.url) !== sourcePage(url)) {
    return {
      aligned: false, score: 3, severity: 'soft', expectedTitle: expected.title,
      reason: `主論点の出典と不一致（期待: ${expected.title}）`,
    };
  }
  return { aligned: true, score: 5, severity: 'ok', expectedTitle: expected.title, reason: '' };
}

module.exports = {
  sourceFamily,
  sourcePage,
  expectedSourceFor,
  checkSourceAlignment,
};
