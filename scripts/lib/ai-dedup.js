'use strict';

const { generateAux } = require('./aux-model');

const SYSTEM_PROMPT = `あなたは日本の税務ブログの編集者です。
候補トピックが既存記事と内容的に重複しているか判定してください。

判定基準:
- 読者にとって「同じ疑問に同じ角度で答える記事」なら重複（duplicate: true）
- slug やタイトルの文字面が違っても、扱う論点・対象者・状況が実質同じなら重複
- 同じ税制度でも、対象者（ペルソナ）や状況（開業期/成長期/副業）が明確に異なれば非重複
- 基本解説(guide)と実践Tips(practice/misconception_fix)は、同一テーマでも別記事として非重複

応答は指定の JSON 配列のみ。説明文や前置きは不要。`;

function buildCorpusSummary(corpus) {
  const lines = [];
  for (const p of corpus) {
    if (!p.slug) continue;
    const parts = [p.slug];
    if (p.title) parts.push(p.title);
    const q = p.primary_question || p.search_intent;
    if (q) parts.push(q);
    if (p.category) parts.push(p.category);
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

function buildCandidateBlock(topic, idx) {
  const lines = [`### 候補${idx + 1}`];
  lines.push(`slug: ${topic.slug}`);
  if (topic.title) lines.push(`title: ${topic.title}`);
  if (topic.search_intent) lines.push(`intent: ${topic.search_intent}`);
  if (topic.primary_question) lines.push(`question: ${topic.primary_question}`);
  if (topic.persona) lines.push(`persona: ${topic.persona}`);
  if (topic.category) lines.push(`category: ${topic.category}`);
  if (topic.pain_point) lines.push(`pain: ${topic.pain_point}`);
  if (topic.business_stage) lines.push(`stage: ${topic.business_stage}`);
  if (topic.article_type) lines.push(`type: ${topic.article_type}`);
  return lines.join('\n');
}

/**
 * picks（選定済み候補 1〜2 件）を既存コーパスと照合し、
 * Haiku で意味的重複を判定する。
 *
 * aux 未有効・APIエラー時は skipped: true を返し、候補はそのまま通過する。
 *
 * @param {Array} picks  - selectDailyTopics が返した候補
 * @param {Array} corpus - 既存記事 + 未マージ下書き
 * @returns {{ results: Array, skipped: boolean }}
 */
async function checkDuplicatesWithAI(picks, corpus) {
  if (!picks || picks.length === 0) return { results: [], skipped: true };

  const candidateBlocks = picks
    .map((t, i) => buildCandidateBlock(t, i))
    .join('\n\n');
  const corpusSummary = buildCorpusSummary(corpus);

  const userPrompt = `## 候補トピック
${candidateBlocks}

## 既存記事一覧（slug | title | question | category）
${corpusSummary}

## 応答形式
JSON配列で返してください:
[{"slug":"候補のslug","duplicate":true,"similar_to":"重複先のslug","reason":"判定理由（1文）"}]
duplicateがfalseの場合、similar_toはnullにしてください。`;

  const raw = await generateAux({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    task: 'ai_dedup',
    maxTokens: 400,
  });

  if (!raw) return { results: [], skipped: true };

  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[ai-dedup] LLM応答にJSON配列が見つからない');
      return { results: [], skipped: true, parseError: true };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return { results: [], skipped: true, parseError: true };
    }
    return { results: parsed, skipped: false };
  } catch (e) {
    console.warn(`[ai-dedup] JSON parse失敗: ${e.message}`);
    return { results: [], skipped: true, parseError: true };
  }
}

module.exports = { checkDuplicatesWithAI };
