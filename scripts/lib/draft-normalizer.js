'use strict';

/**
 * 生成記事の正規化
 *
 * LLM（Claude Sonnet 4.6 等）の出力は、以下のように崩れることがある:
 *   - 出力前に説明文が混ざる
 *   - ```markdown のコードブロックで囲まれる
 *   - frontmatter が `---` から始まらない / 途中に出る
 *   - 本文だけ返ってくる（frontmatter 無し）
 *   - quote 形式が single / double / block scalar
 *
 * これらでも壊れないよう、本文（Markdown）を抽出し、
 * frontmatter は topic metadata から**コード側で確実に構築**する。
 * → LLM に frontmatter を完全依存せず、必須項目をシステムで保証する。
 */

const MAIN_TYPES = new Set(['basic_explainer', 'comparison_decision']);

// 記事タイプ別の関連記事リンク文言（generate-draft の RELATED_LINK_TEXTS と整合）
const RELATED_LINK_TEXTS = {
  basic_explainer:     '基本から確認したい方はこちら',
  comparison_decision: '比較・判断のポイントはこちら',
  edge_case:           '判断に迷うケースについてはこちら',
  industry_example:    '業種別の具体例はこちら',
  filing_practice:     '申告実務の注意点はこちら',
  misconception_fix:   'よくある誤解と正しい理解はこちら',
  case_study:          '具体的な事例で確認するにはこちら',
};

