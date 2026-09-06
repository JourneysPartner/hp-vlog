'use strict';
/**
 * 国税庁のQ&A・事例集カタログ（data/nta-qa）を引く
 *
 * なぜ必要か（2026-09-01）:
 *   カタログはタックスアンサー・質疑応答事例・基本通達の3種類しか収録しておらず、
 *   インボイスの詳細が載っている Q&A（PDF）が入っていなかった。そのため
 *   「インボイス登録をやめたい」の記事が、取消届出書の期限を「12月31日まで」と誤り
 *   （正しくは課税期間の初日から起算して15日前の日まで）、さらに登録した経路で
 *   結論が変わること（経過措置なら2年縛りがある）に触れないまま出た。
 *
 *   全2,222件を全文検索しても2年縛りは1件も収録されておらず、記事に誤りが出てから
 *   手で参考資料に登録する後追いを繰り返していた。それをやめるために取り込んだ。
 *
 * 使い方:
 *   記事の主出典（source_url）には使わない。関連する問の原文を、記事生成の
 *   プロンプトに参考資料として渡すのに使う。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const QA_DIR = path.join(ROOT, 'data', 'nta-qa');
const INDEX_PATH = path.join(QA_DIR, 'index.json');

// 1件あたりの本文の上限。長い資料（多く寄せられるご質問は約10万字）を
// そのまま渡すとプロンプトが膨らみ、主要な論点が埋もれる。
const MAX_BODY_CHARS = 1800;
const DEFAULT_MAX_DOCS = 3;

let _cache;

/** 全角・半角と空白の揺れを吸収する。PDFの抽出結果は「２年」「1,000 万円」のように混在する。 */
const qaSources = require('./nta-qa-sources');

function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, '');
}

function loadIndex() {
  if (_cache !== undefined) return _cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    _cache = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (_) {
    _cache = [];   // 未クロールでも落とさない
  }
  return _cache;
}

/** テスト用にキャッシュを捨てる */
function resetCacheForTest() { _cache = undefined; _dfCache = undefined; }

// 語ごとの「何件の資料に出てくるか」。珍しい語ほど絞り込みに効く。
// 出典探し（nta-source-matcher）で珍しい語を重視したのと同じ考え方。
// 例: 「登録」は93/173件に出るので手がかりにならないが、「やめたい」は1件しかない。
let _dfCache;
function documentFrequency() {
  if (_dfCache !== undefined) return _dfCache;
  _dfCache = new Map();
  const bodies = loadIndex().map(e => normalize(`${e.title} ${readBody(e)}`));
  _dfCache.set('__docs', bodies.length);
  _dfCache.set('__bodies', bodies);
  return _dfCache;
}

function rarityOf(term) {
  const df = documentFrequency();
  const bodies = df.get('__bodies') || [];
  const docs = df.get('__docs') || 1;
  if (!df.has(term)) {
    df.set(term, bodies.filter(b => b.includes(term)).length);
  }
  const n = df.get(term);
  if (n === 0) return 0;                       // どこにも無い語は手がかりにならない
  return Math.log(docs / n);                   // 珍しいほど大きい
}

function readBody(entry) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(QA_DIR, entry.file_path), 'utf8'));
    return String(parsed.body || '');
  } catch (_) {
    return '';
  }
}

/**
 * キーワードで該当する問を探す。
 * 語は正規化して比較するので、全角数字や PDF 由来の空白があっても当たる。
 * @returns {Array<{id,q_no,title,url,body,hits}>} 一致した語の数が多い順
 */
