'use strict';

/**
 * 国税庁ページの「図」を出典レコードに結び付けて保存・添付する。
 *
 * 背景（2026-09-06）:
 *   質疑応答事例「同族株主がいない会社の株主の議決権割合の判定」
 *   (law/shitsugi/hyoka/05/03.htm) は、議決権割合が本文ではなく図（GIF）に
 *   書かれている。クローラは本文テキストしか取らないため、生成モデルは
 *   数値を持たないまま設例を書き、A=10% / B=3% / C=5% という存在しない
 *   数値を作った。実際の図は C=15%(Aの5親等) / A=2.5% / B=1% / 子=0.5%×2 で、
 *   結論（誰が中心的な株主か）まで逆になった。
 *
 * 図と出典がずれないための決め事:
 *   1. 図は「そのページの HTML に実在する <img>」だけを採る。URL を規則から
 *      組み立てない（同じ img ディレクトリに別事例の図が同居しているため、
 *      規則生成では別事例の図を掴む）。
 *   2. 解決後の絶対 URL が nta.go.jp かつ「そのページ自身のディレクトリ配下」で
 *      なければ捨てる。
 *   3. 図は出典レコード（data/nta-sources/**\/<id>.json）の images に持たせる。
 *      本文と同じ 1 レコードから同時に取り出すので、別出典の図が紛れ込む
 *      経路that自体が無い。
 *   4. 取得時のページ html_hash を images[].page_html_hash に残し、読み出し時に
 *      レコード現在の html_hash と一致するときだけ添付する（ページ更新後に
 *      古い図が付くのを防ぐ）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const IMAGES_DIR = path.join(ROOT, 'data', 'nta-sources', 'images');

// Anthropic / OpenAI がともに受け付ける形式だけを対象にする
const MEDIA_TYPES = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const MAX_FIGURES_PER_SOURCE = 4;   // 4枚ある事例（不整形地の評価）まで通す
const MAX_BYTES_PER_FIGURE = 2 * 1024 * 1024;
const MIN_BYTES_PER_FIGURE = 200;   // スペーサ等の装飾画像を落とす
const ALLOWED_HOSTS = new Set(['www.nta.go.jp', 'nta.go.jp']);

/** <img ...> タグから属性を1つ取り出す（属性順に依存しない） */
function attr(tag, name) {
  const re = new RegExp(
    String.raw`\b` + name +
    String.raw`\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))`,
    'i',
  );
  const m = tag.match(re);
  if (!m) return '';
  return (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
}

/**
 * ページ HTML から図の参照を取り出す。
 *
 * @param {string} html     そのページの HTML
 * @param {string} pageUrl  そのページの絶対 URL
 * @returns {Array<{url:string, alt:string, width:string, height:string}>}
 */
function extractFigureRefs(html, pageUrl) {
  if (!html || !pageUrl) return [];
  let base;
  try { base = new URL(pageUrl); } catch (_e) { return []; }
  // ページ自身のディレクトリ（例: /law/shitsugi/hyoka/05/）
  const pageDir = base.pathname.replace(/[^/]*$/, '');

  const out = [];
  const seen = new Set();
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(tag, 'src');
    if (!src) continue;
    let abs;
    try { abs = new URL(src, pageUrl); } catch (_e) { continue; }
    if (!ALLOWED_HOSTS.has(abs.hostname)) continue;
    // そのページ自身のディレクトリ配下のものだけ（他セクションの図を排除）
    if (!abs.pathname.startsWith(pageDir)) continue;
    const ext = path.extname(abs.pathname).toLowerCase();
    if (!MEDIA_TYPES[ext]) continue;
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      alt: attr(tag, 'alt'),
      width: attr(tag, 'width'),
      height: attr(tag, 'height'),
    });
    if (out.length >= MAX_FIGURES_PER_SOURCE) break;
  }
  return out;
}

/**
 * その出典専用の画像ディレクトリを決める。
 *
 * 本文の読み出し（nta-source-body.loadSourceBody）と同じ「URL → パス」の写像を
 * 使う。本文と図が同じ URL から同じ規則で導かれるので、別出典の図が混ざらない。
 */
