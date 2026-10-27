'use strict';

// 03w の回帰試験。保存済み資料は読むだけにし、LLMは偽物にする。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const F = require('../fact-check');
const U = require('../fact-units');
const page = require('../../../netlify/functions/review-page');
const audit = require('../../audit-published-facts');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', batch: false,
  now: new Date('2026-10-20T00:00:00Z'), loadEvidenceText: e => e.text };
const ref = (text, id = 'own') => ({ id, text, title: '試験資料', url: 'https://example.jp/' + id, law_version: '' });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '相続時精算課税', type: '金額', heading: '', ...extra });
const raw = body => `---\nslug: fact-03w\nrecommendation: publish\n---\n${body}`;
const source = ref('令和6年1月1日以降の贈与では、年間110万円の基礎控除があります。');
const originalA = '令和6年1月1日以降の贈与からは、年間110万円の基礎控除と300万円の特別控除が新設されました。';
const badA = '年間110万円の基礎控除があります（特別控除は国税庁の案内で確認）。';
const goodA = '令和6年1月1日以降の贈与では、年間110万円の基礎控除があります（特別控除は国税庁の案内で確認）。';
const originalB = '令和7年1月1日以降の贈与からは、年間110万円の基礎控除が新設されました。';
const badB = '令和7年1月1日以降の贈与では、年間110万円の基礎控除があります。';
const goodB = '年間110万円の基礎控除があります（適用開始日は国税庁の案内で確認）。';

async function repairDate(kind, replacement, fullYear = false) {
  let extracts = 0;
  const original = kind === 'a' ? originalA : originalB;
  return F.checkFacts(original, { ...options, searchEvidence: () => [source], callLLM: async req => {
    if (req.task === 'extract') {
      extracts++;
      if (extracts > 1) return [{ s: 1, type: '金額', subject: '相続時精算課税', claim: '基礎控除は年110万円' }];
      if (kind === 'b') return [{ s: 1, type: '金額', subject: '相続時精算課税', claim: `${fullYear ? '令和7年1月1日' : '令和7年'}以降の贈与から年110万円の基礎控除が新設` }];
      return [
        { s: 1, type: '適用年', subject: '相続時精算課税', claim: `${fullYear ? '令和6年1月1日' : '令和6年'}以降の贈与に適用` },
        { s: 1, type: '金額', subject: '相続時精算課税', claim: '基礎控除は110万円' },
        { s: 1, type: '金額', subject: '相続時精算課税', claim: '特別控除は300万円' },
      ];
    }
    if (req.task === 'repair') return [{ id: kind === 'a' ? 'c3' : 'c1', replacement }];
    return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: '1' }));
  } });
}

for (const fullYear of [false, true]) test('W1', `(a) ${fullYear ? '年月日' : '年だけ'}の要約でも正しい適用日を消す修正を拒否する`, async () => {
  const result = await repairDate('a', badA, fullYear);
  assert.equal(result.record.claims[0].status, '裏付けあり');
  assert.equal(result.body, originalA); assert.equal(result.record.status, 'revise');
  assert.equal(result.record.corrections[0].reason, '裏付けのある数字を消しています');
  assert.equal(matter(F.applyFactResult(raw(result.body), result)).data.fact_check_blocking, true);
});

for (const fullYear of [false, true]) test('W1', `(b) ${fullYear ? '年月日' : '年だけ'}の要約でも誤った適用日を残す修正を拒否する`, async () => {
  const result = await repairDate('b', badB, fullYear);
  assert.deepEqual(result.record.claims[0].supported_numbers, ['110万円']);
  assert.equal(result.body, originalB); assert.equal(result.record.status, 'revise');
  assert.equal(result.record.corrections[0].reason, '資料の無い数字が残っています');
});

for (const [kind, replacement] of [['a', goodA], ['b', goodB]]) test('W1', `(${kind}) 正しい数字を残し、資料なしの数字を消す修正は採る`, async () => {
  const result = await repairDate(kind, replacement);
  assert.equal(result.body, replacement); assert.equal(result.record.status, 'ok');
  assert.equal(result.record.corrections[0].resolved, true);
});

