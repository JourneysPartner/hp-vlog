'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { deflateRawSync, inflateRawSync } = require('zlib');
const matter = require('gray-matter');
const contentModel = require('./content-model');
const partial = require('./partial-revise');
const { searchEvidence } = require('./fact-evidence');
const { writerMaterials, materialFingerprint, searchWriterEvidence, resolveMaterial, materialId, resolveWriterMaterials } = require('./writer-materials');
const { positiveLimit } = require('./source-excerpt');
const { LAW_SCOPE_RULE } = require('./grounding-rules');
const { tokenizeForMatcher } = require('./nta-source-matcher');
const { splitUnits, renderUnits, rangeText, unitNumber, basisRanges } = require('./fact-units');
const { buildPages, pageGroups } = require('./fact-pages');
const TYPES = ['金額', '期限', '割合', '適用年', '番号', '要件', '判定', '手続'];
// 歯止めの延期は段A/Bの内部だけで許可し、通常の呼び出しから無効化させない。
const STAGE_TALLY = Symbol('段A/Bの採用した答え');
const JUDGE_RETRIED = Symbol('判定の聞き直し済み');
const REPAIR_RETRIED = Symbol('修正の直し済み');
const CONFIRM_KEEP = Symbol('確かめで正しい主張の数字を保全');
const CALCULATION_NUMBERS = Symbol('検算を通った数字');
const GATEWAY_FALLBACK = Symbol('Gatewayからのやり直し済み');
const EXTRACT_RETRIED = Symbol('抜き出し直し済み');
// 指定された言い換えだけを受け付け、説明付きの名前などへは広げない。
const TYPE_ALIASES = new Map([
  ...['対象・条件', '対象', '条件', '対象者', '要件・条件'].map(label => [label, '要件']),
  ['保存期間', '期限'],
  ...['届出', '申請', '選択', '届出・申請・選択'].map(label => [label, '手続']),
  ...['条文', '通達', 'タックスアンサー', '条文・通達・タックスアンサー'].map(label => [label, '番号']),
  ['税率', '割合'],
]);
const NUMERIC_TYPES = new Set(['金額', '割合', '期限', '適用年', '番号']);
const REVIEW_TYPES = new Set(['要件', '判定', '手続']);
const STATUSES = ['裏付けあり', '食い違い', '資料なし', '期限の書き漏れ'];
const ROOT = path.join(__dirname, '..', '..');
const WARNING_RE = /【事実の照合】[\s\S]*?【\/事実の照合】/g;

function config(options = {}) {
  const provider = options.provider || process.env.FACT_CHECK_PROVIDER || 'anthropic';
  const model = options.model || process.env.FACT_CHECK_MODEL || 'claude-opus-5-5';
  const effort = (options.effort ?? process.env.FACT_CHECK_EFFORT) || null;
  const extractEffort = (options.extractEffort ?? process.env.FACT_CHECK_EXTRACT_EFFORT) || effort;
  const poll = options.batchPollSeconds ?? process.env.FACT_CHECK_BATCH_POLL_SECONDS;
  return { provider, model, extractModel: options.extractModel || process.env.FACT_CHECK_EXTRACT_MODEL || model, effort, extractEffort,
    modelOptions: effort === null ? {} : { output_config: { effort } },
    extractModelOptions: extractEffort === null ? {} : { output_config: { effort: extractEffort } },
    batch: provider === 'anthropic' && (options.batch ?? (process.env.FACT_CHECK_BATCH === 'true')) === true,
    batchMaxWaitMs: Math.min(180, positiveLimit(options.batchMaxWaitMinutes ?? process.env.FACT_CHECK_BATCH_MAX_WAIT_MINUTES, 60)) * 60000,
    batchPollMs: (poll !== undefined && poll !== '' && Number.isFinite(Number(poll)) ? Math.max(5, Number(poll)) : 30) * 1000,
    enabled: options.enabled ?? (process.env.FACT_CHECK_ENABLED !== 'false'),
    failOpen: options.failOpen ?? (process.env.FACT_CHECK_FAIL_OPEN === 'true'),
    maxClaims: positiveLimit(options.maxClaims ?? process.env.FACT_CHECK_MAX_CLAIMS, writerMaterials(options).length ? 80 : 40),
    maxNumericClaims: positiveLimit(options.maxNumericClaims ?? process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS, 120),
    timeoutMs: provider === 'gateway' ? Math.min(900000, positiveLimit(options.timeoutMs ?? process.env.FACT_CHECK_TIMEOUT_MS, 600000))
      : positiveLimit(options.timeoutMs ?? process.env.FACT_CHECK_TIMEOUT_MS, 600000) };
}

function normalizeBody(body) {
  return String(body).replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').trimEnd();
}
function bodyHash(body) { return createHash('sha256').update(normalizeBody(body)).digest('hex'); }

/** 原文は表に一度だけ保存し、判定と修正からはIDで参照する。 */
function compactRecord(record) {
  const evidence = {};
  const compact = rows => (rows || []).map(({ evidence: refs, ...row }) => {
    const ids = (refs || []).map(ref => {
      let id = ref.id;
      if (evidence[id] && JSON.stringify(evidence[id]) !== JSON.stringify(ref)) id += ':' + bodyHash(JSON.stringify(ref)).slice(0, 16);
      evidence[id] = { ...ref };
      return id;
    });
    return { ...row, evidence_ids: ids };
  });
  const result = { ...record };
  for (const key of ['claims', 'rechecked', 'corrections', 'remaining', 'review_items']) result[key] = compact(record[key]);
  // 日本語2000文字×120件は表だけでも600KBを超える。長い原文は可逆圧縮で保持する。
  for (const ref of Object.values(evidence)) if (Buffer.byteLength(ref.text || '') > 2500) {
    ref.text_deflate_base64 = deflateRawSync(Buffer.from(ref.text)).toString('base64');
    delete ref.text;
  }
  return { ...result, evidence };
}

function evidenceRefs(record, row) {
  return (row.evidence || (row.evidence_ids || []).map(id => record.evidence?.[id]).filter(Boolean)).map(ref =>
    ref.text_deflate_base64 ? { ...ref, text: inflateRawSync(Buffer.from(ref.text_deflate_base64, 'base64'), { maxOutputLength: 2000000 }).toString('utf8') } : ref);
}

/** 再照合を優先し、修正済みや重複を除いて候補外資料の採用を表示する。承認の判定には使わない。 */
function outsideCandidateClaims(record) {
  const resolved = new Set((record.corrections || []).filter(c => c.resolved).map(c => c.id));
  const rewritten = new Set((record.corrections || []).filter(c => typeof c.before === 'string' && typeof c.after === 'string' && c.after).map(c => c.before));
  const rows = [...(record.claims || []).filter(c => c && !resolved.has(c.id) && !rewritten.has(c.sentence)), ...(record.rechecked || [])];
  return [...new Map(rows.filter(Boolean).map(c => [claimKey(c), c])).values()]
    .filter(c => c.status === '裏付けあり' && c.evidence_outside_candidates === true);
}

function normalizedClaim(text) {
  return normalizedQuote(String(text).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''));
}

function actualSentence(body, sentence) {
  if (body.includes(sentence)) return sentence;
  const needle = normalizedClaim(sentence);
  if (!needle) return '';
  // 記号を除いた一致から原文へ戻す。保存・修正にはMarkdownの原文を使う。
  return sentenceRows(body).map(s => s.trim()).find(s => normalizedClaim(s) === needle) || '';
}

function normalizedRatio(numerator, denominator, { negative = false, percentage = false } = {}) {
  const parse = value => {
    const parts = value.match(/[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[〇零一二三四五六七八九]+|[十百千万億]/g) || [];
    const precision = Math.max(0, ...parts.map(c => (c.split('.')[1] || '').length));
    const scale = 10n ** BigInt(precision);
    const digits = '〇一二三四五六七八九';
    let total = 0n, section = 0n, num = 0n, hasNumber = false, hasSection = false;
    for (const c of parts) {
      const unit = { 十: 10n, 百: 100n, 千: 1000n, 万: 10000n, 億: 100000000n }[c];
      if (!unit) {
        const [integer, decimal = ''] = /[0-9]/.test(c) ? c.replace(/,/g, '').split('.')
          : [[...c].map(d => d === '零' ? 0 : digits.indexOf(d)).join('')];
        num = BigInt(integer + decimal.padEnd(precision, '0'));
        hasNumber = true;
      } else if (unit < 10000n) {
        section += (hasNumber ? num : scale) * unit;
        num = 0n; hasNumber = false; hasSection = true;
      } else {
        total += (hasNumber || hasSection ? section + num : scale) * unit;
        section = num = 0n; hasNumber = hasSection = false;
      }
    }
    return { number: total + section + num, scale };
  };
  // 浮動小数点へ丸めず、百分率と分数を約分した同じ割合へ揃える。
  const n = parse(numerator), d = parse(denominator);
  if (!d.number) return null;
  const top = n.number * d.scale * (negative ? -1n : 1n);
  const bottom = d.number * n.scale * (percentage ? 100n : 1n);
  let a = top < 0n ? -top : top, b = bottom;
  while (b) [a, b] = [b, a % b];
  return `割合:${top / a}/${bottom / a}`;
}

function normalizedNumbers(text, range, forms) {
  const normalized = normalizedQuote(text).replace(/(令和|平成|昭和)元年/g, '$11年');
  const numbers = [];
  const add = (number, start, end) => {
    numbers.push(number);
    if (forms) forms.push({ number, start, end });
  };
  const digits = '[0-9〇零一二三四五六七八九十百千]+';
  const dates = `(?<!分の)(?<![0-9〇零一二三四五六七八九十百千万億.,])(?:(?:(令和|平成|昭和|大正|明治)(元|${digits})年(?!間)|([0-9]{4})年(?!間))(?:(${digits})月(?:(${digits})日)?)?|(${digits})月(${digits})日)`;
  const tokens = new RegExp(`${dates}|[0-9〇零一二三四五六七八九十百千万億]+(?:,[0-9]{3})*(?:\\.[0-9]+)?(?:[万億][0-9〇零一二三四五六七八九十百千万億]*(?:,[0-9]{3})*(?:\\.[0-9]+)?)*`, 'g');
  const matches = [...normalized.matchAll(tokens)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match[1] || match[3] || match[6]) {
      if (range && (match.index < range[0] || match.index + match[0].length > range[1])) continue;
      // 日付は年・月・日を分けずに照合し、和暦と西暦は換算しない。
      const read = value => value === '元' ? '1' : normalizedNumbers(`第${value}`)[0];
      const year = match[1] ? match[1] + read(match[2]) : match[3] || '';
      const month = match[4] || match[6], day = match[5] || match[7];
      add(`日付:${year}${month ? '-' + read(month) : ''}${day ? '-' + read(day) : ''}`, match.index, match.index + match[0].length);
      continue;
    }
    const value = match[0];
    const prefix = normalized.slice(0, match.index);
    const suffix = normalized.slice(match.index + value.length);
    // 範囲の端で切れた日付・金額・割合の断片を、別の数として採用しない。
    const next = matches[i + 1];
    const fraction = suffix.startsWith('分の');
    // 「年数四年」などの名詞は読む。「数十」「十数」の概数は分数の分子も含めて除外する。
    if (/(?:^|[^\p{Script=Han}]|[十百千])数$/u.test(prefix) && !/[0-9]/.test(value)) {
      if (fraction && next && next.index === match.index + value.length + 2) i++;
      continue;
    }
    const nextSuffix = next ? normalized.slice(next.index + next[0].length) : '';
    const percent = suffix.match(/^(?:%|パーセント)/)?.[0] || '';
    const nextPercent = nextSuffix.match(/^(?:%|パーセント)/)?.[0] || '';
    // 中黒の列挙は最後の「割」を共有する。読点の列挙には広げない。
    const wariTail = suffix.match(new RegExp(`^(?:・${digits})*割(?!合)(?:(${digits})分)?`));
    const wari = wariTail;
    const directWari = wari && suffix.startsWith('割');
    const bu = directWari && wariTail[1];
    const unit = suffix.match(/^(?:円|年|月|日|歳|人|件|か月|ヶ月|カ月|ケ月|箇月)/)?.[0] || '';
    const end = fraction && next ? next.index + next[0].length + nextPercent.length
      : match.index + value.length + (wari ? wariTail[0].length : percent.length || unit.length);
    if (range && (match.index < range[0] || end > range[1])) {
      if (fraction && next && next.index === match.index + value.length + 2) i++;
      if (bu) i++;
      continue;
    }
    // 「一定」「一般」などの漢数字は、数を示す文脈が無ければ読まない。
    if (!wari && !/[0-9]/.test(value) && !/(?:令和|平成|昭和|第|分の)$/.test(prefix) &&
      !/^(?:年|月|日|円|万|億|%|パーセント|割|分|歳|人|件|か月|ヶ月|カ月|ケ月|箇月)/.test(suffix)) continue;
    if (wari) {
      if (/[.,]$/.test(prefix)) return [null];
      const negative = /[-−]$/.test(prefix);
      const ratio = normalizedRatio(value, '10');
      if (bu) {
        const n = BigInt(ratio.split(':')[1].split('/')[0]), d = BigInt(ratio.split('/')[1]);
        const b = normalizedRatio(bu, '100').split(':')[1].split('/').map(BigInt);
        add(normalizedRatio(String(n * b[1] + b[0] * d), String(d * b[1]), { negative }), match.index - Number(negative), end);
        i++;
      } else add(negative ? normalizedRatio(value, '10', { negative }) : ratio, match.index - Number(negative), end);
      continue;
    }
    if (fraction || percent) {
      // 不完全な分数や数の断片は数字なしへ戻さず、照合不能として残す。
      if (/[.,]$/.test(prefix) || (fraction && (!next || next.index !== match.index + value.length + 2 ||
        (next[0] === '一' && /^(?:定|般)/.test(nextSuffix))))) return [null];
      const ratio = normalizedRatio(fraction ? next[0] : value, fraction ? value : '100', {
        negative: /[-−]$/.test(prefix),
        percentage: fraction && Boolean(nextPercent),
      });
      if (ratio === null) return [null];
      add(ratio, match.index - Number(/[-−]$/.test(prefix)), end);
      if (fraction) i++;
      continue;
    }
    const digitChars = '〇一二三四五六七八九';
    let total = 0, section = 0, num = 0, hasNumber = false, hasSection = false;
    // アラビア数字・漢数字と万・億をまとめ、同じ金額を一つの数にする。
    for (const c of value.match(/[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[〇零一二三四五六七八九]+|[十百千万億]/g) || []) {
      const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000, 億: 100000000 }[c];
      if (!unit) {
        num = /[0-9]/.test(c) ? Number(c.replace(/,/g, '')) : Number([...c].map(d => d === '零' ? 0 : digitChars.indexOf(d)).join(''));
        hasNumber = true;
      } else if (unit < 10000) {
        section += (hasNumber ? num : 1) * unit;
        num = 0; hasNumber = false; hasSection = true;
      } else {
        total += (hasNumber || hasSection ? section + num : 1) * unit;
        section = num = 0; hasNumber = hasSection = false;
      }
    }
    const number = total + section + num;
    // 桁数が大きく正確に揃えられない数は、丸めて一致させない。
    add(Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? String(number) : value, match.index, end);
  }
  return numbers;
}

function sufficientQuote(claim, result, ref, status) {
  const parts = quoteParts(result?.quote).map(normalizedQuote);
  if (!parts.length || parts.length > 2 || !ref || parts.some(p => !p)) return false;
  const wholeSentence = evidenceTexts(ref).some(text => sentenceRows(text).some(s => parts.includes(normalizedQuote(s.trim())) && /。$/.test(s.trim()) && s.trim() !== '。'));
  if (parts.join('').length < 15 && !wholeSentence) return false;
  if (['期限', '金額', '割合', '適用年'].includes(claim.type)) {
    claim = numberCheckClaim(claim, ref);
    let numbers = normalizedNumbers(status === '裏付けあり' ? claim.claim : numberCheckText(result.correct, ref));
    if (status === '裏付けあり') {
      const sentenceNumbers = normalizedNumbers(claim.sentence);
      // 要約だけで数字が書き換わった主張を通さず、要約に数字が無ければ原文を照合する。
      if (!numbersInSentence(numbers, claim.sentence)) return false;
      if (!numbers.length) numbers = sentenceNumbers;
    }
    if (numbers.includes(null)) return false;
    if (result[CALCULATION_NUMBERS]) {
      const remaining=numbers.filter(n=>!result[CALCULATION_NUMBERS].has(n));
      if(numbers.length&&!remaining.length)return true;
      numbers=remaining;
    }
    if (!numbers.length) return status !== '裏付けあり' || !isNumericClaim(claim);
    // 不正な割合による照合不能は、従来どおり採用した原文全体で止める。
    if (evidenceTexts(ref).some(text => normalizedNumbers(text).includes(null))) return false;
    // 空白・文字幅を揃えた引用位置を原文へ戻し、同じ抜粋の前後300文字だけを使う。
    if (!quoteSupportsNumbers(numbers, result, ref)) return false;
  }
  return true;
}

