'use strict';

// 03u の回帰試験。資料・LLM は偽物にし、記録は一時ディレクトリだけへ書く。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../fact-check');
const U = require('../fact-units');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { enabled: true, now: new Date('2026-10-20T00:00:00Z'), provider: 'anthropic',
  model: 'claude-opus-5-5', batch: false, loadEvidenceText: e => e.text, repair: false };
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '贈与税', heading: '', type: '金額', ...extra });
const ref = (text, id) => ({ id, kind: 'taxanswer', no: '4402', title: '試験資料',
  url: 'https://example.jp/' + id, text, law_version: '' });
const raw = body => `---\nslug: fact-03u\nrecommendation: publish\n---\n${body}`;
const requirement = '受贈者は直系卑属である推定相続人または孫です。';
const extract = (body, summary, type = '金額', s = 1) => F.extractClaims(body,
  async () => [{ s, type, subject: '贈与税', claim: summary }], options);

for (const [label, type] of [
  ['対象・条件', '要件'], ['対象', '要件'], ['条件', '要件'], ['対象者', '要件'], ['要件・条件', '要件'],
  [' 保存期間 ', '期限'], ['届出', '手続'], ['申請', '手続'], ['選択', '手続'], ['届出・申請・選択', '手続'],
  ['条文', '番号'], ['通達', '番号'], ['タックスアンサー', '番号'], ['条文・通達・タックスアンサー', '番号'],
  ['税率', '割合'], ['　対象･条件　', '要件'], ['ﾀｯｸｽｱﾝｻｰ', '番号'],
]) test('U1', `一覧内の「${label}」を${type}として採り、元の名前を残す`, async () => {
  const result = await extract(requirement, requirement, label);
  assert.equal(result.discarded, 0); assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].type, type); assert.equal(result.claims[0].type_label, label);
  assert.equal(result.claims[0].sentence, requirement);
});

for (const label of ['その他', '要件（対象・条件）', '対 象', '保存年数', '申告', '税額', 'toString', '__proto__']) {
  test('U1', `一覧外の「${label}」は形式不正で捨てる`, async () => {
    const result = await extract(requirement, requirement, label);
    assert.equal(result.claims.length, 0); assert.equal(result.discarded, 1);
    assert.equal(result.discardedClaims[0].status, '主張の形式が不正');
  });
}

test('U1', '正規の8語には読み替え記録を加えず、指示文で名前と説明を分ける', async () => {
  for (const type of ['要件', '金額', '割合', '期限', '適用年', '手続', '番号', '判定']) {
    const result = await extract(requirement, requirement, type);
    assert.equal(result.claims[0].type, type); assert.equal(Object.hasOwn(result.claims[0], 'type_label'), false);
  }
  await F.extractClaims(requirement, async request => {
    assert.ok(request.system.includes('type は次の8語のどれか1語をそのまま書いてください: 要件・金額・割合・期限・適用年・手続・番号・判定。'));
    assert.ok(request.system.includes('要件は対象・条件、期限は保存期間を含む、手続は届出・申請・選択、番号は条文・通達・タックスアンサーのことです。'));
    assert.ok(request.system.includes('漏れなく')); assert.ok(request.system.includes('claim は60文字以内'));
    assert.ok(request.system.includes('形は [{s,type,subject,claim}]')); assert.equal(request.maxTokens, 8000);
    return [];
  }, options);
});

test('U1', '判定と資料なしの行・圧縮記録にも元の名前を残す', async () => {
  const c = (await extract(requirement, requirement, '対象・条件')).claims[0];
  assert.ok(c);
  const e = ref(requirement, 'requirements');
  const rows = await F.judgeClaims([c], { c1: [e] }, requirement,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options);
  assert.equal(rows[0].status, '裏付けあり'); assert.equal(rows[0].type_label, '対象・条件');
  assert.equal(F.compactRecord({ claims: rows }).claims[0].type_label, '対象・条件');
  const missing = await F.judgeClaims([c], {}, requirement, () => assert.fail('資料なしでは呼ばない'), options);
  assert.equal(missing[0].type_label, '対象・条件');
});

