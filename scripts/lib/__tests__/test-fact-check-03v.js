'use strict';

// 03v の回帰試験。保存済み資料は読み取り専用、LLMは偽物にする。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const F = require('../fact-check');
const E = require('../fact-evidence');
const U = require('../fact-units');
const page = require('../../../netlify/functions/review-page');
const audit = require('../../audit-published-facts');
const factAudit = require('../fact-audit');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', batch: false,
  now: new Date('2026-10-20T00:00:00Z'), loadEvidenceText: e => e.text };
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '住宅取得等資金', heading: '', type: '金額', ...extra });
const ref = (text, id = 'own') => ({ id, title: '試験資料', text, url: 'https://example.jp/' + id, law_version: '' });
const raw = body => `---\nslug: fact-03v\nrecommendation: publish\n---\n${body}`;
function material(folder, no) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../data/nta-sources/taxanswer/${folder}/${no}.json`), 'utf8'));
  const at = j.body.indexOf('関連リンク'), text = at >= 0 ? j.body.slice(0, at) : j.body;
  return { id: 'ta:' + no, kind: 'taxanswer', no, title: j.title, url: j.url, law_version: '', text };
}
const education = material('zoyo', '4510'), wedding = material('zoyo', '4511'), settlement = material('sozoku', '4103');
const educationBasis = String(U.splitUnits(education.text, { material: true }).find(u => u.text.includes('1,500万円')).s);
const weddingBasis = String(U.splitUnits(wedding.text, { material: true }).find(u => u.text.includes('（注1）')).s);
const housing = claim('住宅取得等資金の贈与は1,500万円まで非課税です。');
const housingCandidates = F.searchEvidence(housing);
assert.deepEqual(housingCandidates.map(e => e.no), ['4508', '70_2', '40_4_2']);
const peer = claim('教育資金は30歳未満の受贈者が対象です。', { id: 'c2', type: '要件', subject: '教育資金' });
async function outside(c, source = education, answer = {}, candidates = housingCandidates) {
  const rows = await F.judgeClaims([c, peer], { [c.id]: candidates, c2: [source] }, c.sentence + '\n' + peer.sentence,
    async req => {
      const input = JSON.parse(req.user), ownIds = input.claims[0].evidence_ids, otherId = input.claims[1].evidence_ids[0];
      assert.ok(!ownIds.includes(otherId));
      return [{ id: c.id, status: '裏付けあり', evidence_id: otherId, basis: source === wedding ? weddingBasis : educationBasis, ...answer },
        { id: 'c2', status: '資料なし' }];
    }, { ...options, loadEvidenceText: E.loadEvidenceText });
  return rows[0];
}
const blocked = row => {
  assert.equal(row.status, '資料なし'); assert.equal(row.reject_reason, '資料の番号がこの主張の候補でない');
  assert.equal(row.evidence_id, ''); assert.equal(Object.hasOwn(row, 'supported_numbers'), false);
  assert.equal(Object.hasOwn(row, 'evidence_outside_candidates'), false);
};

for (const [name, c, source, answer] of [
  ['住宅の1,500万円を教育資金4510で裏付けない', housing, education, {}],
  ['住宅の合計所得1,000万円を結婚子育て資金4511で裏付けない', claim('受贈者の合計所得金額が1,000万円を超えると受けられません。'), wedding, {}],
  ['正しい住宅の1,000万円を教育資金の1,500万円へ書き換えない', claim('省エネ等住宅なら1,000万円まで非課税です。'), education,
    { status: '食い違い', correct: '住宅取得等資金の贈与は1,500万円まで非課税です。' }],
  ['要件の食い違いも候補外資料では採用しない', claim('住宅取得等資金は30歳未満の受贈者が対象です。', { type: '要件' }), education,
    { status: '食い違い', correct: '受贈者は30歳未満です。' }],
  ['期限の書き漏れを候補外資料から作らない', claim('住宅取得等資金の非課税を利用できます。', { type: '要件' }), education,
    { status: '期限の書き漏れ', correct: '令和8年3月31日までです。' }],
  ['部分的に一致しても教育資金の1,500万円を保持数字にしない', claim('省エネ住宅なら1,500万円、一般住宅なら500万円まで非課税です。'), education, {}],
]) test('V1', name, async () => blocked(await outside(c, source, answer)));

for (const type of ['金額', '割合', '期限', '適用年', '番号']) test('V1', `${type}の数字の主張は候補外資料で通さない`, async () => {
  blocked(await outside({ ...housing, type }));
});

test('V1', '候補内の引用からの保持数字は従来どおり残す', async () => {
  const c = claim('住宅取得等資金は1,500万円と500万円まで非課税です。');
  const row = (await F.judgeClaims([c], { c1: [ref('住宅取得等資金は500万円まで非課税です。')] }, c.sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options))[0];
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['500万円']);
});

test('V1', '住宅の誤った1,500万円を残して再照合まで通す経路を止める', async () => {
  const original = '省エネ住宅なら1,500万円、一般住宅なら500万円まで非課税です。';
  const replacement = '省エネ住宅なら1,500万円まで非課税です。';
  const body = original + '\n' + peer.sentence;
  const result = await F.checkFacts(body, { ...options, loadEvidenceText: E.loadEvidenceText,
    searchEvidence: c => c.subject === '教育資金' ? [education] : housingCandidates,
    callLLM: async req => {
      if (req.task === 'extract') return [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => ({ s: +m[1], type: m[2] === peer.sentence ? '要件' : '金額',
        subject: m[2] === peer.sentence ? '教育資金' : '住宅取得等資金', claim: m[2] }));
      if (req.task === 'repair') return [{ id: 'c1', replacement }];
      return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: housingCandidates.length + 1, basis: educationBasis }));
    } });
  assert.equal(Object.hasOwn(result.record.claims[0], 'supported_numbers'), false);
  assert.equal(result.body, body); assert.equal(result.record.status, 'revise');
  assert.equal(matter(F.applyFactResult(raw(body), result)).data.fact_check_blocking, true);
});

async function acceptedRequirement(type = '要件') {
  const c = claim('住宅取得等資金は30歳未満の受贈者が対象です。', { type });
  return F.checkFacts(c.sentence + '\n' + peer.sentence, { ...options, repair: false, loadEvidenceText: E.loadEvidenceText,
    searchEvidence: item => item.subject === '教育資金' ? [education] : housingCandidates,
    callLLM: async req => req.task === 'extract'
      ? [{ s: 1, type, subject: c.subject, claim: c.claim }, { s: 2, type: '要件', subject: peer.subject, claim: peer.claim }]
      : JSON.parse(req.user).claims.map(item => ({ id: item.id, status: '裏付けあり', evidence_id: 4, basis: educationBasis })) });
}

for (const partial of [false, true]) test('V1', `03uの旧記録の候補外由来の${partial ? '保持数字' : '数字の裏付け'}を差分照合で使い回さない`, async () => {
  const r = await acceptedRequirement(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03v-prior-'));
  try {
    const before = raw(r.body), after = raw(r.body + '\n案内を追記します。');
    const legacy = { ...r.record.claims[0], type: '金額' };
    if (partial) {
      Object.assign(legacy, { status: '資料なし', quote: '', correct: '', evidence_id: '', evidence: legacy.evidence.slice(0, -1),
        supported_numbers: ['30歳'], rejected_answer: { status: '裏付けあり', evidence: education.id, basis: educationBasis } });
      delete legacy.evidence_outside_candidates;
    }
    const record = F.compactRecord({ ...r.record, slug: 'fact-03v', status: partial ? 'revise' : 'ok',
      claims: r.record.claims.map((c, i) => i === 0 ? legacy : c) });
    fs.writeFileSync(F.recordPath('fact-03v', dir), JSON.stringify(record) + '\n', 'utf8');
    const next = await F.checkArticle(after, { ...options, recordDir: dir, persist: false, previousRaw: before, repair: false,
      loadEvidenceText: E.loadEvidenceText, searchEvidence: c => c.subject === '教育資金' ? [education] : housingCandidates,
      callLLM: async req => req.task === 'extract'
        ? [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => m[2] !== '案内を追記します。').map(m => ({ s: +m[1], type: m[2] === peer.sentence ? '要件' : '金額',
          subject: m[2] === peer.sentence ? '教育資金' : '住宅取得等資金', claim: m[2] }))
        : JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 4, basis: educationBasis })) });
    assert.equal(next.record.logic_version, 'plan2-s1'); assert.equal(next.record.incremental, undefined);
    assert.equal(next.record.status, 'revise'); blocked(next.record.claims[0]);
    assert.ok(next.record.calls.some(c => c.task === 'judge'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const type of ['判定', '要件', '手続']) test('V1', `${type}の裏付けありは同じ資料表の候補外を認める`, async () => {
  const c = claim('暦年課税の基礎控除内なら通常は申告不要です。', { type, subject: '贈与税' });
  const source = material('zoyo', '4402');
  const rows = await F.judgeClaims([c, peer], { c1: [ref('贈与税の手続を確認してください。')], c2: [source] }, c.sentence + '\n' + peer.sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 2, basis: '1' }, { id: 'c2', status: '資料なし' }], options);
  assert.equal(rows[0].status, '裏付けあり'); assert.equal(rows[0].evidence_outside_candidates, true);
  assert.equal(rows[0].evidence.at(-1).id, source.id);
});

const outsideHeading = '候補の外の資料で裏付けた主張';
const draw = record => page.renderReviewPage('2026-10-20-fact-03v.md', { slug: 'fact-03v', fact_check_status: record.status }, '<p>本文</p>', 'main', null, record);
test('V2', '30歳未満の要件は止めず、件数・主張・採用資料・引用を表示する', async () => {
  const result = await acceptedRequirement(), record = F.compactRecord(result.record), row = record.claims[0];
  assert.equal(record.status, 'ok'); assert.equal(row.evidence_outside_candidates, true);
  assert.match(record.summary, /候補の外の資料で裏付け 1 件/);
  assert.equal(matter(F.applyFactResult(raw(result.body), result)).data.fact_check_blocking, false);
  const html = draw(record), at = html.indexOf(outsideHeading);
  assert.ok(at >= 0); const list = html.slice(at, html.indexOf('</details>', at));
  assert.ok(list.includes(row.sentence)); assert.ok(list.includes(education.title)); assert.ok(list.includes(education.url));
  assert.ok(list.includes(row.quote)); assert.ok(!html.includes('照合で承認が止まっています'));
  assert.equal(record.review_items.length, 0);
});

test('V2', '0件なら件数と一覧を表示しない', async () => {
  const r = await F.checkFacts('制度の案内です。', { ...options, callLLM: async () => [] });
  assert.ok(!r.record.summary.includes('候補の外の資料で裏付け'));
  assert.ok(!draw(r.record).includes(outsideHeading));
  assert.ok(!audit.renderReport([{ ...r.record, slug: 'zero', title: '試験記事' }]).includes('候補の外の資料で裏付け'));
});

test('V2', '古い記録の候補外一覧は表示しない', async () => {
  const r = await acceptedRequirement();
  assert.ok(!draw({ ...r.record, stale: true }).includes(outsideHeading));
});

test('V2', '公開済み一覧にも全体と記事ごとの件数を出す', async () => {
  const r = await acceptedRequirement(), record = F.compactRecord({ ...r.record, slug: 'fact-03v', title: '試験記事' });
  assert.equal(factAudit.auditOutsideCandidateCount(record), 1);
  assert.equal(audit.counts(record).outside, 1);
  assert.equal((audit.renderReport([record]).match(/候補の外の資料で裏付け 1 件/g) || []).length, 3);
  assert.equal(factAudit.auditReason({ body: r.body }, record), null);
  assert.equal(factAudit.auditInstructions(record), '');
});

test('V2', '再照合の重複・修正済み・資料なしは件数を水増ししない', async () => {
  const r = await acceptedRequirement(), c = r.record.claims[0];
  const record = { ...r.record, rechecked: [{ ...c, id: 'c9' }] };
  assert.equal(factAudit.auditOutsideCandidateCount(record), 1);
  assert.equal(factAudit.auditOutsideCandidateCount({ ...record, rechecked: [{ ...c, status: '資料なし' }] }), 0);
  assert.equal(factAudit.auditOutsideCandidateCount({ ...record, rechecked: [], corrections: [{ id: c.id, resolved: true }] }), 0);
});

test('V2', '一覧の主張・題名・引用をエスケープし危険なURLをリンクにしない', async () => {
  const r = await acceptedRequirement(), c = r.record.claims[0];
  const row = { ...c, sentence: '<script>主張</script>', quote: '<script>引用</script>', evidence_id: 'unsafe',
    evidence: [{ id: 'unsafe', title: '<img onerror=alert(1)>', url: 'javascript:alert(1)', text: '<script>引用</script>' }] };
  const html = draw({ ...r.record, claims: [row] });
  assert.ok(html.includes('&lt;script&gt;主張&lt;/script&gt;')); assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;引用&lt;/script&gt;')); assert.ok(!html.includes('href="javascript:'));
});

const dated = '令和6年1月1日以降の贈与からは、年間110万円の基礎控除が新設されたため、贈与税の負担が軽くなります。';
const summary = '令和6年以降の贈与から年110万円の基礎控除が新設';
const settlementUnits = U.splitUnits(settlement.text, { material: true });
const dateBasis = String(settlementUnits.find(u => u.text.includes('令和6年1月1日')).s);
const amountBasis = String(settlementUnits.find(u => u.text.includes('基礎控除額110万円')).s);
async function datedRow(text = summary, source = settlement) {
  return (await F.judgeClaims([claim(dated, { subject: '相続時精算課税', claim: text })], { c1: [source] }, dated,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: source === settlement ? dateBasis + ',' + amountBasis : '1' }], options))[0];
}

test('V3', '年だけの要約とTA4103の引用を判定で裏付けありにする', async () => {
  const row = await datedRow();
  assert.equal(row.status, '裏付けあり'); assert.equal(row.reject_reason, undefined);
  assert.equal(F.quoteParts(row.quote).length, 2);
});

test('V3', 'U2の例を修正まで通しても日付と110万円を消さない', async () => {
  let repairs = 0;
  const result = await F.checkFacts(dated, { ...options, searchEvidence: () => [settlement], callLLM: async req => {
    if (req.task === 'extract') return req.user.includes(dated) ? [{ s: 1, type: '金額', subject: '相続時精算課税', claim: summary }] : [];
    if (req.task === 'repair') { repairs++; return [{ id: 'c1', replacement: '基礎控除の内容は、国税庁の案内で確認してください。' }]; }
    return [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: dateBasis + ',' + amountBasis }];
  } });
  assert.equal(result.body, dated); assert.equal(result.record.status, 'ok'); assert.equal(repairs, 0);
  assert.equal(result.record.claims[0].status, '裏付けあり'); assert.equal(result.record.corrections.length, 0);
});

for (const [name, text, source] of [
  ['違う年の要約', summary.replace('令和6年', '令和7年'), settlement],
  ['和暦と西暦は換算しない', summary.replace('令和6年', '2024年'), settlement],
  ['違う年の資料', summary, ref(dated.replace('令和6年', '令和7年'))],
  ['基準日の年月日だけの資料', summary, ref('令和6年1月1日現在、年間110万円の基礎控除があります。')],
]) test('V3', name, async () => assert.equal((await datedRow(text, source)).status, '資料なし'));

test('V3', '抜き出しで年の補完と基準日の完全一致を区別する', async () => {
  for (const [body, text, kept = 0] of [[dated, summary.replace('令和6年', '令和7年')], ['令和6年1月1日現在法令等\n年間110万円の基礎控除があります。', summary],
    ['令和6年現在、年間110万円の基礎控除があります。', summary, 1]]) {
    const r = await F.extractClaims(body, async () => [{ s: 1, type: '金額', subject: '相続時精算課税', claim: text }], options);
    assert.equal(r.claims.length, kept); assert.equal(r.discarded, 1 - kept);
  }
});

test('V3', '本文の基準日の年が完全一致なら従来どおり数字の対応を認める', async () => {
  const sentence = '令和6年現在、年間110万円の基礎控除があります。';
  const row = (await F.judgeClaims([claim(sentence, { claim: summary })], { c1: [settlement] }, sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: dateBasis + ',' + amountBasis }], options))[0];
  assert.equal(row.status, '裏付けあり'); assert.equal(Object.hasOwn(row, 'supported_numbers'), false);
});

test('V3', '年だけの要約でも候補内資料から確認できた110万円を部分的に保持する', async () => {
  const sentence = dated.replace('基礎控除が', '基礎控除と300万円の特別控除が');
  const c = claim(sentence, { claim: summary + '、特別控除300万円', subject: '相続時精算課税' });
  const source = ref('令和6年1月1日から年間110万円の基礎控除があります。');
  const row = (await F.judgeClaims([c], { c1: [source] }, sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options))[0];
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['令和6年1月1日', '110万円']);
});

test('V4', '抜き出しの種類の説明の後を句点で区切る', async () => {
  await F.extractClaims(dated, async req => {
    assert.ok(req.system.includes('条文・通達・タックスアンサーのことです。s は主張を述べた'));
    assert.equal(req.maxTokens, 8000); return [];
  }, options);
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
