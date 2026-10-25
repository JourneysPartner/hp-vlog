'use strict';

const fs = require('fs');
const path = require('path');
const laws = require('./law-sources');
const tsutatsu = require('./nta-tsutatsu');
const { tokenizeForMatcher, rankSources, TAX_CATEGORY_CODES } = require('./nta-source-matcher');
const { relationReferences } = require('./materials-bundle');
const { resolveSourceForTopic } = require('./tax-authority-refs');
const ROOT = path.join(__dirname, '..', '..');
let catalog;
// 検索用の正規化文字列は資料オブジェクトに足さず、返却する資料の形を保つ。
const statementTexts = new WeakMap();
const statementFrequencies = new WeakMap();
const compactText = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
const phraseText = text => String(text || '').normalize('NFKC').toLowerCase().replace(/(?<=\d),(?=\d)/g, '');

// #642 の試算: 対応する根拠が候補にある主張は20→28件、既存の根拠は231/231件を維持。
const OTHER_TAX_SCORE = 0.15;
const TAX_WORDS = Object.freeze({
  income: ['所得税', '所得', '確定申告', '年末調整', '源泉', '譲渡所得', '取得費', '空き家'],
  corporate: ['法人', '会社', '役員', '事業年度'],
  consumption: ['消費税', 'インボイス', '適格請求書', '仕入税額', '課税売上', '免税事業者', '課税事業者',
    '簡易課税', '納税義務', '軽減税率', '2割特例', '3割特例', '基準期間'],
  inheritance: ['相続', '贈与', '遺贈', '遺産', '財産評価', '路線価'],
});
const CATEGORY_TAX = Object.freeze({
  __proto__: null,
  shotoku: 'income', gensen: 'income', joto: 'income', hojin: 'corporate', shohi: 'consumption',
  sozoku: 'inheritance', zoyo: 'inheritance', hyoka: 'inheritance',
});
const CIRCULAR_TAX = Object.freeze({
  __proto__: null,
  shotoku: 'income', sochi_shotoku: 'income', sochi_joto: 'income', hojin: 'corporate', sochi_hojin: 'corporate',
  shohi: 'consumption', sozoku: 'inheritance', sochi_sozoku: 'inheritance', hyoka: 'inheritance',
});

function evidenceTax(e) {
  if (e.kind === 'law') {
    if (e.key?.startsWith('shotokuzei_')) return 'income';
    if (e.key?.startsWith('hojinzei_')) return 'corporate';
    if (e.key?.startsWith('shohizei_')) return 'consumption';
    if (e.key?.startsWith('sozokuzei')) return 'inheritance';
  } else if (e.kind === 'tsutatsu') return CIRCULAR_TAX[e.circular];
  else return CATEGORY_TAX[e.url?.match(/\/(?:taxanswer|law\/shitsugi)\/([^/]+)\//)?.[1]];
}

function overlappingTokens(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

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

/** 末尾の補足だけを外し、途中のかっこと対応しないかっこは残す。 */
function subjectWithoutTrailingParens(subject) {
  if (typeof subject !== 'string') return subject;
  let name = subject;
  while (true) {
    const text = name.trimEnd(), stack = [];
    if (!/[）)]$/.test(text)) return name;
    let start = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ')' || ch === '）') stack.push(ch === ')' ? '(' : '（');
      else if (ch === '(' || ch === '（') {
        if (stack.pop() !== ch) return name;
        if (!stack.length) { start = i; break; }
      }
    }
    if (start < 0) return name;
    const next = text.slice(0, start).trimEnd();
    if (!next) return subject;
    name = next;
  }
}

