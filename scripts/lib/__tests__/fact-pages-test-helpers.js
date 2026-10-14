'use strict';

// 既存の回帰試験の意味を保ち、偽LLMの文・引用を新しい番号形式へ変換する。
const F = require('../fact-check');
const E = require('../fact-evidence');
const { splitUnits, rangeText } = require('../fact-units');
function bodyText(numbered) { return numbered.replace(/^\[\d+\] /gm, ''); }
function materials(request) {
  const extra = request.task === 'judge' ? JSON.parse(request.user).evidence || '' : '';
  return [...(request.system + '\n' + extra).matchAll(/\[資料 (\d+)\] ([^\n]*)\n([\s\S]*?)(?=\n\n\[資料 |$)/g)].map(m => {
    const [title, url, law_version] = m[2].split(' / ');
    const rows = [...m[3].matchAll(/^\[(\d+)\] (.*)$/gm)].map(u => ({ s: Number(u[1]), text: u[2] }));
    return { number: Number(m[1]), title, url, law_version, rows, text: rows.map(u => u.text).join('\n') };
  });
}
function basisFor(page, quote) {
  const wanted = F.normalizedQuote(quote);
  if (!wanted) return '';
  if (wanted.length < 15 && !page.rows.some(u => F.normalizedQuote(u.text) === wanted && /。$/.test(u.text))) return '';
  for (let i = 0; i < page.rows.length; i++) for (let n = 1; n <= 4 && i + n <= page.rows.length; n++) {
    const text = page.rows.slice(i, i + n).map(u => u.text).join('\n');
    if (F.normalizedQuote(text).includes(wanted)) return n === 1 ? String(page.rows[i].s) : `${page.rows[i].s}-${page.rows[i + n - 1].s}`;
  }
  return '';
}
function readPayload(request) {
  const data = JSON.parse(request.user);
  if (!data.claims) return data;
  const units = splitUnits(bodyText(data.body));
  return { ...data, claims: data.claims.map(c => ({ ...c, sentence: units.find(u => u.s === c.s)?.text || '' })), evidence: materials(request).map(p => ({ ...p, id: p.number })) };
}
function numberedFake(fake, context = {}) {
  return async request => {
    const ret = await fake(request);
    let data = ret;
    if (typeof ret === 'string' || ret?.text) {
      try { data = JSON.parse(typeof ret === 'string' ? ret : ret.text); } catch (_) { /* 壊れたJSONも試験対象。 */ }
    }
    if (request.task === 'extract' && Array.isArray(data)) {
      const units = [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => ({ s: Number(m[1]), text: m[2] }));
      data = data.map(c => {
        if (c.s !== undefined) return c;
        const sentence = F.normalizedQuote(c.sentence);
        return { s: units.find(u => F.normalizedQuote(u.text.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')) ===
          F.normalizedQuote((c.sentence || '').replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')))?.s || 0,
          type: c.type, subject: c.subject, claim: c.claim || sentence };
      });
    } else if (request.task === 'judge' && Array.isArray(data)) {
      const pages = materials(request), input = JSON.parse(request.user);
      data = data.map(r => {
        if (r.basis !== undefined || r.status === '資料なし') return r;
        const candidates = input.claims.find(c => c.id === r.id)?.evidence_ids || [];
        const idRef = context.refs?.find(e => e.id === r.evidence_id);
        const page = pages.find(p => (!r.evidence_id ? candidates.includes(p.number) : idRef ? p.url === (idRef.url || '') && p.title === (idRef.title || '') : p.number === r.evidence_id) && basisFor(p, r.quote));
        return { id: r.id, status: r.status, correct: r.correct || '', evidence_id: page?.number || 0, basis: page ? basisFor(page, r.quote) : '' };
      });
    } else if (request.task === 'repair' && typeof data === 'string') {
      const corrections = JSON.parse(request.user).corrections;
      if (context.body && F.preservesOtherText(context.body, data, corrections)) {
        const pairs = F.correctionPairs(context.body, data, corrections);
        data = corrections.map(c => ({ id: c.id, replacement: pairs.get(c.sentence) || '' }));
      }
    }
    return Array.isArray(data) ? ret?.text ? { ...ret, text: JSON.stringify(data) } : data : ret;
  };
}
function syntheticSource(ref, refs) {
  const catalog = E.evidenceCatalog();
  if (catalog.entries.some(e => e.id === ref.id && e.title === ref.title)) return E.loadEvidenceText(ref);
  const parts = refs.filter(e => e.id === ref.id);
  if (parts.every(e => Number.isInteger(e.text_start))) {
    const chars = Array(Math.max(...parts.map(e => e.text_start + e.text.length))).fill('空');
    for (const e of parts) for (let i = 0; i < e.text.length; i++) chars[e.text_start + i] = e.text[i];
    return chars.join('');
  }
  const unique = [];
  for (const e of parts) if (!unique.some(t => t.includes(e.text))) unique.push(e.text);
  return unique.join('\n' + '空'.repeat(1000) + '\n');
}
function adaptOptions(options = {}, body = '', refs = []) {
  const context = { body, refs: [...refs] };
  const search = options.searchEvidence || E.searchEvidence;
  return { ...options, loadEvidenceText: options.loadEvidenceText || (ref => syntheticSource(ref, context.refs)),
    searchEvidence: (...args) => { const found = search(...args); context.refs.push(...found); return found; },
    ...(options.callLLM ? { callLLM: numberedFake(options.callLLM, context) } : {}) };
}
const overrides = {
  extractClaims: (body, fake, options) => F.extractClaims(body, numberedFake(fake), options),
  judgeClaims: (claims, evidence, body, fake, options) => {
    const refs = Object.values(evidence).flat(), opts = adaptOptions(options, body, refs);
    return F.judgeClaims(claims, evidence, body, numberedFake(fake, { body, refs }), opts);
  },
  repairBody: (body, findings, fake, options) => F.repairBody(body, findings, numberedFake(fake, { body }), options),
  checkFacts: (body, options) => F.checkFacts(body, adaptOptions(options, body)),
  checkArticle: (raw, options) => F.checkArticle(raw, adaptOptions(options, require('gray-matter')(raw).content)),
};
const adapted = new Proxy(F, { get: (target, key) => overrides[key] || target[key], set: (target, key, value) => { target[key] = value; return true; } });
module.exports = { F: adapted, readPayload, materials, basisFor, numberedFake, adaptOptions, bodyText, rangeText };
