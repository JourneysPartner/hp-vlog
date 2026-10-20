'use strict';

// 03s の回帰試験。原文は読み取り専用、LLM と検索用カタログは偽物にする。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const matter = require('gray-matter');
const F = require('../fact-check');
const U = require('../fact-units');
const { tokenizeForMatcher, TAX_CATEGORY_CODES } = require('../nta-source-matcher');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { enabled: true, now: new Date('2026-10-20T00:00:00Z'), provider: 'anthropic', model: 'claude-opus-5-5', loadEvidenceText: e => e.text };
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '生前贈与加算', heading: '', type: '金額', ...extra });
const ta = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../data/nta-sources/taxanswer/sozoku/4161.json'), 'utf8'));
const source4161 = ta.body.slice(0, ta.body.indexOf('関連リンク'));
const units4161 = U.splitUnits(source4161, { material: true });
const note4161 = units4161.find(u => u.text.includes('総額100万円'));
const ref = (text, extra = {}) => ({ id: 'e1', kind: 'taxanswer', no: '4161', title: '試験用資料',
  url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4161.htm', text, law_version: '', ...extra });
async function judge(c, text, basis, extra = {}) {
  return (await F.judgeClaims([c], { [c.id]: [ref(text)] }, c.sentence,
    async () => [{ id: c.id, status: '裏付けあり', evidence_id: 1, basis }], { ...options, ...extra }))[0];
}
for (const [name, sentence] of [
  ['200万円', '相続開始前3年超7年以内の贈与分は総額200万円まで加算対象外です。'],
  ['300万円', '相続開始前3年超7年以内の贈与分は総額300万円までは加算されません。'],
  ['6年', '相続開始前3年超6年以内の贈与分は総額100万円まで加算対象外です。'],
]) test('S1', `本物のTA4161: 誤った${name}を補完しない`, async () => {
  const row = await judge(claim(sentence), source4161, String(note4161.s));
  assert.equal(row.status, '資料なし', `status=${row.status}, basis_added=${row.basis_added}`);
  assert.equal(row.basis_added, undefined);
});
test('S1', '本物のTA4161: 正しい100万円・7年も補完せず保持数字だけ残す', async () => {
  const row = await judge(claim('相続開始前3年超7年以内の贈与分は総額100万円まで加算対象外です。'), source4161, String(note4161.s));
  assert.equal(row.status, '資料なし');
  assert.deepEqual(row.supported_numbers, ['3年', '100万円']);
  assert.equal(Object.hasOwn(row, 'basis_added'), false);
  assert.equal(row.quote, ''); assert.equal(row.rejected_answer.basis, String(note4161.s));
});

const filler = Array(5).fill('中間の説明を確認しています'.repeat(15) + '。');
const note = '贈与加算の控除は100万円です。';
const period = claim('贈与加算の対象期間は7年、控除は100万円です。');
async function supplement(c, candidate, cited = note) {
  const text = [candidate, ...filler, cited].join('\n');
  const basis = String(U.splitUnits(text, { material: true }).at(-1).s);
  return judge(c, text, basis);
}
for (const [name, c, candidate] of [
  ['単位なし', claim('贈与加算の区分は7、控除は100万円です。'), '贈与加算の区分は7です。'],
  ['同じ値に単位のある形と無い形が混在', claim('贈与加算の区分は7で、対象期間は7年、控除は100万円です。'), '贈与加算の対象期間は7年です。'],
  ['年と円', period, '贈与加算の対象期間は7円です。'],
  ['第3項', claim('贈与加算の対象期間は3年、控除は100万円です。'), '贈与加算の対象期間は第3項によります。'],
  ['措法70の2', claim('贈与加算の対象期間は2年、控除は100万円です。'), '贈与加算の対象期間は措法70の2です。'],
  ['通達番号に年を付けた形', period, '贈与加算の対象期間は相基通19-7年です。'],
  ['括弧の列挙', period, '贈与加算の対象期間は（7）に書いています。'],
  ['数字の前後の語が異なる', period, '生前贈与加算' + 'あ'.repeat(30) + '契約は7年です。'],
  ['汎用の語だけが重なる', claim('贈与加算の売上金額は300万円以内、控除は100万円です。'), '贈与加算' + 'あ'.repeat(30) + '契約金額は300万円以内です。'],
  ['割合の単位が異なる', claim('贈与加算の対象割合は20%、控除は100万円です。'), '贈与加算の対象割合は2割です。'],
  ['列挙の先頭の数字に直後の単位が無い', claim('贈与加算の対象割合は7・5・3割、控除は100万円です。'), '贈与加算の対象割合は7割、5割、3割です。'],
]) test('S1', `${name}では補完しない`, async () => {
  const row = await supplement(c, candidate);
  assert.equal(row.status, '資料なし'); assert.equal(row.basis_added, undefined);
  assert.deepEqual(row.supported_numbers, ['100万円']);
});
for (const candidate of ['贈与加算の対象期間は七年です。', '贈与加算の対象期間は７年です。']) test('S1', '同じ単位の漢数字・全角数字も別の文から補完しない', async () => {
  const row = await supplement(period, candidate);
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['100万円']);
  assert.equal(Object.hasOwn(row, 'basis_added'), false);
});
for (const [sentence, candidate] of [
  ['贈与加算の対象期間は7か月、控除は100万円です。', '贈与加算の対象期間は七ヶ月です。'],
  ['贈与加算の対象割合は20%、控除は100万円です。', '贈与加算の対象割合は20パーセントです。'],
  ['贈与加算の開始日は令和8年4月1日、控除は100万円です。', '贈与加算の開始日は令和8年4月1日です。'],
]) test('S1', '同じ月数・割合・日付でも別の文から補完しない', async () => {
  const row = await supplement(claim(sentence), candidate);
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['100万円']);
  assert.equal(Object.hasOwn(row, 'basis_added'), false);
});
for (const marker of ['計算例', '具体例', '設例', '事例', '例えば', '〔例〕', '（例）']) test('S1', `${marker}の次の文も同じ節なら探さない`, async () => {
  const row = await supplement(period, `${marker}を説明します。\n贈与加算の対象期間は7年です。`);
  assert.equal(row.status, '資料なし');
});
test('S1', '300字で切った断片の先頭の番号を節の見出しにしない', async () => {
  const row = await supplement(period, '具体例\n' + 'あ'.repeat(300) + '1 贈与加算の対象期間は7年です。');
  assert.equal(row.status, '資料なし'); assert.equal(row.basis_added, undefined);
});
for (const boundary of ['\n\n', '\n【対象期間】\n', '\n（参考）\n', '\n《対象期間》\n', '\n1 対象期間\n', '\n(1) 対象期間\n']) {
  test('S1', '例の節の後に定義があっても補完しない', async () => {
    const row = await supplement(period, '具体例を説明します。' + boundary + '贈与加算の対象期間は7年です。');
    assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['100万円']);
    assert.equal(Object.hasOwn(row, 'basis_added'), false); assert.equal(row.quote, '');
  });
}
for (const candidate of ['贈与加算の対象期間は7年です 根拠法令等 相基通19-7',
  '根拠法令等\n【対象期間】\n贈与加算の対象期間は7年です。']) test('S1', '根拠法令等を含む文とそれ以降は探さない', async () => {
  assert.equal((await supplement(period, candidate)).status, '資料なし');
});