for (const [date, year, amount] of [
  ['令和6年1月1日', '令和6年', '110万円'], ['令和６年１月１日', '令和6年', '１１０万円'], ['2026年1月1日', '2026年', '110万円'],
]) test('W1', `部分的な裏付けの日付を本文の表記「${date}」で保持する`, async () => {
  const sentence = `${date}以降の贈与は、基礎控除${amount}と特別控除300万円です。`;
  const c = claim(sentence, { claim: `${year}以降、基礎控除110万円と特別控除300万円` });
  const e = ref(`${date}以降の贈与の基礎控除は110万円です。`);
  const row = (await F.judgeClaims([c], { c1: [e] }, sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options))[0];
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, [date, amount]);
});

test('W1', '年だけの裏付けを別の年・元号・基準日から広げない', async () => {
  for (const date of ['令和7年1月1日', '平成6年1月1日', '令和6年1月1日現在']) {
    const sentence = `${date}、基礎控除110万円と特別控除300万円があります。`;
    const c = claim(sentence, { status: '資料なし', claim: '特別控除300万円', keep: [{ claim: '令和6年以降に適用' }, { claim: '110万円' }] });
    const replacement = '基礎控除110万円があります（特別控除は国税庁の案内で確認）。';
    const result = await F.repairBody(sentence, [c], async () => [{ id: 'c1', replacement }]);
    assert.equal(result.body, replacement); assert.equal(result.rejected.size, 0);
  }
});

function weddingMaterial() {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../data/nta-sources/taxanswer/zoyo/4511.json'), 'utf8'));
  const text = j.body.split('関連リンク')[0];
  return { ...ref(text, 'ta:4511'), kind: 'taxanswer', no: '4511', title: j.title, url: j.url };
}
const wedding = weddingMaterial();
const basis = String(U.splitUnits(wedding.text, { material: true }).find(u => u.text.includes('（注1）')).s);
const peer = '結婚・子育て資金の制度を確認します。';
async function repairOutside(original, replacement, summary, ownKeep = false) {
  let extracts = 0, sentKeep;
  const own = ref('住宅取得等資金の受贈者には所得などの要件があります。');
  const result = await F.checkFacts(original + '\n' + peer, { ...options,
    searchEvidence: c => c.subject === '結婚・子育て資金' ? [wedding] : [own],
    callLLM: async req => {
      if (req.task === 'extract') {
        extracts++;
        if (extracts > 1) return [{ s: 1, type: '要件', subject: '住宅取得等資金', claim: '受贈者には所得などの要件がある' }];
        return [{ s: 1, type: '要件', subject: '住宅取得等資金', claim: summary },
          { s: 1, type: '金額', subject: '住宅取得等資金', claim: original.includes('300万円') ? '控除額は300万円' : '所得要件は1,000万円以下' },
          { s: 2, type: '要件', subject: '結婚・子育て資金', claim: peer }];
      }
      if (req.task === 'repair') { sentKeep = JSON.parse(req.user).corrections[0].keep; return [{ id: 'c2', replacement }]; }
      return JSON.parse(req.user).claims.map(c => c.id === 'c2' && extracts === 1 ? { id: c.id, status: '資料なし' }
        : { id: c.id, status: '裏付けあり', evidence_id: ownKeep && c.subject === '住宅取得等資金' ? 1 : 2, basis: ownKeep && c.subject === '住宅取得等資金' ? '1' : basis });
    } });
  return { ...result, sentKeep };
}

const oldSentence = '住宅取得等資金の受贈者には要件があり、控除は300万円です。';
const newSentence = '住宅取得等資金には受贈者の要件があります（控除額は国税庁の案内で確認）。';
const draw = record => page.renderReviewPage('2026-10-20-fact-03w.md', { slug: 'fact-03w', fact_check_status: record.status }, '<p>本文</p>', 'main', null, F.compactRecord(record));

