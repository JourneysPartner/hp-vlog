'use strict';

/**
 * タイトルの日本語自然さチェック。
 *
 * FAIL: 明らかな日本語崩れ・禁止フレーズ
 * WARN: やや硬い・長い・機械的
 *
 * 使い方:
 *   const { lintTitle } = require('./title-lint');
 *   const { fails, warns } = lintTitle(title, { article_type, macro });
 */

// 明らかな禁止フレーズ（FAIL）
const HARD_FAIL_PATTERNS = [
  /に押さえる/,
  /が直面するに/,
  /を判断するを/,
  /判断を判断/,
  /基本の基本/,
  /ポイントのポイント/,
  /整理を整理/,
  /\{[a-zA-Z_]+\}/,  // 未充足プレースホルダ
];

// 軽い不自然さ（WARN）
const SOFT_WARN_PATTERNS = [
  /における.{0,20}における/,
  /\(.{0,40}\)\(.{0,40}\)/,
  /[ぁ-んァ-ヶ一-鿿]の[ぁ-んァ-ヶ一-鿿]+の[ぁ-んァ-ヶ一-鿿]+の[ぁ-んァ-ヶ一-鿿]+の/,  // の が 4 連続
  /(？|\?).{0,2}(？|\?)/,  // 連続する疑問符
];

const MAX_LEN_FAIL = 80;
const MAX_LEN_WARN = 70;
const MIN_LEN_WARN = 16;

function countChar(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function lintTitle(title, ctx = {}) {
  const fails = [];
  const warns = [];

  if (!title || typeof title !== 'string') {
    return { fails: ['title is empty or not a string'], warns: [] };
  }

  // 1. 禁止フレーズ
  for (const re of HARD_FAIL_PATTERNS) {
    if (re.test(title)) fails.push(`禁止フレーズ: ${re}`);
  }
  for (const re of SOFT_WARN_PATTERNS) {
    if (re.test(title)) warns.push(`不自然パターン: ${re}`);
  }

  // 2. 長さ
  if (title.length > MAX_LEN_FAIL) fails.push(`長すぎ: ${title.length} > ${MAX_LEN_FAIL}`);
  else if (title.length > MAX_LEN_WARN) warns.push(`やや長い: ${title.length} > ${MAX_LEN_WARN}`);
  if (title.length < MIN_LEN_WARN) warns.push(`短すぎる: ${title.length} < ${MIN_LEN_WARN}`);

  // 3. 同一単語の重複（4文字以上の単語）
  const tokens = title.match(/[ぁ-んァ-ヶ一-鿿]{4,}/g) || [];
  const seen = new Set();
  for (const t of tokens) {
    if (seen.has(t)) { warns.push(`重複語句: "${t}"`); break; }
    seen.add(t);
  }

  // 3b. 同一名詞の繰り返し（3文字以上の漢字/カタカナのまとまり）
  // 「消費税の消費税課税事業者判定」「インボイス登録のインボイス対応」等の
  // slug 由来冗長表現が日本語化されたまま残るケースを fail として捕捉する。
  //
  // 単純な「同一トークン 2 回」では「消費税」と「消費税課税事業者判定」が
  // 別文字列扱いになって捕捉できないため、3 文字スライディング窓で
  // 「同じ 3-gram が 2 回以上出現」を判定する。
  // ただし、判定対象は漢字/カタカナのみを連結した文字列で行う
  // （ひらがな・記号を間に挟んだ繰り返しも検知できる）。
  //
  // 【誤検知対策】「課税事業者／免税事業者」のような正当な対比ペアは、
  // 共有する 3-gram（"税事業"・"事業者"）が 2 回出現するため、この窓では
  // 冗長表現と誤判定される。これらは slug 由来の同語反復ではなく自然な対比
  // なので、両方が揃っているときに限り走査対象から除去して中和する
  // （片方だけの重複は従来どおり検知する）。
  let scanTitle = title;
  if (/課税事業者/.test(scanTitle) && /免税事業者/.test(scanTitle)) {
    scanTitle = scanTitle.replace(/課税事業者/g, '').replace(/免税事業者/g, '');
  }
  const kanjiKataOnly = scanTitle.replace(/[^一-鿿ァ-ヶ]/g, '');
  const ngramCount = new Map();
  for (let i = 0; i + 3 <= kanjiKataOnly.length; i++) {
    const gram = kanjiKataOnly.slice(i, i + 3);
    ngramCount.set(gram, (ngramCount.get(gram) || 0) + 1);
  }
  for (const [gram, count] of ngramCount) {
    if (count >= 2) {
      fails.push(`同一名詞の繰り返し: "${gram}" を含む語が ${count} 回出現`);
      break;
    }
  }

  // 4. の の過剰連続
  const noCount = countChar(title, 'の');
  if (noCount > 5) warns.push(`「の」が多すぎ: ${noCount} 個`);

  // 5. 相続タイトル特有チェック
  if (ctx.macro === '相続贈与' && /に押さえる/.test(title)) {
    fails.push('相続タイトルに「に押さえる」が含まれている');
  }

  return { fails, warns };
}

/**
 * 一覧のタイトルを lint し、{fail件数, warn件数, samples} を返す
 */
function lintAll(topics) {
  let failCount = 0;
  let warnCount = 0;
  const failedSamples = [];
  const warnedSamples = [];

  for (const t of topics) {
    const r = lintTitle(t.title, { article_type: t.article_type, macro: t.macro });
    if (r.fails.length > 0) {
      failCount++;
      if (failedSamples.length < 5) failedSamples.push({ slug: t.slug, title: t.title, fails: r.fails });
    }
    if (r.warns.length > 0) {
      warnCount++;
      if (warnedSamples.length < 5) warnedSamples.push({ slug: t.slug, title: t.title, warns: r.warns });
    }
  }

  return { total: topics.length, failCount, warnCount, failedSamples, warnedSamples };
}

module.exports = {
  lintTitle,
  lintAll,
  HARD_FAIL_PATTERNS,
  SOFT_WARN_PATTERNS,
};
