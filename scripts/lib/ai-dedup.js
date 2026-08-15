'use strict';

const { generateAux } = require('./aux-model');

const SYSTEM_PROMPT = `あなたは日本の税務ブログの編集者です。
候補トピックが既存記事と内容的に重複しているか判定してください。

## 最優先の判定軸: 論点（pain）が同じか
読者は「どの制度・どの論点の記事か」で読み分けます。persona や記事タイプは
書き手側の都合であって、読者から見れば同じ話が2回並ぶだけです。

- <strong>pain（論点）が同一なら、persona や記事タイプが違っても重複</strong>とする。
  例: pain:vending-machine-special の記事が既にあるとき、
      persona だけ変えた自販機特例の記事は重複。
- pain が明示されていない場合は、title と intent から実質的な論点を読み取って判断する。

## 非重複（duplicate: false にすべきケース）
論点そのものが違う場合です:
- 扱う制度・論点が異なる（例: 簡易課税の事業区分 と 高額特定資産の3年縛り）
- 同じ制度でも、読者が知りたい問いが別（例: 「対象になるか」と「申告書の書き方」）
- 業種特有の事情が本質的に違い、判断基準そのものが変わる

## 重複（duplicate: true にすべきケース）
- pain（論点）が同一
- または、扱う制度・中心疑問が実質的に同じで、読者が「同じ記事」と感じる

論点が同じかどうかで判断してください。persona 違いを非重複の根拠にしないこと。

応答は指定の JSON 配列のみ。説明文や前置きは不要。`;

function buildCorpusSummary(corpus) {
  const lines = [];
  for (const p of corpus) {
    if (!p.slug) continue;
    const parts = [p.slug];
    if (p.title) parts.push(p.title);
    const persona = p.primary_persona || p.persona;
    if (persona) parts.push(`persona:${persona}`);
    if (p.category) parts.push(p.category);
    // pain_point（論点）は重複判定の最重要シグナル。同じ論点なら persona が
    // 違っても読者から見れば同じ記事なので、LLM にも必ず見せる。
    if (p.pain_point) parts.push(`pain:${p.pain_point}`);
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

## 既存記事一覧（slug | title | persona | category）
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

    // ── 決定論的ガード: persona/type が異なれば LLM の判定をオーバーライド ──
    const pickBySlug = Object.create(null);
    for (const p of picks) if (p.slug) pickBySlug[p.slug] = p;
    const corpusBySlug = Object.create(null);
    for (const c of corpus) if (c.slug) corpusBySlug[c.slug] = c;

    for (const r of parsed) {
      if (!r.duplicate || !r.similar_to) continue;
      const cand = pickBySlug[r.slug];
      const existing = corpusBySlug[r.similar_to];
      if (!cand || !existing) continue;

      const candPersona = cand.persona || cand.primary_persona || '';
      const existPersona = existing.primary_persona || existing.persona || '';
      const candType = cand.article_type || '';
      const existType = existing.article_type || '';
      const candPain = cand.pain_point || '';
      const existPain = existing.pain_point || '';

      // 論点（pain_point）が同一なら、persona/type が違ってもオーバーライドしない。
      // 2026-08-15 の事故: 自販機特例(vending-machine-special)の記事が
      // persona 違い(influencer_creator vs domestic_ec_seller)を理由に
      // 非重複と判定され、前日とほぼ同内容の記事が生成された。
      // 読者から見れば「同じ話が2回」であり、書き分けの余地は persona だけでは作れない。
      if (candPain && existPain && candPain === existPain) {
        console.log(`[ai-dedup] ガード対象外: pain_point一致(${candPain}) → LLMの重複判定を維持: ${r.slug}`);
        continue;
      }

      if (candPersona && existPersona && candPersona !== existPersona) {
        console.log(`[ai-dedup] ガード: persona不一致(${candPersona} vs ${existPersona}) → 非重複にオーバーライド: ${r.slug}`);
        r.duplicate = false;
        r.reason = `[override] persona不一致: ${candPersona} ≠ ${existPersona}`;
      } else if (candType && existType && candType !== existType) {
        console.log(`[ai-dedup] ガード: type不一致(${candType} vs ${existType}) → 非重複にオーバーライド: ${r.slug}`);
        r.duplicate = false;
        r.reason = `[override] type不一致: ${candType} ≠ ${existType}`;
      }
    }

    return { results: parsed, skipped: false };
  } catch (e) {
    console.warn(`[ai-dedup] JSON parse失敗: ${e.message}`);
    return { results: [], skipped: true, parseError: true };
  }
}

// buildCorpusSummary はテスト用にも公開する（LLM に渡す情報の欠落は
// 重複見逃しに直結するため、内容を直接検証できるようにしておく）。
module.exports = { checkDuplicatesWithAI, buildCorpusSummary };
