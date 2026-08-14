'use strict';

/**
 * LLM 補助の出典選定（A＝カタログ税目内 → B＝curated refs → C＝カタログ全横断 → D＝Web発見）。
 *
 * 目的:
 *   ルールベース matcher（nta-source-matcher）が低確信で domain-fallback に倒れるとき、
 *   検証済みローカル国税庁カタログから候補を出し、LLM（GPT-5.6 Luna 想定）に
 *   「候補の中から最適な1件」を選ばせて、記事に的確な出典を載せる。
 *   カタログに該当がない場合は、Luna が国税庁サイト内のページを提案し、
 *   HTTP で実在確認した上で採用する（Tier D）。
 *
 * 安全原則（重要）:
 *   - Tier A/B/C: LLM には必ず「候補リストの中から番号で選ぶ」だけをさせる。
 *   - Tier D: Luna が URL を提案するが、HTTP GET で実在確認 + タイトル取得してから
 *     改めて候補リストとして提示し直す。未検証 URL をそのまま採用しない。
 *   - provenance は 'llm-auto'（trusted ではない）。承認前に人が確認する設計は不変。
 *
 * テスト容易性:
 *   LLM 呼び出しは callLLM(system, user)=>Promise<string> として注入する。
 *   HTTP 取得は fetchNTAPage(url)=>Promise<{ok,title}> として注入可。
 */

const https = require('https');
const { rankSources } = require('./nta-source-matcher');

const A_LIMIT = 5;    // A: 税目カテゴリ内の上位
const B_LIMIT = 15;   // B: curated refs の上限
const C_LIMIT = 30;   // C: 全カテゴリ横断の上位
const D_SUGGEST_LIMIT = 5; // D: Luna が提案する URL 数の上限
const DEFAULT_MIN_CONFIDENCE = 0.5;
const FETCH_TIMEOUT_MS = 8000;

function topicSummary(topic = {}) {
  return [
    `テーマ(slug): ${topic.slug || ''}`,
    `参考タイトル: ${topic.title || '(未定)'}`,
    `顧客カテゴリ: ${topic.customer_segment || topic.persona || ''}`,
    `税目: ${topic.tax_domain || ''}`,
    `論点(pain_point): ${topic.pain_point || ''}`,
    `検索意図: ${topic.search_intent || ''}`,
    `読者の課題: ${topic.reader_problem || ''}`,
  ].filter(Boolean).join('\n');
}

function formatCandidates(candidates) {
  return candidates
    .map((c, i) => {
      const label = c.no && c.no !== 'N/A' ? `No.${c.no}` : c.url;
      return `${i + 1}. [${label}] ${c.title}`;
    })
    .join('\n');
}

function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

const SYSTEM_PROMPT =
  'あなたは日本の税務記事の「出典選定」アシスタントです。' +
  '与えられた記事テーマに最も適合する国税庁ページを、提示された候補リストの中から1つだけ選びます。' +
  '重要な制約:\n' +
  '- 必ず候補リストにある番号だけを選ぶこと。リストに無いページ番号やURLを創作してはいけない。\n' +
  '- テーマの論点（pain_point）に直接対応する正本を優先する。\n' +
  '- 適合するものが候補に無ければ choice を null にする（無理に選ばない）。\n' +
  '出力は次の JSON のみ:\n' +
  '{"choice": <候補番号(1始まり) または null>, "confidence": <0〜1の数値>, "reason": "<日本語で簡潔な理由>"}';

/**
 * 候補リストを1回 LLM に渡して選ばせる。
 * @returns {Object|null} { url, title, no, confidence, reason } or null
 */
async function pickFromCandidates(topic, candidates, callLLM) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const user =
    `# 記事テーマ\n${topicSummary(topic)}\n\n` +
    `# 候補（この中の番号からのみ選ぶ）\n${formatCandidates(candidates)}\n\n` +
    `# 出力（JSONのみ）`;
  let raw;
  try { raw = await callLLM(SYSTEM_PROMPT, user); }
  catch (e) { throw new Error(`LLM呼び出し失敗: ${e.message}`); }

  const parsed = parseJsonLoose(raw);
  if (!parsed || parsed.choice === null || parsed.choice === undefined) return null;

  const idx = Number(parsed.choice) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null;

  const c = candidates[idx];
  const confidence = Number(parsed.confidence);
  return {
    url: c.url,
    title: c.title,
    no: c.no,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: String(parsed.reason || '').slice(0, 200),
  };
}

