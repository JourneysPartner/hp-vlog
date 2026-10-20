'use strict';

// 03x の回帰試験。カタログは読み取り専用にし、LLM は偽物にする。
const assert = require('assert/strict');
const F = require('../fact-check');
const E = require('../fact-evidence');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { now: new Date('2026-10-20T00:00:00Z'), loadEvidenceText: e => e.text };
const article = { tax_domain: 'inheritance_tax', source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm' };
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '配偶者控除', heading: '', type: '金額', ...extra });
const spouse = claim('| 配偶者への居住用不動産の贈与（配偶者控除） | 最大2,000万円 | 居住用不動産または取得資金 | 婚姻期間20年以上・同一配偶者への適用は一生に一度 |',
  { subject: '配偶者控除（居住用不動産の贈与）', claim: '配偶者控除の非課税上限は最大2,000万円' });
const ta = no => `https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/${no}.htm`;
const refs = c => E.searchEvidence(c, article);
const entry = (id, title = '試験資料', text = '試験資料の本文です。') => ({ id, url: id, kind: 'taxanswer', title, text,
  tokens: new Set(), titleTokens: new Set() });
const catalog = entries => ({ entries, df: new Map() });

for (const c of [spouse, { ...spouse, claim: '最大2,000万円まで贈与税が非課税',
  sentence: '婚姻期間が20年以上の配偶者に対し、居住用不動産またはその取得資金を贈与する場合、最大2,000万円まで贈与税が非課税となる制度です。' }]) {
  test('X1', `#644 の本物のカタログで TA4452 を制度名の枠に残す: ${c.claim}`, () => {
    const result = refs(c);
    assert.equal(result[0].url, article.source_url); assert.equal(result[1].url, ta('4452'));
    assert.ok(result.length <= 7);
  });
}

test('X1', '暦年課税の基礎控除（年110万円）は制度名の1枠に TA4408 を選ぶ', () => {
  const result = refs(claim('暦年課税の基礎控除は年110万円です。', { subject: '暦年課税の基礎控除（年110万円）' }));
  assert.equal(result[0].url, article.source_url); assert.equal(result[1].url, ta('4408'));
});

for (const subject of ['配偶者控除(居住用不動産の贈与)', '配偶者控除（居住用）(贈与)',
  '配偶者控除（住宅（建物）の贈与）', '配偶者控除（住宅(建物)の贈与）', '配偶者控除 （居住用）  ']) {
  test('X1', `制度名の枠では末尾の補足を外す: ${subject}`, () => {
    // 主張全体の得点をゼロにし、制度名だけの1枠を確かめる。
    const result = E.searchEvidence(claim('制度を確認します。', { subject }), {
      tax_domain: 'inheritance_tax', catalog: catalog([entry(ta('4452')), entry(ta('4455'))]),
    });
    assert.deepEqual(result.map(e => e.url), [ta('4452')]);
  });
}

test('X1', '空になる名前・途中のかっこ・対応しないかっこは元の名前を使う', () => {
  for (const subject of ['（配偶者控除）', '（配偶者控除）（補足）', '試験制度（対象）の控除', '試験制度（対象', '試験制度（対象)']) {
    const e = entry('https://example.jp/unchanged', subject);
    const result = E.searchEvidence(claim('制度を確認します。', { subject }), { catalog: catalog([e]) });
    assert.equal(result.length, 1); assert.equal(result[0].score, 80);
  }
});

test('X1', '題名の制度名の加点にも補足を外した名前を使う', () => {
  const e = entry('https://example.jp/title', '試験制度の取扱い');
  const result = E.searchEvidence(claim('取扱いを確認します。', { subject: '試験制度（対象の補足）' }), { catalog: catalog([e]) });
  assert.deepEqual(result.map(e => e.id), [e.id]); assert.ok(result[0].score > 5);
});

test('X1', '主張全体の検索語と原文の抜粋には元の補足を残す', () => {
  const marker = '珍しい確認語';
  const e = entry('https://example.jp/query', '試験制度', '前置き。'.repeat(900) + marker + 'の説明です。' + '後書き。'.repeat(900));
  const result = E.searchEvidence(claim('取扱いを確認します。', { subject: `試験制度（${marker}）` }), { catalog: catalog([e]) });
  assert.equal(result.length, 1); assert.ok(result[0].text.includes(marker)); assert.ok(result[0].text.length <= 2000);
});

