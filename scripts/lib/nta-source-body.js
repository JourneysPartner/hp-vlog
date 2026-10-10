'use strict';

/**
 * 国税庁カタログから「出典の本文」を取り出す。
 *
 * 背景（2026-08-16）:
 *   生成プロンプトには出典のタイトルとURLしか渡しておらず、本文は一切
 *   渡していなかった。LLM は出典を読まずに記憶で書き、番号だけを引用する
 *   ため、次のような事故が繰り返し起きた。
 *     - 「No.6459 も『日当については、課税仕入れに該当しない』と明示」
 *       → 原文は正反対（「課税仕入れになります」）。引用自体が捏造。
 *     - 自販機特例の対象にコインパーキングを含める（原文の列挙にない）
 *     - プラットフォーム課税を国内事業者に適用（原文は国外事業者限定）
 *   いずれも本文を渡していれば防げた誤りだった。
 *
 * カタログ（data/nta-sources/）には全文が保存済みなので、それを使う。
 * ネットワークには接続しない。カタログ障害時は null を返し、
 * 呼び出し側は従来どおり（タイトル+URLのみ）で動作する。
 */

const fs = require('fs');
const path = require('path');
const { checkCitations, buildProvisionBlock } = require('./nta-tsutatsu');
const { excerptText, positiveLimit } = require('./source-excerpt');
const { UNSOURCED_RULE, DEADLINE_RULE } = require('./grounding-rules');

const ROOT = path.join(__dirname, '..', '..');
const TAXANSWER_DIR = path.join(ROOT, 'data', 'nta-sources', 'taxanswer');
const SHITSUGI_DIR = path.join(ROOT, 'data', 'nta-sources', 'shitsugi');

// 長いページは論点に合う段落を優先する。
const DEFAULT_MAX_CHARS = 6000;
const MAX_KANKEI_TSUTATSU = 3;

/** URL から taxanswer のセクションと番号を取り出す */
function parseTaxanswerUrl(url) {
  const m = String(url || '').match(/taxanswer\/([a-z]+)\/(\d{4})\.htm/);
  return m ? { section: m[1], no: m[2] } : null;
}

/** URL から質疑応答事例の税目・セクション・番号を取り出す */
function parseShitsugiUrl(url) {
  const m = String(url || '').match(/law\/shitsugi\/([a-z]+)\/([a-z0-9_-]+)\/([a-z0-9_-]+)\.htm/i);
  return m ? { category: m[1], section: m[2], id: m[3] } : null;
}

/**
 * 出典URLに対応するカタログのファイルパスを返す。
 *
 * 本文（loadSourceBody）と図（loadSourceFigures）は必ずこの1つの写像を通す。
 * 別経路で探すと、本文と図が違う出典のものになりうるため。
 */
function resolveSourceFile(url) {
  const taxanswer = parseTaxanswerUrl(url);
  if (taxanswer) return path.join(TAXANSWER_DIR, taxanswer.section, `${taxanswer.no}.json`);
  const shitsugi = parseShitsugiUrl(url);
  if (shitsugi) return path.join(SHITSUGI_DIR, shitsugi.category, shitsugi.section, `${shitsugi.id}.json`);
  return null;
}

/**
 * 出典URLに対応する本文を返す。
 * @returns {{no:string, title:string, url:string, body:string, truncated:boolean}|null}
 */
function loadSourceBody(url, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars : DEFAULT_MAX_CHARS;
  const taxanswer = parseTaxanswerUrl(url);
  const shitsugi = parseShitsugiUrl(url);
  if (!taxanswer && !shitsugi) return null;   // カタログ収録対象外（パンフレット等）

  const file = resolveSourceFile(url);
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (entry.deleted === true) return null;
    const sourceBody = taxanswer
      ? entry.body
      : (entry.body_combined || [entry.shokai_yoshi, entry.kaitou_yoshi].filter(Boolean).join(' '));
    const raw = String(sourceBody || '').replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    const truncated = raw.length > maxChars;
    return {
      no: String(entry.id || (taxanswer ? taxanswer.no : shitsugi.id)),
      title: entry.title || '',
      url,
      body: truncated ? excerptText(raw, options.query || '', maxChars) : raw,
      truncated,
      kind: taxanswer ? 'taxanswer' : 'shitsugi',
      law_version: entry.law_version || '',
    };
  } catch (_error) {
    return null;   // 破損・読込失敗はカタログ無しとして扱う
  }
}

