'use strict';

const { checkBodyLength } = require('./article-length');
const { findUnappliedRules, detectRulesFromBody } = require('./article-prompt-static');
const { findUnappliedReferencePages, findReferencePagesFromBody } = require('./nta-reference-pages');
const { checkCitations } = require('./nta-tsutatsu');
const lawSources = require('./law-sources');
const banned = require('./banned-phrases');
const partial = require('./partial-revise');

// 空行で段落・見出し・表・箇条書きの塊を分ける。コードフェンス内は分割しない。
function splitParagraphs(body) {
  const parts = [];
  let start = 0, fence = null;
  const lines = body.match(/[^\n]*(?:\n|$)/g) || [];
  let offset = 0;
  for (const line of lines) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (mark) {
      if (!fence) fence = mark[1][0];
      else if (mark[1][0] === fence) fence = null;
    }
    if (!fence && !line.trim()) {
      if (offset > start) parts.push({ start, end: offset, text: body.slice(start, offset) });
      start = offset + line.length;
    }
    offset += line.length;
  }
  if (start < body.length) parts.push({ start, end: body.length, text: body.slice(start) });
  return parts.map((p, i) => ({ ...p, id: i + 1 }));
}

const numbers = text => text.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) || [];
function noNewNumbers(before, after) {
  const counts = new Map();
  for (const n of numbers(before)) counts.set(n, (counts.get(n) || 0) + 1);
  return numbers(after).every(n => {
    const left = counts.get(n) || 0;
    counts.set(n, left - 1);
    return left > 0;
  });
}

