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

// ── DB の記録の一覧（段 2） ───────────────────────────────────
// taxanswer/<分類>/<id>.json と shitsugi/<分類>/<節>/<id>.json だけを、
// file_path（index.json と同じ `/` 区切り）の順で返す。中身は読まない。
// 深さが違うもの・.json で終わらないもの・images/・index.json・meta.json・
// token-df.json は返さない。
function listRecordKeys(rootDir = NTA_SOURCES_DIR) {
  const results = [];
  const readDir = dir => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
  };
  const isFileJson = entry => entry.isFile() && entry.name.endsWith('.json');

  for (const categoryEntry of readDir(path.join(rootDir, 'taxanswer'))) {
    if (!categoryEntry.isDirectory()) continue;
    const category = categoryEntry.name;
    for (const fileEntry of readDir(path.join(rootDir, 'taxanswer', category))) {
      if (!isFileJson(fileEntry)) continue;
      const id = fileEntry.name.slice(0, -'.json'.length);
      results.push({
        type: 'taxanswer',
        category,
        id,
        file_path: `taxanswer/${category}/${fileEntry.name}`,
      });
    }
  }

  for (const categoryEntry of readDir(path.join(rootDir, 'shitsugi'))) {
    if (!categoryEntry.isDirectory()) continue;
    const category = categoryEntry.name;
    for (const sectionEntry of readDir(path.join(rootDir, 'shitsugi', category))) {
      if (!sectionEntry.isDirectory()) continue;
      const section = sectionEntry.name;
      for (const fileEntry of readDir(path.join(rootDir, 'shitsugi', category, section))) {
        if (!isFileJson(fileEntry)) continue;
        const id = fileEntry.name.slice(0, -'.json'.length);
        results.push({
          type: 'shitsugi',
          category,
          section,
          id,
          file_path: `shitsugi/${category}/${section}/${fileEntry.name}`,
        });
      }
    }
  }

  return results.sort((a, b) => (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0));
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
  listRecordKeys,
  shitsugiPath,
  saveShitsugiEntry,
};
