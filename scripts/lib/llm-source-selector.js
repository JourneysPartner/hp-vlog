'use strict';

/**
 * LLM 補助の出典選定（A＝Luna 選定 ＋ C＝Luna 深掘り）。
 *
 * 目的:
 *   ルールベース matcher（nta-source-matcher）が低確信で domain-fallback に倒れるとき、
 *   検証済みローカル国税庁カタログから候補を出し、LLM（GPT-5.6 Luna 想定）に
 *   「候補の中から最適な1件」を選ばせて、記事に的確な出典を載せる。
 *
 * 安全原則（重要）:
 *   - LLM には必ず「候補リストの中から番号で選ぶ」だけをさせる。番号/URL の創作は不可。
 *   - LLM が返した番号が候補範囲外なら棄却（幻覚防止）。返り値の URL は必ずカタログ由来。
 *   - provenance は 'llm-auto'（trusted ではない）。承認前に人が確認する設計は不変。
 *     （source-alignment は explicit/curated のみ trusted。llm-auto は needs_source_review のまま）
 *
 * テスト容易性:
 *   LLM 呼び出しは callLLM(system, user)=>Promise<string> として注入する。
 *   本番では makeOpenAILuna() を渡す。テストではフェイク関数を渡す。
 */

const { rankSources } = require('./nta-source-matcher');

const A_LIMIT = 5;    // A: 税目カテゴリ内の上位
const C_LIMIT = 30;   // C: 全カテゴリ横断の上位（語彙スコアで薄いテーマの取りこぼしを減らすため広め）
const DEFAULT_MIN_CONFIDENCE = 0.5;

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
    .map((c, i) => `${i + 1}. [No.${c.no}] ${c.title}`)
    .join('\n');
}

function parseJsonLoose(text) {
  if (!text) return null;
  // ```json フェンスや前後の説明を除去して最初の { … } を拾う
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
  // 幻覚棄却: 候補範囲外の番号は不採用
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

/**
 * A（税目カテゴリ内）→ C（全カテゴリ横断）の順で LLM 選定を試みる。
 * @param {Object} topic
 * @param {Object} opts { callLLM, minConfidence }
 * @returns {Object|null} { url, title, no, confidence, reason, provenance:'llm-auto', tier:'A'|'C' }
 */
async function resolveSourceWithLLM(topic, opts = {}) {
  const callLLM = opts.callLLM;
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;

  // A: 税目カテゴリ内の上位5件から選定
  const aRank = rankSources(topic, { limit: A_LIMIT });
  const aPick = await pickFromCandidates(topic, aRank.candidates || [], callLLM);
  if (aPick && aPick.confidence >= minConfidence) {
    return { ...aPick, provenance: 'llm-auto', tier: 'A' };
  }

  // C: 全カテゴリ横断の上位20件から選定（税目カテゴリ外の正本も拾う）
  const cRank = rankSources(topic, { allCategories: true, limit: C_LIMIT });
  const cPick = await pickFromCandidates(topic, cRank.candidates || [], callLLM);
  if (cPick && cPick.confidence >= minConfidence) {
    return { ...cPick, provenance: 'llm-auto', tier: 'C' };
  }

  return null;
}

/**
 * 本番用の callLLM（OpenAI GPT-5.6 Luna）。
 * モデルは LLM_SOURCE_SELECT_MODEL（既定 gpt-5.6-luna）。
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
  _internals: { topicSummary, formatCandidates, A_LIMIT, C_LIMIT, DEFAULT_MIN_CONFIDENCE },
};