const wedding = claim('結婚・子育て資金は1,000万円（うち結婚費用300万円）まで非課税です。', { subject: '結婚子育て資金' });
const weddingSource = '結婚・子育て資金は1,000万円まで非課税です。';
const replacement = '結婚費用は1,000万円まで非課税です（詳しくは国税庁の案内で確認）。';
async function repaired({ mode = 'supported', original = wedding.sentence, source = weddingSource,
  revised = replacement, summary } = {}) {
  let extracts = 0;
  return F.checkFacts(original, { ...options, searchEvidence: () => [ref(source)], callLLM: async req => {
    if (req.task === 'extract') {
      extracts++;
      if (extracts > 1 && mode === 'missing') return [];
      const lines = [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)];
      return lines.map(m => ({ s: +m[1], type: extracts > 1 && mode === 'vague' ? '要件' : '金額', subject: wedding.subject,
        claim: extracts > 1 ? mode === 'vague' ? '結婚費用には上限があります。' : summary || m[2] : m[2] }));
    }
    if (req.task === 'repair') {
      assert.ok(JSON.parse(req.user).corrections[0].keep_numbers.includes('1,000万円'));
      return [{ id: 'c1', replacement: revised }];
    }
    return JSON.parse(req.user).claims.map(c => ({ id: c.id,
      status: extracts > 1 && mode === 'unsupported' ? '資料なし' : '裏付けあり', evidence_id: 1, basis: '1' }));
  } });
}
for (const mode of ['missing', 'vague', 'unsupported', 'supported']) test('S2', `残した数字の再照合: ${mode}`, async () => {
  const result = await repaired({ mode });
  const resolved = mode === 'supported';
  assert.equal(result.record.corrections[0].resolved, resolved);
  assert.equal(result.record.status, resolved ? 'ok' : 'revise');
  if (mode === 'missing') assert.equal(result.record.rechecked.length, 0);
  if (mode === 'vague') assert.equal(result.record.rechecked[0].claim, '結婚費用には上限があります。');
  if (!resolved) {
    assert.ok(result.record.remaining.some(c => c.id === 'c1'));
    const raw = `---\nslug: fact-03s\nrecommendation: publish\n---\n${result.body}`;
    const meta = matter(F.applyFactResult(raw, result)).data;
    assert.equal(meta.recommendation, 'revise'); assert.equal(meta.fact_check_blocking, true);
  }
});
test('S2', 'keep_numbersの全数字が再照合されたときだけ解決する', async () => {
  const original = '結婚・子育て資金は18歳から1,000万円（うち結婚費用300万円）まで非課税です。';
  const source = '結婚・子育て資金は18歳から1,000万円まで非課税です。';
  const revised = '結婚・子育て資金は18歳から1,000万円まで非課税です（結婚費用の上限は国税庁で確認）。';
  for (const summary of [undefined, '結婚・子育て資金は1,000万円まで非課税です。']) {
    const result = await repaired({ original, source, revised, summary });
    assert.deepEqual(result.record.claims[0].supported_numbers, ['18歳', '1,000万円']);
    assert.equal(result.record.corrections[0].resolved, summary === undefined);
    assert.equal(result.record.status, summary === undefined ? 'ok' : 'revise');
  }
});
test('S2', 'keep_numbersが無い一般化は従来どおり', async () => {
  let extracts = 0;
  const original = '結婚・子育て資金の上限は300万円です。';
  const result = await F.checkFacts(original, { ...options, searchEvidence: () => [ref('この制度の案内を確認してください。')], callLLM: async req => {
    if (req.task === 'extract') return ++extracts === 1 ? [{ s: 1, type: '金額', subject: wedding.subject, claim: original }] : [];
    if (req.task === 'repair') {
      assert.equal(Object.hasOwn(JSON.parse(req.user).corrections[0], 'keep_numbers'), false);
      return [{ id: 'c1', replacement: '結婚・子育て資金の上限は国税庁の案内で確認してください。' }];
    }
    return [{ id: 'c1', status: '資料なし' }];
  } });
  assert.equal(result.record.corrections[0].resolved, true); assert.equal(result.record.status, 'ok');
});

