'use strict';

const fs = require('fs');
const path = require('path');
const laws = require('./law-sources');
const tsutatsu = require('./nta-tsutatsu');
const { tokenizeForMatcher } = require('./nta-source-matcher');
const { relationReferences } = require('./materials-bundle');
const { resolveSourceForTopic } = require('./tax-authority-refs');
const ROOT = path.join(__dirname, '..', '..');
let catalog;

function readEntries(dir, out) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, f.name);
    if (f.isDirectory()) readEntries(file, out);
    else if (f.name.endsWith('.json')) {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (e.deleted || !e.url || !(e.body || e.body_combined || e.kaitou_yoshi)) continue;
      const text = e.body || e.body_combined || [e.shokai_yoshi, e.kaitou_yoshi].filter(Boolean).join('\n');
      out.push({ id: e.url, kind: e.type === 'taxanswer' || /\/taxanswer\//.test(e.url) ? 'taxanswer' : 'shitsugi',
        no: String(e.id || ''), title: e.title || '', url: e.url, text, law_version: e.law_version || '' });
    }
  }
}

function evidenceCatalog() {
  if (catalog) return catalog;
  const entries = [];
  // 読み込みエラーを隠すと検索範囲を狭めたまま通過するため、照合全体を not_run にする。
  readEntries(path.join(ROOT, 'data', 'nta-sources', 'taxanswer'), entries);
  readEntries(path.join(ROOT, 'data', 'nta-sources', 'shitsugi'), entries);
  for (const [key, def] of Object.entries(laws.LAWS)) {
    const file = path.join(laws.LAW_DIR, `${key}.json`);
    if (!fs.existsSync(file)) continue;
    const searchIndex = laws.loadLawIndex(key);
    if (searchIndex) {
      entries.push(...searchIndex.entries.map(e => ({ ...e, url: laws.lawPageUrl(key, e.no), lazy: true })));
      continue;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const a of data.articles || []) entries.push({ id: `law:${key}:${a.num}`, kind: 'law', key, no: a.num,
      title: `${def.title} ${a.caption || ''}`, url: laws.lawPageUrl(key, a.num), text: a.text, law_version: data.amendment_enforcement_date || '' });
  }
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nta-tsutatsu', 'index.json'), 'utf8'));
  for (const item of index) {
    const searchFile = path.join(ROOT, 'data', 'nta-tsutatsu', item.search_index || `${item.circular}.index.json`);
    if (fs.existsSync(searchFile)) {
      entries.push(...JSON.parse(fs.readFileSync(searchFile, 'utf8')).entries.map(e => ({ ...e, lazy: true })));
      continue;
    }
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nta-tsutatsu', item.file), 'utf8'));
    for (const [no, p] of Object.entries(data.provisions || {})) entries.push({ id: `tsutatsu:${item.circular}:${no}`, kind: 'tsutatsu',
      circular: item.circular, no, title: `${item.label} ${p.title || ''}`, url: p.url, text: p.body, law_version: '' });
  }
  const df = new Map();
  for (const e of entries) {
    e.titleTokens = new Set(e.titleTokens || tokenizeForMatcher(e.title));
    e.tokens = new Set(e.tokens || tokenizeForMatcher(`${e.title} ${e.text}`));
    for (const token of e.tokens) df.set(token, (df.get(token) || 0) + 1);
  }
  catalog = { entries, df };
  return catalog;
}

function contiguousExcerpt(text, query, maxChars = 2000, focus = '') {
  if (text.length <= maxChars) return text;
  const tokens = [...tokenizeForMatcher(query)].filter(t => !/^\d+$/.test(t));
  const focusTokens = tokenizeForMatcher(focus);
  // リンク集に現れただけの語より、制度の説明を優先する。
  const tailAt = text.search(/関連リンク|関連コード|お問い合わせ先/);
  const searchable = tailAt > maxChars ? text.slice(0, tailAt) : text;
  const phrases = new Set();
  for (const m of String(query).matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{8,}/gu)) {
    for (let i = 0; i + 8 <= m[0].length; i++) phrases.add(m[0].slice(i, i + 8));
  }
  let best = { start: 0, score: -1 };
  for (let start = 0; start <= Math.max(0, searchable.length - maxChars); start += 100) {
    const window = searchable.slice(start, start + maxChars).normalize('NFKC').toLowerCase();
    const interior = window.slice(200, -200);
    const df = catalog?.df;
    const score = tokens.reduce((s, t) => s + (window.includes(t) ? (focusTokens.has(t) && interior.includes(t) ? 4 : 1) * t.length * Math.log(1 + 10000 / ((df?.get(t) || 0) + 1)) : 0), 0) +
      [...phrases].reduce((s, phrase) => s + (window.includes(phrase) ? 20 : 0), 0);
    if (score > best.score) best = { start, score };
  }
  return searchable.slice(best.start, best.start + maxChars);
}

