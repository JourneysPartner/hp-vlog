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
    first_fetched_at: entry.first_fetched_at || null,
    content_changed_at: entry.content_changed_at || null,
    content_change_kind: entry.content_change_kind || null,
    as_of_changed_at: entry.as_of_changed_at || null,
    law_version: entry.law_version || null,
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
 *   @param {Object}   params.results          { fetched, skipped, deleted, deleted_still, deletion_held,
 *                                               restored, gone_unrecorded, errors[],
 *                                               unlisted?, unlisted_deleted_before? }
 *   @param {Object}   params.byType           { taxanswer: {...}, shitsugi: {...} }
 *   @param {string}   [params.nextScheduledAt]
 *   @param {number}   [params.maxDeletions]
 *   @param {Array}    [params.deletedEntries]          { type, url, title, file_path, reason }
 *   @param {Array}    [params.deletionHeldEntries]     { type, url, title, file_path, reason }
 *   @param {Array}    [params.restoredEntries]         { type, url, title }
 *   @param {Array}    [params.goneUnrecordedUrls]      URL の配列
 *   @param {Array}    [params.unlistedEntries]         { type, url, title, file_path, outcome, reason?, final_url? }
 *   @param {string}   [params.unlistedCheck]          done / skipped_filter / skipped_dry_run / skipped_too_many
 *   @param {number}   [params.unlistedCheckLimit]     一覧から外れた記録を訪ねる上限
 *   @param {string}   [params.metaFile]       テスト用の書き出し先（既定は meta.json）
 * @returns {string} 保存先パス
 */
function saveMeta({ startedAt, finishedAt, results = {}, byType, nextScheduledAt,
  maxDeletions, deletedEntries, deletionHeldEntries, restoredEntries, goneUnrecordedUrls,
  unlistedEntries, unlistedCheck, unlistedCheckLimit,
  metaFile = META_FILE }) {
  const fetched = results.fetched || 0;
  const skipped = results.skipped || 0;
  const deleted = results.deleted || 0;
  const deletedStill = results.deleted_still || 0;
  const deletionHeld = results.deletion_held || 0;
  const restored = Array.isArray(results.restored)
    ? results.restored.length
    : (results.restored || 0);
  const goneUnrecorded = Array.isArray(results.gone_unrecorded)
    ? results.gone_unrecorded.length
    : (results.gone_unrecorded || 0);
  const entriesOf = (explicit, fallback) => {
    const value = explicit !== undefined ? explicit : fallback;
    return Array.isArray(value) ? value : [];
  };
  const deletedList = entriesOf(deletedEntries, results.deleted_entries).slice().sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const heldList = entriesOf(deletionHeldEntries, results.deletion_held_entries).slice().sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const restoredList = entriesOf(restoredEntries, results.restored_entries);
  const goneList = entriesOf(goneUnrecordedUrls, results.gone_unrecorded_urls).slice().sort();
  const unlistedList = entriesOf(unlistedEntries, results.unlisted_entries)
    .slice().sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const unlistedCheckValue = unlistedCheck !== undefined
    ? unlistedCheck
    : (results.unlisted_check !== undefined ? results.unlisted_check : null);
  const unlistedLimitValue = unlistedCheckLimit !== undefined
    ? unlistedCheckLimit
    : (results.unlisted_check_limit !== undefined ? results.unlisted_check_limit : null);
  const unlistedCount = results.unlisted !== undefined ? results.unlisted : unlistedList.length;
  // 前から削除済みで一覧にも無い記録の数（H3）。crawl_results.unlisted には含めない。
  const unlistedDeletedBefore = results.unlisted_deleted_before !== undefined
    ? results.unlisted_deleted_before
    : unlistedList.filter(entry => entry.outcome === 'deleted_before').length;
  // 一覧から外れた記録の情報を渡されたときだけ crawl_results.unlisted を出す
  // （段 1 からある呼び出しの形を変えないため）。
  const hasUnlistedInfo = results.unlisted !== undefined || unlistedEntries !== undefined
    || unlistedCheck !== undefined || unlistedCheckLimit !== undefined;
  const max = maxDeletions !== undefined
    ? maxDeletions
    : (results.max_deletions !== undefined ? results.max_deletions : 0);
  const totalEntries = fetched + skipped + deleted + deletedStill + deletionHeld;
  const durationMs = new Date(finishedAt) - new Date(startedAt);
  const meta = {
    version: 1,
    last_crawl_started_at: startedAt,
    last_crawl_finished_at: finishedAt,
    last_crawl_duration_seconds: Math.round(durationMs / 1000),
    crawl_results: {
      fetched,
      skipped,
      deleted,
      deleted_still: deletedStill,
      deletion_held: deletionHeld,
      restored,
      gone_unrecorded: goneUnrecorded,
      // 一覧から外れた記録の数。既存の呼び出し（渡されない）では項目を足さない。
      ...(hasUnlistedInfo
        ? { unlisted: unlistedCount, unlisted_deleted_before: unlistedDeletedBefore }
        : {}),
      errors_count: (results.errors || []).length,
    },
    by_type: byType || {},
    total_entries_processed: totalEntries,
    max_deletions: max,
    deleted_entries: deletedList,
    deletion_held_entries: heldList,
    restored_entries: restoredList,
    gone_unrecorded_urls: goneList,
    unlisted_check: unlistedCheckValue,
    unlisted_check_limit: unlistedLimitValue,
    unlisted_entries: unlistedList,
    errors_sample: (results.errors || []).slice(0, 20),
    next_scheduled_at: nextScheduledAt || null,
  };
  store.writeJsonAtomic(metaFile, meta);
  return metaFile;
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
