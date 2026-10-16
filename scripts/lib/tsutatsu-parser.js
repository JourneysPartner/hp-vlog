'use strict';

/**
 * 法令解釈通達（基本通達）のページを解析する。
 *
 * 国税庁の通達ページの構造:
 *   <h2>（物品切手等の発行）</h2>
 *   <p class="indent1"><strong>6－4－5　</strong>事業者が、…</p>
 *
 * 所得税基本通達は条番号が <strong> 2つに分かれる:
 *   <p class="indent1"><strong>37</strong><strong>－13　</strong>一の修理、…</p>
 *
 * そのため、見出しの直後の <p> から太字のタグを連結して条番号を取り出す。
 *
 * 文字コードは Shift_JIS。呼び出し側でデコードしてから渡すこと。
 */

// 全角ハイフン（－ U+FF0D、‐ U+2010、− U+2212、‒、–、—）を半角に寄せる
const DASHES = /[－‐‑‒–—―−]/g;

/** 条番号の表記ゆれを吸収する（6－4－5 → 6-4-5） */
function normalizeProvisionNo(raw) {
  return String(raw || '')
    .replace(DASHES, '-')
    .replace(/[〜~]/g, '～')
    .replace(/[\s　]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\(共\)/g, '共')
    .trim();
}

function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 番号中の文字参照を戻す。本文の従来の整形は変えない。 */
function decodeNumberEntities(html) {
  return html.replace(/&(?:emsp|ensp|thinsp|nbsp);/gi, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, value) => {
      const code = /^x/i.test(value) ? parseInt(value.slice(1), 16) : Number(value);
      return code <= 0x10FFFF ? String.fromCodePoint(code) : entity;
    });
}