function findQaByKeywords(keywords, options = {}) {
  // 渡された語のうち、絞り込みに効くものだけを使う。
  //   ・長すぎる断片（文をそのまま切ったもの）は Q&A の文言と一致しない
  //   ・ほぼ全件に出てくる語（「登録」は93/173件）は手がかりにならない
  // 2026-09-01: 企画メタをそのまま切って22語渡したところ、ありふれた語で
  // 同点になり、肝心の問7（2年縛りの原文）が上位に来なかった。
  const MAX_TERM_LEN = 16;
  // 全体の半数以上に出てくる語は捨てる。実測では「登録」が93/173件（希少度0.62）で、
  // これを手がかりに含めると、登録に触れるだけの問がすべて同点で並んでしまう。
  const MIN_RARITY = 0.7;
  const all = (Array.isArray(keywords) ? keywords : [keywords])
    .map(k => normalize(k))
    .filter(k => k.length >= 2 && k.length <= MAX_TERM_LEN);
  const terms = [...new Set(all)].filter(t => rarityOf(t) >= MIN_RARITY);
  if (terms.length === 0) return [];

  const maxDocs = Number.isInteger(options.maxDocs) && options.maxDocs > 0
    ? options.maxDocs : DEFAULT_MAX_DOCS;
  const taxDomain = options.taxDomain || null;

  // 資料レベルの絞り込み（2026-09-06）:
  //   税目が同じでも主題が違う資料は候補にしない。income_tax の資料は暗号資産 FAQ
  //   だけなので、これが無いと所得税の記事すべてに暗号資産 FAQ が付く。
  //   記事の企画メタに資料の主題語（nta-qa-sources.SCOPES）が無ければその資料は外す。
  //   scope 未定義の資料はどの記事にも付かない（安全側）。
  const scopeText = options.scopeText != null
    ? options.scopeText
    : (Array.isArray(keywords) ? keywords : [keywords]).join('|');
  const eligible = qaSources.eligibleSourceKeys(scopeText);
  if (eligible.size === 0) return [];

  const scored = [];
  for (const entry of loadIndex()) {
    if (taxDomain && entry.tax_domain !== taxDomain) continue;
    if (!eligible.has(entry.source_key)) continue;
    const body = readBody(entry);
    if (!body) continue;
    const haystack = normalize(`${entry.title} ${body}`);
    const matched = terms.filter(t => haystack.includes(t));
    if (matched.length === 0) continue;
    // 一致した語の珍しさを合計する。ありふれた語ばかり当たっても点は伸びない。
    const hits = matched.reduce((sum, t) => sum + rarityOf(t), 0);
    // 題名に語が含まれる問は、その論点そのものを扱っている可能性が高い。
    // ただし資料名（「インボイス制度に関するQ&A」など）は全件に共通で入っており、
    // これを数えると総集編が常に上位に来る。資料名を除いた見出し部分だけで数える。
    const heading = normalize(entry.title).replace(normalize(entry.source_label), '');
    const titleHits = terms.filter(t => heading.includes(t))
      .reduce((sum, t) => sum + rarityOf(t), 0);
    // 5 文字以上の具体的な語（「2年を経過する日」「取消しを求める旨の届出書」等）が本文に
    // 当たっていれば、見出しに無くても論点を扱っている可能性が高い。
    const strongBodyHit = matched.some(t => t.length >= 5);
    scored.push({
      id: entry.id, q_no: entry.q_no, title: entry.title, url: entry.url,
      source_label: entry.source_label, body, hits, titleHits, strongBodyHit,
      // 総集編（多く寄せられるご質問・事例集）は多数の問をまとめた資料で、
      // どんな語にも当たりやすい。個別の問を優先し、これは後ろに回す。
      digest: entry.digest === true,
      length: body.length,
    });
  }
  // 並び順の考え方:
  //   総集編（多く寄せられるご質問は約3.5万字、事例集は約5千字）は語を多く含むので、
  //   単純な一致数だけで並べると、単一論点を扱う短い問より常に上に来てしまう。
  //   実際、今回の論点でも問7（2年縛りの原文がある1,089字）が4位に落ちた。
  //   題名の一致 → 本文の一致 → 短い順、の優先で並べる。
  // 題名（資料名を除いた見出し）に珍しい語が当たったものを最優先。
  // 次に本文の珍しさ合計。同点なら短い（単一論点の）ものを先に。
  scored.sort((a, b) => (Number(a.digest) - Number(b.digest))
    || (b.titleHits - a.titleHits)
    || (b.hits - a.hits)
    || (a.length - b.length));
  // 文書レベルの下限（2026-09-06）:
  //   見出しに検索語が 1 つも当たらない問は、本文のありふれた語で拾われただけの
  //   可能性が高い（土地の譲渡に「暗号資産取引で損失が生じた場合」が付いたときは
  //   3 問とも titleHits=0 だった）。資料が合っていても、こういう弱い一致は渡さない。
  //   ただし 5 文字以上の具体的な語が本文に当たっているものは、見出しに無くても残す
  //   （資料レベルの絞り込みを通っている前提なので、これは弱い一致ではない）。
  const floored = scored.filter(s => s.titleHits > 0 || s.strongBodyHit);
  return floored.slice(0, maxDocs);
}

/** 本文を上限まで切り詰める。切ったことが分かるようにする。 */
function trimBody(body, maxChars = MAX_BODY_CHARS) {
  const text = String(body || '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * プロンプトに渡すブロックを組み立てる。該当が無ければ空文字。
 */
function buildQaBlock(keywords, options = {}) {
  const found = findQaByKeywords(keywords, options);
  if (found.length === 0) return '';
  const sections = found.map((q) => {
    const { text, truncated } = trimBody(q.body, options.maxChars);
    const label = q.q_no ? `${q.source_label} ${q.q_no}` : q.source_label;
    const note = truncated ? '\n（※長いため冒頭のみ抜粋）' : '';
    return `【${label}】${q.title}\n${q.url}${note}\n---\n${text}\n---`;
  }).join('\n\n');
  return `\n\n═══ 国税庁 Q&A の原文（記事の内容がこれと食い違わないこと）═══\n`
    + `以下は国税庁が公表している Q&A の本文です。制度の細かい要件や例外は\n`
    + `タックスアンサーより Q&A に詳しく書かれていることがあります。\n`
    + `記憶ではなくこの本文を根拠にしてください。\n${sections}`;
}

function catalogStats() {
  const entries = loadIndex();
  const bySource = {};
  for (const e of entries) bySource[e.source_key] = (bySource[e.source_key] || 0) + 1;
  return {
    total: entries.length,
    bySource,
    chars: entries.reduce((sum, e) => sum + (e.char_count_body || 0), 0),
  };
}

module.exports = {
  findQaByKeywords, buildQaBlock, catalogStats, normalize,
  loadIndex, resetCacheForTest, trimBody,
  QA_DIR, INDEX_PATH, MAX_BODY_CHARS,
};
