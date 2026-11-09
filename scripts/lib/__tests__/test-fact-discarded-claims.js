'use strict';

// 偽の AI と資料だけで、捨てた主張の記録・表示と承認判断の維持を確かめる。
const assert = require('assert/strict');
const matter = require('gray-matter');
const F = require('../fact-check');
const H = require('./fact-pages-test-helpers');
const page = require('../../../netlify/functions/review-page');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const opts = { now: new Date('2026-11-05T00:00:00Z'), provider: 'anthropic', model: 'claude-opus-5-5',
  enabled: true, batch: false, repair: false, writer_materials: [], searchEvidence: () => [], loadEvidenceText: e => e.text };
const original = '控除は55万円です。';
const missing = '控除は最高65万円になります。';
const raw = (extra = {}) => ({ s: 1, type: '金額', subject: '控除', claim: missing, ...extra });
const source = text => ({ id: 'discarded-test', kind: 'taxanswer', title: '試験制度', url: 'https://example.invalid/discarded', text });
const supported = req => H.readPayload(req).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: c.evidence_ids[0], basis: '1' }));

function invariant(record) {
  assert.ok(['ok', 'revise'].includes(record.status), record.error || record.summary);
  assert.equal(record.discarded_claims.length, record.discarded);
  const before = JSON.stringify(record);
  assert.deepEqual(JSON.parse(JSON.stringify(F.compactRecord(record))).discarded_claims, record.discarded_claims);
  assert.equal(JSON.stringify(record), before, '記録の圧縮で元の一覧を変えない');
  assert.ok(record.review_items.every(c => !Object.hasOwn(c, 'pointed_sentence') || c.status === '照合で文を特定できなかった'));
}

async function check(body, rows, extra = {}) {
  const result = await F.checkFacts(body, { ...opts, callLLM: async req => {
    assert.equal(req.task, 'extract', '指定のない AI 呼び出しを行わない');
    return rows;
  }, ...extra });
  invariant(result.record);
  return result;
}

const longBody = original + '\n' + '制度の説明を確認します。'.repeat(50).slice(0, 446 - original.length - 1);
test('段階3 F1: 446字の本文で数字の主張を全部捨てたら未実施で止める', async () => {
  assert.equal(longBody.length, 446);
  const result = await F.checkFacts(longBody, { ...opts, callLLM: async req => {
    assert.equal(req.task, 'extract');
    return Array.from({ length: 12 }, (_, i) => raw({ claim: `控除は${65 + i}万円です。` }));
  } });
  assert.equal(result.record.status, 'not_run'); assert.equal(result.record.summary, '主張を抜き出せませんでした');
  assert.equal(result.record.discarded, 12); assert.ok(result.record.discarded_claims.every(c => c.blocks_approval === false));
  const meta = matter(F.applyFactResult('---\nrecommendation: publish\n---\n' + longBody, result)).data;
  assert.equal(meta.fact_check_status, 'not_run'); assert.equal(meta.fact_check_blocking, true);
});
test('段階3 F1: 長文でも正しい主張が1件あれば捨てた分では止めない', async () => {
  const { record } = await check(longBody, [], { searchEvidence: () => [source(original)],
    callLLM: async req => req.task === 'extract' ? [raw({ claim: original }), raw()] : supported(req) });
  assert.equal(record.status, 'ok'); assert.equal(record.claims.length, 1); assert.equal(record.discarded, 1);
  assert.equal(record.discarded_claims[0].blocks_approval, false);
  assert.equal(record.review_items[0].status, '照合で文を特定できなかった');
});
for (const length of [199, 200]) test(`段階3 F1: 見出しを除いた本文の長さで未実施を判断する (${length})`, async () => {
  const body = '## ' + '見出し'.repeat(100) + '\n' + '説明'.repeat(100).slice(0, length);
  const result = await F.checkFacts(body, { ...opts, callLLM: async () => [raw()] });
  assert.equal(result.record.status, length < 200 ? 'ok' : 'not_run');
});

test('R1: 本文に見つからない主張の元の欄を維持し、指した文を足す', async () => {
  const result = await F.extractClaims('## 制度\n' + original, async () => [raw({ s: 2 })]);
  assert.deepEqual(result.discardedClaims, [{ sentence: missing, heading: '', type: '金額', subject: '控除',
    claim: missing, s: 2, status: '本文に見つからない', pointed_sentence: original }]);
});

