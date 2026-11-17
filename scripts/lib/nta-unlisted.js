'use strict';

/**
 * 国税庁の一覧（index）から外れた DB の記録を選ぶ部品（段 2）。
 *
 * 通信しない・ファイルを書かない。取り込みの CLI がこの結果を見て、
 * 記録ごとに本文を取りに行くかどうかを決める。
 *   - 一覧にある記録は対象外
 *   - 一覧で 1 件も取れなかった分類の記録は訪ねない（一覧の取得の不具合を疑う）
 *   - 記録が読めない・URL が置き場所と合わない記録は訪ねない
 *   - 前から削除済みの記録は訪ねない
 */

// 一覧から外れた記録を訪ねてよい上限（U6）。これが多いときは一覧の取得・
// 読み取りの不具合を疑う。
const UNLISTED_CHECK_LIMIT = 100;

const NTA_BASE_URL = 'https://www.nta.go.jp';

// 記録の置き場所から決まる「正しい URL」。記録の url と完全に一致するときだけ訪ねる。
function canonicalUrlOf(key) {
  if (!key) return null;
  if (key.type === 'taxanswer') {
    return `${NTA_BASE_URL}/taxes/shiraberu/taxanswer/${key.category}/${key.id}.htm`;
  }
  if (key.type === 'shitsugi') {
    return `${NTA_BASE_URL}/law/shitsugi/${key.category}/${key.section}/${key.id}.htm`;
  }
  return null;
}

// 本文の取得の失敗の理由の日本語のラベル（報告用）。
const ERROR_REASON_LABELS = {
  retry_exhausted: '通信の失敗・時間切れ',
  http_error: 'HTTP エラー',
  mojibake_detected: '文字化け',
  parse_failed: '本文を読めない',
};

function errorReasonLabel(reason) {
  return ERROR_REASON_LABELS[reason] || String(reason || '');
}

// 報告・meta に出す結果の名前（outcome）と日本語のラベル。
const UNLISTED_OUTCOME_LABELS = {
  deleted: () => '新しく削除済みにした',
  held: () => '上限を超えたため印を付けなかった',
  alive_updated: () => 'ページはある（中身を更新）',
  alive_unchanged: () => 'ページはある（変わっていない）',
  redirected_elsewhere: entry => `国税庁の別のページへ転送（記録は変えない）: ${(entry && entry.final_url) || ''}`,
  error: entry => `取れなかった（${errorReasonLabel(entry && entry.reason)}、記録は変えない）`,
  deleted_before: () => '前から削除済み（訪ねない）',
  invalid_record: () => '記録が読めない・URL が正しくない（訪ねない）',
  category_unlisted: () => '国税庁の一覧でこの分類が 1 件も取れなかった（訪ねない）',
  not_checked: () => '対象が多すぎるため訪ねなかった',
};

function unlistedOutcomeLabel(entry) {
  const label = UNLISTED_OUTCOME_LABELS[entry && entry.outcome];
  return label ? label(entry) : String((entry && entry.outcome) || '');
}

function itemOf(key, record, url, title) {
  return { key, record, url, title: title || '' };
}

/**
 * 一覧から外れた記録を、扱いごとに分ける。
 *
 * @param {Object} params
 *   @param {Array}  params.keys              listRecordKeys() の戻り値
 *   @param {Set|Array} params.listedFilePaths  この実行で一覧に載っていた file_path
 *   @param {Set|Array} params.listedCategories 一覧の項目が 1 件以上あった `<種類>/<分類>`
 *   @param {Function} params.loadRecord     key から記録を読む（読めなければ null）
 * @returns {{category_unlisted:Array, invalid_record:Array, deleted_before:Array, targets:Array}}
 */
function selectUnlisted({ keys, listedFilePaths, listedCategories, loadRecord }) {
  const listedPaths = listedFilePaths instanceof Set ? listedFilePaths : new Set(listedFilePaths || []);
  const listedCats = listedCategories instanceof Set ? listedCategories : new Set(listedCategories || []);
  const result = { category_unlisted: [], invalid_record: [], deleted_before: [], targets: [] };

  for (const key of Array.isArray(keys) ? keys : []) {
    if (!key || !key.file_path) continue;
    if (listedPaths.has(key.file_path)) continue;

    const canonical = canonicalUrlOf(key);
    // 一覧でこの分類が 1 件も取れていないなら訪ねない（記録も読まない）。
    if (!listedCats.has(`${key.type}/${key.category}`)) {
      result.category_unlisted.push(itemOf(key, null, canonical, ''));
      continue;
    }

    const record = typeof loadRecord === 'function' ? loadRecord(key) : null;
    const url = record && typeof record.url === 'string' ? record.url : '';
    const title = record && record.title ? record.title : '';
    if (!record || !url || url !== canonical) {
      result.invalid_record.push(itemOf(key, record, url || canonical, title));
      continue;
    }
    if (record.deleted === true) {
      result.deleted_before.push(itemOf(key, record, url, title));
      continue;
    }
    result.targets.push(itemOf(key, record, url, title));
  }

  return result;
}

module.exports = {
  UNLISTED_CHECK_LIMIT,
  canonicalUrlOf,
  selectUnlisted,
  errorReasonLabel,
  UNLISTED_OUTCOME_LABELS,
  unlistedOutcomeLabel,
};
