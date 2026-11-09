'use strict';

/**
 * 公開中の記事の手直し PR（枝 `edit/<slug>`）の判定と差分の部品。
 *
 * 画面（review-page）と承認・差し戻し・見送り（各関数）が、同じ条件で
 * 「手直し PR として扱えるか」を毎回サーバー側で確かめるために使う。
 * 画面から送られた「手直しである」という値は信じない。
 */

const { parseFrontmatterMeta } = require('../../../scripts/lib/source-guard');

// 枝の名前。Claude が手直し PR を作るときの命名に合わせる。
const MANUAL_EDIT_REF = /^edit\/[a-z0-9][a-z0-9_-]{0,80}$/;

// 記事以外で変更を許すファイル（記事ごとの data/fact-check/<slug>.json は別に許す）。
const ALLOWED_EXTRA_FILES = Object.freeze([
  'data/internal-link-placements.json',
  'scripts/lib/__tests__/test-title-refresh.js',
]);

function isManualEditRef(ref) {
  return typeof ref === 'string' && MANUAL_EDIT_REF.test(ref);
}

function stripFrontmatter(raw) {
  const match = String(raw || '').match(/^---\r?\n([\s\S]+?)\r?\n---/);
  return match ? match[1] : '';
}

function unquote(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

// 1 行の `key: "value"` の項目だけを読む（複数行の値は比べない）。
function frontmatterEntries(raw) {
  const entries = [];
  for (const line of stripFrontmatter(raw).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (match) entries.push([match[1], unquote(match[2])]);
  }
  return entries;
}

/**
 * main と枝の frontmatter を比べ、変わった項目を { key, before, after } で返す。
 * 題名・説明文・updated_at・reviewed_at などを画面に出すために使う。
 */
function diffFrontmatter(mainRaw, branchRaw) {
  const main = new Map(frontmatterEntries(mainRaw));
  const branch = new Map(frontmatterEntries(branchRaw));
  const keys = [...main.keys(), ...[...branch.keys()].filter(key => !main.has(key))];
  const changed = [];
  for (const key of keys) {
    const before = main.has(key) ? main.get(key) : '';
    const after = branch.has(key) ? branch.get(key) : '';
    if (before !== after) changed.push({ key, before, after });
  }
  return changed;
}

/**
 * 手直し PR として扱えるかを確かめる。
 *
 * @param {object} deps
 * @param {string} deps.filename   画面が表示している記事のファイル名
 * @param {string} deps.ref        枝の名前
 * @param {Function} deps.findPR   github-api.findPR
 * @param {Function} deps.listPRFiles github-api.listPRFiles
 * @param {Function} deps.getFile  github-api.getFile
 * @returns {Promise<{ok:boolean, reasons:string[], pr:object|null, headSha:string,
 *   mainFile:object|null, branchFile:object|null, files:Array}>}
 */
async function checkManualEditPR({ filename, ref, findPR, listPRFiles, getFile }) {
  const reasons = [];
  const result = {
    ok: false, reasons, pr: null, headSha: '', mainFile: null, branchFile: null, files: [],
  };

  if (!isManualEditRef(ref)) {
    reasons.push('手直しの枝（edit/…）ではありません。');
    return result;
  }
  if (typeof filename !== 'string' || !/^[\w-]+\.md$/.test(filename)) {
    reasons.push('記事のファイル名が正しくありません。');
    return result;
  }

  const articlePath = `content/posts/${filename}`;

  let pr;
  try {
    pr = await findPR(ref);
  } catch (_) {
    reasons.push('PR の情報を確認できませんでした。');
    return result;
  }
  if (!pr || pr.number == null) {
    reasons.push('この枝の開いている PR が見つかりません。');
    return result;
  }
  result.pr = pr;
  result.headSha = pr.head && pr.head.sha ? String(pr.head.sha) : '';
  if (!result.headSha) reasons.push('PR の先頭のコミットを確認できませんでした。');
  if (!pr.base || pr.base.ref !== 'main') reasons.push('PR の向き先が main ではありません。');

  let files;
  try {
    files = await listPRFiles(pr.number);
  } catch (_) {
    reasons.push('PR の変更ファイルを確認できませんでした。');
    return result;
  }
  result.files = Array.isArray(files) ? files : [];
  const filenames = result.files.map(file => file && file.filename).filter(Boolean);
  const posts = filenames.filter(name => /^content\/posts\/[^/]+\.md$/.test(name));
  if (posts.length !== 1) {
    reasons.push(`記事の変更は 1 本だけにしてください（${posts.length} 本あります）。`);
  } else if (posts[0] !== articlePath) {
    reasons.push('承認しようとしている記事と PR の記事が一致しません。');
  }

  try {
    result.mainFile = await getFile(articlePath, 'main');
  } catch (_) {
    reasons.push('公開中の記事を取得できませんでした。');
    return result;
  }
  try {
    result.branchFile = await getFile(articlePath, ref);
  } catch (_) {
    reasons.push('手直しの枝の記事を取得できませんでした。');
    return result;
  }

  const mainMeta = parseFrontmatterMeta(result.mainFile.content);
  const branchMeta = parseFrontmatterMeta(result.branchFile.content);
  const slug = branchMeta.slug ? String(branchMeta.slug) : '';
  if (mainMeta.review_status !== 'published' || branchMeta.review_status !== 'published') {
    reasons.push('公開中の記事ではありません（main と枝の両方で review_status が published である必要があります）。');
  }
  if (!slug || mainMeta.slug !== branchMeta.slug) {
    reasons.push('記事の slug が main と枝で一致しません。');
  }

  const allowed = new Set([articlePath, ...ALLOWED_EXTRA_FILES]);
  if (slug) allowed.add(`data/fact-check/${slug}.json`);
  const disallowed = filenames.filter(name => !allowed.has(name));
  if (disallowed.length) {
    reasons.push(`手直しで変えてよいファイル以外が含まれています（${disallowed.join('、')}）。`);
  }

  result.ok = reasons.length === 0;
  return result;
}

module.exports = {
  MANUAL_EDIT_REF,
  ALLOWED_EXTRA_FILES,
  isManualEditRef,
  diffFrontmatter,
  checkManualEditPR,
};