test('F2: 文字列・角括弧・全角の番号にも指した文を残し、元の s の扱いは変えない', async () => {
  for (const s of ['1', '[1]', '１']) {
    const result = await F.extractClaims(original, async () => [raw({ s })]);
    assert.equal(result.discarded, 1);
    assert.deepEqual(result.discardedClaims, [{ sentence: missing, heading: '', type: '金額', subject: '控除',
      claim: missing, status: '本文に見つからない', pointed_sentence: original }], s);
  }
});

test('R1/F2: 読めない番号・範囲外・番号なしには指した文を作らない', async () => {
  for (const s of [0, -1, 2, 1.5, 'a', null, undefined]) {
    const result = await F.extractClaims(original, async () => [raw({ s })]);
    assert.equal(result.discarded, 1);
    assert.equal(Object.hasOwn(result.discardedClaims[0], 'pointed_sentence'), false, String(s));
    assert.equal(result.discardedClaims[0].sentence, missing);
    assert.equal(Object.hasOwn(result.discardedClaims[0], 's'), Number.isInteger(s));
  }
});

test('R1: 見出しを指した文もそのまま残す', async () => {
  const result = await F.extractClaims('## 制度\n' + original, async () => [raw()]);
  assert.equal(result.discardedClaims[0].pointed_sentence, '## 制度');
  assert.equal(result.discardedClaims[0].sentence, missing);
});

test('R1: 形式不正にも指した文を残し、読み替えた種類の元の名前を維持', async () => {
  const result = await F.extractClaims(original, async () => [raw({ type: ' 条件 ', subject: '', claim: original })]);
  assert.deepEqual(result.discardedClaims, [{ sentence: original, heading: '', type: '要件', subject: '',
    claim: original, type_label: ' 条件 ', s: 1, status: '主張の形式が不正', pointed_sentence: original }]);
});

test('R1: 採用した主張と件数の上限で落とした主張には新しい欄を足さない', async () => {
  const body = original + '\n控除は65万円です。';
  const result = await F.extractClaims(body, async () => [raw({ claim: original }), raw({ s: 2, claim: '控除は65万円です。' })], { maxNumericClaims: 1 });
  assert.equal(result.claims.length, 1);
  assert.equal(result.droppedClaims.length, 1);
  assert.deepEqual(result.discardedClaims, []);
  assert.ok([...result.claims, ...result.droppedClaims].every(c => !Object.hasOwn(c, 'pointed_sentence')));
});

test('R8: 最初に捨てた金額の主張は承認を止めず、人の確認に回す', async () => {
  const { body, record } = await check(original, [raw()]);
  assert.equal(body, original);
  assert.equal(record.status, 'ok');
  assert.equal(record.discarded, 1);
  assert.deepEqual(record.remaining, []);
  assert.equal(record.review_items.length, 1);
  assert.equal(record.review_items[0].status, '照合で文を特定できなかった');
  assert.equal(record.review_items[0].pointed_sentence, original);
  assert.deepEqual(record.discarded_claims, [{ sentence: missing, heading: '', type: '金額', subject: '控除', claim: missing,
    s: 1, status: '本文に見つからない', pointed_sentence: original, stage: '抜き出し', blocks_approval: false }]);
  assert.equal(record.logic_version, 'plan2-s7');
  assert.equal(record.summary, '主張 0 件: 裏付けあり 0・修正 0（食い違い 0・期限 0・具体を外した 0）・残った食い違い 0・未解決 0・上限で未照合 0・捨てた主張 1・人が確かめる箇所 1 件');
});

test('R2: 捨てた要件は従来の内容で人の確認に回し、承認を止めない', async () => {
  const claim = '扶養親族だけが対象となります。';
  const { record } = await check(original, [raw({ type: '要件', claim })]);
  assert.equal(record.status, 'ok');
  assert.deepEqual(record.remaining, []);
  assert.equal(record.discarded, 1);
  assert.equal(record.discarded_claims[0].blocks_approval, false);
  assert.equal(record.discarded_claims[0].pointed_sentence, original);
  assert.deepEqual(record.review_items, [{ sentence: claim, heading: '', type: '要件', subject: '控除', claim,
    s: 1, status: '照合で文を特定できなかった', pointed_sentence: original, evidence: [] }]);
});

