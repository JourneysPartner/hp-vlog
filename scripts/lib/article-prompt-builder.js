'use strict';

/**
 * 記事生成プロンプトビルダー（provider 非依存）
 *
 * 固定ルール（article-prompt-static.STATIC_RULES）と可変部分を分離し、
 * provider に応じたメッセージ構造を返す。
 *
 * - OpenAI:    { system: string, user: string }（従来どおり）
 * - Anthropic: { system: [{type:'text', text, cache_control}], messages: [...] }
 *              固定ルールに cache_control: { type: 'ephemeral' } を付け、
 *              Claude Sonnet 4.6 の prompt caching を効かせられる構造にする。
 *
 * 可変部分（毎回変わる）:
 *   topic / title / category / persona / article_type / article_role /
 *   source / 企画メタ / 関連記事 / 差し戻しコメント / 部分修正対象
 */

const {
  STATIC_RULES, ARTICLE_TYPE_CHECKLIST, WORD_COUNT_GUIDE, DISCLAIMER_TEXT,
  selectConditionalRules,
} = require('./article-prompt-static');
const bannedPhrasesLib = require('./banned-phrases');

// ── 可変部分の組み立て（生成時）────────────────────────────────
function buildDynamicGenerationBlock({ topic, persona, cta, articleType, articleRole,
                                        ntaRefsBlock, lawChangesBlock, revisionHint,
                                        pairedTopic, pairedArticleType, pairedArticleRole,
                                        conditionalRules = [] }) {
  const wordCount = WORD_COUNT_GUIDE[articleType] || '1000〜1500文字';
  const roleLabel = articleRole === 'main' ? '本命記事' : '補強記事';
  const checklist = ARTICLE_TYPE_CHECKLIST[articleType] || [];
  const macro = topic.macro || '';

  // 論点別ルール（この記事に該当するものだけ）。全記事共通ではなく、
  // eBay手数料・特定期間判定・インボイス経過措置 等を該当記事にだけ注入する。
  const conditionalBlock = (conditionalRules && conditionalRules.length)
    ? `\n\n═══ この記事に必ず適用する論点別ルール（正確性・最優先）═══\n${conditionalRules.join('\n\n')}`
    : '';

  const sourceInstruction = topic.source_url
    ? `出典として「${topic.source_title || ''}」（${topic.source_url}）を参照すること`
    : 'source_url / source_title は空文字のまま出力（本文では「国税庁によると」等の一般表現に留める）';

  // 参考タイトル: curated トピックには人間が書いた title が、
  // 拡張シナリオでは空文字が入る。LLM はこれを「ヒント」として扱い、
  // 自分自身でこの記事に最も適切なタイトルを生成する（Pattern C）。
  const titleHintLine = topic.title
    ? `参考タイトル（任意のヒント。改善余地があると判断したら変更可）: ${topic.title}`
    : 'タイトル: 下記の企画メタ情報からあなた自身で最適な日本語タイトルを生成してください。';

  // ── ペア記事ブロック ──────────────────────────────────────
  // 同じ pair_group の本命+補強で「タイトルの主題部が同一」になり、
  // ブログ一覧で重複に見える問題への対策。
  // ペアの相手記事の情報を渡し、主題部を被らせず、別角度から書くよう明示。
  let pairBlock = '';
  if (pairedTopic) {
    const pairedRoleLabel = pairedArticleRole === 'main' ? '本命記事' : '補強記事';
    const pairedTitleHint = pairedTopic.title
      ? `ペア記事の想定タイトル: ${pairedTopic.title}`
      : 'ペア記事のタイトルはまだ未生成（同じ場で並行生成）';
    pairBlock = `

═══ 【最重要】ペア記事との差別化（同じ pair_group の相方）═══
${pairedTitleHint}
ペア記事の役割: ${pairedRoleLabel}（記事タイプ: ${pairedArticleType || pairedTopic.article_type || ''}）
ペア記事の中心疑問: ${pairedTopic.primary_question || '（同じテーマを別角度で）'}

【絶対に守る】
1. **あなたのタイトルの主題部（最初の問い、｜より前）は、ペア記事と完全に被らせないこと**。
   悪い例:
     - あなた: 「うちは相続税がかかる？生前に確認したい判断ライン｜基本を整理」
     - ペア:   「うちは相続税がかかる？生前に確認したい判断ライン｜必要書類と注意点」
   ↑ これは読者から見ると「同じ記事が2つ並んでる」状態。禁止。
2. **副題（｜以降）だけで違いを表現してはいけない**。主題部自体を別角度の問いに変える。
3. あなたの役割（${roleLabel}）とペアの役割（${pairedRoleLabel}）の違いを、
   主題部の問い方そのもので表現する。例:
     - 本命（basic_explainer）: 「相続税はどこから課税される？基本のしくみと判断軸」
     - 補強（filing_practice）:  「生前の財産棚卸し、何を集めて何を残す？実務チェックリスト」
   ↑ 主題部の問いが完全に違う。これが読者にとって価値ある「2記事セット」。
4. ペア記事の参考タイトル（あれば上記）の表現とは別の動詞・別の名詞を選ぶ。`;
  }

  return `═══ この記事の可変条件 ═══
大分類: ${macro}
${titleHintLine}
ターゲット読者: ${persona.label}
カテゴリ: ${topic.category || ''}
記事タイプ: ${articleType}（${roleLabel}）
記事の役割: ${articleRole === 'main'
    ? '本命記事。テーマの入口・全体像・原則を網羅的に。例外/応用は補強記事に委ねる。'
    : '補強記事。原則の説明は最小限（3行以内）。例外・応用・具体例の深掘りに集中。'}

═══ 企画メタ情報（この記事の設計意図 — タイトル生成にも活用すること）═══
検索意図: ${topic.search_intent || '（パーソナと痛点から推測）'}
読者の課題: ${topic.reader_problem || '（パーソナと痛点から推測）'}
読み終えたあとの状態: ${topic.success_outcome || '（パーソナと痛点から推測）'}
中心疑問: ${topic.primary_question || '（パーソナと痛点から推測）'}
${pairBlock}

═══ このタイプの必須要素チェックリスト ═══
${checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}

═══ 出典 ═══
${sourceInstruction}${ntaRefsBlock || ''}${lawChangesBlock || ''}${conditionalBlock}
${bannedPhrasesLib.formatForPrompt()}${bannedPhrasesLib.formatTitleBannedForPrompt()}
═══ 末尾の相談導線（免責の後に自然に）═══
「${cta}」
「毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。」
${revisionHint || ''}
目安文字数: ${wordCount}`;
}