/** カタログ全体を検索する。LLM・ネットワークは使わない。 */
function scoreEvidence(claim, options = {}) {
  const { entries, df } = options.catalog || evidenceCatalog();
  const subjectName = subjectWithoutTrailingParens(claim.subject);
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
  const articleTaxes = (TAX_CATEGORY_CODES[options.tax_domain] || []).map(code => CATEGORY_TAX[code]);
  const articleTax = options.tax_domain !== 'overseas_transactions' && articleTaxes.length && articleTaxes.every(tax => tax === articleTaxes[0]) ? articleTaxes[0] : undefined;
  const claimText = [claim.subject, claim.claim, claim.sentence].filter(Boolean).join(' ');
  // 主題・記事全体のtax_termsに引かれない、要約＋本文だけの補助順位。
  const statementRaw = [claim.claim, claim.sentence].filter(Boolean).join(' ');
  const statement = compactText(statementRaw);
  const statementTokens = tokenizeForMatcher(statementRaw);
  // 数字自体を照合する型では、誤った数字を持つ別制度・設例を呼び込まない。
  const numericEligible = ['要件', '判定', '手続'].includes(claim.type);
  let frequencies = statementFrequencies.get(entries);
  if (!frequencies) {
    frequencies = { titles: new Map(), numbers: new Map() };
    for (const e of entries) {
      const text = phraseText(e.text), title = compactText(e.title);
      const numbers = new Set(text.match(/\d+(?:\.\d+)?/g) || []);
      statementTexts.set(e, { title, text, numbers });
      frequencies.titles.set(title, (frequencies.titles.get(title) || 0) + 1);
      for (const number of numbers) frequencies.numbers.set(number, (frequencies.numbers.get(number) || 0) + 1);
    }
    statementFrequencies.set(entries, frequencies);
  }
  const normalizedStatement = phraseText(statementRaw);
  const rareNumbers = [...tokenizeForMatcher(normalizedStatement)]
    // 日・月などの頻出数字を資格にしないため、カタログの1%未満を目安にする。
    // 本文ありだけを母数にする変更は、既存の検索再現率を落とすため保留。
    .filter(t => /^\d+$/.test(t) && (frequencies.numbers.get(t) || 0) < entries.length * 0.01);
  // 日・月などの頻出する数字だけでは枠を使わず、珍しい数字を含む連続した文言で照合する。
  const phrases = new Map();
  for (const m of normalizedStatement.matchAll(/[\p{L}\p{N}ー]{6,}/gu)) {
    for (let i = 0; i + 6 <= m[0].length; i++) {
      const phrase = m[0].slice(i, i + 6);
      if (/^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(phrase) || phrases.has(phrase)) continue;
      const numericPatterns = [];
      if (numericEligible) for (const number of rareNumbers) {
        const match = new RegExp(`(?<!\\d)${number}(?!\\d)`).exec(phrase);
        if (!match) continue;
        // 6字の外側も含め、主張・資料の双方で数字の前後の桁を切っていないかを見る。
        const pattern = new RegExp(`${phrase.slice(0, match.index)}(?<!\\d)${number}(?!\\d)${phrase.slice(match.index + number.length)}`, 'u');
        if (pattern.test(normalizedStatement)) numericPatterns.push({ number, pattern });
      }
      phrases.set(phrase, numericPatterns);
    }
  }
  const weights = tokens.map(t => [t, Math.log(1 + (options.scorePopulation ?? entries.length) / ((df.get(t) || 0) + 1))]);
  const scored = entries.map(e => {
    let score = 0, statementScore = 0, numericMatch = false, titleMatch = false;
    for (const [t, rarity] of weights) {
      if (e.tokens.has(t)) score += rarity * (subjectTokens.has(t) ? 2 : 1);
      if (e.titleTokens.has(t)) score += rarity * (subjectTokens.has(t) ? 6 : 3);
      if (statementTokens.has(t)) {
        if (e.tokens.has(t)) statementScore += rarity;
        if (e.titleTokens.has(t)) statementScore += rarity * 3;
      }
    }
    // 詳細事例だけで上位が埋まらないよう、制度名を端的に説明する題名を優先する。
    if (subjectName && e.title.includes(subjectName)) score += 80 * subjectName.length / e.title.length;
    const indexed = statementTexts.get(e);
    if (indexed.title.length >= 2 && statement.includes(indexed.title) && e.titleTokens.size &&
        [...e.titleTokens].every(t => statementTokens.has(t))) {
      // 法令名だけの題名など、同じ題名を持つ多数の条をまとめて押し上げない。
      const titleBonus = 80 / frequencies.titles.get(indexed.title);
      statementScore += titleBonus; titleMatch = true;
    }
    for (const [phrase, numericPatterns] of phrases) if (indexed.text.includes(phrase)) {
      statementScore += 20;
      // 短い数字だけで別制度の本文に一致する場合は、題名にも主張の語が必要。
      // 数字が一致区間の半分以上を占める場合は、その具体性を使う。
      if (numericPatterns.some(({ number, pattern }) => indexed.numbers.has(number) && pattern.test(indexed.text) &&
          (number.length * 2 >= phrase.length || [...e.titleTokens].some(t => statementTokens.has(t))))) numericMatch = true;
    }
    const ownScore = score;
    const tax = evidenceTax(e);
    if (articleTax && tax && tax !== articleTax && !TAX_WORDS[tax].some(word => claimText.includes(word))) {
      score *= OTHER_TAX_SCORE; statementScore *= OTHER_TAX_SCORE;
    }
    let bonus = 0;
    if (direct.has(e.id) || direct.has(`tsutatsu:${e.circular}:${e.no}`) || (e.kind === 'taxanswer' && numbers.includes(e.no))) bonus += 10000;
    if (bundle.has(e.id) || bundle.has(e.url)) bonus += 5;
    if (mapped?.url === e.url && !['domain-fallback', 'ultimate', 'unknown'].includes(mapped.provenance)) bonus += 10;
    // 新しい枠にはTAX_WORDSの例外を使わず、記事と別税目なら資格を与えない。
    const statementEligible = !articleTax || !tax || tax === articleTax;
    return { e, score: score + bonus, ownScore: ownScore + bonus, statementScore, statementEligible, numericMatch, titleMatch, direct: bonus >= 10000 };
  });
  return { scored, subjectName, tokens, query, focus, bundle };
}