/** 数字の照合範囲は、原文の引用位置の前後300字に限定する。 */
function quoteSupportsNumbers(numbers, result, ref) {
  if (!numbers.length || numbers.includes(null)) return false;
  const parts = quoteParts(result.quote).map(normalizedQuote);
  if (!parts.length || !ref) return false;
  const supports = parts.map(() => []);
  for (const [partIndex, quote] of parts.entries()) for (const text of evidenceTexts(ref)) {
    let normalized = '';
    const positions = [];
    for (const match of text.matchAll(/[｡-ﾟ][ﾞﾟ]?|[\s\S]/gu)) {
      const part = normalizedQuote(match[0]);
      normalized += part;
      for (let i = 0; i < part.length; i++) positions.push([match.index, match.index + match[0].length]);
    }
    for (let at = normalized.indexOf(quote); at >= 0; at = normalized.indexOf(quote, at + 1)) {
      const start = Math.max(0, positions[at][0] - 300);
      const end = positions[at + quote.length - 1][1] + 300;
      const from = positions.findIndex(([begin]) => begin >= start);
      let to = positions.length;
      while (to > 0 && positions[to - 1][1] > end) to--;
      const quoted = normalizedNumbers(normalized, [from, to]);
      if (quoted.includes(null)) continue;
      // 年だけの例外は引用そのものだけ。基準日の年は裏付けに使わない。
      const dates = normalizedNumbers(withoutAsOfDates(quote));
      supports[partIndex].push(new Set(numbers.filter(n => quoted.includes(n) || (typeof n === 'string' && /^日付:[^-]+$/.test(n) && dates.some(d => d?.startsWith(n + '-'))))));
    }
  }
  // 同じ引用が何度も現れても、別々の出現位置の近傍を一つの引用の裏付けに混ぜない。
  const covers = sets => numbers.every(n => sets.some(s => s.has(n)));
  return parts.length === 1 ? supports[0].some(s => covers([s]))
    : parts.length === 2 && supports[0].some(a => supports[1].some(b => covers([a, b])));
}

function quoteParts(quote) { return typeof quote === 'string' && quote ? quote.split('\n…\n') : []; }
function quoteExists(quote, ref) {
  const parts = quoteParts(quote);
  return parts.length > 0 && parts.length <= 2 && parts.every(part => normalizedQuote(part) && evidenceTexts(ref).some(text => normalizedQuote(text).includes(normalizedQuote(part))));
}

// 型だけで数字の事実にしない。読めない数や漢数字の条文・通達番号は止める側に残す。
function isNumericClaim(c) {
  return NUMERIC_TYPES.has(c.type) && (normalizedNumbers(c.sentence).length > 0 ||
    /No\.|(?:第)?[〇零一二三四五六七八九十百千万億]+条|[〇零一二三四五六七八九十百千万億]+[-−][〇零一二三四五六七八九十百千万億]+/i.test(normalizedQuote(c.sentence)));
}

function evidenceTexts(ref) {
  return ref.text_ranges ? ref.text_ranges.map(([start, end]) => ref.text.slice(start, end)) : [ref.text];
}

function parseJson(value) {
  if (Array.isArray(value)) return value;
  const text = String(typeof value === 'string' ? value : value?.text || '').trim();
  const start = text.indexOf('[');
  if (start < 0) return JSON.parse(text);
  // 文字列内の角括弧やエスケープを数えず、最初の配列の対応する終端まで読む。
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return JSON.parse(text.slice(start));
}

function normalizedQuote(text) {
  // 互換文字（①→1等）は別の意味を持つため、文字幅と空白だけを揃える。
  return String(text || '').replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[｡-ﾟ]+/g, s => s.normalize('NFKC')).replace(/\s+/g, '');
}

// 数字の確認だけで、根拠自身のタックスアンサー番号を除く。番号の主張は従来どおり。
function ownTaxAnswerCitations(text, ref) {
  if (ref?.kind !== 'taxanswer' || !/^\d{4}$/.test(String(ref.no))) return [];
  return [...text.matchAll(/(?:No\.?|タックスアンサー(?:No\.?)?|TA)(\d{4})(?!\d)/gi)].filter(m => m[1] === String(ref.no));
}
function numberCheckText(text, ref) {
  let normalized = normalizedQuote(text);
  for (const m of ownTaxAnswerCitations(normalized, ref).reverse()) normalized = normalized.slice(0, m.index) + normalized.slice(m.index + m[0].length);
  return normalized;
}
function numberCheckClaim(claim, ref) {
  return claim.type === '番号' ? claim : { ...claim, claim: numberCheckText(claim.claim, ref), sentence: numberCheckText(claim.sentence, ref) };
}
function withoutAsOfDates(text) {
  const digits = '[0-9〇零一二三四五六七八九十百千]+';
  return text.replace(new RegExp(`(?:(?:令和|平成|昭和|大正|明治)(?:元|${digits})|[0-9]{4})年(?:${digits}月(?:${digits}日)?)?現在(?:法令等)?`, 'g'), '');
}

/** 年だけの日付は同じ文の同じ元号・年の年月日だけで補い、基準日からは補わない。 */
function numbersInSentence(numbers, sentence) {
  const present = normalizedNumbers(sentence);
  const dates = normalizedNumbers(withoutAsOfDates(normalizedQuote(sentence)));
  return numbers.every(n => present.includes(n) || (typeof n === 'string' && /^日付:[^-]+$/.test(n) && dates.some(d => d?.startsWith(n + '-'))));
}

/** 年だけの要約を同じ文の具体的な日付へ広げ、保持・除去する数字と本文の表記を対応付ける。 */
function expandYearDates(numbers, sentence) {
  const dates = normalizedNumbers(withoutAsOfDates(normalizedQuote(sentence)));
  return [...new Set(numbers.flatMap(n => typeof n === 'string' && /^日付:[^-]+$/.test(n)
    ? [n, ...dates.filter(d => d?.startsWith(n + '-'))] : [n]))];
}

// 元の表記と位置を保持する。数字の読み方自体は normalizedNumbers に共通化する。
function supportedNumberForms(text, ref, supported) {
  const positions = [];
  let normalized = '';
  for (const m of text.matchAll(/[｡-ﾟ][ﾞﾟ]?|[\s\S]/gu)) {
    const part = normalizedQuote(m[0]);
    normalized += part;
    for (let i = 0; i < part.length; i++) positions.push([m.index, m.index + m[0].length]);
  }
  const forms = [], citations = ownTaxAnswerCitations(normalized, ref);
  normalizedNumbers(normalized, undefined, forms);
  const expanded = expandYearDates(supported, text);
  return [...new Set(forms.filter(f => expanded.includes(f.number) &&
    !citations.some(m => f.start >= m.index && f.end <= m.index + m[0].length)).map(f =>
    text.slice(positions[f.start][0], positions[f.end - 1][1])).filter(form => {
      const numbers = normalizedNumbers(form);
      return numbers.length && numbers.every(n => expanded.includes(n));
    }))];
}

function partialQuoteNumbers(claim, grounded, ref) {
  const checked = numberCheckClaim(claim, ref);
  const summary = normalizedNumbers(checked.claim);
  const sentence = normalizedNumbers(checked.sentence);
  if (!numbersInSentence(summary, checked.sentence) || evidenceTexts(ref).some(text => normalizedNumbers(text).includes(null))) return null;
  const numbers = summary.length ? summary : sentence;
  if (!numbers.length || numbers.includes(null)) return null;
  const supported = numbers.filter(n => quoteSupportsNumbers([n], grounded, ref));
  const missing = numbers.filter(n => !supported.includes(n));
  if (!supported.length || !missing.length) return null;
  return { forms: supportedNumberForms(claim.sentence, ref, supported) };
}

function isScenarioAmount(c) {
  return c.type === '金額' && /想定|設例/.test(`${c.heading} ${c.sentence}`) &&
    !/控除|税額|上限|限度|非課税|基礎|税率|制度/.test(c.sentence);
}

async function extractClaims(body, callLLM, options = {}) {
  const units = splitUnits(body);
  if (!units.length) return { claims: [], dropped: 0, discarded: 0, droppedClaims: [], discardedClaims: [] };
  const enhanced = writerRefs(options).length > 0;
  const read = async rows => {
    const request = { task: 'extract', maxTokens: 8000,
    system: '記事本文から税務の事実を述べた文を漏れなく抜き出してください。出力は JSON 配列だけです。要件・金額・割合・期限・適用年・手続・番号・判定を対象にします。type は次の8語のどれか1語をそのまま書いてください: 要件・金額・割合・期限・適用年・手続・番号・判定。要件は対象・条件、期限は保存期間を含む、手続は届出・申請・選択、番号は条文・通達・タックスアンサーのことです。s は主張を述べた本文の文の番号、subject は制度名・論点名（かっこの補足を付けない）、claim は主張の1文要約です。claim は60文字以内にしてください。想定と明示された設例の金額は対象外です。ただし設例中でも税率・控除額など制度の数値は対象です。制度を説明する文には、期限を書いていなくても要件や判定の主張を作り、期限の書き漏れを判定できるようにしてください。番号だけの引用も対象です。形は [{s,type,subject,claim}] です。',
    user: renderUnits(rows),
    };
    if (enhanced) request.system += '\n' + CALCULATED_CLAIM_RULE + '\n' + MISCONCEPTION_EXTRACT_RULE;
    return parseJson(await callLLM(request));
  };
  let data;
  try { data = await read(units); }
  catch (error) {
    if (!(error instanceof SyntaxError) || options[EXTRACT_RETRIED]) throw error;
    const boundaries = units.filter(u => u.heading && u.start > 0).map(u => u.start);
    if (!boundaries.length) throw error;
    const at = boundaries.reduce((best, next) => Math.abs(next - body.length / 2) < Math.abs(best - body.length / 2) ? next : best);
    data = [];
    let retryError;
    // 各半分を一度だけ再抽出する。片方の失敗を隠して部分的な結果を通さない。
    for (const rowsHalf of [units.filter(u => u.start < at), units.filter(u => u.start >= at)]) {
      try {
        const rows = await read(rowsHalf);
        if (!Array.isArray(rows)) throw new Error('主張一覧が不正です');
        data.push(...rows);
      } catch (err) { retryError ||= err; }
    }
    if (retryError) throw retryError;
  }
  if (!Array.isArray(data)) throw new Error('主張一覧が不正です');
  const seen = new Set();
  const discardedClaims = [];
  const valid = [];
  let calculatedSkipped = 0;
  const fields = c => ({ ...Object.fromEntries(['sentence', 'heading', 'type', 'subject', 'claim'].map(key => [key, typeof c?.[key] === 'string' ? c[key] : ''])),
    ...(typeof c?.type_label === 'string' ? { type_label: c.type_label } : {}), ...(Number.isInteger(c?.s) ? { s: c.s } : {}) });
  for (const original of data) {
    const label = typeof original?.type === 'string' ? original.type.trim()
      .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[｡-ﾟ]+/g, text => text.normalize('NFKC')) : '';
    const type = TYPES.includes(label) ? label : TYPE_ALIASES.get(label);
    const c = { ...original, type: type || original?.type };
    // 元の名前は LLM の別フィールドではなく、実際に読み替えた type から記録する。
    delete c.type_label;
    if (type && type !== original.type) c.type_label = original.type;
    const number = unitNumber(c?.s);
    let unit = number ? units[number - 1] || null : null;
    if (unit) {
      const near = units.filter(u => !u.heading && Math.abs(u.s - unit.s) <= 2);
      const numbers = normalizedNumbers(c.claim);
      const contains = u => numbersInSentence(numbers, u.text);
      if (isNumericClaim({ ...c, sentence: c.claim }) && numbers.length) {
        // 読めない割合が同じ原文にある場合は抽出し、後段の歯止めで止める。
        if (unit.heading || !contains(unit)) { const matches = near.filter(contains); unit = matches.length === 1 ? matches[0] : null; }
      } else {
        const words = [...tokenizeForMatcher(c.claim || '')];
        const overlap = u => words.filter(w => normalizedQuote(u.text).toLowerCase().includes(w)).length;
        if (unit.heading || !overlap(unit)) {
          const best = near.filter(contains).map(u => ({ u, score: overlap(u) }))
            .sort((a, b) => b.score - a.score || a.u.s - b.u.s).find(p => p.score);
          unit = best?.u || null;
        }
      }
    }
    const sentence = unit?.text || '';
    const heading = unit ? units.filter(u => u.heading && u.s < unit.s).at(-1)?.text.replace(/^\s*#{1,6}\s+/, '') || '' : '';
    const resolved = { ...c, sentence, heading, s: unit?.s };
    if (unit && isScenarioAmount(resolved)) continue;
    if (unit && enhanced && isCalculatedClaim(resolved)) { calculatedSkipped++; continue; }
    if (!sentence || !TYPES.includes(c.type) || typeof c.subject !== 'string' || !c.subject.trim() || typeof c.claim !== 'string') {
      discardedClaims.push({ ...fields({ ...c, sentence: sentence || (typeof c?.claim === 'string' ? c.claim : '') }), status: sentence ? '主張の形式が不正' : '本文に見つからない' });
      continue;
    }
    const key = claimKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key); valid.push(resolved);
  }
  if (enhanced && !options[EXTRACT_RETRIED]) {
    const targets = [...new Set(discardedClaims.filter(c => c.status === '主張の形式が不正').map(c => c.s))];
    // 同じ文は一度だけ。最大10文ずつ・3回で、失敗分と上限の外は未照合のまま残す。
    for (let i = 0; i < Math.min(targets.length, 30); i += 10) {
      const numbers = new Set(targets.slice(i, i + 10));
      const selected = units.filter(u => !u.heading && numbers.has(u.s));
      if (!selected.length) continue;
      try {
        const retry = await extractClaims(body, async request => {
          const rows = parseJson(await callLLM({ ...request, task: 'retry_extract', immediate: true, user: renderUnits(selected) }));
          if (!Array.isArray(rows)) throw new Error('主張一覧が不正です');
          return rows.filter(c => numbers.has(unitNumber(c?.s)));
        }, { ...options, [EXTRACT_RETRIED]: true });
        const recovered = [...retry.claims, ...retry.droppedClaims].filter(c => numbers.has(c.s));
        for (let j = discardedClaims.length - 1; j >= 0; j--) {
          const c = discardedClaims[j], own = recovered.filter(r => r.s === c.s);
          if (!numbers.has(c.s) || c.status !== '主張の形式が不正' || !own.length) continue;
          const needed = normalizedNumbers(c.claim), found = own.flatMap(r => normalizedNumbers(r.claim));
          // 文全体の数字ではなく、拾い直した要約に実際に含まれる数字だけで回復を確かめる。
          if (!needed.includes(null) && needed.every(n => found.includes(n))) discardedClaims.splice(j, 1);
        }
        calculatedSkipped += retry.calculated_skipped || 0;
        for (const { id, status, ...c } of recovered) if (!seen.has(claimKey(c))) { seen.add(claimKey(c)); valid.push(c); }
      } catch (_) { /* 抜き出し直せない主張は、元の未照合として残す。 */ }
    }
  }
  const max = positiveLimit(options.maxClaims, 40);
  const maxNumeric = positiveLimit(options.maxNumericClaims, 120);
  const numericCount = valid.filter(isNumericClaim).length;
  let numeric = 0, review = 0;
  const chosen = numericCount > maxNumeric || valid.length - numericCount > max
    ? [...valid].sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type)).filter(c => isNumericClaim(c) ? numeric++ < maxNumeric : review++ < max)
    : valid;
  const kept = new Set(chosen);
  const droppedClaims = valid.filter(c => !kept.has(c)).map(c => ({ ...fields(c), status: '上限で未照合' }));
  return { claims: chosen.map((c, i) => ({ id: `c${i + 1}`, ...fields(c) })),
    dropped: droppedClaims.length, discarded: discardedClaims.length, droppedClaims, discardedClaims,
    ...(enhanced ? { calculated_skipped: calculatedSkipped } : {}) };
}

// 同じ文・種類・制度名でも、要約の数字が違えば別の主張（例: 48万円 と 2,400万円）。
// 数字を見ずにまとめると、2 つ目の数字が照合されないまま消えて止まらない。
function claimKey(c) {
  return `${c.sentence}:${c.type}:${c.subject}:${JSON.stringify([...new Set(normalizedNumbers(c.claim).map(String))].sort())}`;
}

// 照合の作り（抜き出しの重複除去・判定の指示文など）を変えたら上げる。版の違う記録は差し戻しで使い回さない。
const LOGIC_VERSION = 'plan2';

// 同じ制度の 2 件目の期限の書き漏れは、根拠を確かめていないので自動で直さず、止めて人が確かめる。
const NO_REPAIR_REASONS = new Set(['同じ制度の期限の書き漏れは記録済み']);

function blockingFinding(c) {
  return c.status !== '裏付けあり' && !(c.status === '資料なし' && (REVIEW_TYPES.has(c.type) || (NUMERIC_TYPES.has(c.type) && !isNumericClaim(c))));
}

