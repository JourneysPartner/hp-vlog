'use strict';

// 03r の回帰試験。カタログと LLM は偽物にし、通信は使わない。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const F = require('../fact-check');
const U = require('../fact-units');
const { tokenizeForMatcher } = require('../nta-source-matcher');
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const now = new Date('2026-10-20T00:00:00Z');
const options = { enabled: true, now, provider: 'anthropic', model: 'claude-opus-5-5', loadEvidenceText: e => e.text };
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, subject: '制度', heading: '', type: '金額', ...extra });
const ref = (text, no = '4161', extra = {}) => ({ id: `ta:${no}`, kind: 'taxanswer', no,
  title: `試験資料 ${no}`, url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/${no}.htm`, text, law_version: '', ...extra });
const raw = body => `---\nslug: fact-03r\nrecommendation: publish\n---\n${body}`;
function catalog(entries) {
  entries = entries.map(e => ({ ...e, titleTokens: tokenizeForMatcher(e.title), tokens: tokenizeForMatcher(`${e.title} ${e.text}`) }));
  const df = new Map();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) || 0) + 1);
  return { entries, df };
}
function inventoryCatalog(subject) {
  return catalog([
    { id: 'law:shotokuzei_rei:102', kind: 'law', key: 'shotokuzei_rei', no: '102', title: '所得税法施行令 棚卸資産の評価 原価法 任意 金額',
      text: '棚卸資産 評価方法 原価法 届け出 時価評価 任意 金額', url: 'https://example.jp/income' },
    ...['青空通算', '白雲連結', '赤松組織', '緑葉移転'].map((word, i) => ({
      id: i === 3 ? 'law:hojinzei_kisoku:27' : `tsutatsu:hojin:5-2-${9 + i}`, kind: i === 3 ? 'law' : 'tsutatsu',
      key: 'hojinzei_kisoku', circular: 'hojin', no: i === 3 ? '27' : `5-2-${9 + i}`, title: subject,
      text: `${subject} ${word.repeat(4)} ${i === 0 ? '準用取扱' : word} 法人税`, url: `https://example.jp/corporate-${i}`,
    })),
  ]);
}
async function judge(c, e, basis, answer = {}, extra = {}) {
  return (await F.judgeClaims([c], { [c.id]: [e] }, c.sentence,
    async () => [{ id: c.id, status: '裏付けあり', evidence_id: 1, basis, ...answer }], { ...options, ...extra }))[0];
}
const giftClaim = claim('相続開始前3年超7年以内の贈与分は総額100万円まで加算対象外です。', { subject: '生前贈与加算' });
const giftSource = ['加算対象期間が相続開始前7年以内となります。',
  ...Array(5).fill('贈与の制度についての中間の説明を確認します'.repeat(8) + '。'),
  '（注）相続開始の日が令和9年1月2日以後の場合には、相続開始前3年以内に取得した財産以外の財産については、総額100万円までは相続税の課税価格に加算されません。'].join('\n');
const giftUnits = U.splitUnits(giftSource, { material: true });
const giftBasis = String(giftUnits.at(-1).s);

for (const [name, subject, sentence] of [
  ['#642 c8', '棚卸資産の評価方法', '個人事業主の棚卸資産の評価方法は原則として原価法です。'],
  ['#642 c26', '棚卸資産の時価評価', '届出なしに任意で安い金額で評価することは認められません。'],
]) test('R1', `${name}: 個人の主張に所得税の条を渡す`, () => {
  const c = claim(sentence, { subject, type: '判定' }), cat = inventoryCatalog(subject);
  const ids = F.searchEvidence(c, { catalog: cat, tax_domain: 'bookkeeping_expenses' }).map(e => e.id);
  assert.ok(ids.includes('law:shotokuzei_rei:102'), JSON.stringify(ids));
});
test('R3', '#644: 離れた7年は補わず、注で確かめた数字だけ保持する', async () => {
  const row = await judge(giftClaim, ref(giftSource), giftBasis);
  assert.equal(row.status, '資料なし');
  assert.deepEqual(row.supported_numbers, ['3年', '100万円']);
  assert.equal(Object.hasOwn(row, 'basis_added'), false);
  assert.equal(row.quote, '');
  assert.equal(row.rejected_answer.basis, giftBasis);
});