function searchEvidence(claim, options = {}) {
  const { scored, subjectName, tokens, query, focus, bundle } = scoreEvidence(claim, options);
  const byScore = (a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id);
  const ranked = scored.filter(r => r.score > 5).sort(byScore);
  const articleIds = new Set([options.source_url,
    ...(Array.isArray(options.source_supplements) ? options.source_supplements.map(s => typeof s === 'string' ? s : s?.url) : []),
    ...bundle].filter(Boolean));
  const isArticle = e => articleIds.has(e.id) || articleIds.has(e.url) || (e.kind === 'tsutatsu' && articleIds.has(`tsutatsu:${e.circular}:${e.no}`));
  const isPrimary = e => Boolean(options.source_url) && (e.id === options.source_url || e.url === options.source_url);
  // 主出典を先頭に、記事自身の資料は主張に近い順に並べる。
  const own = scored.filter(r => isArticle(r.e)).sort((a, b) => isPrimary(b.e) - isPrimary(a.e) || b.ownScore - a.ownScore || a.e.id.localeCompare(b.e.id));
  const selected = [], seen = new Set();
  const add = ({ e, score }) => {
    if (seen.has(e.id) || selected.length >= 7) return;
    seen.add(e.id); selected.push({ e, score });
  };
  // 記事資料の後に制度名だけの検索を足し、主張全体の上位3件も残す。
  own.slice(0, 3).forEach(add);
  const subjectRanking = subjectName && rankSources({ tax_domain: options.tax_domain, tax_terms: subjectName },
    { allCategories: !TAX_CATEGORY_CODES[options.tax_domain], limit: 1 });
  if (subjectRanking?.errorCode) throw new Error('制度名の検索用カタログを読めませんでした');
  const subjectTop = subjectRanking?.top1?.score > 0 && scored.find(r => r.e.url === subjectRanking.top1.url);
  if (subjectTop) add(subjectTop);
  // この3枠だけを重複除外する。own・subjectTopの枠と既存の追加順は変えない。
  const diverse = [];
  const addsEvidence = (row, rows) => {
    const addsQueryToken = tokens.some(t => row.e.tokens.has(t) && !rows.some(r => r.e.tokens.has(t)));
    return addsQueryToken || !rows.some(r => overlappingTokens(r.e.tokens, row.e.tokens) >= 0.9);
  };
  for (const row of ranked) {
    if (!addsEvidence(row, diverse)) continue;
    diverse.push(row);
    if (diverse.length === 3) break;
  }
  // この枠は索引に本文を持つTA・質疑応答だけを選ぶ。法令・通達の本文は遅延読込しない。
  const statementRanked = scored.filter(r => r.statementEligible && r.statementScore > 5 && r.e.text &&
    ['taxanswer', 'shitsugi'].includes(r.e.kind)).sort((a, b) => b.statementScore - a.statementScore || byScore(a, b));
  const statementTop = statementRanked.find(r => (r.numericMatch || r.titleMatch) && !seen.has(r.e.id) &&
    !diverse.slice(0, 2).some(d => d.e.id === r.e.id) && addsEvidence(r, diverse.slice(0, 2)));
  if (statementTop && statementTop.statementScore === statementRanked[0].statementScore && !diverse[2]?.direct) {
    // 本文の最上位（同点を含む）だけで3枠目を置き換える。直接引用は残す。
    // 最上位が既に記事資料等にあれば、次点を無理に足して資料表を増やさない。
    const retainedIds = new Set(seen);
    for (const row of [...diverse, ...own.slice(3)]) {
      if (retainedIds.size >= 7) break;
      retainedIds.add(row.e.id);
    }
    // 記事資料の4件目以降など、入れ替えなくても最終7件に残るページには枠を使わない。
    if (!retainedIds.has(statementTop.e.id)) diverse.splice(2, 1, statementTop);
  }
  diverse.forEach(add);
  own.slice(3).forEach(add);
  return selected.map(({ e, score }) => {
    const { tokens: _tokens, titleTokens: _titleTokens, lazy: _lazy, ...data } = e;
    const text = e.lazy ? e.kind === 'law' ? laws.getArticle(e.key, e.no)?.text : tsutatsu.findProvisions(e.no, e.circular)[e.variant || 0]?.body : e.text;
    if (typeof text !== 'string') throw new Error('索引に対応する原文を読めませんでした');
    const excerpt = contiguousExcerpt(text, query, 2000, focus);
    return { ...data, text: excerpt, text_start: text.indexOf(excerpt), score: Math.round(score * 100) / 100 };
  });
}

// 検索の候補・順番・抜粋は変えず、資料表を作るときだけ原文を読む。
function loadEvidenceText(ref) {
  const entry = evidenceCatalog().entries.find(e => e.id === ref.id);
  if (!entry) return ref.text;
  const text = entry.lazy ? entry.kind === 'law' ? laws.getArticle(entry.key, entry.no)?.text
    : tsutatsu.findProvisions(entry.no, entry.circular)[entry.variant || 0]?.body : entry.text;
  if (typeof text !== 'string') throw new Error('索引に対応する原文を読めませんでした');
  return text;
}
module.exports = { searchEvidence, evidenceCatalog, contiguousExcerpt, loadEvidenceText, subjectWithoutTrailingParens, scoreEvidence, evidenceTax, CATEGORY_TAX };
