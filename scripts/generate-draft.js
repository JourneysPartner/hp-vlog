'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const { TOPICS } = require('./topic-pool');

// ── モデル定義（OpenAI GPT-5.4） ───────────────────────────────
const MODEL_STANDARD = process.env.OPENAI_MODEL || 'gpt-5.4';
const MODEL_HIGH     = process.env.OPENAI_MODEL_HIGH || 'gpt-5.4';

// ── ペルソナ定義 ─────────────────────────────────────────────────
const PERSONAS = [
  { id: 'ebay_export_seller',          label: 'eBay輸出セラー',               categories: ['消費税', 'インボイス', '海外取引'] },
  { id: 'domestic_ec_seller',          label: '国内EC物販セラー',              categories: ['消費税', 'インボイス', '帳簿・経費'] },
  { id: 'reseller_marketplace_seller', label: 'フリマ・転売セラー',            categories: ['所得税', '帳簿・経費', 'インボイス'] },
  { id: 'influencer_creator',          label: 'インフルエンサー・クリエイター', categories: ['所得税', '帳簿・経費', 'インボイス'] },
  { id: 'beauty_salon_owner',          label: '美容サロンオーナー',            categories: ['消費税', '所得税', '帳簿・経費'] },
  { id: 'inheritance_client',          label: '相続・贈与の依頼者',            categories: ['相続'] },
];

const PERSONA_MAP = Object.fromEntries(PERSONAS.map(p => [p.id, p]));

// ── ペルソナ別 CTA ──────────────────────────────────────────────
const CTA_MAP = {
  ebay_export_seller:          '輸出取引に伴う消費税還付や記帳について、ご不明な点がございましたらお気軽にご相談ください。',
  domestic_ec_seller:          'EC物販の税務処理や消費税申告について、お困りのことがありましたらお気軽にお問い合わせください。',
  reseller_marketplace_seller: 'せどり・転売に関する確定申告や帳簿の付け方について、ご相談を承っております。',
  influencer_creator:          '広告収入やPR案件の税務処理について、お気軽にご相談ください。',
  beauty_salon_owner:          'サロン経営に関する税務・経理のご相談を承っております。開業時の届出から日々の記帳まで、お気軽にお問い合わせください。',
  inheritance_client:          '相続税・贈与税に関するご相談を承っております。個別のご事情に応じたアドバイスが可能ですので、まずはお気軽にお問い合わせください。',
};

// ── 記事タイプ別の構成指示 ──────────────────────────────────────
const ARTICLE_TYPE_INSTRUCTIONS = {
  basic_explainer: `この記事は「基本解説」タイプです。
- 制度の全体像を初心者にも分かるように体系的に説明してください
- 専門用語には初出時に簡潔な説明を添えてください
- 「そもそも○○とは」から始め、要件・計算方法・手続きの順に構成してください`,

  comparison_decision: `この記事は「比較・判断」タイプです。
- 2つ以上の選択肢（制度・方法）を比較し、それぞれのメリット・デメリットを整理してください
- 表形式やリストで比較ポイントを明示してください
- 「どちらを選ぶべきか」の判断基準を具体的な数値例と共に提示してください
- 読者が自分の状況に当てはめて判断できるよう、条件別の推奨を示してください`,

  edge_case: `この記事は「判断に迷うケース」タイプです。
- 実務上よくある「グレーゾーン」や「例外パターン」に焦点を当ててください
- 「原則はこうだが、○○の場合はこうなる」という構成にしてください
- 具体的な想定シナリオを2〜3パターン示してください
- 判断に迷った場合の対処法（専門家への相談推奨）も含めてください`,

  industry_example: `この記事は「業種別具体例」タイプです。
- この業種特有の税務上の論点に絞って解説してください
- 業界用語や実際の取引フローに即した具体例を多く含めてください
- 他の業種との違い（特にこの業種ならではの注意点）を強調してください`,

  filing_practice: `この記事は「申告実務」タイプです。
- 実際の申告書作成・届出手続きの流れに沿って解説してください
- 「いつまでに」「何を」「どこに」提出するかを時系列で整理してください
- 必要書類・準備物のチェックリストを含めてください
- よくある記入ミスや提出漏れの注意点を含めてください`,

  misconception_fix: `この記事は「よくある誤解」タイプです。
- 冒頭で「○○と思っていませんか？」と誤解を提示し、正しい理解を解説してください
- 誤解が生じる原因や背景を説明してください
- 誤解のまま対応した場合のリスクを具体的に示してください
- 正しい対応方法を段階的に説明してください`,

  case_study: `この記事は「ケーススタディ」タイプです。
- 具体的な想定事例をベースに解説してください（【想定事例】と明記）
- 数値を含む具体的なシナリオで計算過程を示してください
- 事例から得られる教訓・ポイントをまとめてください
- 読者が自分のケースに応用できるよう、条件の違いによる影響も説明してください`,
};