// ── マークダウンコードフェンス除去 ──────────────────────────────
function stripCodeFences(text) {
  if (!text) return '';
  let t = text.trim();
  // 全体が ```...``` で囲まれている場合に中身を取り出す
  const whole = t.match(/^```(?:markdown|md|yaml|yml)?\s*\n([\s\S]*?)\n```\s*$/);
  if (whole) return whole[1].trim();
  // 先頭の ``` 開始だけ（閉じ無し）を除去
  t = t.replace(/^```(?:markdown|md|yaml|yml)?\s*\n/, '');
  // 末尾の ``` を除去
  t = t.replace(/\n```\s*$/, '');
  return t.trim();
}

// ── 最初の YAML frontmatter ブロックを抽出 ──────────────────────
// 先頭に説明文があっても、最初の `---\n...\n---` を探す。
function extractFrontmatterAndBody(text) {
  const t = text.replace(/^﻿/, ''); // BOM 除去
  // 先頭（空白/説明文許容）から最初の frontmatter ブロックを探す
  const fmRe = /(^|\n)---\r?\n([\s\S]+?)\r?\n---\r?\n?/;
  const m = t.match(fmRe);
  if (!m) {
    return { meta: {}, body: t.trim(), hadFrontmatter: false };
  }
  // frontmatter より前に本文らしき長いテキストがある場合は、それを誤検出している可能性。
  // ただし通常は先頭付近なので、前置きが短ければ frontmatter とみなす。
  const before = t.slice(0, m.index).trim();
  const fmText = m[2];
  const after = t.slice(m.index + m[0].length);

  const meta = parseYamlish(fmText);
  // frontmatter として妥当か（title か slug を含む）を確認
  const looksLikeFm = meta.title != null || meta.slug != null ||
    meta.primary_persona != null || meta.review_status != null;
  if (!looksLikeFm) {
    // frontmatter ではなかった → 全文を body とみなす
    return { meta: {}, body: t.trim(), hadFrontmatter: false };
  }
  // before（前置き説明文）は破棄。body は after。
  return { meta, body: after.trim(), hadFrontmatter: true, leadingText: before };
}

// ── 簡易 YAML パーサ（single/double/block scalar/裸 を許容）─────
function parseYamlish(fmText) {
  const meta = {};
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];

    // block scalar（>- や | ）の場合、続く字下げ行を結合
    if (/^[|>][-+]?\s*$/.test(val.trim())) {
      const collected = [];
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        collected.push(lines[j].trim());
        j++;
      }
      meta[key] = collected.join(' ');
      i = j - 1;
      continue;
    }
    val = unquote(val.trim());
    meta[key] = val;
  }
  return meta;
}

function unquote(s) {
  if (!s) return '';
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

// ── 本文冒頭から summary を生成（フォールバック）────────────────
function deriveSummary(body, topic) {
  // 本文の最初の意味のある段落（見出し/空行を除く）から 120 字以内で抽出
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) continue; // 見出しスキップ
    if (/^[-*|>]/.test(t)) continue;   // 箇条書き/表/引用スキップ
    const clean = t.replace(/[*_`#]/g, '');
    if (clean.length >= 10) return clean.slice(0, 118);
  }
  // 本文から取れなければ topic ベース
  return `${topic.title || ''}について、判断のポイントと実務上の注意点を整理します。`.slice(0, 118);
}

function escFm(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

// ── LLM 出力のタイトルを検証 ──────────────────────────────────
// 妥当: 6〜80 字、placeholder（全角カッコのまま）でない、明らかな煽り語を含まない
function isValidLlmTitle(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 6 || t.length > 80) return false;
  // placeholder（プロンプトの「（〜記入）」が残っているケース）
  if (/^（.+記入.*）$/.test(t)) return false;
  if (/あなたがこの記事に最も適したタイトル/.test(t)) return false;
  // 安直な煽り（最終ガード）
  if (/(徹底解説|完全ガイド|必読)/.test(t)) return false;
  return true;
}

// ── topic metadata から canonical frontmatter を構築 ────────────
// LLM frontmatter（llmMeta）から title / summary を採用（妥当な場合）。
// title は Pattern C: ルールベース生成は使わず、LLM 出力を最終タイトルとする。
function buildCanonicalFrontmatter(topic, { llmMeta = {}, now, pairedTopic } = {}) {
  const ts = now || new Date().toISOString();
  const articleType = topic.article_type || 'basic_explainer';
  const articleRole = topic.article_role || (MAIN_TYPES.has(articleType) ? 'main' : 'support');

  const relatedSlug      = pairedTopic ? pairedTopic.slug : (topic.related_slug || '');
  const relatedTitle     = pairedTopic ? pairedTopic.title : (topic.related_title || '');
  const relatedLinkText  = pairedTopic
    ? (RELATED_LINK_TEXTS[pairedTopic.article_type] || 'あわせて読みたい')
    : (topic.related_link_text || '');

  // title: LLM 出力を採用（Pattern C）。妥当性チェックに失敗した場合のみ
  // 「[要レビュー] {slug}」を入れて人間レビュアーが気付けるようにする。
  // ※ルールベースの title 生成（title-builder）には絶対に戻さない。
  const llmTitle = (llmMeta.title || '').trim();
  let title;
  if (isValidLlmTitle(llmTitle)) {
    title = llmTitle;
  } else if (topic.title && isValidLlmTitle(topic.title)) {
    // curated トピック（topic-pool）の人手キュレートタイトルは妥当ならそのまま使う
    title = topic.title;
    console.warn(`[draft-normalizer] LLM タイトル無効 → curated topic.title を採用: "${title}"`);
  } else {
    title = `[要レビュー] ${topic.slug || 'untitled'}`;
    console.warn(`[draft-normalizer] LLM タイトル無効 + topic.title 無し → "${title}" を仮置き。レビューで修正必須`);
  }

  // summary: LLM のものが妥当（10〜160字）ならそれ、なければ topic、なければ本文派生（呼び出し側で渡す）
  let summary = '';
  const llmSummary = (llmMeta.summary || '').trim();
  if (llmSummary && llmSummary.length >= 10 && llmSummary.length <= 200 && !/^（.*）$/.test(llmSummary)) {
    summary = llmSummary;
  } else if (topic.summary && topic.summary.length >= 10) {
    summary = topic.summary;
  } else if (topic._derivedSummary) {
    summary = topic._derivedSummary;
  } else {
    summary = `${title}について、判断のポイントと実務上の注意点を整理します。`;
  }

  return `---
title: "${escFm(title)}"
slug: "${escFm(topic.slug)}"
category: "${escFm(topic.category || '')}"
primary_persona: "${escFm(topic.persona || topic.primary_persona || '')}"
secondary_persona: ""
article_type: "${escFm(articleType)}"
article_role: "${escFm(articleRole)}"
related_slug: "${escFm(relatedSlug)}"
related_title: "${escFm(relatedTitle)}"
related_link_text: "${escFm(relatedLinkText)}"
source_url: "${escFm(topic.source_url || '')}"
source_title: "${escFm(topic.source_title || '')}"
search_intent: "${escFm(topic.search_intent || '')}"
reader_problem: "${escFm(topic.reader_problem || '')}"
success_outcome: "${escFm(topic.success_outcome || '')}"
primary_question: "${escFm(topic.primary_question || '')}"
macro: "${escFm(topic.macro || '')}"
cluster: "${escFm(topic.cluster || '')}"
subcluster: "${escFm(topic.subcluster || '')}"
tax_domain: "${escFm(topic.tax_domain || '')}"
business_stage: "${escFm(topic.business_stage || '')}"
life_stage: "${escFm(topic.life_stage || '')}"
pain_point: "${escFm(topic.pain_point || '')}"
procedure_stage: "${escFm(topic.procedure_stage || '')}"
summary: "${escFm(summary)}"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "${escFm(topic._created_at || ts)}"
updated_at: "${escFm(ts)}"
---`;
}

// ── 本文中の h2 見出し数 ────────────────────────────────────────
function countH2(body) {
  return (body.match(/^##\s+/gm) || []).length;
}

/**
 * 生成出力を正規化する。
 * @param {string} rawText  LLM の生出力（postProcess 済みでも可）
 * @param {Object} topic     トピック metadata（frontmatter 構築の正本）
 * @param {Object} opts      { now, pairedTopic }
 * @returns {Object} { content, body, bodyH2Count, hadFrontmatter, summary }
 */
function normalizeGeneratedDraft(rawText, topic, opts = {}) {
  const stripped = stripCodeFences(rawText || '');
  const { meta: llmMeta, body, hadFrontmatter } = extractFrontmatterAndBody(stripped);

  // body から summary を派生できるよう topic に一時保存
  const derived = deriveSummary(body, topic);
  const topicForFm = { ...topic, _derivedSummary: derived };

  const frontmatter = buildCanonicalFrontmatter(topicForFm, {
    llmMeta, now: opts.now, pairedTopic: opts.pairedTopic,
  });

  const content = `${frontmatter}\n\n${body.trim()}\n`;
  return {
    content,
    body: body.trim(),
    bodyH2Count: countH2(body),
    hadFrontmatter,
    leadingTextStripped: !!(extractFrontmatterAndBody(stripped).leadingText),
  };
}

module.exports = {
  normalizeGeneratedDraft,
  stripCodeFences,
  extractFrontmatterAndBody,
  buildCanonicalFrontmatter,
  parseYamlish,
  countH2,
  deriveSummary,
  isValidLlmTitle,
  RELATED_LINK_TEXTS,
};