// 候補外の兄弟制度から数字や修正内容を持ち込まない。
function canUseOutsideEvidence(claim, status) {
  return status === '裏付けあり' && REVIEW_TYPES.has(claim.type);
}

function writerRefs(options) {
  const ids = writerMaterials(options);
  return ids.length ? options.resolvedWriterMaterials || resolveWriterMaterials(ids) : [];
}

function confirmationEnabled(options) {
  return process.env.FACT_CHECK_CONFIRM === 'true' && writerRefs(options).length > 0;
}

/** 候補外の緩和は、解決できた書き手の資料かつ制度の関連がある原文だけ。 */
function canUseWriterEvidence(claim, status, ref, refs, confirming = false) {
  if (!ref || isNumericClaim(claim) || !['裏付けあり', '食い違い', '期限の書き漏れ'].includes(status)) return false;
  const own = refs.find(e => e.id === ref.id || (materialId(e) && materialId(e) === materialId(ref)));
  if (!own || own.kind === 'change') return false;
  if (confirming) return true; // 書き換えの可否は、提示済み資料を使うOpusの独立した確かめで決める。
  const text = own.kind === 'taxanswer' ? own.text.split('関連リンク')[0] : own.text;
  return [1, 3].includes(require('./article-plan').relevantMaterial(claim.subject, own, text).condition);
}

const CALCULATED_CLAIM_RULE = '「試算」「計算例」と明記した見出し・表・文の中で、資料の数字から計算した結果の金額のうち、要約に計算式（×・÷・＝・=）があるものだけを主張から外す。割合・期限・適用年・番号は外さない。計算に使った制度の数字（税率・控除額・みなし仕入率など）は主張にする。';
const MISCONCEPTION_EXTRACT_RULE = '「よくある誤解」「NG例」「〜と考えるのは誤り」のように、誤りの例として書かれた文は、その文が伝えたい正しい内容（例: 「〜にはならない」）をclaimにする。';
const MISCONCEPTION_CONTEXT_RULE = '記事の文が誤りの例（『よくある誤解』『NG例』『〜と考えるのは誤り』など）として書かれている場合は、その文の主張は「その考えは誤り」である。直前の見出しと前後の文を踏まえて判断する。';
function isCalculatedClaim(c) {
  return c.type === '金額' && /試算|計算例/.test(`${c.heading} ${c.sentence}`) && /[×÷＝=]/.test(c.claim);
}

const CONDITION_SYSTEM = '記事の文が、根拠の文と同じ条件を述べているかを確かめます。記事の文に書かれた条件（誰が・誰に・年齢・続柄・「かつ」と「または」・日付や期限・金額・回数・場所）を1つずつ挙げ、根拠の文での書き方と比べてください。言い換えは一致としてよい。ただし、対象が広がる・狭まる、「かつ」と「または」の取り違え、対象者や条件の追加・欠落、日付・期限・金額の違いは不一致です。根拠の文に書かれていない条件は記載なしです。記事の文が根拠の文の条件の一部だけを書いていて、書いた部分が正しいなら一致です（書いていない条件があるだけでは不一致にしない）。ただし、書いていない条件のせいで記事の文が誤った意味になる場合（例: 「AかつB」が要件なのに「Aなら対象」と書く）は不一致です。不一致のときは correct に、根拠の文に合わせて記事の文を直した文（記事の文と同じ形・長さ）を書いてください。出力はJSONだけ: {"conditions":[{"article":"記事の条件","source":"根拠での書き方","match":"一致|不一致|記載なし"}],"verdict":"一致|不一致|記載なし","correct":"不一致のときだけ"}';

function sentenceContext(body, sentence) {
  const units = splitUnits(body), at = units.findIndex(u => !u.heading && u.text === sentence);
  const previous = units.slice(0, at), next = units.slice(at + 1);
  return { heading: previous.filter(u => u.heading).at(-1)?.text.replace(/^\s*#{1,6}\s+/, '') || '',
    prev: previous.filter(u => !u.heading).at(-1)?.text || '', next: next.find(u => !u.heading)?.text || '' };
}

function normalizedCondition(value) {
  // 小数点・正負の符号は条件の数字の一部なので、句読点として消さない。
  return normalizedClaim(value).replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '')
    .replace(/[、。!?「」『』（）()]/g, '').replace(/(?<!\d)[.,]|[.,](?!\d)/g, '');
}

function substantiveCondition(row) {
  const meaning = value => normalizedCondition(value).replace(/直接|原則|など/g, '');
  if (meaning(row.article) === meaning(row.source)) return false;
  return row.match === '不一致' && /対象|贈与者|受贈者|相続人|法人|個人|事業者|申請者|納税者|従業員|役員|本人|歳|年齢|子|孫|父母|祖父母|配偶者|続柄|直系|卑属|尊属|かつ|または|及び|又は|年|月|日|期限|金額|円|万円|回|場所|居住|住所|住宅|土地|都|道|府|県|市|区|町|村|国内|国外|海外|税務署|以上|以下|未満|超|でき|出来|戻れ|ません|ない|届出|申請|承認|申告者|要件/.test(`${row.article} ${row.source}`);
}

function canFinalizeStageA(claim, candidates) {
  const ref = claim.evidence.find(e => e.id === claim.evidence_id);
  if (!ref) return false;
  if (ref.id === candidates[0]?.id) return true;
  const relevance = e => require('./article-plan').relevantMaterial(claim.subject, e,
    e.kind === 'taxanswer' ? (e.text || '').split('関連リンク')[0] : e.text || '').condition;
  const match = relevance(ref);
  // 一般的な制度名が兄弟ページの題名にも当たる条件3は、一意に結びつく場合だけ採る。
  return match === 1 || (match === 3 && !candidates.some(e => e.id !== ref.id && [1, 3].includes(relevance(e))));
}

function sentenceWords(claim) {
  const subject = tokenizeForMatcher(claim.subject || '');
  return [...tokenizeForMatcher(claim.sentence)].filter(word => !subject.has(word));
}

function unrelatedCorrect(claim, correct) {
  if (onlyNumberChange(claim.sentence, correct)) return false;
  const words = sentenceWords(claim), after = tokenizeForMatcher(correct);
  return words.length > 0 && words.filter(word => after.has(word)).length < words.length * 0.3;
}

// 数字だけの訂正は話題の変更ではない。引用と数字そのものの歯止めは別に掛ける。
function onlyNumberChange(before, after) {
  const mask = s => normalizedCondition(s).replace(/[+-]?\d+(?:\.\d+)?/g, '数');
  return mask(before) === mask(after);
}

async function checkConditions(claims, call, addReviewItem, options, body, stage, evidence) {
  const items = claims.filter(c => c.status === '裏付けあり' && REVIEW_TYPES.has(c.type));
  for (let i = 0; i < items.length; i += 4) await Promise.all(items.slice(i, i + 4).map(async c => {
    try {
      const ret = await call({ task: 'condition_check', immediate: true, maxTokens: 4000,
        system: CONDITION_SYSTEM + '\n「直接」「原則」「など」のような言い回しの有無や、より詳しい書き方への言い換えは一致とする。対象者・年齢・続柄・「かつ」と「または」・日付や期限・金額・回数・場所に加え、肯定と否定・範囲の向き・届出と申請や承認の違い、誤った意味になる要件の欠落も不一致とする。\n' + MISCONCEPTION_CONTEXT_RULE,
        user: JSON.stringify({ article: c.sentence, source: c.quote, ...sentenceContext(body, c.sentence) }) });
      const text = String(typeof ret === 'string' ? ret : ret?.text || '').trim();
      const data = ret?.verdict ? ret : JSON.parse(text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || text);
      if (!['一致', '不一致', '記載なし'].includes(data?.verdict) || !Array.isArray(data.conditions)) throw new Error('条件確認の形が不正');
      c.condition_check = { verdict: data.verdict, conditions: data.conditions.slice(0, 12).map(row => ({
        article: String(row.article || '').slice(0, 160), source: String(row.source || '').slice(0, 160),
        match: ['一致', '不一致', '記載なし'].includes(row.match) ? row.match : '記載なし',
      })) };
      if (data.verdict !== '不一致') return;
      const correct = typeof data.correct === 'string' ? data.correct.trim() : '';
      if (confirmationEnabled(options)) {
        c.status = '食い違い'; c.correct = correct; c.condition_mismatch = true;
        c.glm_answer = { status: '条件の不一致', evidence: c.evidence_id, basis: c.glm_answer?.basis || '', correct: contentModel.redactSecrets(correct) };
        return;
      }
      if (!c.condition_check.conditions.some(substantiveCondition) || normalizedCondition(correct) === normalizedCondition(c.sentence)) {
        addReviewItem({ ...c, status: '条件の違いを要確認' }); return;
      }
      const ref = c.evidence.find(e => e.id === c.evidence_id);
      const numbers = normalizedNumbers(numberCheckText(correct, ref));
      const allowed = (!c.evidence_outside_candidates || canUseWriterEvidence(c, '食い違い', ref, writerRefs(options))) &&
        canFinalizeStageA(c, options.writerCandidates?.get(c.id) || evidence[c.id]);
      if (correct && unrelatedCorrect(c, correct)) { addReviewItem({ ...c, status: '条件の違いを要確認', correct }); return; }
      if (allowed && correct && !numbers.includes(null) && (!numbers.length || quoteSupportsNumbers(numbers, c, ref))) {
        c.status = '食い違い'; c.correct = correct; c.condition_mismatch = true;
      } else addReviewItem({ ...c, status: '条件の違いを要確認' });
    } catch (_) { c.condition_check = { verdict: '確認できません', conditions: [] }; }
  }));
}

/** 修正で変えていない数字だけの新たな資料なしは、その修正の失敗とは数えない。 */
function unchangedNumericClaim(finding, claim, replacement, originals) {
  if (claim.status !== '資料なし' || !NUMERIC_TYPES.has(claim.type)) return false;
  if (!normalizedClaim(claim.sentence) || !normalizedClaim(replacement).includes(normalizedClaim(claim.sentence))) return false;
  const numbers = normalizedNumbers(claim.claim), before = normalizedNumbers(finding.sentence), after = normalizedNumbers(replacement);
  if (!numbers.length || numbers.includes(null) || !numbers.every(n => before.includes(n) && after.includes(n))) return false;
  const prior = originals.filter(c => c.type === claim.type && c.subject === claim.subject &&
    JSON.stringify(normalizedNumbers(c.claim)) === JSON.stringify(numbers));
  return !prior.length || prior.every(c => c.status === '裏付けあり');
}

function sourceDate(version) {
  const s = String(version || '');
  const era = s.match(/(令和|平成)(元|\d+)年(\d+)月(\d+)日/);
  if (era) return new Date(Date.UTC((era[1] === '令和' ? 2018 : 1988) + (era[2] === '元' ? 1 : Number(era[2])), Number(era[3]) - 1, Number(era[4])));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10));
  return null;
}