test('R8: 最初に捨てた主張は種類によらず人の確認に回す', async () => {
  for (const type of ['金額', '割合', '期限', '適用年', '番号', '要件', '判定', '手続', 'その他']) {
    const numeric = ['金額', '割合', '期限', '適用年', '番号', 'その他'].includes(type);
    const claim = numeric ? missing : '扶養親族だけが対象となります。';
    const { record } = await check(original, [raw({ type, claim })]);
    assert.equal(record.discarded, 1, type);
    assert.equal(record.discarded_claims[0].blocks_approval, false, type);
    assert.equal(record.status, 'ok', type);
    assert.equal(record.review_items.length, 1, type);
    assert.deepEqual(record.remaining, []);
  }
  const { record } = await check(original, [raw({ s: 99, claim: '扶養親族だけが対象となります。' })]);
  assert.equal(record.discarded_claims[0].blocks_approval, false, '数字のない金額の種類だけでは止めない');
  assert.equal(record.status, 'ok');
});

test('R2: 修正の後の再照合でも一覧を積み、段階と件数が合う', async () => {
  const before = '試験制度の控除額は100万円です。', after = '試験制度の控除額は200万円です。';
  const evidence = source(after);
  let round = 0;
  const result = await check(before, [], { repair: true, searchEvidence: () => [evidence], callLLM: async req => {
    if (req.task === 'extract') {
      round++;
      return [raw({ subject: '試験制度', claim: round === 1 ? before : after }),
        raw({ subject: '別の制度', claim: `別の控除は${round === 1 ? 300 : 400}万円です。` })];
    }
    if (req.task === 'repair') return [{ id: 'c1', replacement: after }];
    assert.equal(req.task, 'judge');
    return supported(req).map(c => ({ ...c, status: round === 1 ? '食い違い' : '裏付けあり', correct: after }));
  } });
  assert.equal(round, 2);
  assert.equal(result.body, after);
  assert.equal(result.record.status, 'revise');
  assert.deepEqual(result.record.remaining, []);
  assert.equal(result.record.review_items.length, 1);
  assert.equal(result.record.review_items[0].status, '照合で文を特定できなかった');
  assert.equal(result.record.discarded, 2);
  assert.deepEqual(result.record.discarded_claims.map(c => [c.stage, c.pointed_sentence, c.blocks_approval]),
    [['抜き出し', before, false], ['再照合', after, true]]);
  assert.equal(result.record.corrections[0].resolved, true);
});

test('R2: 条件確認だけの修正を取り消すと、修正前の一覧も戻す', async () => {
  const before = '18歳以上の子が対象です。', after = '18歳以上の孫が対象です。';
  const evidence = source(after);
  let round = 0;
  const result = await check(before, [], { repair: true, writer_materials: ['ta:4103'],
    searchWriterEvidence: () => [evidence], searchEvidence: () => [evidence], callLLM: async req => {
      if (req.task === 'extract') {
        round++;
        return round === 1 ? [raw({ type: '要件', subject: '試験制度', claim: before }),
          raw({ type: '手続', claim: '電子帳簿保存の事前申請が必須です。' })] : [raw()];
      }
      if (req.task === 'condition_check') return { verdict: '不一致', conditions: [{ article: '子', source: '孫', match: '不一致' }], correct: after };
      if (req.task === 'repair') return [{ id: 'c1', replacement: after }];
      assert.equal(req.task, 'judge');
      return supported(req);
    } });
  assert.equal(round, 2);
  assert.equal(result.body, before);
  assert.equal(result.record.status, 'ok');
  assert.deepEqual(result.record.remaining, []);
  assert.deepEqual(result.record.rechecked, []);
  assert.deepEqual(result.record.corrections, []);
  assert.equal(result.record.discarded, 1);
  assert.deepEqual(result.record.discarded_claims.map(c => [c.claim, c.stage, c.blocks_approval]),
    [['電子帳簿保存の事前申請が必須です。', '抜き出し', false]]);
  assert.ok(result.record.review_items.some(c => c.status === '条件の違いを要確認'));
});

