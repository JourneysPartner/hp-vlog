'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const laws = require('../law-sources');
const P = require('../tsutatsu-parser');
const T = require('../nta-tsutatsu');
const C = require('../../crawl-nta-tsutatsu');
const fixtures = path.join(__dirname, '../../../docs/codex-tasks/fact-grounding/fixtures');
const lawFixture = require(path.join(fixtures, 'law-ids.json'));
const pages = require(path.join(fixtures, 'tsutatsu-pages.json'));
let pass = 0, fail = 0;
const groups = {}, stats = [], catalog = {};
function test(group, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { fn(); pass++; groups[group].pass++; console.log(`PASS ${group}`); }
  catch (e) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${e.stack}`); }
}
for (const l of lawFixture.laws) test('R1', () => {
  assert.equal(laws.LAWS[l.key].law_id, l.law_id);
  assert.equal(laws.LAWS[l.key].title, l.title);
  assert.deepEqual(laws.LAWS[l.key].elms, l.elms);
  for (const alias of l.aliases) assert.ok((laws.LAWS[l.key].aliases || []).includes(alias) || l.key === 'sozokuzei');
  assert.equal(laws.LAWS[l.key].articles, undefined);
});
for (const c of pages.circulars) test('R2', () => {
  const def = C.CIRCULARS[c.key];
  assert.equal(def.index, c.index_url);
  let urls, entries = [];
  const pageStats = [];
  for (const p of c.files) {
    const html = new TextDecoder('shift_jis').decode(fs.readFileSync(path.join(fixtures, p.file)));
    if (p.kind === 'index') urls = P.parseIndexPage(html, c.key, p.url);
    else {
      const parsed = P.parseTsutatsuPage(html, { circular: c.key, url: p.url });
      assert.ok(parsed.provisions.length > 0);
      assert.ok(parsed.provisions.every(p => p.no && p.body && (p.title || p.body.includes('削除'))));
      entries.push(...parsed.provisions);
      pageStats.push({ file: p.file, count: parsed.provisions.length, first: parsed.provisions[0].no, last: parsed.provisions.at(-1).no });
    }
  }
  for (const p of c.files.filter(p => p.kind === 'body')) assert.ok(urls.includes(p.url), p.url);
  const stored = C.provisionsByNumber(entries, c.key);
  const duplicates = Object.entries(stored).filter(([, p]) => Array.isArray(p)).map(([no]) => no);
  if (c.key === 'sochi_hojin') { assert.ok(duplicates.includes('67の5-1の2')); assert.equal(stored['67の5-1の2'].length, 2); }
  if (c.key === 'hyoka') { assert.ok(stored['11']); assert.ok(stored['10'].body.includes('削除')); }
  if (c.key === 'sochi_sozoku') assert.ok(stored['70の2の2-1']);
  if (c.key === 'sochi_shotoku') assert.ok(stored['28の2-2'].body.includes('40万円'));
  catalog[c.key] = { ...def, provisions: stored };
  stats.push({ key: c.key, index_pages: urls.length, count: entries.length, first: entries[0].no, last: entries.at(-1).no, duplicates, pages: pageStats });
});
test('R2', () => {
  const html = '<title>指定されたページを表示できませんでした</title>';
  assert.throws(() => P.parseTsutatsuPage(html, { circular: 'shotoku' }));
  assert.throws(() => P.parseIndexPage(html, 'hyoka', C.CIRCULARS.hyoka.index));
  assert.throws(() => P.parseTsutatsuPage('<title>国税庁</title><h1>指定されたページを表示できませんでした</h1>', { circular: 'hyoka' }));
});
test('R2', () => assert.equal(P.normalizeProvisionNo('６１の４（１）－１'), '61の4(1)-1'));
for (const [no, expected] of [['69の4-8', ['sochi_sozoku']], ['28の2-2', ['sochi_shotoku']], ['35-3', ['sochi_joto']], ['67の5-1の2', ['sochi_hojin']]]) test('R2', () => {
  assert.deepEqual(T.resolveSochi(no, { catalog }), expected);
  console.log(`措通${no} → ${expected.join(',')}`);
});
test('R2', () => {
  assert.deepEqual(T.resolveSochi('69の4-999', { catalog: {} }), ['sochi_sozoku']);
  assert.deepEqual(T.resolveSochi('42の3-99', { catalog: {} }), ['sochi_shotoku', 'sochi_joto']);
  assert.deepEqual(T.resolveSochi('42の3の2-99', { catalog: {} }), ['sochi_hojin']);
  assert.deepEqual(T.resolveSochi('999-1', { catalog: {}, tax_domain: 'corporate_tax' }), ['sochi_hojin']);
  assert.equal(T.resolveSochi('999-1', { catalog: {} }).length, 4);
  const both = { sochi_shotoku: { provisions: { '35-3': {} } }, sochi_joto: { provisions: { '35-3': {} } } };
  assert.deepEqual(T.resolveSochi('35-3', { catalog: both, tax_domain: 'capital_gains' }), ['sochi_joto']);
});
test('R3', () => {
  const index = require('../catalog-search-index').lawSearchIndex({ key: 'shotokuzei_rei', title: '所得税法施行令', articles: [{ num: '104', caption: '棚卸資産', text: '季節商品を評価する。' }] });
  assert.equal(index.entries[0].text, undefined); assert.ok(index.entries[0].tokens.length);
});
test('R3', () => {
  const bodyFile = path.join(laws.LAW_DIR, 'shotokuzei_rei.json'), indexFile = path.join(laws.LAW_DIR, 'shotokuzei_rei.index.json');
  const body = { key: 'shotokuzei_rei', title: '所得税法施行令', articles: [{ num: '104', caption: '評価損', text: '季節商品の評価損を原文で確認する。' }] };
  const index = require('../catalog-search-index').lawSearchIndex(body);
  const oldExists = fs.existsSync, oldRead = fs.readFileSync; let bodyReads = 0;
  laws.resetCacheForTest();
  try {
    fs.existsSync = file => [bodyFile, indexFile].includes(file) || oldExists(file);
    fs.readFileSync = (file, ...args) => {
      if (file === indexFile) return JSON.stringify(index);
      if (file === bodyFile) { bodyReads++; return JSON.stringify(body); }
      return oldRead(file, ...args);
    };
    assert.equal(laws.findLawCitations('所令104条')[0].found, true); assert.equal(bodyReads, 0);
    const entry = index.entries[0];
    const refs = require('../fact-evidence').searchEvidence({ sentence: '所令104条の季節商品の評価損', subject: '季節商品', claim: '評価損' }, { catalog: {
      entries: [{ ...entry, lazy: true, tokens: new Set(entry.tokens), titleTokens: new Set(entry.titleTokens) }], df: new Map(),
    } });
    assert.equal(refs[0].text, body.articles[0].text); assert.equal(bodyReads, 1);
  } finally { fs.existsSync = oldExists; fs.readFileSync = oldRead; laws.resetCacheForTest(); }
});
test('R4', () => {
  const citations = laws.findLawCitations('所令104条・法令68条・消令1条。一般の法令に従う。法令68は見出し。');
  assert.deepEqual(citations.map(c => c.key), ['shotokuzei_rei', 'hojinzei_rei', 'shohizei_rei']);
  for (const c of citations) assert.equal(c.found, !!laws.getArticle(c.key, c.num));
  assert.ok(laws.findLawCitations('所令9999条・法令9999条・消令9999条').every(c => !c.found));
  assert.ok(T.checkCitations('所基通47-22').citations[0].found);
  for (const text of ['措通69の4-8', '評基通11']) {
    const result = T.checkCitations(text);
    assert.equal(result.citations.length, 1);
    assert.equal(result.unknown.length, result.citations[0].found ? 0 : 1);
  }
  for (const text of ['措通69の4-999', '評基通999']) assert.equal(T.checkCitations(text).unknown.length, 1);
});
test('R4', () => {
  const M = require('../materials-bundle'), E = require('../fact-evidence');
  const { tokenizeForMatcher } = require('../nta-source-matcher');
  const oldRead = fs.readFileSync, oldArticle = laws.getArticle, oldProvision = T.findProvision;
  const url = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm';
  const sourceFile = require('../nta-source-body').resolveSourceFile(url);
  try {
    fs.readFileSync = (file, ...args) => path.resolve(file) === path.resolve(sourceFile) ? JSON.stringify({ kankei_hourei: '所令104条、措通69の4-8、評基通11' }) : oldRead(file, ...args);
    laws.getArticle = (key, num) => key === 'shotokuzei_rei' && num === '104' ? { num, text: '季節商品について評価損を確認する。' } : oldArticle(key, num);
    T.findProvision = (no, circular) => ['sochi_sozoku', 'hyoka'].includes(circular) ? { no, body: '建替え中の居住と財産評価の原文。', url: 'https://example.jp/' } : oldProvision(no, circular);
    const chain = M.buildLawChain([{ url }], { log: () => {} });
    assert.equal(chain.attached.length, 3); assert.ok(chain.block.includes('季節商品'));
    const entries = chain.attached.map((r, i) => ({ id: `test${i}`, kind: r.kind, title: r.label, text: r.text, url: r.url,
      tokens: tokenizeForMatcher(r.text + r.label), titleTokens: tokenizeForMatcher(r.label) }));
    const refs = E.searchEvidence({ sentence: '季節商品の評価損を確認する。', subject: '季節商品', claim: '評価損を確認する。' }, { catalog: { entries, df: new Map() } });
    assert.ok(refs.some(r => r.text.includes('季節商品')));
  } finally { fs.readFileSync = oldRead; laws.getArticle = oldArticle; T.findProvision = oldProvision; }
});
test('R4', () => {
  const refs = require('../materials-bundle').relationReferences('所令104条、措通69の4-8、評基通11');
  assert.ok(refs.some(r => r.key === 'shotokuzei_rei')); assert.ok(refs.some(r => r.circular === 'sochi_sozoku')); assert.ok(refs.some(r => r.circular === 'hyoka'));
});
console.log('通達見本の解析:', JSON.stringify(stats));
console.log(`カタログ拡張: PASS ${pass} / FAIL ${fail}\n${JSON.stringify(groups)}`);
process.exitCode = fail ? 1 : 0;
