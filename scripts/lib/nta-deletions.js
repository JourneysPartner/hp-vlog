'use strict';

/**
 * 国税庁で削除された資料の判定・記録・報告をまとめる部品。
 *
 * 取り込みの CLI（scripts/crawl-nta-sources.js）から使う。ここでは通信しない。
 *   - 削除の印（deleted / deleted_reason / deleted_at）の付け外し
 *   - 一回の実行で新しく削除にしてよい数の上限
 *   - 資料を使っている記事・データの検索（報告用）
 *   - PR 本文に貼る Markdown の生成
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 削除と見なす理由と、報告に出す日本語のラベル。
const GONE_REASON_LABELS = {
  nta_error_page: '国税庁のエラーページ（/error/404.htm）へ転送',
  not_found: '404/410 が返った',
};

function isGoneReason(reason) {
  return Object.prototype.hasOwnProperty.call(GONE_REASON_LABELS, reason);
}

// 既存の記録に削除の印を付けた写しを返す（引数は書き換えない）。
// すでに削除済みで deleted_at があれば、その日時を引き継ぐ。
function markDeleted(existing, reason, at) {
  const deletedAt = existing && existing.deleted === true && existing.deleted_at
    ? existing.deleted_at
    : at;
  return {
    ...existing,
    deleted: true,
    deleted_reason: reason,
    deleted_at: deletedAt,
    last_checked_at: at,
  };
}

// 削除の印を外した写しを返す（引数は書き換えない）。
function clearDeleted(entry) {
  const copy = { ...entry };
  delete copy.deleted;
  delete copy.deleted_reason;
  delete copy.deleted_at;
  return copy;
}

/**
 * 新しく削除にする資料を保存する。上限を超えたら一件も保存しない。
 * @param {Array} pending 保存候補（この実行で新しく削除になった資料）
 * @param {{maxDeletions:number, save:Function}} options
 * @returns {{applied:Array, held:Array}}
 */
function applyPendingDeletions(pending, { maxDeletions, save }) {
  const items = Array.isArray(pending) ? pending : [];
  if (items.length > maxDeletions) {
    return { applied: [], held: items };
  }
  for (const item of items) save(item);
  return { applied: items, held: [] };
}

const SEARCH_DIRS = [
  'content/posts',
  'data/fact-check',
  'data/tax-simulator',
  'scripts/lib',
];
const SEARCH_FILES = ['scripts/topic-pool.js'];
const SEARCH_EXTENSIONS = new Set(['.md', '.json', '.js', '.yml']);

function collectFiles(root, relativeDir, acc) {
  const directory = path.join(root, relativeDir);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      // 試験用の資料と生成物（assets）は「使っている所」に数えない。
      if (entry.name === '__tests__' || entry.name === 'assets') continue;
      collectFiles(root, relative, acc);
    } else if (entry.isFile() && SEARCH_EXTENSIONS.has(path.extname(entry.name))) {
      acc.push(relative);
    }
  }
}

function readSearchFiles(root) {
  const relativePaths = [];
  for (const dir of SEARCH_DIRS) collectFiles(root, dir, relativePaths);
  for (const file of SEARCH_FILES) {
    try {
      if (fs.statSync(path.join(root, file)).isFile()) relativePaths.push(file);
    } catch (e) {
      // 無ければ見ない
    }
  }
  const files = [];
  for (const relative of relativePaths) {
    try {
      files.push({ relative, text: fs.readFileSync(path.join(root, relative), 'utf8') });
    } catch (e) {
      // 読めないファイルは飛ばす（報告のための検索なので止めない）
    }
  }
  return files;
}

function urlNeedle(url) {
  try {
    const pathname = new URL(url).pathname;
    for (const marker of ['/taxanswer/', '/shitsugi/']) {
      const index = pathname.indexOf(marker);
      if (index >= 0) return pathname.slice(index + 1);
    }
  } catch (e) {
    return null;
  }
  return null;
}