/**
 * 生成プロンプトに差し込む「出典本文ブロック」を組み立てる。
 *
 * @param {Object} topic         記事トピック（source_url / source_title を持つ）
 * @param {Array}  refs          getRefsForTopic() の戻り（参考出典・優先度順）
 * @param {Object} options       { maxRefs, maxChars }
 * @returns {string} プロンプトに連結する文字列（該当なしなら空文字）
 */
function buildSourceBodyBundle(topic = {}, refs = [], options = {}) {
  const maxRefs = Number.isInteger(options.maxRefs) ? options.maxRefs : 1;
  const maxChars = positiveLimit(options.maxChars ?? process.env.SOURCE_BODY_MAX_CHARS_PER_PAGE, DEFAULT_MAX_CHARS);
  const maxTotal = positiveLimit(options.maxTotal ?? process.env.SOURCE_BODY_MAX_CHARS_TOTAL, 24000);
  const query = [topic.tax_terms, topic.source_term, topic.title, topic.primary_question].filter(Boolean).join(' ');
  const log = options.log || console.log;

  const loaded = [];
  const seen = new Set();
  const dropped = [];
  const ordered = [];
  let total = 0;
  const candidates = [
    { url: topic.source_url, title: topic.source_title, role: '主出典' },
    ...(topic.source_supplements || []).map(r => ({ ...r, role: '補助出典' })),
  ];
  let refsAdded = 0;
  for (const r of refs || []) {
    if (!r?.url || candidates.some(c => c.url === r.url) || refsAdded >= maxRefs) continue;
    candidates.push({ ...r, role: '参考' });
    refsAdded++;
  }
  for (const r of candidates) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const b = loadSourceBody(r.url, { maxChars, query });
    if (!b) {
      dropped.push({ ...r, reason: 'カタログに本文なし' });
      ordered.push({ ...r, reason: 'カタログに本文なし', included: false });
      log(`[source] 本文なし: ${r.role} ${r.url}`);
      continue;
    }
    if (total + b.body.length > maxTotal) {
      dropped.push({ ...b, role: r.role, reason: '合計予算超過' });
      ordered.push({ ...b, role: r.role, reason: '合計予算超過', included: false });
      log(`[source] 予算で題名のみ: ${b.kind} ${b.no} ${b.body.length}文字`);
      continue;
    }
    total += b.body.length;
    loaded.push({ ...b, role: r.role });
    ordered.push({ ...b, role: r.role, included: true });
    log(`[source] 資料: ${r.role} ${b.kind} ${b.no} ${b.body.length}文字 ${b.truncated ? '抜粋' : '全文'}`);
  }

  const sections = ordered.map(s => {
    if (!s.included) return `【${s.role}・題名のみ】${s.title || s.url}\n${s.url}\n（${s.reason}。原文が無いため具体的な要件・金額・期限の根拠にしない）`;
    const label = s.kind === 'shitsugi'
      ? `【${s.role}】国税庁 質疑応答事例「${s.title}」`
      : `【${s.role}】国税庁タックスアンサー No.${s.no}「${s.title}」`;
    const note = s.truncated ? '\n（※本文が長いため論点に合う段落を優先した抜粋）' : '';
    return `${label}\n${s.url}${note}\n---\n${s.body}\n---`;
  }).join('\n\n');

  const block = loaded.length ? `

═══ 出典の本文（これが唯一の根拠。記憶で補わないこと）═══
以下は上記の出典ページの実際の本文です。記事の事実関係は、この本文に
書かれている内容だけを根拠にしてください。

【厳守】
1. 出典を引用・言及するときは、<strong>ここに実際に書かれている内容だけ</strong>を書く。
   本文に無いことを「出典が明示している」「国税庁が示している」と書くのは捏造であり厳禁。
2. 制度の<strong>対象範囲（誰が/何が対象か）</strong>は、本文の列挙をそのまま守る。
   本文の列挙に無いものを勝手に対象へ加えない（列挙は限定列挙として扱う）。
3. 金額の上限・期間・割合などの数値は、本文に書かれた値をそのまま使う。
   本文に無い数値は書かない。
4. ${UNSOURCED_RULE}
5. 本文と自分の記憶が食い違う場合は<strong>必ず本文を優先</strong>する。
6. 出典ページに図（画像）がある事例では、要点が図にしか書かれていないことがある。
   図が渡されていない場合、図に書かれているはずの数値・続柄・関係を推測して書かない。
   <strong>説明のための設例であっても、出典に無い数値を自分で作ってはならない</strong>
   （2026-09-06、議決権割合を創作して結論まで誤った事故が実際に起きている）。
7. ${DEADLINE_RULE}

${sections}` : '';
  return { block, sources: loaded, dropped, totalChars: total };
}