// 03o・03t・03w の保存記録から、補足なしの代表例を固定する。順序も変えない。
for (const [stage, subject, summary, rest] of [
  ['03o', '低価法の届出', '新たに事業を開始した場合はその年の確定申告書の提出期限までに届け出る',
    ['tsutatsu:shotoku:47-9', 'tsutatsu:shotoku:47-11', 'law:sozeki_rei:39_11']],
  ['03t', '新規開業の届出', '新規開業はその年分の確定申告書提出期限まで',
    ['https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2070.htm', 'law:sozeki_rei:39_11', 'law:sozeki_hou:66_3']],
  ['03w', '評価方法の届出', '新たに事業を開始した場合、届出はその年の確定申告書の提出期限まで',
    ['tsutatsu:shotoku:47-14', 'tsutatsu:shotoku:48-7', 'tsutatsu:shotoku:48の2-3']],
]) test('X1', `${stage} の補足のない制度名は候補と順序を維持する`, () => {
  const source = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm';
  const c = claim('- 新たに事業を開始した場合：その年の確定申告書の提出期限まで', { subject, claim: summary });
  const result = E.searchEvidence(c, { tax_domain: 'bookkeeping_expenses', source_url: source });
  assert.deepEqual(result.map(e => e.id), [source, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2090.htm', ...rest]);
});

test('X1', '抜き出しでは制度名の補足を禁じ、種類の説明にかっこを使わない', async () => {
  await F.extractClaims('配偶者控除は最大2,000万円です。', async request => {
    assert.ok(request.system.includes('subject は制度名・論点名（かっこの補足を付けない）'));
    const start = request.system.indexOf('type は次の8語');
    const end = request.system.indexOf('s は主張', start);
    assert.ok(start >= 0 && end > start);
    const types = request.system.slice(start, end);
    assert.ok(types.includes('要件・金額・割合・期限・適用年・手続・番号・判定。'));
    assert.ok(types.includes('要件は対象・条件、期限は保存期間を含む、手続は届出・申請・選択、番号は条文・通達・タックスアンサーのことです。'));
    assert.doesNotMatch(types, /[（）()]/); assert.equal(request.maxTokens, 8000);
    return [];
  }, options);
});

const own = { id: 'own', title: '候補資料', url: 'https://example.jp/own', text: '基礎控除は110万円です。' };
const shared = { id: 'shared', title: '別主張の候補資料', url: 'https://example.jp/shared', text: '基礎控除は110万円です。' };
const amount = claim(own.text, { subject: '基礎控除' });
const peer = { ...amount, id: 'c2' };
async function judge(type, outside, inspect = () => {}) {
  return F.judgeClaims([{ ...amount, type }, peer], { c1: [own], c2: [shared] }, amount.sentence, async request => {
    inspect(request);
    assert.deepEqual(JSON.parse(request.user).claims.map(c => c.evidence_ids), [[1], [2]]);
    return [{ id: 'c1', status: '裏付けあり', evidence_id: outside ? 2 : 1, basis: '1' }, { id: 'c2', status: '資料なし' }];
  }, options);
}

test('X2', '判定の指示文は候補外を認める3種類と候補内だけの5種類を明示する', async () => {
  await judge('金額', false, request => {
    assert.ok(request.system.includes('要件・判定・手続の主張で、evidence_ids の資料に根拠が無く、この資料表の別の資料に根拠があるときは、その資料の番号を evidence_id に書いてかまいません。金額・割合・期限・適用年・番号の主張は evidence_ids の資料だけを根拠にしてください。'));
    assert.equal(request.maxTokens, 16000);
  });
});

for (const type of ['金額', '割合', '期限', '適用年', '番号']) test('X2', `${type}が候補外の資料を挙げたら従来どおり却下する`, async () => {
  const row = (await judge(type, true))[0];
  assert.equal(row.status, '資料なし'); assert.equal(row.reject_reason, '資料の番号がこの主張の候補でない');
  assert.equal(Object.hasOwn(row, 'evidence_outside_candidates'), false);
  assert.deepEqual(row.evidence.map(e => e.id), [own.id]);
});

for (const type of ['要件', '判定', '手続']) test('X2', `${type}の候補外資料は従来どおり確認後に採る`, async () => {
  const row = (await judge(type, true))[0];
  assert.equal(row.status, '裏付けあり'); assert.equal(row.evidence_outside_candidates, true);
  assert.equal(row.quote, shared.text); assert.deepEqual(row.evidence.map(e => e.id), [own.id, shared.id]);
});

test('X2', '候補内資料の110万円は裏付けありのままにする', async () => {
  const row = (await judge('金額', false))[0];
  assert.equal(row.status, '裏付けあり'); assert.equal(row.quote, own.text);
  assert.equal(Object.hasOwn(row, 'evidence_outside_candidates'), false);
});

(async () => {
  let passed = 0, failed = 0; const groups = {};
  for (const { group, name, run } of tests) {
    groups[group] ||= { pass: 0, fail: 0 };
    try { await run(); passed++; groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
    catch (error) { failed++; groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
  }
  console.log(JSON.stringify({ passed, failed, groups }));
  if (failed) process.exitCode = 1;
})();
