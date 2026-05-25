'use strict';

/**
 * Markdown（GFM）表の検査ユーティリティ（完全ルールベース・API不要）
 *
 * 以前「表がきれいに出ない」問題があったため、生成記事の表の整合性を機械的に検査する。
 * 検出する不整合:
 *   - 区切り行（|---|---|）が無いヘッダ行
 *   - ヘッダの列数と区切り行/データ行の列数の不一致
 *   - 表の前に空行が無い（描画崩れの原因になりやすい）
 */

function isTableRow(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length >= 3;
}
function isSeparatorRow(line) {
  const t = line.trim();
  return /^\|(?:\s*:?-+:?\s*\|)+$/.test(t);
}
function countCols(line) {
  // 先頭末尾の | を除いて | で分割
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').length;
}

/**
 * 本文中の GFM 表を検査して問題を返す。
 * @returns {Array<{line:number, issue:string}>}
 */
function lintTables(body) {
  const lines = body.split(/\r?\n/);
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isTableRow(line)) continue;
    if (isSeparatorRow(line)) continue;

    // ヘッダ行候補: 次の行が区切り行なら表ヘッダ
    const next = lines[i + 1] || '';
    if (isSeparatorRow(next)) {
      const headerCols = countCols(line);
      const sepCols    = countCols(next);
      if (headerCols !== sepCols) {
        issues.push({ line: i + 1, issue: `ヘッダ列数(${headerCols})と区切り行列数(${sepCols})が不一致` });
      }
      // 表の前に空行があるか
      const prev = lines[i - 1];
      if (prev != null && prev.trim() !== '' && !isTableRow(prev)) {
        issues.push({ line: i + 1, issue: '表の直前に空行がない（描画崩れの可能性）' });
      }
      // データ行の列数チェック
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]) && !isSeparatorRow(lines[j])) {
        const cols = countCols(lines[j]);
        if (cols !== headerCols) {
          issues.push({ line: j + 1, issue: `データ行の列数(${cols})がヘッダ(${headerCols})と不一致` });
        }
        j++;
      }
      i = j - 1; // この表をスキップ
    } else {
      // 区切り行が続かない表ヘッダ風の行
      // （箇条書きの | など誤検出を避けるため、複数列ある場合のみ警告）
      if (countCols(line) >= 2 && !isTableRow(lines[i - 1] || '')) {
        issues.push({ line: i + 1, issue: '表ヘッダの直後に区切り行（|---|）が無い' });
      }
    }
  }
  return issues;
}

function hasAnyTable(body) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (isTableRow(lines[i]) && isSeparatorRow(lines[i + 1])) return true;
  }
  return false;
}

module.exports = { lintTables, hasAnyTable, isTableRow, isSeparatorRow, countCols };