test('R1', '法人の語・記事税目なし・未知なら従来の順位を保つ', () => {
  const c = claim('棚卸資産の評価方法を確認します。', { subject: '棚卸資産の評価方法', type: '判定' });
  const cat = inventoryCatalog(c.subject), search = (c, tax_domain) => F.searchEvidence(c, { catalog: cat, tax_domain });
  assert.deepEqual(search(c, undefined), search(c, 'unknown'));
  for (const field of ['subject', 'claim', 'sentence']) {
    const corporate = { ...c, [field]: c[field] + '法人' };
    assert.deepEqual(search(corporate, undefined), search(corporate, 'bookkeeping_expenses'));
  }
  assert.ok(!search(c, undefined).some(e => e.key === 'shotokuzei_rei'));
});
test('R1', '名指しの通達・記事自身の法人税資料・7件上限を保つ', () => {
  const c = claim('棚卸資産の評価方法は法人税基本通達5-2-9で確認します。', { subject: '棚卸資産の評価方法' });
  const cat = inventoryCatalog(c.subject);
  assert.ok(F.searchEvidence(c, { catalog: cat, tax_domain: 'bookkeeping_expenses' }).some(e => e.id === 'tsutatsu:hojin:5-2-9'));
  const ordinary = { ...c, claim: '棚卸資産を評価します。', sentence: '棚卸資産を評価します。' };
  const primary = cat.entries.at(-1);
  const rows = F.searchEvidence(ordinary, { catalog: cat, tax_domain: 'bookkeeping_expenses',
    source_url: primary.url, source_bundle: cat.entries.slice(1, 4).map(e => e.id).join(';') });
  assert.equal(rows[0].id, primary.id);
  for (const e of cat.entries.slice(1)) assert.ok(rows.some(r => r.id === e.id));
  assert.ok(rows.length <= 7);
});
test('R1', '措置法・通則法は共通で、直接指定とbundleの加点は減らさない', () => {
  const c = claim('棚卸資産の評価方法はNo.9999を確認します。', { subject: '棚卸資産の評価方法' });
  const entries = ['sozeki_hou', 'tsusoku_hou'].map(key => ({ id: key, kind: 'law', key,
    title: c.subject, text: '棚卸資産の評価方法', url: `https://example.jp/${key}` }));
  const e = ref('棚卸資産の評価方法', '9999', { title: c.subject, url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/9999.htm' });
  const cat = catalog([...entries, e]);
  const source_bundle = [...entries, e].map(e => e.id).join(';');
  const before = F.searchEvidence(c, { catalog: cat, source_bundle });
  const after = F.searchEvidence(c, { catalog: cat, source_bundle, tax_domain: 'bookkeeping_expenses' });
  for (const common of entries) assert.equal(after.find(r => r.id === common.id).score, before.find(r => r.id === common.id).score);
  assert.ok(Math.abs((after.find(r => r.id === e.id).score - 10005) - (before.find(r => r.id === e.id).score - 10005) * 0.15) < 0.02);
});
test('R1', '消費税の記事では所得税資料を下げ、確定申告の語があれば下げない', () => {
  const c = claim('控除額を確認します。', { subject: '控除額', type: '判定' });
  const cat = catalog([ref('控除額の取扱い', '9998', { title: '控除額', url: 'https://www.nta.go.jp/law/shitsugi/shotoku/99/01.htm' })]);
  const search = (c, tax_domain) => F.searchEvidence(c, { catalog: cat, tax_domain })[0];
  assert.ok(Math.abs(search(c, 'consumption_tax').score - search(c).score * 0.15) < 0.02);
  const withIncome = { ...c, sentence: c.sentence + '確定申告' };
  assert.equal(search(withIncome, 'consumption_tax').score, search(withIncome).score);
});
test('R1', '分類・法令キー・通達系列と記事の全税目を対応させる', () => {
  const c = claim('特別な控除額を確認します。', { subject: '控除額', type: '判定' });
  const groups = [
    ['income_tax', ['shotoku', 'gensen', 'joto'], ['shotokuzei_hou'], ['shotoku', 'sochi_shotoku', 'sochi_joto']],
    ['consumption_tax', ['shohi'], ['shohizei_hou'], ['shohi']],
    ['inheritance_tax', ['sozoku', 'zoyo', 'hyoka'], ['sozokuzei_hou'], ['sozoku', 'sochi_sozoku', 'hyoka']],
    ['corporate', ['hojin'], ['hojinzei_hou'], ['hojin', 'sochi_hojin']],
  ];
  for (const [domain, codes, keys, circulars] of groups) {
    const entries = [
      ...codes.flatMap(code => ['taxanswer', 'law/shitsugi'].map(section => ref('控除額の取扱い', '9997',
        { id: `${section}:${code}`, title: c.subject, url: `https://www.nta.go.jp/${section}/${code}/9997.htm` }))),
      ...keys.map(key => ({ id: key, kind: 'law', key, title: c.subject, text: '控除額の取扱い', url: `https://example.jp/${key}` })),
      ...circulars.map(circular => ({ id: circular, kind: 'tsutatsu', circular, title: c.subject, text: '控除額の取扱い', url: `https://example.jp/${circular}` })),
    ];
    for (const e of entries) {
      const cat = catalog([e]), search = tax_domain => F.searchEvidence(c, { catalog: cat, tax_domain })[0].score;
      const other = domain === 'income_tax' ? 'consumption_tax' : 'income_tax';
      assert.ok(Math.abs(search(other) - search() * 0.15) < 0.02, e.id);
      if (domain !== 'corporate') assert.equal(search(domain), search(), e.id);
    }
  }
  for (const domain of ['withholding', 'bookkeeping_expenses', 'invoice_system', 'overseas_transactions']) {
    const code = ['withholding', 'bookkeeping_expenses'].includes(domain) ? 'shotoku' : 'shohi';
    const cat = catalog([ref('控除額の取扱い', '9996', { title: c.subject, url: `https://www.nta.go.jp/taxanswer/${code}/9996.htm` })]);
    assert.equal(F.searchEvidence(c, { catalog: cat, tax_domain: domain })[0].score, F.searchEvidence(c, { catalog: cat })[0].score);
  }
});
test('R1', 'headingと記事全体の語は税目の免除条件に使わない', () => {
  const c = claim('棚卸資産を評価します。', { subject: '棚卸資産の評価方法' }), cat = inventoryCatalog(c.subject);
  const a = F.searchEvidence(c, { catalog: cat, tax_domain: 'bookkeeping_expenses' });
  assert.deepEqual(F.searchEvidence({ ...c, heading: '法人の取扱い' }, { catalog: cat, tax_domain: 'bookkeeping_expenses' }), a);
});
test('R1', '未分類のURL・通達・法令は共通資料として下げない', () => {
  const c = claim('控除額を確認します。', { subject: '控除額', type: '判定' });
  for (const e of [
    ref('控除額の取扱い', '9995', { title: c.subject, url: 'https://www.nta.go.jp/taxanswer/other/9995.htm' }),
    ref('控除額の取扱い', '9995', { title: c.subject, url: 'https://www.nta.go.jp/law/shitsugi/constructor/99/01.htm' }),
    { id: 'unknown', kind: 'tsutatsu', circular: 'gensen', title: c.subject, text: '控除額の取扱い', url: 'https://example.jp/unknown' },
    { id: 'common', kind: 'law', key: 'denshi_choubo', title: c.subject, text: '控除額の取扱い', url: 'https://example.jp/common' },
  ]) {
    const cat = catalog([e]);
    assert.deepEqual(F.searchEvidence(c, { catalog: cat, tax_domain: 'consumption_tax' }), F.searchEvidence(c, { catalog: cat }));
  }
});
test('R2', '同じ原文の3資料は1枠にし、次の別資料2件を渡す', () => {
  const entries = ['a', 'b', 'c'].map(id => ({ id, kind: 'law', key: 'tsusoku_hou', title: '棚卸資産の評価方法',
    text: '棚卸資産の評価方法の準用', url: `https://example.jp/${id}` }));
  entries.push({ id: 'd', kind: 'law', title: '棚卸資産', text: '棚卸資産 原価法 期末', url: 'https://example.jp/d' },
    { id: 'e', kind: 'law', title: '評価方法', text: '評価方法 低価法 在庫', url: 'https://example.jp/e' });
  const c = claim('棚卸資産の評価方法を確認します。', { subject: '棚卸資産の評価方法' }), cat = catalog(entries);
  assert.deepEqual(F.searchEvidence(c, { catalog: cat }).map(e => e.id), ['a', 'd', 'e']);
  const own = F.searchEvidence(c, { catalog: cat, source_url: entries[2].url, source_bundle: 'a;b' });
  assert.deepEqual(own.slice(0, 3).map(e => e.id), ['c', 'a', 'b']);
  assert.ok(own.some(e => e.id === 'd') && own.some(e => e.id === 'e'));
});
test('R2', 'Jaccardの境界0.9で重複を除き、7件を超えない', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, title: '控除額', text: '控除額', kind: 'law', url: `https://example.jp/r${i}` }));
  const cat = catalog(entries), base = ['控除額', ...Array.from({ length: 9 }, (_, i) => `語${i}`)];
  cat.entries[0].tokens = new Set(base);
  cat.entries[1].tokens = new Set(base.slice(0, 9));
  cat.entries[2].tokens = new Set(base.slice(0, 8));
  for (let i = 3; i < entries.length; i++) cat.entries[i].tokens = new Set(['控除額', `別語${i}`]);
  const c = claim('控除額を確認します。', { subject: '控除額' });
  assert.deepEqual(F.searchEvidence(c, { catalog: cat }).map(e => e.id), ['r0', 'r2', 'r3']);
  assert.equal(F.searchEvidence(c, { catalog: cat, source_bundle: entries.map(e => e.id).join(';') }).length, 7);
});

