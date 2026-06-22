'use strict';

/**
 * n-gram 転載検知
 *
 * Phase D: 質疑応答事例ベース記事（source_type === "nta_shitsugi"）の
 * 本文が国税庁原文と「連続 3 文以上一致」しているかを検出する。
 *
 * 初期実装の仕様:
 *   - 文区切り: 「。」「？」「！」（全角）
 *   - 連続 3 文一致 → FAIL
 *   - 短い文（10 文字未満）は除外（決まり文句の誤検知防止）
 *   - 全角・半角の正規化後に比較
 *   - 国税庁原文は data/nta-sources/ から URL で逆引き
 *
 * 将来拡張（C-7 後の Phase 拡張で検討）:
 *   - 50 文字以上の長文一致 → warning（連続 1 文でも）
 *   - 編集距離・コサイン類似度による高類似文検知
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NTA_SOURCES_DIR = path.join(ROOT, 'data', 'nta-sources');

const MIN_SENTENCE_LENGTH = 10;        // 1 文の最低文字数（これ未満は決まり文句として除外）
const NGRAM_THRESHOLD = 3;              // 連続 N 文一致で FAIL

// ── 文区切り ───────────────────────────────────────────────────
// 句点・疑問符・感嘆符を区切りに使う。区切り文字自体は文末に残す。
function splitSentences(text) {
  if (!text) return [];
  // 全角・半角の正規化
  const normalized = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[　]/g, ' ')           // 全角スペースを半角に
    .replace(/\s+/g, ' ')                // 連続空白を 1 つに
    .trim();
  // 句点等で分割（区切り文字を保持）
  const sentences = [];
  const re = /[^。？！\n]+[。？！]|[^。？！\n]+$/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
  }
  return sentences;
}

// ── 文の正規化（比較用、誤検知防止のため緩く正規化）──────────
// HTML タグや太字マーク <strong>...</strong> を除去
// 連続空白の正規化のみ。記号は保持（誤検知防止）。
function normalizeForCompare(sentence) {
  return String(sentence)
    .replace(/<\/?strong>/gi, '')
    .replace(/\s+/g, '')
    .trim();
}

// ── n-gram 一致検出 ─────────────────────────────────────────────
/**
 * @param {string} articleBody 検査対象の記事本文
 * @param {string} sourceBody  国税庁原文
 * @returns {Object} { matched: bool, overlaps: [{ sentences: string[], length, indexInArticle, indexInSource }] }
 */
function find3GramOverlap(articleBody, sourceBody) {
  const article = splitSentences(articleBody);
  const source  = splitSentences(sourceBody);

  // 正規化版でインデックス化（短文除外）
  const articleNorm = article.map(normalizeForCompare);
  const sourceNorm  = source.map(normalizeForCompare);

  const overlaps = [];
  // article の各位置から、source 全位置と「連続一致を伸ばせるだけ伸ばす」
  for (let i = 0; i <= article.length - NGRAM_THRESHOLD; i++) {
    // 短文除外: 先頭が短いなら skip
    if (articleNorm[i].length < MIN_SENTENCE_LENGTH) continue;

    for (let j = 0; j <= source.length - NGRAM_THRESHOLD; j++) {
      // 先頭一致しなければ skip
      if (articleNorm[i] !== sourceNorm[j]) continue;
      // 連続一致を伸ばす
      let k = 0;
      while (
        i + k < article.length &&
        j + k < source.length &&
        articleNorm[i + k] === sourceNorm[j + k]
      ) {
        k++;
      }
      if (k >= NGRAM_THRESHOLD) {
        // 3 文すべてが MIN_SENTENCE_LENGTH 以上であることを確認
        let allLong = true;
        for (let x = 0; x < k; x++) {
          if (articleNorm[i + x].length < MIN_SENTENCE_LENGTH) {
            allLong = false;
            break;
          }
        }
        if (allLong) {
          overlaps.push({
            sentences: article.slice(i, i + k),
            length: k,
            indexInArticle: i,
            indexInSource: j,
          });
        }
        // 重複検出を避けるため i を進める
        i += k - 1;
        break;
      }
    }
  }

  return { matched: overlaps.length > 0, overlaps };
}

// ── 国税庁ソース JSON の URL 逆引き ─────────────────────────────
// data/nta-sources/index.json を読み、URL → file_path を逆引きする。
// パフォーマンスのため初回読込結果をキャッシュ。
let _urlIndex = null;
function loadUrlIndex() {
  if (_urlIndex) return _urlIndex;
  const indexPath = path.join(NTA_SOURCES_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    _urlIndex = new Map();
    return _urlIndex;
  }
  const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  _urlIndex = new Map();
  for (const e of data.entries || []) {
    if (e.url && e.file_path) {
      _urlIndex.set(e.url, e.file_path);
    }
  }
  return _urlIndex;
}

// テスト用：キャッシュをクリア
function _resetUrlIndexCache() {
  _urlIndex = null;
}

// URL から本文（n-gram 用）を取得する。
// taxanswer は body、shitsugi は body_combined を返す。
// 見つからなければ null。
function loadSourceBodyByUrl(url) {
  const idx = loadUrlIndex();
  const filePath = idx.get(url);
  if (!filePath) return null;
  const fullPath = path.join(NTA_SOURCES_DIR, filePath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    return data.body_combined || data.body || null;
  } catch (e) {
    return null;
  }
}

// ── トップレベル：記事 frontmatter + body から検査 ────────────
/**
 * @param {Object} frontmatter parseFrontmatter 済の meta
 * @param {string} articleBody 記事本文（frontmatter 除く）
 * @returns {Object} { sourceFound: bool, results: [{ url, matched, overlaps }] }
 */
function checkNgramOverlapForArticle(frontmatter, articleBody) {
  // 検査対象 URL は source_url + supporting_source_urls
  const urls = [];
  if (frontmatter.source_url) urls.push(frontmatter.source_url);
  const supp = frontmatter.supporting_source_urls;
  if (Array.isArray(supp)) {
    for (const u of supp) if (typeof u === 'string' && u) urls.push(u);
  }

  const results = [];
  let anySourceFound = false;
  for (const url of urls) {
    const body = loadSourceBodyByUrl(url);
    if (!body) {
      results.push({ url, sourceFound: false, matched: false, overlaps: [] });
      continue;
    }
    anySourceFound = true;
    const r = find3GramOverlap(articleBody, body);
    results.push({ url, sourceFound: true, ...r });
  }

  return { sourceFound: anySourceFound, results };
}

module.exports = {
  MIN_SENTENCE_LENGTH,
  NGRAM_THRESHOLD,
  splitSentences,
  normalizeForCompare,
  find3GramOverlap,
  loadSourceBodyByUrl,
  checkNgramOverlapForArticle,
  _resetUrlIndexCache,
};