/** カタログ全体を検索する。LLM・ネットワークは使わない。 */
function searchEvidence(claim, options = {}) {
  const { entries, df } = options.catalog || evidenceCatalog();
  const rawQuery = [claim.subject, claim.claim, claim.sentence, options.tax_terms].filter(Boolean).join(' ');
  // 読者の呼び方と原文の制度用語をつなぐ。記事や出典番号に依存しない。
  const synonyms = [
    [/二世帯住宅/, '区分所有 一棟 小規模宅地 居住'],
    [/売れ残り|型落ち/, '棚卸資産 著しい陳腐化 季節商品'],
    [/在庫/, '棚卸資産'],
  ].filter(([pattern]) => pattern.test(rawQuery)).map(([, words]) => words).join(' ');
  const focus = [
    /二世帯住宅/.test(rawQuery) ? '区分所有 一棟' : '',
    /売れ残り|型落ち/.test(rawQuery) ? '陳腐化 季節商品' : '',
  ].join(' ');
  const query = `${rawQuery} ${synonyms}`;
  const subjectTokens = tokenizeForMatcher(claim.subject);
  const tokens = [...tokenizeForMatcher(query)].filter(t => !/^\d+$/.test(t));
  const direct = new Set();
  for (const c of laws.findLawCitations(query)) if (c.found) direct.add(`law:${c.key}:${c.num}`);
  for (const c of relationReferences(query, options)) {
    if (c.kind === 'law' && c.key) direct.add(`law:${c.key}:${c.num}`);
    if (c.kind === 'tsutatsu') direct.add(`tsutatsu:${c.circular}:${c.no}`);
  }
  for (const c of tsutatsu.checkCitations(query, options).citations) if (c.found) for (const circular of c.candidates || [c.circular]) direct.add(`tsutatsu:${circular}:${c.no}`);
  const numbers = [...query.matchAll(/(?:No\.?|タックスアンサー|TA)\s*(\d{4})/gi)].map(m => m[1]);
  const bundle = new Set(String(options.source_bundle || '').split(';'));
  for (const ref of relationReferences([...bundle].join('、'))) {
    if (ref.kind === 'law' && ref.key) bundle.add(`law:${ref.key}:${ref.num}`);
    if (ref.kind === 'tsutatsu') bundle.add(`tsutatsu:${ref.circular}:${ref.no}`);
  }
  const mapped = resolveSourceForTopic({ pain_point: claim.subject, tax_terms: claim.subject, title: claim.subject,
    search_intent: claim.claim, tax_domain: options.tax_domain || '' });
  const ranked = entries.map(e => {
    let score = 0;
    for (const t of tokens) {
      const rarity = Math.log(1 + entries.length / ((df.get(t) || 0) + 1));
      if (e.tokens.has(t)) score += rarity * (subjectTokens.has(t) ? 2 : 1);
      if (e.titleTokens.has(t)) score += rarity * (subjectTokens.has(t) ? 6 : 3);
    }
    // 詳細事例だけで上位が埋まらないよう、制度名を端的に説明する題名を優先する。
    if (claim.subject && e.title.includes(claim.subject)) score += 80 * claim.subject.length / e.title.length;
    if (direct.has(e.id) || direct.has(`tsutatsu:${e.circular}:${e.no}`) || (e.kind === 'taxanswer' && numbers.includes(e.no))) score += 10000;
    if (bundle.has(e.id) || bundle.has(e.url)) score += 5;
    if (mapped?.url === e.url && !['domain-fallback', 'ultimate', 'unknown'].includes(mapped.provenance)) score += 10;
    return { e, score };
  }).filter(r => r.score > 5).sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  return ranked.slice(0, 3).map(({ e, score }) => {
    const { tokens: _tokens, titleTokens: _titleTokens, lazy: _lazy, ...data } = e;
    const text = e.lazy ? e.kind === 'law' ? laws.getArticle(e.key, e.no)?.text : tsutatsu.findProvisions(e.no, e.circular)[e.variant || 0]?.body : e.text;
    if (typeof text !== 'string') throw new Error('索引に対応する原文を読めませんでした');
    return { ...data, text: contiguousExcerpt(text, query, 2000, focus), score: Math.round(score * 100) / 100 };
  });
}

module.exports = { searchEvidence, evidenceCatalog, contiguousExcerpt };
