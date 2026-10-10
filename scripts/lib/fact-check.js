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
const TYPES = ['期限', '要件', '判定', '金額', '割合', '手続', '適用年', '番号'];
const STATUSES = ['裏付けあり', '食い違い', '資料なし', '期限の書き漏れ'];
const ROOT = path.join(__dirname, '..', '..');
const WARNING_RE = /【事実の照合】[\s\S]*?【\/事実の照合】/g;

function config(options = {}) {
  const provider = options.provider || process.env.FACT_CHECK_PROVIDER || 'anthropic';
  return { provider, model: options.model || process.env.FACT_CHECK_MODEL || 'claude-opus-5-5',
    enabled: options.enabled ?? (process.env.FACT_CHECK_ENABLED !== 'false'),
    failOpen: options.failOpen ?? (process.env.FACT_CHECK_FAIL_OPEN === 'true'),
    maxClaims: positiveLimit(options.maxClaims ?? process.env.FACT_CHECK_MAX_CLAIMS, 40),
    timeoutMs: positiveLimit(options.timeoutMs ?? process.env.FACT_CHECK_TIMEOUT_MS, 600000) };
}

function bodyHash(body) { return createHash('sha256').update(String(body).replace(/\r\n/g, '\n')).digest('hex'); }

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
  for (const key of ['claims', 'rechecked', 'corrections', 'remaining']) result[key] = compact(record[key]);
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

function normalizedNumbers(text) {
  const normalized = normalizedQuote(text).replace(/[〇零一二三四五六七八九十百千万億]+/g, value => {
    const digits = '〇一二三四五六七八九';
    if (!/[十百千万億]/.test(value)) return [...value].map(c => c === '零' ? 0 : digits.indexOf(c)).join('');
    let total = 0, section = 0, num = 0;
    for (const c of value) {
      const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000, 億: 100000000 }[c];
      if (!unit) num = c === '零' ? 0 : digits.indexOf(c);
      else if (unit < 10000) { section += (num || 1) * unit; num = 0; }
      else { total += (section + num || 1) * unit; section = num = 0; }
    }
    return String(total + section + num);
  }).replace(/(令和|平成)元年/g, '$11年');
  return normalized.match(/\d+(?:[.,]\d+)*/g) || [];
}

function sufficientQuote(claim, result, ref, status) {
  const quote = normalizedQuote(result?.quote);
  if (!quote || !ref) return false;
  const wholeSentence = sentenceRows(ref.text).some(s => normalizedQuote(s.trim()) === quote && /。$/.test(s.trim()) && quote !== '。');
  if (quote.length < 15 && !wholeSentence) return false;
  if (['期限', '金額', '割合', '適用年'].includes(claim.type)) {
    const numbers = normalizedNumbers(status === '裏付けあり' ? claim.claim + claim.sentence : result.correct);
    const quoted = normalizedNumbers(result.quote);
    if (!numbers.length || !numbers.every(n => quoted.includes(n))) return false;
  }
  return true;
}