test('W2', '書き換えた文の旧行を数えず、要約・一覧・公開済み件数を1件にする', async () => {
  const r = await repairOutside(oldSentence, newSentence, '受贈者には一定の要件がある');
  assert.equal(r.body, newSentence + '\n' + peer); assert.equal(r.record.status, 'ok');
  assert.match(r.record.summary, /候補の外の資料で裏付け 1 件/);
  assert.equal(audit.counts(r.record).outside, 1);
  const rows = F.outsideCandidateClaims(r.record);
  assert.equal(rows.length, 1); assert.equal(rows[0].sentence, newSentence);
  const html = draw(r.record), start = html.indexOf('候補の外の資料で裏付けた主張');
  const list = html.slice(start, html.indexOf('</details>', start));
  assert.ok(list.includes(newSentence)); assert.ok(!list.includes(oldSentence));
});

test('W2', '適用した修正が未解決でも旧文の行を除く', async () => {
  const r = await repairOutside(oldSentence, newSentence, '受贈者には一定の要件がある');
  r.record.corrections[0].resolved = false;
  assert.deepEqual(F.outsideCandidateClaims(r.record).map(c => c.sentence), [newSentence]);
});

test('W2', '却下してafterが空なら元の文の行を残す', async () => {
  const r = await repairOutside(oldSentence, newSentence, '受贈者には一定の要件がある');
  r.record.corrections[0].after = ''; r.record.corrections[0].resolved = false; r.record.rechecked = [];
  assert.deepEqual(F.outsideCandidateClaims(r.record).map(c => c.sentence), [oldSentence]);
});

for (const date of ['令和6年4月1日', '2024年4月1日']) test('W3', `基準日の完全一致「${date}現在」を抜き出しと判定で認める`, async () => {
  const sentence = `${date}現在の法令では、基礎控除は年110万円です。`;
  const summary = `${date}現在の基礎控除は年110万円`;
  const r = await F.checkFacts(sentence, { ...options, repair: false, searchEvidence: () => [ref(sentence)], callLLM: async req => req.task === 'extract'
    ? [{ s: 1, type: '金額', subject: '基礎控除', claim: summary }]
    : [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }] });
  assert.equal(r.record.discarded, 0); assert.equal(r.record.claims[0].sentence, sentence);
  assert.equal(r.record.claims[0].status, '裏付けあり'); assert.equal(r.record.status, 'ok');
});

test('W3', '年だけの要約を基準日の年月日には広げない', async () => {
  for (const body of ['令和6年4月1日現在の法令では、基礎控除は年110万円です。', '令和6年4月1日現在法令等\n基礎控除は年110万円です。']) {
    const r = await F.extractClaims(body, async () => [{ s: 1, type: '金額', subject: '基礎控除', claim: '令和6年以降の基礎控除は年110万円' }], options);
    assert.equal(r.claims.length, 0); assert.equal(r.discardedClaims[0].status, '本文に見つからない');
  }
});

test('W4', '4511で候補外の裏付けとなった所得1,000万円はkeepに渡さず、消す修正を採る', async () => {
  const original = '住宅取得等資金は受贈者の合計所得金額が1,000万円以下なら非課税です。';
  const replacement = '住宅取得等資金の所得要件は国税庁の案内で確認してください。';
  const r = await repairOutside(original, replacement, '受贈者の合計所得金額が1,000万円以下');
  assert.equal(r.record.claims[0].evidence_outside_candidates, true); assert.deepEqual(r.sentKeep, []);
  assert.equal(r.body, replacement + '\n' + peer); assert.equal(r.record.status, 'ok');
  assert.equal(r.record.corrections[0].resolved, true);
});

test('W4', '候補内の裏付けをkeepから除かず、正しい数字を消す修正を拒否する', async () => {
  const original = '住宅取得等資金は所得2,000万円以下が対象で、控除は300万円です。';
  const replacement = '住宅取得等資金の所得要件と控除額は国税庁の案内で確認してください。';
  const r = await repairOutside(original, replacement, '受贈者の合計所得金額は2,000万円以下', true);
  assert.equal(r.sentKeep.length, 1); assert.equal(r.body, original + '\n' + peer);
  assert.equal(r.record.corrections[0].reason, '裏付けのある数字を消しています'); assert.equal(r.record.status, 'revise');
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