for (const recovered of [true, false]) test(`R2: 書き手資料モードの抜き出し直しで${recovered ? '回復した主張を消す' : '回復しなかった主張を残す'}`, async () => {
  const evidence = source(original);
  const tasks = [];
  const { record } = await check(original, [], { writer_materials: ['ta:4103'], searchWriterEvidence: () => [evidence],
    searchEvidence: () => [evidence], callLLM: async req => {
      tasks.push(req.task);
      if (req.task === 'extract') return [raw({ type: 'その他', claim: original })];
      if (req.task === 'retry_extract') return recovered ? [raw({ claim: original })] : [];
      assert.equal(req.task, 'judge');
      return supported(req);
    } });
  assert.equal(tasks.filter(task => task === 'retry_extract').length, 1);
  assert.equal(record.discarded, recovered ? 0 : 1);
  assert.equal(record.status, 'ok');
  assert.deepEqual(record.remaining, []);
  assert.equal(record.review_items.length, recovered ? 0 : 1);
  if (!recovered) {
    assert.equal(record.discarded_claims[0].status, '主張の形式が不正');
    assert.equal(record.discarded_claims[0].pointed_sentence, original);
    assert.equal(record.discarded_claims[0].blocks_approval, false);
  }
});

test('R8: 数字の主張の形式が不正でも、最初の抜き出しでは止めない', async () => {
  const { record } = await check(original, [raw({ type: 'その他', subject: '', claim: original })]);
  assert.equal(record.status, 'ok');
  assert.equal(record.discarded_claims[0].status, '主張の形式が不正');
  assert.equal(record.discarded_claims[0].blocks_approval, false);
  assert.equal(record.review_items.length, 1);
  assert.equal(record.review_items[0].status, '照合で文を特定できなかった');
  assert.equal(record.review_items[0].pointed_sentence, original);
});

test('R8: #744 の箇条書きを要約して捨てても止めず、画面に指した文を出す', async () => {
  const sentence = '- <strong>10万円</strong>：上のいずれにも当てはまらない場合';
  const { record } = await check(sentence, [raw({ claim: '65万円・55万円の要件に当てはまらない場合は10万円' })]);
  assert.equal(record.status, 'ok');
  assert.equal(record.discarded_claims[0].blocks_approval, false);
  assert.equal(record.review_items[0].pointed_sentence, sentence);
  const [summary, detail] = render(record, sentence);
  assert.match(summary, /照合で文を特定できなかった 1 件/);
  assert.match(detail, /AI が指した文: 10万円：上のいずれにも当てはまらない場合/);
  assert.match(detail, /人が確かめる箇所にも載せています（承認は止めません）/);
  assert.ok(!detail.includes('承認を止めています'));
  const revised = render({ ...record, status: 'revise' }, sentence)[1];
  assert.ok(!revised.includes('数字の主張は照合できていないため、承認を止めています。'));
});

test('S6/R8: 上限で未照合の数字の主張は引き続き止める', async () => {
  const second = '控除は100万円です。';
  const { record } = await check(original + '\n' + second, [raw({ claim: original }), raw({ s: 2, claim: second })], {
    maxNumericClaims: 1, searchEvidence: () => [source(original)],
    callLLM: async req => req.task === 'extract' ? [raw({ claim: original }), raw({ s: 2, claim: second })] : supported(req),
  });
  assert.equal(record.status, 'revise');
  assert.equal(record.dropped, 1); assert.equal(record.discarded, 0);
  assert.deepEqual(record.review_items, []);
});

test('R9: 人の確認一覧は資料なし・上限・文を特定できなかった項目の順', () => {
  const statuses = ['照合で文を特定できなかった', '上限で未照合', '資料なし'];
  const record = displayRecord({ review_items: statuses.map(status => ({ sentence: original, status })), discarded_claims: [] });
  const html = render(record)[1];
  assert.ok(html.indexOf('<h4 class="h6">資料が見つからなかった記述') < html.indexOf('<h4 class="h6">件数の上限で照合しなかった記述'));
  assert.ok(html.indexOf('<h4 class="h6">件数の上限で照合しなかった記述') < html.indexOf('<h4 class="h6">照合で文を特定できなかった'));
});

const row = (extra = {}) => ({ ...raw(), sentence: missing, pointed_sentence: original, heading: '',
  status: '本文に見つからない', stage: '抜き出し', blocks_approval: true, ...extra });