test('S3', '本文の数字を読めずsupported_numbersだけあるときは修正を採らない', async () => {
  const c = { ...wedding, sentence: wedding.sentence.replace('300万円', '300万円、割合0分の1'),
    status: '資料なし', keep: [], supported_numbers: ['1,000万円'] };
  assert.ok(F.normalizedNumbers(c.sentence).includes(null));
  const result = await F.repairBody(c.sentence, [c], async () => [{ id: 'c1', replacement: '結婚・子育て資金は1,000万円で結婚費用300万円まで非課税です。' }]);
  assert.equal(result.body, c.sentence); assert.equal(result.rejected.get('c1'), '数字を読めないため確かめられません');
});
test('S3', '要約に数字が無いときも本文由来の300万円を残せない', async () => {
  const c = { ...wedding, claim: '結婚・子育て資金には上限があります。', status: '資料なし', supported_numbers: ['1,000万円'] };
  const result = await F.repairBody(c.sentence, [c], async () => [{ id: 'c1', replacement: '結婚・子育て資金は1,000万円で結婚費用300万円まで非課税です。' }]);
  assert.equal(result.body, c.sentence); assert.equal(result.rejected.get('c1'), '資料の無い数字が残っています');
});
test('S3', '要約と本文の数字が一致しないときはR3・R4をしない', async () => {
  const c = { ...period, sentence: period.sentence.replace('7年', '8年') };
  const row = await supplement(c, '贈与加算の対象期間は7年です。');
  assert.equal(row.status, '資料なし'); assert.equal(row.basis_added, undefined); assert.equal(row.supported_numbers, undefined);
});
test('S3', '根拠の原文に読めない数字があればR3・R4をしない', async () => {
  const row = await supplement(period, '割合0分の1です。\n贈与加算の対象期間は7年です。');
  assert.equal(row.status, '資料なし'); assert.equal(row.basis_added, undefined); assert.equal(row.supported_numbers, undefined);
});
test('S3', 'keep_numbersが無い修正のリクエスト本文は03rとバイト一致', async () => {
  const c = claim('控除は120万円です。', { subject: '制度', status: '資料なし' });
  await F.repairBody(c.sentence, [c], async req => {
    assert.equal(createHash('sha256').update(JSON.stringify(req)).digest('hex'), '27e026363ec74bd8c786cf8b11ffe0ec0ba06ac5c6b66877edaa2fdee37e37ea');
    return [];
  });
});

