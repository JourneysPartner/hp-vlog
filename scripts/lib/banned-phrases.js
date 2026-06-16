'use strict';

/**
 * 本文・タイトル禁止フレーズ（データ駆動）
 *
 * data/banned-phrases.json を正本として、以下を提供する:
 *   - loadBannedPhrases() : JSON 読み込み
 *   - applyBannedPhrasesToBody(text) : 本文の sanitize（replacement あり時のみ置換）
 *   - detectBannedInBody(text) : 検出のみ（self-check 用）
 *   - formatForPrompt() : LLM プロンプトに注入する禁止指示文を生成
 *   - extractBannedFromComment(comment) : 差し戻しコメントから「今後〜禁止」フレーズを自動抽出
 *
 * 設計方針:
 *   - replacement が null の場合は「置換せず警告のみ」（人間レビューに委ねる）
 *   - replacement あり時は generate-draft の sanitize で自動置換
 *   - 3 段防御: ① LLM プロンプトで事前回避 ② sanitize で後処理 ③ self-check で警告
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_PATH = path.join(ROOT, 'data', 'banned-phrases.json');

// ── データ I/O ─────────────────────────────────────────────────
function loadBannedPhrases() {
  if (!fs.existsSync(DATA_PATH)) {
    return { version: 1, phrases: [] };
  }
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.phrases || !Array.isArray(data.phrases)) {
      return { version: 1, phrases: [] };
    }
    return data;
  } catch (e) {
    console.warn(`[banned-phrases] 読込失敗（空として扱う）: ${e.message}`);
    return { version: 1, phrases: [] };
  }
}

function saveBannedPhrases(data) {
  const out = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(DATA_PATH, out, 'utf8');
}

// ── スコープ別取得 ─────────────────────────────────────────────
function getPhrasesForScope(scope, data) {
  const all = (data || loadBannedPhrases()).phrases || [];
  return all.filter(p =>
    Array.isArray(p.appliesTo) && p.appliesTo.includes(scope)
  );
}

// ── 本文への適用（sanitize）────────────────────────────────────
// replacement が文字列なら置換（空文字 "" も置換対象＝該当箇所を削除する意図）。
// replacement が null/undefined なら検出のみ。
function applyBannedPhrasesToBody(text, data) {
  const phrases = getPhrasesForScope('body', data);
  let out = text;
  const applied = [];
  for (const p of phrases) {
    let re;
    try { re = new RegExp(p.pattern, 'g'); }
    catch (e) {
      console.warn(`[banned-phrases] 不正な regex pattern (id=${p.id}): ${e.message}`);
      continue;
    }
    if (re.test(out)) {
      const hasReplacement = typeof p.replacement === 'string';
      applied.push({ id: p.id, pattern: p.pattern, hasReplacement });
      if (hasReplacement) {
        out = out.replace(re, p.replacement);
      }
    }
  }
  return { text: out, applied };
}

// ── 検出のみ（self-check 用 — sanitize 後にも残っているかチェック）─
function detectBannedInBody(text, data) {
  const phrases = getPhrasesForScope('body', data);
  const hits = [];
  for (const p of phrases) {
    let re;
    try { re = new RegExp(p.pattern, 'g'); }
    catch { continue; }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      hits.push({ id: p.id, match: m[0], pattern: p.pattern });
      if (!re.global) break;
    }
  }
  return hits;
}

// ── LLM プロンプト用の指示文を生成 ────────────────────────────
// data/banned-phrases.json の body スコープエントリを「使わない」リストとして
// 動的プロンプトに注入する。空なら空文字を返す（プロンプト肥大化を避ける）。
function formatForPrompt(maxItems = 30) {
  const phrases = getPhrasesForScope('body');
  if (phrases.length === 0) return '';
  const items = phrases.slice(0, maxItems).map(p => {
    // humanReadable があればそれを使う（手書き済の読みやすい表記）
    // 無ければ pattern から正規表現メタを取り除いて整形
    const human = p.humanReadable || p.pattern
      .replace(/\\s\*/g, '')
      .replace(/\\s\+/g, ' ')
      .replace(/\\d\+/g, '◯')
      .replace(/\\d/g, '◯')
      .replace(/\[[^\]]+\]\+/g, '◯')
      .replace(/\[[^\]]+\]/g, '◯')
      .replace(/\(\?:[^)]+\)/g, '')
      .replace(/\\([.*+?^${}()|\[\]\\])/g, '$1');
    return `- 「${human}」（${p.reason || '過去のレビューで禁止'}）`;
  }).join('\n');
  return `\n═══ 本文で絶対に使わない定型表現（過去のレビューで禁止指定された文言）═══
${items}
↑ これらは陳腐化・形式的すぎるとレビューで指摘された表現です。本文のどこにも書かないこと。`;
}