const displayRecord = (extra = {}) => ({ status: 'revise', body_sha256: F.bodyHash(original),
  corrections: [], remaining: [], review_items: [], discarded: 1, discarded_claims: [row()], ...extra });
const render = (record, body = original, meta = {}) => [page.renderFactCheckSummary(meta, record, body), page.renderFactCheck(meta, record, body)];

test('F1: 状態表どおりに承認の表示を切り替え、記事情報の状態も使う', () => {
  for (const [recordStatus, statusOverride] of [['not_run'], ['revise'], ['ok'], ['unknown'],
    ['revise', 'not_run'], ['not_run', 'revise'], ['revise', 'ok']]) {
    const status = statusOverride || recordStatus;
    const record = displayRecord({ status: recordStatus, discarded: 2,
      discarded_claims: [row(), row({ claim: '人が確かめる主張', blocks_approval: false })] });
    const before = JSON.stringify(record);
    const [summary, detail] = render(record, original, statusOverride ? { fact_check_status: statusOverride } : {});
    const blocking = status === 'revise';
    assert.equal(summary.includes('class="alert alert-danger"'), blocking);
    assert.equal(summary.includes('承認が止まっています'), blocking);
    assert.equal(summary.includes('数字を照合できなかった主張 1 件'), blocking);
    assert.ok(detail.includes(`<details${blocking ? ' open' : ''}><summary>捨てた主張 2 件${blocking ? '（うち承認を止めている 1 件）' : ''}</summary>`));
    assert.equal(detail.includes('<details open>'), blocking);
    const explanation = blocking ? '数字の主張は照合できていないため、承認を止めています。'
      : status === 'ok' ? '' : '照合が最後まで動かなかったため、この一覧は承認の判断に使っていません。';
    assert.ok(detail.includes(`<p>照合の AI が抜き出した主張のうち、本文の文と結び付けられなかったものです。${explanation}</p>`));
    assert.equal(detail.includes('承認を止めています'), blocking);
    assert.equal(detail.includes('<div class="text-danger">数字を照合できていないため、承認を止めています</div>'), blocking);
    assert.equal(detail.includes('人が確かめる箇所にも載せています（承認は止めません）'), blocking || status === 'ok');
    assert.equal(JSON.stringify(record), before, '表示で承認判断や記録を変えない');
  }
});

test('F1: 数字の主張を捨てた後に判定が失敗した実際の記録では承認停止を表示しない', async () => {
  const retained = '課税額は100万円です。', body = original + '\n' + retained;
  for (const failOpen of [false, true]) {
    const calls = [];
    const { body: checkedBody, record } = await F.checkFacts(body, { ...opts, failOpen,
      searchEvidence: () => [source(retained)], callLLM: async req => {
        calls.push(req.task);
        if (req.task === 'extract') return [raw(), raw({ type: '要件', claim: '未成年者だけが対象です。' }),
          raw({ s: 2, subject: '課税額', claim: retained })];
        assert.equal(req.task, 'judge');
        throw new Error('F1 fake judge failure');
      } });
    assert.deepEqual(calls, ['extract', 'judge']);
    assert.equal(checkedBody, body);
    assert.equal(record.status, 'not_run');
    assert.equal(record.body_sha256, F.bodyHash(body));
    assert.equal(record.discarded, 2);
    assert.deepEqual(record.discarded_claims.map(c => c.blocks_approval), [false, false]);
    assert.equal(record.discarded_claims[0].pointed_sentence, original);
    const before = JSON.stringify(record);
    const [summary, detail] = render(record, body);
    assert.ok(!summary.includes('class="alert alert-danger"'));
    assert.ok(!summary.includes('承認が止まっています'));
    assert.ok(!summary.includes('数字を照合できなかった主張'));
    assert.ok(detail.includes('<details><summary>捨てた主張 2 件</summary>'));
    assert.ok(!detail.includes('<details open>'));
    assert.ok(detail.includes('照合が最後まで動かなかったため、この一覧は承認の判断に使っていません。'));
    assert.ok(!detail.includes('承認を止めています'));
    assert.ok(!detail.includes('承認は止めません'));
    assert.equal(JSON.stringify(record), before, '表示で失敗した記録を変えない');
  }
});

