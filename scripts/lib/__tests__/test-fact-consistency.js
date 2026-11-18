'use strict';

// A（同じ文の指摘を1つの直しにまとめる）・B（直した後の食い違い探し）・画面の試験。
// 偽の AI の作りは test-fact-check.js の fake と同じ形にし、実データは fixtures/pr796.json を使う。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../fact-check');
const H = require('./fact-pages-test-helpers');
const page = require('../../../netlify/functions/review-page');
const fixture = require('../../../docs/codex-tasks/fact-consistency/fixtures/pr796.json');

const now = new Date('2026-11-18T00:00:00Z');
const same = fixture.same_sentence;
const SENTENCE = same.findings[0].sentence;
const GOOD = same.good_replacement;
const A_BODY = `## ${same.findings[0].heading}\n\n${SENTENCE}\n\nこの節の最後の文です。\n`;
const findings = () => same.findings.map(f => ({ ...f, keep: [] }));

const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });

function fakeAI(config = {}) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    if (request.task === 'consistency_check') {
      const value = typeof config.consistency === 'function' ? config.consistency(request) : config.consistency;
      if (value instanceof Error) throw value;
      return value === undefined ? [] : value;
    }
    if (request.task === 'extract' || request.task === 'retry_extract') {
      return typeof config.extract === 'function' ? config.extract(request) : [];
    }
    if (request.task === 'judge') {
      return typeof config.judge === 'function' ? config.judge(request, JSON.parse(request.user)) : JSON.parse(request.user).claims.map(c => ({ id: c.id, status: '資料なし' }));
    }
    if (request.task === 'repair' || request.task === 'retry_repair') {
      return typeof config.repair === 'function' ? config.repair(request) : [];
    }
    throw new Error(`未定義の呼び出し: ${request.task}`);
  };
  return { fn, calls };
}

function unitLine(request, text) {
  return [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)].find(m => m[2] === text)?.[1];
}

function claimText(data, claim) {
  if (claim.sentence) return claim.sentence;
  const line = String(data.body || '').split('\n').find(row => new RegExp(`^\\[${claim.s}\\] `).test(row));
  return line ? line.replace(/^\[\d+\] /, '') : '';
}

function basisOf(pageData, text) {
  const want = F.normalizedQuote(text);
  for (let i = 0; i < pageData.rows.length; i++) for (let n = 1; n <= 2; n++) {
    const rows = pageData.rows.slice(i, i + n);
    if (rows.length !== n) break;
    if (F.normalizedQuote(rows.map(row => row.text).join('\n')) === want) return n === 1 ? String(rows[0].s) : `${rows[0].s}-${rows[n - 1].s}`;
  }
  return '';
}

// ── A ──────────────────────────────────────────────────────────────
test('A', 'T1 同じ文の2つの指摘が1つの置き換えで本文に入る', async () => {
  const llm = fakeAI({ repair: req => JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: GOOD })) });
  const result = await F.repairBody(A_BODY, findings(), llm.fn, { now });
  assert.equal(result.accepted, true);
  assert.ok(result.body.includes(GOOD));
  assert.equal(result.rejected.size, 0);
});

test('A', 'T2 両方の項目に same_sentence_ids と共通の instruction が付く', () => {
  const items = F.repairInstructions(findings());
  assert.deepEqual(items.map(i => i.id), ['c42', 'c43']);
  for (const item of items) {
    assert.deepEqual(item.same_sentence_ids, ['c42', 'c43']);
    assert.ok(item.instruction.includes('。この文には same_sentence_ids の指摘が全部かかっています。全部の指摘を満たす1つの置き換えを作り、どの id にも同じ replacement を返す'));
  }
  assert.ok(items[1].instruction.includes('。同じ文の食い違い・期限の直し（correct）にある数字は、その直しのために残してよい。外すのは資料の無い部分だけ'));
  assert.ok(!items[0].instruction.includes('同じ文の食い違い・期限の直し（correct）にある数字'));
});

test('A', 'T3 資料の無い「約2万円」を残した置き換えは採らない', async () => {
  const bad = '課税所得が195万円以上330万円未満の人（税率10%）なら、所得税は約2万円です（復興特別所得税を除く）。';
  const result = await F.repairBody(A_BODY, findings(), async () => [
    { id: 'c42', replacement: bad }, { id: 'c43', replacement: bad }], { now });
  assert.equal(result.rejected.get('c43'), '資料の無い数字が残っています');
  assert.equal(result.rejected.get('c42'), '同じ文の別の指摘の置き換えを採れませんでした');
  assert.equal(result.body, A_BODY);
});

test('A', 'T4 資料の無い「所得20万円」を残した置き換えも採らない', async () => {
  const bad = '課税所得が195万円以上330万円未満の人（税率10%）なら、所得20万円の増加で税額が増えます（復興特別所得税を除く）。';
  const result = await F.repairBody(A_BODY, findings(), async () => [
    { id: 'c42', replacement: bad }, { id: 'c43', replacement: bad }], { now });
  assert.equal(result.rejected.get('c43'), '資料の無い数字が残っています');
  assert.equal(result.rejected.get('c42'), '同じ文の別の指摘の置き換えを採れませんでした');
  assert.equal(result.body, A_BODY);
});

