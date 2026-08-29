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

const { evaluateTopicFit, recommendationForDecision } = require('./customer-relevance');

const MAIN_TYPES = new Set(['basic_explainer', 'comparison_decision']);

// primary_persona は validate.js の REQUIRED_FIELDS。空文字だと品質チェックが
// ERROR になり、日次生成のジョブごと落ちる（2026-08-15 に発生）。
// トピックにペルソナが無い / 意図的に対象を絞らない記事でも必ず値が入るよう、
// 汎用ペルソナ（customer_segment=general_business に対応）をフォールバックにする。
const DEFAULT_PERSONA = 'general_individual_proprietor';

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
// 妥当: 6〜80 字、placeholder（全角カッコのまま）でない、明らかな煽り語を含まない、
// title-lint の HARD_FAIL を含まない（同一名詞 2 回繰り返しなど）。
// 生成時にタイトルを確定できなかったときに入れる仮置き。
// これが記事タイトルとして公開されないよう、承認/公開の各所で弾く。
const PLACEHOLDER_TITLE_PREFIX = '[要レビュー] ';
// 仮置きタイトルのときに review_warning へ入れる文言。
// タイトルが確定したら、この文言と revise 判定を取り消す（clearPlaceholderTitleWarning）。
const PLACEHOLDER_TITLE_WARNING = 'タイトル: 生成時に確定できず仮置きのままです（要修正）';

function isPlaceholderTitle(title) {
  return String(title || '').trim().startsWith(PLACEHOLDER_TITLE_PREFIX);
}

/**
 * LLM が出したタイトルが使えるかを、理由つきで判定する。
 * 2026-08-25: 理由を残していなかったため、仮置きに落ちた記事の原因が追えなかった。
 * @returns {{ok: boolean, reasons: string[]}}
 */
function checkLlmTitle(s, ctx = {}) {
  const reasons = [];
  if (!s || typeof s !== 'string') return { ok: false, reasons: ['タイトルが空'] };
  const t = s.trim();
  if (t.length < 6) reasons.push(`短すぎ: ${t.length}文字`);
  if (t.length > 80) reasons.push(`長すぎ: ${t.length}文字`);
  if (/^（.+記入.*）$/.test(t)) reasons.push('プロンプトの記入欄が残っている');
  if (/あなたがこの記事に最も適したタイトル/.test(t)) reasons.push('プロンプトの指示文が残っている');
  if (/(徹底解説|完全ガイド|必読)/.test(t)) reasons.push('安直な煽り表現');
  try {
    const { detectBannedInTitle } = require('./banned-phrases');
    const banned = detectBannedInTitle(t);
    if (banned.length > 0) reasons.push(`禁止フレーズ: ${banned.join(' / ')}`);
  } catch (_) { /* 読込失敗時は他チェックのみで判定 */ }
  try {
    const { lintTitle } = require('./title-lint');
    const r = lintTitle(t, ctx);
    if (r.fails && r.fails.length > 0) reasons.push(...r.fails);
  } catch (_) { /* lint 失敗時は他のチェックだけで判定 */ }
  return { ok: reasons.length === 0, reasons };
}