test('R3: 要点に件数・文・要約と赤い枠、詳細に指定の文言と開いた一覧が出る', () => {
  const record = displayRecord(), before = JSON.stringify(record);
  const [summary, detail] = render(record);
  assert.match(summary, /<div class="alert alert-danger">数字を照合できなかった主張 1 件で承認が止まっています。/);
  assert.ok(summary.includes(`<p>${original}／要約: ${missing}</p>`));
  assert.ok(summary.includes('<a href="#factCheck">詳しくは本文の後ろの「捨てた主張」</a>'));
  assert.ok(summary.includes('照合で承認が止まっています'));
  assert.ok(detail.includes('<details open><summary>捨てた主張 1 件（うち承認を止めている 1 件）</summary>'));
  for (const text of [original, `要約: ${missing}`, '種類: 金額 / 制度名: 控除',
    '理由: AI が指した文に、要約の数字や言葉が見つかりませんでした', '段階: 最初の照合',
    '照合の AI が抜き出した主張のうち、本文の文と結び付けられなかったものです。数字の主張は照合できていないため、承認を止めています。',
    '<div class="text-danger">数字を照合できていないため、承認を止めています</div>']) assert.ok(detail.includes(text), text);
  assert.equal(JSON.stringify(record), before, '表示で記録を変えない');
});

test('R3: 止めない主張は閉じた一覧にし、形式不正の理由・再照合・文の代用を出す', () => {
  const [summary, detail] = render(displayRecord({ status: 'ok', review_items: [{ sentence: original, status: '本文に見つからない' }],
    discarded_claims: [row({ pointed_sentence: undefined, sentence: '代わりの文です。', status: '主張の形式が不正', stage: '再照合', blocks_approval: false })] }));
  assert.ok(!summary.includes('数字を照合できなかった主張'));
  assert.ok(detail.includes('<details><summary>捨てた主張 1 件</summary>'));
  assert.ok(detail.indexOf('人が確かめる箇所 1 件') < detail.indexOf('捨てた主張 1 件'));
  for (const text of ['代わりの文です。', '理由: AI の答えの形が正しくありませんでした（種類・制度名など）',
    '段階: 修正の後の再照合', '<div class="small">人が確かめる箇所にも載せています（承認は止めません）</div>']) assert.ok(detail.includes(text), text);
});

test('R3: 混在した一覧は止める主張だけを要点に数え、文のない欄は元の文で表示', () => {
  const [summary, detail] = render(displayRecord({ discarded: 2, discarded_claims: [row({ pointed_sentence: undefined }),
    row({ claim: '要点に出さない主張', blocks_approval: false })] }));
  assert.ok(summary.includes('数字を照合できなかった主張 1 件'));
  assert.ok(summary.includes(`<p>${missing}／要約: ${missing}</p>`));
  assert.ok(!summary.includes('要点に出さない主張'));
  assert.ok(detail.includes('捨てた主張 2 件（うち承認を止めている 1 件）'));
});

test('R3: AI の文・要約・種類・制度名・理由・段階をエスケープする', () => {
  const unsafe = '<script>alert("discarded")</script>';
  const escaped = '&lt;script&gt;alert(&quot;discarded&quot;)&lt;/script&gt;';
  const [summary, detail] = render(displayRecord({ discarded_claims: [row({ pointed_sentence: unsafe, claim: unsafe,
    type: unsafe, subject: unsafe, status: unsafe, stage: unsafe })] }));
  for (const html of [summary, detail]) {
    assert.ok(!html.includes(unsafe));
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes('<script>'));
  }
  for (const label of ['要約', '種類', '制度名', '理由', '段階']) assert.ok(detail.includes(`${label}: ${escaped}`), label);
  for (const html of render(displayRecord({ discarded_claims: [row({ pointed_sentence: undefined, sentence: unsafe })] }))) {
    assert.ok(!html.includes(unsafe)); assert.ok(html.includes(escaped));
  }
});

test('R3: 一覧のない旧版の記録と0件の表示', () => {
  for (const html of render(displayRecord({ discarded_claims: undefined }))) {
    assert.ok(html.includes('<p>捨てた主張 1 件（この記録には主張の一覧がありません）</p>'));
    assert.ok(!html.includes('数字を照合できなかった主張'));
  }
  for (const discarded_claims of [undefined, []]) for (const html of render(displayRecord({ discarded: 0, discarded_claims }))) {
    assert.ok(!html.includes('捨てた主張'));
    assert.ok(!html.includes('数字を照合できなかった主張'));
  }
});

