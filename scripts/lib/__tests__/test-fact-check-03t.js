'use strict';

// 03t の回帰試験。保存済み原文は読み取り専用、LLM・カタログは偽物にする。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const matter = require('gray-matter');
const F = require('../fact-check');
const U = require('../fact-units');
const { tokenizeForMatcher } = require('../nta-source-matcher');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { enabled: true, now: new Date('2026-10-20T00:00:00Z'), provider: 'anthropic', model: 'claude-opus-5-5', loadEvidenceText: e => e.text };
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '生前贈与加算', heading: '', type: '金額', ...extra });
const ref = (text, extra = {}) => ({ id: 'e1', kind: 'taxanswer', no: '4161', title: '試験用資料',
  url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4161.htm', text, law_version: '', ...extra });
function material(no) {
  const ta = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../data/nta-sources/taxanswer/sozoku/${no}.json`), 'utf8'));
  const at = ta.body.indexOf('関連リンク'), text = at >= 0 ? ta.body.slice(0, at) : ta.body;
  return { text, ref: ref(text, { id: `ta:${no}`, no, title: ta.title, url: ta.url }), units: U.splitUnits(text, { material: true }) };
}
async function judge(c, e, basis) {
  return (await F.judgeClaims([c], { [c.id]: [e] }, c.sentence,
    async () => [{ id: c.id, status: '裏付けあり', evidence_id: 1, basis }], options))[0];
}
const gift = claim('相続開始前3年超7年以内の贈与分は総額100万円まで加算対象外です。');
const ta4161 = material('4161'), noteBasis = String(ta4161.units.find(u => u.text.includes('総額100万円')).s);
test('T1', '正しい主張でも2か所目を足さず、3年と100万円だけ保持する', async () => {
  const row = await judge(gift, ta4161.ref, noteBasis);
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['3年', '100万円']);
  assert.equal(Object.hasOwn(row, 'basis_added'), false); assert.equal(row.quote, '');
  assert.equal(row.rejected_answer.basis, noteBasis);
});
for (const [no, basis, sentence, subject] of [
  ['4161', '20', '令和9年1月2日以後の相続では、相続開始前7年以内に取得した財産以外は総額100万円まで加算されません。', '生前贈与加算'],
  ['4161', '20', '令和6年1月1日以後の相続開始では、相続開始前3年以内に取得した財産以外は総額100万円まで加算されません。', '生前贈与加算'],
  ['4161', '20', '令和9年1月2日以後の相続開始では、相続開始前3年以内の贈与以外は総額110万円まで加算されません。', '生前贈与加算'],
  ['4103', '21', '相続時精算課税は18歳以上の父母から贈与を受けた場合に選択でき、令和6年1月1日以後の贈与が対象です。', '相続時精算課税'],
  ['4504', '6', '相続時精算課税の特別控除額は2,500万円で、相続時精算課税に係る基礎控除額は40万円です。', '相続時精算課税'],
]) test('T1', `レビューの誤った主張を通さない: TA${no} ${sentence}`, async () => {
  const row = await judge(claim(sentence, { subject }), material(no).ref, basis);
  assert.equal(row.status, '資料なし'); assert.equal(Object.hasOwn(row, 'basis_added'), false);
});
test('T1', 'R3専用の関数・定数・basis_addedの出力が残っていない', () => {
  const source = fs.readFileSync(require.resolve('../fact-check'), 'utf8');
  for (const name of ['completeNumberBasis', 'numberBasisForms', 'excludedNumberBasisRanges', 'numberContextWords', 'NUMBER_CONTEXT_STOP_WORDS', 'basis_added']) {
    assert.ok(!source.includes(name), name);
  }
});
test('T1', 'LLM自身が返す2範囲の裏付けは従来どおり確かめる', async () => {
  const row = await judge(gift, ta4161.ref, `8,${noteBasis}`);
  assert.equal(row.status, '裏付けあり'); assert.equal(F.quoteParts(row.quote).length, 2);
  assert.equal(Object.hasOwn(row, 'basis_added'), false);
});

const keptGift = '相続開始前3年以内に取得した財産以外は総額100万円まで加算されません。';
async function repaired({ original = gift.sentence, summary = original, source = ta4161.ref, basis = noteBasis,
  replacement = keptGift, recheckType = '金額', recheck = true, recheckBasis = basis } = {}) {
  let extracts = 0;
  return F.checkFacts(original, { ...options, searchEvidence: () => [source], callLLM: async req => {
    if (req.task === 'extract') {
      extracts++;
      if (extracts > 1 && !recheck) return [];
      return [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => ({ s: +m[1], type: extracts === 1 ? '金額' : recheckType,
        subject: '生前贈与加算', claim: extracts === 1 ? summary : m[2] }));
    }
    if (req.task === 'repair') return [{ id: 'c1', replacement }];
    return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1,
      basis: extracts === 1 ? basis : recheckBasis }));
  } });
}
for (const recheck of [true, false]) test('T1', `3年と100万円を残す修正は採り、再照合が${recheck ? 'あれば解決' : '無ければ止める'}`, async () => {
  const result = await repaired({ recheck });
  assert.equal(result.body, keptGift); assert.deepEqual(result.record.claims[0].supported_numbers, ['3年', '100万円']);
  assert.equal(result.record.corrections[0].resolved, recheck);
  assert.equal(result.record.status, recheck ? 'ok' : 'revise');
  if (!recheck) {
    assert.equal(result.record.rechecked.length, 0);
    const raw = `---\nslug: fact-03t\nrecommendation: publish\n---\n${result.body}`;
    const meta = matter(F.applyFactResult(raw, result)).data;
    assert.equal(meta.recommendation, 'revise'); assert.equal(meta.fact_check_blocking, true);
  }
});
for (const [replacement, reason] of [
  [gift.sentence.replace('です。', 'となります。'), '資料の無い数字が残っています'],
  ['加算されない贈与財産の総額は100万円です。', '裏付けのある数字を消しています'],
]) test('T1', '7年を残す修正・3年を消す修正は採らない', async () => {
  const row = await judge(gift, ta4161.ref, noteBasis);
  const result = await F.repairBody(gift.sentence, [row], async () => [{ id: 'c1', replacement }]);
  assert.equal(result.body, gift.sentence); assert.equal(result.rejected.get('c1'), reason);
});

const wedding = '結婚・子育て資金は1,000万円（うち結婚費用300万円）まで非課税です。';
const weddingSource = ref('結婚・子育て資金は1,000万円まで非課税です。');
const weddingSummary = '結婚・子育て資金は1千万円（結婚費用3百万円）まで非課税です。';
test('T2', 'supported_numbersとkeep_numbersは要約でなく本文の表記にする', async () => {
  const row = await judge(claim(wedding, { claim: weddingSummary }), weddingSource, '1');
  assert.deepEqual(row.supported_numbers, ['1,000万円']);
  const replacement = '結婚・子育て資金は1,000万円まで非課税です（結婚費用の上限は国税庁の案内で確認）。';
  const result = await F.repairBody(wedding, [row], async req => {
    assert.deepEqual(JSON.parse(req.user).corrections[0].keep_numbers, ['1,000万円']);
    return [{ id: 'c1', replacement }];
  });
  assert.equal(result.body, replacement); assert.equal(result.rejected.size, 0);
});
test('T2', '本文の同じ値の全表記を残し、重複だけ除く', async () => {
  const sentence = '結婚・子育て資金は1,000万円（別表記1千万円、結婚費用300万円）まで非課税で、総額1,000万円です。';
  const row = await judge(claim(sentence, { claim: weddingSummary }), weddingSource, '1');
  assert.deepEqual(row.supported_numbers, ['1,000万円', '1千万円']);
});
for (const recheckType of ['要件', '判定', '手続', '番号', '金額', '割合', '期限', '適用年']) test('T3', `再照合の${recheckType}を数字の裏付けに数えるか`, async () => {
  const filler = Array(5).fill('中間の説明を確認しています'.repeat(15) + '。');
  const text = [weddingSource.text, ...filler, '制度の案内については国税庁の説明を確認してください。'].join('\n');
  const numeric = ['金額', '割合', '期限', '適用年'].includes(recheckType);
  const result = await repaired({ original: wedding, source: ref(text), basis: '1',
    replacement: '結婚費用は1,000万円まで非課税です（詳しくは国税庁の案内で確認）。', recheckType,
    recheckBasis: numeric ? '1' : String(U.splitUnits(text, { material: true }).at(-1).s) });
  assert.equal(result.record.rechecked[0].status, '裏付けあり');
  assert.equal(result.record.corrections[0].resolved, numeric);
  assert.equal(result.record.status, numeric ? 'ok' : 'revise');
});
test('T4', '単なる譲渡は所得税資料の減点を外さず、譲渡所得なら外す', () => {
  const title = '土地の譲渡の非課税', e = { id: 'joto', kind: 'taxanswer', no: '9999', title,
    text: title, url: 'https://www.nta.go.jp/taxanswer/joto/9999.htm' };
  e.tokens = tokenizeForMatcher(e.text); e.titleTokens = tokenizeForMatcher(e.title);
  const catalog = { entries: [e], df: new Map([...e.tokens].map(t => [t, 1])) };
  const search = (c, tax_domain) => F.searchEvidence(c, { catalog, tax_domain })[0].score;
  const c = claim('土地の譲渡は消費税が非課税です。', { subject: title, type: '判定' });
  assert.ok(Math.abs(search(c, 'consumption_tax') - search(c) * 0.15) < 0.02);
  const income = { ...c, claim: c.claim + '譲渡所得を確認します。' };
  assert.equal(search(income, 'consumption_tax'), search(income));
});
test('T3', 'keep_numbersの無い修正本文は従来とバイト一致', async () => {
  const c = claim('控除は120万円です。', { subject: '制度', status: '資料なし' });
  await F.repairBody(c.sentence, [c], async req => {
    assert.equal(createHash('sha256').update(JSON.stringify(req)).digest('hex'), '27e026363ec74bd8c786cf8b11ffe0ec0ba06ac5c6b66877edaa2fdee37e37ea');
    return [];
  });
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