function catalog(entries) {
  entries = entries.map(e => ({ ...e, titleTokens: tokenizeForMatcher(e.title), tokens: tokenizeForMatcher(`${e.title} ${e.text}`) }));
  const df = new Map();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) || 0) + 1);
  return { entries, df };
}
test('S4', 'Jaccardが0.9以上でも新しい検索語がある資料は残す', () => {
  const c = claim('資金非課税の結婚について確認します。', { subject: '資金非課税', type: '判定' });
  const a = { id: 'a', kind: 'law', title: c.subject, text: '資金非課税', url: 'https://example.jp/a' };
  const b = { ...a, id: 'b', title: '関連する案内', text: '資金非課税 結婚', url: 'https://example.jp/b' };
  const cat = catalog([a, b, { ...a, id: 'c', url: 'https://example.jp/c' }]);
  const base = new Set([...tokenizeForMatcher(a.text), ...Array.from({ length: 100 }, (_, i) => `共通語${i}`)]);
  cat.entries[0].tokens = base; cat.entries[2].tokens = base;
  cat.entries[1].tokens = new Set([...base, '結婚']);
  const ids = F.searchEvidence(c, { catalog: cat }).map(e => e.id);
  assert.deepEqual(ids, ['a', 'b']);
});
test('S4', '新しい検索語を持たない重複は引き続き飛ばす', () => {
  const c = claim('資金非課税について確認します。', { subject: '資金非課税', type: '判定' });
  const entries = ['a', 'b', 'c'].map(id => ({ id, kind: 'law', title: c.subject, text: '資金非課税', url: `https://example.jp/${id}` }));
  assert.deepEqual(F.searchEvidence(c, { catalog: catalog(entries) }).map(e => e.id), ['a']);
});