test('R3', '保持数字を差分照合で使い回し、LLMの2範囲はレビュー・監査で表示する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03r-'));
  const opts = { ...options, recordDir: dir, repair: false, searchEvidence: () => [ref(giftSource)],
    callLLM: async req => req.task === 'extract' ? [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => m[2] === giftClaim.sentence)
      .map(m => ({ s: +m[1], type: giftClaim.type, subject: giftClaim.subject, claim: giftClaim.claim }))
      : [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: giftBasis }] };
  try {
    const before = raw(giftClaim.sentence), result = await F.checkArticle(before, opts);
    const next = await F.checkArticle(raw(giftClaim.sentence + '\n案内を追記します。'), { ...opts, previousRaw: before, persist: false });
    assert.equal(next.record.incremental.reused, 1);
    assert.equal(next.record.claims[0].status, '資料なし');
    assert.deepEqual(next.record.claims[0].supported_numbers, ['3年', '100万円']);
    assert.equal(Object.hasOwn(next.record.claims[0], 'basis_added'), false);
    const page = require('../../../netlify/functions/review-page'), audit = require('../../audit-published-facts');
    const quoted = await judge(giftClaim, ref(giftSource), `1,${giftBasis}`);
    assert.equal(quoted.status, '裏付けあり');
    assert.equal(quoted.quote, giftUnits[0].text + '\n…\n' + giftUnits.at(-1).text);
    const finding = { ...quoted, status: '食い違い' };
    const record = { ...result.record, status: 'revise', claims: [finding], remaining: [finding] };
    const html = page.renderReviewPage('2026-10-20-fact-03r.md', { slug: 'fact-03r' }, '<p>本文</p>', 'main', null, record);
    for (const part of F.quoteParts(quoted.quote)) assert.ok(html.includes(part));
    assert.equal((audit.renderReport([record]).match(/根拠の抜粋:/g) || []).length, 2);
    const file = F.recordPath('fact-03r', dir), prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    prior.logic_version = '03o'; fs.writeFileSync(file, JSON.stringify(prior));
    const old = await F.checkArticle(raw(giftClaim.sentence + '\n案内を追記します。'), { ...opts, previousRaw: before, persist: false });
    assert.equal(old.record.incremental, undefined);
    assert.equal(old.record.logic_version, '03u');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const filler = Array(5).fill('中間の説明が続いています'.repeat(15) + '。');
const separated = (first, last) => [first, ...filler, last].join('\n');
for (const [name, c, source, answer] of [
  ['制度名の語が無い', giftClaim, separated('契約の期間は7年以内です。', giftUnits.at(-1).text)],
  ['基準日の行だけの日付', claim('生前贈与加算は令和8年4月1日から100万円までです。', { subject: '生前贈与加算' }),
    separated('[令和8年4月1日現在法令等] 生前贈与加算の説明', '生前贈与加算の金額は100万円です。')],
  ['足し算した2,110万円', claim('配偶者控除と基礎控除110万円の併用で合計2,110万円です。', { subject: '配偶者控除' }),
    separated('配偶者控除は2,000万円までです。', '基礎控除は110万円です。')],
  ['不足する2数が別々の文にある', claim('生前贈与加算は3年超7年以内で100万円、110万円です。', { subject: '生前贈与加算' }),
    ['生前贈与加算は7年以内です。', '生前贈与加算の別の控除は110万円です。', ...filler, '生前贈与加算は3年以内の贈与について100万円です。'].join('\n')],
  ['ある数字が0', giftClaim, separated('生前贈与加算は3年超7年以内で100万円です。', '生前贈与加算の対象の財産について説明します。')],
  ['食い違いは補完しない', giftClaim, giftSource, { status: '食い違い', correct: giftClaim.claim }],
]) test('R3', `${name}: 補完しない`, async () => {
  const basis = String(U.splitUnits(source, { material: true }).at(-1).s);
  const row = await judge(c, ref(source), basis, answer);
  assert.equal(row.status, '資料なし'); assert.equal(row.basis_added, undefined);
  if (name === '食い違いは補完しない' || name === 'ある数字が0') assert.equal(row.supported_numbers, undefined);
});
test('R3', '既に2範囲の答えには足さず、R4の110万円を記録する', async () => {
  const source = ['生前贈与加算は令和6年1月1日から対象です。', ...filler, '贈与の基礎控除は110万円です。',
    ...filler, '基礎控除は年110万円です。'].join('\n');
  const units = U.splitUnits(source, { material: true });
  const c = claim('令和6年1月1日以降の贈与から年110万円の基礎控除が新設されます。', { subject: '生前贈与加算' });
  const row = await judge(c, ref(source), `${units.find(u => u.text.startsWith('贈与の基礎')).s},${units.at(-1).s}`);
  assert.equal(row.status, '資料なし'); assert.equal(row.basis_added, undefined);
  assert.deepEqual(row.supported_numbers, ['110万円']);
});
test('R3', '2か所目の近傍にだけある数字では補完しない', async () => {
  const source = ['生前贈与加算の期間について説明します。', '契約は7年以内です。', ...filler, giftUnits.at(-1).text].join('\n');
  assert.equal((await judge(giftClaim, ref(source), String(U.splitUnits(source, { material: true }).at(-1).s))).status, '資料なし');
});
test('R3', '判定に見せないページ外と別資料は探さない', async () => {
  const source = ['生前贈与加算は7年以内です。', ...Array(40).fill(filler[0]), giftUnits.at(-1).text].join('\n');
  assert.ok(source.length > 6000);
  const excerpt = ref(giftUnits.at(-1).text);
  const row = await judge(giftClaim, excerpt, '1', {}, { loadEvidenceText: () => source });
  assert.equal(row.status, '資料なし');
  const note = ref(giftUnits.at(-1).text), other = ref('生前贈与加算は7年以内です。', '4162');
  const rows = await F.judgeClaims([giftClaim], { c1: [note, other] }, giftClaim.sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options);
  assert.equal(rows[0].status, '資料なし');
});
test('R3', '距離や同距離の並びによらず他の文を追加しない', async () => {
  const source = ['生前贈与加算は7年以内です。', ...filler, giftUnits.at(-1).text, ...filler,
    '生前贈与加算の期間は7年以内となります。'].join('\n');
  const units = U.splitUnits(source, { material: true }), basis = String(units.find(u => u.text.startsWith('（注）')).s);
  const row = await judge(giftClaim, ref(source), basis);
  assert.equal(row.status, '資料なし');
  assert.deepEqual(row.supported_numbers, ['3年', '100万円']);
  assert.equal(Object.hasOwn(row, 'basis_added'), false);
  const nearerSource = ['生前贈与加算は7年以内です。', ...filler, ...filler, giftUnits.at(-1).text, ...filler,
    '生前贈与加算の期間は7年以内となります。'].join('\n');
  const nearerUnits = U.splitUnits(nearerSource, { material: true });
  const nearer = await judge(giftClaim, ref(nearerSource), String(nearerUnits.find(u => u.text.startsWith('（注）')).s));
  assert.equal(nearer.status, '資料なし');
  assert.deepEqual(nearer.supported_numbers, ['3年', '100万円']);
  assert.equal(Object.hasOwn(nearer, 'basis_added'), false);
});
test('R3', '補完後も要約と本文・読めない数字の確かめを省かない', async () => {
  const invented = { ...giftClaim, sentence: giftClaim.sentence.replace('7年', '8年') };
  assert.equal((await judge(invented, ref(giftSource), giftBasis)).status, '資料なし');
  const unreadable = { ...giftClaim, sentence: giftClaim.sentence + '割合は0分の1です。', claim: giftClaim.claim + '割合は0分の1です。' };
  assert.ok(F.normalizedNumbers(unreadable.claim).includes(null));
  assert.equal((await judge(unreadable, ref(giftSource), giftBasis)).status, '資料なし');
  const badSource = '計算式は0分の1です。\n' + giftSource;
  assert.equal((await judge(giftClaim, ref(badSource), String(U.splitUnits(badSource, { material: true }).at(-1).s))).status, '資料なし');
});
test('R3', '補完に頼る多数の答えは棄却数に含めて止める', async () => {
  const claims = Array.from({ length: 3 }, (_, i) => ({ ...giftClaim, id: `c${i + 1}` }));
  const evidence = Object.fromEntries(claims.map(c => [c.id, [ref(giftSource)]]));
  const reply = async () => claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: 1, basis: giftBasis }));
  await assert.rejects(() => F.judgeClaims(claims, evidence, giftClaim.sentence, reply, options), /答えの多くが確認を通りません/);
  await assert.rejects(() => F.judgeClaims(claims.map(c => ({ ...c, subject: '住宅特例' })), evidence, giftClaim.sentence, reply, options), /答えの多くが確認を通りません/);
});

