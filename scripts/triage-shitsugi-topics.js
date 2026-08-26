#!/usr/bin/env node
'use strict';
/**
 * 質疑応答事例候補の LLM 全件選別（段階1.5）
 *
 * data/nta-shitsugi-topics-candidate.json の candidates 全982件を LLM で選別し、
 * 各候補に llm_triage（decision / reason / corrected_persona / judged_at / model）を
 * 書き戻す。
 *
 * なぜ必要か:
 *   手動採用（adopted フラグ）は「どれを採用していいかわからない・数が多い」で
 *   276件で停滞し、精度も出ていなかった（機械判定 reject の候補が11件混入）。
 *   機械の点数だけでは「日本標準産業分類の解説」のような分類表ページが84点を
 *   取ってしまう。実在の読者の悩みに答えるページかどうかは LLM に判定させる。
 *
 * 実行:
 *   node scripts/triage-shitsugi-topics.js            # 未選別のみ判定（再開可能）
 *   node scripts/triage-shitsugi-topics.js --force    # 全件を判定し直す
 *   node scripts/triage-shitsugi-topics.js --limit 30 # 最初の30件だけ（動作確認用）
 *
 * OPENAI_API_KEY が必要。モデルは LLM_TRIAGE_MODEL（既定 gpt-5.6-luna）。
 * バッチごとにファイルへ書き戻すため、途中で落ちても再実行すれば続きから進む。
 */

const fs = require('fs');
const path = require('path');
const { parseJsonLoose } = require('./lib/llm-source-selector');
const { MACRO_BY_PERSONA } = require('./lib/shitsugi-topics');

const ROOT = path.join(__dirname, '..');
const CANDIDATE_FILE = path.join(ROOT, 'data', 'nta-shitsugi-topics-candidate.json');
const SOURCE_ROOT = path.join(ROOT, 'data', 'nta-sources');
const BATCH_SIZE = 15;
const QUESTION_EXCERPT_CHARS = 300;

// ── 判定基準（指示書 R2。ここから発明・逸脱しない）─────────────────
const SYSTEM_PROMPT = [
  'あなたは日本の税理士事務所ブログの編集長です。',
  '国税庁の「質疑応答事例」のページ一覧から、当ブログの記事の題材として使えるものを選別します。',
  '',
  '# 当ブログの顧客層',
  'EC・フリマ・ネット物販の事業者／クリエイター・YouTuber・コンテンツ販売者／',
  '美容サロン経営者／建設業の一人親方／小売店・卸売業者／一般の個人事業主／中小法人／',
  '相続・贈与に直面する個人',
  '',
  '# reject にする条件（いずれかに該当したら reject）',
  '1. 読者の悩みに答えるページではない: 分類表・一覧表・様式や手続の逐条解説・',
  '   通達の適用関係の整理など、「実在の人の疑問」ではなく「資料」であるもの',
  '2. 当ブログの顧客層の外: 公益法人・特殊法人向け／金融機関・金融商品の運用／',
  '   大法人の組織再編・連結／輸出入の特殊関税手続 など',
  '3. どの顧客カテゴリに置き換えても接点が不自然: 読者想定（persona）を別の顧客',
  '   カテゴリに直しても、その読者が検索して辿り着く場面が想像できないもの',
  '',
  '# adopt にする条件',
  '上記に該当せず、実在の読者（顧客層のいずれか）が同じ場面で迷いうる論点であること。',
  '提示された persona が不自然でも、別の顧客カテゴリなら自然な場合は',
  'corrected_persona にそのカテゴリの ID を入れて adopt にする。',
  `corrected_persona に使える ID: ${Object.keys(MACRO_BY_PERSONA).join(' / ')}`,
  '',
  '# 重要',
  '- 判定に迷う場合は reject に倒す（候補は他にも十分ある。誤 adopt の方が高くつく）',
  '- 出力は次の JSON のみ。前置き・後書き・コードフェンスを付けない',
  '{"results": [{"item": <番号>, "decision": "adopt"|"reject", "reason": "<日本語で簡潔に>", "corrected_persona": "<必要な場合のみ>"}]}',
].join('\n');

function excerptQuestion(candidate, sourceRoot) {
  try {
    const relative = String(candidate.file_path || '').replace(/[\\/]+/g, path.sep);
    const resolved = path.resolve(sourceRoot, relative);
    if (!resolved.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) return '';
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return String(parsed.shokai_yoshi || '').replace(/\s+/g, ' ').trim().slice(0, QUESTION_EXCERPT_CHARS);
  } catch (_error) {
    return '';   // 照会要旨が読めない場合は題名だけで判定させる
  }
}

function buildUserPrompt(batch, sourceRoot) {
  const lines = ['次の各候補を判定してください。', ''];
  batch.forEach((candidate, index) => {
    lines.push(`## 候補 ${index + 1}`);
    lines.push(`題名: ${candidate.shitsugi_title}`);
    lines.push(`税目: ${candidate.tax_category}`);
    lines.push(`提示された persona: ${(candidate.proposed && candidate.proposed.persona) || '（無し）'}`);
    const question = excerptQuestion(candidate, sourceRoot);
    if (question) lines.push(`照会要旨（冒頭）: ${question}`);
    lines.push('');
  });
  return lines.join('\n');
}

