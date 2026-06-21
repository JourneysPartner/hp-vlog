'use strict';

/**
 * 国税庁ソース DB（data/nta-sources/）への保存・読込
 *
 * ファイルレイアウト:
 *   data/nta-sources/
 *     taxanswer/<category>/<id>.json
 *     shitsugi/<category>/<section>/<id>.json   ← C-3 で使用
 *     index.json                                 ← C-5 で生成
 *     meta.json                                  ← C-5 で生成
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NTA_SOURCES_DIR = path.join(ROOT, 'data', 'nta-sources');

// ── ディレクトリ確保 ──────────────────────────────────────────
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ── 共通の安全な JSON 書き込み ───────────────────────────────
function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ── タックスアンサー ──────────────────────────────────────────
function taxAnswerPath(categoryCode, id) {
  return path.join(NTA_SOURCES_DIR, 'taxanswer', categoryCode, `${id}.json`);
}

/**
 * タックスアンサーエントリを保存する。
 *
 * @param {Object} entry parseTaxAnswerHtml の戻り値 + fetched_at / html_hash / byte_size
 * @returns {string} 保存先ファイルパス
 */
function saveTaxAnswerEntry(entry) {
  if (!entry || !entry.id || !entry.tax_category_code) {
    throw new Error('saveTaxAnswerEntry: id / tax_category_code が必須');
  }
  const filePath = taxAnswerPath(entry.tax_category_code, entry.id);
  writeJsonAtomic(filePath, entry);
  return filePath;
}

function loadTaxAnswerEntry(categoryCode, id) {
  return readJson(taxAnswerPath(categoryCode, id));
}

// ── 全エントリ一覧（後続 Phase で使用） ──────────────────────
function listTaxAnswerEntries(categoryCode) {
  const dir = path.join(NTA_SOURCES_DIR, 'taxanswer', categoryCode);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

// ── 質疑応答事例（C-3 で使用） ────────────────────────────────
function shitsugiPath(categoryCode, section, id) {
  return path.join(NTA_SOURCES_DIR, 'shitsugi', categoryCode, String(section).padStart(2, '0'), `${id}.json`);
}

function saveShitsugiEntry(entry) {
  if (!entry || !entry.id || !entry.tax_category_code || !entry.section) {
    throw new Error('saveShitsugiEntry: id / tax_category_code / section が必須');
  }
  const filePath = shitsugiPath(entry.tax_category_code, entry.section, entry.id);
  writeJsonAtomic(filePath, entry);
  return filePath;
}

module.exports = {
  NTA_SOURCES_DIR,
  ensureDir,
  writeJsonAtomic,
  readJson,
  taxAnswerPath,
  saveTaxAnswerEntry,
  loadTaxAnswerEntry,
  listTaxAnswerEntries,
  shitsugiPath,
  saveShitsugiEntry,
};