function parseJson(value) {
  if (Array.isArray(value)) return value;
  const text = typeof value === 'string' ? value : value?.text;
  return JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
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
  const data = parseJson(await callLLM({ task: 'extract', maxTokens: 12000,
    system: '記事本文から税務の事実を述べた文を漏れなく抜き出してください。出力は JSON 配列だけです。要件（対象・条件）・金額・割合・期限（保存期間を含む）・適用年・手続（届出・申請・選択）・番号（条文・通達・タックスアンサー）・判定を対象にします。sentence は本文の原文そのまま、heading は見出し、type は上記8種類のいずれか、subject は制度名・論点名、claim は主張の1文要約です。想定と明示された設例の金額は対象外です。ただし設例中でも税率・控除額など制度の数値は対象です。制度を説明する文には、期限を書いていなくても要件や判定の主張を作り、期限の書き漏れを判定できるようにしてください。番号だけの引用も対象です。形は [{id,sentence,heading,type,subject,claim}] です。',
    user: body,
  }));
  if (!Array.isArray(data)) throw new Error('主張一覧が不正です');
  const seen = new Set();
  let discarded = 0;
  const valid = [];
  for (const c of data) {
    if (c && isScenarioAmount(c)) continue;
    const sentence = c && typeof c.sentence === 'string' ? actualSentence(body, c.sentence) : '';
    if (!sentence || !TYPES.includes(c.type) || typeof c.subject !== 'string' || !c.subject.trim() || typeof c.claim !== 'string') { discarded++; continue; }
    const key = `${sentence}:${c.type}:${c.subject}`;
    if (seen.has(key)) continue;
    seen.add(key); valid.push({ ...c, sentence });
  }
  const max = positiveLimit(options.maxClaims, 40);
  const chosen = valid.length > max ? [...valid].sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type)).slice(0, max) : valid;
  return { claims: chosen.map((c, i) => ({ id: `c${i + 1}`, sentence: c.sentence, heading: c.heading || '', type: c.type, subject: c.subject, claim: c.claim })),
    dropped: Math.max(0, valid.length - chosen.length), discarded };
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
    const data = parseJson(await callLLM({ task: 'judge', maxTokens: 7000,
      system: `主張を添付した原文だけで照合してください。判断できなければ資料なしにする。記憶で補わない。括弧書き・ただし書きの対象を取り違えない。${LAW_SCOPE_RULE} 出力は [{id,status,quote,correct,evidence_id}] のJSON配列だけです。statusは裏付けあり／食い違い／資料なし／期限の書き漏れ。裏付けあり・食い違い・期限の書き漏れでは quote に根拠の該当文を原文のまま書き、evidence_id にその資料のidを書いてください。食い違いには correct に原文に基づく正しい内容を書く。制度の適用期限が原文にあるのに記事本文のどこにも書かれていない場合、制度ごとに1件だけ期限の書き漏れとし、correctに期限を書いてください。設例の額を制度の上限と混同しないでください。`,
      user: JSON.stringify({ today: (options.now || new Date()).toISOString().slice(0, 10), body, claims: batch }),
    }));
    if (!Array.isArray(data)) throw new Error('判定結果が不正です');
    for (const c of batch) {
      const rows = data.filter(r => r?.id === c.id);
      const r = rows.length === 1 ? rows[0] : null;
      let status = STATUSES.includes(r?.status) ? r.status : '資料なし';
      const ref = c.evidence.find(e => (!r?.evidence_id || e.id === r.evidence_id) && normalizedQuote(r?.quote) && normalizedQuote(e.text).includes(normalizedQuote(r.quote)));
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
        evidence: c.evidence, evidence_id: status === '資料なし' ? '' : ref.id,
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
    calls: [], summary: cfg.enabled ? '照合を実施できませんでした' : '照合を無効にしています' };
  if (!cfg.enabled) return { body, record };
  if (!((cfg.provider === 'anthropic' && /^claude-/.test(cfg.model)) || (cfg.provider === 'openai' && /^(gpt-|o[134](?:-|$))/.test(cfg.model)))) {
    record.summary = '照合のモデル設定が不正です';
    return { body, record };
  }
  const caller = options.callLLM || (async request => contentModel.generateContent({ staticSystem: request.system, dynamicSystem: '', user: request.user },
    { provider: cfg.provider, model: cfg.model, maxTokens: request.maxTokens, fallback: false, signal: request.signal, timeoutMs: cfg.timeoutMs }));
  const call = async request => {
    record.calls.push({ task: request.task, input_chars: request.system.length + request.user.length });
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => caller({ ...request, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('照合の時間切れ')); }, cfg.timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  const search = options.searchEvidence || searchEvidence;
  const analyze = async (text, fullBody) => {
    const extracted = await extractClaims(text, call, cfg);
    record.dropped += extracted.dropped;
    record.discarded += extracted.discarded;
    if (!extracted.claims.length && text.replace(/^\s*#{1,6}\s+.*$/gm, '').trim().length >= 200) {
      const error = new Error('主張を抜き出せませんでした'); error.emptyClaims = true; throw error;
    }
    const evidence = Object.fromEntries(extracted.claims.map(c => [c.id, search(c, options)]));
    return judgeClaims(extracted.claims, evidence, fullBody, call, options);
  };
  let revisedBody = body;
  try {
    record.claims = await analyze(body, body);
    const findings = record.claims.filter(c => c.status !== '裏付けあり');
    if (findings.length && options.repair !== false) {
      const repair = await repairBody(body, findings, call, options);
      if (repair.accepted) {
        revisedBody = repair.body;
        const changes = changedText(body, revisedBody);
        record.rechecked = changes.trim() ? await analyze(changes, revisedBody) : [];
        const pairs = correctionPairs(body, revisedBody, findings);
        record.corrections = findings.map(f => ({ ...f, before: f.sentence,
          after: pairs.get(f.sentence) || '',
          generalized: f.status === '資料なし',
          resolved: !revisedBody.includes(f.sentence) && !record.rechecked.some(c => c.status !== '裏付けあり' && c.subject === f.subject),
        }));
        // 期限追記は元の文を残せるため、再照合の結果と期限追記の有無で判定する。
        for (const c of record.corrections) if (['食い違い', '期限の書き漏れ'].includes(c.status)) {
          c.resolved = changes.trim().length > 0 && record.rechecked.some(r => r.subject === c.subject && r.status === '裏付けあり');
        }
      } else record.repair_warning = repair.reason;
    }
    const unresolved = record.claims.filter(c => c.status !== '裏付けあり' && !record.corrections.find(f => f.id === c.id)?.resolved);
    record.remaining = [...unresolved, ...record.rechecked.filter(c => c.status !== '裏付けあり')];
    const mismatches = record.remaining.filter(c => ['食い違い', '期限の書き漏れ'].includes(c.status)).length;
    // 上限で未照合の主張、または具体を外せなかった資料なしも承認しない。
    record.status = record.remaining.length || record.dropped || record.discarded ? 'revise' : 'ok';
    const repaired = record.corrections.filter(c => c.resolved).length;
    record.summary = `主張 ${record.claims.length} 件: 裏付けあり ${record.claims.filter(c => c.status === '裏付けあり').length}・修正 ${repaired}（食い違い ${record.corrections.filter(c => c.resolved && c.status === '食い違い').length}・期限 ${record.corrections.filter(c => c.resolved && c.status === '期限の書き漏れ').length}・具体を外した ${record.corrections.filter(c => c.resolved && c.generalized).length}）・残った食い違い ${mismatches}・未解決 ${record.remaining.length}・上限で未照合 ${record.dropped}`;
    record.summary += `・捨てた主張 ${record.discarded}`;
  } catch (error) {
    // API応答や例外に認証情報が含まれる可能性があるため、保存・表示は固定文のみ。
    record.status = 'not_run';
    record.summary = error.emptyClaims ? '主張を抜き出せませんでした' : '照合を実施できませんでした（設定・API応答・カタログを確認してください）';
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
  const result = await checkFacts(body, { tax_terms: meta.tax_terms, source_bundle: meta.source_bundle, tax_domain: meta.tax_domain, ...options });
  result.record.slug = slug;
  if (options.persist !== false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(compactRecord(result.record), null, 2) + '\n', 'utf8');
  }
  return { ...result, content: applyFactResult(raw, result, options), recordFile: file };
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
  applyFactResult, updateMeta, recordPath, changedText, preservesOtherText, normalizedQuote, sourceDate, config, inheritFactMetadata,
  bodyHash, compactRecord, evidenceRefs, normalizedNumbers };