// ── 差し戻しコメントから「今後〜禁止」フレーズを自動抽出 ───────────
// 検出パターン:
//   1) 「今後...「<phrase>」...という文言...書かないで」 → リテラル
//   2) 「、<phrase>、というような文言」 → wildcard 化（◯〇○ → \d+）
function extractBannedFromComment(comment, opts = {}) {
  if (!comment || typeof comment !== 'string') return [];
  const now = opts.now || new Date().toISOString();
  const sourceArticle = opts.sourceArticle || null;

  // スコープ: 「今後/以後/これから」～「書かないで/使わないで/...」の範囲
  // 末尾の「書かないでください」「使わないでください」「やめてください」「禁止して」までを抽出範囲とする。
  const scopeRe = /(?:今後|以後|これから|今回以降|今度から)[、,]?\s*([\s\S]+?)(?:書かないで|使わないで|入れないで|やめて|禁止して|お願いします|お願いいたします)/;
  const scopeMatch = comment.match(scopeRe);
  if (!scopeMatch) return [];
  const scope = scopeMatch[1];

  const found = [];
  const seenPatterns = new Set();

  // 1) 引用符 (「」/『』) 内のフレーズ → リテラル（regex メタ文字を escape）
  const quotedRe = /[「『]([^」』]{3,80})[」』]/g;
  let q;
  while ((q = quotedRe.exec(scope)) !== null) {
    const phrase = q[1].trim();
    const pattern = escapeRegex(phrase);
    if (seenPatterns.has(pattern)) continue;
    seenPatterns.add(pattern);
    found.push(makeEntry(phrase, pattern, false, now, sourceArticle));
  }

  // 2) 「、<phrase>、というような文言」「、<phrase>、というよう文言」 → wildcard 化
  //    ◯〇○XxⅩ等を \d+ に変換
  const unquotedRe = /[、,]\s*([^「『、,。\n]{4,40}?)[、,]\s*(?:というような|というよう|というふう|という形|のような)?\s*文言/g;
  let u;
  while ((u = unquotedRe.exec(scope)) !== null) {
    const phrase = u[1].trim();
    if (!phrase) continue;
    if (/^(?:や|や、|と|また)$/.test(phrase)) continue;  // 接続詞のみは除外
    const pattern = wildcardize(phrase);
    if (seenPatterns.has(pattern)) continue;
    seenPatterns.add(pattern);
    found.push(makeEntry(phrase, pattern, true, now, sourceArticle));
  }

  return found;
}

function makeEntry(originalPhrase, pattern, isWildcard, now, sourceArticle) {
  // ID: phrase の英数字化スラグ + タイムスタンプ
  const slug = originalPhrase
    .replace(/[^一-鿿ぁ-んァ-ヶa-zA-Z0-9]/g, '')
    .slice(0, 20) || 'banned';
  const id = `auto-${slug}-${Date.now().toString(36)}`;
  return {
    id,
    pattern,
    replacement: null,           // 自動抽出は基本「警告のみ」（誤適用を避ける）
    reason: `ユーザー指摘で禁止（${sourceArticle || 'review'} ${now.slice(0, 10)}${isWildcard ? '、ワイルドカード化' : ''}）`,
    appliesTo: ['body'],
    addedAt: now,
    sourceArticle,
    autoExtracted: true,
  };
}

// 正規表現メタ文字 escape
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ◯〇○XxⅩ などのワイルドカード文字を \d+ に置換し、他はメタ escape
function wildcardize(s) {
  // まず一旦すべてメタ escape
  let out = escapeRegex(s);
  // 連続する [◯〇○XxⅩ] を \d+ に
  out = out.replace(/[◯〇○XxⅩ]+/g, '\\d+');
  return out;
}

// ── 重複排除付きマージ ─────────────────────────────────────────
// 既存 entries と 追加候補 を pattern ベースでマージ（重複は無視）
function mergeEntries(existing, additions) {
  const seen = new Set(existing.map(e => e.pattern));
  const out = [...existing];
  for (const a of additions) {
    if (seen.has(a.pattern)) continue;
    seen.add(a.pattern);
    out.push(a);
  }
  return out;
}

module.exports = {
  loadBannedPhrases,
  saveBannedPhrases,
  getPhrasesForScope,
  applyBannedPhrasesToBody,
  detectBannedInBody,
  formatForPrompt,
  extractBannedFromComment,
  mergeEntries,
  escapeRegex,
  wildcardize,
};