// ── 出力フォーマット指定（frontmatter テンプレ）────────────────
// title はあなた（LLM）が記事内容に最も適したタイトルを生成する（Pattern C）。
// 30〜70 文字、検索者が自然に検索する具体的な表現、`｜サブテキスト` 形式可、
// 曖昧表現禁止、「〜の徹底解説」など中身がない煽り禁止。
function buildFrontmatterTemplate({ topic, articleType, articleRole, relatedSlug,
                                     relatedTitle, relatedLinkText, now }) {
  return `---
title: "（あなたがこの記事に最も適したタイトルをここに記入。30〜70文字、検索者が自然に検索する具体的な表現、\`｜サブテキスト\`形式可、曖昧表現禁止）"
slug: "${topic.slug}"
category: "${topic.category || ''}"
primary_persona: "${topic.persona}"
secondary_persona: ""
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${relatedSlug || ''}"
related_title: "${relatedTitle || ''}"
related_link_text: "${relatedLinkText || ''}"
source_url: "${topic.source_url || ''}"
source_title: "${topic.source_title || ''}"
search_intent: "${topic.search_intent || ''}"
reader_problem: "${topic.reader_problem || ''}"
success_outcome: "${topic.success_outcome || ''}"
primary_question: "${topic.primary_question || ''}"
macro: "${topic.macro || ''}"
cluster: "${topic.cluster || ''}"
subcluster: "${topic.subcluster || ''}"
tax_domain: "${topic.tax_domain || ''}"
business_stage: "${topic.business_stage || ''}"
life_stage: "${topic.life_stage || ''}"
pain_point: "${topic.pain_point || ''}"
procedure_stage: "${topic.procedure_stage || ''}"
summary: "（記事の結論や具体的情報を含む自然な文章。120文字以内。曖昧表現禁止）"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "${now}"
updated_at: "${now}"
---`;
}

