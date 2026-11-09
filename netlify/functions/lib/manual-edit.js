'use strict';

/**
 * 公開中の記事の手直し PR（枝 `edit/<slug>`）の判定と差分の部品。
 *
 * 画面（review-page）と承認・差し戻し・見送り（各関数）が、同じ条件で
 * 「手直し PR として扱えるか」を毎回サーバー側で確かめるために使う。
 * 画面から送られた「手直しである」という値は信じない。
 */

// source-guard は gray-matter に依存する。通知のワークフローが main から
// checkout したこのファイルを node -e で require するだけのとき（npm install を
// しない）でも読み込めるよう、判定に使うときだけ読み込む。
function parseFrontmatterMeta(raw) {
  return require('../../../scripts/lib/source-guard').parseFrontmatterMeta(raw);
}

// 枝の名前。Claude が手直し PR を作るときの命名に合わせる。
const MANUAL_EDIT_REF = /^edit\/[a-z0-9][a-z0-9_-]{0,80}$/;

// 記事以外で変更を許すファイル（記事ごとの data/fact-check/<slug>.json は別に許す）。
const ALLOWED_EXTRA_FILES = Object.freeze([
  'data/internal-link-placements.json',
  'scripts/lib/__tests__/test-title-refresh.js',
]);

// main と枝で同じでなければならない frontmatter の項目。
// 手直しは本文と題名・説明文だけを変える（公開状態・公開日・公開枠は触らない）。
const LOCKED_FIELDS = Object.freeze([
  'review_status', 'slug', 'publish_at', 'published_at', 'approved_at', 'publish_slot',
]);

// edit/ で始まるか（形が正しいかは別に MANUAL_EDIT_REF で見る）。
function isEditRefShape(ref) {
  return typeof ref === 'string' && ref.startsWith('edit/');
}

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
 * @param {Function} deps.compareCommits github-api.compareCommits
 * @returns {Promise<{ok:boolean, reasons:string[], pr:object|null, headSha:string,
 *   mainFile:object|null, branchFile:object|null, files:Array}>}
 */
async function checkManualEditPR({ filename, ref, findPR, listPRFiles, getFile, compareCommits }) {
  const reasons = [];
  const result = {
    ok: false, reasons, pr: null, headSha: '', mainFile: null, branchFile: null, files: [],
  };

  if (!isEditRefShape(ref)) {
    reasons.push('手直しの枝（edit/…）ではありません。');
    return result;
  }
  if (!isManualEditRef(ref)) {
    reasons.push('手直しの枝の名前の形が正しくありません。');
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
  if (pr.draft === true) reasons.push('下書きの PR です。確認できる状態にしてから開いてください。');

  let files;
  try {
    files = await listPRFiles(pr.number);
  } catch (_) {
    reasons.push('PR の変更ファイルを確認できませんでした。');
    return result;
  }
  result.files = (Array.isArray(files) ? files : []).filter(file => file && typeof file === 'object');

  // 変更ファイルは filename と previous_filename（名前の変更の元）の両方を
  // 許可リストに照らす。片方だけ見ると、許可リストの外への持ち出しを見落とす。
  const names = [];
  for (const file of result.files) {
    if (file.filename) names.push(String(file.filename));
    if (file.previous_filename) names.push(String(file.previous_filename));
  }
  const posts = [...new Set(names.filter(name => /^content\/posts\/[^/]+\.md$/.test(name)))];
  if (posts.length !== 1) {
    reasons.push(`記事の変更は 1 本だけにしてください（${posts.length} 本あります）。`);
  } else if (posts[0] !== articlePath) {
    reasons.push('承認しようとしている記事と PR の記事が一致しません。');
  }

  // 記事のファイルは「変更」だけを認める（追加・削除・名前の変更は認めない）。
  const articleEntry = result.files.find(file => file.filename === articlePath);
  if (!articleEntry) {
    reasons.push('記事のファイルが PR の変更に含まれていません。');
  } else if (articleEntry.status !== 'modified') {
    reasons.push('記事のファイルは「変更」だけにしてください（追加・削除・名前の変更はできません）。');
  }

  // 許可リストのほかのファイルも、追加・変更だけを認める。
  for (const file of result.files) {
    if (file.filename === articlePath) continue;
    if (!['added', 'modified'].includes(String(file.status || ''))) {
      reasons.push(`手直しで変えてよいファイルの状態ではありません（${file.filename || 'ファイル名なし'}: ${file.status || '不明'}）。`);
    }
  }

  try {
    result.mainFile = await getFile(articlePath, 'main');
  } catch (_) {
    reasons.push('公開中の記事を取得できませんでした。');
    return result;
  }
  // 画面が表示に使った版（headSha）から読む。枝の先頭が動いても、
  // 画面で見た版と承認する版が食い違わないようにする。
  try {
    result.branchFile = await getFile(articlePath, result.headSha || ref);
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

  // 公開状態・公開日・公開枠などは main と同じでなければならない。
  const changed = LOCKED_FIELDS.filter(key => {
    const before = mainMeta[key] == null ? '' : String(mainMeta[key]);
    const after = branchMeta[key] == null ? '' : String(branchMeta[key]);
    return before !== after;
  });
  if (changed.length) {
    reasons.push(`公開日などの項目（${changed.join('、')}）が main と違います。手直しでは変えられません。`);
  }

  const allowed = new Set([articlePath, ...ALLOWED_EXTRA_FILES]);
  if (slug) allowed.add(`data/fact-check/${slug}.json`);
  const disallowed = [...new Set(names.filter(name => !allowed.has(name)))];
  if (disallowed.length) {
    reasons.push(`手直しで変えてよいファイル以外が含まれています（${disallowed.join('、')}）。`);
  }

  // main の記事が枝を分けたあとに変わっていないことを確かめる。
  // 枝を main に追従させずにマージすると、main の変更を巻き戻す事故になる。
  if (result.headSha) {
    try {
      const compare = typeof compareCommits === 'function' ? await compareCommits('main', result.headSha) : null;
      const baseSha = compare && compare.merge_base_commit && compare.merge_base_commit.sha
        ? String(compare.merge_base_commit.sha) : '';
      if (!baseSha) {
        reasons.push('main と枝の共通の親を確認できませんでした。');
      } else {
        let baseFile = null;
        try { baseFile = await getFile(articlePath, baseSha); }
        catch (_) { baseFile = null; }
        if (!baseFile || !result.mainFile || baseFile.sha !== result.mainFile.sha) {
          reasons.push('main 側でこの記事が変わりました。枝を main に追従させてから、もう一度確認してください。');
        }
      }
    } catch (_) {
      reasons.push('main と枝の共通の親を確認できませんでした。');
    }
  }

  result.ok = reasons.length === 0;
  return result;
}

module.exports = {
  MANUAL_EDIT_REF,
  ALLOWED_EXTRA_FILES,
  LOCKED_FIELDS,
  isEditRefShape,
  isManualEditRef,
  diffFrontmatter,
  checkManualEditPR,
};
