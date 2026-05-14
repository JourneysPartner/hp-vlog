'use strict';

/**
 * Netlify Function 側から data/topic-denylist.json を更新するための GitHub I/O ヘルパー。
 *
 * 既存の review-* / admin-* 機能から呼ばれて、新規 entry を追加する。
 * 競合（同時に複数 Lambda から書き込み）に備え、sha 不一致時は 1 回リトライする。
 */

const { getFile, putFile, nowJST } = require('./github-api');

const DENYLIST_PATH = 'data/topic-denylist.json';

function parseJsonSafe(raw, fallback) {
  try { return JSON.parse(raw); }
  catch { return fallback; }
}

async function fetchDenylist() {
  try {
    const { content, sha } = await getFile(DENYLIST_PATH, 'main');
    const json = parseJsonSafe(content, { version: 1, entries: [] });
    if (!Array.isArray(json.entries)) json.entries = [];
    return { json, sha };
  } catch (e) {
    // ファイル未作成（404）→ 空で初期化
    console.warn(`[denylist-store] denylist 取得失敗 → 新規作成扱い: ${e.message}`);
    return { json: { version: 1, entries: [] }, sha: null };
  }
}

function dedupeAppend(json, newEntries) {
  const list = json.entries || [];
  const seen = new Set(list.map(e => `${e.type}::${String(e.value || '').toLowerCase()}`));
  const added = [];
  for (const e of newEntries) {
    const key = `${e.type}::${String(e.value || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(e);
    added.push(e);
  }
  return { json: { ...json, entries: list }, added };
}

/**
 * denylist に entries を追加して main に commit する。
 *
 * @param {Array} newEntries  追加する entry の配列
 * @param {string} commitMessage  コミットメッセージ
 * @returns {Object} { added: [...], total: number, committed: boolean }
 */
async function appendEntries(newEntries, commitMessage) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) {
    return { added: [], total: 0, committed: false };
  }

  // 1 回目
  let { json, sha } = await fetchDenylist();
  let merged = dedupeAppend(json, newEntries);
  if (merged.added.length === 0) {
    return { added: [], total: (merged.json.entries || []).length, committed: false };
  }

  const body = JSON.stringify(merged.json, null, 2) + '\n';
  try {
    await putFile(DENYLIST_PATH, body, sha, commitMessage || `denylist: add ${merged.added.length} entries`, 'main');
    return { added: merged.added, total: merged.json.entries.length, committed: true };
  } catch (e) {
    // 409 などで失敗 → 再取得 + 再試行 1 回
    console.warn(`[denylist-store] 初回 putFile 失敗、再取得して再試行: ${e.message}`);
    ({ json, sha } = await fetchDenylist());
    merged = dedupeAppend(json, newEntries);
    if (merged.added.length === 0) {
      return { added: [], total: (merged.json.entries || []).length, committed: false };
    }
    const body2 = JSON.stringify(merged.json, null, 2) + '\n';
    await putFile(DENYLIST_PATH, body2, sha, commitMessage || `denylist: add ${merged.added.length} entries (retry)`, 'main');
    return { added: merged.added, total: merged.json.entries.length, committed: true };
  }
}

module.exports = {
  DENYLIST_PATH,
  fetchDenylist,
  appendEntries,
  nowJST,
};
