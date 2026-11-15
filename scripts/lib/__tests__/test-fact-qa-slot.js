'use strict';

// 02-qa-slot。LLM・ネットワークは使わない。資料は読み取りだけ。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const E = require('../fact-evidence');
const F = require('../fact-check');
const P = require('../fact-pages');
const { tokenizeForMatcher, rankSources, TAX_CATEGORY_CODES } = require('../nta-source-matcher');
const root = path.resolve(__dirname, '../../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'docs/codex-tasks/fact-search/fixtures/qa-slot/pr693-claims.json'), 'utf8'));

const groups = {};
function test(group, name, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
// id・順番・抜粋・点をまとめて比べる。抜粋は開始位置・長さ・内容の要約で固定する。
const snapshot = refs => refs.map(e => [e.id, e.score, e.text_start, e.text.length, sha(e.text)]);
const qaIds = refs => refs.filter(e => e.id.startsWith('qa:')).map(e => e.id);

const claims = Object.fromEntries(fixture.claims.map(c => [c.id, c]));
// 分野の違う固定の主張（所得税・相続税）。
const INCOME_CLAIM = { id: 'i1', type: '要件', subject: '給与所得の確定申告', claim: '給与収入が2,000万円を超える人は確定申告が必要',
  sentence: '給与収入が2,000万円を超える人は確定申告が必要です。' };
const INHERITANCE_CLAIM = { id: 'z1', type: '金額', subject: '贈与税の基礎控除', claim: '贈与税の基礎控除は110万円',
  sentence: '贈与税の基礎控除は110万円です。' };
// その呼び出しで必ず高い点になる「わな」の Q&A。主張の文・主題をそのまま題名と本文に入れ、
// tax_domain をその呼び出しと同じにする。source_key は SCOPES でその主題に当たるもの。
const INVOICE_TRAP = { sourceKey: 'invoice', taxDomain: 'invoice_system', taxCategoryCode: 'shohi' };
const INHERITANCE_TRAP = { sourceKey: 'sozoku', taxDomain: 'inheritance_tax', taxCategoryCode: 'sozoku' };
// 所得税の呼び出し用。Q&A は tax_domain が一致するものしか残らないため、わなも所得税の
// 分野（tax_domain: 'income_tax'）にする。source_key は scope の語（「インボイス」）で
// 当たる 'invoice' にする（所得税の資料は scope に無い）。
const INCOME_TRAP = { sourceKey: 'invoice', taxDomain: 'income_tax', taxCategoryCode: 'shotoku' };

// Q&A を使わない呼び出し（変更前と同じ）。
function noQaOptions(extra = {}) {
  const options = { tax_terms: fixture.meta.tax_terms, source_bundle: fixture.meta.source_bundle,
    tax_domain: fixture.meta.tax_domain, source_url: fixture.meta.source_url,
    source_supplements: [2, 3, 4].map(n => ({ url: fixture.meta[`source_${n}_url`] })), ...extra };
  return options;
}
const qaOptions = extra => ({ ...F.articleEvidenceOptions(fixture.meta), ...extra });

// Q&A の読み込み先だけを差し替える（本物の data/ は変えない）。
const QA_DIR = path.join(root, 'data', 'nta-qa');
function withQaFiles(entries, files, fn) {
  const indexPath = path.join(QA_DIR, 'index.json');
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    const resolved = path.resolve(file);
    if (resolved === path.resolve(indexPath)) {
      return typeof entries === 'function' ? entries() : JSON.stringify({ version: 1, entries });
    }
    const key = [...files.keys()].find(name => path.resolve(path.join(QA_DIR, name)) === resolved);
    if (key !== undefined) {
      const value = files.get(key);
      return typeof value === 'function' ? value() : value;
    }
    return original.call(fs, file, ...args);
  };
  E.resetQaEvidenceForTest();
  try { return fn(); } finally {
    fs.readFileSync = original;
    E.resetQaEvidenceForTest();
  }
}
const qaQuestion = (body, title, extra = {}) => JSON.stringify({ body, title, ...extra });
const qaIndexEntry = (id, filePath, extra = {}) => ({ id, type: 'qa', source_key: 'invoice', source_label: '試験のQ&A',
  tax_category: '消費税', tax_category_code: 'shohi', tax_domain: 'invoice_system', q_no: id, digest: false,
  title: `問 ${id}`, url: 'https://example.test/qa.pdf', file_path: filePath, ...extra });

/** わなの Q&A を 1 件だけ持つ索引と、その問のファイル。 */
function trapQa(claim, spec) {
  const title = claim.subject;
  const body = [claim.claim, claim.sentence].filter(Boolean).join(' ');
  const entries = [qaIndexEntry('trap', 'test/trap.json', {
    source_key: spec.sourceKey, tax_domain: spec.taxDomain,
    tax_category_code: spec.taxCategoryCode, title,
  })];
  return {
    id: `qa:${spec.sourceKey}/trap`,
    entries,
    files: new Map([['test/trap.json', qaQuestion(body, title)]]),
  };
}

test('T1', 'qa_scope_text が無ければ、Q&A は候補に何の影響も与えない', () => {
  const incomeOptions = noQaOptions({ tax_domain: 'income_tax', source_url: undefined, source_bundle: undefined, source_supplements: [], tax_terms: undefined });
  const inheritanceOptions = noQaOptions({ tax_domain: 'inheritance_tax', source_url: undefined, source_bundle: undefined, source_supplements: [], tax_terms: undefined });
  // 今と同じ 4 つの呼び出し（オプションも今と同じ）。
  const calls = [
    { name: 'c41', claim: claims.c41, options: noQaOptions(), trap: INVOICE_TRAP },
    { name: 'c40', claim: claims.c40, options: noQaOptions(), trap: INVOICE_TRAP },
    { name: '所得税', claim: INCOME_CLAIM, options: incomeOptions, trap: INCOME_TRAP },
    { name: '相続', claim: INHERITANCE_CLAIM, options: inheritanceOptions, trap: INHERITANCE_TRAP },
  ];
  for (const call of calls) {
    // 1. 結果に qa: の id が無い。
    const real = E.searchEvidence(call.claim, call.options);
    assert.deepEqual(qaIds(real), [], `${call.name}: 結果に qa: の id が無い`);
    // 2. 本物の Q&A のままの結果が、Q&A の索引を空にした状態の結果と同じ。
    const empty = withQaFiles([], new Map(), () => E.searchEvidence(call.claim, call.options));
    assert.deepEqual(snapshot(real), snapshot(empty), `${call.name}: Q&A の索引を空にした結果と同じ`);
    // 3. その呼び出しで必ず高い点になるわなの Q&A だけを入れても、2 と同じ。
    const trap = trapQa(call.claim, call.trap);
    const trapped = withQaFiles(trap.entries, trap.files, () => E.searchEvidence(call.claim, call.options));
    assert.deepEqual(snapshot(trapped), snapshot(empty), `${call.name}: わなの Q&A を索引に入れても同じ`);
  }
  // 4. わなが効くことの確かめ。
  const c41Trap = trapQa(claims.c41, INVOICE_TRAP);
  const c41Ids = withQaFiles(c41Trap.entries, c41Trap.files,
    () => E.searchEvidence(claims.c41, qaOptions())).map(ref => ref.id);
  assert.ok(c41Ids.includes(c41Trap.id), 'c41: qa_scope_text を付けるとわなの id が結果に入る');
  const inheritanceTrap = trapQa(INHERITANCE_CLAIM, INHERITANCE_TRAP);
  const inheritanceScoped = { ...inheritanceOptions, qa_scope_text: '贈与税の基礎控除' };
  const inheritanceIds = withQaFiles(inheritanceTrap.entries, inheritanceTrap.files,
    () => E.searchEvidence(INHERITANCE_CLAIM, inheritanceScoped)).map(ref => ref.id);
  assert.ok(inheritanceIds.includes(inheritanceTrap.id),
    '相続: qa_scope_text に「贈与税の基礎控除」を入れるとわなの id が結果に入る');
  // 所得税のわなも、その分野の呼び出しに scope の語を付けると効く。
  const incomeTrap = trapQa(INCOME_CLAIM, INCOME_TRAP);
  const incomeScoped = { ...incomeOptions, qa_scope_text: 'インボイス' };
  const incomeIds = withQaFiles(incomeTrap.entries, incomeTrap.files,
    () => E.searchEvidence(INCOME_CLAIM, incomeScoped)).map(ref => ref.id);
  assert.ok(incomeIds.includes(incomeTrap.id),
    '所得税: qa_scope_text に「インボイス」を入れると所得税のわなの id が結果に入る');
});

test('T2', '対象の Q&A が無い記事では、qa_scope_text があっても結果は変わらない', () => {
  const incomePlain = noQaOptions({ tax_domain: 'income_tax', source_url: undefined, source_bundle: undefined, source_supplements: [], tax_terms: undefined });
  const incomeScoped = { ...incomePlain, qa_scope_text: '所得税の記事 確定申告 給与所得' };
  // 1. 所得税の呼び出しに qa_scope_text を付けても付けなくても同じ。
  assert.deepEqual(snapshot(E.searchEvidence(INCOME_CLAIM, incomeScoped)),
    snapshot(E.searchEvidence(INCOME_CLAIM, incomePlain)), '所得税: qa_scope_text の有無で結果が変わらない');
  // 2. c41 の noQaOptions に同じ qa_scope_text を付けても付けなくても同じ。
  const invoicePlain = noQaOptions();
  const invoiceScoped = noQaOptions({ qa_scope_text: '所得税の記事 確定申告 給与所得' });
  assert.deepEqual(snapshot(E.searchEvidence(claims.c41, invoiceScoped)),
    snapshot(E.searchEvidence(claims.c41, invoicePlain)), 'c41: 分野の違う qa_scope_text で結果が変わらない');
  // 3. 1・2 を、T1 の 3 のわなを入れた状態でも確かめる（所得税の分は所得税の分野のわな）。
  const trap = trapQa(claims.c41, INVOICE_TRAP);
  const withTrap = (claim, options) => snapshot(withQaFiles(trap.entries, trap.files,
    () => E.searchEvidence(claim, options)));
  const incomeTrap = trapQa(INCOME_CLAIM, INCOME_TRAP);
  const withIncomeTrap = options => snapshot(withQaFiles(incomeTrap.entries, incomeTrap.files,
    () => E.searchEvidence(INCOME_CLAIM, options)));
  assert.deepEqual(withIncomeTrap(incomeScoped), withIncomeTrap(incomePlain),
    '所得税: 所得税のわなを入れても qa_scope_text の有無で結果が変わらない');
  assert.deepEqual(withTrap(claims.c41, invoiceScoped), withTrap(claims.c41, invoicePlain),
    'c41: わなを入れても分野の違う qa_scope_text で結果が変わらない');
  // 4. 分野の違う Q&A は tax_domain で落ちる。
  assert.deepEqual(qaIds(E.searchEvidence(claims.c41, qaOptions({ tax_domain: 'income_tax' }))), []);
});

test('T3', '#693 の c41・c42・c63 で事例集が候補に入り、候補は 7 件以内', () => {
  for (const id of ['c41', 'c42', 'c63']) {
    const refs = E.searchEvidence(claims[id], qaOptions());
    assert.ok(refs.some(e => e.id === 'qa:invoice/jireishu'), id);
    assert.ok(refs.length <= 7, id);
    assert.equal(new Set(refs.map(e => e.id)).size, refs.length, id);
  }
});

test('T4', 'c40・c46 で記事の資料・本文の枠のページが残る（押し出されるのは一般の枠だけ）', () => {
  const own = [fixture.meta.source_url, fixture.meta.source_2_url, fixture.meta.source_3_url, fixture.meta.source_4_url];
  const c40 = E.searchEvidence(claims.c40, qaOptions());
  assert.ok(c40.some(e => e.id === 'qa:invoice/jireishu'));
  for (const id of [...own, 'tsutatsu:shohi:21-1-1', 'law:shohizei_hou:57_2']) assert.ok(c40.some(e => e.id === id), id);
  const c46 = E.searchEvidence(claims.c46, qaOptions());
  for (const id of [...own, 'tsutatsu:shohi:21-1-1', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6137.htm']) {
    assert.ok(c46.some(e => e.id === id), id);
  }
});

// 検索の枠を試験用に固定する。資料の形は evidenceCatalog と同じ（tokens/titleTokens を持つ）。
function entry(id, no, title, text) {
  return { id, kind: 'taxanswer', no, title, url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/${no}.htm`, text,
    tokens: new Set(tokenizeForMatcher(`${title} ${text}`)), titleTokens: new Set(tokenizeForMatcher(title)) };
}
function catalog(entries) {
  const df = new Map();
  for (const e of entries) for (const token of e.tokens) df.set(token, (df.get(token) || 0) + 1);
  return { entries, df };
}

function overlap(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

/**
 * Q&A なしの検索が選ぶ枠（記事の資料・制度名の検索・直接引用・本文の枠）を、
 * searchEvidence と同じ手順で求める。変更前の候補を保護する試験に使う。
 */
function frames(claim, options) {
  const { scored, subjectName, tokens, bundle } = E.scoreEvidence(claim, options);
  const byScore = (a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id);
  const ranked = scored.filter(r => r.score > 5).sort(byScore);
  const articleIds = new Set([options.source_url,
    ...(Array.isArray(options.source_supplements) ? options.source_supplements.map(s => typeof s === 'string' ? s : s?.url) : []),
    ...bundle].filter(Boolean));
  const isArticle = e => articleIds.has(e.id) || articleIds.has(e.url) ||
    (e.kind === 'tsutatsu' && articleIds.has(`tsutatsu:${e.circular}:${e.no}`));
  const isPrimary = e => Boolean(options.source_url) && (e.id === options.source_url || e.url === options.source_url);
  const seen = new Set();
  const add = row => { if (row && !seen.has(row.e.id)) seen.add(row.e.id); };
  const own = scored.filter(r => isArticle(r.e)).sort((a, b) => isPrimary(b.e) - isPrimary(a.e) ||
    b.ownScore - a.ownScore || a.e.id.localeCompare(b.e.id));
  own.slice(0, 3).forEach(add);
  const subjectRanking = subjectName && rankSources({ tax_domain: options.tax_domain, tax_terms: subjectName },
    { allCategories: !TAX_CATEGORY_CODES[options.tax_domain], limit: 1 });
  const subjectTop = subjectRanking?.top1?.score > 0 && scored.find(r => r.e.url === subjectRanking.top1.url);
  if (subjectTop) add(subjectTop);
  const diverse = [];
  const addsEvidence = (row, rows) => {
    const addsQueryToken = tokens.some(t => row.e.tokens.has(t) && !rows.some(r => r.e.tokens.has(t)));
    return addsQueryToken || !rows.some(r => overlap(r.e.tokens, row.e.tokens) >= 0.9);
  };
  for (const row of ranked) { if (!addsEvidence(row, diverse)) continue; diverse.push(row); if (diverse.length === 3) break; }
  const statementRanked = scored.filter(r => r.statementEligible && r.statementScore > 5 && r.e.text &&
    ['taxanswer', 'shitsugi'].includes(r.e.kind)).sort((a, b) => b.statementScore - a.statementScore || byScore(a, b));
  const statementTop = statementRanked.find(r => (r.numericMatch || r.titleMatch) && !seen.has(r.e.id) &&
    !diverse.slice(0, 2).some(d => d.e.id === r.e.id) && addsEvidence(r, diverse.slice(0, 2)));
  return { isArticle, subjectTopId: subjectTop ? subjectTop.e.id : undefined,
    statementTopId: statementTop ? statementTop.e.id : undefined,
    directIds: new Set(scored.filter(r => r.direct).map(r => r.e.id)) };
}

test('T5', '入れる場所: 空きがあれば末尾に足す／7 件なら 3 枠目→2 枠目の順に置き換える／保護された枠だけなら入れない', () => {
  const c41 = claims.c41;
  // 空き: 末尾に足し、何も押し出さない。
  const one = [entry('e1', '9001', '登録の取消し 資料', '登録の取消しを求める旨の届出書を提出する。')];
  const appended = E.searchEvidence({ ...c41, claim: `${c41.claim} TA 9001`, sentence: `${c41.sentence} TA 9001` },
    qaOptions({ catalog: catalog(one) }));
  assert.deepEqual(appended.map(e => e.id), ['e1', 'qa:invoice/jireishu']);
  // #693 c41: 3 枠目は記事の資料（TA6613）なので、2 枠目（消法57条の2）と置き換える。
  const c41Ids = E.searchEvidence(c41, qaOptions()).map(e => e.id);
  assert.ok(c41Ids.includes('qa:invoice/jireishu'));
  assert.ok(c41Ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm'), '記事の資料が残る');
  assert.ok(!c41Ids.includes('law:shohizei_hou:57_2'), '2 枠目だった一般の枠が置き換わる');
  // #693 c46: 3 枠目が本文の枠（6137）なので、本文の枠を残して 2 枠目と置き換える。
  const c46Ids = E.searchEvidence(claims.c46, qaOptions()).map(e => e.id);
  assert.ok(c46Ids.includes('qa:invoice/07') || c46Ids.includes('qa:invoice/jireishu'));
  assert.ok(c46Ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6137.htm'));
  assert.ok(!c46Ids.includes('law:shohizei_hou:57_2'), '2 枠目だった一般の枠が置き換わる');
  // #693 c63: 2・3 枠目を記事の資料にすると、置き換えてよい枠が無いので Q&A は入れない。
  const lockedIds = E.searchEvidence(claims.c63,
    qaOptions({ source_bundle: `${fixture.meta.source_bundle};law:shohizei_hou:57_2` })).map(e => e.id);
  assert.ok(!lockedIds.some(id => id.startsWith('qa:')), '保護された枠だけなら入れない');
  assert.ok(lockedIds.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6630.htm'));
  // 直接引用が 3 枠を占め、記事の資料 4 件と合わせて 7 件になる場合も入れない。
  const directCatalog = [
    entry('a1', '9011', '登録の取消し 資料1', '登録の取消しを求める旨の届出書を提出する。'),
    entry('a2', '9012', '登録の取消し 資料2', '登録の取消しを求める旨の届出書を提出する。'),
    entry('a3', '9013', '登録の取消し 資料3', '登録の取消しを求める旨の届出書を提出する。'),
    entry('a4', '9014', '登録の取消し 資料4', '登録の取消しを求める旨の届出書を提出する。'),
    entry('d1', '9001', '適格請求書 資料', '適格請求書の発行。'),
    entry('d2', '9002', '仕入税額控除 資料', '仕入税額控除の計算。'),
    entry('d3', '9003', '免税事業者 資料', '免税事業者の届出。'),
  ];
  const directClaim = { ...c41, claim: `${c41.claim} TA 9001 TA 9002 TA 9003`,
    sentence: `${c41.sentence} TA 9001 TA 9002 TA 9003` };
  const directRefs = E.searchEvidence(directClaim, qaOptions({ source_url: 'a1',
    source_supplements: [{ url: 'a2' }, { url: 'a3' }, { url: 'a4' }], catalog: catalog(directCatalog) }));
  const directIds = directRefs.map(e => e.id);
  assert.equal(directRefs.length, 7);
  for (const id of ['a1', 'a2', 'a3', 'a4', 'd1', 'd2', 'd3']) assert.ok(directIds.includes(id), `${id} が残る`);
  assert.ok(!directIds.some(id => id.startsWith('qa:')), '直接引用は置き換えない');
});

test('P1', 'fixture の 5 主張で、変更前の候補の記事の資料・制度名・直接引用・本文の枠が変更後も残る', () => {
  for (const id of ['c40', 'c41', 'c42', 'c46', 'c63']) {
    const preOptions = { ...qaOptions(), qa_scope_text: undefined };
    const fr = frames(claims[id], preOptions);
    const pre = E.searchEvidence(claims[id], preOptions);
    const protectedRefs = pre.filter(ref => fr.isArticle(ref) || ref.id === fr.subjectTopId ||
      fr.directIds.has(ref.id) || ref.id === fr.statementTopId);
    const post = E.searchEvidence(claims[id], qaOptions());
    const postIds = new Set(post.map(e => e.id));
    assert.ok(post.length <= 7, `${id}: 7 件以内`);
    for (const ref of protectedRefs) assert.ok(postIds.has(ref.id), `${id}: ${ref.id} が残る`);
    if (id === 'c41' || id === 'c42') {
      assert.ok(postIds.has('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm'), `${id}: TA6501 が残る`);
    }
  }
});

test('P2', '記事の資料が 4 件以上で空きがある主張は、Q&A を末尾に足して記事の資料を外さない', () => {
  const text = '登録の取消しを求める旨の届出書を提出する。';
  const pages = ['p1', 'p2', 'p3', 'p4'].map((id, i) => entry(id, `90${i + 1}`, '登録の取消し 資料', text));
  const other = entry('p5', '9010', '免税事業者 資料', '免税事業者に戻す手続。');
  const options = qaOptions({ source_url: 'p1', source_supplements: [{ url: 'p2' }, { url: 'p3' }, { url: 'p4' }],
    catalog: catalog([...pages, other]) });
  const refs = E.searchEvidence(claims.c41, options);
  assert.ok(refs.length <= 7);
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.ok(refs.some(e => e.id === id), `${id} が残る`);
  assert.equal(refs[refs.length - 1].id, 'qa:invoice/jireishu', '空きの末尾に足す');
});

test('T6', 'source_bundle に Q&A の PDF の URL があっても、その PDF の問を記事の資料にも候補にもしない', () => {
  const question = E.qaEvidenceEntries().find(e => e.id === 'qa:invoice/jireishu');
  assert.ok(question, '事例集がある');
  const plain = E.searchEvidence(claims.c41, qaOptions());
  const bundled = E.searchEvidence(claims.c41, qaOptions({ source_bundle: `${fixture.meta.source_bundle};${question.url}` }));
  assert.deepEqual(snapshot(bundled), snapshot(plain));
  assert.equal(bundled[0].url, fixture.meta.source_url, '主出典が先頭のまま');
  // 同じ PDF を多数の問が共有する資料（軽減税率 03-01.pdf）でも、URL だけで記事の資料にしない。
  const pdf = 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/03-01.pdf';
  assert.ok(E.qaEvidenceEntries().filter(e => e.url === pdf).length > 1, '同じ URL を持つ問が複数ある');
  const keigenClaim = { id: 'k1', type: '要件', subject: '申告期限', claim: '消費税の確定申告の期限は3月31日',
    sentence: '消費税の確定申告の期限は3月31日です。' };
  const keigenOptions = { tax_domain: 'consumption_tax', qa_scope_text: '軽減税率 飲食料品' };
  const keigenPlain = E.searchEvidence(keigenClaim, keigenOptions);
  const keigenBundled = E.searchEvidence(keigenClaim, { ...keigenOptions, source_bundle: pdf });
  assert.deepEqual(snapshot(keigenBundled), snapshot(keigenPlain));
  assert.ok(keigenBundled.every(e => !e.id.startsWith('qa:')), 'その PDF の問は候補にならない');
  assert.ok(keigenBundled.every(e => e.url !== pdf), 'その PDF は記事の資料にならない');
});

test('T7', 'loadEvidenceText は Q&A の本文全体を返し、資料表に載る', () => {
  const refs = E.searchEvidence(claims.c41, qaOptions());
  const question = E.qaEvidenceEntries().find(e => e.id === 'qa:invoice/jireishu');
  const ref = refs.find(e => e.id === 'qa:invoice/jireishu');
  assert.equal(E.loadEvidenceText(ref), question.text);
  const pack = P.buildPages([claims.c41], { c41: [ref] });
  assert.equal(pack.pages.length, 1);
  assert.equal(pack.pages[0].id, 'qa:invoice/jireishu');
  assert.equal(pack.pages[0].source.length, question.text.length);
  assert.equal(pack.pages[0].ref.text, question.text);
});

test('T8', '分野の違う Q&A（tax_domain 違い・SCOPES に当たらない）は入らない', () => {
  assert.deepEqual(qaIds(E.searchEvidence(claims.c41, qaOptions({ tax_domain: 'inheritance_tax' }))), []);
  assert.deepEqual(qaIds(E.searchEvidence(claims.c41, qaOptions({ qa_scope_text: '所得税の記事 確定申告' }))), []);
  assert.deepEqual(qaIds(E.searchEvidence(INCOME_CLAIM, { tax_domain: 'income_tax', qa_scope_text: '給与所得 確定申告' })), []);
});

test('T9', '下限: qaScore が 60 以下、または 6 字の一致が 0 の Q&A は入らない', () => {
  // 主張の文の語だけで 60 を超える主張（c42）で、母数だけを 1 にすると 60 以下になる。
  const claim = claims.c42;
  assert.deepEqual(qaIds(E.searchEvidence(claim, qaOptions({ scorePopulation: 1 }))), []);
  assert.ok(qaIds(E.searchEvidence(claim, qaOptions())).includes('qa:invoice/jireishu'), '母数が目録の件数なら入る');
  // 点は高くても 6 字の一致が 0 なら入らない。
  const noPhrase = { type: '期限', subject: '登録の取消し', claim: '登録通知', sentence: '登録通知' };
  assert.ok(E.qaSlotScores(noPhrase, qaOptions()).some(r => r.qaScore > 60 && r.phraseMatches === 0),
    '「qaScore > 60 かつ 6 字の一致 0」の行が実際にある');
  assert.deepEqual(qaIds(E.searchEvidence(noPhrase, qaOptions())), []);
});

test('T10', '数字の型の主張でも、数字を含む 6 字の一致を Q&A 枠の点に数える（一般の枠の資格は変えない）', () => {
  const numeric = { type: '期限', subject: '期限', claim: '12月17日', sentence: '12月17日' };
  const row = E.qaSlotScores(numeric, qaOptions()).find(r => r.e.id === 'qa:invoice/jireishu');
  assert.ok(row, '事例集が採点の対象になる');
  assert.equal(row.phraseMatches, 1, '数字を含む 6 字「12月17日」の一致を数える');
  assert.ok(row.qaScore >= 20, '数字の 6 字の一致が点に入る');
  // 一般の枠の numericMatch は従来どおり（期限の主張では数字で資格を与えない）。
  const table = scored => scored.map(r => [r.e.id, r.numericMatch, r.statementScore, r.statementEligible, r.score]);
  assert.deepEqual(table(E.scoreEvidence(numeric, qaOptions()).scored),
    table(E.scoreEvidence(numeric, { ...qaOptions(), qa_scope_text: undefined }).scored),
    'qa_scope_text の有無で一般の枠の点の表が変わらない');
  assert.ok(E.scoreEvidence(numeric, qaOptions()).scored.every(r => r.numericMatch === false));
});

test('T11', 'index.json・問のファイル・本文が読めないときは例外になる', () => {
  const claim = { type: '期限', subject: '登録の取消し', claim: '翌年1月1日から戻す', sentence: '翌年1月1日から戻す' };
  // index.json が読めない・JSON として壊れている。
  for (const broken of [() => { throw new Error('読めません'); }, () => '[']) {
    assert.throws(() => withQaFiles(broken, new Map(), () => E.searchEvidence(claim, qaOptions())));
    assert.throws(() => withQaFiles(broken, new Map(), () => E.qaEvidenceEntries()));
  }
  const entries = [qaIndexEntry('q1', 'test/q1.json')];
  // 問のファイルが読めない。
  assert.throws(() => withQaFiles(entries,
    new Map([['test/q1.json', () => { throw new Error('読めません'); }]]),
    () => E.searchEvidence(claim, qaOptions())));
  assert.throws(() => withQaFiles(entries,
    new Map([['test/q1.json', () => { throw new Error('読めません'); }]]),
    () => E.qaEvidenceEntries()));
  // body が文字列でない。
  assert.throws(() => withQaFiles(entries, new Map([['test/q1.json', qaQuestion(123, '問1')]]),
    () => E.qaEvidenceEntries()));
  assert.ok(E.qaEvidenceEntries().length > 0, '戻せば読める');
});

test('T12', 'evidenceCatalog の件数と中身は変わらない', () => {
  const catalog = E.evidenceCatalog();
  const ids = catalog.entries.map(e => e.id);
  // 1. evidenceCatalog の行に kind qa・id qa: が無い（今のまま）。
  assert.ok(catalog.entries.every(e => e.kind !== 'qa' && !String(e.id).startsWith('qa:')));
  // 2. 件数は 1 以上で、kind が taxanswer・shitsugi・law・tsutatsu の行がそれぞれ 1 件以上ある。
  assert.ok(catalog.entries.length >= 1, 'evidenceCatalog の件数は 1 以上');
  for (const kind of ['taxanswer', 'shitsugi', 'law', 'tsutatsu']) {
    assert.ok(catalog.entries.some(e => e.kind === kind), `kind が ${kind} の行がある`);
  }
  // 3. data/nta-qa の下を読もうとすると例外になる状態でも、fact-evidence を読み直した
  //    別の写しの evidenceCatalog() が成功し、行の id の並びが今の写しと同じ。
  const qaDir = path.resolve(root, 'data', 'nta-qa');
  const insideQa = (file) => {
    try {
      const resolved = path.resolve(String(file));
      return resolved === qaDir || resolved.startsWith(qaDir + path.sep);
    } catch (_) { return false; }
  };
  const original = {
    readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
    existsSync: fs.existsSync, statSync: fs.statSync,
  };
  const deny = () => { throw new Error('data/nta-qa は読めません'); };
  const evidencePath = require.resolve('../fact-evidence');
  const cachedModule = require.cache[evidencePath];
  try {
    fs.readFileSync = function (file, ...args) {
      if (insideQa(file)) deny();
      return original.readFileSync.call(fs, file, ...args);
    };
    fs.readdirSync = function (dir, ...args) {
      if (insideQa(dir)) deny();
      return original.readdirSync.call(fs, dir, ...args);
    };
    fs.existsSync = function (file) {
      if (insideQa(file)) deny();
      return original.existsSync.call(fs, file);
    };
    fs.statSync = function (file, ...args) {
      if (insideQa(file)) deny();
      return original.statSync.call(fs, file, ...args);
    };
    delete require.cache[evidencePath];
    const fresh = require('../fact-evidence');
    const freshCatalog = fresh.evidenceCatalog();
    assert.deepEqual(freshCatalog.entries.map(e => e.id), ids,
      'data/nta-qa を読めない状態でも evidenceCatalog は同じ id の並びを返す');
  } finally {
    fs.readFileSync = original.readFileSync;
    fs.readdirSync = original.readdirSync;
    fs.existsSync = original.existsSync;
    fs.statSync = original.statSync;
    if (cachedModule) require.cache[evidencePath] = cachedModule;
  }
  // 4. qaEvidenceEntries() の件数が index.json の entries の件数（その場で読む）と同じで、1 件以上。
  const indexEntries = JSON.parse(fs.readFileSync(path.join(root, 'data/nta-qa/index.json'), 'utf8')).entries;
  const qa = E.qaEvidenceEntries();
  assert.equal(qa.length, indexEntries.length, 'qaEvidenceEntries の件数が index.json の entries と同じ');
  assert.ok(qa.length >= 1, 'qaEvidenceEntries の件数は 1 以上');
  // 5. qaEvidenceEntries() を呼ぶ前と後で、evidenceCatalog() の件数が同じ（今のまま）。
  const before = E.evidenceCatalog().entries.length;
  E.qaEvidenceEntries();
  assert.equal(E.evidenceCatalog().entries.length, before, 'Q&A を読んでも evidenceCatalog の件数は変わらない');
});

test('R3', 'tax_terms にだけある語（主張の文にも主題にも無い語）は Q&A 枠の点に入らない', () => {
  const claim = claims.c41;
  const options = qaOptions();
  const qaEntry = E.qaEvidenceEntries().find(e => e.id === 'qa:invoice/jireishu');
  const statementTokens = new Set(tokenizeForMatcher([claim.claim, claim.sentence].filter(Boolean).join(' ')));
  const subjectTokens = new Set(tokenizeForMatcher(claim.subject));
  // 事例集の本文にあり、主張の文にも主題にも無い語。tax_terms 経由で weights にだけ入る。
  const extra = [...qaEntry.tokens].find(t => !/^\d+$/.test(t) &&
    !statementTokens.has(t) && !subjectTokens.has(t) && tokenizeForMatcher(t).has(t));
  assert.ok(extra, '事例集にだけある語が見つかる');
  const scores = rows => Object.fromEntries(rows.map(r => [r.e.id, r.qaScore]));
  const plain = scores(E.qaSlotScores(claim, options));
  const added = scores(E.qaSlotScores(claim, { ...options, tax_terms: `${options.tax_terms} ${extra}` }));
  assert.deepEqual(added, plain, `tax_terms の語「${extra}」で qaScore が変わらない`);
});

test('R3', '主題の語の加点: 主張の文に無い主題の語で上がり、数字だけの語では上がらない', () => {
  const questionId = 'qa:invoice/jireishu';
  const scoreOf = subject => {
    const row = E.qaSlotScores({ ...claims.c41, subject }, qaOptions()).find(r => r.e.id === questionId);
    assert.ok(row, questionId);
    return row.qaScore;
  };
  // 事例集の本文にあり、c41 の主張の文には無い主題の語（登録・取消）で上がる。
  assert.ok(scoreOf('登録の取消し') > scoreOf(''), '主題の語で qaScore が上がる');
  // 事例集の本文にある数字だけの語「444」では上がらない（数字は 6 字の一致だけで使う）。
  assert.equal(scoreOf('444'), scoreOf(''), '数字だけの語では qaScore が変わらない');
});

test('R3', '題名一致の加点と、制度名が題名にあるときの第 2 キーの加点', () => {
  const claim = { type: '要件', subject: '登録の取消', claim: '登録の取消の期限は12月17日',
    sentence: '登録の取消の期限は12月17日です。' };
  const entries = [qaIndexEntry('a', 'test/a.json', { title: '登録の取消の期限' }),
    qaIndexEntry('b', 'test/b.json', { title: '取消の期限の登録' })];
  const body = '登録の取消について。免税事業者に戻す手続。';
  const files = new Map([['test/a.json', qaQuestion(body, '登録の取消の期限')],
    ['test/b.json', qaQuestion(body, '取消の期限の登録')]]);
  const rows = withQaFiles(entries, files, () => E.qaSlotScores(claim, qaOptions()));
  const a = rows.find(r => r.e.id === 'qa:invoice/a');
  const b = rows.find(r => r.e.id === 'qa:invoice/b');
  assert.ok(a && b, '2 問とも採点される');
  const { frequencies } = E.scoreEvidence(claim, qaOptions()).context;
  const titleBonus = 80 / (frequencies.titles.get('登録の取消の期限') || 1);
  assert.ok(Math.abs((a.qaScore - b.qaScore) - titleBonus) < 1e-9, 'qaScore の題名一致の加点');
  const mainBonus = 80 * '登録の取消'.length / '登録の取消の期限'.length;
  assert.ok(Math.abs((a.score - b.score) - mainBonus) < 1e-9, 'mainScore の制度名の加点');
});

test('R3', '別税目: 一般の枠は 0.15 倍、Q&A は statementTax が違えば除外する', () => {
  // 一般の枠: 記事と別税目の行（#693 c41 の所得税のページ）は 0.15 倍になる。
  const { scored } = E.scoreEvidence(claims.c41, qaOptions());
  assert.ok(scored.some(r => r.ownScore > 0 && Math.abs(r.score - r.ownScore * 0.15) < 1e-9),
    'OTHER_TAX_SCORE の 0.15 倍の行がある');
  // Q&A: 記事の税目（消費税）と違う税目の問は本文の枠と同じく除外する。
  const entries = [qaIndexEntry('income', 'test/income.json', { tax_category_code: 'shotoku' }),
    qaIndexEntry('shohi', 'test/shohi.json')];
  const body = '登録の取消し 免税事業者 12月17日が期限です。';
  const files = new Map([['test/income.json', qaQuestion(body, '登録の取消しの期限')],
    ['test/shohi.json', qaQuestion(body, '登録の取消しの期限')]]);
  const rows = withQaFiles(entries, files, () => E.qaSlotScores(claims.c41, qaOptions()));
  assert.ok(rows.some(r => r.e.id === 'qa:invoice/shohi'), '同じ税目は採点する');
  assert.ok(!rows.some(r => r.e.id === 'qa:invoice/income'), '違う税目は除外する');
});

test('R2', 'articleEvidenceOptions は書き手に Q&A を渡すときと同じ欄を qa_scope_text にする', () => {
  const options = F.articleEvidenceOptions(fixture.meta);
  for (const value of [fixture.meta.tax_terms, fixture.meta.pain_point, fixture.meta.primary_question,
    fixture.meta.reader_problem, fixture.meta.search_intent, fixture.meta.title]) assert.ok(options.qa_scope_text.includes(value));
  assert.equal(F.articleEvidenceOptions({}).qa_scope_text, '');
});

console.log('02-qa-slot集計:', JSON.stringify(groups));
process.exitCode = Object.values(groups).some(g => g.fail) ? 1 : 0;
