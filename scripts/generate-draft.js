'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const { TOPICS } = require('./topic-pool');

// ── モデル定義 ───────────────────────────────────────────────────
const MODEL_STANDARD = 'claude-sonnet-4-6';
const MODEL_HIGH     = 'claude-opus-4-6';

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

// ── モデル選択ロジック ──────────────────────────────────────────
//
// 優先順位:
//   1. --high-quality フラグ → Opus 4.6
//   2. --model <model-id> フラグ → 指定モデル
//   3. 環境変数 ANTHROPIC_MODEL → 指定モデル
//   4. topic.quality === 'high' → Opus 4.6（自動判定）
//   5. デフォルト → Sonnet 4.6
//
function resolveModel(topic) {
  const args = process.argv.slice(2);

  // 1. --high-quality フラグ
  if (args.includes('--high-quality')) {
    return { model: MODEL_HIGH, reason: '--high-quality フラグ' };
  }

  // 2. --model <model-id> フラグ
  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    return { model: args[modelIdx + 1], reason: `--model フラグ` };
  }

  // 3. 環境変数 ANTHROPIC_MODEL
  if (process.env.ANTHROPIC_MODEL) {
    return { model: process.env.ANTHROPIC_MODEL, reason: '環境変数 ANTHROPIC_MODEL' };
  }

  // 4. テーマの quality フィールド
  if (topic.quality === 'high') {
    return { model: MODEL_HIGH, reason: `テーマ quality=high（自動判定）` };
  }

  // 5. デフォルト
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
// review_status が needs_revision かつ review_comment が非空の記事から
// 直近3件までのコメントを取得し、改善ヒントとして返す
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
  // 更新日の降順でソートし、直近 limit 件を返す
  comments.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return comments.slice(0, limit);
}

// ── テーマプールから未使用テーマを選択 ──────────────────────────
function pickTopic(dateStr) {
  const existing = getExistingSlugs();
  const available = TOPICS.filter(t => !existing.has(t.slug));

  if (available.length === 0) {
    console.warn('[generate] テーマプールを全て使い切りました。ランダムに再選択します。');
    const hash = [...dateStr].reduce((a, c) => a + c.charCodeAt(0), 0);
    return TOPICS[hash % TOPICS.length];
  }

  // 日付から決定的に選択（同じ日付なら同じテーマ）
  const hash = [...dateStr].reduce((a, c) => a + c.charCodeAt(0), 0);
  return available[hash % available.length];
}