test('U1', '受贈者の誤った要件が判定へ届き、食い違いなら承認を差し止める', async () => {
  const sentence = '受贈者は18歳以上の直系卑属であれば対象です。';
  const result = await F.checkFacts(sentence, { ...options, searchEvidence: () => [ref(requirement, 'requirements')],
    callLLM: async request => request.task === 'extract'
      ? [{ s: 1, type: '対象・条件', subject: '相続時精算課税', claim: sentence }]
      : [{ id: 'c1', status: '食い違い', evidence_id: 1, basis: '1', correct: requirement }] });
  assert.equal(result.record.discarded, 0); assert.equal(result.record.claims[0].status, '食い違い');
  assert.equal(result.record.claims[0].type_label, '対象・条件'); assert.equal(result.record.status, 'revise');
  assert.ok(F.applyFactResult(raw(sentence), result).includes('fact_check_blocking: true'));
});

const dated = '令和6年1月1日以降の贈与からは、年間110万円の基礎控除が新設されたため、贈与税の負担が軽くなります。';
const summary = '令和6年以降の贈与から年110万円の基礎控除が新設';
for (const [name, body, text, s, expected, type = '金額'] of [
  ['同じ元号・年', dated, summary, 1, 1],
  ['前後2文から同じ年を探す', '贈与の制度を確認します。\n' + dated, summary, 1, 2],
  ['見出しから同じ年を探す', '## 贈与の制度\n' + dated, summary, 1, 2],
  ['要件の近傍探索にも同じ読み方を使う', '## 贈与の制度\n' + dated, summary, 1, 2, '要件'],
  ['西暦の同じ年', dated.replace('令和6年', '2026年'), summary.replace('令和6年', '2026年'), 1, 1],
  ['違う年', dated, summary.replace('令和6年', '令和7年'), 1, null],
  ['違う元号', dated, summary.replace('令和6年', '平成6年'), 1, null],
  ['和暦と西暦は換算しない', dated, summary.replace('令和6年', '2024年'), 1, null],
  ['月まである要約は年だけの例外にしない', dated, summary.replace('令和6年', '令和6年1月'), 1, null],
  ['別の文の年は混ぜない', '令和6年1月1日から制度が変わります。\n年間110万円の基礎控除が新設されます。', summary, 2, null],
  ['基準日の行の年月日は数えない', '令和6年1月1日現在法令等\n年間110万円の基礎控除が新設されます。', summary, 2, null],
  ['同じ文の基準日の年月日も数えない', '令和6年1月1日現在、年間110万円の基礎控除があります。', summary, 1, null],
  ['近傍の外の年は使わない', dated + '\n案内を確認します。\n詳細を確認します。\n年間110万円の基礎控除があります。', summary, 4, null],
  ['同じ年でも金額が違えば捨てる', dated, summary.replace('110万円', '120万円'), 1, null],
]) test('U2', name, async () => {
  const result = await extract(body, text, type, s);
  if (expected === null) {
    assert.equal(result.claims.length, 0); assert.equal(result.discardedClaims[0].status, '本文に見つからない');
  } else {
    assert.equal(result.discarded, 0); assert.equal(result.claims[0].s, expected);
    assert.equal(result.claims[0].sentence, U.splitUnits(body)[expected - 1].text);
  }
});

const a = claim('年110万円以内の贈与なら贈与税の申告は通常不要です。');
const b = claim('贈与税の基礎控除は年間110万円です。', { id: 'c2' });
const body = a.sentence + '\n' + b.sentence;
const own = ref('贈与税の手続については所轄税務署の案内を確認してください。', 'own');
const shared = ref(a.sentence + '\n' + b.sentence, 'shared');
const fakeJudge = (answer = {}) => async request => {
  const payload = JSON.parse(request.user);
  assert.deepEqual(payload.claims.map(c => c.evidence_ids), [[1], [2]]);
  assert.equal(request.maxTokens, 16000);
  return [{ id: 'c1', status: '裏付けあり', evidence_id: 2, basis: '1', ...answer },
    { id: 'c2', status: '資料なし' }];
};
const judgeOutside = (source = shared, answer = {}, extra = {}) => {
  const { claimType = a.type, candidate = false, ...opts } = extra;
  return F.judgeClaims([{ ...a, type: claimType }, b], { c1: [candidate ? { ...source, id: own.id } : own], c2: [source] },
    body, fakeJudge({ ...answer, ...(candidate ? { evidence_id: 1 } : {}) }), { ...options, ...opts });
};