// ── Tier B: curated refs ──────────────────────────────────────────
function collectCuratedCandidates(topic) {
  let REFS, DEFAULT_SOURCE_BY_PAIN, DEFAULT_SOURCE_BY_TAX_DOMAIN;
  try {
    ({ REFS, DEFAULT_SOURCE_BY_PAIN, DEFAULT_SOURCE_BY_TAX_DOMAIN } = require('./tax-authority-refs'));
  } catch (_) { return []; }

  const seen = new Set();
  const out = [];
  function add(r) {
    if (!r || !r.url || seen.has(r.url)) return;
    seen.add(r.url);
    out.push({ no: r.no || 'N/A', title: r.title, url: r.url });
  }

  const domain = topic.tax_domain || '';
  if (REFS[domain]) REFS[domain].forEach(add);
  if (domain !== 'invoice_system' && REFS.invoice_system) REFS.invoice_system.forEach(add);
  if (DEFAULT_SOURCE_BY_TAX_DOMAIN[domain]) add(DEFAULT_SOURCE_BY_TAX_DOMAIN[domain]);

  for (const [, ref] of Object.entries(DEFAULT_SOURCE_BY_PAIN)) add(ref);

  return out.slice(0, B_LIMIT);
}

// ── Tier D: Web discovery ─────────────────────────────────────────
const DISCOVER_SYSTEM =
  'あなたは日本の国税庁ウェブサイト(nta.go.jp)の構造に詳しい税務アシスタントです。\n' +
  '与えられた記事テーマに最も関連する国税庁のページURLを提案してください。\n' +
  'タックスアンサー（/taxanswer/）だけでなく、以下のような種類のページも含めてください：\n' +
  '- 概要・特集ページ（/zeimokubetsu/ 等）\n' +
  '- パンフレット（/publication/pamph/ 等）\n' +
  '- Q&A・通達\n' +
  '重要な制約:\n' +
  '- URLは https://www.nta.go.jp/ で始まるもののみ\n' +
  '- 確信のあるページだけを挙げること（存在しないURLは厳禁）\n' +
  '- 3〜5件を目安に提案すること\n' +
  '出力は次のJSONのみ:\n' +
  '{"suggestions": [{"url": "https://www.nta.go.jp/...", "title": "ページタイトル（推定可）"}]}';

function extractNoFromUrl(url) {
  const m = String(url).match(/\/(\d{4})\.htm/);
  return m ? m[1] : 'N/A';
}

function extractTitleFromHtml(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim().replace(/\|.*$/, '').trim() || null;
}

function decodeHtml(buf) {
  const raw = buf.toString('binary');
  const m = raw.match(/charset=([\w-]+)/i);
  const charset = (m ? m[1] : '').toLowerCase().replace(/[-_]/g, '');
  if (charset === 'shiftjis' || charset === 'sjis' || charset === 'ms932' || charset === 'windows31j') {
    try { return new TextDecoder('shift_jis').decode(buf); } catch (_) {}
  }
  if (charset === 'eucjp') {
    try { return new TextDecoder('euc-jp').decode(buf); } catch (_) {}
  }
  return buf.toString('utf8');
}

const NTA_ERROR_PATTERNS = /指定されたページ|ページが見つかり|404|not found/i;

function defaultFetchNTAPage(url, _depth) {
  const depth = _depth || 0;
  return new Promise((resolve) => {
    if (!String(url).startsWith('https://www.nta.go.jp/')) {
      return resolve({ ok: false, title: null });
    }
    const timer = setTimeout(() => resolve({ ok: false, title: null }), FETCH_TIMEOUT_MS);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        clearTimeout(timer);
        const loc = res.headers.location.startsWith('/')
          ? `https://www.nta.go.jp${res.headers.location}`
          : res.headers.location;
        res.resume();
        if (!loc.startsWith('https://www.nta.go.jp/')) return resolve({ ok: false, title: null });
        return defaultFetchNTAPage(loc, depth + 1).then(resolve);
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        res.resume();
        return resolve({ ok: false, title: null });
      }
      const chunks = [];
      let totalLen = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        totalLen += chunk.length;
        if (totalLen > 100000) res.destroy();
      });
      res.on('end', () => {
        clearTimeout(timer);
        const body = decodeHtml(Buffer.concat(chunks));
        const title = extractTitleFromHtml(body);
        if (title && NTA_ERROR_PATTERNS.test(title)) {
          return resolve({ ok: false, title: null });
        }
        resolve({ ok: true, title });
      });
      res.on('error', () => { clearTimeout(timer); resolve({ ok: false, title: null }); });
    });
    req.on('error', () => { clearTimeout(timer); resolve({ ok: false, title: null }); });
  });
}