function protectedParagraph(text, cta = '') {
  return /^\s*(?:#{1,6}\s|```|~~~)/m.test(text) || text.includes('|')
    || /出典|引用元|参考資料|免責|個別事情|専門家にご相談|実際の税務処理|お問い合わせ|お問合せ|お気軽に|ご相談ください|https?:\/\/|\]\(/.test(text)
    || Boolean(cta && text.includes(cta));
}

function validateBodyPatch(before, after, { topic, articleType, intentType, cta = '' }) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const subset = (oldItems, newItems) => {
    const counts = new Map();
    oldItems.forEach(item => counts.set(item, (counts.get(item) || 0) + 1));
    return newItems.every(item => {
      const left = counts.get(item) || 0;
      counts.set(item, left - 1);
      return left > 0;
    });
  };
  const keys = items => items.map(r => r.key);
  const length = checkBodyLength(after, articleType, intentType);
  if (length.tooLong || (length.tooShort && !checkBodyLength(before, articleType, intentType).tooShort)) return false;
  if (!same(before.match(/^## .+$/gm) || [], after.match(/^## .+$/gm) || [])) return false;
  if (splitParagraphs(before).some(p => protectedParagraph(p.text, cta) && !after.includes(p.text))) return false;
  if (partial.findInternalProcessWords(after).contaminated) return false;
  return subset(checkCitations(before).unknown.map(c => c.matched), checkCitations(after).unknown.map(c => c.matched))
    && subset(lawSources.findLawCitations(before).filter(c => !c.found).map(c => c.matched), lawSources.findLawCitations(after).filter(c => !c.found).map(c => c.matched))
    && subset(banned.detectBannedInBody(before).map(h => h.match), banned.detectBannedInBody(after).map(h => h.match))
    && subset(keys(findUnappliedRules(topic, before)), keys(findUnappliedRules(topic, after)))
    && subset(keys(findUnappliedReferencePages(topic, before)), keys(findUnappliedReferencePages(topic, after)));
}

function applyEdits(body, units, answer, options, allowDelete) {
  if (!answer || !Array.isArray(answer.replacements) || (allowDelete && !Array.isArray(answer.delete))
    || (!allowDelete && answer.delete !== undefined)) return null;
  const byId = new Map(units.map(p => [p.id, p]));
  const edits = new Map();
  const add = (id, text) => {
    const original = byId.get(id);
    if (!Number.isInteger(id) || !original || edits.has(id) || typeof text !== 'string') throw new Error('不正な部分修正');
    if (protectedParagraph(original.text, options.cta) || !noNewNumbers(original.text, text)) throw new Error('保護対象の変更');
    // 部分修正に見せかけた節の追加や全文出力も拒否する。
    if (/^\s*#{1,6}\s/m.test(text) || /\n\s*\n/.test(text)) throw new Error('段落以外の出力');
    edits.set(id, text && original.text.endsWith('\n') && !text.endsWith('\n') ? text + '\n' : text);
  };
  try {
    for (const id of answer.delete || []) add(id, '');
    for (const item of answer.replacements) add(item.id, item.text);
    let result = body;
    for (const [id, replacement] of [...edits].sort((a, b) => byId.get(b[0]).start - byId.get(a[0]).start)) {
      const p = byId.get(id);
      result = result.slice(0, p.start) + replacement + result.slice(p.end);
    }
    return edits.size && result !== body && validateBodyPatch(body, result, options) ? result : null;
  } catch (_) { return null; }
}

const PATCH_SYSTEM = 'あなたは税務記事の編集者です。指定された番号の部分修正だけをJSONで返してください。全文・説明は返さないでください。見出し・表の列・免責文・CTA・出典の記載を削除変更しない。数字（金額・割合・期限・条番号）を書き換えない。削除は文ごとに行い、新しい事実を足さない。';
async function shortenBody(body, options) {
  const { generateSimple = require('./content-model').generateSimple } = options;
  const units = splitParagraphs(body);
  const max = checkBodyLength(body, options.articleType, options.intentType).max;
  try {
    const result = await generateSimple({ system: PATCH_SYSTEM, user: [
      `本文は${body.trim().length}文字。目標${Math.floor(max * 0.95)}文字以下。超えた分だけ短くする。`,
      '形式: {"delete":[段落番号],"replacements":[{"id":段落番号,"text":"短くした文"}]}',
      ...units.map(p => `[${p.id}]${protectedParagraph(p.text, options.cta) ? '（変更禁止）' : ''}\n${p.text}`),
    ].join('\n\n') }, { maxTokens: 2000 });
    return applyEdits(body, units, JSON.parse(result.text), options, true);
  } catch (_) { return null; }
}

// 文を位置情報つきで保持し、該当文とその前後一文以外はモデルに渡さない。
function targetedSentences(body, topic, rules, refs, cta) {
  const sentences = [];
  for (const paragraph of splitParagraphs(body)) {
    if (protectedParagraph(paragraph.text, cta)) continue;
    const re = /[^。！？\n]+[。！？]?/g;
    let m;
    while ((m = re.exec(paragraph.text))) {
      sentences.push({ id: sentences.length + 1, start: paragraph.start + m.index,
        end: paragraph.start + m.index + m[0].length, text: m[0], paragraph: paragraph.id });
    }
  }
  const wanted = new Set([...rules, ...refs].map(r => r.key));
  const selected = new Set();
  sentences.forEach((sentence, i) => {
    const hits = [...detectRulesFromBody(topic, sentence.text), ...findReferencePagesFromBody(topic, sentence.text)];
    if (!hits.some(r => wanted.has(r.key))) return;
    for (const j of [i - 1, i, i + 1]) {
      if (sentences[j]) selected.add(j);
    }
  });
  return sentences.filter((_, i) => selected.has(i));
}

async function postfixRules(body, options) {
  const rules = findUnappliedRules(options.topic, body);
  const refs = findUnappliedReferencePages(options.topic, body);
  const names = [...rules, ...refs].map(r => r.key);
  if (!names.length) return { body, applied: false };
  const failure = { body, applied: false, failed: true, names: names.join(', ') };
  if (process.env.RULE_POSTFIX === 'off') return failure;
  const units = targetedSentences(body, options.topic, rules, refs, options.cta);
  if (!units.length) return failure;
  try {
    const generate = options.generateSimple || require('./content-model').generateSimple;
    const result = await generate({ system: PATCH_SYSTEM,
      user: ['該当文だけを直す。形式: {"replacements":[{"id":文番号,"text":"置き換える文"}]}',
        ...rules.map(r => r.text), require('./nta-reference-pages').formatReferencePages(refs),
        ...units.map(p => `[${p.id}] ${p.text}`)].join('\n\n') }, { maxTokens: 2000 });
    const revised = applyEdits(body, units, JSON.parse(result.text), options, false);
    return revised ? { body: revised, applied: true, names: names.join(', ') } : failure;
  } catch (_) { return failure; }
}

module.exports = { shortenBody, postfixRules, splitParagraphs, targetedSentences, validateBodyPatch, noNewNumbers };