test('A', 'T5 指摘が1つだけの文は依頼文も今と同じ', () => {
  const [item] = F.repairInstructions([{ ...same.findings[1] }]);
  assert.equal(Object.hasOwn(item, 'same_sentence_ids'), false);
  assert.equal(item.instruction, '資料が無い具体的な要件・金額・割合・期限・適用年・手続・判定を外し、「詳しくは国税庁の〇〇で確認」程度の案内に置き換える。keep にある裏付けのある内容（数字を含む）は残し、資料が無い部分だけを外す');
});

test('A', 'T6 資料なしが2つだけの文は id を共有し、数字の外し方は今と同じ', async () => {
  const sentence = '所得が20万円を超えたら税率10%で所得税が約2万円増えます。';
  const pair = [
    { id: 'x1', sentence, heading: '', status: '資料なし', type: '金額', subject: '所得税', claim: '所得20万円で所得税が約2万円増える', correct: '', quote: '' },
    { id: 'x2', sentence, heading: '', status: '資料なし', type: '割合', subject: '所得税率', claim: '税率10%', correct: '', quote: '' },
  ];
  for (const item of F.repairInstructions(pair)) assert.deepEqual(item.same_sentence_ids, ['x1', 'x2']);
  const removed = await F.repairBody('この節です。\n' + sentence + '\n', pair, async () => [
    { id: 'x1', replacement: '所得が増えると所得税も増えます。' },
    { id: 'x2', replacement: '所得が増えると所得税も増えます。' }], { now });
  assert.equal(removed.rejected.size, 0, '数字を全部外せば採れる');
  const kept = await F.repairBody('この節です。\n' + sentence + '\n', pair, async () => [
    { id: 'x1', replacement: '所得が20万円を超えると所得税が増えます。' },
    { id: 'x2', replacement: '所得が20万円を超えると所得税が増えます。' }], { now });
  assert.equal(kept.rejected.get('x1'), '資料の無い数字が残っています');
  assert.equal(kept.rejected.get('x2'), '同じ文の別の指摘の置き換えを採れませんでした');
});

test('A', 'T7 通しの照合で c42・c43 が直り ok になる', async () => {
  const c42 = same.findings[0];
  const ref = { id: 'a-source', kind: 'taxanswer', no: '2260', title: '所得税の速算表', url: 'https://www.nta.go.jp/example',
    text: [c42.correct, GOOD].join('\n'), law_version: '令和8年4月1日現在法令等' };
  const llm = fakeAI({
    extract: request => {
      const s = unitLine(request, SENTENCE);
      if (s) return [
        { s: Number(s), type: '割合', subject: '所得税率', claim: '課税所得195万円超330万円以下の所得税率は10%' },
        { s: Number(s), type: '金額', subject: '副業所得の税額', claim: '税率10%の人は所得20万円増加で所得税が約2万円増える' },
      ];
      const after = unitLine(request, GOOD);
      return after ? [{ s: Number(after), type: '金額', subject: '副業所得の税額', claim: '増えた所得に10%の所得税がかかる' }] : [];
    },
    judge: (request, data) => {
      const pages = H.materials(request);
      return data.claims.map(claim => {
        const text = claimText(data, claim);
        if (claim.type === '金額' && text === SENTENCE) return { id: claim.id, status: '資料なし' };
        const quote = text === SENTENCE ? c42.correct : GOOD;
        return { id: claim.id, status: text === SENTENCE ? '食い違い' : '裏付けあり',
          evidence_id: pages[0].number, basis: basisOf(pages[0], quote), correct: text === SENTENCE ? c42.correct : '' };
      });
    },
    repair: req => JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: GOOD })),
    consistency: [],
  });
  const r = await F.checkFacts(A_BODY, { callLLM: llm.fn, searchEvidence: () => [ref], now });
  assert.equal(r.record.status, 'ok');
  assert.deepEqual(r.record.remaining, []);
  assert.equal(r.record.corrections.length, 2);
  assert.deepEqual(r.record.corrections.map(c => c.status).sort(), ['資料なし', '食い違い']);
  assert.ok(r.record.corrections.every(c => c.resolved));
  assert.ok(r.body.includes(GOOD));
  assert.equal(llm.calls.filter(c => c.task === 'consistency_check').length, 1);
});

// ── B ──────────────────────────────────────────────────────────────
const c22 = fixture.consistency.correction;
const BEFORE = c22.before;
const AFTER = c22.after;
const AFTER_BODY = fixture.consistency.body_after_repair;
const BEFORE_BODY = AFTER_BODY.replace(AFTER, BEFORE);