async function discoverAndValidate(topic, callLLM, fetchPage) {
  const user =
    `# 記事テーマ\n${topicSummary(topic)}\n\n` +
    `上記テーマに最も適切な国税庁ページのURLを提案してください。\n# 出力（JSONのみ）`;

  let raw;
  try { raw = await callLLM(DISCOVER_SYSTEM, user); }
  catch (_) { return []; }

  const parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.suggestions)) return [];

  const validated = [];
  const urls = parsed.suggestions
    .slice(0, D_SUGGEST_LIMIT)
    .map(s => s && s.url)
    .filter(u => u && String(u).startsWith('https://www.nta.go.jp/'));

  const results = await Promise.all(urls.map(u => fetchPage(u).then(r => ({ url: u, ...r }))));
  for (const r of results) {
    if (!r.ok) continue;
    const suggestion = parsed.suggestions.find(s => s && s.url === r.url);
    validated.push({
      no: extractNoFromUrl(r.url),
      title: r.title || (suggestion && suggestion.title) || r.url,
      url: r.url,
    });
  }
  return validated;
}

/**
 * A（税目カテゴリ内）→ B（curated refs）→ C（全カテゴリ横断）→ D（Web発見）の順で選定。
 * @param {Object} topic
 * @param {Object} opts { callLLM, minConfidence, fetchPage }
 * @returns {Object|null} { url, title, no, confidence, reason, provenance:'llm-auto', tier }
 */
async function resolveSourceWithLLM(topic, opts = {}) {
  const callLLM = opts.callLLM;
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;
  const fetchPage = typeof opts.fetchPage === 'function' ? opts.fetchPage : defaultFetchNTAPage;

  // A: 税目カテゴリ内の上位5件から選定
  const aRank = rankSources(topic, { limit: A_LIMIT });
  const aPick = await pickFromCandidates(topic, aRank.candidates || [], callLLM);
  if (aPick && aPick.confidence >= minConfidence) {
    return { ...aPick, provenance: 'llm-auto', tier: 'A' };
  }

  // B: curated refs（タックスアンサー以外の国税庁ページを含む）
  const bCandidates = collectCuratedCandidates(topic);
  if (bCandidates.length > 0) {
    const bPick = await pickFromCandidates(topic, bCandidates, callLLM);
    if (bPick && bPick.confidence >= minConfidence) {
      return { ...bPick, provenance: 'llm-auto', tier: 'B' };
    }
  }

  // C: 全カテゴリ横断の上位30件から選定
  const cRank = rankSources(topic, { allCategories: true, limit: C_LIMIT });
  const cPick = await pickFromCandidates(topic, cRank.candidates || [], callLLM);
  if (cPick && cPick.confidence >= minConfidence) {
    return { ...cPick, provenance: 'llm-auto', tier: 'C' };
  }

  // D: Luna が NTA サイト内の URL を提案 → HTTP 実在確認 → 選定
  const dCandidates = await discoverAndValidate(topic, callLLM, fetchPage);
  if (dCandidates.length > 0) {
    const dPick = await pickFromCandidates(topic, dCandidates, callLLM);
    if (dPick && dPick.confidence >= minConfidence) {
      return { ...dPick, provenance: 'llm-auto', tier: 'D' };
    }
  }

  return null;
}

/**
 * 本番用の callLLM（OpenAI GPT-5.6 Luna）。
 */
function makeOpenAILuna() {
  const model = process.env.LLM_SOURCE_SELECT_MODEL || 'gpt-5.6-luna';
  const _sdk = require('openai');
  const OpenAI = _sdk.default || _sdk.OpenAI || _sdk;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return async (system, user) => {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });
    return completion.choices && completion.choices[0]
      ? (completion.choices[0].message && completion.choices[0].message.content) || ''
      : '';
  };
}

module.exports = {
  resolveSourceWithLLM,
  pickFromCandidates,
  makeOpenAILuna,
  parseJsonLoose,
  collectCuratedCandidates,
  discoverAndValidate,
  defaultFetchNTAPage,
  _internals: {
    topicSummary, formatCandidates,
    A_LIMIT, B_LIMIT, C_LIMIT, D_SUGGEST_LIMIT, DEFAULT_MIN_CONFIDENCE,
    extractNoFromUrl, extractTitleFromHtml,
    DISCOVER_SYSTEM,
  },
};