test('U3', '別主張の候補でも同じ資料表なら採り、候補末尾と記録に残す', async () => {
  const rows = await judgeOutside(shared, {}, { claimType: '判定' }), row = rows[0];
  assert.equal(row.status, '裏付けあり'); assert.equal(row.quote, a.sentence); assert.equal(row.evidence_id, shared.id);
  assert.deepEqual(row.evidence.map(e => e.id), [own.id, shared.id]); assert.equal(row.evidence_outside_candidates, true);
  assert.deepEqual(row.evidence.at(-1), rows[1].evidence[0]);
  const compact = F.compactRecord({ claims: rows });
  assert.deepEqual(compact.claims[0].evidence_ids, [own.id, shared.id]);
  assert.equal(compact.claims[0].evidence_outside_candidates, true);
  assert.deepEqual(F.evidenceRefs(compact, compact.claims[0]), row.evidence);
});

for (const [name, source, answer, reason, extra = {}] of [
  ['資料表にない番号', shared, { evidence_id: 3 }, '資料の番号がこの主張の候補でない'],
  ['そのページにない文番号と架空の引用', shared, { basis: '99', quote: a.sentence }, '根拠の文の番号が読めない・範囲外', { claimType: '判定' }],
  ['別ページだけにある引用は採らない', shared, { evidence_id: 1, basis: '1', quote: a.sentence }, '引用が短い・数字が引用の近くに無い'],
  // 03vでは数字の主張の候補外資料を拒否するため、数字の歯止めは候補内の同じ原文で確かめる。
  ['300字より離れた数字は使わない', ref('贈与税の申告については制度の条件を確認してください。\n' + '補足説明が続きます。'.repeat(40) + '\n' + a.sentence, 'shared'), {}, '引用が短い・数字が引用の近くに無い', { candidate: true }],
  ['短すぎる引用', ref('贈与税\n' + a.sentence, 'shared'), {}, '引用が短い・数字が引用の近くに無い', { claimType: '判定' }],
  ['数字の主張の2範囲で3文の範囲を認めない', ref('年110万円の基礎控除があります。\n補足は150万円です。\n別の控除は200万円です。\n手続を確認します。\n適用条件も確認します。', 'shared'),
    { basis: '1-3,5' }, '根拠の文の番号が読めない・範囲外', { candidate: true }],
]) test('U3', name, async () => {
  const row = (await judgeOutside(source, answer, extra))[0];
  assert.equal(row.status, '資料なし'); assert.equal(row.reject_reason, reason); assert.equal(row.quote, '');
  assert.equal(row.evidence_id, ''); assert.deepEqual(row.evidence.map(e => e.id), [own.id]);
  assert.equal(Object.hasOwn(row, 'evidence_outside_candidates'), false);
});

test('U3', '候補外ページでも引用が保存資料に実在しなければ落とす', async () => {
  const pageCache = {};
  const rows = await F.judgeClaims([{ ...a, type: '判定' }, b], { c1: [own], c2: [shared] }, body, async request => {
    // 番号から復元する引用と保存資料が食い違う場合でも、実在確認を省かない。
    const page = pageCache.groups[0].pack.pages[1];
    page.ref = { ...page.ref, text: own.text, text_ranges: [[0, own.text.length]] };
    return fakeJudge()(request);
  }, { ...options, pageCache });
  assert.equal(rows[0].status, '資料なし'); assert.equal(rows[0].reject_reason, '引用が資料に無い');
  assert.deepEqual(rows[0].evidence.map(e => e.id), [own.id]);
  assert.equal(Object.hasOwn(rows[0], 'evidence_outside_candidates'), false);
});

test('U3', '候補内ページの数字の主張の連続3文は従来どおり検証を通る2文以内へ絞る', async () => {
  const source = ref(a.sentence + '\n手続の注意点を確認します。\n適用条件も確認します。', 'shared');
  const row = (await judgeOutside(source, { basis: '1-3' }, { candidate: true }))[0];
  assert.equal(row.status, '裏付けあり'); assert.equal(row.quote, a.sentence);
  assert.equal(Object.hasOwn(row, 'evidence_outside_candidates'), false);
});