function consistencyRef() {
  return { id: 'b-source', kind: 'taxanswer', no: '2020', title: '確定申告', url: 'https://www.nta.go.jp/example',
    text: [c22.correct, AFTER].join('\n'), law_version: '令和8年4月1日現在法令等' };
}

function consistencyFake(consistency) {
  const ref = consistencyRef();
  return fakeAI({
    extract: request => {
      const before = unitLine(request, BEFORE), after = unitLine(request, AFTER);
      if (before) return [{ s: Number(before), type: '判定', subject: '確定申告', claim: '課税所得が生じない場合は申告義務は残らない' }];
      if (after) return [{ s: Number(after), type: '判定', subject: '確定申告', claim: '確定申告は不要' }];
      return [];
    },
    judge: (request, data) => {
      const pages = H.materials(request);
      return data.claims.map(claim => {
        const text = claimText(data, claim);
        return text === BEFORE
          ? { id: claim.id, status: '食い違い', evidence_id: pages[0].number, basis: basisOf(pages[0], c22.correct), correct: c22.correct }
          : { id: claim.id, status: '裏付けあり', evidence_id: pages[0].number, basis: basisOf(pages[0], AFTER) };
      });
    },
    repair: req => JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: AFTER })),
    consistency,
  });
}

const articleMeta = { title: fixture.title, summary: fixture.summary };

function numberInBody(request, text) {
  return unitLine(request, text);
}

const twoRows = request => {
  const body = JSON.parse(request.user).body;
  const heading = body.split('\n').find(line => /^\[\d+\] ## 基礎控除104万円は申告要否の判定には使わない$/.test(line));
  return [
    { where: 'summary', text: fixture.summary, correction: 'c1', reason: '直した内容と食い違います。', suggestion: '直した内容に合わせて書き直します。' },
    { where: heading.match(/^\[(\d+)\]/)[1], text: '## 基礎控除104万円は申告要否の判定には使わない', correction: 'c1', reason: '申告要否の判定に使わないという直しと食い違います。', suggestion: '見出しを直した内容に合わせます。' },
  ];
};

test('B', 'T8 見出しと要約の食い違いを記録し、止めるが本文は変えない', async () => {
  const llm = consistencyFake(twoRows);
  const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
  assert.equal(r.record.consistency.findings.length, 2);
  assert.equal(r.record.status, 'revise');
  assert.ok(r.record.summary.includes('直した内容と食い違う箇所 2 件'));
  assert.equal(llm.calls.filter(c => c.task === 'consistency_check').length, 1);
  assert.equal(r.body, AFTER_BODY);
  const raw = `---\ntitle: "t"\nslug: "b"\nrecommendation: "publish"\n---\n${BEFORE_BODY}`;
  assert.ok(F.applyFactResult(raw, r).includes('fact_check_blocking: true'));
});

test('B', 'T9 依頼に corrections・title・summary・番号付きの本文が入る', async () => {
  const llm = consistencyFake([]);
  await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
  const request = llm.calls.find(c => c.task === 'consistency_check');
  const data = JSON.parse(request.user);
  assert.equal(data.corrections.length, 1);
  assert.equal(data.corrections[0].id, 'c1');
  assert.equal(data.corrections[0].before, BEFORE);
  assert.equal(data.corrections[0].after, AFTER);
  assert.equal(data.corrections[0].correct, c22.correct);
  assert.equal(data.title, fixture.title);
  assert.equal(data.summary, fixture.summary);
  assert.ok(data.body.includes('[1] '));
  assert.ok(data.body.includes('## 基礎控除104万円は申告要否の判定には使わない'));
});

test('B', 'T10 直しが案内だけ、または直しが無いときは呼ばない', async () => {
  const supportedSentence = 'この制度は届出が必要です。';
  const supportedRef = { id: 'ok-source', kind: 'taxanswer', no: '2020', title: '手続', url: 'https://www.nta.go.jp/example',
    text: supportedSentence, law_version: '令和8年4月1日現在法令等' };
  const plain = fakeAI({
    extract: request => {
      const s = unitLine(request, supportedSentence);
      return s ? [{ s: Number(s), type: '判定', subject: '制度', claim: '届出が必要' }] : [];
    },
    judge: (request, data) => {
      const pages = H.materials(request);
      return data.claims.map(claim => ({ id: claim.id, status: '裏付けあり', evidence_id: pages[0].number, basis: basisOf(pages[0], supportedSentence) }));
    },
  });
  const none = await F.checkFacts(`## 制度\n${supportedSentence}\n`, { callLLM: plain.fn, searchEvidence: () => [supportedRef], now, article_meta: articleMeta });
  assert.equal(none.record.consistency, undefined);
  assert.equal(none.record.status, 'ok');
  assert.ok(!plain.calls.some(c => c.task === 'consistency_check'));

  const numeric = '給与収入400万円の会社員は所得税が約1万円増えます。';
  const body = `## 試算\n\n${numeric}\n\nこの節の最後の文です。\n`;
  const guide = '詳しくは国税庁の確定申告書等作成コーナーで確認してください。';
  const llm = fakeAI({
    extract: request => {
      const s = unitLine(request, numeric);
      return s ? [{ s: Number(s), type: '金額', subject: '所得税', claim: '所得税が約1万円増える' }] : [];
    },
    repair: () => [{ id: 'c1', replacement: guide }],
  });
  const r = await F.checkFacts(body, { callLLM: llm.fn, searchEvidence: () => [], now, article_meta: articleMeta });
  assert.equal(r.record.consistency, undefined);
  assert.ok(!llm.calls.some(c => c.task === 'consistency_check'));
  assert.ok(r.record.corrections[0].generalized && r.record.corrections[0].resolved);
  assert.equal(r.record.status, 'ok');
});

test('B', 'T11 採れない行は dropped に数え、他に理由が無ければ ok', async () => {
  const llm = consistencyFake(request => {
    const body = JSON.parse(request.user).body;
    const afterLine = body.split('\n').find(line => line.endsWith(` ${AFTER}`));
    const rows = [
      { where: 9999, text: '知らない場所', correction: 'c1' },
      { where: 'summary', text: '要約に無い文です。', correction: 'c1' },
      { where: afterLine.match(/^\[(\d+)\]/)[1], text: AFTER, correction: 'c1' },
      { where: 'summary', text: fixture.summary, correction: 'c999' },
    ];
    return rows;
  });
  const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
  assert.deepEqual(r.record.consistency.findings, []);
  assert.equal(r.record.consistency.dropped, 4);
  assert.equal(r.record.status, 'ok');
});

for (const [name, value] of [['T12 例外', new Error('応答が読めません 秘密の本文')], ['T13 読めない答え', '読めない答え 秘密の本文'], ['T13 配列でない答え', '{"秘密":"本文"}']]) {
  test('B', `${name}は失敗として止める`, async () => {
    const llm = consistencyFake(value);
    const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
    assert.equal(r.record.consistency.failed, true);
    assert.equal(r.record.consistency.checked, false);
    assert.equal(r.record.status, 'revise');
    assert.ok(r.record.summary.includes('直した内容との食い違いを確かめられませんでした'));
    assert.notEqual(r.record.status, 'not_run');
    assert.ok(!String(r.record.consistency.error || '').includes('秘密'));
  });
}

test('B', 'T32 R9 中断が consistency_check の途中で起きたら照合全体を失敗にし、consistency を failed にしない', async () => {
  const controller = new AbortController();
  const llm = consistencyFake(() => { controller.abort(); throw new Error('中断されました'); });
  const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now,
    article_meta: articleMeta, signal: controller.signal });
  // B まで届いていること（中断が最初の抜き出しで終わっていない）。
  assert.ok(r.record.calls.some(c => c.task === 'consistency_check'));
  assert.equal(r.record.status, 'not_run');
  assert.equal(r.record.consistency, undefined);
  assert.notEqual(r.record.consistency?.failed, true);
});

