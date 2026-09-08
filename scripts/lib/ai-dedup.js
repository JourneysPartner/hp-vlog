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

// ── 決定論的ガード: persona/type が異なれば LLM の判定をオーバーライド ──
// 選定時（checkDuplicatesWithAI）と生成後（checkGeneratedDuplicateWithAI）で共用する。
function applyDeterministicGuard(parsed, picks, corpus) {
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

    applyDeterministicGuard(parsed, picks, corpus);

    return { results: parsed, skipped: false };
  } catch (e) {
    console.warn(`[ai-dedup] JSON parse失敗: ${e.message}`);
    return { results: [], skipped: true, parseError: true };
  }
}

// ── 生成後の重複判定（2026-09-08）────────────────────────────
//
// 選定時の判定は企画メタ（intent / question）しか見られない。企画は狭く見えても、
// 生成された記事が広がって既存記事と同じになることがある（9/8 の本命記事は
// 「逝去直後の初動」の企画から「10か月の全体像」まで書き、4/18・8/22 と重複した）。
// 生成物のタイトル・要約・見出しで、もう一度既存記事と照合する。
function buildGeneratedArticleBlock(article) {
  const lines = ['### 生成済み記事'];
  lines.push(`slug: ${article.slug}`);
  if (article.title) lines.push(`title: ${article.title}`);
  if (article.summary) lines.push(`summary: ${article.summary}`);
  if (Array.isArray(article.headings) && article.headings.length) {
    lines.push('headings:');
    for (const h of article.headings.slice(0, 20)) lines.push(`  - ${h}`);
  }
  if (article.persona) lines.push(`persona: ${article.persona}`);
  if (article.category) lines.push(`category: ${article.category}`);
  if (article.pain_point) lines.push(`pain: ${article.pain_point}`);
  if (article.article_type) lines.push(`type: ${article.article_type}`);
  return lines.join('\n');
}

/**
 * 生成済み記事 1 本を既存コーパスと照合し、Haiku で意味的重複を判定する。
 * aux 未有効・API エラー時は skipped: true（記事はそのまま通す）。
 *
 * @param {Object} article  { slug, title, summary, headings[], persona, category, pain_point, article_type }
 * @param {Array}  corpus   既存記事 + 未マージ下書き（同じ実行で生成した記事は呼び出し側で除く）
 * @returns {{ duplicate: boolean, similar_to: string|null, reason: string, skipped: boolean }}
 */
async function checkGeneratedDuplicateWithAI(article, corpus) {
  if (!article || !article.slug) return { duplicate: false, similar_to: null, reason: '', skipped: true };
  const userPrompt = `## 判定対象
以下は生成が終わった記事です。企画ではなく、実際に書かれた内容（タイトル・要約・見出し）で判定してください。

${buildGeneratedArticleBlock(article)}

## 既存記事一覧（slug | title | persona | category）
${buildCorpusSummary(corpus)}

## 応答形式
JSON配列で返してください:
[{"slug":"生成済み記事のslug","duplicate":true,"similar_to":"重複先のslug","reason":"判定理由（1文）"}]
duplicateがfalseの場合、similar_toはnullにしてください。`;

  const raw = await generateAux({ system: SYSTEM_PROMPT, user: userPrompt, task: 'ai_dedup', maxTokens: 300 });
  if (!raw) return { duplicate: false, similar_to: null, reason: '', skipped: true };
  try {
    const jsonMatch = raw.match(/[[][\s\S]*[\]]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!Array.isArray(parsed) || parsed.length === 0) return { duplicate: false, similar_to: null, reason: '', skipped: true, parseError: true };
    applyDeterministicGuard(parsed, [article], corpus);
    const r = parsed.find(x => x.slug === article.slug) || parsed[0];
    return { duplicate: !!r.duplicate, similar_to: r.similar_to || null, reason: r.reason || '', skipped: false };
  } catch (e) {
    console.warn(`[ai-dedup] 生成後判定の JSON parse 失敗: ${e.message}`);
    return { duplicate: false, similar_to: null, reason: '', skipped: true, parseError: true };
  }
}

// buildCorpusSummary はテスト用にも公開する（LLM に渡す情報の欠落は
// 重複見逃しに直結するため、内容を直接検証できるようにしておく）。
module.exports = { checkDuplicatesWithAI, checkGeneratedDuplicateWithAI, buildCorpusSummary, buildGeneratedArticleBlock, applyDeterministicGuard };