function validateResults(parsed, batchLength) {
  if (!parsed || !Array.isArray(parsed.results)) return null;
  const byItem = new Map();
  for (const r of parsed.results) {
    const item = Number(r && r.item);
    if (!Number.isInteger(item) || item < 1 || item > batchLength) continue;
    const decision = r.decision === 'adopt' || r.decision === 'reject' ? r.decision : null;
    if (!decision) continue;
    const out = { decision, reason: String(r.reason || '').trim().slice(0, 200) };
    const persona = String(r.corrected_persona || '').trim();
    if (persona && MACRO_BY_PERSONA[persona]) out.corrected_persona = persona;
    byItem.set(item, out);
  }
  // 全件そろっていなければ形式不正として扱う（部分適用は再開処理を複雑にするだけ）
  return byItem.size === batchLength ? byItem : null;
}

/**
 * @param {Object} options
 *   callLLM: async (system, user) => string   … テストではモックを注入
 *   candidateFile / sourceRoot / force / limit / batchSize / model / logger / nowFn
 * @returns {{ judged:number, adopt:number, reject:number, corrected:number,
 *             skippedBatches:number, targeted:number }}
 */
async function runTriage(options = {}) {
  const callLLM = options.callLLM;
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const candidateFile = options.candidateFile || CANDIDATE_FILE;
  const sourceRoot = options.sourceRoot || SOURCE_ROOT;
  const batchSize = options.batchSize || BATCH_SIZE;
  const model = options.model || process.env.LLM_TRIAGE_MODEL || 'gpt-5.6-luna';
  const logger = options.logger === undefined ? console : options.logger;
  const nowFn = options.nowFn || (() => new Date().toISOString());
  const log = (msg) => { if (logger && typeof logger.log === 'function') logger.log(msg); };
  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };

  const data = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const targets = candidates.filter(c => c && (options.force
    ? true
    : !(c.llm_triage && c.llm_triage.decision)));
  const limited = Number.isInteger(options.limit) && options.limit > 0
    ? targets.slice(0, options.limit) : targets;

  const stats = { judged: 0, adopt: 0, reject: 0, corrected: 0, skippedBatches: 0, targeted: limited.length };
  const total = candidates.length;
  const alreadyJudged = () => candidates.filter(c => c && c.llm_triage && c.llm_triage.decision);

  for (let offset = 0; offset < limited.length; offset += batchSize) {
    const batch = limited.slice(offset, offset + batchSize);
    const user = buildUserPrompt(batch, sourceRoot);

    let results = null;
    for (let attempt = 1; attempt <= 2 && !results; attempt++) {
      try {
        const raw = await callLLM(SYSTEM_PROMPT, user);
        results = validateResults(parseJsonLoose(raw), batch.length);
        if (!results && attempt === 1) warn('[triage] 応答の形式が不正 → 1回だけリトライします');
      } catch (error) {
        warn(`[triage] LLM 呼び出し失敗 (${attempt}回目): ${error.message}`);
      }
    }
    if (!results) {
      stats.skippedBatches++;
      warn(`[triage] このバッチ（${batch.length}件）をスキップして続行します`);
      continue;
    }

    batch.forEach((candidate, index) => {
      const r = results.get(index + 1);
      candidate.llm_triage = {
        decision: r.decision,
        reason: r.reason,
        ...(r.corrected_persona ? { corrected_persona: r.corrected_persona } : {}),
        judged_at: nowFn(),
        model,
      };
      stats.judged++;
      if (r.decision === 'adopt') stats.adopt++; else stats.reject++;
      if (r.corrected_persona) stats.corrected++;
    });

    // バッチごとに書き戻す（途中で落ちても再実行で続きから進めるように）
    fs.writeFileSync(candidateFile, JSON.stringify(data, null, 2) + '\n', 'utf8');

    const done = alreadyJudged();
    const adoptTotal = done.filter(c => c.llm_triage.decision === 'adopt').length;
    log(`[triage] ${done.length}/${total} 判定済み (adopt ${adoptTotal} / reject ${done.length - adoptTotal})`);
  }

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : null;

  if (!process.env.OPENAI_API_KEY) {
    console.error('[triage] OPENAI_API_KEY が未設定です');
    process.exit(1);
  }
  const { makeOpenAILuna } = require('./lib/llm-source-selector');
  const model = process.env.LLM_TRIAGE_MODEL || 'gpt-5.6-luna';
  process.env.LLM_SOURCE_SELECT_MODEL = model;   // makeOpenAILuna が読むモデル指定を選別用に合わせる
  const callLLM = makeOpenAILuna();

  const stats = await runTriage({ callLLM, force, limit, model });
  console.log(`[triage] 完了: 対象 ${stats.targeted} 件 / 判定 ${stats.judged} 件 ` +
    `(adopt ${stats.adopt} / reject ${stats.reject} / persona補正 ${stats.corrected}) ` +
    `/ スキップしたバッチ ${stats.skippedBatches}`);
  if (stats.targeted > 0 && stats.judged === 0) {
    console.error('[triage] 1件も判定できませんでした');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[triage] 失敗:', e.message); process.exit(1); });
}

module.exports = { runTriage, validateResults, buildUserPrompt, SYSTEM_PROMPT, BATCH_SIZE, CANDIDATE_FILE };