const wedding = claim('結婚・子育て資金は1,000万円（うち結婚費用300万円）まで非課税です。', { subject: '結婚子育て資金' });
const weddingRef = ref('結婚・子育て資金は1,000万円まで非課税です。', '4511');
const replacement = '結婚・子育て資金は1,000万円まで非課税です（結婚費用の上限は国税庁の案内で確認）。';
test('R4', '一部だけ裏付けのある数字を元の表記で記録する', async () => {
  const row = await judge(wedding, weddingRef, '1');
  assert.equal(row.status, '資料なし'); assert.deepEqual(row.supported_numbers, ['1,000万円']);
  assert.deepEqual(row.rejected_answer, { status: '裏付けあり', evidence: weddingRef.id, basis: '1', quote: weddingRef.text });
  const fullwidth = { ...wedding, claim: wedding.claim.replace('1,000万円', '１，０００万円'), sentence: wedding.sentence.replace('1,000万円', '１，０００万円') };
  assert.deepEqual((await judge(fullwidth, weddingRef, '1')).supported_numbers, ['１，０００万円']);
  const noSummaryNumbers = { ...wedding, claim: '結婚・子育て資金には非課税枠があります。' };
  assert.deepEqual((await judge(noSummaryNumbers, weddingRef, '1')).supported_numbers, ['1,000万円']);
});
for (const [name, revised, reason] of [
  ['裏付けのある1,000万円を残す', replacement, undefined],
  ['1,000万円を消す', '結婚・子育て資金の限度額は国税庁の案内で確認してください。', '裏付けのある数字を消しています'],
  ['300万円を残す', '結婚・子育て資金は1,000万円まで非課税で結婚費用は300万円までです。', '資料の無い数字が残っています'],
]) test('R4', name, async () => {
  const row = await judge(wedding, weddingRef, '1');
  const result = await F.repairBody(wedding.sentence, [row], async req => {
    const c = JSON.parse(req.user).corrections[0];
    assert.deepEqual(c.keep_numbers, ['1,000万円']);
    assert.ok(c.instruction.endsWith('。keep_numbers の数字は表記どおり残し、それ以外の資料の無い数字だけを外す'));
    return [{ id: 'c1', replacement: revised }];
  });
  assert.equal(result.rejected.get('c1'), reason);
  assert.equal(result.body, reason ? wedding.sentence : revised);
});
test('R4', 'supported_numbersが無い修正リクエストは変更前とバイト単位で同じ', async () => {
  const c = claim('控除は120万円です。', { status: '資料なし' });
  await F.repairBody(c.sentence, [c], async req => {
    assert.equal(createHash('sha256').update(JSON.stringify(req)).digest('hex'), '27e026363ec74bd8c786cf8b11ffe0ec0ba06ac5c6b66877edaa2fdee37e37ea');
    assert.equal(Object.hasOwn(JSON.parse(req.user).corrections[0], 'keep_numbers'), false);
    return [];
  });
});
test('R4', '抜き出しと判定のリクエストは03uの指示文とバイト単位で一致', async () => {
  const c = claim('控除は120万円です。');
  const e = ref(c.sentence, '2080', { id: 'e1', title: '試験資料', url: 'https://example.jp/e1' });
  await F.extractClaims(c.sentence, async req => {
    assert.equal(createHash('sha256').update(JSON.stringify(req)).digest('hex'), '065ba2b29ab57ba7cac871a439bc1ce54cc536b7352a1625494c54d5c32180ec');
    return [];
  }, options);
  await F.judgeClaims([c], { c1: [e] }, c.sentence, async req => {
    assert.equal(createHash('sha256').update(JSON.stringify(req)).digest('hex'), 'fd8b916f42c8c6d06548109f5b9f472c6bf833b4b15a8fba7c5a7579072eefc9');
    return [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }];
  }, options);
});
test('R4', '残した数字は再照合し、裏付けが無ければ止める', async () => {
  for (const recheckStatus of ['裏付けあり', '資料なし']) {
    let extracts = 0;
    const result = await F.checkFacts(wedding.sentence, { ...options, searchEvidence: () => [weddingRef], callLLM: async req => {
      if (req.task === 'extract') {
        extracts++;
        const line = [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)][0];
        return [{ s: +line[1], type: wedding.type, subject: wedding.subject, claim: line[2] }];
      }
      if (req.task === 'repair') {
        assert.deepEqual(JSON.parse(req.user).corrections[0].keep_numbers, ['1,000万円']);
        return [{ id: 'c1', replacement }];
      }
      return [{ id: 'c1', status: extracts === 1 ? '裏付けあり' : recheckStatus, evidence_id: 1, basis: '1' }];
    } });
    assert.equal(extracts, 2); assert.equal(result.body, replacement);
    assert.equal(result.record.rechecked.length, 1);
    assert.equal(result.record.rechecked[0].status, recheckStatus);
    assert.equal(result.record.status, recheckStatus === '裏付けあり' ? 'ok' : 'revise');
  }
});