async function judgeClaims(claims, evidence, body, callLLM, options = {}) {
  const ownWriter = writerRefs(options);
  const confirming = confirmationEnabled(options);
  const ownTally = ownWriter.length && !options[STAGE_TALLY];
  const results = new Map(), queued = [];
  const units = splitUnits(body);
  for (const c of claims) {
    const refs = evidence[c.id] || [];
    if (!refs.length) results.set(c.id, { id: c.id, sentence: c.sentence, heading: c.heading, type: c.type, subject: c.subject, claim: c.claim,
      ...(typeof c.type_label === 'string' ? { type_label: c.type_label } : {}),
      s: units.find(u => !u.heading && u.text === c.sentence)?.s,
      status: '資料なし', quote: '', correct: '', evidence: [], evidence_id: '' });
    else queued.push(c);
  }
  const stageTally = options[STAGE_TALLY] || (ownTally ? { answers: new Map(), deadlineSubjects: new Set() } : null);
  const deadlineSubjects = stageTally?.deadlineSubjects || new Set();
  const tally = { declared: 0, rejected: 0, missing: 0, total: 0, samples: [] };
  const instruction = `主張を添付した原文だけで照合してください。evidence の中の、各主張の evidence_ids の資料を優先して根拠にしてください。要件・判定・手続の主張で、evidence_ids の資料に根拠が無く、この資料表の別の資料に根拠があるときは、その資料の番号を evidence_id に書いてかまいません。金額・割合・期限・適用年・番号の主張は evidence_ids の資料だけを根拠にしてください。判断できなければ資料なしにする。記憶で補わない。括弧書き・ただし書きの対象を取り違えない。${LAW_SCOPE_RULE} 出力は [{id,status,evidence_id,basis,correct}] の形のJSON配列だけです（correct は食い違い・期限の書き漏れのときだけ、資料なしでは evidence_id・basis も書かない）。statusは裏付けあり／食い違い／資料なし／期限の書き漏れ。裏付けあり・食い違い・期限の書き漏れでは basis に根拠の文の番号（連続4つまで）を書き（金額・期限・割合・適用年・番号の主張は連続2つまで）、evidence_id にその資料の番号を書いてください。食い違いには correct に原文に基づく正しい内容を書く。制度の適用期限が原文にあるのに番号付きの本文のどこにも書かれていない場合、制度ごとに1件だけ期限の書き漏れとし、correctに期限を書いてください。設例の額を制度の上限と混同しないでください。その主張の数字・期間そのものが、原文で適用時期によって段階的に変わるのに、番号付きの本文のどこにも段階や対象の時期が書かれていない場合に限り、食い違いとし、correct に段階を書いてください。特定の年分の値として正しく書いている場合は裏付けありとしてください。数字の根拠が同じ資料の離れた2か所にあるときに限り、basis に範囲を2つまで "12-13,30" の形で書いてください。`;
  const example = '\n例: [{"id":"c1","status":"裏付けあり","evidence_id":3,"basis":"12-13"}]';
  const cache = options.pageCache;
  const batching = options.batch && !options.batch.disabled;
  let groups;
  if (!batching && cache?.groups?.length) {
    // 初回の固定部分をそのまま使い、不足するページだけを可変部分へ追加する。
    groups = cache.groups.map(g => ({ ...g, claims: [] }));
    for (const c of queued) {
      const own = new Set((evidence[c.id] || []).map(e => e.id));
      const group = [...groups].sort((a, b) => b.pack.pages.filter(p => own.has(p.id)).length - a.pack.pages.filter(p => own.has(p.id)).length)[0];
      group.claims.push(c);
    }
  } else {
    groups = pageGroups(queued, evidence, options)
      .map(g => ({ ...g, staticSystem: instruction + example + '\n\n' + g.pack.block }));
    if (cache && (!batching || !cache.groups)) cache.groups = groups;
  }
  const judgeBatch = async (batch, group, depth = 0) => {
    const known = new Set(group.pack.pages.map(p => p.id));
    const missing = Object.fromEntries(batch.map(c => [c.id, (evidence[c.id] || []).filter(e => !known.has(e.id))]));
    const extra = buildPages(batch, missing, options, group.pack.pages.length + 1);
    const pages = [...group.pack.pages, ...extra.pages];
    const byId = new Map(pages.map(p => [p.id, p]));
    const contained = (ref, page) => evidenceTexts(ref).every(text => {
      const required = ref.kind === 'taxanswer' && Number.isInteger(ref.text_start) ? text.slice(0, Math.max(0, page.source.length - ref.text_start)) : text;
      return !required || evidenceTexts(page.ref).some(part => normalizedQuote(part).includes(normalizedQuote(required)));
    });
    // 再照合の主張の抜粋が固定資料（キャッシュ）に無い、または追加で上限を超える場合は、
    // 根拠を削ったり照合を止めたりせず、その主張だけで資料を作り直して判定する（キャッシュは使わない）。
    const fits = group.pack.block.length + extra.block.length <= 100000 &&
      batch.every(c => (evidence[c.id] || []).every(ref => !known.has(ref.id) || contained(ref, byId.get(ref.id))));
    if (!fits) {
      if (group.fresh) throw new Error('判定の資料に主張の抜粋を収められません');
      for (const g of pageGroups(batch, evidence, options)) {
        await judgeBatch(g.claims, { ...g, fresh: true, staticSystem: instruction + example + '\n\n' + g.pack.block }, depth);
      }
      return;
    }
    let data;
    try {
      const ret = await callLLM({ task: 'judge', maxTokens: 16000, system: group.staticSystem, staticSystem: group.staticSystem,
        user: JSON.stringify({ today: (options.now || new Date()).toISOString().slice(0, 10), body: renderUnits(units),
          ...(extra.pages.length ? { evidence: extra.block } : {}),
          claims: batch.map(({ id, sentence, claim, type, subject }) => {
            const s = units.find(u => !u.heading && u.text === sentence)?.s;
            return { id, ...(s ? { s } : { sentence }), type, subject, claim,
              evidence_ids: (evidence[id] || []).map(e => byId.get(e.id).number) };
          }) }),
      });
      if (['max_tokens', 'length'].includes(ret?.stopReason) || ret?.stop_reason === 'max_tokens') throw new SyntaxError('判定の出力が上限に達しました');
      // 答えの形が想定と違うときに原因を追えるよう、先頭だけログに残す（公開資料に基づく判定で秘密情報は含まない）。
      if (!ownWriter.length && (options.provider || process.env.FACT_CHECK_PROVIDER) !== 'gateway') console.log(`[fact-check] 判定の出力（先頭）: ${String(typeof ret === 'string' ? ret : Array.isArray(ret) ? JSON.stringify(ret) : ret?.text || '').slice(0, 1500)}`);
      data = parseJson(ret);
    } catch (error) {
      if (!(error instanceof SyntaxError) || depth >= 3 || batch.length < 2) throw error;
      let retryError;
      const at = Math.ceil(batch.length / 2);
      for (const half of [batch.slice(0, at), batch.slice(at)]) {
        try { await judgeBatch(half, group, depth + 1); } catch (err) { retryError ||= err; }
      }
      if (retryError) throw retryError;
      return;
    }
    if (!Array.isArray(data)) throw new Error('判定結果が不正です');
    tally.total += batch.length;
    for (const c of batch) {
      const beforeTally = { ...tally, samples: tally.samples.length };
      const rows = data.filter(r => String(r?.id ?? '') === c.id);
      const r = rows.length === 1 ? rows[0] : null;
      let status = STATUSES.includes(r?.status) ? r.status : '資料なし';
      // 答えが無い・形が不正なものは資料なし。確認で落とした理由は記録に残す（全部落ちる不具合を見逃さないため）。
      let reason = !r ? (rows.length > 1 ? '同じ主張の答えが複数' : '答えが無い') : !STATUSES.includes(r.status) ? '状態が不正' : '';
      // correct は空の代わりに null で返ることがある。文字列でも空でもないものだけを不正とする。
      const correct = typeof r?.correct === 'string' ? r.correct : r?.correct == null ? '' : null;
      if (correct === null) { status = '資料なし'; reason ||= '正しい内容が文字列でない'; }
      const candidates = (evidence[c.id] || []).map(e => byId.get(e.id).ref);
      const evidenceNo = unitNumber(r?.evidence_id);
      const citedPage = evidenceNo ? pages.find(p => p.number === evidenceNo) : null;
      const inCandidates = citedPage && candidates.some(e => e.id === citedPage.id);
      const page = inCandidates || canUseOutsideEvidence(c, status) || canUseWriterEvidence(c, status, citedPage?.ref, ownWriter, confirming) ? citedPage : null;
      const ranges = basisRanges(r?.basis);
      // 2範囲では各範囲の上限を先に守る。単一範囲の3〜4文に対する従来の救済は維持する。
      const maxUnits = ranges?.length === 2 && NUMERIC_TYPES.has(c.type) ? 2 : 4;
      let citations = page && ranges?.map(basis => rangeText(page.source, page.units, basis, maxUnits));
      if (citations?.some(c => !c)) citations = null;
      const joinQuotes = parts => parts?.map(c => c.text).join('\n…\n') || '';
      let tooMany = NUMERIC_TYPES.has(c.type) && citations && ranges.some(basis => !rangeText(page.source, page.units, basis, 2));
      if (tooMany && status !== '資料なし') {
        // 各範囲を独立に連続1〜2文へ絞る。範囲間の隙間を引用へ取り込まない。
        const choices = citations.map(cited => {
          const selected = page.units.filter(u => u.start >= cited.start && u.end <= cited.end);
          const candidates = [];
          for (let i = 0; i < selected.length; i++) for (const length of [1, 2]) {
            if (i + length <= selected.length) candidates.push(rangeText(page.source, page.units, `${selected[i].s}-${selected[i + length - 1].s}`, 2));
          }
          return candidates.filter(Boolean);
        });
        const combinations = choices.length === 1 ? choices[0].map(c => [c]) : choices[0].flatMap(a => choices[1].map(b => [a, b]));
        const rescued = combinations.find(parts => {
          const grounded = { correct: correct ?? '', quote: joinQuotes(parts) };
          const checked = numberCheckClaim(c, page.ref);
          const numbers = normalizedNumbers(status === '裏付けあり' ? checked.claim : c.type === '番号' ? correct : numberCheckText(correct, page.ref));
          if (status === '裏付けあり' && !numbers.length) numbers.push(...normalizedNumbers(checked.sentence));
          return quoteExists(grounded.quote, page.ref) && sufficientQuote(c, grounded, page.ref, status) &&
            (numbers.length ? quoteSupportsNumbers(numbers, grounded, page.ref) : status !== '裏付けあり' || !isNumericClaim(checked));
        });
        if (rescued) { citations = rescued; tooMany = false; }
      }
      const quote = joinQuotes(citations);
      let supportedNumbers = null;
      const ref = page?.ref;
      const grounded = { ...r, correct: correct ?? '', quote };
      if (status !== '資料なし') {
        const rejected = !evidenceNo ? '資料の番号が読めない' : !page ? '資料の番号がこの主張の候補でない' : !quote ? '根拠の文の番号が読めない・範囲外'
          : tooMany ? '数字の主張の根拠が2文を超える'
          : !quoteExists(quote, ref) ? '引用が資料に無い'
            : !sufficientQuote(c, grounded, ref, status) ? '引用が短い・数字が引用の近くに無い'
              : ['食い違い', '期限の書き漏れ'].includes(status) && !correct.trim() ? '正しい内容が空' : '';
        if (inCandidates && status === '裏付けあり' && ['金額', '割合', '期限', '適用年'].includes(c.type) && rejected === '引用が短い・数字が引用の近くに無い') {
          const partial = partialQuoteNumbers(c, grounded, ref);
          if (partial?.forms.length) supportedNumbers = partial.forms;
        }
        if (rejected) { status = '資料なし'; reason = rejected; }
      }
      if (r && STATUSES.includes(r.status) && r.status !== '資料なし') {
        tally.declared++;
        if (status === '資料なし') { tally.rejected++; if (tally.samples.length < 3) tally.samples.push({ reason, row: r }); }
      } else if (!r) tally.missing++;
      // 同じ制度の期限の2件目は修正対象に加えない。
      if (status === '期限の書き漏れ') {
        if (deadlineSubjects.has(c.subject)) {
          status = '資料なし'; reason = '同じ制度の期限の書き漏れは記録済み';
        } else deadlineSubjects.add(c.subject);
      }
      // 提示済み資料でも、引用と数字などの確認を通った場合だけ候補末尾へ加える。
      const outsideCandidates = status !== '資料なし' && page && !inCandidates;
      if (outsideCandidates) candidates.push(page.ref);
      const date = ref && sourceDate(ref.law_version);
      const cutoff = new Date(options.now || new Date());
      cutoff.setUTCMonth(cutoff.getUTCMonth() - 18);
      results.set(c.id, { id: c.id, sentence: c.sentence, heading: c.heading, type: c.type, subject: c.subject, claim: c.claim,
        ...(typeof c.type_label === 'string' ? { type_label: c.type_label } : {}),
        s: units.find(u => !u.heading && u.text === c.sentence)?.s,
        status, quote: status === '資料なし' ? '' : quote, correct: status === '資料なし' ? '' : correct,
        evidence: candidates, evidence_id: status === '資料なし' ? '' : ref.id,
        ...(confirming && r ? { glm_answer: { status: STATUSES.includes(r.status) ? r.status : '資料なし', evidence: citedPage?.id || '', basis: contentModel.redactSecrets(String(r.basis ?? '')).slice(0, 80),
          correct: contentModel.redactSecrets(correct || '').slice(0, 2000) } } : {}),
        ...(outsideCandidates ? { evidence_outside_candidates: true } : {}),
        ...(supportedNumbers ? { supported_numbers: supportedNumbers } : {}),
        ...(reason ? { reject_reason: reason } : {}),
        ...(reason && r && STATUSES.includes(r.status) && r.status !== '資料なし' ? { rejected_answer: {
          status: r.status, evidence: pages.find(p => p.number === evidenceNo)?.id || r.evidence_id,
          basis: String(r.basis ?? '').slice(0, 40), quote: quote.slice(0, 200),
        } } : {}),
        ...(status === '裏付けあり' && date && date <= cutoff ? { warning: '注意: 根拠の基準日が古い' } : {}),
      });
      if (stageTally) stageTally.answers.set(c.id, { total: 1,
        declared: tally.declared - beforeTally.declared, rejected: tally.rejected - beforeTally.rejected,
        missing: tally.missing - beforeTally.missing, samples: tally.samples.slice(beforeTally.samples) });
    }
    if (ownWriter.length && !options[JUDGE_RETRIED]) {
      const eligible = new Set(['引用が資料に無い', '引用が短い・数字が引用の近くに無い', '根拠の文の番号が読めない・範囲外', '数字の主張の根拠が2文を超える', '正しい内容が空']);
      const rejected = batch.filter(c => eligible.has(results.get(c.id)?.reject_reason) && results.get(c.id)?.rejected_answer);
      const pack = { pages, block: pages.map(p => p.block).join('\n\n') };
      for (let i = 0; i < rejected.length; i += 10) {
        const items = rejected.slice(i, i + 10);
        const previousTally = new Map(items.map(c => [c.id, stageTally.answers.get(c.id)]));
        const previousDeadlines = new Set(stageTally.deadlineSubjects);
        try {
          const retried = await judgeClaims(items, evidence, body, req => callLLM({ ...req, task: 'retry_judge', immediate: true,
            user: JSON.stringify({ ...JSON.parse(req.user), retry: items.map(c => ({ id: c.id, reason: results.get(c.id).reject_reason,
              answer: data.find(r => String(r?.id ?? '') === c.id) })),
              instruction: '前回の答えは示した理由のため採れませんでした。引用する文の番号と、correct の数字は引用の文にある数字だけで書き直してください。' }) }),
          { ...options, [JUDGE_RETRIED]: true, [STAGE_TALLY]: stageTally, batch: null,
            pageCache: { groups: [{ pack, staticSystem: instruction + example + '\n\n' + pack.block, claims: [] }] } });
          for (const c of retried) {
            if (c.status !== '資料なし') results.set(c.id, c);
            else stageTally.answers.set(c.id, previousTally.get(c.id));
          }
        } catch (_) {
          for (const [id, row] of previousTally) stageTally.answers.set(id, row);
          stageTally.deadlineSubjects.clear();
          for (const subject of previousDeadlines) stageTally.deadlineSubjects.add(subject);
        } // 聞き直せなくても、元の資料なしとその歯止めを維持する。
      }
    }
  };
  for (const group of groups) if (group.claims.length) await judgeBatch(group.claims, group);
  // 段A/Bは採用した答えの合計で同じ歯止めを掛ける。従来経路はこの場で確かめる。
  if (!stageTally) checkTally(tally, options);
  else if (ownTally) checkTally(mergeTally(stageTally.answers), options);
  return claims.map(c => results.get(c.id)).filter(Boolean);
}

function mergeTally(answers) {
  const tally = { declared: 0, rejected: 0, missing: 0, total: 0, samples: [] };
  for (const row of answers.values()) {
    for (const key of ['declared', 'rejected', 'missing', 'total']) tally[key] += row[key];
    tally.samples.push(...row.samples);
  }
  return tally;
}
function checkTally(tally, options = {}) {
  const judged = tally.declared + tally.missing;
  if ((tally.rejected >= 3 && tally.rejected * 2 >= tally.declared) || (tally.missing >= 3 && tally.missing * 2 >= tally.total)) {
    if ((options.provider || process.env.FACT_CHECK_PROVIDER) !== 'gateway') console.warn(`[fact-check] 確認で落とした答えの例: ${JSON.stringify(tally.samples).slice(0, 1500)}`);
    const error = new Error(`判定の答えの多くが確認を通りません（落とした ${tally.rejected}/${tally.declared}・答え無し ${tally.missing}/${judged}）`);
    error.diagnostic = error.message;
    throw error;
  }
}

function sentenceRows(body) {
  return splitUnits(String(body)).map(u => u.text);
}