// ── 関連記事リンクテキスト（相手の記事タイプに応じた導線文言）────
const RELATED_LINK_TEXTS = {
  basic_explainer:     '基本から確認したい方はこちら',
  comparison_decision: '比較・判断のポイントはこちら',
  edge_case:           '判断に迷うケースについてはこちら',
  industry_example:    '業種別の具体例はこちら',
  filing_practice:     '申告実務の注意点はこちら',
  misconception_fix:   'よくある誤解と正しい理解はこちら',
  case_study:          '具体的な事例で確認するにはこちら',
};

// ── モデル選択ロジック ──────────────────────────────────────────
function resolveModel(topic) {
  const args = process.argv.slice(2);

  if (args.includes('--high-quality')) {
    return { model: MODEL_HIGH, reason: '--high-quality フラグ' };
  }

  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    return { model: args[modelIdx + 1], reason: `--model フラグ` };
  }

  if (process.env.OPENAI_MODEL) {
    return { model: process.env.OPENAI_MODEL, reason: '環境変数 OPENAI_MODEL' };
  }

  if (topic.quality === 'high') {
    return { model: MODEL_HIGH, reason: `テーマ quality=high（自動判定）` };
  }

  return { model: MODEL_STANDARD, reason: 'デフォルト' };
}

// ── 既存記事のスラグ一覧を取得 ──────────────────────────────────
function getExistingSlugs() {
  if (!fs.existsSync(POSTS_DIR)) return new Set();
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const slugs = new Set();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const m = raw.match(/^slug:\s*"?([^"\n\r]+)"?/m);
    if (m) slugs.add(m[1].trim());
  }
  return slugs;
}