function figureDirFor(entry) {
  if (!entry) return null;
  const url = String(entry.url || "");
  const shitsugi = url.match(/law[/]shitsugi[/]([a-z]+)[/]([a-z0-9_-]+)[/]([a-z0-9_-]+)[.]htm/i);
  if (shitsugi) {
    return path.join(IMAGES_DIR, "shitsugi", shitsugi[1], shitsugi[2], shitsugi[3]);
  }
  const taxanswer = url.match(/taxanswer[/]([a-z]+)[/](\d{4})[.]htm/);
  if (taxanswer) {
    return path.join(IMAGES_DIR, "taxanswer", taxanswer[1], taxanswer[2]);
  }
  return null;
}

function sanitizeFilename(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'figure';
}

/**
 * 図を取得してリポジトリに保存し、entry.images に入れる形の配列を返す。
 * 取得に失敗した図は黙って落とす（本文の取り込みは止めない）。
 *
 * @param {Array} refs        extractFigureRefs() の戻り
 * @param {Object} entry      パース済みの出典レコード
 * @param {string} htmlHash   そのページの html_hash
 * @param {Object} deps       { fetchBinary, rateLimiter } テストで差し替える
 */
async function fetchAndStoreFigures(refs, entry, htmlHash, deps = {}) {
  const fetchBinary = deps.fetchBinary || defaultFetchBinary;
  const rateLimiter = deps.rateLimiter || null;
  const dir = figureDirFor(entry);
  if (!dir || !refs || refs.length === 0) return [];

  const stored = [];
  for (const ref of refs) {
    if (rateLimiter && typeof rateLimiter.wait === 'function') await rateLimiter.wait();
    let buf;
    try {
      buf = await fetchBinary(ref.url);
    } catch (e) {
      console.warn(`[figures] 取得失敗（無視して続行）: ${ref.url} — ${e.message}`);
      continue;
    }
    if (!buf || buf.length < MIN_BYTES_PER_FIGURE || buf.length > MAX_BYTES_PER_FIGURE) {
      console.warn(`[figures] サイズが対象外のため除外: ${ref.url} (${buf ? buf.length : 0} bytes)`);
      continue;
    }
    const ext = path.extname(new URL(ref.url).pathname).toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    const file = sanitizeFilename(path.basename(new URL(ref.url).pathname));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
    stored.push({
      url: ref.url,
      alt: ref.alt || '',
      width: ref.width || '',
      height: ref.height || '',
      file: path.relative(ROOT, path.join(dir, file)).split(path.sep).join('/'),
      media_type: mediaType,
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      page_html_hash: htmlHash || '',
    });
  }
  return stored;
}

async function defaultFetchBinary(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'hp-vlog-nta-crawler' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 出典レコードに紐づく図を、モデルに渡せる形で読み出す。
 *
 * ページが更新されて html_hash が変わっている図は返さない（古い図の添付を防ぐ）。
 * ファイルが無い・壊れている場合も返さない。
 *
 * @returns {Array<{media_type:string, data:string, alt:string, url:string}>}
 */
function loadFiguresForEntry(entry) {
  if (!entry || !Array.isArray(entry.images) || entry.images.length === 0) return [];
  const out = [];
  for (const img of entry.images) {
    if (!img || !img.file || !img.media_type) continue;
    if (img.page_html_hash && entry.html_hash && img.page_html_hash !== entry.html_hash) {
      console.warn(`[figures] ページが更新されているため図を添付しません: ${img.url}`);
      continue;
    }
    const abs = path.join(ROOT, img.file);
    let buf;
    try {
      if (!fs.existsSync(abs)) continue;
      buf = fs.readFileSync(abs);
    } catch (_e) { continue; }
    if (!buf.length || buf.length > MAX_BYTES_PER_FIGURE) continue;
    out.push({
      media_type: img.media_type,
      data: buf.toString('base64'),
      alt: img.alt || '',
      url: img.url || '',
    });
  }
  return out;
}

/** そのレコードが図を持つか（図はあるが渡せないケースの判定に使う） */
function hasFigures(entry) {
  return !!(entry && Array.isArray(entry.images) && entry.images.length > 0);
}

module.exports = {
  extractFigureRefs,
  fetchAndStoreFigures,
  loadFiguresForEntry,
  hasFigures,
  figureDirFor,
  MEDIA_TYPES,
  MAX_FIGURES_PER_SOURCE,
};