const books = '決算に関して作成した棚卸表その他の書類は5年間保存します。';
for (const citation of ['タックスアンサーNo.2080', 'No 2080', 'No.　2080', 'タックスアンサー2080', 'タックスアンサー No.2080', 'TA2080', 'Ｎｏ．２０８０']) {
  test('R5', `${citation}は根拠自身の番号だけ除く`, async () => {
    const c = claim(`${citation}で棚卸表等決算書類は5年間保存します。`, { subject: '帳簿保存', type: '期限' });
    assert.equal((await judge(c, ref(books, '2080'), '1')).status, '裏付けあり');
    assert.equal((await judge(c, ref(books, '2081'), '1')).status, '資料なし');
  });
}
test('R5', 'No.4408の110万円と、番号を除くと数字が無いO5の主張', async () => {
  const gift = '1年間の贈与額合計から基礎控除110万円を引き税率をかけます。';
  assert.equal((await judge(claim(gift + '（No.4408）', { subject: '基礎控除' }), ref(gift, '4408'), '1')).status, '裏付けあり');
  const c = claim('棚卸表その他の決算書類には保存期間が定められています（No.2080）。', { type: '期限' });
  assert.equal((await judge(c, ref(books, '2080'), '1')).status, '裏付けあり');
  assert.equal((await judge(c, ref('書類', '2080'), '1')).status, '資料なし');
});
test('R5', '本文フォールバック・correct・範囲を絞る救済にも同じ番号の除外を掛ける', async () => {
  const c = claim('棚卸表等決算書類は5年間保存します（No.2080）。', { type: '期限' });
  assert.equal((await judge({ ...c, claim: '棚卸表等の書類は保存が必要です。' }, ref(books, '2080'), '1')).status, '裏付けあり');
  assert.equal((await judge(c, ref(books, '2080'), '1', { status: '食い違い', correct: c.claim })).status, '食い違い');
  const source = books + '\n保存場所の説明です。\nその他の説明です。';
  assert.equal((await judge(c, ref(source, '2080'), '1-3')).status, '裏付けあり');
  const noNumber = { ...c, claim: '書類の保存期間は定められています（No.2080）。', sentence: '書類の保存期間は定められています（No.2080）。' };
  assert.equal((await judge(noNumber, ref(source, '2080'), '1-3')).status, '裏付けあり');
});
test('R5', 'R4の保持数字でも根拠自身の番号だけを除く', async () => {
  const c = { ...giftClaim, claim: giftClaim.claim + '（No.4161）', sentence: giftClaim.sentence + '（No.4161）' };
  const gift = await judge(c, ref(giftSource), giftBasis);
  assert.equal(gift.status, '資料なし');
  assert.deepEqual(gift.supported_numbers, ['3年', '100万円']);
  assert.equal(Object.hasOwn(gift, 'basis_added'), false);
  const w = { ...wedding, claim: wedding.claim + '（No.4511）', sentence: wedding.sentence + '（No.4511）' };
  const row = await judge(w, weddingRef, '1');
  assert.deepEqual(row.supported_numbers, ['1,000万円']);
});
test('R5', '別番号・番号の主張・法令資料・5桁の番号は除外しない', async () => {
  const c = claim('書類はNo.2080で5年間保存します。', { type: '期限' });
  assert.equal((await judge(c, ref(books, '2080', { kind: 'law' }), '1')).status, '資料なし');
  assert.equal((await judge({ ...c, type: '番号' }, ref('短', '2080'), '1')).status, '資料なし');
  assert.equal((await judge({ ...c, claim: c.claim.replace('2080', '20801'), sentence: c.sentence.replace('2080', '20801') }, ref(books, '2080'), '1')).status, '資料なし');
});
test('版', 'LOGIC_VERSIONは03u', async () => {
  const result = await F.checkFacts('案内です。', { ...options, callLLM: async () => [], repair: false });
  assert.equal(result.record.logic_version, '03u');
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
