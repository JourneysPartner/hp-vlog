'use strict';

/**
 * preflight check（生成直後の事前検査・完全ルールベース・API不要）
 *
 * npm run validate（公開前ゲート）より手前で、生成直後の記事を機械的に検査する。
 * 目的: API を使わずに「明らかな崩れ」を早期検出し、無駄な再生成 API 呼び出しを減らす。
 *
 * 検査:
 *   - frontmatter 必須項目（title / slug / category / primary_persona / summary）
 *   - source_url / source_title が非空
 *   - title lint（禁止フレーズ・長さ）
 *   - Markdown 表の整合
 *   - 免責文の有無
 *   - h2 見出しが最低1つ
 */

const { lintTitle } = require('./title-lint');
const { lintTables } = require('./markdown-table-lint');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

const REQUIRED = ['title', 'slug', 'category', 'primary_persona', 'summary'];

/**
 * @returns {Object} { ok, errors: [], warnings: [] }
 */
function preflightCheck(raw) {
  const { meta, body } = parseFrontmatter(raw);
  const errors = [];
  const warnings = [];

  // 1. 必須 frontmatter
  for (const f of REQUIRED) {
    if (!meta[f]) errors.push(`必須項目が未設定: ${f}`);
  }

  // 2. source_url / source_title（生成記事は必ず付くべき）
  if (!meta.source_url)   errors.push('source_url が未設定（生成時に補完されるはず）');
  if (!meta.source_title) warnings.push('source_title が未設定');

  // 3. title lint
  if (meta.title) {
    const r = lintTitle(meta.title, { macro: meta.macro, article_type: meta.article_type });
    for (const f of r.fails) errors.push(`title: ${f}`);
    for (const w of r.warns) warnings.push(`title: ${w}`);
  }

  // 4. Markdown 表
  const tableIssues = lintTables(body);
  for (const t of tableIssues) warnings.push(`表(line ${t.line}): ${t.issue}`);

  // 5. 免責文
  if (!/本記事は.{0,30}情報提供|免責|個別事情/.test(body)) {
    warnings.push('免責文が見つからない（postProcess で補完される想定）');
  }

  // 6. h2 見出し
  const h2 = (body.match(/^##\s+/gm) || []).length;
  if (h2 < 1) errors.push('h2 見出しが1つもない');
  else if (h2 < 3) warnings.push(`h2 見出しが ${h2} 個（3個以上推奨）`);

  return { ok: errors.length === 0, errors, warnings, meta };
}

module.exports = { preflightCheck, parseFrontmatter };