/** 段落先頭で連続する strong・span.bold・b を番号として読む。 */
function readNumberHead(paragraph, isValid) {
  let head = paragraph, number = '', longest = null;
  for (;;) {
    const m = head.match(/^((?:\s|&(?:emsp|ensp|thinsp|nbsp);|&#(?:x[0-9a-f]+|\d+);)*)<(strong|span|b)\b([^>]*)>([\s\S]*?)<\/\2\s*>/i);
    if (!m || decodeNumberEntities(m[1]).trim()) break;
    if (m[2].toLowerCase() === 'span') {
      const classes = m[3].match(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (!classes || !(classes[1] || classes[2] || classes[3] || '').split(/\s+/).includes('bold')) break;
    }
    number += decodeNumberEntities(stripTags(m[4]));
    head = head.slice(m[0].length);
    const no = normalizeProvisionNo(number);
    if (isValid && isValid(no)) longest = { no, head };
  }
  // 後続の注記まで太字の場合は、番号として成立する最長の先頭部分を使う。
  if (longest && !isValid(normalizeProvisionNo(number))) return longest;
  return { no: normalizeProvisionNo(number), head };
}

// 条番号として妥当な形か。
// 相続税法基本通達は「・」で複数条にまたがり、「共」で共通関係を示す。
//   1の2-1            通常形
//   1の3・1の4共-1     第1条の3と第1条の4の共通関係
//   2・2の2共-1        第2条と第2条の2の共通関係
// 「の」は章・節・枝番のどこにも入りうる。
//   37-13      所得税の一般形
//   6-4-5      消費税の一般形
//   37-14の2   枝番（末尾）
//   12の5-1-1  章番号に「の」（法人税のリース取引。第12章の5）
//   7-6の2-1   節番号に「の」
// 2026-08-21: 末尾の「の」しか許していなかったため、リース取引の条文を
// 9条まるごと取りこぼしていた。各要素に「のN」を許す形に直す。
// 「181～223共-6」のような共通関係は、範囲全体の外側に「共」が付く。
const PROVISION_NO_ATOM = String.raw`\d{1,3}(?:の\d{1,2})?(?:・\d{1,3}(?:の\d{1,2})?)*`;
const PROVISION_NO_ELEMENT = `${PROVISION_NO_ATOM}(?:～${PROVISION_NO_ATOM})?共?`;
const PROVISION_NO_RE = new RegExp(`^${PROVISION_NO_ELEMENT}(?:-${PROVISION_NO_ELEMENT}){1,3}$`);
function looksLikeProvisionNo(s) {
  return PROVISION_NO_RE.test(normalizeProvisionNo(s));
}

/**
 * 通達の1ページから条文を抽出する。
 *
 * @param {string} html   Shift_JIS からデコード済みの HTML
 * @param {Object} [opts] { url, circular }
 * @returns {{sectionTitle: string, provisions: Array<{no,title,body,url,circular}>, skipped: Array<{no,title}>}}
 */
function parseTsutatsuPage(html, opts = {}) {
  const src = String(html || '');
  assertUsablePage(src);
  if (opts.circular === 'hyoka' || String(opts.circular).startsWith('sochi_')) return parseExtendedPage(src, opts);
  const sectionTitle = stripTags((src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');

  const provisions = [];
  const skipped = [];
  // <h2>見出し</h2> と、それに続く本文ブロックを順に拾う
  const blocks = src.split(/<h2[^>]*>/).slice(1);
  for (const block of blocks) {
    const headEnd = block.indexOf('</h2>');
    if (headEnd < 0) continue;
    const title = stripTags(block.slice(0, headEnd));
    const rest = block.slice(headEnd + 5);

    // 見出し直後の最初の <p> を条番号の行とみなす
    const pMatch = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!pMatch) continue;

    const { no, head } = readNumberHead(pMatch[1], looksLikeProvisionNo);
    if (!no) continue;
    if (!looksLikeProvisionNo(no)) {
      skipped.push({ no, title });
      continue;
    }

    // 条番号の後ろから、次の <h2> までを本文とする
    const bodyHtml = head + rest.slice(pMatch[0].length);
    const body = stripTags(bodyHtml);
    if (!body) continue;

    provisions.push({
      no,
      title,
      body,
      url: opts.url || '',
      circular: opts.circular || '',
    });
  }

  return { sectionTitle, provisions, skipped };
}

/** 目次ページから節ページの URL を集める */
function parseIndexPage(html, circularKey, baseUrl) {
  const src = String(html || '');
  assertUsablePage(src);
  if (circularKey === 'hyoka' || String(circularKey).startsWith('sochi_')) {
    const base = new URL(baseUrl);
    const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
    const urls = new Set();
    for (const m of src.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      const url = new URL(m[1].replace(/&amp;/g, '&'), baseUrl);
      url.hash = ''; url.search = '';
      const relative = url.pathname.slice(directory.length);
      if (url.origin === base.origin && url.pathname.startsWith(directory) && /\.htm$/.test(url.pathname) && url.href !== baseUrl && !/zenbun/.test(relative) && !(circularKey === 'sochi_sozoku' && relative === '02.htm')) urls.add(url.href);
    }
    return [...urls];
  }
  // 相続税は 01/01.htm#a-1_1_2_1 のようにアンカー付きで並ぶため、
  // アンカーを落として重複を潰す。
  const re = new RegExp(`href="([^"]*?/kihon/${circularKey}/[^"]*?\\.htm)(?:#[^"]*)?"`, 'g');
  const seen = new Set();
  const urls = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    let href = m[1];
    if (href.startsWith('/')) href = `https://www.nta.go.jp${href}`;
    else if (!/^https?:/.test(href)) href = new URL(href, baseUrl).toString();
    // 目次自身は除く
    if (/\/01\.htm$/.test(href) && href.split('/').length <= 8) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

function assertUsablePage(html) {
  const title = [...html.matchAll(/<(?:title|h1)[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi)].map(m => stripTags(m[1])).join(' ');
  if (/指定されたページを表示できませんでした|ページが見つかりません/.test(title)) {
    const error = new Error('国税庁のエラーページです');
    error.code = 'NTA_MISSING_PAGE';
    throw error;
  }
}

/** 取得できたページを分類する。通信失敗や解析の例外は呼び出し側で失敗にする。 */
function classifyTsutatsuPage(html, opts = {}) {
  const src = String(html || '');
  const empty = { sectionTitle: '', provisions: [], skipped: [] };
  try {
    assertUsablePage(src);
  } catch (error) {
    if (error.code === 'NTA_MISSING_PAGE') return { ...empty, type: 'missing' };
    throw error;
  }
  const parsed = parseTsutatsuPage(src, opts);
  if (parsed.provisions.length) return { ...parsed, type: 'provisions' };
  if (!hasNtaBody(src)) return { ...parsed, type: 'unreadable' };
  // 形が未知の番号も読み落としとして止める。番号を受け入れる判定とは分ける。
  const heads = [...src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => readNumberHead(m[1]).no).filter(Boolean);
  const hasNumber = heads.some(no => /^\d/.test(no) && (opts.circular === 'hyoka' || !/^\d+$/.test(no)));
  const pathname = new URL(opts.url || '/', 'https://www.nta.go.jp').pathname;
  const appendix = /\/(fusoku|bessi|zenbun)(\/|\.htm)/i.test(pathname);
  if (hasNumber && !appendix) return { ...parsed, type: 'unreadable' };
  const examples = [...new Set(heads.filter(no => /^(?:旧)?\d/.test(no)))].slice(0, 3);
  const reason = appendix ? '附則・別紙・前文のページです' : '段落の先頭に番号らしい書式がありません';
  return { ...parsed, type: 'non_provision', reason: reason + (examples.length ? `（読めなかった番号の例: ${examples.join('、')}）` : '') };
}

/** 項目なしとするには、閉じた国税庁本文ページと十分な本文が必要。 */
function hasNtaBody(src) {
  const title = stripTags(src.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  if (!/｜国税庁$/.test(title)) return false;
  const rawBody = src.match(/<body\b[^>]*>([\s\S]*?)<\/body>\s*<\/html>\s*$/i)?.[1];
  if (!rawBody || !/<html\b[^>]*>/i.test(src)) return false;
  const body = rawBody.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const frame = body.match(/<(div|main|section)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*\b(?:imp-cnt-tsutatsu|bodyArea)\b[^"']*["'][^>]*>/i);
  const marker = frame || body.match(/<[^>]+\bclass\s*=\s*["'][^"']*\bpage-header\b[^"']*["'][^>]*>|<h1\b[^>]*>/i);
  if (!marker) return false;
  let text = body.slice(marker.index);
  if (frame) {
    // 本文枠の外にあるナビゲーション等で、空の本文を正常扱いしない。
    const start = frame.index + frame[0].length;
    let depth = 1, end = -1;
    for (const tag of body.slice(start).matchAll(new RegExp(`<(/?)${frame[1]}\\b[^>]*>`, 'gi'))) {
      if (tag[1]) depth--; else if (!/\/>$/.test(tag[0])) depth++;
      if (depth === 0) { end = start + tag.index; break; }
    }
    if (end < 0) return false;
    text = body.slice(start, end);
  }
  text = text.split(/<(?:footer|nav)\b/i)[0];
  return stripTags(decodeNumberEntities(text)).replace(/\s/g, '').length >= 50;
}

// 措置法・評価の従来の番号判定。通常用とは別のままにする。
function looksLikeExtendedProvisionNo(no, opts) {
  const atom = '\\d{1,3}(?:の\\d{1,2})*(?:・\\d{1,3}(?:の\\d{1,2})*)*共?(?:\\(\\d+\\))?';
  const valid = new RegExp(`^${atom}(?:-${atom}){${opts.circular === 'hyoka' ? '0,3' : '1,3'}}$`).test(no);
  return valid;
}

/** 新しい通達は見出し1件に複数の番号が続くため、番号行を区切りにする。 */
function parseExtendedPage(src, opts) {
  const sectionTitle = stripTags((src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const provisions = [], skipped = [];
  let title = '', current = null;
  const finish = () => {
    if (!current) return;
    const body = stripTags(current.html.replace(/&(?:emsp|ensp);/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value))));
    if (body) provisions.push({ no: current.no, title: current.title, body, url: opts.url || '', circular: opts.circular });
    current = null;
  };
  // 本文の末尾のナビゲーションを取り込まない。
  // h1 のない旧形式でも、ヘッダー内の区切りを本文末尾と誤認しない。
  const bodyStart = src.search(/<!--\s*InstanceBeginEditable\s+name=["']bodyArea["']\s*-->/i);
  const contentStart = bodyStart >= 0 ? bodyStart : src.search(/<h[12]\b/i);
  const cutoff = contentStart >= 0 ? src.indexOf('<!-- InstanceEndEditable -->', contentStart) : -1;
  const content = cutoff >= 0 ? src.slice(0, cutoff) : src;
  const matches = [...content.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>|<p\b[^>]*>[\s\S]*?<\/p>/gi)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i], token = m[0];
    if (/^<h2/i.test(token)) { finish(); title = stripTags(token); continue; }
    const p = token.replace(/^<p[^>]*>/i, '').replace(/<\/p>$/i, '');
    const { no, head } = readNumberHead(p, no => looksLikeExtendedProvisionNo(no, opts) || looksLikeProvisionNo(no));
    // 通常用ですでに認めている共通関係の範囲形も、同じ番号判定で補完する。
    if (looksLikeExtendedProvisionNo(no, opts) || looksLikeProvisionNo(no)) {
      finish(); current = { no, title, html: head };
    } else if (current) current.html += token;
    const end = m.index + token.length;
    if (current) current.html += content.slice(end, matches[i + 1]?.index ?? end);
  }
  finish();
  return { sectionTitle, provisions, skipped };
}

module.exports = {
  normalizeProvisionNo,
  looksLikeProvisionNo,
  stripTags,
  parseTsutatsuPage,
  parseIndexPage,
  PROVISION_NO_RE,
  assertUsablePage,
  classifyTsutatsuPage,
};
