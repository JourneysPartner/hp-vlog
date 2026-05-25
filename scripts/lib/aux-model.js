'use strict';

/**
 * 周辺作業用モデル（claude-haiku-4-5-20251001 想定）の呼び出し
 *
 * 方針:
 *   - 原則ルールベース優先。ルールで明確に判断できる処理は API を呼ばない。
 *   - AUX_MODEL_ENABLED=true かつ「Haiku が要るタスク」のときだけ呼ぶ。
 *   - Haiku 失敗時は可能な限りルールベース fallback（周辺作業の失敗で本文生成を止めない）。
 *   - APIキー・本文・秘密情報はログに出さない。provider/model/task/usage のみ。
 *
 * 環境変数:
 *   AUX_MODEL_ENABLED   'true' で周辺作業の API 利用を許可（既定 false = 完全ルールベース）
 *   AUX_MODEL_PROVIDER  'anthropic'（既定）| 'openai' | 'rule_based'
 *   AUX_MODEL           モデルID（既定 claude-haiku-4-5-20251001）
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY
 */

const ANTHROPIC_VERSION = '2023-06-01';
const AUX_DEFAULT_MODEL  = 'claude-haiku-4-5-20251001';

function auxEnabled() {
  return (process.env.AUX_MODEL_ENABLED || 'false').toLowerCase() === 'true';
}

function auxProvider() {
  return (process.env.AUX_MODEL_PROVIDER || 'anthropic').toLowerCase();
}

function auxModel() {
  return process.env.AUX_MODEL || AUX_DEFAULT_MODEL;
}

/**
 * 周辺作業を Haiku で実行できる状態か判定する。
 * - AUX_MODEL_ENABLED=true
 * - provider が rule_based でない
 * - 対応する API キーがある
 */
function canUseAux() {
  if (!auxEnabled()) return false;
  const p = auxProvider();
  if (p === 'rule_based') return false;
  if (p === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return false;
  if (p === 'openai' && !process.env.OPENAI_API_KEY) return false;
  return true;
}

// ── 低レベル呼び出し（短いプロンプト用。秘密情報はログに出さない）──
async function callAux({ system, user, task, maxTokens = 512 }) {
  const provider = auxProvider();
  const model = auxModel();

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: system ? [{ type: 'text', text: system }] : undefined,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic(aux) ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const u = data.usage || {};
    console.log(`[aux-model] provider=anthropic model=${model} task=${task} ` +
      `usage(in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'})`);
    return Array.isArray(data.content) ? data.content.map(b => b.text || '').join('') : '';
  }

  // openai（任意の代替）
  const _sdk = require('openai');
  const OpenAI = _sdk.default || _sdk.OpenAI || _sdk;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.4',  // OpenAI には Claude ID を渡さない
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
  });
  const u = completion.usage || {};
  console.log(`[aux-model] provider=openai model=${process.env.OPENAI_MODEL || 'gpt-5.4'} task=${task} ` +
    `usage(in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'})`);
  const choice = completion.choices && completion.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

/**
 * 汎用 aux 呼び出し。canUseAux() でなければ null を返す（呼び出し側がルールベース継続）。
 */
async function generateAux({ system, user, task, maxTokens }) {
  if (!canUseAux()) return null;
  try {
    return await callAux({ system, user, task, maxTokens });
  } catch (e) {
    console.warn(`[aux-model] task=${task} 失敗（${e.message}）→ ルールベース fallback`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  タスク別ヘルパー（ルールベース優先 → 必要時のみ Haiku）
// ════════════════════════════════════════════════════════════════

/**
 * 差し戻しコメントの分類補助。
 * まずルールベース（revision-classifier）で分類し、
 * 「targeted（=デフォルト落ち、低確度）」かつ aux 利用可能なときだけ Haiku で補助する。
 */
async function classifyWithAuxIfNeeded(comment, ruleResult) {
  // ルールベースで明確に判定できた（targeted デフォルト以外）ならそのまま使う
  const isLowConfidence = ruleResult &&
    ruleResult.type === 'factual_correction' &&
    /デフォルト/.test(ruleResult.reason || '');
  if (!isLowConfidence || !canUseAux()) return ruleResult;

  const out = await generateAux({
    task: 'revise_classify',
    maxTokens: 64,
    system: 'あなたは編集アシスタントです。差し戻しコメントの修正範囲を1語で分類します。',
    user: `次の差し戻しコメントの修正範囲を、以下から1つだけ選んで単語のみ返してください。
title_only / table_fix / add_section / section_only / intro_conclusion_fix / factual_correction / full_regenerate

コメント: ${comment}`,
  });
  if (!out) return ruleResult;
  const token = (out.match(/title_only|table_fix|add_section|section_only|intro_conclusion_fix|factual_correction|full_regenerate/) || [])[0];
  if (!token) return ruleResult;
  const scopeMap = {
    title_only: 'frontmatter', table_fix: 'section', add_section: 'section',
    section_only: 'section', intro_conclusion_fix: 'section',
    factual_correction: 'targeted', full_regenerate: 'full',
  };
  return { ...ruleResult, type: token, scope: scopeMap[token], reason: 'aux(Haiku)による分類補助' };
}

/**
 * タイトル自然化補助。
 * まず title-lint でチェックし、warn/fail があり aux 利用可能なときだけ Haiku で自然化。
 * 失敗時は元タイトルを返す（ルールベース fallback）。
 */
async function polishTitleWithAuxIfNeeded(title, ctx = {}) {
  const { lintTitle } = require('./title-lint');
  const r = lintTitle(title, ctx);
  if (r.fails.length === 0 && r.warns.length === 0) return title;  // 問題なし → そのまま
  if (!canUseAux()) return title;  // ルールベースのみ → そのまま

  const out = await generateAux({
    task: 'title_polish',
    maxTokens: 80,
    system: 'あなたは日本語の編集者です。検索者が自然に検索しそうなブログ記事タイトルに整えます。意味は変えません。',
    user: `次のタイトルを、より自然で読みやすい日本語に整えてください。タイトルだけを1行で返してください。
「に押さえる」「が直面するに」のような不自然な表現や、名詞の過剰連結を避けてください。

タイトル: ${title}`,
  });
  if (!out) return title;
  const polished = out.split(/\r?\n/)[0].trim().replace(/^["「『]|["」』]$/g, '');
  // 整形後も lint を通るか確認。だめなら元に戻す（品質ガード）
  const r2 = lintTitle(polished, ctx);
  return (polished && r2.fails.length === 0) ? polished : title;
}

/**
 * 軽い校正（誤字・表記ゆれ）補助。
 * aux 利用不可なら原文をそのまま返す（ルールベースでは校正しない方針）。
 */
async function proofreadLightlyWithAuxIfNeeded(text) {
  if (!canUseAux()) return text;
  const out = await generateAux({
    task: 'light_proofread',
    maxTokens: Math.min(2048, Math.ceil(text.length / 2)),
    system: 'あなたは日本語の校正者です。誤字・脱字・明らかな表記ゆれのみを直し、内容・構成・意味は変えません。Markdown 構造は保持します。',
    user: `次の文章の誤字・脱字・表記ゆれだけを直して、修正後の全文を返してください。\n\n${text}`,
  });
  return out && out.trim() ? out.trim() : text;
}

module.exports = {
  auxEnabled,
  auxProvider,
  auxModel,
  canUseAux,
  generateAux,
  classifyWithAuxIfNeeded,
  polishTitleWithAuxIfNeeded,
  proofreadLightlyWithAuxIfNeeded,
  AUX_DEFAULT_MODEL,
};