/**
 * 生成プロンプトを provider 非依存の中間表現で返す。
 * @returns {Object} { staticSystem, dynamicSystem, user }
 */
function buildGenerationPrompt(args) {
  const { topic, persona, cta, articleType, articleRole, ntaRefsBlock, lawChangesBlock,
          revisionHint, relatedSlug, relatedTitle, relatedLinkText, now,
          pairedTopic, pairedArticleType, pairedArticleRole } = args;

  const staticSystem = STATIC_RULES;  // ← キャッシュ対象（固定）
  const conditionalRules = selectConditionalRules(topic);  // 該当する論点別ルールだけ
  const dynamicSystem = buildDynamicGenerationBlock({
    topic, persona, cta, articleType, articleRole, ntaRefsBlock, lawChangesBlock, revisionHint,
    pairedTopic, pairedArticleType, pairedArticleRole, conditionalRules,
  });
  const frontmatter = buildFrontmatterTemplate({
    topic, articleType, articleRole, relatedSlug, relatedTitle, relatedLinkText, now,
  });
  const user = `以下の条件でブログ記事の下書きを1本作成してください。
記事を書く前に、検索意図に直接答えているか・必須要素を満たすか・表で整理すべき情報がないかを内部で点検してください。

【タイトル生成に関する重要指示】
- title は frontmatter の placeholder ではなく、あなたが書いた本文の内容を最も的確に伝える日本語タイトルを生成して入れること
- 検索者が実際に検索しそうな具体的な疑問形・名詞句で（例: 「〜はどうなる？」「〜の判断基準｜サブテキスト」）
- 30〜70 文字を目安。70 文字を超えない
- 「徹底解説」「完全ガイド」「必読」などの中身のない煽り表現は禁止
- 本文を書き上げた後、その内容を踏まえてタイトルを最適化すること

以下の形式でそのまま出力（コードブロック不要）:

${frontmatter}

（Markdown本文 ${WORD_COUNT_GUIDE[articleType] || '1000〜1500文字'}）`;

  return { staticSystem, dynamicSystem, user };
}

// ── provider 別メッセージ変換 ──────────────────────────────────
/**
 * OpenAI Chat Completions 形式に変換。
 * 固定ルールと可変指示を 1 つの system にまとめる（OpenAI は明示キャッシュAPIが別途のため統合）。
 */
function toOpenAIMessages({ staticSystem, dynamicSystem, user }) {
  return [
    { role: 'system', content: `${staticSystem}\n\n${dynamicSystem}` },
    { role: 'user',   content: user },
  ];
}

/**
 * Anthropic Messages 形式に変換。
 * 固定ルールに cache_control を付け、prompt caching の対象にする。
 * system は配列（複数ブロック）で渡す:
 *   [ { type:'text', text: STATIC_RULES, cache_control:{type:'ephemeral'} },
 *     { type:'text', text: dynamicSystem } ]
 */
function toAnthropicRequest({ staticSystem, dynamicSystem, user }, { model, maxTokens, useCache }) {
  const systemBlocks = [
    useCache
      ? { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: staticSystem },
    { type: 'text', text: dynamicSystem },
  ];
  return {
    model,
    max_tokens: maxTokens || 4096,
    system: systemBlocks,
    messages: [{ role: 'user', content: user }],
  };
}

module.exports = {
  buildGenerationPrompt,
  buildDynamicGenerationBlock,
  buildFrontmatterTemplate,
  toOpenAIMessages,
  toAnthropicRequest,
  STATIC_RULES,
};