test('B', 'T14 repair: false では呼ばない', async () => {
  const llm = consistencyFake([]);
  const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta, repair: false });
  assert.equal(r.record.consistency, undefined);
  assert.ok(!llm.calls.some(c => c.task === 'consistency_check'));
});

test('B', 'T15 checkArticle は frontmatter の title・summary を渡す', async () => {
  const llm = consistencyFake([]);
  const raw = `---\ntitle: "${fixture.title}"\nsummary: "${fixture.summary}"\nslug: "b"\nrecommendation: "publish"\n---\n${BEFORE_BODY}`;
  await F.checkArticle(raw, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, persist: false });
  const request = llm.calls.find(c => c.task === 'consistency_check');
  const data = JSON.parse(request.user);
  assert.equal(data.title, fixture.title);
  assert.equal(data.summary, fixture.summary);
});

test('B', 'T16 本文の見出し・要約・箇条書きの3行を採る', async () => {
  const llm = consistencyFake(request => {
    const body = JSON.parse(request.user).body;
    const number = text => body.split('\n').find(line => line.endsWith(` ${text}`))?.match(/^\[(\d+)\]/)?.[1];
    return fixture.consistency.expected_conflicts.map(row => ({ ...row, where: row.where === 'summary' ? 'summary' : number(row.text), correction: 'c1',
      reason: '直した内容と食い違います。', suggestion: '直した内容に合わせます。' }));
  });
  const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
  assert.equal(r.record.consistency.findings.length, 3);
  assert.deepEqual(r.record.consistency.findings.map(f => f.text), fixture.consistency.expected_conflicts.map(row => row.text));
  assert.deepEqual(r.record.consistency.findings.map(f => f.where), ['summary', 'body', 'body']);
  // 見出しそのものが指摘のときは、直前の見出し名ではなく heading_unit で示す（R21）。
  assert.equal(r.record.consistency.findings[1].heading_unit, true);
  assert.equal(r.record.consistency.findings[1].heading, '');
  assert.equal(r.record.consistency.findings[2].heading, 'まとめ');
  assert.equal(r.record.status, 'revise');
});