// ── JST の今日の日付文字列 (YYYY-MM-DD) ─────────────────────────
function getTodayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ── テンプレートベース生成（APIキー未設定時フォールバック）────────
function generateFromTemplate(dateStr, topic) {
  const now     = new Date().toISOString();
  const persona = PERSONA_MAP[topic.persona];
  const cta     = CTA_MAP[topic.persona] || 'ご不明な点がございましたらお気軽にご相談ください。';

  const sourceBlock = topic.source_url
    ? `source_url: "${topic.source_url}"\nsource_title: "${topic.source_title}"`
    : `source_url: ""\nsource_title: ""`;

  return `---
title: "${topic.title}"
slug: "${topic.slug}"
category: "${topic.category}"
primary_persona: "${topic.persona}"
secondary_persona: ""
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

// ── Claude API を使った生成 ──────────────────────────────────────
async function generateWithClaude(dateStr, topic, modelId) {
  const _sdk    = require('@anthropic-ai/sdk');
  const Anthropic = _sdk.default || _sdk;
  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const now     = new Date().toISOString();
  const persona = PERSONA_MAP[topic.persona];
  const cta     = CTA_MAP[topic.persona] || 'ご不明な点がございましたらお気軽にご相談ください。';

  const sourceInstruction = topic.source_url
    ? `- 出典として「${topic.source_title}」（${topic.source_url}）を参照すること`
    : '- このテーマは公的URLが未指定です。source_url / source_title は空文字のまま出力してください。本文中で根拠を示す場合は「国税庁によると」等の一般的な表現に留めてください';

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログライターです。
${persona.label}が実務で直面する税務上の疑問に答える記事を書いてください。

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
- 記事末尾に免責事項を含めること
- 免責事項の後に、以下の相談導線を自然に入れること:
  「${cta}」
  「毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。」

記事のヒント: ${topic.hint}`;

  // 直近の差し戻しコメントがあれば改善ヒントとして追加
  const revisions = getRecentRevisionComments(3);
  let revisionHint = '';
  if (revisions.length > 0) {
    const items = revisions.map(r => `- ${r.comment}`).join('\n');
    revisionHint = `\n\n過去の記事で以下のレビュー指摘がありました。同様の問題を避けてください:\n${items}`;
  }

  const sourceUrl   = topic.source_url || '';
  const sourceTitle = topic.source_title || '';

  const userPrompt = `以下の条件でブログ記事の下書きを1本作成してください。

テーマ: ${topic.title}
ターゲット読者: ${persona.label}
カテゴリ: ${topic.category}${revisionHint}

以下の形式でそのまま出力してください（コードブロック不要）:

---
title: "${topic.title}"
slug: "${topic.slug}"
category: "${topic.category}"
primary_persona: "${topic.persona}"
secondary_persona: ""
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

  const message = await client.messages.create({
    model: modelId,
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  // コードブロックで包まれていた場合は除去
  const fenced = raw.match(/^```(?:markdown|yaml|md)?\n([\s\S]+)\n```\s*$/m);
  return (fenced ? fenced[1] : raw).trim();
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

// ── 差し戻し対応の再生成 (Claude API) ──────────────────────────────
async function regenerateWithClaude(existingContent, comment, modelId) {
  const _sdk    = require('@anthropic-ai/sdk');
  const Anthropic = _sdk.default || _sdk;
  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { meta, body: existingBody } = parseFrontmatter(existingContent);
  const persona = PERSONA_MAP[meta.primary_persona] || { label: meta.primary_persona || '' };
  const cta     = CTA_MAP[meta.primary_persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const now     = new Date().toISOString();

  const sourceInstruction = meta.source_url
    ? `- 出典として「${meta.source_title || ''}」（${meta.source_url}）を参照すること`
    : '- source_url / source_title は空文字のまま出力してください';

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログライターです。
${persona.label}が実務で直面する税務上の疑問に答える記事を書いてください。

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
- 記事末尾に免責事項を含めること
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

改善した記事を、以下の形式でそのまま出力してください（コードブロック不要）:

---
title: "${meta.title || ''}"
slug: "${meta.slug || ''}"
category: "${meta.category || ''}"
primary_persona: "${meta.primary_persona || ''}"
secondary_persona: "${meta.secondary_persona || ''}"
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

  const message = await client.messages.create({
    model: modelId,
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  const fenced = raw.match(/^```(?:markdown|yaml|md)?\n([\s\S]+)\n```\s*$/m);
  return (fenced ? fenced[1] : raw).trim();
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

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[regenerate] ANTHROPIC_API_KEY が必要です');
      process.exit(1);
    }

    const modelId = MODEL_STANDARD;
    console.log(`[regenerate] Claude API で再生成します（${modelId}）...`);
    const content = await regenerateWithClaude(existing, comment, modelId);

    fs.writeFileSync(filepath, content + '\n', 'utf8');
    console.log(`[regenerate] 再生成完了: content/posts/${filename}`);
    return;
  }

  // ── 通常の新規生成モード ──────────────────────────────────────
  const dateStr = getTodayJST();
  const topic   = pickTopic(dateStr);
  const persona = PERSONA_MAP[topic.persona];
  const { model, reason } = resolveModel(topic);

  console.log(`[generate] 日付: ${dateStr}`);
  console.log(`[generate] テーマ: ${topic.title}`);
  console.log(`[generate] ペルソナ: ${topic.persona} / カテゴリ: ${topic.category}`);
  console.log(`[generate] テーマ品質: ${topic.quality || 'standard'}`);
  console.log(`[generate] 使用モデル: ${model}（${reason}）`);

  // 差し戻しコメントの確認
  const revisionComments = getRecentRevisionComments(3);
  if (revisionComments.length > 0) {
    console.log(`[generate] 差し戻しコメント ${revisionComments.length} 件を改善ヒントとして使用`);
  }

  let content;
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(`[generate] Claude API で生成します（${model}）...`);
    try {
      content = await generateWithClaude(dateStr, topic, model);
    } catch (err) {
      console.warn(`[generate] Claude API 失敗: ${err.message} → テンプレートにフォールバック`);
      content = generateFromTemplate(dateStr, topic);
    }
  } else {
    console.log('[generate] ANTHROPIC_API_KEY 未設定 → テンプレートで生成します');
    content = generateFromTemplate(dateStr, topic);
  }

  // ファイル名を決定
  const filename = `${dateStr}-${topic.slug}.md`;
  const filepath = path.join(POSTS_DIR, filename);

  fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.writeFileSync(filepath, content + '\n', 'utf8');
  console.log(`[generate] 生成完了: content/posts/${filename}`);

  // GitHub Actions 出力変数
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    fs.appendFileSync(ghOutput, `filename=${filename}\n`);
    fs.appendFileSync(ghOutput, `slug=${topic.slug}\n`);
    fs.appendFileSync(ghOutput, `date=${dateStr}\n`);
    fs.appendFileSync(ghOutput, `model=${model}\n`);
  }
}

main().catch(err => {
  console.error('[generate] エラー:', err.message);
  process.exit(1);
});
