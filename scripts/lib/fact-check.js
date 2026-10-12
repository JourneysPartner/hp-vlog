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
const TYPES = ['金額', '期限', '割合', '適用年', '番号', '要件', '判定', '手続'];
const NUMERIC_TYPES = new Set(['金額', '割合', '期限', '適用年', '番号']);
const REVIEW_TYPES = new Set(['要件', '判定', '手続']);
const STATUSES = ['裏付けあり', '食い違い', '資料なし', '期限の書き漏れ'];
const ROOT = path.join(__dirname, '..', '..');
const WARNING_RE = /【事実の照合】[\s\S]*?【\/事実の照合】/g;

function config(options = {}) {
  const provider = options.provider || process.env.FACT_CHECK_PROVIDER || 'anthropic';
  return { provider, model: options.model || process.env.FACT_CHECK_MODEL || 'claude-opus-5-5',
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
    ref.text_deflate_base64 ? { ...ref, text: inflateRawSync(Buffer.from(ref.text_deflate_base64, 'base64'), { maxOutputLength: 100000 }).toString('utf8') } : ref);
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

function normalizedNumbers(text, range) {
  const normalized = normalizedQuote(text).replace(/(令和|平成|昭和)元年/g, '$11年');
  const numbers = [];
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
      numbers.push(`日付:${year}${month ? '-' + read(month) : ''}${day ? '-' + read(day) : ''}`);
      continue;
    }
    const value = match[0];
    const prefix = normalized.slice(0, match.index);
    const suffix = normalized.slice(match.index + value.length);
    // 範囲の端で切れた日付・金額・割合の断片を、別の数として採用しない。
    const next = matches[i + 1];
    const fraction = suffix.startsWith('分の');
    const nextSuffix = next ? normalized.slice(next.index + next[0].length) : '';
    const unit = suffix.match(/^(?:円|年|月|日|歳|人|件|か月|ヶ月|カ月|ケ月|箇月)/)?.[0] || '';
    const end = fraction && next ? next.index + next[0].length + (nextSuffix.startsWith('%') ? 1 : 0)
      : match.index + value.length + (suffix.startsWith('%') ? 1 : unit.length);
    if (range && (match.index < range[0] || end > range[1])) {
      if (fraction && next && next.index === match.index + value.length + 2) i++;
      continue;
    }
    // 「一定」「一般」などの漢数字は、数を示す文脈が無ければ読まない。
    if (!/[0-9]/.test(value) && !/(?:令和|平成|昭和|第|分の)$/.test(prefix) &&
      !/^(?:年|月|日|円|万|億|%|割|分|歳|人|件|か月|ヶ月|カ月|ケ月|箇月)/.test(suffix)) continue;
    if (suffix.startsWith('分の') || suffix.startsWith('%')) {
      // 不完全な分数や数の断片は数字なしへ戻さず、照合不能として残す。
      if (/[.,]$/.test(prefix) || (fraction && (!next || next.index !== match.index + value.length + 2 ||
        (next[0] === '一' && /^(?:定|般)/.test(nextSuffix))))) return [null];
      const ratio = normalizedRatio(fraction ? next[0] : value, fraction ? value : '100', {
        negative: /[-−]$/.test(prefix),
        percentage: fraction && nextSuffix.startsWith('%'),
      });
      if (ratio === null) return [null];
      numbers.push(ratio);
      if (fraction) i++;
      continue;
    }
    const digits = '〇一二三四五六七八九';
    let total = 0, section = 0, num = 0, hasNumber = false, hasSection = false;
    // アラビア数字・漢数字と万・億をまとめ、同じ金額を一つの数にする。
    for (const c of value.match(/[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[〇零一二三四五六七八九]+|[十百千万億]/g) || []) {
      const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000, 億: 100000000 }[c];
      if (!unit) {
        num = /[0-9]/.test(c) ? Number(c.replace(/,/g, '')) : Number([...c].map(d => d === '零' ? 0 : digits.indexOf(d)).join(''));
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
    numbers.push(Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? String(number) : value);
  }
  return numbers;
}

function sufficientQuote(claim, result, ref, status) {
  const quote = normalizedQuote(result?.quote);
  if (!quote || !ref) return false;
  const wholeSentence = evidenceTexts(ref).some(text => sentenceRows(text).some(s => normalizedQuote(s.trim()) === quote && /。$/.test(s.trim()) && quote !== '。'));
  if (quote.length < 15 && !wholeSentence) return false;
  if (['期限', '金額', '割合', '適用年'].includes(claim.type)) {
    let numbers = normalizedNumbers(status === '裏付けあり' ? claim.claim : result.correct);
    if (status === '裏付けあり') {
      const sentenceNumbers = normalizedNumbers(claim.sentence);
      // 要約だけで数字が書き換わった主張を通さず、要約に数字が無ければ原文を照合する。
      if (!numbers.every(n => sentenceNumbers.includes(n))) return false;
      if (!numbers.length) numbers = sentenceNumbers;
    }
    if (numbers.includes(null) || !numbers.length) return false;
    // 不正な割合による照合不能は、従来どおり採用した原文全体で止める。
    if (evidenceTexts(ref).some(text => normalizedNumbers(text).includes(null))) return false;
    // 空白・文字幅を揃えた引用位置を原文へ戻し、同じ抜粋の前後300文字だけを使う。
    const supported = evidenceTexts(ref).some(text => {
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
        if (!quoted.includes(null) && numbers.every(n => quoted.includes(n))) return true;
      }
      return false;
    });
    if (!supported) return false;
  }
  return true;
}

