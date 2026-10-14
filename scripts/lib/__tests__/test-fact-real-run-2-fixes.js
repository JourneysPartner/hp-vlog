'use strict';

// 03f の回帰確認。実際のLLM・ネットワークは使わず、K2だけ取り込み済みの実データを読む。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const { F, readPayload, bodyText } = require('./fact-pages-test-helpers');
const E = require('../fact-evidence');
const groups = {};
let pass = 0, fail = 0;
const now = new Date('2026-10-12T00:00:00Z');
const claim = (sentence, type = '金額', subject = '制度', id = 'c1') => ({ id, sentence, claim: sentence, heading: '制度', type, subject });
const ref = (text, id = '資料1', extra = {}) => ({ id, title: '制度の原文', url: `https://example.jp/${id}`, law_version: '', text, ...extra });
const options = extra => ({ enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', now, persist: false, ...extra });
const raw = body => `---\nslug: real-run-2-test\nrecommendation: publish\n---\n${body}`;
const missing = request => readPayload(request).claims.map(c => ({ id: c.id, status: '資料なし' }));
const supported = request => readPayload(request).claims.map(c => ({ id: c.id, status: '裏付けあり', quote: c.sentence, evidence_id: '資料1' }));
async function test(group, name, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); pass++; groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
async function judge(c, refs, result) {
  return (await F.judgeClaims([c], { [c.id]: refs }, c.sentence, async () => [{ id: c.id, ...result }], { now }))[0];
}

async function main() {
  const amount = claim('非課税枠は1,000万円（うち結婚費用300万円）です。');
  const quote = '結婚・子育て資金の非課税枠は1,000万円です。';
  const other = '結婚費用については300万円までです。';
  await test('K1', '別々の原文の文に数字があれば、引用1文に全数字を求めない', async () => {
    assert.equal((await judge(amount, [ref(`${quote}\n${other}`)], { status: '裏付けあり', quote, evidence_id: '資料1' })).status, '裏付けあり');
  });
  for (const text of [quote, other]) await test('K1', `採用した原文に一方の数字が無ければ資料なし: ${text}`, async () => {
    assert.equal((await judge(amount, [ref(text)], { status: '裏付けあり', quote: text, evidence_id: '資料1' })).status, '資料なし');
  });
  await test('K1', '他の候補の数字は採用した原文の不足を埋めない', async () => {
    assert.equal((await judge(amount, [ref(quote), ref(other, '資料2')], { status: '裏付けあり', quote, evidence_id: '資料1' })).status, '資料なし');
  });
  for (const badQuote of ['原文に無い捏造した制度の説明です。', '1,000万円']) await test('K1', `実在しない引用・短い断片を資料なしにする: ${badQuote}`, async () => {
    assert.equal((await judge(amount, [ref(`${quote}\n${other}`)], { status: '裏付けあり', quote: badQuote, evidence_id: '資料1' })).status, '資料なし');
  });
  await test('K1', '短くても原文の1文全体なら従来どおり通る', async () => {
    assert.equal((await judge(amount, [ref(`対象です。\n${quote}\n${other}`)], { status: '裏付けあり', quote: '対象です。', evidence_id: '資料1' })).status, '裏付けあり');
  });
  for (const status of ['食い違い', '期限の書き漏れ']) await test('K1', `${status}のcorrectの数字も採用した原文全体で確認する`, async () => {
    const result = { status, quote, correct: amount.sentence, evidence_id: '資料1' };
    assert.equal((await judge(claim('非課税枠は900万円です。'), [ref(`${quote}\n${other}`)], result)).status, status);
    assert.equal((await judge(claim('非課税枠は900万円です。'), [ref(quote)], result)).status, '資料なし');
  });

  const primary = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm';
  const article = { tax_domain: 'inheritance_tax', source_url: primary,
    source_supplements: ['4510', '4511', '4405'].map(no => `https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/${no}.htm`) };
  for (const [subject, sentence, no] of [
    ['贈与税の配偶者控除', '配偶者控除は最大2,000万円です。', '4452'],
    ['結婚・子育て資金の一括贈与', amount.sentence, '4511'],
    ['生前贈与加算', '相続開始前7年以内の贈与を加算し、延長4年分は100万円まで加算しません。', '4161'],
  ]) await test('K2', `実データで${subject}の説明資料TA ${no}を候補に入れる`, () => {
    const refs = E.searchEvidence(claim(sentence, '金額', subject), article);
    assert.equal(refs[0].id, primary); assert.ok(refs.some(e => e.no === no && e.kind === 'taxanswer'));
    assert.ok(refs.length <= 7); assert.equal(new Set(refs.map(e => e.id)).size, refs.length);
    assert.ok(refs.every(e => e.text.length <= 2000));
    console.log('K2 実データの候補:', JSON.stringify({ subject, refs: refs.map(({ id, title, no }) => ({ id, title, no })) }));
  });
  await test('K2', '記事資料3件→制度名1件→主張全体3件の並びを保つ', () => {
    const c = claim('配偶者控除は最大2,000万円です。', '金額', '贈与税の配偶者控除');
    const refs = E.searchEvidence(c, article);
    assert.equal(refs.length, 7); assert.equal(refs[3].no, '4452');
    assert.ok(refs.slice(0, 3).every(e => [primary, ...article.source_supplements].includes(e.url)));
    const ranked = E.searchEvidence(c, { tax_domain: article.tax_domain });
    for (const e of ranked.filter(e => e.no !== '4452').slice(0, 3)) assert.ok(refs.some(r => r.id === e.id));
  });

  await test('K3', '10主張が共有する主出典は判定入力に1回だけ載せる', async () => {
    const text = '同じ主出典の本文を重ねず送ります。';
    const claims = Array.from({ length: 10 }, (_, i) => claim(`控除額は${i + 1}万円です。`, '金額', '制度', `c${i + 1}`));
    const evidence = Object.fromEntries(claims.map(c => [c.id, [ref(text)]]));
    await F.judgeClaims(claims, evidence, '', async request => {
      const payload = readPayload(request);
      assert.equal(payload.evidence.length, 1); assert.equal(request.system.split(text).length - 1, 1);
      assert.equal(payload.claims.length, 10);
      for (const c of payload.claims) { assert.deepEqual(c.evidence_ids, [1]); assert.equal(c.evidence, undefined); }
      assert.equal(JSON.parse(request.user).evidence, undefined);
      assert.match(request.system, /evidence の中の、各主張の evidence_ids の資料だけ/);
      return missing(request);
    }, { now });
  });
  await test('K3', '重なった原文範囲を合わせ、元の候補IDの合わせた範囲で引用を確認', async () => {
    const text = '前半の説明です。'.repeat(120) + amount.sentence + '後半の説明です。'.repeat(200);
    const claims = [claim(amount.sentence), claim(amount.sentence, '金額', '別制度', 'c2')];
    const refs = { c1: [ref(text.slice(0, 1500), '資料1', { text_start: 0 })], c2: [ref(text.slice(1000, 3000), '資料1', { text_start: 1000 })] };
    const result = await F.judgeClaims(claims, refs, amount.sentence, async request => {
      assert.equal(F.normalizedQuote(readPayload(request).evidence[0].text), F.normalizedQuote(text.slice(0, 3000)));
      return supported(request);
    }, { now });
    assert.ok(result.every(c => c.status === '裏付けあり'));
  });
  // 03g M2: 数字は引用と同じ抜粋の部分（前後 300 字）に限る。別々の抜粋に分かれた数字は合わせない
  // （隣り合う文に分かれた正しい場合は test-fact-number-guard.js で裏付けありを確かめている）。
  await test('K3', '離れた抜粋の数字は合わせず、境界をまたぐ架空の引用も通さない', async () => {
    const claims = [amount, claim(amount.sentence, '金額', '別制度', 'c2')];
    const refs = { c1: [ref(quote)], c2: [ref(other)] };
    const result = await F.judgeClaims(claims, refs, '', async () => claims.map(c => ({ id: c.id, status: '裏付けあり', quote, evidence_id: '資料1' })), { now });
    assert.ok(result.every(c => c.status === '資料なし'));
    const invalid = await F.judgeClaims(claims, refs, '', async () => claims.map(c => ({ id: c.id, status: '裏付けあり', quote: quote + other, evidence_id: '資料1' })), { now });
    assert.ok(invalid.every(c => c.status === '資料なし'));
    const compact = F.compactRecord({ claims: result });
    assert.deepEqual(F.evidenceRefs(compact, compact.claims[0])[0].text_ranges, result[0].evidence[0].text_ranges);
  });
  await test('K3', '6000文字以下の原文は全文を載せ、末尾の根拠も使える', async () => {
    const claims = [amount, claim(amount.sentence, '金額', '別制度', 'c2'), claim(amount.sentence, '金額', '他制度', 'c3')];
    const text = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, '0')}説明`).join('').slice(0, 5500) + amount.sentence;
    const refs = Object.fromEntries(claims.map((c, i) => [c.id, [ref(text.slice(i * 2000, i * 2000 + 2000), '資料1', { text_start: i * 2000 })]]));
    const result = await F.judgeClaims(claims, refs, amount.sentence, async request => {
      assert.equal(F.normalizedQuote(readPayload(request).evidence[0].text), F.normalizedQuote(text));
      return supported(request);
    }, { now });
    assert.ok(result.every(c => c.status === '裏付けあり'));
  });
  await test('K3', '同じバッチでも他主張だけの候補IDは採用できない', async () => {
    const claims = [amount, claim(amount.sentence, '金額', '別制度', 'c2')];
    const result = await F.judgeClaims(claims, { c1: [ref('別の説明です。')], c2: [ref(`${quote}\n${other}`, '資料2')] }, '', async () =>
      claims.map(c => ({ id: c.id, status: '裏付けあり', quote, evidence_id: '資料2' })), { now });
    assert.equal(result[0].status, '資料なし'); assert.equal(result[1].status, '裏付けあり');
  });
  await test('K3', '離れた抜粋の数字の断片をつなぎ、原文に無い金額を作らない', async () => {
    const claims = [claim('控除額は1,000万円です。'), claim('控除額は1,000万円です。', '金額', '別制度', 'c2')];
    const quote = '制度の金額に関する原文の説明です。';
    const result = await F.judgeClaims(claims, { c1: [ref(quote + '上限は1,')], c2: [ref('000万円です。')] }, '', async () =>
      claims.map(c => ({ id: c.id, status: '裏付けあり', quote, evidence_id: '資料1' })), { now });
    assert.ok(result.every(c => c.status === '資料なし'));
  });
  await test('K3', '#644相当の79主張・共通7資料で03eの入力文字数の半分以下', async () => {
    const claims = Array.from({ length: 79 }, (_, i) => claim(`非課税枠は${i + 1}万円です。`, '金額', '制度', `c${i + 1}`));
    const shared = Array.from({ length: 7 }, (_, i) => ref(`資料${i + 1}の原文。` + '共通の制度の説明。'.repeat(230), `資料${i + 1}`)).map(e => ({ ...e, text: e.text.slice(0, 2000) }));
    const evidence = Object.fromEntries(claims.map(c => [c.id, shared]));
    const body = claims.map(c => c.sentence).join('\n');
    let current = 0, previous = 0, calls = 0;
    await F.judgeClaims(claims, evidence, body, async request => {
      calls++;
      const payload = readPayload(request);
      current += request.system.length + request.user.length;
      const oldSystem = request.system.replace('evidence の中の、各主張の evidence_ids の資料だけを根拠にしてください。', '');
      const oldClaims = payload.claims.map(c => ({ ...claims.find(row => row.id === c.id), evidence: shared }));
      previous += oldSystem.length + JSON.stringify({ today: payload.today, body, claims: oldClaims }).length;
      return missing(request);
    }, { now });
    assert.equal(calls, 1); assert.ok(current <= previous / 2);
    console.log('K3 判定の入力文字数:', JSON.stringify({ claims: 79, calls, before_03e: previous, after_03f: current, ratio: current / previous }));
  });

  await test('K4', '数字60件は全件、要件50件は40件を照合し残り10件を一覧へ', async () => {
    const numbers = Array.from({ length: 60 }, (_, i) => claim(`控除額${i + 1}は100万円です。`));
    const requirements = Array.from({ length: 50 }, (_, i) => claim(`要件${i + 1}は個別の事情によります。`, '要件'));
    const items = [...requirements, ...numbers], body = items.map(c => c.sentence).join('\n');
    const result = await F.checkArticle(raw(body), options({ repair: false, searchEvidence: () => [ref(body)],
      callLLM: async request => request.task === 'extract' ? items : supported(request) }));
    assert.equal(result.record.claims.filter(c => c.type === '金額').length, 60);
    assert.equal(result.record.claims.filter(c => c.type === '要件').length, 40);
    assert.equal(result.record.dropped, 10); assert.equal(result.record.review_items.length, 10);
    assert.ok(result.record.review_items.every(c => c.type === '要件' && c.status === '上限で未照合'));
    assert.equal(result.record.status, 'ok'); assert.equal(matter(result.content).data.fact_check_blocking, false);
  });
  await test('K4', '数字121件は120件まで照合し、未照合1件で差し止める', async () => {
    const items = Array.from({ length: 121 }, (_, i) => claim(`控除額${i + 1}は100万円です。`)), body = items.map(c => c.sentence).join('\n');
    const result = await F.checkArticle(raw(body), options({ repair: false, searchEvidence: () => [ref(body)],
      callLLM: async request => request.task === 'extract' ? items : supported(request) }));
    assert.equal(result.record.claims.length, 120); assert.equal(result.record.dropped, 1);
    assert.equal(result.record.status, 'revise'); assert.equal(matter(result.content).data.fact_check_blocking, true);
  });
  await test('K4', '数字上限の既定・環境変数・明示設定を確認する', () => {
    const old = process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS;
    try {
      delete process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS; assert.equal(F.config().maxNumericClaims, 120);
      process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS = '2'; assert.equal(F.config().maxNumericClaims, 2);
      assert.equal(F.config({ maxNumericClaims: 3 }).maxNumericClaims, 3);
      process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS = '0'; assert.equal(F.config().maxNumericClaims, 120);
    } finally { if (old === undefined) delete process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS; else process.env.FACT_CHECK_MAX_NUMERIC_CLAIMS = old; }
  });

  for (const type of ['期限', '金額', '割合', '適用年', '番号']) await test('K5', `数字のない${type}の資料なしは本文を保持し一覧に残す`, async () => {
    const body = '保存期間は国税庁のタックスアンサーで確認してください。';
    const result = await F.checkArticle(raw(body), options({ searchEvidence: () => [], callLLM: async request => {
      assert.equal(request.task, 'extract'); return [claim(body, type)];
    } }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.body, body); assert.equal(result.record.review_items.length, 1);
    assert.equal(result.record.corrections.length, 0); assert.equal(matter(result.content).data.fact_check_blocking, false);
  });
  for (const [sentence, type] of [['5年間保存します。', '期限'], ['五年間保存します。', '期限'], ['令和九年三月三十一日が期限です。', '期限'],
    ['No.五を確認します。', '番号'], ['第三条を確認します。', '番号'], ['三条を確認します。', '番号'], ['四-二を確認します。', '番号'], ['割合は2分の一定です。', '割合']])
    await test('K5', `数字・日付・番号・読めない分数は引き続き止める: ${sentence}`, async () => {
      const result = await F.checkFacts(sentence, options({ repair: false, searchEvidence: () => [], callLLM: async () => [claim(sentence, type)] }));
      assert.equal(result.record.status, 'revise'); assert.equal(result.record.remaining.length, 1);
    });
  await test('K5', '案内に置き換えた文が再び期限として抽出されても止まり続けない', async () => {
    const before = '棚卸表は5年間保存します。', after = '保存期間は国税庁のタックスアンサーで確認してください。';
    const result = await F.checkFacts(before, options({ searchEvidence: () => [ref('別の制度の説明です。')], callLLM: async request => {
      if (request.task === 'extract') return [claim(request.user.includes(before) ? before : after, '期限')];
      if (request.task === 'judge') return missing(request);
      return after;
    } }));
    assert.equal(result.body, after); assert.equal(result.record.status, 'ok'); assert.equal(result.record.corrections[0].resolved, true);
    assert.equal(result.record.review_items[0].type, '期限');
  });
  await test('K5', '数字のない文でも食い違い・期限の書き漏れは種類を問わず止める', async () => {
    const sentence = '制度はいつでも適用できます。', deadline = '制度の適用期限は令和9年3月31日です。';
    for (const status of ['食い違い', '期限の書き漏れ']) {
      const result = await F.checkFacts(sentence, options({ repair: false, searchEvidence: () => [ref(deadline)], callLLM: async request =>
        request.task === 'extract' ? [claim(sentence, '期限')] : [{ id: 'c1', status, quote: deadline, correct: deadline, evidence_id: '資料1' }] }));
      assert.equal(result.record.status, 'revise'); assert.equal(result.record.remaining[0].status, status);
    }
  });

  const wrong = '配偶者控除は翌年以降に居住する見込みがあれば適用できます。';
  const correct = '贈与を受けた年の翌年3月15日までに居住し、その後も引き続き住む見込みであることが必要です。';
  const correctionSource = ref(correct, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4452.htm');
  for (const changedSubject of [false, true]) await test('K6', `再検索から落ちたTA4452を${changedSubject ? '前後の文の対' : '同じsubject'}で引き継ぎ解決する`, async () => {
    const body = `${wrong}\nその他の説明をそのまま残します。`;
    const result = await F.checkFacts(body, options({ searchEvidence: c => c.sentence === wrong ? [ref('住宅取得の説明です。', primary), correctionSource]
      : [ref('住宅取得の説明です。', primary), ...Array.from({ length: 6 }, (_, i) => ref('別の制度の説明です。', `候補${i}`))], callLLM: async request => {
      if (request.task === 'extract') return [claim(request.user.includes(wrong) ? wrong : correct, '要件', changedSubject && !request.user.includes(wrong) ? '居住要件' : '贈与税の配偶者控除')];
      if (request.task === 'repair') return body.replace(wrong, correct);
      const c = readPayload(request).claims[0];
      assert.ok(c.evidence_ids.some(id => readPayload(request).evidence.find(e => e.id === id)?.url === correctionSource.url));
      assert.equal(readPayload(request).evidence.find(e => e.id === c.evidence_ids[0]).url, ref('', primary).url); assert.ok(c.evidence_ids.length <= 7);
      return [{ id: c.id, status: c.sentence === wrong ? '食い違い' : '裏付けあり', quote: correct, correct, evidence_id: correctionSource.id }];
    } }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.corrections[0].resolved, true);
    assert.equal(result.record.rechecked[0].evidence_id, correctionSource.id);
  });
  await test('K6', '同じIDの再検索結果で修正の根拠の抜粋を上書きしない', async () => {
    const result = await F.checkFacts(wrong, options({ searchEvidence: c => [c.sentence === wrong ? correctionSource : { ...correctionSource, text: '関係しない原文の別の範囲です。' }],
      callLLM: async request => {
        if (request.task === 'extract') return [claim(request.user.includes(wrong) ? wrong : correct, '要件')];
        if (request.task === 'repair') return correct;
        assert.ok(readPayload(request).evidence[0].text.includes(correct));
        return [{ id: 'c1', status: request.user.includes(wrong) ? '食い違い' : '裏付けあり', quote: correct, correct, evidence_id: correctionSource.id }];
      } }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.corrections[0].resolved, true);
  });
  await test('K6', '引き継いだ資料があっても再照合の裏付けが無ければ未解決', async () => {
    const result = await F.checkFacts(wrong, options({ searchEvidence: c => c.sentence === wrong ? [correctionSource] : [], callLLM: async request => {
      if (request.task === 'extract') return [claim(request.user.includes(wrong) ? wrong : correct, '要件')];
      if (request.task === 'repair') return correct;
      return request.user.includes(wrong) ? [{ id: 'c1', status: '食い違い', quote: correct, correct, evidence_id: correctionSource.id }] : missing(request);
    } }));
    assert.equal(result.record.status, 'revise'); assert.equal(result.record.corrections[0].resolved, false);
  });

  await test('K7', '抽出・判定・修正・再照合の入力合計を記録し保存後も保持する', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-real-run-2-'));
    try {
      const result = await F.checkArticle(raw(wrong), options({ persist: true, recordDir: dir, searchEvidence: () => [correctionSource], callLLM: async request => {
        if (request.task === 'extract') return [claim(request.user.includes(wrong) ? wrong : correct, '要件')];
        if (request.task === 'repair') return correct;
        return [{ id: 'c1', status: request.user.includes(wrong) ? '食い違い' : '裏付けあり', quote: correct, correct, evidence_id: correctionSource.id }];
      } }));
      assert.deepEqual(result.record.calls.map(c => c.task), ['extract', 'judge', 'repair', 'recheck_extract', 'recheck_judge']);
      assert.equal(result.record.input_chars_total, result.record.calls.reduce((sum, c) => sum + c.input_chars, 0));
      assert.equal(JSON.parse(fs.readFileSync(result.recordFile, 'utf8')).input_chars_total, result.record.input_chars_total);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('K7', '障害が起きた呼び出しも合計に含め、未実施をfail-closedで止める', async () => {
    const result = await F.checkArticle(raw('制度の説明です。'), options({ callLLM: async () => { throw new Error('偽の障害'); } }));
    assert.equal(result.record.input_chars_total, result.record.calls[0].input_chars);
    assert.equal(result.record.status, 'not_run'); assert.equal(result.record.error, 'Error');
    assert.equal(matter(result.content).data.fact_check_blocking, true);
    assert.equal((await F.checkFacts('本文', options({ enabled: false }))).record.input_chars_total, 0);
  });
  await test('K7', '生成処理の照合ログ1行に入力文字数を出す', async () => {
    const generate = require('../../generate-draft');
    const lines = [], log = console.log;
    try {
      console.log = (...args) => lines.push(args.join(' '));
      await generate.runFactCheckForArticle(raw('制度の説明です。'), { persist: false,
        factCheck: async content => ({ content, record: { status: 'ok', summary: '偽の照合', input_chars_total: 12345 } }) });
    } finally { console.log = log; }
    assert.ok(lines.some(line => /^\[fact-check\].*入力 12345 字$/.test(line)));
  });
  console.log(`\n実AI2回目の修正: PASS ${pass} / FAIL ${fail}`);
  console.log('K別集計:', JSON.stringify(groups));
  process.exitCode = fail ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
