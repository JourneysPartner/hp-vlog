'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { deflateRawSync, inflateRawSync } = require('zlib');
const matter = require('gray-matter');
const contentModel = require('./content-model');
const partial = require('./partial-revise');
const { searchEvidence } = require('./fact-evidence');
const { positiveLimit } = require('./source-excerpt');
const { LAW_SCOPE_RULE } = require('./grounding-rules');
const { tokenizeForMatcher } = require('./nta-source-matcher');
const { splitUnits, renderUnits, rangeText, unitNumber, basisRanges } = require('./fact-units');
const { buildPages, pageGroups } = require('./fact-pages');
const TYPES = ['金額', '期限', '割合', '適用年', '番号', '要件', '判定', '手続'];
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
    maxClaims: positiveLimit(options.maxClaims ?? process.env.FACT_CHECK_MAX_CLAIMS, 40),
    maxNumericClaims: positiveLimit(options.maxNumericClaims ?? process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS, 120),
    timeoutMs: positiveLimit(options.timeoutMs ?? process.env.FACT_CHECK_TIMEOUT_MS, 600000) };
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
      if (!numbers.every(n => sentenceNumbers.includes(n))) return false;
      if (!numbers.length) numbers = sentenceNumbers;
    }
    if (numbers.includes(null)) return false;
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
  return [...new Set(forms.filter(f => supported.includes(f.number) &&
    !citations.some(m => f.start >= m.index && f.end <= m.index + m[0].length)).map(f =>
    text.slice(positions[f.start][0], positions[f.end - 1][1])).filter(form => {
      const numbers = normalizedNumbers(form);
      return numbers.length && numbers.every(n => supported.includes(n));
    }))];
}

function partialQuoteNumbers(claim, grounded, ref) {
  const checked = numberCheckClaim(claim, ref);
  const summary = normalizedNumbers(checked.claim);
  const sentence = normalizedNumbers(checked.sentence);
  if (!summary.every(n => sentence.includes(n)) || evidenceTexts(ref).some(text => normalizedNumbers(text).includes(null))) return null;
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
  const read = async rows => parseJson(await callLLM({ task: 'extract', maxTokens: 8000,
    system: '記事本文から税務の事実を述べた文を漏れなく抜き出してください。出力は JSON 配列だけです。要件・金額・割合・期限・適用年・手続・番号・判定を対象にします。type は次の8語のどれか1語をそのまま書いてください: 要件・金額・割合・期限・適用年・手続・番号・判定。（要件＝対象・条件、期限＝保存期間を含む、手続＝届出・申請・選択、番号＝条文・通達・タックスアンサー）s は主張を述べた本文の文の番号、subject は制度名・論点名、claim は主張の1文要約です。claim は60文字以内にしてください。想定と明示された設例の金額は対象外です。ただし設例中でも税率・控除額など制度の数値は対象です。制度を説明する文には、期限を書いていなくても要件や判定の主張を作り、期限の書き漏れを判定できるようにしてください。番号だけの引用も対象です。形は [{s,type,subject,claim}] です。',
    user: renderUnits(rows),
  }));
  let data;
  try { data = await read(units); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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
      const contains = u => {
        const present = normalizedNumbers(u.text);
        const dates = normalizedNumbers(withoutAsOfDates(normalizedQuote(u.text)));
        // 年だけの例外は同じ文の同じ元号・年に限定し、基準日や別の文から補わない。
        return numbers.every(n => present.includes(n) || (typeof n === 'string' && /^日付:[^-]+$/.test(n) && dates.some(d => d?.startsWith(n + '-'))));
      };
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
    if (!sentence || !TYPES.includes(c.type) || typeof c.subject !== 'string' || !c.subject.trim() || typeof c.claim !== 'string') {
      discardedClaims.push({ ...fields({ ...c, sentence: sentence || (typeof c?.claim === 'string' ? c.claim : '') }), status: sentence ? '主張の形式が不正' : '本文に見つからない' });
      continue;
    }
    const key = claimKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key); valid.push(resolved);
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
    dropped: droppedClaims.length, discarded: discardedClaims.length, droppedClaims, discardedClaims };
}

// 同じ文・種類・制度名でも、要約の数字が違えば別の主張（例: 48万円 と 2,400万円）。
// 数字を見ずにまとめると、2 つ目の数字が照合されないまま消えて止まらない。
function claimKey(c) {
  return `${c.sentence}:${c.type}:${c.subject}:${JSON.stringify([...new Set(normalizedNumbers(c.claim).map(String))].sort())}`;
}