// 型だけで数字の事実にしない。読めない数や漢数字の条文・通達番号は止める側に残す。
function isNumericClaim(c) {
  return NUMERIC_TYPES.has(c.type) && (normalizedNumbers(c.sentence).length > 0 ||
    /No\.|(?:第)?[〇零一二三四五六七八九十百千万億]+条|[〇零一二三四五六七八九十百千万億]+[-−][〇零一二三四五六七八九十百千万億]+/i.test(normalizedQuote(c.sentence)));
}

function evidenceTexts(ref) {
  return ref.text_ranges ? ref.text_ranges.map(([start, end]) => ref.text.slice(start, end)) : [ref.text];
}

// 原文の位置が分かる重複・連続範囲は統合する。離れた範囲は引用の実在確認でも分けて扱う。
function batchEvidence(batch) {
  const grouped = new Map();
  for (const c of batch) for (const ref of c.evidence) {
    if (!grouped.has(ref.id)) grouped.set(ref.id, { ref, parts: [] });
    const parts = grouped.get(ref.id).parts;
    for (const text of evidenceTexts(ref)) {
      if (parts.some(p => p.text.includes(text))) continue;
      for (let i = parts.length - 1; i >= 0; i--) if (text.includes(parts[i].text)) parts.splice(i, 1);
      parts.push({ text, start: ref.text_ranges ? undefined : ref.text_start });
    }
  }
  const result = new Map();
  for (const [id, { ref, parts }] of grouped) {
    if (parts.every(p => Number.isInteger(p.start))) parts.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const part of parts) {
      const last = merged[merged.length - 1];
      const overlap = last && Number.isInteger(last.start) && Number.isInteger(part.start) ? last.start + last.text.length - part.start : -1;
      if (overlap >= 0 && overlap <= part.text.length && last.text.slice(last.text.length - overlap) === part.text.slice(0, overlap)) last.text += part.text.slice(overlap);
      else merged.push({ ...part });
    }
    let text = '';
    const ranges = [];
    for (const part of merged) {
      const start = text.length + (text ? 1 : 0);
      const excerpt = part.text.slice(0, Math.max(0, 4000 - start));
      if (!excerpt) break;
      text += (text ? '\n' : '') + excerpt;
      ranges.push([start, text.length]);
    }
    const entry = { ...ref, text };
    delete entry.text_start;
    delete entry.text_ranges;
    if (ranges.length > 1) entry.text_ranges = ranges;
    else if (Number.isInteger(merged[0]?.start)) entry.text_start = merged[0].start;
    result.set(id, entry);
  }
  return result;
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

function isScenarioAmount(c) {
  return c.type === '金額' && /想定|設例/.test(`${c.heading} ${c.sentence}`) &&
    !/控除|税額|上限|限度|非課税|基礎|税率|制度/.test(c.sentence);
}