test('U3', '判定の指示文は候補を優先し、同じ資料表の別資料を認める', async () => {
  await F.judgeClaims([a], { c1: [shared] }, a.sentence, async request => {
    assert.ok(request.system.includes('各主張の evidence_ids の資料を優先して根拠にしてください。要件・判定・手続の主張で、evidence_ids の資料に根拠が無く、この資料表の別の資料に根拠があるときは、その資料の番号を evidence_id に書いてかまいません。金額・割合・期限・適用年・番号の主張は evidence_ids の資料だけを根拠にしてください'));
    assert.ok(!request.system.includes('各主張の evidence_ids の資料だけを根拠にしてください'));
    return [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }];
  }, options);
});

test('U3', '候補内の資料には追加・外部候補の印を付けない', async () => {
  const rows = await F.judgeClaims([a], { c1: [shared] }, a.sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options);
  assert.equal(rows[0].status, '裏付けあり'); assert.deepEqual(rows[0].evidence.map(e => e.id), [shared.id]);
  assert.equal(Object.hasOwn(rows[0], 'evidence_outside_candidates'), false);
});

test('U3', '候補外ページの答えも多数が確認を通らなければ照合不能で止める', async () => {
  const claims = [1, 2, 3].map(i => ({ ...a, id: 'c' + i }));
  claims.push({ ...b, id: 'c4' });
  const wrong = ref('年間220万円の別制度の手続について確認してください。', 'wrong');
  const evidence = { c1: [own], c2: [own], c3: [own], c4: [wrong] };
  await assert.rejects(() => F.judgeClaims(claims, evidence, body, async () => claims.map(c =>
    c.id === 'c4' ? { id: c.id, status: '資料なし' } : { id: c.id, status: '裏付けあり', evidence_id: 2, basis: '1' }), options),
  /判定の答えの多くが確認を通りません/);
});

function articleOptions(dir) {
  return { ...options, recordDir: dir, searchEvidence: c => [c.sentence === a.sentence ? own : shared], callLLM: async request => {
    if (request.task === 'extract') return [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)]
      .filter(m => [a.sentence, b.sentence].includes(m[2]))
      .map(m => ({ s: +m[1], type: m[2] === a.sentence ? '判定' : '金額', subject: '贈与税', claim: m[2] }));
    assert.equal(request.task, 'judge');
    return JSON.parse(request.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 2, basis: c.claim === a.claim ? '1' : '2' }));
  } };
}

test('U3', 'compactRecordで保存した候補外資料をvalidRefsが認め、差分照合で使い回す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03u-'));
  try {
    const opts = articleOptions(dir), before = raw(body), after = raw(body + '\n案内を追記します。');
    const first = await F.checkArticle(before, opts);
    assert.equal(first.record.status, 'ok');
    const saved = JSON.parse(fs.readFileSync(F.recordPath('fact-03u', dir), 'utf8'));
    assert.deepEqual(saved.claims[0].evidence_ids, [own.id, shared.id]);
    assert.equal(saved.claims[0].evidence_outside_candidates, true);
    const next = await F.checkArticle(after, { ...opts, previousRaw: before, persist: false,
      callLLM: async request => { assert.equal(request.task, 'extract'); return []; } });
    assert.equal(next.record.incremental.reused, 2); assert.equal(next.record.incremental.rejudged, 0);
    assert.equal(next.record.claims[0].evidence_outside_candidates, true);
    assert.equal(next.record.claims[0].evidence_id, shared.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('版', 'LOGIC_VERSIONはplan2で、03rの記録は差分照合で使い回さない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03u-version-'));
  try {
    const opts = articleOptions(dir), before = raw(body), after = raw(body + '\n案内を追記します。');
    const first = await F.checkArticle(before, opts);
    assert.equal(first.record.logic_version, 'plan2-s1');
    const file = F.recordPath('fact-03u', dir), prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    prior.logic_version = '03r'; fs.writeFileSync(file, JSON.stringify(prior) + '\n', 'utf8');
    const next = await F.checkArticle(after, { ...opts, previousRaw: before, persist: false });
    assert.equal(next.record.logic_version, 'plan2-s1'); assert.equal(next.record.incremental, undefined);
    assert.deepEqual(next.record.calls.map(c => c.task), ['extract', 'judge']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