// ── 直近の差し戻しコメントを収集 ────────────────────────────────
function getRecentRevisionComments(limit = 3) {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const comments = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const status  = (raw.match(/^review_status:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const comment = (raw.match(/^review_comment:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    if (status === 'needs_revision' && comment) {
      const updated = (raw.match(/^updated_at:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
      comments.push({ file, comment, updated });
    }
  }
  comments.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return comments.slice(0, limit);
}

// ── ペアグループから未使用ペアを選択 ────────────────────────────
function pickPair(dateStr) {
  const existing = getExistingSlugs();
  const available = TOPICS.filter(t => !existing.has(t.slug));

  // pair_group ごとにグルーピング（未使用テーマのみ）
  const groups = {};
  for (const t of available) {
    if (!t.pair_group) continue;
    if (!groups[t.pair_group]) groups[t.pair_group] = [];
    groups[t.pair_group].push(t);
  }

  // 2本揃っているペアグループを優先
  const fullPairs = Object.entries(groups).filter(([, topics]) => topics.length >= 2);

  if (fullPairs.length > 0) {
    const hash = [...dateStr].reduce((a, c) => a + c.charCodeAt(0), 0);
    const [, topics] = fullPairs[hash % fullPairs.length];
    // main（basic_explainer / comparison_decision）と support を分ける
    const mainTypes = new Set(['basic_explainer', 'comparison_decision']);
    const main = topics.find(t => mainTypes.has(t.article_type)) || topics[0];
    const support = topics.find(t => t !== main) || topics[1];
    return [main, support];
  }

  // 2本揃うペアがない場合: 残りの未使用テーマから1本ずつ（ペアなし）
  if (available.length >= 2) {
    const hash = [...dateStr].reduce((a, c) => a + c.charCodeAt(0), 0);
    const first = available[hash % available.length];
    const rest = available.filter(t => t !== first);
    const second = rest[(hash + 1) % rest.length];
    return [first, second];
  }

  if (available.length === 1) {
    return [available[0]];
  }

  // 全テーマ使い切り → ランダム再選択
  console.warn('[generate] テーマプールを全て使い切りました。ランダムに再選択します。');
  const hash = [...dateStr].reduce((a, c) => a + c.charCodeAt(0), 0);
  const first = TOPICS[hash % TOPICS.length];
  const second = TOPICS[(hash + 1) % TOPICS.length];
  return [first, second];
}

// ── JST の今日の日付文字列 (YYYY-MM-DD) ─────────────────────────
function getTodayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ── テンプレートベース生成（APIキー未設定時フォールバック）────────
function generateFromTemplate(dateStr, topic, pairedTopic) {
  const now     = new Date().toISOString();
  const persona = PERSONA_MAP[topic.persona];
  const cta     = CTA_MAP[topic.persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const articleType = topic.article_type || 'basic_explainer';
  const mainTypes = new Set(['basic_explainer', 'comparison_decision']);
  const articleRole = mainTypes.has(articleType) ? 'main' : 'support';

  const sourceBlock = topic.source_url
    ? `source_url: "${topic.source_url}"\nsource_title: "${topic.source_title}"`
    : `source_url: ""\nsource_title: ""`;

  const relatedSlug      = pairedTopic ? pairedTopic.slug : '';
  const relatedTitle     = pairedTopic ? pairedTopic.title : '';
  const relatedLinkText  = pairedTopic ? (RELATED_LINK_TEXTS[pairedTopic.article_type] || 'あわせて読みたい') : '';

  return `---
title: "${topic.title}"
slug: "${topic.slug}"
category: "${topic.category}"
primary_persona: "${topic.persona}"
secondary_persona: ""
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${relatedSlug}"
related_title: "${relatedTitle}"
related_link_text: "${relatedLinkText}"
${sourceBlock}
summary: "${persona.label}向けに、${topic.category}の基本と実務上の注意点を解説します。"
review_status: "draft"
review_comment: "テンプレートから自動生成された下書きです。内容の加筆・修正が必要です。"
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "${now}"
updated_at: "${now}"
---

## はじめに

${persona.label}の方にとって、${topic.category}は事業運営に直結する重要なテーマです。本記事では、${topic.hint}について、基本的な考え方と実務上のポイントを整理します。

なお、個別の事情によって取り扱いが異なる場合がありますので、具体的な判断は税理士等の専門家にご確認ください。

## ${topic.category}の基本的な考え方

${topic.hint}について、まず押さえておきたい基本事項を解説します。

<!-- TODO: 国税庁等の公的情報を根拠に、具体的な制度説明を加筆してください -->

## 実務上の注意点

${persona.label}が${topic.category}に対応する際、特に注意したいポイントを整理します。

- 届出や申告の期限を確認し、余裕を持って準備を進めること
- 帳簿や証拠書類を日頃から整理しておくこと
- 判断に迷う場合は、早めに専門家に相談すること

<!-- TODO: テーマに即した具体的な注意点に差し替えてください -->

## まとめ

本記事では、${persona.label}向けに${topic.category}の基本と実務上の注意点を解説しました。制度の詳細や個別の事情への対応については、税理士等の専門家への相談をおすすめします。

${cta}

毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。

---

本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。
`;
}

// ── 標準免責事項ブロック ─────────────────────────────────────────
const DISCLAIMER_BLOCK = `\n\n---\n\n本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります（免責事項）。\n`;

function ensureDisclaimer(content) {
  const m = content.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n([\s\S]*)$/);
  const body = m ? m[1] : content;
  const hasDisclaimer =
    /本記事は.{0,30}情報提供/.test(body) ||
    /免責/.test(body) ||
    /個別事情/.test(body);
  if (hasDisclaimer) return content;
  console.warn('[generate] 免責事項が検出できなかったため自動補完します');
  return content.replace(/\s*$/, '') + DISCLAIMER_BLOCK;
}

const BANNED_REPLACEMENTS = [
  [/必ず節税/g,    '節税につながる場合があります'],
  [/絶対安心/g,    '安心につながります'],
  [/確実に節税/g,  '節税につながる場合があります'],
  [/100%節税/g,    '節税につながる場合があります'],
  [/受賞歴/g,      '実績'],
  [/最優秀/g,      '高い評価'],
  [/No\.1税理士/g, '税理士'],
];
function sanitizeBannedPhrases(content) {
  let out = content;
  for (const [re, rep] of BANNED_REPLACEMENTS) {
    if (re.test(out)) {
      console.warn(`[generate] 禁止表現を置換: ${re}`);
      out = out.replace(re, rep);
    }
  }
  return out;
}

function postProcess(content) {
  return ensureDisclaimer(sanitizeBannedPhrases(content));
}

// ── OpenAI クライアント生成 ─────────────────────────────────────
function createOpenAIClient() {
  const _sdk = require('openai');
  const OpenAI = _sdk.default || _sdk.OpenAI || _sdk;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function extractText(completion) {
  const choice = completion && completion.choices && completion.choices[0];
  if (!choice) return '';
  if (choice.message && typeof choice.message.content === 'string') {
    return choice.message.content;
  }
  if (choice.message && Array.isArray(choice.message.content)) {
    return choice.message.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
  }
  return '';
}

// ── OpenAI API を使った生成 ──────────────────────────────────────
async function generateWithOpenAI(dateStr, topic, modelId, pairedTopic) {
  const client  = createOpenAIClient();
  const now     = new Date().toISOString();
  const persona = PERSONA_MAP[topic.persona];
  const cta     = CTA_MAP[topic.persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const articleType = topic.article_type || 'basic_explainer';
  const mainTypes = new Set(['basic_explainer', 'comparison_decision']);
  const articleRole = mainTypes.has(articleType) ? 'main' : 'support';

  const sourceInstruction = topic.source_url
    ? `- 出典として「${topic.source_title}」（${topic.source_url}）を参照すること`
    : '- このテーマは公的URLが未指定です。source_url / source_title は空文字のまま出力してください。本文中で根拠を示す場合は「国税庁によると」等の一般的な表現に留めてください';

  const typeInstruction = ARTICLE_TYPE_INSTRUCTIONS[articleType] || '';

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログライターです。
${persona.label}が実務で直面する税務上の疑問に答える記事を書いてください。

${typeInstruction}

文体・トーン:
- 税理士事務所として穏当で信頼感のある文体にすること
- 「です・ます」調で統一すること
- 読者（${persona.label}）に直接語りかける視点で書くこと
- 他のペルソナ（他業種）の話題には触れず、このペルソナに集中すること

禁止事項:
- 誇大表現（「必ず節税」「絶対安心」「確実に節税」「100%節税」等）は使用禁止
- 「受賞歴」「最優秀」「No.1税理士」等の自称・権威付けは禁止
- 断定を避け、「〜の場合があります」「〜が一般的です」等の穏当な表現を使うこと
- 事実（法令・通達）と解釈（実務上の判断）を混同しないこと

構成ルール:
- h2見出し（## ）を最低3つ使い、読みやすく区切ること
- 想定事例を含める場合は「【想定事例】」と見出しまたは冒頭に明記すること
- 個別事情で結論が変わりうる場合は、その旨を自然に記載すること
${sourceInstruction}
- 本文中に他の記事への直接リンクは挿入しないこと（関連記事の導線はサイト側で自動生成します）
- 記事末尾に必ず以下の免責事項ブロックを含めること（文言は変更しない）:
  「本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。」
- 免責事項の後に、以下の相談導線を自然に入れること:
  「${cta}」
  「毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。」

記事のヒント: ${topic.hint}`;

  const revisions = getRecentRevisionComments(3);
  let revisionHint = '';
  if (revisions.length > 0) {
    const items = revisions.map(r => `- ${r.comment}`).join('\n');
    revisionHint = `\n\n過去の記事で以下のレビュー指摘がありました。同様の問題を避けてください:\n${items}`;
  }

  const sourceUrl      = topic.source_url || '';
  const sourceTitle    = topic.source_title || '';
  const relatedSlug    = pairedTopic ? pairedTopic.slug : '';
  const relatedTitle   = pairedTopic ? pairedTopic.title : '';
  const relatedLinkText = pairedTopic ? (RELATED_LINK_TEXTS[pairedTopic.article_type] || 'あわせて読みたい') : '';

  const userPrompt = `以下の条件でブログ記事の下書きを1本作成してください。

テーマ: ${topic.title}
ターゲット読者: ${persona.label}
カテゴリ: ${topic.category}
記事タイプ: ${articleType}
記事の役割: ${articleRole === 'main' ? '本命記事' : '補強記事'}${revisionHint}

以下の形式でそのまま出力してください（コードブロック不要）:

---
title: "${topic.title}"
slug: "${topic.slug}"
category: "${topic.category}"
primary_persona: "${topic.persona}"
secondary_persona: ""
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${relatedSlug}"
related_title: "${relatedTitle}"
related_link_text: "${relatedLinkText}"
source_url: "${sourceUrl}"
source_title: "${sourceTitle}"
summary: "（記事の内容が分かる自然な文章。120文字以内。検索結果に表示されるmeta descriptionとして使用）"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "${now}"
updated_at: "${now}"
---

（Markdown本文 1000〜1500文字）`;

  const completion = await client.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });

  const raw = extractText(completion);
  const fenced = raw.match(/^```(?:markdown|yaml|md)?\n([\s\S]+)\n```\s*$/m);
  return postProcess((fenced ? fenced[1] : raw).trim());
}

// ── 既存記事の frontmatter をパースする ─────────────────────────
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2];
  }
  return { meta, body: match[2] };
}

// ── 差し戻し対応の再生成 (OpenAI API) ──────────────────────────────
async function regenerateWithOpenAI(existingContent, comment, modelId) {
  const client = createOpenAIClient();

  const { meta, body: existingBody } = parseFrontmatter(existingContent);
  const persona = PERSONA_MAP[meta.primary_persona] || { label: meta.primary_persona || '' };
  const cta     = CTA_MAP[meta.primary_persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const now     = new Date().toISOString();
  const articleType = meta.article_type || 'basic_explainer';
  const articleRole = meta.article_role || 'main';

  const sourceInstruction = meta.source_url
    ? `- 出典として「${meta.source_title || ''}」（${meta.source_url}）を参照すること`
    : '- source_url / source_title は空文字のまま出力してください';

  const typeInstruction = ARTICLE_TYPE_INSTRUCTIONS[articleType] || '';

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログライターです。
${persona.label}が実務で直面する税務上の疑問に答える記事を書いてください。

${typeInstruction}

文体・トーン:
- 税理士事務所として穏当で信頼感のある文体にすること
- 「です・ます」調で統一すること
- 読者（${persona.label}）に直接語りかける視点で書くこと

禁止事項:
- 誇大表現は使用禁止
- 断定を避け、穏当な表現を使うこと

構成ルール:
- h2見出し（## ）を最低3つ使い、読みやすく区切ること
${sourceInstruction}
- 本文中に他の記事への直接リンクは挿入しないこと（関連記事の導線はサイト側で自動生成します）
- 記事末尾に必ず以下の免責事項ブロックを含めること（文言は変更しない）:
  「本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。」
- 免責事項の後に、以下の相談導線を自然に入れること:
  「${cta}」
  「毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。」`;

  const userPrompt = `以下のブログ記事に対して、レビュー担当者から差し戻しがありました。
コメントの内容を踏まえて、記事を改善してください。

【差し戻しコメント】
${comment}

【現在の記事】
${existingBody.substring(0, 3000)}

【記事情報】
タイトル: ${meta.title || ''}
ターゲット読者: ${persona.label}
カテゴリ: ${meta.category || ''}
記事タイプ: ${articleType}
記事の役割: ${articleRole === 'main' ? '本命記事' : '補強記事'}

改善した記事を、以下の形式でそのまま出力してください（コードブロック不要）:

---
title: "${meta.title || ''}"
slug: "${meta.slug || ''}"
category: "${meta.category || ''}"
primary_persona: "${meta.primary_persona || ''}"
secondary_persona: "${meta.secondary_persona || ''}"
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${meta.related_slug || ''}"
related_title: "${meta.related_title || ''}"
related_link_text: "${meta.related_link_text || ''}"
source_url: "${meta.source_url || ''}"
source_title: "${meta.source_title || ''}"
summary: "（改善した内容に合わせた要約。120文字以内）"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: "${meta.pr_number || ''}"
preview_url: "${meta.preview_url || ''}"
created_at: "${meta.created_at || now}"
updated_at: "${now}"
---

（改善した Markdown 本文 1000〜1500文字）`;

  const completion = await client.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });

  const raw = extractText(completion);
  const fenced = raw.match(/^```(?:markdown|yaml|md)?\n([\s\S]+)\n```\s*$/m);
  return postProcess((fenced ? fenced[1] : raw).trim());
}

// ── CLI 引数ヘルパー ────────────────────────────────────────────────
function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// ── エントリポイント ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // ── 再生成モード ──────────────────────────────────────────────
  if (args.includes('--regenerate')) {
    const filename = getArg('--filename');
    const comment  = getArg('--comment');
    if (!filename || !comment) {
      console.error('[regenerate] --filename と --comment は必須です');
      process.exit(1);
    }

    const filepath = path.join(POSTS_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.error(`[regenerate] ファイルが見つかりません: ${filepath}`);
      process.exit(1);
    }

    const existing = fs.readFileSync(filepath, 'utf8');
    console.log(`[regenerate] 対象: content/posts/${filename}`);
    console.log(`[regenerate] コメント: ${comment}`);

    if (!process.env.OPENAI_API_KEY) {
      console.error('[regenerate] OPENAI_API_KEY が必要です');
      process.exit(1);
    }

    const modelId = MODEL_STANDARD;
    console.log(`[regenerate] OpenAI API で再生成します（${modelId}）...`);
    const content = await regenerateWithOpenAI(existing, comment, modelId);

    fs.writeFileSync(filepath, content + '\n', 'utf8');
    console.log(`[regenerate] 再生成完了: content/posts/${filename}`);
    return;
  }

  // ── 通常の新規生成モード（2本ペア生成）────────────────────────
  const dateStr = getTodayJST();
  const pair = pickPair(dateStr);

  console.log(`[generate] 日付: ${dateStr}`);
  console.log(`[generate] 生成本数: ${pair.length}`);

  const results = [];

  for (let i = 0; i < pair.length; i++) {
    const topic = pair[i];
    const pairedTopic = pair.length === 2 ? pair[1 - i] : null;
    const persona = PERSONA_MAP[topic.persona];
    const { model, reason } = resolveModel(topic);

    console.log(`[generate] ── 記事 ${i + 1}/${pair.length} ──`);
    console.log(`[generate] テーマ: ${topic.title}`);
    console.log(`[generate] ペルソナ: ${topic.persona} / カテゴリ: ${topic.category}`);
    console.log(`[generate] タイプ: ${topic.article_type || 'basic_explainer'} / ペアグループ: ${topic.pair_group || 'なし'}`);
    console.log(`[generate] テーマ品質: ${topic.quality || 'standard'}`);
    console.log(`[generate] 使用モデル: ${model}（${reason}）`);
    if (pairedTopic) {
      console.log(`[generate] ペア記事: ${pairedTopic.title}`);
    }

    const revisionComments = getRecentRevisionComments(3);
    if (i === 0 && revisionComments.length > 0) {
      console.log(`[generate] 差し戻しコメント ${revisionComments.length} 件を改善ヒントとして使用`);
    }

    let content;

    if (process.env.OPENAI_API_KEY) {
      console.log(`[generate] OpenAI API で生成します（${model}）...`);
      try {
        content = await generateWithOpenAI(dateStr, topic, model, pairedTopic);
      } catch (err) {
        console.warn(`[generate] OpenAI API 失敗: ${err.message} → テンプレートにフォールバック`);
        content = generateFromTemplate(dateStr, topic, pairedTopic);
      }
    } else {
      console.log('[generate] OPENAI_API_KEY 未設定 → テンプレートで生成します');
      content = generateFromTemplate(dateStr, topic, pairedTopic);
    }

    const filename = `${dateStr}-${topic.slug}.md`;
    const filepath = path.join(POSTS_DIR, filename);

    fs.mkdirSync(POSTS_DIR, { recursive: true });
    fs.writeFileSync(filepath, content + '\n', 'utf8');
    console.log(`[generate] 生成完了: content/posts/${filename}`);

    results.push({ filename, slug: topic.slug, model });
  }

  // GitHub Actions 出力変数（2本分）
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    fs.appendFileSync(ghOutput, `date=${dateStr}\n`);
    fs.appendFileSync(ghOutput, `count=${results.length}\n`);

    // 1本目
    fs.appendFileSync(ghOutput, `filename1=${results[0].filename}\n`);
    fs.appendFileSync(ghOutput, `slug1=${results[0].slug}\n`);
    fs.appendFileSync(ghOutput, `model1=${results[0].model}\n`);

    // 2本目（ある場合）
    if (results.length >= 2) {
      fs.appendFileSync(ghOutput, `filename2=${results[1].filename}\n`);
      fs.appendFileSync(ghOutput, `slug2=${results[1].slug}\n`);
      fs.appendFileSync(ghOutput, `model2=${results[1].model}\n`);
    }

    // カンマ区切りリスト（通知・コミット用）
    fs.appendFileSync(ghOutput, `filenames=${results.map(r => r.filename).join(',')}\n`);
    fs.appendFileSync(ghOutput, `slugs=${results.map(r => r.slug).join(',')}\n`);
  }
}

main().catch(err => {
  console.error('[generate] エラー:', err.message);
  process.exit(1);
});