async function extractClaims(body, callLLM, options = {}) {
  const read = async text => parseJson(await callLLM({ task: 'extract', maxTokens: 12000,
    system: '記事本文から税務の事実を述べた文を漏れなく抜き出してください。出力は JSON 配列だけです。要件（対象・条件）・金額・割合・期限（保存期間を含む）・適用年・手続（届出・申請・選択）・番号（条文・通達・タックスアンサー）・判定を対象にします。sentence は本文の原文そのまま、heading は見出し、type は上記8種類のいずれか、subject は制度名・論点名、claim は主張の1文要約です。claim は60文字以内にしてください。想定と明示された設例の金額は対象外です。ただし設例中でも税率・控除額など制度の数値は対象です。制度を説明する文には、期限を書いていなくても要件や判定の主張を作り、期限の書き漏れを判定できるようにしてください。番号だけの引用も対象です。形は [{id,sentence,heading,type,subject,claim}] です。',
    user: text,
  }));
  let data;
  try { data = await read(body); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const boundaries = [...body.matchAll(/^## /gm)].map(m => m.index).filter(at => at > 0);
    if (!boundaries.length) throw error;
    const at = boundaries.reduce((best, next) => Math.abs(next - body.length / 2) < Math.abs(best - body.length / 2) ? next : best);
    data = [];
    let retryError;
    // 各半分を一度だけ再抽出する。片方の失敗を隠して部分的な結果を通さない。
    for (const text of [body.slice(0, at), body.slice(at)]) {
      try {
        const rows = await read(text);
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
  const fields = c => Object.fromEntries(['sentence', 'heading', 'type', 'subject', 'claim'].map(key => [key, typeof c?.[key] === 'string' ? c[key] : '']));
  for (const c of data) {
    if (c && isScenarioAmount(c)) continue;
    const sentence = c && typeof c.sentence === 'string' ? actualSentence(body, c.sentence) : '';
    if (!sentence || !TYPES.includes(c.type) || typeof c.subject !== 'string' || !c.subject.trim() || typeof c.claim !== 'string') {
      discardedClaims.push({ ...fields(c), status: sentence ? '主張の形式が不正' : '本文に見つからない' });
      continue;
    }
    const key = `${sentence}:${c.type}:${c.subject}`;
    if (seen.has(key)) continue;
    seen.add(key); valid.push({ ...c, sentence });
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
  const results = new Map();
  const queued = [];
  for (const c of claims) {
    const refs = evidence[c.id] || [];
    if (!refs.length) results.set(c.id, { ...c, status: '資料なし', quote: '', correct: '', evidence: [] });
    else queued.push({ ...c, evidence: refs });
  }
  const deadlineSubjects = new Set();
  for (let start = 0; start < queued.length; start += 10) {
    const batch = queued.slice(start, start + 10);
    const refs = batchEvidence(batch);
    const data = parseJson(await callLLM({ task: 'judge', maxTokens: 7000,
      system: `主張を添付した原文だけで照合してください。evidence の中の、各主張の evidence_ids の資料だけを根拠にしてください。判断できなければ資料なしにする。記憶で補わない。括弧書き・ただし書きの対象を取り違えない。${LAW_SCOPE_RULE} 出力は [{id,status,quote,correct,evidence_id}] のJSON配列だけです。statusは裏付けあり／食い違い／資料なし／期限の書き漏れ。裏付けあり・食い違い・期限の書き漏れでは quote に根拠の該当文を原文のまま書き、evidence_id にその資料のidを書いてください。食い違いには correct に原文に基づく正しい内容を書く。制度の適用期限が原文にあるのに記事本文のどこにも書かれていない場合、制度ごとに1件だけ期限の書き漏れとし、correctに期限を書いてください。設例の額を制度の上限と混同しないでください。`,
      user: JSON.stringify({ today: (options.now || new Date()).toISOString().slice(0, 10), body,
        evidence: [...refs.values()].map(({ id, title, url, law_version, text }) => ({ id, title, url, law_version, text })),
        claims: batch.map(({ id, sentence, claim, type, subject, evidence }) => ({ id, sentence, claim, type, subject, evidence_ids: evidence.map(e => e.id) })) }),
    }));
    if (!Array.isArray(data)) throw new Error('判定結果が不正です');
    for (const c of batch) {
      const rows = data.filter(r => r?.id === c.id);
      const r = rows.length === 1 ? rows[0] : null;
      let status = STATUSES.includes(r?.status) ? r.status : '資料なし';
      const candidates = c.evidence.map(e => refs.get(e.id));
      const ref = candidates.find(e => (!r?.evidence_id || e.id === r.evidence_id) && normalizedQuote(r?.quote) && evidenceTexts(e).some(text => normalizedQuote(text).includes(normalizedQuote(r.quote))));
      if (status !== '資料なし' && (!sufficientQuote(c, r, ref, status) || (['食い違い', '期限の書き漏れ'].includes(status) && !r.correct?.trim()))) status = '資料なし';
      // 同じ制度の期限の2件目は修正対象に加えない。
      if (status === '期限の書き漏れ') {
        if (deadlineSubjects.has(c.subject)) continue;
        deadlineSubjects.add(c.subject);
      }
      const date = ref && sourceDate(ref.law_version);
      const cutoff = new Date(options.now || new Date());
      cutoff.setUTCMonth(cutoff.getUTCMonth() - 18);
      results.set(c.id, { id: c.id, sentence: c.sentence, heading: c.heading, type: c.type, subject: c.subject, claim: c.claim,
        status, quote: status === '資料なし' ? '' : r.quote, correct: status === '資料なし' ? '' : r.correct || '',
        evidence: candidates, evidence_id: status === '資料なし' ? '' : ref.id,
        ...(status === '裏付けあり' && date && date <= cutoff ? { warning: '注意: 根拠の基準日が古い' } : {}),
      });
    }
  }
  return claims.map(c => results.get(c.id)).filter(Boolean);
}

function sentenceRows(body) {
  return String(body).match(/[^。\n]+[。\n]?/g) || [];
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

/** 修正対象以外の原文が、同じ順番で残ることを確認する。 */
function preservesOtherText(before, after, findings) {
  const intervals = findings.flatMap(f => {
    const start = before.indexOf(f.sentence);
    return start < 0 ? [] : [{ start, end: start + f.sentence.length }];
  }).sort((a, b) => a.start - b.start);
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
    instruction: f.status === '食い違い' ? '根拠の原文に合わせて、この文だけを直す' :
      f.status === '期限の書き漏れ' ? 'この制度の説明に、根拠の適用期限を1文で足す' :
        f.type === '番号' ? '資料が無い番号を消し、番号を推測せず内容だけにする' :
          '資料が無い具体的な要件・金額・割合・期限・適用年・手続・判定を外し、「詳しくは国税庁の〇〇で確認」程度の案内に置き換える',
  }));
}

function correctionPairs(before, after, findings) {
  const targets = [...new Set(findings.map(f => f.sentence))].map(sentence => ({ sentence, at: before.indexOf(sentence) }))
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
    const followingAt = following ? after.indexOf(following, start) : after.length;
    pairs.set(t.sentence, after.slice(start, followingAt < 0 ? after.length : followingAt).trim());
    cursor = followingAt < 0 ? start : followingAt;
    previousEnd = end;
  }
  return pairs;
}

async function repairBody(body, findings, callLLM, options = {}) {
  const ret = await callLLM({ task: 'repair', maxTokens: 12000,
    system: '指摘された文だけを最小限修正し、記事本文のMarkdown全文だけを出力してください。主題・構成・見出し・文体は変えず、他の文はそのまま残す。検討の過程・確認結果・修正方針の説明を本文に書かない。「差し戻しコメント」「論点別ルール」「該当箇所」などの語を本文に登場させない。本文は元の書き出しからそのまま始める。frontmatterやコードフェンスは出力しない。根拠に無いことを記憶で補わない。',
    user: JSON.stringify({ body, corrections: repairInstructions(findings) }),
  });
  let revised = String(typeof ret === 'string' ? ret : ret?.text || '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  revised = partial.stripAnalysisPreamble(body, revised).body;
  const guard = partial.isBodyShrinkageSuspicious(body, revised, 0.6);
  if (guard.suspicious || partial.findInternalProcessWords(revised).contaminated || /^---\n/.test(revised) ||
      !preservesOtherText(body, revised, findings) || (options.validateRepair && !options.validateRepair(revised))) {
    return { body, accepted: false, reason: '修正結果が本文の保全条件を満たさないため、元の本文を維持しました' };
  }
  return { body: revised, accepted: true };
}

async function checkFacts(body, options = {}) {
  const cfg = config(options);
  const record = { version: 1, status: 'not_run', model: cfg.model, provider: cfg.provider,
    checked_at: (options.now || new Date()).toISOString(), body_sha256: bodyHash(body), claims: [], rechecked: [], corrections: [], dropped: 0, discarded: 0,
    calls: [], input_chars_total: 0, review_items: [], summary: cfg.enabled ? '照合を実施できませんでした' : '照合を無効にしています' };
  if (!cfg.enabled) return { body, record };
  if (!((cfg.provider === 'anthropic' && /^claude-/.test(cfg.model)) || (cfg.provider === 'openai' && /^(gpt-|o[134](?:-|$))/.test(cfg.model)))) {
    record.summary = '照合のモデル設定が不正です';
    return { body, record };
  }
  const caller = options.callLLM || (async request => contentModel.generateContent({ staticSystem: request.system, dynamicSystem: '', user: request.user },
    { provider: cfg.provider, model: cfg.model, maxTokens: request.maxTokens, fallback: false, signal: request.signal, timeoutMs: cfg.timeoutMs }));
  const call = async request => {
    record.calls.push({ task: request.task, input_chars: request.system.length + request.user.length });
    record.input_chars_total += request.system.length + request.user.length;
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => caller({ ...request, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('照合の時間切れ')); }, cfg.timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  const search = options.searchEvidence || searchEvidence;
  let uncheckedNumeric = 0;
  const addReviewItem = c => {
    if (record.review_items.some(r => r.sentence === c.sentence && r.type === c.type && r.subject === c.subject)) return;
    // 一覧には候補の所在を残し、判定に使わない原文は重ねて保存しない。
    record.review_items.push({ ...c, evidence: (c.evidence || []).map(({ id, title, url }) => ({ id, title, url })) });
  };
  const matchesCorrection = (f, c, pairs) => f.subject === c.subject || Boolean(normalizedClaim(c.sentence) && normalizedClaim(pairs.get(f.sentence) || '').includes(normalizedClaim(c.sentence)));
  const analyze = async (text, fullBody, findings = [], pairs = new Map()) => {
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
    const evidence = Object.fromEntries(extracted.claims.map(c => [c.id, candidates(c)]));
    return judgeClaims(extracted.claims, evidence, fullBody, call, options);
  };
  let revisedBody = body;
  try {
    record.claims = await analyze(body, body);
    const findings = record.claims.filter(blockingFinding);
    if (findings.length && options.repair !== false) {
      const repair = await repairBody(body, findings, call, options);
      if (repair.accepted) {
        revisedBody = repair.body;
        const changes = changedText(body, revisedBody);
        const pairs = correctionPairs(body, revisedBody, findings);
        record.rechecked = changes.trim() ? await analyze(changes, revisedBody, findings, pairs) : [];
        record.corrections = findings.map(f => ({ ...f, before: f.sentence,
          after: pairs.get(f.sentence) || '',
          generalized: f.status === '資料なし',
          resolved: !revisedBody.includes(f.sentence) && !record.rechecked.some(c => blockingFinding(c) && matchesCorrection(f, c, pairs)),
        }));
        // 期限追記は元の文を残せるため、再照合の結果と期限追記の有無で判定する。
        for (const c of record.corrections) if (['食い違い', '期限の書き漏れ'].includes(c.status)) {
          c.resolved = changes.trim().length > 0 && record.rechecked.some(r => matchesCorrection(c, r, pairs) && r.status === '裏付けあり') &&
            !record.rechecked.some(r => matchesCorrection(c, r, pairs) && blockingFinding(r));
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
  const result = await checkFacts(body, { ...articleEvidenceOptions(meta), ...options });
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
  normalizeBody, bodyHash, compactRecord, evidenceRefs, normalizedNumbers, WARNING_RE };