function changedText(before, after) {
  const counts = new Map();
  for (const row of sentenceRows(before)) counts.set(row, (counts.get(row) || 0) + 1);
  const changed = [];
  let heading = '';
  for (const row of sentenceRows(after)) {
    if (/^\s*#{1,6}\s/.test(row)) heading = row.trim();
    const n = counts.get(row) || 0;
    if (n) counts.set(row, n - 1);
    else if (row.trim()) changed.push(`${heading}\n${row}`);
  }
  return changed.join('\n');
}

/** 見出しの階層と表の見出し行を含めて、差分の影響を節単位で追う。 */
function affectedClaims(before, after, previous, extracted) {
  const sections = text => {
    const rows = splitUnits(text), result = [{ heading: '', context: '', rows: [], headers: [] }], parents = [];
    for (const [i, row] of rows.entries()) {
      if (row.heading) {
        const level = row.text.match(/^\s*(#+)/)[1].length;
        parents.length = level; parents[level - 1] = row.text;
        result.push({ heading: row.text.replace(/^\s*#{1,6}\s+/, ''), context: parents.join('\n'), rows: [], headers: [] });
      }
      const section = result.at(-1);
      section.rows.push(row.text);
      if (/^\s*\|/.test(row.text) && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(rows[i + 1]?.text || '')) section.headers.push(row.text);
    }
    return result;
  };
  const oldSections = sections(before), newSections = sections(after), affected = new Set();
  for (let i = 0; i < Math.max(oldSections.length, newSections.length); i++) {
    if (oldSections.length !== newSections.length || oldSections[i]?.context !== newSections[i]?.context ||
        JSON.stringify(oldSections[i]?.headers) !== JSON.stringify(newSections[i]?.headers)) affected.add(i);
  }
  const remaining = new Map();
  for (const row of sentenceRows(after)) remaining.set(row, (remaining.get(row) || 0) + 1);
  const removedDates = [];
  for (const [i, section] of oldSections.entries()) for (const row of section.rows) {
    const n = remaining.get(row) || 0;
    if (n) remaining.set(row, n - 1);
    else if (normalizedNumbers(row).some(n => typeof n === 'string' && n.startsWith('日付:')) || /まで|までの間|以後/.test(row)) {
      affected.add(i); removedDates.push(row);
    }
  }
  const locations = (c, list) => {
    const exact = list.flatMap((s, i) => s.rows.includes(c.sentence) ? [i] : []);
    if (exact.length) return exact;
    const headings = list.flatMap((s, i) => s.heading === c.heading ? [i] : []);
    return headings.length ? headings : list.map((_, i) => i); // 位置が曖昧なら再判定する。
  };
  const inAffected = c => locations(c, oldSections).some(i => affected.has(i)) || locations(c, newSections).some(i => affected.has(i));
  // 直前の見出しの名前だけでなく、見出しの階層（例: 令和6年分 > 基礎控除 → 令和7年分 > 基礎控除）が変わった文も判定し直す。
  const contexts = (list, sentence) => list.filter(s => s.rows.includes(sentence)).map(s => s.context);
  const headingChanged = c => newSections.some(s => s.rows.includes(c.sentence) && s.heading !== c.heading) ||
    contexts(newSections, c.sentence).some(context => !contexts(oldSections, c.sentence).includes(context));
  const subjects = [...new Set([...extracted.map(c => c.subject), ...previous.filter(c =>
    !actualSentence(after, c.sentence) || inAffected(c) || headingChanged(c) || removedDates.some(row => subjectsOverlap(c.subject, row))).map(c => c.subject)])];
  return { subjects, needsJudge: c => inAffected(c) || headingChanged(c) || subjects.some(subject => subjectsOverlap(subject, c.subject)) };
}

function subjectsOverlap(a, b) {
  const words = tokenizeForMatcher(a), other = tokenizeForMatcher(b);
  return a === b || !words.size || !other.size || [...words].some(word => other.has(word));
}

/** 修正対象以外の原文が、同じ順番で残ることを確認する。 */
function preservesOtherText(before, after, findings) {
  const targets = new Set(findings.map(f => f.sentence));
  const intervals = splitUnits(before).filter(u => !u.heading && targets.has(u.text));
  const anchors = [];
  let at = 0;
  for (const interval of intervals) {
    if (interval.start > at) anchors.push(before.slice(at, interval.start));
    at = Math.max(at, interval.end);
  }
  anchors.push(before.slice(at));
  const normalized = after.replace(/\s+/g, ' ');
  let cursor = 0;
  for (const anchor of anchors) {
    const needle = anchor.replace(/\s+/g, ' ').trim();
    if (!needle) continue;
    const found = normalized.indexOf(needle, cursor);
    if (found < 0) return false;
    cursor = found + needle.length;
  }
  const headings = text => [...text.matchAll(/^#{1,6}\s+.+$/gm)].map(m => m[0]).join('\n');
  return headings(before) === headings(after);
}

function repairInstructions(findings) {
  return findings.map(f => ({ ...f,
    ...(f.supported_numbers ? { keep_numbers: f.supported_numbers } : {}),
    instruction: f.status === '食い違い' ? '根拠の原文に合わせて、この文だけを直す' :
      f.status === '期限の書き漏れ' ? 'この制度の説明に、根拠の適用期限を1文で足す' :
        f.type === '番号' ? '資料が無い番号を消し、番号を推測せず内容だけにする' :
          '資料が無い具体的な要件・金額・割合・期限・適用年・手続・判定を外し、「詳しくは国税庁の〇〇で確認」程度の案内に置き換える。keep にある裏付けのある内容（数字を含む）は残し、資料が無い部分だけを外す' +
          (f.supported_numbers ? '。keep_numbers の数字は表記どおり残し、それ以外の資料の無い数字だけを外す' : ''),
  }));
}

function correctionPairs(before, after, findings, replacements) {
  // 実際に採用した編集を唯一の対応にする。却下・空の編集は元の文のまま。
  if (replacements || findings.every(f => Object.hasOwn(f, 'after'))) {
    return new Map(findings.map(f => [f.sentence, replacements ? replacements.get(f.sentence) || f.sentence : f.after || f.sentence]));
  }
  const units = splitUnits(before);
  const targets = [...new Set(findings.map(f => f.sentence))].map(sentence => ({ sentence, at: units.find(u => !u.heading && u.text === sentence)?.start ?? -1 }))
    .filter(t => t.at >= 0).sort((a, b) => a.at - b.at);
  const pairs = new Map();
  let cursor = 0, previousEnd = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const preceding = before.slice(previousEnd, t.at).trim();
    const precedingAt = preceding ? after.indexOf(preceding, cursor) : cursor;
    const start = precedingAt < 0 ? cursor : precedingAt + preceding.length;
    const end = t.at + t.sentence.length;
    const following = before.slice(end, targets[i + 1]?.at ?? before.length).trim();
    const nextUnit = splitUnits(after).find(u => u.start >= start && !u.heading);
    const followingAt = following ? after.indexOf(following, start) : targets[i + 1] ? nextUnit?.end ?? start : after.length;
    pairs.set(t.sentence, after.slice(start, followingAt < 0 ? after.length : followingAt).trim());
    cursor = followingAt < 0 ? start : followingAt;
    previousEnd = end;
  }
  return pairs;
}

async function repairBody(body, findings, callLLM, options = {}) {
  const enhanced = writerRefs(options).length > 0;
  const units = splitUnits(body);
  const corrections = repairInstructions(findings).map(({ id, sentence, heading, status, type, subject, correct, quote, instruction, keep = [], keep_numbers }) => {
    const at = units.find(u => !u.heading && u.text === sentence)?.start ?? -1;
    const context = text => sentenceRows(text).map(s => s.trim()).filter(s => s && !/^#{1,6}\s/.test(s));
    return { id, sentence, heading, prev: context(body.slice(0, at)).at(-1) || '', next: context(body.slice(at + sentence.length))[0] || '',
      status, type, correct, quote, instruction: instruction + (enhanced && status === '食い違い' ? '。元の文の話題・役割（例・注意・手順など）は変えず、誤りの部分だけを直す' : ''),
      keep, ...(keep_numbers ? { keep_numbers } : {}), ...(enhanced ? { subject, ...sentenceContext(body, sentence) } : {}) };
  });
  const ret = await callLLM({ task: 'repair', maxTokens: 8000,
    system: '指摘された文だけを最小限修正し、各文の置き換え後の文を [{id,replacement}] のJSON配列だけで出力してください。replacement は元の文の位置にそのまま入る（改行・見出しを含めない）。表の行は列の数を変えずに直し、期限を足すときは該当する列の中に書く。主題・構成・見出し・文体は変えず、他の文はそのまま残す。検討の過程・確認結果・修正方針の説明を本文に書かない。「差し戻しコメント」「論点別ルール」「該当箇所」などの語を本文に登場させない。本文は元の書き出しからそのまま始める。frontmatterやコードフェンスは出力しない。根拠に無いことを記憶で補わない。' + (enhanced ? '\n' + MISCONCEPTION_CONTEXT_RULE : ''),
    user: JSON.stringify({ corrections }),
  });
  let data;
  try { data = parseJson(ret); if (!Array.isArray(data)) throw new SyntaxError(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { body, accepted: false, reason: '修正のJSONを読めないため、元の本文を維持しました' };
  }
  const rejected = new Map(), replacements = new Map();
  for (const f of findings) {
    const rows = data.filter(r => r?.id === f.id);
    const replacement = typeof rows[0]?.replacement === 'string' ? rows[0].replacement.trim() : '';
    let reason = '';
    if (!units.some(u => !u.heading && u.text === f.sentence)) reason = '修正対象が本文の文に一致しません';
    else if (rows.length > 1) reason = '修正のidが重複しています';
    else if (!replacement) reason = '置き換え後の文が空です';
    else if (normalizedClaim(replacement) === normalizedClaim(f.sentence)) reason = '置き換え後の文が元の文と同じです';
    else if (/[\r\n]/.test(rows[0].replacement) || /(^|\s)#{1,6}\s/.test(replacement)) reason = '改行または見出しを含んでいます';
    else if (replacement.length > f.sentence.length * 3 && replacement.length > 200) reason = '置き換え後の文が長すぎます';
    else if (f.sentence.startsWith('|') && (replacement.match(/\|/g) || []).length !== (f.sentence.match(/\|/g) || []).length) reason = '表の列数が変わっています';
    if (!reason && enhanced && ['食い違い', '期限の書き漏れ'].includes(f.status) && !onlyNumberChange(f.sentence, replacement)) {
      const before = sentenceWords(f), after = tokenizeForMatcher(replacement);
      const subject = [...tokenizeForMatcher(f.subject || '')];
      // 長い制度名があるときに、税目を共有するだけの2文字の断片で別の話題を通さない。
      const words = subject.some(word => word.length >= 3) ? subject.filter(word => word.length >= 3) : subject;
      const hasSubject = (NUMERIC_TYPES.has(f.type) || f.status === '期限の書き漏れ') && words.some(word => after.has(word));
      if (!hasSubject && before.filter(word => after.has(word)).length < before.length / 2) reason = '元の文の話題を残していません';
    }
    // 確かめで正しいと認めた同じ文の数字は、誤りの修正でも残す。
    if (!reason && options[CONFIRM_KEEP]) {
      const before = normalizedNumbers(f.sentence), after = normalizedNumbers(replacement);
      const rawKeep = (f.keep || []).flatMap(c => normalizedNumbers(c.claim));
      const keep = expandYearDates(rawKeep, f.sentence).filter(n => before.includes(n));
      if (rawKeep.includes(null) || !keep.every(n => after.includes(n))) reason = '裏付けのある数字を消しています';
    }
    // 具体を外す修正だけで、裏付けのある数字を守り、資料の無い数字を残さない。
    if (!reason && f.status === '資料なし') {
      const originalNumbers = normalizedNumbers(f.sentence), revisedNumbers = normalizedNumbers(replacement);
      const keep = f.keep || [];
      const keepNumbers = expandYearDates([...keep.flatMap(c => normalizedNumbers(c.claim)), ...(f.supported_numbers || []).flatMap(n => normalizedNumbers(n))], f.sentence)
        .filter(n => originalNumbers.includes(n));
      const summaryNumbers = normalizedNumbers(f.claim);
      const removeNumbers = expandYearDates(f.supported_numbers && !summaryNumbers.length ? originalNumbers : summaryNumbers, f.sentence)
        .filter(n => originalNumbers.includes(n) && !keepNumbers.includes(n));
      if (originalNumbers.includes(null) && (keep.length || f.supported_numbers?.length)) reason = '数字を読めないため確かめられません';
      else if (!keepNumbers.every(n => revisedNumbers.includes(n))) reason = '裏付けのある数字を消しています';
      else if (removeNumbers.some(n => revisedNumbers.includes(n))) reason = '資料の無い数字が残っています';
      else if (enhanced && REVIEW_TYPES.has(f.type) && revisedNumbers.some(n => !keepNumbers.includes(n))) reason = '資料の無い数字が残っています';
    }
    if (reason) rejected.set(f.id, reason);
    else replacements.set(f.id, replacement);
  }
  const checkSentences = () => {
    for (const f of findings) if (rejected.has(f.id)) for (const same of findings.filter(r => r.sentence === f.sentence)) {
      replacements.delete(same.id);
      if (!rejected.has(same.id)) rejected.set(same.id, '同じ文の別の指摘の置き換えを採れませんでした');
    }
    // 同じ文の複数の指摘から異なる置き換えが返った場合は、その文を維持する。
    const bySentence = new Map();
    for (const f of findings) if (replacements.has(f.id)) {
      if (!bySentence.has(f.sentence)) bySentence.set(f.sentence, []);
      bySentence.get(f.sentence).push(f);
    }
    for (const rows of bySentence.values()) if (new Set(rows.map(f => replacements.get(f.id))).size > 1) {
      for (const f of rows) { replacements.delete(f.id); rejected.set(f.id, '同じ文の置き換えが一致しません'); }
    }
  };
  checkSentences();
  if (enhanced && !options[REPAIR_RETRIED]) {
    const retryReasons = new Set(['置き換え後の文が元の文と同じです', '改行または見出しを含んでいます', '置き換え後の文が長すぎます', '表の列数が変わっています',
      '裏付けのある数字を消しています', '資料の無い数字が残っています', '同じ文の別の指摘の置き換えを採れませんでした', '同じ文の置き換えが一致しません', '元の文の話題を残していません']);
    const retry = findings.filter(f => retryReasons.has(rejected.get(f.id)));
    if (retry.length) {
      try {
        const again = await repairBody(body, retry, req => callLLM({ ...req, task: 'retry_repair', immediate: true,
          user: JSON.stringify({ ...JSON.parse(req.user), previous: retry.map(f => ({ id: f.id, replacement: data.find(r => r?.id === f.id)?.replacement || '', reason: rejected.get(f.id) })),
            instruction: '前回の置き換えは示した理由のため採れませんでした。その指摘だけを直してください。同じ文の指摘はまとめて同じ1つの置き換えを返してください。' }) }),
        { ...options, [REPAIR_RETRIED]: true });
        if (again.accepted) for (const f of retry) {
          if (again.rejected.has(f.id)) rejected.set(f.id, again.rejected.get(f.id));
          else if (again.replacements.has(f.sentence)) { replacements.set(f.id, again.replacements.get(f.sentence)); rejected.delete(f.id); }
        }
      } catch (_) { /* 直しに失敗しても、採れない置き換えは元のまま残す。 */ }
    }
  }
  if (enhanced) checkSentences();
  const edits = new Map(findings.filter(f => replacements.has(f.id)).map(f => [f.sentence, replacements.get(f.id)]));
  const intervals = units.filter(u => !u.heading && edits.has(u.text)).map(u => ({ at: u.start, end: u.end, replacement: edits.get(u.text) }));
  let revised = body;
  for (const edit of intervals.sort((a, b) => b.at - a.at)) revised = revised.slice(0, edit.at) + edit.replacement + revised.slice(edit.end);
  const stripped = partial.stripAnalysisPreamble(body, revised).body;
  if (stripped !== revised.trim()) revised = stripped;
  const guard = partial.isBodyShrinkageSuspicious(body, revised, 0.6);
  if (guard.suspicious || partial.findInternalProcessWords(revised).contaminated || /^---\n/.test(revised) ||
      !preservesOtherText(body, revised, findings) || (options.validateRepair && !options.validateRepair(revised))) {
    return { body, accepted: false, reason: '修正結果が本文の保全条件を満たさないため、元の本文を維持しました' };
  }
  return { body: revised, accepted: true, rejected, replacements: edits };
}

// 記載なしだけに加える、意味を変えたり具体を残したりする答えの歯止め。
function notStatedMeaningReason(body, finding, replacement) {
  const normalize = text=>String(text || '').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const negative = text=>/ない|ません|不要|対象外|除く/.test(normalize(text));
  if (negative(finding.sentence)!==negative(replacement)) return '否定の向きが変わっています';
  const context=sentenceContext(body,finding.sentence);
  if (/よくある誤解|NG\s*(?:な)?例|(?:と考える|と思う|という考え)(?:の)?は(?:誤り|間違い)|勘違い|誤りの例|誤った例/i.test([context.heading,context.prev,finding.sentence].join('\n').normalize('NFKC')))
    return '誤解・NG例の文では具体を外しません';
  const subject=[...tokenizeForMatcher(finding.subject || '')], after=tokenizeForMatcher(replacement);
  const words=subject.some(word=>word.length>=3) ? subject.filter(word=>word.length>=3) : subject;
  if (!words.length || !words.some(word=>after.has(word))) return '制度の話題を残していません';
  const beforeNumbers=normalizedNumbers(finding.sentence), afterNumbers=normalizedNumbers(replacement), claimNumbers=normalizedNumbers(finding.claim);
  if (claimNumbers.length) {
    if (claimNumbers.includes(null) || !claimNumbers.some(n=>beforeNumbers.includes(n)&&!afterNumbers.includes(n))) return '主張の数字を何も外していません';
  } else {
    const summary=[...tokenizeForMatcher(finding.claim || '')].filter(word=>word.length>=2&&!subject.includes(word)&&normalize(finding.sentence).includes(word));
    if (!summary.some(word=>!after.has(word))) return '主張の具体的な語を何も外していません';
  }
  const keep=[...(finding.keep || []).flatMap(c=>normalizedNumbers(c.claim)),...(finding.supported_numbers || []).flatMap(n=>normalizedNumbers(n))];
  const allowed=expandYearDates(keep,finding.sentence).filter(n=>beforeNumbers.includes(n));
  if (keep.includes(null) || afterNumbers.some(n=>!allowed.includes(n))) return '裏付けのない数字が残っています';
  return '';
}

/** 確かめでも引用・数字・本文の保全には従来と同じ部品を使う。 */
function calculationContext(body,finding) {
  const context=sentenceContext(body,finding.sentence),rows=[finding.sentence,context.heading,context.prev,context.next];
  if(finding.sentence.trimStart().startsWith('|')){
    const lines=body.split('\n'),at=lines.findIndex(line=>line.trim()===finding.sentence.trim());let first=at;
    while(first>0&&lines[first-1].trimStart().startsWith('|'))first--;
    rows.push(...lines.slice(first,first+2),lines[at-1]||'',lines[at+1]||'');
  }
  return rows;
}
async function validateConfirmation(body, finding, row, pages, options) {
  const reject = (code, detail) => require('./fact-confirm').rejectConfirmation({}, code, detail);
  const replacement = typeof row.replacement === 'string' ? row.replacement.trim() : '';
  if (row.verdict === '記載なし') {
    if(REVIEW_TYPES.has(finding.type)&&finding.status!=='期限の書き漏れ'&&(finding.status==='食い違い'||finding.condition_mismatch))
      return {...reject('not_stated_status','税の資料に記載が無いため、人が確かめる箇所へ残します'),verdict:'記載なし',review:true};
    if (finding.status !== '資料なし' || finding.condition_mismatch) return reject('not_stated_status', '資料なし以外の指摘には記載なしを採れません');
    if (finding.sentence.trimStart().startsWith('|')) return reject('not_stated_table', '表の行では具体を外しません');
    if (!replacement) return reject('replacement_missing', '具体を外した文がありません');
    const before = normalizedNumbers(finding.sentence), after = normalizedNumbers(replacement);
    if (before.includes(null) || after.includes(null) || after.some(n => !before.includes(n))) return reject('repair_rejected', '元の文に無い数字があるか、数字を読めません');
    const repair = await repairBody(body, [finding], async () => [{id:finding.id,replacement}], {...options,writerMaterials:false});
    if (!repair.accepted || repair.rejected.size) return reject('repair_rejected', repair.reason || repair.rejected.get(finding.id));
    const meaning=notStatedMeaningReason(body,finding,replacement);
    if (meaning) return reject('not_stated_meaning',meaning);
    return {verdict:'記載なし',replacement,reason:contentModel.redactSecrets(String(row.reason || '')).slice(0,300)};
  }
  const number=unitNumber(row.evidence_id), page = pages.find(p => p.number === number);
  if (!page) return reject('page_not_offered', number===null ? '答えの資料番号が無いか、読み取れません' : '答えの資料番号はこの指摘に見せた資料にありません');
  if (page && (row.verdict === '誤り' || REVIEW_TYPES.has(finding.type)) &&
      !canFinalizeStageA({ ...finding, evidence: [page.ref], evidence_id: page.ref.id },
        (options.searchWriterEvidence || searchWriterEvidence)(finding, options).slice(0, 4))) return reject('rewrite_source', '書き手の資料の1位でも題名の一意な一致でもありません');
  const ranges = basisRanges(row.basis);
  const parts = page && ranges?.map(range => rangeText(page.source, page.units, range, NUMERIC_TYPES.has(finding.type) ? 2 : 4));
  if (!parts?.length || parts.some(p => !p)) return reject('basis_unreadable', '文の番号を読めないか、示した抜粋の外です');
  const quote = parts.map(p => p.text).join('\n…\n'), ref = page.ref;
  const grounded = { quote, correct: replacement };
  if (!quoteExists(quote, ref)) return reject('quote_missing', '引用が資料の原文にありません');
  if(Object.hasOwn(row,'calculation')){
    const checked=require('./fact-calculation').verifyCalculations(row.calculation,{quote,article:calculationContext(body,finding),target:row.verdict==='誤り'?replacement:finding.sentence,normalizedNumbers});
    if(checked.error)return reject('calculation_rejected',checked.error);
    grounded[CALCULATION_NUMBERS]=checked.excluded;
  }
  if (row.verdict === '誤り') {
    const numbers = normalizedNumbers(numberCheckText(replacement, ref));
    const remaining=numbers.filter(n=>!grounded[CALCULATION_NUMBERS]?.has(n));
    if (!replacement) return reject('replacement_missing', '誤りを直す文がありません');
    if (numbers.includes(null) || (remaining.length && !quoteSupportsNumbers(remaining, grounded, ref))) return reject('replacement_numbers', '修正文の数字を読めないか、引用の近くにありません');
  }
  if (!sufficientQuote(finding, grounded, ref, row.verdict === '正しい' ? '裏付けあり' : '食い違い')) return reject('quote_insufficient', '引用が短いか、主張の数字が引用の近くにありません');
  if (row.verdict === '誤り') {
    // Opusの意味判断を語の重なりで覆さず、同じrepairBodyの構造・本文保全だけを適用する。
    const repair = await repairBody(body, [finding.status === '資料なし' ? finding : { ...finding, status: '食い違い' }], async () => [{ id: finding.id, replacement }], { ...options, writerMaterials: false });
    if (!repair.accepted || repair.rejected.size) return reject('repair_rejected', repair.reason || repair.rejected.get(finding.id));
  }
  return { verdict: row.verdict, evidence_id: ref.id, basis: ranges.join(','), quote, replacement: row.verdict === '誤り' ? replacement : '',
    reason: contentModel.redactSecrets(String(row.reason || '')).slice(0, 300), ref };
}

async function applyConfirmations(body, findings, record, call, options, model) {
  const {confirmFindings,rejectConfirmation} = require('./fact-confirm');
  // GLMの裏付けありも、確かめに回らないという理由で消さない。確かめの経路だけに適用する。
  findings=findings.map(f=>({...f,keep:[...(f.keep || []),...record.claims.filter(c=>c.sentence===f.sentence&&c.status==='裏付けあり')]}));
  const answers = await confirmFindings(body, findings, call, options,
    (finding, row, pages) => validateConfirmation(body, finding, row, pages, options), sentenceContext, parseJson, normalizedNumbers);
  const editing = answer => !answer?.review&&['誤り','記載なし'].includes(answer?.verdict);
  const notStated = findings.filter(f => answers.get(f.id)?.verdict === '記載なし'&&!answers.get(f.id).review);
  const sentences = new Set(notStated.map(f => f.sentence));
  const tooManyNotStated = sentences.size > 8 || sentences.size > record.claims.length * 0.2;
  if (tooManyNotStated) for (const f of notStated) answers.set(f.id, rejectConfirmation(answers.get(f.id), 'not_stated_limit', '資料に記載の無い具体を外す文が8文または主張の2割を超えました'));
  // 同じ文の一部だけを直したり、複数の置き換えを競合させたりしない。
  const proposed = findings.filter(f => editing(answers.get(f.id))), beforeSentenceCheck = new Map(answers);
  const keepFor = f => [...(f.keep || []), ...findings.filter(other => other.sentence === f.sentence && beforeSentenceCheck.get(other.id)?.verdict === '正しい')];
  for (const f of proposed) {
    const answer = beforeSentenceCheck.get(f.id);
    const conflict = findings.some(other => other.sentence === f.sentence && beforeSentenceCheck.get(other.id)?.verdict !== '正しい' &&
      (!editing(beforeSentenceCheck.get(other.id)) || beforeSentenceCheck.get(other.id).replacement !== answer.replacement));
    const kept = keepFor(f), numbers = normalizedNumbers(answer.replacement);
    const rawKeep = kept.flatMap(c => normalizedNumbers(c.claim));
    const keepNumbers = expandYearDates(rawKeep, f.sentence).filter(n => normalizedNumbers(f.sentence).includes(n));
    if (conflict || rawKeep.includes(null) || !keepNumbers.every(n => numbers.includes(n)))
      answers.set(f.id, rejectConfirmation(answer, 'same_sentence', conflict ? '同じ文の確かめの答えが一致しません' : '同じ文の正しい主張の数字を消しています'));
  }
  const edits = findings.filter(f => editing(answers.get(f.id)));
  const repair = edits.length ? await repairBody(body, edits.map(f => ({...f,status:f.status === '資料なし' ? f.status : '食い違い',keep:keepFor(f)})),
    async () => edits.map(f => ({ id: f.id, replacement: answers.get(f.id).replacement })), { ...options, writerMaterials: false, [CONFIRM_KEEP]:true }) : null;
  for (const f of edits) if (!repair?.accepted || repair.rejected.has(f.id)) answers.set(f.id, rejectConfirmation(answers.get(f.id), 'repair_rejected', repair?.reason || repair?.rejected.get(f.id) || '修正文の本文保全を確かめられませんでした'));
  const counts = { checked: findings.length, rewritten: 0, generalized:0, kept: 0, unknown: 0, rejected:0 };
  const verdicts = {'誤り':0,'正しい':0,'記載なし':0,'判断できない':0}, rejectedCodes = {};
  record.review_items = record.review_items.filter(row => !findings.some(f => f.id === row.id));
  for (const f of findings) {
    const c = record.claims.find(c => c.id === f.id), answer = answers.get(f.id);
    const { ref, ...confirm } = answer;
    c.confirm = confirm;
    if (Object.hasOwn(verdicts, answer.answer?.verdict)) verdicts[answer.answer.verdict]++;
    if (answer.rejected) { counts.rejected++; rejectedCodes[answer.rejected.code] = (rejectedCodes[answer.rejected.code] || 0)+1; }
    if(answer.review){counts.unknown++;c.status='資料なし';c.correct='';delete c.condition_mismatch;record.review_items.push({...c});continue;}
    if (answer.verdict === '判断できない') {
      counts.unknown++;
      if (c.condition_mismatch) {
        record.review_items.push({ ...c, status: '条件の違いを要確認' });
        c.status = '裏付けあり'; c.correct = ''; delete c.condition_mismatch;
      } else if (REVIEW_TYPES.has(c.type)) record.review_items.push({ ...c });
      continue;
    }
    c.confirmed_by = model;
    if (ref) {
      if (!c.evidence.some(e => e.id === ref.id)) c.evidence.push(ref);
      // 採用した確かめの引用は、段A/Bの抜粋ではなくOpusに提示した原文へ結びつける。
      c.evidence = c.evidence.map(e => e.id === ref.id ? ref : e);
      c.evidence_id = ref.id; c.quote = answer.quote;
    }
    delete c.evidence_outside_candidates;
    if (answer.verdict === '正しい') {
      counts.kept++; c.status = '裏付けあり'; c.evidence_id = ref.id; c.quote = answer.quote; c.correct = '';
      for (const key of ['condition_mismatch','correct_requires_review','evidence_requires_review','rejected_answer','reject_reason','supported_numbers','evidence_outside_candidates']) delete c[key];
    } else {
      if (answer.verdict === '記載なし') counts.generalized++; else counts.rewritten++;
      c.correct = answer.replacement;
      record.corrections.push({ ...c, before: c.sentence, after: answer.replacement, resolved: true, generalized: f.status === '資料なし' });
    }
  }
  const calls = record.calls.filter(c => c.task === 'confirm');
  const tokens = key => calls.reduce((n,c) => n+(Number.isFinite(c.usage?.[key]) ? c.usage[key] : 0), 0);
  record.confirm = { model, ...counts, verdicts, rejected_codes:rejectedCodes, stop_reasons:calls.map(c=>c.stop_reason || null),
    usage_complete:calls.every(c=>Number.isFinite(c.usage?.input_tokens)&&Number.isFinite(c.usage?.output_tokens)),
    ...(tooManyNotStated ? {not_stated_limit:true} : {}), calls: calls.length, batch: calls.some(c => c.mode === 'batch'),
    input_tokens: tokens('input_tokens'), output_tokens: tokens('output_tokens'),
    cache_creation_input_tokens: tokens('cache_creation_input_tokens'), cache_read_input_tokens: tokens('cache_read_input_tokens') };
  return repair?.accepted ? repair.body : body;
}

async function checkFacts(body, options = {}) {
  const requestedWriterIds = writerMaterials(options);
  const resolvedWriter = resolveWriterMaterials(requestedWriterIds);
  const writerIds = resolvedWriter.length ? requestedWriterIds : [];
  if (requestedWriterIds.length) options = { ...options, resolvedWriterMaterials: resolvedWriter };
  const confirming = confirmationEnabled(options);
  const confirmModel = process.env.FACT_CHECK_CONFIRM_MODEL || 'claude-opus-5-5';
  const cfg = config(requestedWriterIds.length && !writerIds.length ? { ...options, writer_materials: [] } : options);
  const unresolvedWriter = requestedWriterIds.length - resolvedWriter.length;
  const unresolvedSummary = unresolvedWriter ? `・書き手の資料のうち引けない ${unresolvedWriter} 件` : '';
  const record = { version: 1, logic_version: LOGIC_VERSION, status: 'not_run', model: cfg.model, provider: cfg.provider,
    extract_model: cfg.extractModel, effort: cfg.effort, extract_effort: cfg.extractEffort, batch: cfg.batch,
    checked_at: (options.now || new Date()).toISOString(), body_sha256: bodyHash(body), claims: [], rechecked: [], corrections: [], dropped: 0, discarded: 0,
    calls: [], input_chars_total: 0, output_chars_total: 0, review_items: [], summary: cfg.enabled ? '照合を実施できませんでした' : '照合を無効にしています' };
  if (requestedWriterIds.length) record.writer_materials = materialFingerprint(requestedWriterIds, resolvedWriter.length);
  if (writerIds.length) {
    record.stages = { A: { claims: 0, pages: 0, input_chars: 0 }, B: { claims: 0, pages: 0, input_chars: 0 } };
    record.calculated_skipped = 0;
  }
  if (!cfg.enabled) { record.summary += unresolvedSummary; return { body, record }; }
  const validModel = model => (cfg.provider === 'anthropic' && /^claude-/.test(model)) ||
    (cfg.provider === 'openai' && /^(gpt-|o[134](?:-|$))/.test(model)) ||
    (cfg.provider === 'gateway' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model));
  if (!validModel(cfg.model) || !validModel(cfg.extractModel) ||
      [cfg.effort, cfg.extractEffort].some(e => e !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(e))) {
    record.summary = '照合のモデル設定が不正です' + unresolvedSummary;
    return { body, record };
  }
  const batch = cfg.batch ? contentModel.createBatchContext({ ...options.batchRuntime,
    maxWaitMs: cfg.batchMaxWaitMs, pollMs: cfg.batchPollMs }) : null;
  const confirmBatch = confirming && (options.batch ?? (process.env.FACT_CHECK_BATCH === 'true')) === true
    ? batch || contentModel.createBatchContext({ ...options.batchRuntime, maxWaitMs: cfg.batchMaxWaitMs, pollMs: cfg.batchPollMs }) : null;
  const extracting = request => ['extract', 'retry_extract'].includes(request.task);
  const caller = options.callLLM || (async request => request.task === 'confirm'
    ? contentModel.generateContent({ staticSystem: request.staticSystem || request.system, dynamicSystem: request.dynamicSystem || '', user: request.user },
      { provider: 'anthropic', model: request.model, maxTokens: request.maxTokens, fallback: false, signal: request.signal, timeoutMs: cfg.timeoutMs, batch: null })
    : cfg.provider === 'gateway'
    ? require('./gateway-model').callGateway({ model: request.model, system: request.system, user: request.user, maxTokens: 64000,
      task: (rechecking ? 'recheck_' : '') + (request.stageB && request.task === 'judge' ? 'stage_b_judge' : request.task), signal: request.signal, timeoutMs: cfg.timeoutMs,
      reasoningEffort:extracting(request)?cfg.extractEffort:cfg.effort })
    : contentModel.generateContent({ staticSystem: extracting(request) ? '' : request.staticSystem || request.system,
    dynamicSystem: extracting(request) ? request.system : '', user: request.user },
    { provider: cfg.provider, model: request.model, modelOptions: extracting(request) ? cfg.extractModelOptions : cfg.modelOptions, maxTokens: request.maxTokens,
      fallback: false, signal: request.signal, timeoutMs: cfg.timeoutMs, batch: request.stageB || request.immediate ? null : batch }));
  let rechecking = false;
  const call = async (request, invoke = caller) => {
    const isConfirm = request.task === 'confirm';
    if (isConfirm && !/^claude-[A-Za-z0-9._-]+$/.test(confirmModel)) throw new Error('確かめのモデル設定が不正です');
    const runtime = isConfirm ? confirmBatch : batch;
    const batching = !request.stageB && !request.immediate && runtime && !runtime.disabled;
    const task = request.stageB && request.task === 'judge' ? 'stage_b_judge' : request.task;
    const entry = { task: rechecking ? `recheck_${task}` : task,
      model: isConfirm ? confirmModel : extracting(request) ? cfg.extractModel : cfg.model, mode: batching ? 'batch' : 'sync',
      input_chars: request.system.length + request.user.length + (isConfirm ? (request.dynamicSystem || '').length : 0), output_chars: 0,
      ...(isConfirm ? { evidence_chars: (request.dynamicSystem || '').length, ...(request.retry ? { retry: true } : {}) } : {}) };
    record.calls.push(entry);
    record.input_chars_total += entry.input_chars;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const started = runtime?.now();
    let timer;
    try {
      const ret = await Promise.race([Promise.resolve().then(() => invoke({ ...request, ...(isConfirm ? { provider: 'anthropic' } : {}), model: entry.model, signal: controller.signal })),
        new Promise((_, reject) => {
          if (controller.signal.aborted) return reject(new Error('照合の時間切れ'));
          controller.signal.addEventListener('abort', () => reject(new Error('照合の時間切れ')), { once: true });
          timer = setTimeout(abort, cfg.timeoutMs + (batching ? runtime.remainingMs() + 250000 : 0));
        })]);
      if (!isConfirm) for (const key of ['mode', 'wait_seconds', 'batch_error']) if (ret?.[key] !== undefined) entry[key] = ret[key];
      if (isConfirm) {
        if (['batch','sync','sync-fallback'].includes(ret?.mode)) entry.mode = ret.mode;
        if (Number.isFinite(ret?.wait_seconds)) entry.wait_seconds = ret.wait_seconds;
        if (ret?.batch_error) entry.batch_error = contentModel.redactSecrets(String(ret.batch_error)).slice(0, 300);
        const stop = ret?.stopReason || ret?.stop_reason;
        if (stop) entry.stop_reason = ['end_turn','max_tokens','length','stop_sequence','refusal'].includes(stop) ? stop : '不明';
      }
      entry.output_chars = (Array.isArray(ret) || (isConfirm && ret?.verdict) ? JSON.stringify(ret) : typeof ret === 'string' ? ret : ret?.text || '').length;
      record.output_chars_total += entry.output_chars;
      if (ret?.usage) entry.usage = Object.fromEntries(Object.entries({ input_tokens: ret.usage.input_tokens ?? ret.usage.prompt_tokens,
        output_tokens: ret.usage.output_tokens ?? ret.usage.completion_tokens,
        cache_creation_input_tokens: ret.usage.cache_creation_input_tokens, cache_read_input_tokens: ret.usage.cache_read_input_tokens }).filter(([, v]) => isConfirm || cfg.provider === 'gateway' ? Number.isFinite(v) : v !== undefined));
      return ret;
    } catch (error) {
      if (!isConfirm) for (const key of ['mode', 'wait_seconds', 'batch_error']) if (error[key] !== undefined) entry[key] = error[key];
      if (isConfirm) {
        if (['batch','sync','sync-fallback'].includes(error?.mode)) entry.mode = error.mode;
        if (Number.isFinite(error?.wait_seconds)) entry.wait_seconds = error.wait_seconds;
        if (error?.batch_error) entry.batch_error = contentModel.redactSecrets(String(error.batch_error)).slice(0, 300);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (batching && entry.wait_seconds === undefined) entry.wait_seconds = Math.floor(Math.max(0, runtime.now() - started) / 1000);
      if (isConfirm) entry.batch = entry.mode === 'batch';
    }
  };
  if (confirmBatch) call.batch = async requests => {
    if (!/^claude-[A-Za-z0-9._-]+$/.test(confirmModel)) return Promise.allSettled(requests.map(req=>call(req)));
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once:true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, cfg.timeoutMs + confirmBatch.remainingMs() + 250000);
    const prepared = requests.map(req=>({ ...req, provider:'anthropic', model:confirmModel, signal:controller.signal }));
    const responses = Promise.resolve().then(async () => {
      if (options.callBatchLLM) return options.callBatchLLM(prepared);
      if (options.callLLM) {
        const results = [];
        for (let i=0;i<prepared.length;i+=3) results.push(...await Promise.allSettled(prepared.slice(i,i+3).map(options.callLLM)));
        return results;
      }
      return contentModel.generateBatchContent(prepared.map(req=>({ staticSystem:req.staticSystem || req.system,
        dynamicSystem:req.dynamicSystem || '', user:req.user })), { provider:'anthropic', model:confirmModel, maxTokens:16000,
        signal:controller.signal, timeoutMs:cfg.timeoutMs, batch:confirmBatch });
    });
    try {
      return await Promise.allSettled(requests.map((req,i)=>call(req,async()=>{
        const results = await responses;
        if (results[i]?.status !== 'fulfilled') throw results[i]?.reason || new Error('確かめのBatch失敗');
        return results[i].value;
      })));
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); controller.abort(); }
  };
  const search = options.searchEvidence || searchEvidence;
  const pageCache = {};
  const stageBCache = {};
  let uncheckedNumeric = 0;
  const addReviewItem = c => {
    if (record.review_items.some(r => claimKey(r) === claimKey(c))) return;
    // 一覧には候補の所在を残し、判定に使わない原文は重ねて保存しない。
    record.review_items.push({ ...c, evidence: (c.evidence || []).map(({ id, title, url }) => ({ id, title, url })) });
  };
  const addStageAReviewItem = c => {
    const answer = c.stage_a_answer;
    const ref = (c.evidence || []).find(e => e.id === answer.evidence)
      || { id: answer.evidence, title: answer.title || String(answer.evidence), url: answer.url || '' };
    addReviewItem({ ...c, status: `段Aの${answer.status}を要確認（段Bは裏付けあり）`,
      evidence: [ref], quote: '', evidence_id: '',
      review_reason: '段Aは食い違い・期限の書き漏れ、段Bで裏付けあり' });
  };
  const matchesCorrection = (f, c, pairs) => f.subject === c.subject || Boolean(normalizedClaim(c.sentence) && normalizedClaim(pairs.get(f.sentence) || '').includes(normalizedClaim(c.sentence)));
  const analyze = async (text, fullBody, findings = [], pairs = new Map(), previous = null) => {
    const globalCandidates = new Map();
    const candidates = c => {
      if (writerIds.length && globalCandidates.has(c)) return globalCandidates.get(c);
      const refs = search(c, options);
      const required = findings.filter(f => f.evidence_id && matchesCorrection(f, c, pairs)).map(f => f.evidence.find(e => e.id === f.evidence_id)).filter(Boolean);
      const pinned = new Map((writerIds.length ? required : [...refs.slice(0, 1), ...required]).map(e => [e.id, e]));
      if (pinned.size > 7) throw new Error('修正の根拠が候補の上限を超えました');
      // 主出典の順番を保ち、修正の根拠を検索結果より先に確保する。
      for (const ref of refs) if (!pinned.has(ref.id)) pinned.set(ref.id, ref);
      const selected = [...pinned.values()].slice(0, 7);
      if (writerIds.length) globalCandidates.set(c, selected);
      return selected;
    };
    const stageACandidates = c => {
      const refs = (options.searchWriterEvidence || searchWriterEvidence)(c, { ...options, resolvedWriterMaterials: resolvedWriter });
      const required = findings.filter(f => f.evidence_id && matchesCorrection(f, c, pairs)).map(f => f.evidence.find(e => e.id === f.evidence_id)).filter(Boolean);
      const pinned = new Map(required.map(e => [e.id, e]));
      if (pinned.size > 4) return null; // 必須の根拠を削らず、この主張だけ段Bへ直接回す。
      for (const ref of refs) if (!pinned.has(ref.id)) pinned.set(ref.id, ref);
      return [...pinned.values()].slice(0, 4);
    };
    const extracted = await extractClaims(text, call, writerIds.length ? { ...cfg, writer_materials: writerIds, resolvedWriterMaterials: resolvedWriter } : cfg);
    record.dropped += extracted.dropped;
    record.discarded += extracted.discarded;
    if (writerIds.length) record.calculated_skipped += extracted.calculated_skipped || 0;
    for (const c of [...extracted.droppedClaims, ...extracted.discardedClaims]) {
      if (isNumericClaim(c) || (!NUMERIC_TYPES.has(c.type) && !REVIEW_TYPES.has(c.type))) uncheckedNumeric++;
      else addReviewItem({ ...c, evidence: writerIds.length ? stageACandidates(c) || candidates(c) : candidates(c) });
    }
    if (!extracted.claims.length && !extracted.discarded && text.replace(/^\s*#{1,6}\s+.*$/gm, '').trim().length >= 200) {
      const error = new Error('主張を抜き出せませんでした'); error.emptyClaims = true; throw error;
    }
    let claims = extracted.claims, reused = [];
    if (previous) {
      const { subjects, needsJudge } = affectedClaims(options.previousBody, fullBody, previous, claims);
      const fullUnits = splitUnits(fullBody);
      const retained = previous.filter(c => actualSentence(fullBody, c.sentence) === c.sentence);
      reused = retained.filter(c => !needsJudge(c));
      const rejudged = retained.filter(needsJudge).map(c => ({ id: c.id, sentence: c.sentence, type: c.type, subject: c.subject, claim: c.claim,
        ...(typeof c.type_label === 'string' ? { type_label: c.type_label } : {}),
        heading: fullUnits.filter(u => u.heading && u.start < (fullUnits.find(u => !u.heading && u.text === c.sentence)?.start ?? 0))
          .at(-1)?.text.replace(/^\s*#{1,6}\s+/, '') || '' }));
      const seen = new Set(claims.map(claimKey));
      claims = [...claims, ...rejudged.filter(c => !seen.has(claimKey(c)))];
      record.incremental = { reused: reused.length, rejudged: claims.length, subjects };
      claims = claims.map((c, i) => ({ ...c, id: `c${i + 1}` }));
      reused = reused.map((c, i) => ({ ...c, id: `c${claims.length + i + 1}`, s: fullUnits.find(u => !u.heading && u.text === c.sentence)?.s }));
      if (writerIds.length) for (const c of reused) if (c.stage_a_answer) addStageAReviewItem(c);
    }
    if (!writerIds.length) {
      const evidence = Object.fromEntries(claims.map(c => [c.id, candidates(c)]));
      return [...await judgeClaims(claims, evidence, fullBody, call, { ...options, pageCache, batch }), ...reused];
    }
    const answerTally = new Map(), deadlineSubjects = new Set();
    const loadText = options.loadEvidenceText || (ref => ['qa', 'change'].includes(ref.kind)
      ? resolveMaterial(materialId(ref))?.text : require('./fact-evidence').loadEvidenceText(ref));
    const judgeStage = async (stage, items, select, cache) => {
      const evidence = Object.fromEntries(items.map(c => [c.id, select(c)]));
      const start = record.input_chars_total;
      record.stages[stage].claims += items.length;
      record.stages[stage].pages += new Set(Object.values(evidence).flat().map(e => e.id)).size;
      try {
        const result = await judgeClaims(items, evidence, fullBody, stage === 'B' ? req => call({ ...req, stageB: true }) : call,
          { ...options, pageCache: cache, batch: stage === 'B' ? null : batch, loadEvidenceText: loadText,
            [STAGE_TALLY]: { answers: answerTally, deadlineSubjects } });
        await checkConditions(result, call, addReviewItem, { ...options, writerCandidates: stage === 'B' ? stageAEvidence : null }, fullBody, stage, evidence);
        for (const c of result) if (!confirming && c.status === '食い違い' && !NUMERIC_TYPES.has(c.type) &&
            (stage !== 'A' || canFinalizeStageA(c, evidence[c.id])) && unrelatedCorrect(c, c.correct)) {
          // 無関係な修正案は採らず、食い違いによる承認停止を維持する。
          c.correct_requires_review = true;
        }
        if (!confirming && stage === 'B') for (const c of result) if (['食い違い', '期限の書き漏れ'].includes(c.status) &&
            !canFinalizeStageA(c, stageAEvidence.get(c.id) || [])) c.evidence_requires_review = true;
        return result.map(c => ({ ...c, stage }));
      } finally { record.stages[stage].input_chars += record.input_chars_total - start; }
    };
    const stageAEvidence = new Map(claims.map(c => [c.id, stageACandidates(c)]));
    const directB = new Set(claims.filter(c => stageAEvidence.get(c.id) === null).map(c => c.id));
    const stageA = await judgeStage('A', claims.filter(c => !directB.has(c.id)), c => stageAEvidence.get(c.id), pageCache);
    const byClaimId = new Map(claims.map(c => [c.id, c]));
    const retry = new Set([...directB, ...stageA.filter(c => shouldUseStageB(c, () => candidates(byClaimId.get(c.id)), resolvedWriter, stageAEvidence.get(c.id), confirming)).map(c => c.id)]);
    const stageATally = new Map(answerTally);
    deadlineSubjects.clear();
    for (const c of stageA) if (!retry.has(c.id) && c.status === '期限の書き漏れ') deadlineSubjects.add(c.subject);
    const stageB = retry.size ? await judgeStage('B', claims.filter(c => retry.has(c.id)), candidates, stageBCache) : [];
    // 段Bの資料なし（候補・答えなしや却下を含む）では、段Aで落ちた答えの歯止めを消さない。
    for (const c of stageB) if (c.status === '資料なし' && stageATally.has(c.id)) {
      const previous = stageATally.get(c.id), current = answerTally.get(c.id);
      // 段B自身で却下・欠落した答えも数える。候補なしで行が増えなかった場合は二重に数えない。
      if (current !== previous) {
        const merged = mergeTally(new Map([['A', previous], ['B', current]]));
        merged.total = Math.max(previous.total, current.total); // 同じ主張を2件とは数えない。
        answerTally.set(c.id, merged);
      }
    }
    for (const c of stageB) {
      const previous = stageA.find(a => a.id === c.id);
      const answer = ['食い違い', '期限の書き漏れ'].includes(previous?.status)
        ? { status: previous.status, evidence: previous.evidence_id, quote: previous.quote.slice(0, 200),
          correct: previous.correct.replace(/\s+/g, ' ').trim().slice(0, 200) }
        : previous?.rejected_answer;
      if (c.status === '裏付けあり' && ['食い違い', '期限の書き漏れ'].includes(answer?.status)) {
        const ref = [...previous.evidence, ...[...stageAEvidence.values()].flatMap(refs => refs || []),
          ...(pageCache.groups || []).flatMap(group => group.pack.pages.map(page => page.ref))]
          .find(e => e.id === answer.evidence);
        c.stage_a_answer = { ...answer, ...(ref ? { title: ref.title, url: ref.url } : {}) };
        addStageAReviewItem({ ...c, evidence: [...c.evidence, ...(ref ? [ref] : [])] });
      }
    }
    const final = new Map(stageB.map(c => [c.id, c]));
    const tally = { declared: 0, rejected: 0, missing: 0, total: 0, samples: [] };
    for (const row of answerTally.values()) {
      for (const key of ['declared', 'rejected', 'missing', 'total']) tally[key] += row[key];
      tally.samples.push(...row.samples);
    }
    checkTally(tally, cfg);
    const original = new Map(stageA.map(c => [c.id, c]));
    const adopted = [...claims.map(c => final.get(c.id) || original.get(c.id)).filter(Boolean), ...reused];
    if (!confirming) for (const c of reused) if (c.stage === 'B' && ['食い違い', '期限の書き漏れ'].includes(c.status) &&
        !canFinalizeStageA(c, stageACandidates(c) || [])) c.evidence_requires_review = true;
    for (const c of adopted) if (c.correct_requires_review || c.evidence_requires_review) addReviewItem(c);
    return adopted;
  };
  let revisedBody = body;
  try {
    record.claims = options.previousClaims ? await analyze(changedText(options.previousBody, body), body, [], new Map(), options.previousClaims) : await analyze(body, body);
    const missingReview = writerIds.length ? record.claims.filter(c => c.status === '資料なし' && REVIEW_TYPES.has(c.type) && !NO_REPAIR_REASONS.has(c.reject_reason)) : [];
    const missingSentences = new Set(missingReview.map(c => c.sentence));
    const tooManyMissing = missingSentences.size > 8 || missingReview.length > record.claims.length * 0.2;
    const autoReview = missingSentences.size > 0 && !tooManyMissing;
    const findings = record.claims.filter(c => (blockingFinding(c) || (autoReview && missingReview.includes(c))) && !NO_REPAIR_REASONS.has(c.reject_reason) &&
      (confirming || (!c.correct_requires_review && !c.evidence_requires_review))).map(c => ({ ...c,
      keep: c.status === '資料なし' ? record.claims.filter(k => k.sentence === c.sentence && k.status === '裏付けあり' && k.evidence_outside_candidates !== true)
        .map(({ type, subject, claim }) => ({ type, subject, claim })) : [],
    }));
    const onlyConditions = findings.length > 0 && findings.every(c => c.condition_mismatch);
    const beforeRepair = { dropped: record.dropped, discarded: record.discarded, calculated: record.calculated_skipped,
      uncheckedNumeric, review: [...record.review_items] };
    let repairPairs = new Map();
    const reviewCondition = c => {
      addReviewItem({ ...c, status: '条件の違いを要確認' });
      c.status = '裏付けあり'; c.correct = ''; delete c.condition_mismatch;
    };
    if (confirming) {
      if (options.repair !== false) revisedBody = await applyConfirmations(body, findings, record, call, options,
        /^claude-[A-Za-z0-9._-]+$/.test(confirmModel) ? confirmModel : '設定不正');
    } else {
    if (findings.length && options.repair !== false) {
      let repair;
      try { repair = await repairBody(body, findings, call, options); }
      catch (error) {
        if (!onlyConditions) throw error;
        repair = { accepted: false, reason: '条件確認の修正案を採れませんでした' };
      }
      if (repair.accepted) {
        revisedBody = repair.body;
        let changes = changedText(body, revisedBody);
        const pairs = correctionPairs(body, revisedBody, findings, repair.replacements);
        repairPairs = pairs;
        for (const [sentence, replacement] of repair.replacements) {
          const f = findings.find(f => f.sentence === sentence);
          if (replacement && replacement !== f.sentence && !changes.includes(replacement) && revisedBody.includes(replacement)) changes += `\n${f.heading ? '## ' + f.heading : ''}\n${replacement}`;
        }
        rechecking = true;
        try { record.rechecked = changes.trim() ? await analyze(changes, revisedBody, findings, pairs) : []; }
        catch (error) { if (!onlyConditions) throw error; record.rechecked = []; }
        // 再照合の条件確認だけの誤警報は、既に通った判定を取り消さない。
        for (const c of record.rechecked) if (c.condition_mismatch) reviewCondition(c);
        if (writerIds.length) for (const r of record.rechecked) {
          const f = findings.find(f => matchesCorrection(f, r, pairs) && unchangedNumericClaim(f, r, pairs.get(f.sentence) || '', record.claims));
          if (!f) continue;
          r.unchanged_numeric = true;
          if (!record.claims.some(c => c.type === r.type && c.subject === r.subject && JSON.stringify(normalizedNumbers(c.claim)) === JSON.stringify(normalizedNumbers(r.claim)))) addReviewItem(r);
        }
        const blocksRepair = c => blockingFinding(c) && !(writerIds.length && c.unchanged_numeric);
        record.corrections = findings.map(f => ({ ...f, before: f.sentence,
          after: repair.rejected.has(f.id) ? '' : pairs.get(f.sentence) || '',
          generalized: f.status === '資料なし',
          ...(repair.rejected.has(f.id) ? { reason: repair.rejected.get(f.id) } : {}),
          resolved: !repair.rejected.has(f.id) && !revisedBody.includes(f.sentence) && !record.rechecked.some(c => blocksRepair(c) && matchesCorrection(f, c, pairs)),
        }));
        // 期限追記は元の文を残せる。解決の裏付けは自身の置き換え文に限り、止める側は広い対応を維持する。
        for (const c of record.corrections) if (['食い違い', '期限の書き漏れ'].includes(c.status)) {
          c.resolved = !repair.rejected.has(c.id) && changes.trim().length > 0 && record.rechecked.some(r =>
            r.status === '裏付けあり' && (!c.condition_mismatch || (r.type === c.type && r.subject === c.subject)) &&
            Boolean(normalizedClaim(r.sentence)) && normalizedClaim(pairs.get(c.sentence) || '').includes(normalizedClaim(r.sentence))) &&
            !record.rechecked.some(r => matchesCorrection(c, r, pairs) && blocksRepair(r));
        }
        // 数字を残した一般化は、その置き換え自身の数字が再照合で裏付けられたときだけ解決する。
        for (const c of record.corrections) if (c.status === '資料なし' && c.supported_numbers?.length) {
          const required = c.supported_numbers.flatMap(n => normalizedNumbers(n));
          const supported = record.rechecked.filter(r => r.status === '裏付けあり' && ['金額', '割合', '期限', '適用年'].includes(r.type) && normalizedClaim(r.sentence) &&
            normalizedClaim(pairs.get(c.sentence) || '').includes(normalizedClaim(r.sentence))).flatMap(r => {
            const summary = normalizedNumbers(r.claim), sentence = normalizedNumbers(r.sentence);
            return summary.filter(n => n !== null && sentence.includes(n));
          });
          c.resolved = c.resolved && required.length > 0 && !required.includes(null) && required.every(n => supported.includes(n));
        }
        if (writerIds.length) for (const c of record.corrections) if (c.generalized && REVIEW_TYPES.has(c.type) &&
            record.rechecked.some(r => r.status !== '裏付けあり' && matchesCorrection(c, r, pairs))) c.resolved = false;
      } else record.repair_warning = repair.reason;
    }
    const unverifiedConditions = record.claims.filter(c => c.condition_mismatch && !record.corrections.find(f => f.id === c.id)?.resolved);
    if (unverifiedConditions.length && onlyConditions && unverifiedConditions.length === findings.length) {
      // 判定が裏付けた元の文へ戻す。採れなかった条件修正の再照合結果を承認判断に混ぜない。
      revisedBody = body; record.rechecked = [];
      record.dropped = beforeRepair.dropped; record.discarded = beforeRepair.discarded;
      record.calculated_skipped = beforeRepair.calculated; uncheckedNumeric = beforeRepair.uncheckedNumeric;
      record.review_items = beforeRepair.review;
      record.corrections = [];
      for (const c of record.claims) if (c.condition_mismatch) reviewCondition(c);
    } else for (const c of unverifiedConditions) {
      const replacement = repairPairs.get(c.sentence);
      if (replacement && replacement !== c.sentence && !findings.some(f => f.sentence === c.sentence && !f.condition_mismatch)) {
        // 置き換えが複数文でも丸ごと戻し、別の指摘で確かめた編集だけを元本文に適用する。
        repairPairs.delete(c.sentence);
        revisedBody = body;
        const edits = splitUnits(body).filter(u => !u.heading && repairPairs.has(u.text));
        for (const u of edits.sort((a,b) => b.start - a.start)) revisedBody = revisedBody.slice(0,u.start) + repairPairs.get(u.text) + revisedBody.slice(u.end);
        record.rechecked = record.rechecked.filter(r => !normalizedClaim(replacement).includes(normalizedClaim(r.sentence)));
        for (const f of record.corrections.filter(f => f.sentence === c.sentence)) { f.after = ''; f.resolved = false; }
      }
      reviewCondition(c);
      record.corrections = record.corrections.filter(f => !(f.id === c.id && f.condition_mismatch && !f.resolved));
    }
    }
    const unresolved = record.claims.filter(c => c.status !== '裏付けあり' && !record.corrections.find(f => f.id === c.id)?.resolved);
    const pending = [...unresolved, ...record.rechecked.filter(c => c.status !== '裏付けあり' && !(writerIds.length && c.unchanged_numeric))];
    for (const c of pending) if (!blockingFinding(c)) addReviewItem(c);
    record.remaining = pending.filter(blockingFinding);
    const mismatches = record.remaining.filter(c => ['食い違い', '期限の書き漏れ'].includes(c.status)).length;
    // 数字の未照合と、種類を問わない食い違い・期限の書き漏れは引き続き止める。
    record.status = record.remaining.length || uncheckedNumeric ? 'revise' : 'ok';
    const repaired = record.corrections.filter(c => c.resolved).length;
    record.summary = `主張 ${record.claims.length} 件: 裏付けあり ${record.claims.filter(c => c.status === '裏付けあり').length}・修正 ${repaired}（食い違い ${record.corrections.filter(c => c.resolved && c.status === '食い違い').length}・期限 ${record.corrections.filter(c => c.resolved && c.status === '期限の書き漏れ').length}・具体を外した ${record.corrections.filter(c => c.resolved && c.generalized).length}）・残った食い違い ${mismatches}・未解決 ${record.remaining.length}・上限で未照合 ${record.dropped}`;
    record.summary += `・捨てた主張 ${record.discarded}`;
    record.summary += `・人が確かめる箇所 ${record.review_items.length} 件`;
    if (record.confirm) record.summary += `・Opus の確かめ ${record.confirm.checked} 件（書き換え ${record.confirm.rewritten}・具体を外した ${record.confirm.generalized}・残す ${record.confirm.kept}・判断できない ${record.confirm.unknown}、うち答えを採らなかった ${record.confirm.rejected}）・${record.confirm.calls} 回`;
    if (record.confirm?.not_stated_limit) record.summary += '・資料に記載の無い具体が多いため外していません';
    if (writerIds.length && record.calculated_skipped) record.summary += `・試算の数字として照合しなかった ${record.calculated_skipped} 件`;
    if (writerIds.length && missingReview.length && tooManyMissing) record.summary += '・資料なしが多いため具体を外していません';
    const outsideCount = outsideCandidateClaims(record).length;
    if (outsideCount) record.summary += `・候補の外の資料で裏付け ${outsideCount} 件`;
  } catch (error) {
    // 要約は固定文。原因は鍵を伏せた短い診断だけを error に残す（原因が分からないまま全部止まるのを防ぐ）。
    const reason=error.name==='GatewayTimeoutError'||error.message==='照合の時間切れ'?'時間切れ':error.name==='GatewayNetworkError'?'通信失敗':error.name==='GatewayError'&&error.status>=500&&error.status<=599?'Gateway 5xx':'';
    if(cfg.provider==='gateway'&&!options[GATEWAY_FALLBACK]&&!options.signal?.aborted&&reason){
      const fallback=await checkFacts(body,{...options,provider:'anthropic',model:'claude-opus-5-5',extractModel:'claude-opus-5-5',writerMaterials:false,writer_materials:[],previousBody:undefined,previousClaims:undefined,[GATEWAY_FALLBACK]:true});
      fallback.record.fallback={from:'gateway',reason};fallback.record.summary+='・GLM の照合が終わらなかったため Opus で照合';return fallback;
    }
    record.status = 'not_run';
    record.summary = error.emptyClaims ? '主張を抜き出せませんでした' : '照合を実施できませんでした（設定・API応答・カタログを確認してください）';
    if (!error.emptyClaims) {
      record.error = error.diagnostic || contentModel.safeDiagnostic(error);
      console.warn(`[fact-check] 照合を実施できませんでした: ${record.error}`);
    }
    revisedBody = body;
    record.corrections = [];
  }
  record.body_sha256 = bodyHash(revisedBody);
  if (record.input_chars_total > 150000) {
    const warning = `照合の入力が多い（${record.input_chars_total} 字）`;
    record.summary += ` / ${warning}`;
    console.warn(`[fact-check] ${warning}`);
  }
  if (writerIds.length) {
    const effective = [...record.claims, ...record.rechecked];
    record.summary += `・書き手の資料で判定 ${effective.filter(c => c.stage === 'A').length} 件・全体を探した ${effective.filter(c => c.stage === 'B').length} 件`;
  }
  record.summary += unresolvedSummary;
  return { body: revisedBody, record };
}

/** 確認を通った食い違いも、全体検索に根拠が無ければ段Bで判定し直す。 */
function shouldUseStageB(result, globalCandidates, refs = [], stageACandidates = [], confirming = false) {
  if (NO_REPAIR_REASONS.has(result.reject_reason)) return false;
  if (!confirming && ['食い違い', '期限の書き漏れ'].includes(result.status) && !canFinalizeStageA(result, stageACandidates)) return true;
  if (result.evidence_outside_candidates && canUseWriterEvidence(result, result.status, result.evidence.find(e => e.id === result.evidence_id), refs, confirming)) return false;
  return result.status === '資料なし' || (['食い違い', '期限の書き漏れ'].includes(result.status) &&
    !globalCandidates().some(ref => ref.id === result.evidence_id));
}

function updateMeta(raw, updates, body) {
  const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) throw new Error('frontmatter がありません');
  let fm = m[2].replace(/\r/g, '');
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}: ${['number', 'boolean'].includes(typeof value) ? value : JSON.stringify(String(value ?? ''))}`;
    const re = new RegExp(`^${key}:.*$`, 'm');
    fm = re.test(fm) ? fm.replace(re, () => line) : fm + '\n' + line;
  }
  return `---\n${fm}\n---\n${body === undefined ? m[4].replace(/\r\n/g, '\n') : body}`;
}

function applyFactResult(raw, result, options = {}) {
  const { data: meta } = matter(raw);
  const cfg = config(options);
  const ownRevise = ['revise', 'not_run'].includes(meta.fact_check_status) && meta.recommendation === 'revise' &&
    Object.hasOwn(meta, 'fact_check_prev_recommendation');
  const previous = ownRevise ? meta.fact_check_prev_recommendation : meta.recommendation || '';
  const block = result.record.status === 'revise' || (result.record.status === 'not_run' && !cfg.failOpen);
  const warnings = String(meta.review_warning || '').replace(WARNING_RE, '').replace(/(?:\s*\/\s*)+$/, '').trim();
  const stale = [...result.record.claims, ...(result.record.rechecked || [])].some(c => c.warning);
  const warning = block || result.record.status === 'not_run' || stale || result.record.repair_warning
    ? `【事実の照合】${result.record.summary}${result.record.repair_warning ? ' / ' + result.record.repair_warning : ''}${stale ? ' / 注意: 根拠の基準日が古い' : ''}【/事実の照合】` : '';
  return updateMeta(raw, {
    fact_check_version: 1, fact_check_status: result.record.status, fact_check_summary: result.record.summary,
    fact_check_model: result.record.model, fact_check_prev_recommendation: previous, fact_check_blocking: block,
    recommendation: previous === 'reject' ? 'reject' : block ? 'revise' : previous,
    review_warning: [warnings, warning].filter(Boolean).join(' / '),
  }, result.body);
}

function recordPath(slug, dir = path.join(ROOT, 'data', 'fact-check')) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug || '')) throw new Error('照合記録のslugが不正です');
  return path.join(dir, `${slug}.json`);
}

async function checkArticle(raw, options = {}) {
  const { data: meta, content: body } = matter(raw);
  const slug = String(meta.slug || options.slug || '');
  const file = recordPath(slug, options.recordDir);
  let incremental = {};
  if (typeof options.previousRaw === 'string') {
    try {
      const before = matter(options.previousRaw);
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cfg = config(options);
      const currentWriter = writerMaterials({ ...articleEvidenceOptions(meta), ...options });
      const writerMatches = JSON.stringify(prior.writer_materials || null) === JSON.stringify(currentWriter.length ? materialFingerprint(currentWriter) : null);
      const rows = [...(prior.claims || []), ...(prior.rechecked || [])];
      const validRow = c => c && typeof c.id === 'string' && typeof c.sentence === 'string' && c.sentence.trim() &&
        typeof c.subject === 'string' && c.subject.trim() && typeof c.claim === 'string' && typeof c.heading === 'string' &&
        TYPES.includes(c.type) && STATUSES.includes(c.status) && typeof c.quote === 'string' && typeof c.correct === 'string' &&
        (c.evidence_outside_candidates !== true || canUseOutsideEvidence(c, c.status) ||
          canUseWriterEvidence(c, c.status, evidenceRefs(prior, c).find(e => e.id === c.evidence_id), resolveWriterMaterials(currentWriter))) &&
        (Array.isArray(c.evidence) || (Array.isArray(c.evidence_ids) && c.evidence_ids.every(id => prior.evidence?.[id]))) &&
        (c.status === '資料なし' || (typeof c.evidence_id === 'string' && c.evidence_id && c.quote.trim()));
      if (!confirmationEnabled({ ...articleEvidenceOptions(meta), ...options }) && !prior.confirm && writerMatches && prior.version === 1 && prior.logic_version === LOGIC_VERSION && prior.incremental === undefined && prior.slug === slug && before.data.slug === slug && prior.body_sha256 === bodyHash(before.content) &&
          ['ok', 'revise'].includes(prior.status) && prior.model === cfg.model && prior.provider === cfg.provider &&
          (prior.extract_model ?? prior.model) === cfg.extractModel && (prior.effort ?? null) === cfg.effort &&
          (prior.extract_effort ?? prior.effort ?? null) === cfg.extractEffort &&
          Array.isArray(prior.claims) && Array.isArray(prior.rechecked) && Array.isArray(prior.corrections) &&
          prior.dropped === 0 && prior.discarded === 0 && rows.every(validRow)) {
        const resolved = new Set(prior.corrections.filter(c => c.resolved).map(c => c.id));
        const effective = [...prior.claims.filter(c => !resolved.has(c.id)), ...prior.rechecked];
        const seen = new Set();
        const previousClaims = effective.filter(c => {
          const key = claimKey(c);
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }).map(c => ({ ...c, evidence: evidenceRefs(prior, c) }));
        const validRefs = c => c.evidence.every(ref => ref && typeof ref.id === 'string' && ref.id && typeof ref.text === 'string' &&
          (!ref.text_ranges || (Array.isArray(ref.text_ranges) && ref.text_ranges.every(range => Array.isArray(range) && range.length === 2 &&
            range.every(Number.isInteger) && range[0] >= 0 && range[1] >= range[0] && range[1] <= ref.text.length)))) &&
          (c.status === '資料なし' || c.evidence.some(ref => ref.id === c.evidence_id && quoteExists(c.quote, ref))) &&
          // 旧03uで候補外資料から作られ、候補に出どころが無い保持数字は再利用しない。
          (!c.supported_numbers?.length || c.evidence.some(ref => ref.id === c.rejected_answer?.evidence));
        if (!previousClaims.every(validRefs)) throw new Error('前回の照合記録の根拠が不正です');
        incremental = { previousBody: before.content, previousClaims };
      }
    } catch (_) { /* 読めない記録は使い回さず、全体を照合する。 */ }
  }
  const result = await checkFacts(body, { ...articleEvidenceOptions(meta), ...options, ...incremental });
  result.record.slug = slug;
  if (options.persist !== false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(compactRecord(result.record), null, 2) + '\n', 'utf8');
  }
  return { ...result, content: applyFactResult(raw, result, options), recordFile: file };
}

/** 下書きと公開済み記事の照合に、同じ記事資料を渡す。 */
function articleEvidenceOptions(meta) {
  return { tax_terms: meta.tax_terms, source_bundle: meta.source_bundle, tax_domain: meta.tax_domain, source_url: meta.source_url,
    source_supplements: [...(Array.isArray(meta.source_supplements) ? meta.source_supplements : []),
      ...[2, 3, 4].filter(n => meta[`source_${n}_url`]).map(n => ({ url: meta[`source_${n}_url`] }))],
    ...(meta.fact_materials ? { writer_materials: String(meta.fact_materials).split(';').filter(Boolean) } : {}) };
}

/** 再生成モデルに照合の管理項目や既存の品質判定を書き換えさせない。 */
function inheritFactMetadata(original, regenerated) {
  const { data: before } = matter(original);
  const { data: after } = matter(regenerated);
  const planned = Object.hasOwn(before, 'fact_plan_status');
  const updates = Object.fromEntries(Object.entries(before).filter(([key]) => key.startsWith('fact_check_')));
  for (const key of ['fact_plan_status', 'fact_plan', 'fact_plan_missing', 'fact_materials']) {
    if (before[key] !== undefined) updates[key] = before[key];
  }
  if (before.fact_materials && after.fact_materials) {
    const recorded = String(before.fact_materials).split(';');
    const added = String(after.fact_materials).split(';').filter(id => !planned || recorded.includes(id) || resolveWriterMaterials([id]).length);
    updates.fact_materials = [...new Set([...recorded, ...added])].filter(Boolean).join(';');
  }
  if (before.fact_check_version) {
    const previousWarning = String(before.review_warning || '');
    const addedWarning = String(after.review_warning || '').replace(WARNING_RE, '').replace(/(?:\s*\/\s*)+$/, '').trim();
    const previousParts = planned ? previousWarning.split(' / ').map(part => part.trim().replace(/^(?:\s*\/\s*)+/, '')).filter(Boolean) : [];
    const addedParts = planned ? addedWarning.split(' / ').map(part => part.trim().replace(/^(?:\s*\/\s*)+/, '')).filter(Boolean) : [];
    const addedOtherWarning = planned
      ? addedParts.some(part => !part.startsWith('計画:') && !previousParts.includes(part))
      : addedWarning && !previousWarning.includes(addedWarning);
    const newBlocking = after.recommendation === 'reject' ||
      (after.recommendation === 'revise' && (before.recommendation !== 'revise' || addedOtherWarning));
    updates.recommendation = newBlocking ? after.recommendation : before.recommendation || '';
    if (newBlocking) updates.fact_check_prev_recommendation = after.recommendation;
    updates.review_warning = planned ? [...new Set([...previousParts, ...addedParts])].join(' / ')
      : [previousWarning, addedOtherWarning ? addedWarning : ''].filter(Boolean).join(' / ');
  } else if (before.recommendation === 'revise' || before.recommendation === 'reject') {
    updates.recommendation = before.recommendation;
  }
  return Object.keys(updates).length ? updateMeta(regenerated, updates) : regenerated;
}

module.exports = { extractClaims, judgeClaims, searchEvidence, repairBody, repairInstructions, checkFacts, checkArticle,
  articleEvidenceOptions,
  applyFactResult, updateMeta, recordPath, changedText, preservesOtherText, normalizedQuote, sourceDate, config, inheritFactMetadata,
  normalizeBody, bodyHash, compactRecord, evidenceRefs, outsideCandidateClaims, normalizedNumbers, sufficientQuote, quoteParts, correctionPairs, WARNING_RE };