function buildSourceBodyBlock(topic = {}, refs = [], options = {}) {
  return buildSourceBodyBundle(topic, refs, options).block;
}

/** 出典の「関係法令」欄から、カタログで解決できる通達だけを引く。 */
function findTsutatsuFromSourceKankei(topic = {}) {
  try {
    const file = resolveSourceFile(topic.source_url);
    if (!file || !fs.existsSync(file)) return [];
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!entry || entry.deleted === true) return [];
    const text = String(entry.kankei_hourei || '');
    if (!text) return [];
    // 他法の通達が多い事例でもプロンプトを圧迫しないよう、実在する先頭3件に限る。
    return checkCitations(text).citations.filter(c => c.found).slice(0, MAX_KANKEI_TSUTATSU);
  } catch (_error) {
    return [];   // カタログ障害で日次生成そのものを止めない
  }
}

/** 出典の「関係法令」欄を橋渡しした通達原文ブロック。 */
function buildTsutatsuBlockFromSourceKankei(topic = {}, options = {}) {
  const refs = findTsutatsuFromSourceKankei(topic)
    .filter(c => !(options.exclude || []).some(ref => ref.circular === c.circular && ref.no === c.no))
    .map(c => ({ no: c.no, circular: c.circular }));
  return buildProvisionBlock(refs);
}

/**
 * 主出典（記事が根拠として掲げる出典）の図だけを読み出す。
 *
 * 参考出典の図は返さない。プロンプトには主出典と参考出典の本文が同時に載るため、
 * 双方の図を並べるとモデルがどちらの図か区別できず、設例を取り違える。
 *
 * @returns {{figures:Array, hasFigures:boolean, title:string, url:string}}
 */
function loadSourceFigures(topic = {}) {
  const empty = { figures: [], hasFigures: false, title: '', url: topic.source_url || '' };
  const file = resolveSourceFile(topic.source_url);
  if (!file) return empty;
  let entry;
  try {
    if (!fs.existsSync(file)) return empty;
    entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return empty;
  }
  if (!entry || entry.deleted === true) return empty;
  const ntaFigures = require('./nta-figures');
  return {
    figures: ntaFigures.loadFiguresForEntry(entry),
    hasFigures: ntaFigures.hasFigures(entry),
    title: entry.title || '',
    url: topic.source_url || '',
  };
}

module.exports = {
  loadSourceBody,
  buildSourceBodyBlock,
  buildSourceBodyBundle,
  findTsutatsuFromSourceKankei,
  buildTsutatsuBlockFromSourceKankei,
  loadSourceFigures,
  resolveSourceFile,
  parseTaxanswerUrl,
  parseShitsugiUrl,
  DEFAULT_MAX_CHARS,
};