function taxRef(code, extra = {}) {
  return ref('対象確認についての取扱いです。', { id: code, no: '9999', title: '対象確認',
    url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/${code}/9999.htm`, ...extra });
}
test('S5', '相続の記事でも空き家・取得費加算・譲渡所得の資料を下げない', () => {
  for (const word of ['空き家の3,000万円', '取得費加算', '譲渡所得']) {
    const c = claim(`${word}の対象確認をします。`, { subject: '対象確認', type: '判定' }), cat = catalog([taxRef('joto')]);
    assert.deepEqual(F.searchEvidence(c, { catalog: cat, tax_domain: 'inheritance_tax' }), F.searchEvidence(c, { catalog: cat }));
  }
});
test('S5', '消費税の追加語で別税目の減点を免除する', () => {
  for (const word of ['簡易課税', '納税義務', '軽減税率', '2割特例', '3割特例', '基準期間']) {
    const c = claim(`${word}の対象確認をします。`, { subject: '対象確認', type: '判定' }), cat = catalog([taxRef('shohi')]);
    assert.deepEqual(F.searchEvidence(c, { catalog: cat, tax_domain: 'inheritance_tax' }), F.searchEvidence(c, { catalog: cat }));
  }
});
test('S5', '海外取引では所得税・消費税のどちらにもR1を掛けない', () => {
  const c = claim('対象確認をします。', { subject: '対象確認', type: '判定' });
  for (const code of ['shotoku', 'gensen', 'joto', 'shohi', 'hojin', 'sozoku']) {
    const cat = catalog([taxRef(code)]);
    assert.deepEqual(F.searchEvidence(c, { catalog: cat, tax_domain: 'overseas_transactions' }), F.searchEvidence(c, { catalog: cat }));
  }
});
test('S5', '各分類のコードは税目がそろい、海外取引だけはR1の対象外', () => {
  const expected = { income_tax: 'income', withholding: 'income', bookkeeping_expenses: 'income',
    consumption_tax: 'consumption', invoice_system: 'consumption', inheritance_tax: 'inheritance', overseas_transactions: null };
  const categories = { shotoku: 'income', gensen: 'income', joto: 'income', shohi: 'consumption',
    sozoku: 'inheritance', zoyo: 'inheritance', hyoka: 'inheritance' };
  assert.deepEqual(Object.keys(TAX_CATEGORY_CODES).sort(), Object.keys(expected).sort());
  const c = claim('対象確認をします。', { subject: '対象確認', type: '判定' });
  for (const [domain, codes] of Object.entries(TAX_CATEGORY_CODES)) {
    assert.equal(new Set(codes.map(code => categories[code])).size, 1, domain);
    if (expected[domain]) assert.ok(codes.every(code => categories[code] === expected[domain]), domain);
    for (const code of codes) {
      const cat = catalog([taxRef(code)]);
      assert.deepEqual(F.searchEvidence(c, { catalog: cat, tax_domain: domain }), F.searchEvidence(c, { catalog: cat }));
    }
  }
});
test('S5', '記事資料が4件以上でも先頭3件を減点前の順に保つ', () => {
  const c = claim('棚卸資産の評価を確認します。', { subject: '棚卸資産の評価', type: '判定' });
  const entries = [taxRef('other', { id: 'primary', title: '主出典', text: '資料の案内です。', url: 'https://example.jp/primary' }),
    taxRef('hojin', { id: 'corporate', title: c.subject, text: c.subject }),
    taxRef('sozoku', { id: 'inheritance', title: c.subject, text: c.subject }),
    taxRef('shotoku', { id: 'income', title: '棚卸資産', text: c.subject }),
    taxRef('other', { id: 'common', title: '評価', text: c.subject })];
  const cat = catalog(entries), opts = { catalog: cat, source_url: entries[0].url, source_bundle: entries.map(e => e.id).join(';') };
  const before = F.searchEvidence(c, opts), after = F.searchEvidence(c, { ...opts, tax_domain: 'bookkeeping_expenses' });
  assert.deepEqual(before.slice(0, 3).map(e => e.id), ['primary', 'corporate', 'inheritance']);
  assert.deepEqual(after.slice(0, 3).map(e => e.id), before.slice(0, 3).map(e => e.id));
  assert.ok(after.find(e => e.id === 'corporate').score < before.find(e => e.id === 'corporate').score);
});
test('S6', '第三者の三はsupported_numbersに入れない', async () => {
  const c = claim('第三者に1,000万円（うち結婚費用300万円）まで非課税です。', { subject: '結婚子育て資金' });
  const row = await judge(c, '第三者に1,000万円まで非課税です。', '1');
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['1,000万円']);
});

(async () => {
  let passed = 0, failed = 0;
  const totals = {};
  for (const { group, name, run } of tests) {
    totals[group] ||= { pass: 0, fail: 0 };
    try { await run(); passed++; totals[group].pass++; console.log(`PASS ${group}: ${name}`); }
    catch (error) { failed++; totals[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
  }
  console.log(JSON.stringify({ passed, failed, groups: totals }));
  if (failed) process.exitCode = 1;
})();
