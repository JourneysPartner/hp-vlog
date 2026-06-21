'use strict';

/**
 * data/nta-sources/ をスキャンして index.json と meta.json を生成する。
 *
 * index.json:
 *   全エントリの軽量サマリ。後続 Phase の retrieval に使う。
 *   - 各エントリの本文は含めない（個別 JSON を参照）
 *
 * meta.json:
 *   crawl の実行履歴メタ情報。
 *   - 直近の crawl 実績（fetched/skipped/deleted/errors）
 *   - 件数推移
 *   - 次回スケジュール
 */

const fs = require('fs');
const path = require('path');
const store = require('./nta-store');

const NTA_SOURCES_DIR = store.NTA_SOURCES_DIR;
const INDEX_FILE = path.join(NTA_SOURCES_DIR, 'index.json');
const META_FILE  = path.join(NTA_SOURCES_DIR, 'meta.json');

// ── ディレクトリ走査 ────────────────────────────────────────────
// data/nta-sources/<type>/ 以下の全 JSON ファイルを再帰的に列挙する。
// index.json と meta.json 自体は除外する。
function listJsonFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const results = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.json')) {
        // ルート直下の index.json / meta.json は除外
        if (path.dirname(full) === rootDir) continue;
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results.sort();
}

// ── エントリから軽量サマリを抽出 ───────────────────────────────
function buildIndexEntry(entry, fileAbsPath) {
  const relPath = path.relative(NTA_SOURCES_DIR, fileAbsPath).split(path.sep).join('/');
  return {
    id: entry.id,
    section: entry.section || null,  // shitsugi のみ
    type: entry.type,
    tax_category: entry.tax_category,
    tax_category_code: entry.tax_category_code,
    title: entry.title || null,
    url: entry.url,
    file_path: relPath,
    char_count_body: entry.char_count_body || 0,
    deleted: entry.deleted === true,
    fetched_at: entry.fetched_at || null,
    last_modified: entry.last_modified || null,
  };
}

// ── index.json 構築 ────────────────────────────────────────────
function buildIndex(options = {}) {
  const files = listJsonFiles(NTA_SOURCES_DIR);
  const entries = [];
  const byType = {};
  const byCategory = {};
  const errors = [];

  for (const f of files) {
    const data = store.readJson(f);
    if (!data || !data.id || !data.type) {
      errors.push({ file: path.relative(NTA_SOURCES_DIR, f), reason: 'invalid_entry' });
      continue;
    }
    const indexEntry = buildIndexEntry(data, f);
    entries.push(indexEntry);

    // 集計
    byType[data.type] = (byType[data.type] || 0) + 1;
    const cat = data.tax_category_code || 'unknown';
    if (!byCategory[cat]) byCategory[cat] = { taxanswer: 0, shitsugi: 0, total: 0 };
    if (data.type === 'taxanswer') byCategory[cat].taxanswer++;
    if (data.type === 'shitsugi')  byCategory[cat].shitsugi++;
    byCategory[cat].total++;
  }

  // 安定したソート: type → tax_category_code → section（あれば）→ id
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    if (a.tax_category_code !== b.tax_category_code) {
      return (a.tax_category_code || '').localeCompare(b.tax_category_code || '');
    }
    const aSec = a.section || '';
    const bSec = b.section || '';
    if (aSec !== bSec) return aSec.localeCompare(bSec);
    return (a.id || '').localeCompare(b.id || '');
  });

  const indexData = {
    version: 1,
    generated_at: options.now || new Date().toISOString(),
    total_count: entries.length,
    by_type: byType,
    by_category: byCategory,
    entries,
  };
  if (errors.length > 0) {
    indexData.build_errors = errors;
  }

  return indexData;
}

function saveIndex(indexData) {
  store.writeJsonAtomic(INDEX_FILE, indexData);
  return INDEX_FILE;
}

function loadIndex() {
  return store.readJson(INDEX_FILE);
}

// ── meta.json 構築 ─────────────────────────────────────────────
/**
 * 直近の crawl 実績を meta.json に保存する。
 *
 * @param {Object} params
 *   @param {string}   params.startedAt        ISO datetime
 *   @param {string}   params.finishedAt       ISO datetime
 *   @param {Object}   params.results          { fetched, skipped, deleted, errors[] }
 *   @param {Object}   params.byType           { taxanswer: {...}, shitsugi: {...} }
 *   @param {string}   [params.nextScheduledAt]
 * @returns {string} 保存先パス
 */
function saveMeta({ startedAt, finishedAt, results, byType, nextScheduledAt }) {
  const totalEntries = (results.fetched || 0) + (results.skipped || 0) + (results.deleted || 0);
  const durationMs = new Date(finishedAt) - new Date(startedAt);
  const meta = {
    version: 1,
    last_crawl_started_at: startedAt,
    last_crawl_finished_at: finishedAt,
    last_crawl_duration_seconds: Math.round(durationMs / 1000),
    crawl_results: {
      fetched: results.fetched || 0,
      skipped: results.skipped || 0,
      deleted: results.deleted || 0,
      errors_count: (results.errors || []).length,
    },
    by_type: byType || {},
    total_entries_processed: totalEntries,
    errors_sample: (results.errors || []).slice(0, 20),
    next_scheduled_at: nextScheduledAt || null,
  };
  store.writeJsonAtomic(META_FILE, meta);
  return META_FILE;
}

function loadMeta() {
  return store.readJson(META_FILE);
}

module.exports = {
  INDEX_FILE,
  META_FILE,
  listJsonFiles,
  buildIndexEntry,
  buildIndex,
  saveIndex,
  loadIndex,
  saveMeta,
  loadMeta,
};