function taxanswerIdOf(item) {
  if (item.id !== undefined && item.id !== null) return String(item.id);
  try {
    const match = new URL(item.url).pathname.match(/\/([^/]+)\.htm$/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 各資料を使っている記事・データを探す。見つからなくても止めない。
 *
 * 戻り値は資料の URL をキーにしたオブジェクトで、値は root からの相対パス
 * （`/` 区切り、名前順）の配列。
 */
function findReferences(items, { root = ROOT } = {}) {
  const list = Array.isArray(items) ? items : [];
  const files = readSearchFiles(root);
  const result = {};
  for (const item of list) {
    if (!item || !item.url) continue;
    const needle = urlNeedle(item.url);
    const type = item.type || (String(item.kind || '').includes('shitsugi') ? 'shitsugi' : '');
    const taxId = type === 'taxanswer' || /\/taxanswer\//.test(item.url)
      ? taxanswerIdOf(item)
      : null;
    const idPattern = taxId
      ? new RegExp(`["']?taxanswer_id["']?\\s*:\\s*["']?${escapeRegExp(taxId)}["']?(?!\\d)`)
      : null;
    const found = [];
    for (const file of files) {
      let hit = needle ? file.text.includes(needle) : false;
      if (!hit && idPattern && file.relative.startsWith('data/tax-simulator/')) {
        hit = idPattern.test(file.text);
      }
      if (hit) found.push(file.relative);
    }
    found.sort();
    result[item.url] = found;
  }
  return result;
}

const TYPE_LABELS = {
  taxanswer: 'タックスアンサー',
  shitsugi: '質疑応答事例',
};

function typeLabel(type) {
  return TYPE_LABELS[type] || type || '不明';
}

function formatTitle(entry) {
  const title = entry && entry.title ? String(entry.title) : '';
  if ((entry && entry.type) !== 'taxanswer' || /^No\./.test(title)) return title;
  const id = entry.id ? String(entry.id) : taxanswerIdOf(entry || {});
  return id ? `No.${id} ${title}` : title;
}

function cell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function formatReferences(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return 'なし';
  const shown = list.slice(0, 10).map(file => `\`${file}\``).join('、');
  return list.length > 10 ? `${shown}、ほか ${list.length - 10} 件` : shown;
}

function reasonLabel(reason) {
  return GONE_REASON_LABELS[reason] || String(reason || '');
}

function pushTable(lines, entries, references) {
  lines.push('| 種類 | 題名 | URL | 見分けた理由 | この資料を使っている所 |');
  lines.push('|---|---|---|---|---|');
  for (const entry of entries) {
    const refs = references && references[entry.url];
    lines.push(`| ${cell(typeLabel(entry.type))} | ${cell(formatTitle(entry))} | ${cell(entry.url)} | `
      + `${cell(reasonLabel(entry.reason))} | ${cell(formatReferences(refs))} |`);
  }
}

/**
 * PR 本文に貼る Markdown（R6）を返す。節は毎回すべて出す。
 */
function renderReport(summary = {}) {
  const deleted = Array.isArray(summary.deleted) ? summary.deleted : [];
  const held = Array.isArray(summary.held) ? summary.held : [];
  const restored = Array.isArray(summary.restored) ? summary.restored : [];
  const goneUnrecorded = Array.isArray(summary.goneUnrecorded) ? summary.goneUnrecorded : [];
  const references = summary.references || {};
  const deletedStill = Number(summary.deletedStill) || 0;
  const maxDeletions = Number(summary.maxDeletions) || 0;
  const lines = [];

  lines.push(`## 国税庁で削除されたページ（この PR で「削除済み」の印を付けたもの）: ${deleted.length} 件`);
  lines.push('');
  if (deleted.length > 0) pushTable(lines, deleted, references);
  else lines.push('なし');

  lines.push('');
  lines.push(`## 上限を超えたため印を付けなかったもの: ${held.length} 件（上限 ${maxDeletions} 件）`);
  lines.push('');
  if (held.length > 0) {
    lines.push(`本当に削除なら、Actions の「Crawl NTA Sources」を、max_deletions に ${held.length} 以上を入れて手動で実行し直してください。`);
    lines.push('');
    pushTable(lines, held, references);
  } else {
    lines.push('なし');
  }

  lines.push('');
  lines.push(`## 国税庁で戻ったページ（「削除済み」の印を外したもの）: ${restored.length} 件`);
  lines.push('');
  if (restored.length > 0) {
    for (const entry of restored) {
      lines.push(`- ${typeLabel(entry.type)} ${formatTitle(entry)} <${entry.url}>`);
    }
  } else {
    lines.push('なし');
  }

  lines.push('');
  lines.push(`## 前から削除済みで、今回も無かったもの: ${deletedStill} 件`);
  if (deletedStill === 0) lines.push('なし');

  lines.push('');
  lines.push(`## 国税庁の一覧には載っているがページが無いもの（DB に記録なし・変更なし）: ${goneUnrecorded.length} 件`);
  lines.push('');
  if (goneUnrecorded.length > 0) {
    lines.push('<details><summary>URL の一覧</summary>');
    lines.push('');
    for (const url of goneUnrecorded) lines.push(`- ${url}`);
    lines.push('');
    lines.push('</details>');
  } else {
    lines.push('なし');
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  GONE_REASON_LABELS,
  isGoneReason,
  markDeleted,
  clearDeleted,
  applyPendingDeletions,
  findReferences,
  renderReport,
};