test('F3: 一覧が配列でない記録は要点・詳細とも旧版の記録として表示する', () => {
  for (const discarded_claims of [{}, true, 'x', null]) {
    const record = displayRecord({ discarded_claims }), before = JSON.stringify(record);
    for (const html of render(record)) {
      assert.ok(html.includes('<p>捨てた主張 1 件（この記録には主張の一覧がありません）</p>'));
      assert.ok(!html.includes('数字を照合できなかった主張'));
      assert.ok(!html.includes('<summary>捨てた主張'));
    }
    assert.equal(JSON.stringify(record), before, '表示で壊れた一覧も書き換えない');
    for (const html of render(displayRecord({ discarded: 0, discarded_claims }))) {
      assert.ok(!html.includes('捨てた主張'));
    }
  }
});

test('F3: 一覧に null・数字などが混ざっても正しい要素だけを表示する', () => {
  const record = displayRecord({ discarded: 6, discarded_claims: [null, 7, 'x', true, row(),
    row({ claim: '人が確かめる主張', blocks_approval: false })] }), before = JSON.stringify(record);
  const [summary, detail] = render(record);
  assert.ok(summary.includes('数字を照合できなかった主張 1 件で承認が止まっています。'));
  assert.ok(summary.includes(`<p>${original}／要約: ${missing}</p>`));
  assert.ok(!summary.includes('人が確かめる主張'));
  assert.ok(detail.includes('<summary>捨てた主張 2 件（うち承認を止めている 1 件）</summary>'));
  assert.equal((detail.match(/<div>要約:/g) || []).length, 2);
  assert.ok(detail.includes(`要約: ${missing}`));
  assert.ok(detail.includes('要約: 人が確かめる主張'));
  assert.equal(JSON.stringify(record), before, '表示で記録の要素や件数を変えない');
  for (const html of render(displayRecord({ discarded_claims: [null, 7] }))) {
    assert.ok(!html.includes('捨てた主張'));
  }
});

test('R3: 本文と一致しない記録・古い記録・読めない記録では一覧を出さない', () => {
  for (const discarded_claims of [undefined, [row()]]) for (const extra of [{ body_sha256: F.bodyHash('別の本文') }, { stale: true }, { read_error: true }]) {
    for (const html of render(displayRecord({ discarded_claims, ...extra }))) {
      assert.ok(!html.includes('捨てた主張'));
      assert.ok(!html.includes('数字を照合できなかった主張'));
      assert.ok(!html.includes(missing));
    }
  }
});

test('R3: #741 の57件裏付けあり・残り0・未解決0でも、捨てた金額の文と理由を要点に出す', () => {
  const sentence = 'この要件に加えて、e-Taxで申告する場合、控除は最高65万円になります。';
  const record = displayRecord({ body_sha256: F.bodyHash(sentence), claims: Array.from({ length: 57 }, (_, i) => ({ id: `c${i + 1}`, status: '裏付けあり' })),
    summary: '主張 57 件: 裏付けあり 57・残った食い違い 0・未解決 0・捨てた主張 1', discarded_claims: [row({ pointed_sentence: sentence })] });
  const [summary] = render(record, sentence);
  assert.ok(summary.includes('数字を照合できなかった主張 1 件で承認が止まっています。'));
  assert.ok(summary.includes(`<p>${sentence}／要約: ${missing}</p>`));
  assert.ok(summary.includes('状態:</strong> 要修正'));
});

(async () => {
  let passed = 0;
  const savedWriterMode = process.env.FACT_CHECK_WRITER_MATERIALS;
  process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
  try {
    for (const { name, run } of cases) {
      try { await run(); passed++; console.log(`PASS ${name}`); }
      catch (error) { console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally {
    if (savedWriterMode === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS;
    else process.env.FACT_CHECK_WRITER_MATERIALS = savedWriterMode;
  }
  console.log(`discarded-claims: PASS ${passed} / FAIL ${cases.length - passed}`);
  if (passed !== cases.length) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