// 照合の作り（抜き出しの重複除去・判定の指示文など）を変えたら上げる。版の違う記録は差し戻しで使い回さない。
const LOGIC_VERSION = '03u';

// 同じ制度の 2 件目の期限の書き漏れは、根拠を確かめていないので自動で直さず、止めて人が確かめる。
const NO_REPAIR_REASONS = new Set(['同じ制度の期限の書き漏れは記録済み']);

function blockingFinding(c) {
  return c.status !== '裏付けあり' && !(c.status === '資料なし' && (REVIEW_TYPES.has(c.type) || (NUMERIC_TYPES.has(c.type) && !isNumericClaim(c))));
}

function sourceDate(version) {
  const s = String(version || '');
  const era = s.match(/(令和|平成)(元|\d+)年(\d+)月(\d+)日/);
  if (era) return new Date(Date.UTC((era[1] === '令和' ? 2018 : 1988) + (era[2] === '元' ? 1 : Number(era[2])), Number(era[3]) - 1, Number(era[4])));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10));
  return null;
}

async function judgeClaims(claims, evidence, body, callLLM, options = {}) {
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
  const deadlineSubjects = new Set();
  const tally = { declared: 0, rejected: 0, missing: 0, total: 0, samples: [] };
  const instruction = `主張を添付した原文だけで照合してください。evidence の中の、各主張の evidence_ids の資料を優先して根拠にしてください。evidence_ids の資料に根拠が無く、この資料表の別の資料に根拠があるときは、その資料の番号を evidence_id に書いてかまいません。判断できなければ資料なしにする。記憶で補わない。括弧書き・ただし書きの対象を取り違えない。${LAW_SCOPE_RULE} 出力は [{id,status,evidence_id,basis,correct}] の形のJSON配列だけです（correct は食い違い・期限の書き漏れのときだけ、資料なしでは evidence_id・basis も書かない）。statusは裏付けあり／食い違い／資料なし／期限の書き漏れ。裏付けあり・食い違い・期限の書き漏れでは basis に根拠の文の番号（連続4つまで）を書き（金額・期限・割合・適用年・番号の主張は連続2つまで）、evidence_id にその資料の番号を書いてください。食い違いには correct に原文に基づく正しい内容を書く。制度の適用期限が原文にあるのに番号付きの本文のどこにも書かれていない場合、制度ごとに1件だけ期限の書き漏れとし、correctに期限を書いてください。設例の額を制度の上限と混同しないでください。その主張の数字・期間そのものが、原文で適用時期によって段階的に変わるのに、番号付きの本文のどこにも段階や対象の時期が書かれていない場合に限り、食い違いとし、correct に段階を書いてください。特定の年分の値として正しく書いている場合は裏付けありとしてください。数字の根拠が同じ資料の離れた2か所にあるときに限り、basis に範囲を2つまで "12-13,30" の形で書いてください。`;
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
      console.log(`[fact-check] 判定の出力（先頭）: ${String(typeof ret === 'string' ? ret : Array.isArray(ret) ? JSON.stringify(ret) : ret?.text || '').slice(0, 1500)}`);
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
      const page = evidenceNo ? pages.find(p => p.number === evidenceNo) : null;
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
        if (status === '裏付けあり' && ['金額', '割合', '期限', '適用年'].includes(c.type) && rejected === '引用が短い・数字が引用の近くに無い') {
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
      const outsideCandidates = status !== '資料なし' && page && !candidates.some(e => e.id === page.id);
      if (outsideCandidates) candidates.push(page.ref);
      const date = ref && sourceDate(ref.law_version);
      const cutoff = new Date(options.now || new Date());
      cutoff.setUTCMonth(cutoff.getUTCMonth() - 18);
      results.set(c.id, { id: c.id, sentence: c.sentence, heading: c.heading, type: c.type, subject: c.subject, claim: c.claim,
        ...(typeof c.type_label === 'string' ? { type_label: c.type_label } : {}),
        s: units.find(u => !u.heading && u.text === c.sentence)?.s,
        status, quote: status === '資料なし' ? '' : quote, correct: status === '資料なし' ? '' : correct,
        evidence: candidates, evidence_id: status === '資料なし' ? '' : ref.id,
        ...(outsideCandidates ? { evidence_outside_candidates: true } : {}),
        ...(supportedNumbers ? { supported_numbers: supportedNumbers } : {}),
        ...(reason ? { reject_reason: reason } : {}),
        ...(reason && r && STATUSES.includes(r.status) && r.status !== '資料なし' ? { rejected_answer: {
          status: r.status, evidence: pages.find(p => p.number === evidenceNo)?.id || r.evidence_id,
          basis: String(r.basis ?? '').slice(0, 40), quote: quote.slice(0, 200),
        } } : {}),
        ...(status === '裏付けあり' && date && date <= cutoff ? { warning: '注意: 根拠の基準日が古い' } : {}),
      });
    }
  };
  const checkTally = () => {
    const judged = tally.declared + tally.missing;
    if ((tally.rejected >= 3 && tally.rejected * 2 >= tally.declared) || (tally.missing >= 3 && tally.missing * 2 >= tally.total)) {
      console.warn(`[fact-check] 確認で落とした答えの例: ${JSON.stringify(tally.samples).slice(0, 1500)}`);
      const error = new Error(`判定の答えの多くが確認を通りません（落とした ${tally.rejected}/${tally.declared}・答え無し ${tally.missing}/${judged}）`);
      error.diagnostic = error.message;
      throw error;
    }
  };
  for (const group of groups) if (group.claims.length) await judgeBatch(group.claims, group);
  // 答えの多くが確認を通らない・返らないのは、答えの形の不一致などの不具合の疑いが強い。
  // そのまま進むと正しい数字まで資料なしとして置き換えてしまうため、照合不能として止める（fail-closed）。
  checkTally();
  return claims.map(c => results.get(c.id)).filter(Boolean);
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
  const units = splitUnits(body);
  const corrections = repairInstructions(findings).map(({ id, sentence, heading, status, type, correct, quote, instruction, keep = [], keep_numbers }) => {
    const at = units.find(u => !u.heading && u.text === sentence)?.start ?? -1;
    const context = text => sentenceRows(text).map(s => s.trim()).filter(s => s && !/^#{1,6}\s/.test(s));
    return { id, sentence, heading, prev: context(body.slice(0, at)).at(-1) || '', next: context(body.slice(at + sentence.length))[0] || '',
      status, type, correct, quote, instruction, keep, ...(keep_numbers ? { keep_numbers } : {}) };
  });
  const ret = await callLLM({ task: 'repair', maxTokens: 8000,
    system: '指摘された文だけを最小限修正し、各文の置き換え後の文を [{id,replacement}] のJSON配列だけで出力してください。replacement は元の文の位置にそのまま入る（改行・見出しを含めない）。表の行は列の数を変えずに直し、期限を足すときは該当する列の中に書く。主題・構成・見出し・文体は変えず、他の文はそのまま残す。検討の過程・確認結果・修正方針の説明を本文に書かない。「差し戻しコメント」「論点別ルール」「該当箇所」などの語を本文に登場させない。本文は元の書き出しからそのまま始める。frontmatterやコードフェンスは出力しない。根拠に無いことを記憶で補わない。',
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
    // 具体を外す修正だけで、裏付けのある数字を守り、資料の無い数字を残さない。
    if (!reason && f.status === '資料なし') {
      const originalNumbers = normalizedNumbers(f.sentence), revisedNumbers = normalizedNumbers(replacement);
      const keep = f.keep || [];
      const keepNumbers = [...keep.flatMap(c => normalizedNumbers(c.claim)), ...(f.supported_numbers || []).flatMap(n => normalizedNumbers(n))]
        .filter(n => originalNumbers.includes(n));
      const summaryNumbers = normalizedNumbers(f.claim);
      const removeNumbers = (f.supported_numbers && !summaryNumbers.length ? originalNumbers : summaryNumbers)
        .filter(n => originalNumbers.includes(n) && !keepNumbers.includes(n));
      if (originalNumbers.includes(null) && (keep.length || f.supported_numbers?.length)) reason = '数字を読めないため確かめられません';
      else if (!keepNumbers.every(n => revisedNumbers.includes(n))) reason = '裏付けのある数字を消しています';
      else if (removeNumbers.some(n => revisedNumbers.includes(n))) reason = '資料の無い数字が残っています';
    }
    if (reason) rejected.set(f.id, reason);
    else replacements.set(f.id, replacement);
  }
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

async function checkFacts(body, options = {}) {
  const cfg = config(options);
  const record = { version: 1, logic_version: LOGIC_VERSION, status: 'not_run', model: cfg.model, provider: cfg.provider,
    extract_model: cfg.extractModel, effort: cfg.effort, extract_effort: cfg.extractEffort, batch: cfg.batch,
    checked_at: (options.now || new Date()).toISOString(), body_sha256: bodyHash(body), claims: [], rechecked: [], corrections: [], dropped: 0, discarded: 0,
    calls: [], input_chars_total: 0, output_chars_total: 0, review_items: [], summary: cfg.enabled ? '照合を実施できませんでした' : '照合を無効にしています' };
  if (!cfg.enabled) return { body, record };
  const validModel = model => (cfg.provider === 'anthropic' && /^claude-/.test(model)) ||
    (cfg.provider === 'openai' && /^(gpt-|o[134](?:-|$))/.test(model));
  if (!validModel(cfg.model) || !validModel(cfg.extractModel) ||
      [cfg.effort, cfg.extractEffort].some(e => e !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(e))) {
    record.summary = '照合のモデル設定が不正です';
    return { body, record };
  }
  const batch = cfg.batch ? contentModel.createBatchContext({ ...options.batchRuntime,
    maxWaitMs: cfg.batchMaxWaitMs, pollMs: cfg.batchPollMs }) : null;
  const caller = options.callLLM || (async request => contentModel.generateContent({ staticSystem: request.task === 'extract' ? '' : request.staticSystem || request.system,
    dynamicSystem: request.task === 'extract' ? request.system : '', user: request.user },
    { provider: cfg.provider, model: request.model, modelOptions: request.task === 'extract' ? cfg.extractModelOptions : cfg.modelOptions, maxTokens: request.maxTokens,
      fallback: false, signal: request.signal, timeoutMs: cfg.timeoutMs, batch }));
  let rechecking = false;
  const call = async request => {
    const batching = batch && !batch.disabled;
    const entry = { task: rechecking ? `recheck_${request.task}` : request.task,
      model: request.task === 'extract' ? cfg.extractModel : cfg.model, mode: batching ? 'batch' : 'sync',
      input_chars: request.system.length + request.user.length, output_chars: 0 };
    record.calls.push(entry);
    record.input_chars_total += request.system.length + request.user.length;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const started = batch?.now();
    let timer;
    try {
      const ret = await Promise.race([Promise.resolve().then(() => caller({ ...request, model: entry.model, signal: controller.signal })),
        new Promise((_, reject) => {
          if (controller.signal.aborted) return reject(new Error('照合の時間切れ'));
          controller.signal.addEventListener('abort', () => reject(new Error('照合の時間切れ')), { once: true });
          timer = setTimeout(abort, cfg.timeoutMs + (batching ? batch.remainingMs() + 250000 : 0));
        })]);
      for (const key of ['mode', 'wait_seconds', 'batch_error']) if (ret?.[key] !== undefined) entry[key] = ret[key];
      entry.output_chars = (Array.isArray(ret) ? JSON.stringify(ret) : typeof ret === 'string' ? ret : ret?.text || '').length;
      record.output_chars_total += entry.output_chars;
      if (ret?.usage) entry.usage = Object.fromEntries(Object.entries({ input_tokens: ret.usage.input_tokens ?? ret.usage.prompt_tokens,
        output_tokens: ret.usage.output_tokens ?? ret.usage.completion_tokens,
        cache_creation_input_tokens: ret.usage.cache_creation_input_tokens, cache_read_input_tokens: ret.usage.cache_read_input_tokens }).filter(([, v]) => v !== undefined));
      return ret;
    } catch (error) {
      for (const key of ['mode', 'wait_seconds', 'batch_error']) if (error[key] !== undefined) entry[key] = error[key];
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (batching && entry.wait_seconds === undefined) entry.wait_seconds = Math.floor(Math.max(0, batch.now() - started) / 1000);
    }
  };
  const search = options.searchEvidence || searchEvidence;
  const pageCache = {};
  let uncheckedNumeric = 0;
  const addReviewItem = c => {
    if (record.review_items.some(r => claimKey(r) === claimKey(c))) return;
    // 一覧には候補の所在を残し、判定に使わない原文は重ねて保存しない。
    record.review_items.push({ ...c, evidence: (c.evidence || []).map(({ id, title, url }) => ({ id, title, url })) });
  };
  const matchesCorrection = (f, c, pairs) => f.subject === c.subject || Boolean(normalizedClaim(c.sentence) && normalizedClaim(pairs.get(f.sentence) || '').includes(normalizedClaim(c.sentence)));
  const analyze = async (text, fullBody, findings = [], pairs = new Map(), previous = null) => {
    const candidates = c => {
      const refs = search(c, options);
      const required = findings.filter(f => f.evidence_id && matchesCorrection(f, c, pairs)).map(f => f.evidence.find(e => e.id === f.evidence_id)).filter(Boolean);
      const pinned = new Map([...refs.slice(0, 1), ...required].map(e => [e.id, e]));
      if (pinned.size > 7) throw new Error('修正の根拠が候補の上限を超えました');
      // 主出典の順番を保ち、修正の根拠を検索結果より先に確保する。
      for (const ref of refs) if (!pinned.has(ref.id)) pinned.set(ref.id, ref);
      return [...pinned.values()].slice(0, 7);
    };
    const extracted = await extractClaims(text, call, cfg);
    record.dropped += extracted.dropped;
    record.discarded += extracted.discarded;
    for (const c of [...extracted.droppedClaims, ...extracted.discardedClaims]) {
      if (isNumericClaim(c) || (!NUMERIC_TYPES.has(c.type) && !REVIEW_TYPES.has(c.type))) uncheckedNumeric++;
      else addReviewItem({ ...c, evidence: candidates(c) });
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
    }
    const evidence = Object.fromEntries(claims.map(c => [c.id, candidates(c)]));
    return [...await judgeClaims(claims, evidence, fullBody, call, { ...options, pageCache, batch }), ...reused];
  };
  let revisedBody = body;
  try {
    record.claims = options.previousClaims ? await analyze(changedText(options.previousBody, body), body, [], new Map(), options.previousClaims) : await analyze(body, body);
    const findings = record.claims.filter(c => blockingFinding(c) && !NO_REPAIR_REASONS.has(c.reject_reason)).map(c => ({ ...c,
      keep: c.status === '資料なし' ? record.claims.filter(k => k.sentence === c.sentence && k.status === '裏付けあり')
        .map(({ type, subject, claim }) => ({ type, subject, claim })) : [],
    }));
    if (findings.length && options.repair !== false) {
      const repair = await repairBody(body, findings, call, options);
      if (repair.accepted) {
        revisedBody = repair.body;
        let changes = changedText(body, revisedBody);
        const pairs = correctionPairs(body, revisedBody, findings, repair.replacements);
        for (const [sentence, replacement] of repair.replacements) {
          const f = findings.find(f => f.sentence === sentence);
          if (replacement && replacement !== f.sentence && !changes.includes(replacement) && revisedBody.includes(replacement)) changes += `\n${f.heading ? '## ' + f.heading : ''}\n${replacement}`;
        }
        rechecking = true;
        record.rechecked = changes.trim() ? await analyze(changes, revisedBody, findings, pairs) : [];
        record.corrections = findings.map(f => ({ ...f, before: f.sentence,
          after: repair.rejected.has(f.id) ? '' : pairs.get(f.sentence) || '',
          generalized: f.status === '資料なし',
          ...(repair.rejected.has(f.id) ? { reason: repair.rejected.get(f.id) } : {}),
          resolved: !repair.rejected.has(f.id) && !revisedBody.includes(f.sentence) && !record.rechecked.some(c => blockingFinding(c) && matchesCorrection(f, c, pairs)),
        }));
        // 期限追記は元の文を残せる。解決の裏付けは自身の置き換え文に限り、止める側は広い対応を維持する。
        for (const c of record.corrections) if (['食い違い', '期限の書き漏れ'].includes(c.status)) {
          c.resolved = !repair.rejected.has(c.id) && changes.trim().length > 0 && record.rechecked.some(r =>
            r.status === '裏付けあり' && Boolean(normalizedClaim(r.sentence)) && normalizedClaim(pairs.get(c.sentence) || '').includes(normalizedClaim(r.sentence))) &&
            !record.rechecked.some(r => matchesCorrection(c, r, pairs) && blockingFinding(r));
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
      } else record.repair_warning = repair.reason;
    }
    const unresolved = record.claims.filter(c => c.status !== '裏付けあり' && !record.corrections.find(f => f.id === c.id)?.resolved);
    const pending = [...unresolved, ...record.rechecked.filter(c => c.status !== '裏付けあり')];
    for (const c of pending) if (!blockingFinding(c)) addReviewItem(c);
    record.remaining = pending.filter(blockingFinding);
    const mismatches = record.remaining.filter(c => ['食い違い', '期限の書き漏れ'].includes(c.status)).length;
    // 数字の未照合と、種類を問わない食い違い・期限の書き漏れは引き続き止める。
    record.status = record.remaining.length || uncheckedNumeric ? 'revise' : 'ok';
    const repaired = record.corrections.filter(c => c.resolved).length;
    record.summary = `主張 ${record.claims.length} 件: 裏付けあり ${record.claims.filter(c => c.status === '裏付けあり').length}・修正 ${repaired}（食い違い ${record.corrections.filter(c => c.resolved && c.status === '食い違い').length}・期限 ${record.corrections.filter(c => c.resolved && c.status === '期限の書き漏れ').length}・具体を外した ${record.corrections.filter(c => c.resolved && c.generalized).length}）・残った食い違い ${mismatches}・未解決 ${record.remaining.length}・上限で未照合 ${record.dropped}`;
    record.summary += `・捨てた主張 ${record.discarded}`;
    record.summary += `・人が確かめる箇所 ${record.review_items.length} 件`;
  } catch (error) {
    // 要約は固定文。原因は鍵を伏せた短い診断だけを error に残す（原因が分からないまま全部止まるのを防ぐ）。
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
  return { body: revisedBody, record };
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
      const rows = [...(prior.claims || []), ...(prior.rechecked || [])];
      const validRow = c => c && typeof c.id === 'string' && typeof c.sentence === 'string' && c.sentence.trim() &&
        typeof c.subject === 'string' && c.subject.trim() && typeof c.claim === 'string' && typeof c.heading === 'string' &&
        TYPES.includes(c.type) && STATUSES.includes(c.status) && typeof c.quote === 'string' && typeof c.correct === 'string' &&
        (Array.isArray(c.evidence) || (Array.isArray(c.evidence_ids) && c.evidence_ids.every(id => prior.evidence?.[id]))) &&
        (c.status === '資料なし' || (typeof c.evidence_id === 'string' && c.evidence_id && c.quote.trim()));
      if (prior.version === 1 && prior.logic_version === LOGIC_VERSION && prior.incremental === undefined && prior.slug === slug && before.data.slug === slug && prior.body_sha256 === bodyHash(before.content) &&
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
          (c.status === '資料なし' || c.evidence.some(ref => ref.id === c.evidence_id && quoteExists(c.quote, ref)));
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
      ...[2, 3, 4].filter(n => meta[`source_${n}_url`]).map(n => ({ url: meta[`source_${n}_url`] }))] };
}

/** 再生成モデルに照合の管理項目や既存の品質判定を書き換えさせない。 */
function inheritFactMetadata(original, regenerated) {
  const { data: before } = matter(original);
  const { data: after } = matter(regenerated);
  const updates = Object.fromEntries(Object.entries(before).filter(([key]) => key.startsWith('fact_check_')));
  if (before.fact_check_version) {
    const previousWarning = String(before.review_warning || '');
    const addedWarning = String(after.review_warning || '').replace(WARNING_RE, '').replace(/(?:\s*\/\s*)+$/, '').trim();
    const addedOtherWarning = addedWarning && !previousWarning.includes(addedWarning);
    const newBlocking = after.recommendation === 'reject' ||
      (after.recommendation === 'revise' && (before.recommendation !== 'revise' || addedOtherWarning));
    updates.recommendation = newBlocking ? after.recommendation : before.recommendation || '';
    if (newBlocking) updates.fact_check_prev_recommendation = after.recommendation;
    updates.review_warning = [previousWarning, addedOtherWarning ? addedWarning : ''].filter(Boolean).join(' / ');
  } else if (before.recommendation === 'revise' || before.recommendation === 'reject') {
    updates.recommendation = before.recommendation;
  }
  return Object.keys(updates).length ? updateMeta(regenerated, updates) : regenerated;
}

module.exports = { extractClaims, judgeClaims, searchEvidence, repairBody, repairInstructions, checkFacts, checkArticle,
  articleEvidenceOptions,
  applyFactResult, updateMeta, recordPath, changedText, preservesOtherText, normalizedQuote, sourceDate, config, inheritFactMetadata,
  normalizeBody, bodyHash, compactRecord, evidenceRefs, normalizedNumbers, sufficientQuote, quoteParts, correctionPairs, WARNING_RE };