test('B', 'T24 where が数値・文字・括弧の番号でも同じく採る', async () => {
  for (const format of [n => n, n => String(n), n => `[${n}]`]) {
    const llm = consistencyFake(request => {
      const body = JSON.parse(request.user).body;
      const number = Number(body.split('\n').find(line => /^\[\d+\] ## 基礎控除104万円は申告要否の判定には使わない$/.test(line)).match(/^\[(\d+)\]/)[1]);
      return [
        { where: 'summary', text: fixture.summary, correction: 'c1', reason: '直した内容と食い違います。', suggestion: '直した内容に合わせます。' },
        { where: format(number), text: '## 基礎控除104万円は申告要否の判定には使わない', correction: 'c1', reason: '直した内容と食い違います。', suggestion: '直した内容に合わせます。' },
      ];
    });
    const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
    assert.equal(r.record.consistency.findings.length, 2);
    assert.equal(r.record.consistency.dropped, 0);
  }
});

test('B', 'T25 形の違いは失敗にして止め、中身の違いは dropped にする', async () => {
  const rows = [
    '文字列の行',
    { where: '本文', text: '見出しの記述', correction: 'c1' },
    { where: 'summary', text: 1, correction: 'c1' },
    { where: 'summary', text: fixture.summary, correction: ['c1'] },
  ];
  for (const row of rows) {
    const llm = consistencyFake(() => [row]);
    const r = await F.checkFacts(BEFORE_BODY, { callLLM: llm.fn, searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
    assert.equal(r.record.consistency.failed, true, JSON.stringify(row));
    assert.equal(r.record.status, 'revise', JSON.stringify(row));
  }
  // 中身の違いだけなら今のとおり、その行を捨てて続ける。
  const droppedOnly = await F.checkFacts(BEFORE_BODY, { callLLM: consistencyFake(() => [{ where: 'summary', text: '要約に無い文です。', correction: 'c1' }]).fn,
    searchEvidence: () => [consistencyRef()], now, article_meta: articleMeta });
  assert.equal(droppedOnly.record.consistency.failed, undefined);
  assert.equal(droppedOnly.record.consistency.dropped, 1);
  // 詳細の画面だけに、採らなかった件数を小さく出す（R16）。
  const record = screenRecord({ checked: true, corrections: ['c1'], findings: [], dropped: 2 });
  assert.ok(page.renderFactCheck(screenMeta, record, screenBody).includes('AI が挙げたが採らなかった 2 件'));
  assert.ok(!page.renderFactCheckSummary(screenMeta, record, screenBody).includes('AI が挙げたが採らなかった'));
});

test('B', 'T27 資料の文に無い数字は、同じ文の食い違いの correct でも外さない', async () => {
  const sentence = '税率10%の人なら、所得税は約2万円増えます。';
  const mismatch = { id: 'm1', sentence, heading: '', status: '食い違い', type: '判定', subject: '所得税',
    claim: '所得税が増える', correct: '税率10%の人なら、所得税は約2万円増えます。', quote: '税率は10%です。', keep: [] };
  const missing = { id: 'm2', sentence, heading: '', status: '資料なし', type: '金額', subject: '所得税',
    claim: '所得税は約2万円増えます', quote: '', correct: '', keep: [] };
  const result = await F.repairBody('この節です。\n' + sentence + '\n', [mismatch, missing], async () => [
    { id: 'm1', replacement: '税率10%の人なら、所得税が増えます。' },
    { id: 'm2', replacement: '税率10%の人なら、所得税は約2万円ほど増えます。' }], { now });
  assert.equal(result.rejected.get('m2'), '資料の無い数字が残っています');
});

test('B', 'T29 直した文と関係ない短い単位は採り、見出しは本文の見出しと出す', async () => {
  const original = '申告の義務は残ります。';
  const fixed = '確定申告は不要です。';
  const body = `## 制度\n${original}\n\n不要です。\n`;
  const source = { id: 'yes-source', kind: 'taxanswer', no: '2020', title: '確定申告', url: 'https://www.nta.go.jp/example',
    text: fixed, law_version: '令和8年4月1日現在法令等' };
  const llm = fakeAI({
    extract: request => {
      const beforeLine = unitLine(request, original), afterLine = unitLine(request, fixed);
      if (afterLine) return [{ s: Number(afterLine), type: '判定', subject: '申告', claim: '確定申告は不要' }];
      return beforeLine ? [{ s: Number(beforeLine), type: '判定', subject: '申告', claim: '申告義務' }] : [];
    },
    judge: (request, data) => {
      const pages = H.materials(request);
      return data.claims.map(claim => claimText(data, claim) === original
        ? { id: claim.id, status: '食い違い', evidence_id: pages[0].number, basis: basisOf(pages[0], fixed), correct: fixed }
        : { id: claim.id, status: '裏付けあり', evidence_id: pages[0].number, basis: basisOf(pages[0], fixed) });
    },
    repair: request => JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: fixed })),
    consistency: request => {
      const sent = JSON.parse(request.user).body;
      const number = Number(sent.split('\n').find(line => line.endsWith(' 不要です。')).match(/^\[(\d+)\]/)[1]);
      return [{ where: number, text: '不要です。', correction: 'c1', reason: '直した内容と食い違います。', suggestion: '直します。' }];
    },
  });
  const r = await F.checkFacts(body, { callLLM: llm.fn, searchEvidence: () => [source], now, article_meta: articleMeta });
  assert.equal(r.record.consistency.findings.length, 1);
  assert.equal(r.record.consistency.findings[0].text, '不要です。');
  assert.equal(r.record.consistency.dropped, 0);

  const record = screenRecord({ checked: true, corrections: ['c1'], dropped: 0, findings: [
    { where: 'body', s: 5, heading_unit: true, heading: '', text: '## 見出しそのもの', correction_id: 'c1', reason: '矛盾します', suggestion: '直します' },
  ] });
  for (const html of [page.renderFactCheckSummary(screenMeta, record, screenBody), page.renderFactCheck(screenMeta, record, screenBody)]) {
    assert.ok(html.includes('本文の見出し'));
    assert.ok(!html.includes('本文（'));
  }
});

test('B', 'T26 前回の照合の止めを、文字がそのまま残っているときだけ引き継ぐ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-carry-'));
  const slug = 'carry';
  const body = '要約の古い記述。\n本文の古い記述。\n';
  const raw = `---\ntitle: "題名"\nsummary: "要約の古い記述。"\nslug: "${slug}"\nrecommendation: "publish"\n---\n${body}`;
  const file = F.recordPath(slug, dir);
  const write = record => fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  const base = (consistency, corrections = []) => ({ version: 1, slug, status: 'revise', logic_version: 'plan2-s11', corrections, consistency });
  const opts = { callLLM: fakeAI({}).fn, searchEvidence: () => [], recordDir: dir, persist: false, now };
  try {
    write(base({ checked: true, corrections: [], findings: [
      { where: 'summary', text: '要約の古い記述。', heading: '', s: null, correction_id: 'c1', reason: '矛盾します', suggestion: '直します' },
      { where: 'body', text: '本文の古い記述。', heading: '', s: 2, correction_id: 'c1', reason: '矛盾します', suggestion: '直します' },
    ] }));
    const carried = await F.checkArticle(raw, opts);
    assert.equal(carried.record.consistency.findings.length, 2);
    assert.ok(carried.record.consistency.findings.every(f => f.carried === true));
    assert.equal(carried.record.status, 'revise');
    const html = page.renderFactCheckSummary({ fact_check_status: 'revise', fact_check_blocking: true }, carried.record, carried.body);
    assert.ok(html.includes('前回の照合から引き継ぎ'));

    // text が今の記事に無くなっている → 引き継がず ok。
    write(base({ checked: true, corrections: [], findings: [
      { where: 'summary', text: 'もう無い記述。', heading: '', s: null, correction_id: 'c1', reason: '', suggestion: '' }] }));
    const gone = await F.checkArticle(raw, opts);
    assert.equal(gone.record.consistency, undefined);
    assert.equal(gone.record.status, 'ok');

    // 前回が failed で、直した文が今も在る → failed を引き継ぐ。
    write({ ...base({ checked: false, failed: true, corrections: ['c22'], findings: [] },
      [{ id: 'c22', before: '元の文。', after: '本文の古い記述。' }]) });
    const failed = await F.checkArticle(raw, opts);
    assert.equal(failed.record.consistency.failed, true);
    assert.equal(failed.record.consistency.carried, true);
    assert.equal(failed.record.status, 'revise');

    // 直した文が今の記事に無い → 引き継がない。
    write({ ...base({ checked: false, failed: true, corrections: ['c22'], findings: [] },
      [{ id: 'c22', before: '元の文。', after: '今は無い文。' }]) });
    const notCarried = await F.checkArticle(raw, opts);
    assert.equal(notCarried.record.consistency, undefined);
    assert.equal(notCarried.record.status, 'ok');

    // 記録のファイルが無い・壊れている → 今までどおり照合する。
    fs.rmSync(file);
    const missing = await F.checkArticle(raw, opts);
    assert.equal(missing.record.consistency, undefined);
    assert.equal(missing.record.status, 'ok');
    fs.writeFileSync(file, '{壊れた', 'utf8');
    const broken = await F.checkArticle(raw, opts);
    assert.equal(broken.record.consistency, undefined);
    assert.equal(broken.record.status, 'ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B', 'T30 失敗の引き継ぎを直した文そのもので続け、別の直しでも切らない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-carry30-'));
  try {
    const slug = 'carry30';
    const article = text => `---\ntitle: "${fixture.title}"\nsummary: "${fixture.summary}"\nslug: "${slug}"\nrecommendation: "publish"\n---\n${text}`;
    const rawSmall = article(`## 制度\n${AFTER}\n`);
    const file = F.recordPath(slug, dir);
    const write = record => fs.writeFileSync(file, JSON.stringify(record), 'utf8');
    const base = extra => ({ version: 1, slug, status: 'revise', logic_version: 'plan2-s11', corrections: [], ...extra });
    const opts = { callLLM: consistencyFake([]).fn, searchEvidence: () => [consistencyRef()], recordDir: dir, now };
    // 前回が failed。直した文（after）が今も本文に在る。直しの無い照合を3回続けても切らない。
    write(base({ consistency: { checked: false, failed: true, carried: true, corrections: [], afters: [AFTER], findings: [], dropped: 0 } }));
    for (let i = 1; i <= 3; i++) {
      const r = await F.checkArticle(rawSmall, opts);
      assert.equal(r.record.status, 'revise', `${i} 回目`);
      assert.equal(r.record.consistency?.failed, true, `${i} 回目`);
      assert.deepEqual(r.record.consistency.afters, [AFTER], `${i} 回目`);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).consistency.afters, [AFTER], '3 回目の記録にも afters が在る');

    // 前回が failed で、今回は別の文の直しで B が動いて成功した → failed と carried_failure を足し、今回の findings も残す。
    const OTHER = '所得が20万円を少し超えても、課税所得が0円になれば所得税はかかりません。';
    const rawBefore = article(BEFORE_BODY);
    write(base({ consistency: { checked: false, failed: true, carried: true, corrections: [], afters: [OTHER], findings: [], dropped: 0 } }));
    const moved = await F.checkArticle(rawBefore, { ...opts, callLLM: consistencyFake(twoRows).fn });
    assert.equal(moved.record.status, 'revise');
    assert.equal(moved.record.consistency.failed, true);
    assert.equal(moved.record.consistency.carried_failure, true);
    assert.equal(moved.record.consistency.findings.length, 2);
    assert.equal(moved.record.consistency.dropped, 0);
    assert.ok(moved.record.consistency.afters.includes(AFTER));
    assert.ok(moved.record.consistency.afters.includes(OTHER));
    const html = page.renderFactCheckSummary({ fact_check_status: 'revise', fact_check_blocking: true }, moved.record, moved.body);
    assert.ok(html.includes('直した内容と食い違う所を確かめられませんでした'));
    assert.ok(html.includes('（前回の照合から引き継ぎ）'));
    assert.ok(html.includes('直した内容と食い違う箇所 2 件'));
    assert.ok(html.includes(fixture.summary));

    // 今回 B が同じ直した文を含んで成功した → 引き継がない。
    write(base({ consistency: { checked: false, failed: true, carried: true, corrections: [], afters: [AFTER], findings: [], dropped: 0 } }));
    const verified = await F.checkArticle(rawBefore, { ...opts, callLLM: consistencyFake([]).fn });
    assert.equal(verified.record.consistency?.failed, undefined);
    assert.equal(verified.record.consistency?.carried_failure, undefined);
    assert.equal(verified.record.status, 'ok');

    // afters の無い古い記録は、id で引いて今までどおり引き継ぐ。
    write(base({
      corrections: [{ id: 'c22', before: BEFORE, after: AFTER }],
      consistency: { checked: false, failed: true, corrections: ['c22'], findings: [], dropped: 0 },
    }));
    const old = await F.checkArticle(rawSmall, opts);
    assert.equal(old.record.status, 'revise');
    assert.equal(old.record.consistency.failed, true);
    assert.equal(old.record.consistency.carried, true);
    assert.deepEqual(old.record.consistency.afters, [AFTER]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B', 'T31 照合できなかった回も前回の止めた理由を記録に写し、次の照合へ渡す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-carry31-'));
  try {
    const slug = 'carry31';
    const body = '本文の古い記述。\n';
    const raw = `---\ntitle: "題名"\nsummary: "${fixture.summary}"\nslug: "${slug}"\nrecommendation: "publish"\n---\n${body}`;
    const file = F.recordPath(slug, dir);
    const finding = { where: 'summary', text: fixture.summary, heading: '', s: null, correction_id: 'c1', reason: '矛盾します', suggestion: '直します' };
    const write = consistency => fs.writeFileSync(file, JSON.stringify({ version: 1, slug, status: 'revise', logic_version: 'plan2-s11', corrections: [], consistency }), 'utf8');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const opts = { callLLM: fakeAI({}).fn, searchEvidence: () => [], recordDir: dir, now };
    write({ checked: true, corrections: [], findings: [finding], dropped: 0 });
    const normal = await F.checkArticle(raw, opts);
    assert.equal(normal.record.status, 'revise');
    assert.equal(normal.record.consistency.findings.length, 1);

    // API が全部失敗して not_run。保存する記録に前回の consistency を carried で写す。
    const failed = await F.checkArticle(raw, { ...opts, callLLM: async () => { throw new Error('偽のAPI障害'); } });
    assert.equal(failed.record.status, 'not_run');
    assert.ok(failed.record.summary.includes('照合を実施できませんでした'));
    const savedFailed = read();
    assert.equal(savedFailed.status, 'not_run');
    assert.ok(savedFailed.summary.includes('照合を実施できませんでした'), '要約は not_run のまま');
    assert.equal(savedFailed.consistency.carried, true);
    assert.equal(savedFailed.consistency.findings.length, 1);
    assert.equal(savedFailed.consistency.findings[0].carried, true);
    assert.deepEqual(savedFailed.consistency.afters, []);
    assert.ok(failed.content.includes('fact_check_blocking: true'), '止めるかは not_run の扱いのまま');

    // 次のふつうの照合で、同じ文の指摘を引き継いで revise になる。
    const again = await F.checkArticle(raw, opts);
    assert.equal(again.record.status, 'revise');
    assert.equal(again.record.consistency.findings.length, 1);
    assert.equal(again.record.consistency.findings[0].carried, true);

    // 照合を無効にした回も同じく写す。状態と要約は変えない。
    const disabled = await F.checkArticle(raw, { ...opts, enabled: false });
    assert.equal(disabled.record.status, 'not_run');
    const savedDisabled = read();
    assert.ok(savedDisabled.summary.includes('照合を無効にしています'));
    assert.equal(savedDisabled.consistency.carried, true);
    assert.equal(savedDisabled.consistency.findings[0].carried, true);

    // ふつうの照合で文字が無くなった回は写さない（古い指摘を戻さない）。
    const gone = await F.checkArticle(raw.replace(fixture.summary, '別の要約です。'), opts);
    assert.equal(gone.record.status, 'ok');
    assert.equal(gone.record.consistency, undefined);
    assert.equal(read().consistency, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 画面 ────────────────────────────────────────────────────────────
const screenBody = '確認用の本文です。';
const screenMeta = { fact_check_status: 'revise', fact_check_blocking: true };
function screenRecord(consistency) {
  return { version: 1, slug: 'screen', status: 'revise', body_sha256: F.bodyHash(screenBody),
    corrections: [], remaining: [], review_items: [], ...(consistency === undefined ? {} : { consistency }) };
}

test('画面', 'T17 直した内容と食い違う箇所を要点と詳細に出し、AI の文をエスケープする', () => {
  const findings = [
    { where: 'title', s: null, heading: '', text: '題名の<記述>', correction_id: 'c1', reason: '<script>alert(1)</script>', suggestion: '書き方<script>' },
    { where: 'summary', s: null, heading: '', text: '要約の記述', correction_id: 'c1', reason: '矛盾します', suggestion: '直します' },
    { where: 'body', s: 5, heading: '見出しA', text: '本文の記述', correction_id: 'c1', reason: '矛盾します', suggestion: '直します' },
  ];
  const record = screenRecord({ checked: true, corrections: ['c1'], findings, dropped: 0 });
  for (const html of [page.renderFactCheckSummary(screenMeta, record, screenBody), page.renderFactCheck(screenMeta, record, screenBody)]) {
    assert.ok(html.includes('直した内容と食い違う箇所 3 件'));
    assert.ok(html.includes('題名'));
    assert.ok(html.includes('要約'));
    assert.ok(html.includes('本文（見出しA）'));
    assert.ok(html.includes('書き方の例: '));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
  }
  const failed = screenRecord({ checked: false, failed: true, corrections: ['c1'], findings: [], dropped: 0 });
  for (const html of [page.renderFactCheckSummary(screenMeta, failed, screenBody), page.renderFactCheck(screenMeta, failed, screenBody)]) {
    assert.ok(html.includes('直した内容と食い違う所を確かめられませんでした'));
  }
  const old = screenRecord(undefined);
  for (const html of [page.renderFactCheckSummary(screenMeta, old, screenBody), page.renderFactCheck(screenMeta, old, screenBody)]) {
    assert.ok(!html.includes('直した内容と食い違う'));
  }
});

test('画面', 'T18 実際に入った直しだけを数える', () => {
  const record = { ...screenRecord(undefined), corrections: fixture.screen_counts.corrections, status: 'revise' };
  const html = page.renderFactCheckSummary(screenMeta, record, screenBody);
  assert.ok(html.includes('直した 1 件・資料が無く案内に変えた 2 件・採れなかった直し 2 件'));
});

async function main() {
  let passed = 0, failed = 0;
  for (const { group, name, run } of tests) {
    try { await run(); passed++; console.log(`PASS ${group} ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${group} ${name}: ${error.stack}`); }
  }
  console.log(`同じ文の直し・直した後の食い違い・画面: PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

main();