function isValidLlmTitle(s, ctx = {}) {
  return checkLlmTitle(s, ctx).ok;
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
  const titleCtx = { macro: topic.macro, article_type: articleType };
  const llmCheck = checkLlmTitle(llmTitle, titleCtx);
  let title;
  if (llmCheck.ok) {
    title = llmTitle;
  } else if (topic.title && isValidLlmTitle(topic.title, titleCtx)) {
    // curated トピック（topic-pool）の人手キュレートタイトルは妥当ならそのまま使う
    title = topic.title;
    console.warn(`[draft-normalizer] LLM タイトルを採用せず（${llmCheck.reasons.join(' / ')}）` +
      ` 却下したタイトル: "${llmTitle}" → curated topic.title を採用: "${title}"`);
  } else {
    title = `${PLACEHOLDER_TITLE_PREFIX}${topic.slug || 'untitled'}`;
    // 何を弾いたのかを必ず残す。理由を書いていなかったため、2026-08-25 に
    // 仮置きへ落ちた記事の原因を後から特定できなかった。
    console.warn(`[draft-normalizer] LLM タイトルを採用せず（${llmCheck.reasons.join(' / ')}）` +
      ` 却下したタイトル: "${llmTitle}"（${llmTitle.length}文字）`);
    console.warn(`[draft-normalizer] topic.title も無いため "${title}" を仮置き。この記事は承認できない`);
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

  // success_outcome は記事バリデーションの必須項目。トピック側で用意されていない
  // 場合でも空にしない（空のまま承認されると、以後 main の validate が毎回 ERROR に
  // なり、翌日以降の日次生成がバリデーションごと落ちる。2026-08-28/29 に発生）。
  const successOutcome = topic.success_outcome
    || (topic.primary_question
      ? `${String(topic.primary_question).replace(/[？?]\s*$/, '')}がわかり、自分のケースで判断できる`
      : `${title}について、自分のケースでどう扱うか判断できる`);

  // 適合スコア（顧客カテゴリ関連性・出典一致等）をレビュー画面用に付与する。
  // 生成時に code 側で算出し、レビュアーが判断材料として見られるようにする。
  const fit = evaluateTopicFit({ ...topic, article_type: articleType });
  let recommendation = recommendationForDecision(fit.decision); // publish | revise | reject
  let reviewWarning = fit.reason || '';

  // タイトルが仮置きのままなら、判定を「要修正」に落としてレビュー画面に理由を出す。
  // 2026-08-25: 仮置きタイトルのまま「公開推奨」と表示され、そのまま承認できる
  // 状態になっていた（気付かず承認していれば slug が記事タイトルとして公開された）。
  if (isPlaceholderTitle(title)) {
    recommendation = 'revise';
    reviewWarning = [reviewWarning, PLACEHOLDER_TITLE_WARNING]
      .filter(Boolean).join(' / ');
  }
  const sourceConfidence = Number.isFinite(Number(topic.source_confidence))
    ? Number(topic.source_confidence) : 0;

  return `---
title: "${escFm(title)}"
slug: "${escFm(topic.slug)}"
category: "${escFm(topic.category || '')}"
primary_persona: "${escFm(topic.persona || topic.primary_persona || DEFAULT_PERSONA)}"
secondary_persona: ""
article_type: "${escFm(articleType)}"
article_role: "${escFm(articleRole)}"
related_slug: "${escFm(relatedSlug)}"
related_title: "${escFm(relatedTitle)}"
related_link_text: "${escFm(relatedLinkText)}"
source_url: "${escFm(topic.source_url || '')}"
source_title: "${escFm(topic.source_title || '')}"
source_provenance: "${escFm(topic.source_provenance || 'unknown')}"
source_confidence: ${sourceConfidence}
source_guard_version: 1
search_intent: "${escFm(topic.search_intent || '')}"
reader_problem: "${escFm(topic.reader_problem || '')}"
success_outcome: "${escFm(successOutcome)}"
primary_question: "${escFm(topic.primary_question || '')}"
macro: "${escFm(topic.macro || '')}"
cluster: "${escFm(topic.cluster || '')}"
subcluster: "${escFm(topic.subcluster || '')}"
tax_domain: "${escFm(topic.tax_domain || '')}"
business_stage: "${escFm(topic.business_stage || '')}"
life_stage: "${escFm(topic.life_stage || '')}"
pain_point: "${escFm(topic.pain_point || '')}"
procedure_stage: "${escFm(topic.procedure_stage || '')}"
customer_segment: "${escFm(fit.customer_segment)}"
customer_fit_score: ${fit.customer_fit_score}
search_intent_score: ${fit.search_intent_score}
source_alignment_score: ${fit.source_alignment_score}
practical_usefulness_score: ${fit.practical_usefulness_score}
lead_value_score: ${fit.lead_value_score}
tax_risk_score: ${fit.tax_risk_score}
recommendation: "${escFm(recommendation)}"
review_warning: "${escFm(reviewWarning)}"
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

  // titleOverride: LLM のタイトルが使えず仮置きに落ちたとき、呼び出し側が
  // タイトルだけ作り直して渡してくる（generate-draft.js の retryTitleOnce）。
  const metaForFm = opts.titleOverride ? { ...llmMeta, title: opts.titleOverride } : llmMeta;

  const frontmatter = buildCanonicalFrontmatter(topicForFm, {
    llmMeta: metaForFm, now: opts.now, pairedTopic: opts.pairedTopic,
  });

  const content = `${frontmatter}\n\n${body.trim()}\n`;
  return {
    content,
    body: body.trim(),
    title: (frontmatter.match(/^title:\s*"(.*)"$/m) || [])[1] || '',
    bodyH2Count: countH2(body),
    hadFrontmatter,
    leadingTextStripped: !!(extractFrontmatterAndBody(stripped).leadingText),
  };
}

/**
 * 部分再生成でタイトルが確定したのに、生成時に付いた仮置きの警告と
 * revise 判定が frontmatter に残る問題を解消する。
 *
 * 2026-08-27: タイトルを直したのに「タイトル: 生成時に確定できず仮置きの
 * ままです（要修正）」と recommendation=revise が残り、承認できなかった。
 * 部分再生成は判定を作り直さないため、ここで整合をとる。
 *
 * 仮置きの警告だけが残っていた場合に限り取り消す。他の理由の警告は触らない。
 * @returns {string} 整合をとった frontmatter を持つ記事全文
 */
function clearPlaceholderTitleWarning(raw) {
  const text = String(raw || '');
  const title = (text.match(/^title:\s*"(.*)"$/m) || [])[1];
  if (title === undefined || isPlaceholderTitle(title)) return text;   // まだ仮置きなら何もしない

  const warnMatch = text.match(/^review_warning:\s*"(.*)"$/m);
  if (!warnMatch || !warnMatch[1].includes(PLACEHOLDER_TITLE_WARNING)) return text;

  const rest = warnMatch[1].split(' / ').filter(w => w && w !== PLACEHOLDER_TITLE_WARNING);
  let out = text.replace(/^review_warning:\s*".*"$/m, `review_warning: "${rest.join(' / ')}"`);
  // 残る警告が無ければ、仮置きだけを理由にした revise を publish に戻す
  if (rest.length === 0) {
    out = out.replace(/^recommendation:\s*"revise"$/m, 'recommendation: "publish"');
  }
  return out;
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
  checkLlmTitle,
  isPlaceholderTitle,
  PLACEHOLDER_TITLE_PREFIX,
  PLACEHOLDER_TITLE_WARNING,
  clearPlaceholderTitleWarning,
  RELATED_LINK_TEXTS,
};
