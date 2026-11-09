'use strict';

// 再照合で誤りが残った自動修正を、もう 1 回だけ直し、だめなら元の文に戻す（S1〜S8）。
// 通信は偽 LLM と偽の資料だけで行い、実例は docs/codex-tasks/fact-repair-retry/fixtures を使う。
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const matter = require('gray-matter');
const H = require('./fact-pages-test-helpers');
const F = H.F;
const page = require('../../../netlify/functions/review-page');
const fixtures = require('../../../docs/codex-tasks/fact-repair-retry/fixtures/failed-fixes.json');
const REVERTED = F.REVERTED_FIX_REVIEW;
const now = new Date('2026-11-09T00:00:00Z');
const options = { now, enabled: true, batch: false, repair: true };

let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.stack}`); }
}
const ref = (id, title, text) => ({ id, kind: 'taxanswer', title, url: `https://example.jp/${encodeURIComponent(id)}`, text, law_version: '令和8年4月1日現在法令等' });
const rows = text => H.bodyText(text).split('\n');
const row = (sentence, type, subject, claim) => ({ sentence, type, subject, claim });
const budget = record => {
  const count = tasks => record.calls.filter(c => tasks.includes(c.task)).length;
  const repair = count(['repair', 'again_repair']);
  const recheck = count(['recheck_extract', 'again_extract']);
  const retries = {
    retry_repair: count(['retry_repair']),
    again_retry_repair: count(['again_retry_repair']),
    recheck_retry_extract: count(['recheck_retry_extract']),
    again_retry_extract: count(['again_retry_extract']),
  };
  assert.ok(repair <= 2, `修正の呼び出しが 2 回を超えた: ${repair}`);
  assert.ok(recheck <= 2, `再照合が 2 回を超えた: ${recheck}`);
  for (const [task, n] of Object.entries(retries)) assert.ok(n <= 1, `${task} の聞き直しが 1 回を超えた: ${n}`);
  return { repair, recheck };
};

// ── #755（インフルエンサーの確定申告） ─────────────────────────────
const f755 = fixtures.pr755_c33;
const ORIG_755 = f755.finding.sentence;
const FIRST_755 = f755.first_replacement;
const SECOND_755 = '| 消費税 | 前々年の売上と、前年1月1日〜6月30日の売上（前々年が1,000万円以下でも、この期間が1,000万円を超えると免税にならない。給与等支払額で判定することもできる）、インボイス登録の有無 |';
const BODY_755 = `## 自分で確認できるチェックリスト\n${ORIG_755}\n消費税の免税事業者の判定を確認します。\n`;
const REF_755 = [
  f755.finding.evidence_id,
  f755.recheck.evidence_id,
];
function pr755({ second = SECOND_755, secondStatus = '裏付けあり', failSecondRepair = false, failSecondJudge = false } = {}) {
  const calls = [], repairs = [], judges = [];
  const fn = async request => {
    calls.push(request);
    if (request.task === 'extract') {
      if (request.user.includes(second) && second !== FIRST_755) return [row(second, '判定', '消費税の納税義務', '給与等支払額でも免税事業者と判定できる')];
      if (request.user.includes(FIRST_755)) return [row(FIRST_755, '判定', '消費税の特定期間', '特定期間の売上で免税か判定する')];
      if (request.user.includes(ORIG_755)) return [row(ORIG_755, '判定', '消費税の納税義務', '前々年の売上とインボイス登録で判断する')];
      return [];
    }
    if (request.task === 'judge') {
      const data = H.readPayload(request);
      if (failSecondJudge && data.claims.some(c => c.sentence === second)) throw new Error('2回目の再照合の判定の失敗');
      judges.push(data);
      return data.claims.map(c => {
        if (c.sentence === ORIG_755) return { id: c.id, status: '食い違い', quote: f755.finding.quote, correct: f755.finding.correct, evidence_id: f755.finding.evidence_id };
        if (c.sentence === FIRST_755) return { id: c.id, status: '食い違い', quote: f755.recheck.quote, correct: f755.recheck.correct, evidence_id: f755.recheck.evidence_id };
        if (c.sentence === second) return secondStatus === '裏付けあり'
          ? { id: c.id, status: '裏付けあり', quote: f755.recheck.quote, evidence_id: f755.recheck.evidence_id }
          : { id: c.id, status: '食い違い', quote: f755.recheck.quote, correct: f755.recheck.correct, evidence_id: f755.recheck.evidence_id };
        return { id: c.id, status: '資料なし' };
      });
    }
    if (request.task === 'repair') {
      const data = JSON.parse(request.user);
      repairs.push(data);
      if (failSecondRepair && data.corrections.some(c => c.earlier_fix)) throw new Error('2回目の修正の失敗');
      return data.corrections.map(c => ({ id: c.id, replacement: c.earlier_fix ? second : FIRST_755 }));
    }
    throw new Error('未定義の呼び出し: ' + request.task);
  };
  return { fn, calls, repairs, judges };
}
function refs755() {
  return [ref(f755.finding.evidence_id, '消費税法第9条の2', f755.finding.quote),
    ref(f755.recheck.evidence_id, '消費税の質疑応答', f755.recheck.quote)];
}
async function run755(fake) {
  return F.checkFacts(BODY_755, { ...options, callLLM: fake.fn, searchEvidence: () => refs755(), loadEvidenceText: e => e.text });
}

// ── #744（一人親方の白色・青色） ────────────────────────────────
const f744 = fixtures.pr744_c37;
const ORIG_744 = f744.finding.sentence;
const FIRST_744 = f744.first_replacement;
const SECOND_744 = '白色申告でも、変動所得の損失や被災事業用資産の損失から生じた純損失は、3年間繰り越して控除できます。';
const BODY_744 = `## 赤字が3年繰り越せるのは青色だけ\n${ORIG_744}\n`;
function pr744({ secondStatus = '裏付けあり' } = {}) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    if (request.task === 'extract') {
      if (request.user.includes(SECOND_744)) return [row(SECOND_744, '期限', '純損失の繰越控除', '白色申告でも3年間繰り越せる')];
      if (request.user.includes(FIRST_744)) return [row(FIRST_744, '期限', '純損失の繰越控除', '赤字を3年繰り越せる')];
      if (request.user.includes(ORIG_744)) return [row(ORIG_744, '判定', '純損失の繰越控除', '白色申告では損失の繰越ができない')];
      return [];
    }
    if (request.task === 'judge') {
      const data = H.readPayload(request);
      return data.claims.map(c => {
        if (c.sentence === ORIG_744) return { id: c.id, status: '食い違い', quote: f744.finding.quote, correct: f744.finding.correct, evidence_id: f744.finding.evidence_id };
        if (c.sentence === FIRST_744) return { id: c.id, status: '食い違い', quote: f744.recheck.quote, correct: f744.recheck.correct, evidence_id: f744.recheck.evidence_id };
        if (c.sentence === SECOND_744) return secondStatus === '裏付けあり'
          ? { id: c.id, status: '裏付けあり', quote: f744.recheck.quote, evidence_id: f744.recheck.evidence_id }
          : { id: c.id, status: '食い違い', quote: f744.recheck.quote, correct: f744.recheck.correct, evidence_id: f744.recheck.evidence_id };
        return { id: c.id, status: '資料なし' };
      });
    }
    if (request.task === 'repair') {
      const data = JSON.parse(request.user);
      return data.corrections.map(c => ({ id: c.id, replacement: c.earlier_fix ? SECOND_744 : FIRST_744 }));
    }
    throw new Error('未定義の呼び出し: ' + request.task);
  };
  return { fn, calls };
}
const refs744 = () => [ref(f744.finding.evidence_id, '所得税法第70条', `${f744.finding.quote}\n…\n${f744.recheck.quote}`)];
async function run744(fake) {
  return F.checkFacts(BODY_744, { ...options, callLLM: fake.fn, searchEvidence: refs744, loadEvidenceText: e => e.text });
}

async function main() {
  await test('T1（R1）食い違いの指示に例外・選択肢を落とさない文があり、期限・番号・資料なしの指示は変えない', () => {
    const mismatch = F.repairInstructions([{ ...f755.finding, keep: [] }])[0].instruction;
    assert.ok(mismatch.includes('例外（「〜の場合を除く」「ただし〜」など）'));
    assert.ok(mismatch.includes('選択肢'));
    assert.ok(mismatch.endsWith('。quote・quote_notes に例外（「〜の場合を除く」「ただし〜」など）や、別の判定のしかた・選択肢（「〜に代えて〜で判定することもできる」「いずれかを選べる」など）が書かれているときは、それを落とさずに書く'));
    const deadline = F.repairInstructions([{ ...f744.finding, status: '期限の書き漏れ' }])[0].instruction;
    assert.equal(deadline, 'この制度の説明に、根拠の適用期限を1文で足す');
    const number = F.repairInstructions([{ ...f755.finding, status: '資料なし', type: '番号' }])[0].instruction;
    assert.equal(number, '資料が無い番号を消し、番号を推測せず内容だけにする');
    const generic = F.repairInstructions([{ ...f755.finding, status: '資料なし', type: '判定' }])[0].instruction;
    assert.ok(generic.startsWith('資料が無い具体的な要件・金額・割合・期限・適用年・手続・判定を外し'));
  });

  await test('T2（S2）1 回目の再照合が全部裏付けありなら、2 回目をせず今と同じ結果', async () => {
    const original = 'この制度は届出が必要です。';
    const correct = 'この制度は承認が必要です。';
    const body = `## 制度\n${original}\n`;
    const calls = [];
    const fake = async request => {
      calls.push(request);
      if (request.task === 'extract') { const sentence = request.user.includes(correct) ? correct : original; return [row(sentence, '判定', '試験制度', sentence)]; }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => c.sentence === correct
        ? { id: c.id, status: '裏付けあり', quote: correct, evidence_id: 'doc' }
        : { id: c.id, status: '食い違い', quote: correct, correct, evidence_id: 'doc' });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: correct }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, callLLM: fake, searchEvidence: () => [ref('doc', '試験資料', correct)], loadEvidenceText: e => e.text });
    budget(r.record);
    assert.equal(calls.filter(c => c.task === 'repair').length, 1);
    assert.ok(!r.record.calls.some(c => c.task.startsWith('again_')));
    assert.ok(!r.record.calls.some(c => c.task === 'retry_repair'));
    assert.equal(r.record.repair_retry, undefined);
    assert.equal(r.record.corrections[0].reverted, undefined);
    assert.equal(r.record.corrections[0].retry, undefined);
    assert.equal(r.record.status, 'ok');
    assert.ok(r.body.includes(correct));
    // 2 回目が動かない記事は、修正の記録・再照合・人が確かめる箇所・本文・状態が今と同じ。
    const [claim] = r.record.claims;
    const evidence = { ...ref('doc', '試験資料', correct), text_ranges: [[0, correct.length]] };
    assert.deepEqual(JSON.parse(JSON.stringify(r.record.corrections)),
      JSON.parse(JSON.stringify([{ ...claim, keep: [], before: original, after: correct, generalized: false, resolved: true }])));
    assert.deepEqual(JSON.parse(JSON.stringify(r.record.rechecked)),
      JSON.parse(JSON.stringify([{ ...claim, sentence: correct, claim: correct, status: '裏付けあり', quote: correct, correct: '', evidence_id: 'doc', evidence: [evidence] }])));
    assert.deepEqual(r.record.review_items, []);
    assert.equal(r.body, `## 制度\n${correct}\n`);
  });

  await test('T3（R2〜R4）2 回目で直り、earlier_fix と again_ の記録が残る', async () => {
    const fake = pr755();
    const r = await run755(fake);
    const { repair, recheck } = budget(r.record);
    assert.equal(repair, 2); assert.equal(recheck, 2);
    assert.equal(r.record.status, 'ok');
    assert.ok(r.body.includes(SECOND_755));
    assert.ok(!r.body.includes(FIRST_755));
    assert.ok(!r.body.includes(ORIG_755));
    const correction = r.record.corrections.find(c => c.before === ORIG_755);
    assert.equal(correction.after, SECOND_755); assert.equal(correction.resolved, true);
    assert.deepEqual(correction.retry, { status: 'kept', first_after: FIRST_755 });
    assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 1, reverted: 0 });
    assert.ok(r.record.calls.some(c => c.task === 'again_repair'));
    assert.ok(r.record.calls.some(c => c.task === 'again_extract'));
    assert.ok(r.record.calls.some(c => c.task === 'again_judge'));
    assert.ok(!r.record.calls.some(c => c.task.startsWith('again_recheck_')));
    assert.ok(!r.record.rechecked.some(c => c.sentence === FIRST_755));
    const second = fake.repairs[1].corrections[0];
    assert.deepEqual(second.earlier_fix, [{ before: ORIG_755, correct: f755.finding.correct, quote: f755.finding.quote }]);
    assert.ok(second.instruction.includes('earlier_fix は 1 回目の修正で直した点です。その正しい内容は保ったまま、correct の指摘に合わせて直す'));
    assert.equal(fake.repairs[0].corrections[0].earlier_fix, undefined);
  });

  await test('T4（S3〜S6）2 回目も食い違うと元の文に戻し、記録と承認画面の元を残す', async () => {
    const fake = pr755({ secondStatus: '食い違い' });
    const r = await run755(fake);
    const { repair } = budget(r.record);
    assert.equal(repair, 2);
    assert.equal(r.record.status, 'revise');
    assert.ok(rows(r.body).includes(ORIG_755));
    assert.ok(!r.body.includes(FIRST_755)); assert.ok(!r.body.includes(SECOND_755));
    const correction = r.record.corrections.find(c => c.before === ORIG_755);
    assert.equal(correction.after, ''); assert.equal(correction.reverted, true); assert.equal(correction.resolved, false);
    assert.equal(correction.proposal, SECOND_755);
    assert.equal(correction.reason, '再照合で誤りが残ったため、元の文に戻しました');
    assert.equal(correction.retry.status, 'reverted');
    assert.equal(correction.retry.first_after, FIRST_755);
    assert.equal(correction.retry.second_after, SECOND_755);
    assert.equal(correction.retry.cause, '2 回目の再照合でも誤りが残りました');
    assert.ok(r.record.remaining.some(c => c.sentence === ORIG_755 && c.status === '食い違い'));
    const items = r.record.review_items.filter(c => c.status === REVERTED);
    assert.equal(items.length, 1);
    assert.equal(items[0].proposal, SECOND_755);
    assert.ok(items[0].recheck.length >= 1);
    assert.ok(items[0].recheck.every(c => ['status', 'claim', 'correct', 'quote', 'evidence_id'].every(k => Object.hasOwn(c, k))));
    assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 0, reverted: 1 });
    assert.ok(r.record.summary.includes('・元の文に戻した 1'));
    const raw = `---\ntitle: "再照合の試験"\nslug: "repair-retry-755"\nrecommendation: "publish"\n---\n${BODY_755}`;
    const applied = matter(F.applyFactResult(raw, r)).data;
    assert.equal(applied.fact_check_blocking, true);
    assert.equal(applied.recommendation, 'revise');
  });

  await test('T5（R5）2 回目の置き換えを歯止めで採れず戻す。再照合は呼ばない', async () => {
    const bad = SECOND_755.replace('1,000万円以下', '9,999万円以下');
    const fake = pr755({ second: bad });
    const r = await run755(fake);
    budget(r.record);
    assert.ok(!r.record.calls.some(c => c.task === 'again_extract'));
    assert.ok(!r.record.calls.some(c => c.task === 'again_judge'));
    const correction = r.record.corrections.find(c => c.before === ORIG_755);
    assert.equal(correction.reverted, true); assert.equal(correction.after, '');
    assert.equal(correction.retry.status, 'reverted');
    assert.equal(correction.retry.cause, '2 回目の修正を採れませんでした（根拠の正しい内容に無い数字を足しています）');
    assert.equal(correction.proposal, FIRST_755);
    assert.ok(rows(r.body).includes(ORIG_755));
  });

  await test('T6（S7）2 回目の修正の例外は戻す側に倒し、照合全体を未実施にしない', async () => {
    const fake = pr755({ failSecondRepair: true });
    const r = await run755(fake);
    budget(r.record);
    assert.equal(r.record.status, 'revise');
    assert.ok(r.body.includes(ORIG_755));
    assert.equal(r.record.repair_warning, '再照合で誤りが残った修正を元の文に戻しました（2 回目を実施できませんでした）');
    const correction = r.record.corrections.find(c => c.before === ORIG_755);
    assert.equal(correction.reverted, true);
    assert.equal(correction.retry.cause, '2 回目の修正・再照合を実施できませんでした');

    // 2 回目の再照合の判定（again_judge）の途中で失敗しても、戻す側に倒す。
    const judgeFail = pr755({ failSecondJudge: true });
    const r2 = await run755(judgeFail);
    budget(r2.record);
    assert.equal(r2.record.status, 'revise');
    assert.equal(r2.body, BODY_755);
    assert.equal(r2.record.repair_warning, '再照合で誤りが残った修正を元の文に戻しました（2 回目を実施できませんでした）');
    assert.ok(r2.record.calls.some(c => c.task === 'again_judge'));
    const c2 = r2.record.corrections.find(c => c.before === ORIG_755);
    assert.equal(c2.reverted, true); assert.equal(c2.after, '');
    assert.equal(c2.retry.cause, '2 回目の修正・再照合を実施できませんでした');
  });

  await test('T7（R2・R5）片方だけ戻し、もう片方の修正は本文に残る', async () => {
    const A = '制度Aでは届出が必要です。', B = '制度Bでは承認が必要です。';
    const AC = '制度Aでは申請が必要です。', BC = '制度Bでは届出が必要です。', B2 = '制度Bでは届出と確認が必要です。';
    const body = `## 制度\n${A}\n${B}\n`;
    const fn = async request => {
      if (request.task === 'extract') {
        if (request.user.includes(B2)) return [row(B2, '判定', '制度B', 'Bは届出と確認')];
        if (request.user.includes(AC)) return [row(AC, '判定', '制度A', 'Aは申請'), row(BC, '判定', '制度B', 'Bは届出')];
        return [row(A, '判定', '制度A', 'Aは届出'), row(B, '判定', '制度B', 'Bは承認')];
      }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
        if (c.sentence === A) return { id: c.id, status: '食い違い', quote: AC, correct: AC, evidence_id: 'doc' };
        if (c.sentence === B) return { id: c.id, status: '食い違い', quote: BC, correct: BC, evidence_id: 'doc' };
        if (c.sentence === AC) return { id: c.id, status: '裏付けあり', quote: AC, evidence_id: 'doc' };
        if (c.sentence === BC) return { id: c.id, status: '食い違い', quote: BC, correct: B2, evidence_id: 'doc' };
        if (c.sentence === B2) return { id: c.id, status: '食い違い', quote: BC, correct: B2, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.sentence === A ? AC : c.earlier_fix ? B2 : BC }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, callLLM: fn, searchEvidence: () => [ref('doc', '試験資料', `${AC}\n${BC}\n${B2}\n`)], loadEvidenceText: e => e.text });
    const { repair } = budget(r.record);
    assert.equal(repair, 2);
    assert.equal(r.record.status, 'revise');
    assert.ok(r.body.includes(AC)); assert.ok(r.body.includes(B)); assert.ok(!r.body.includes(B2));
    const a = r.record.corrections.find(c => c.before === A), b = r.record.corrections.find(c => c.before === B);
    assert.equal(a.after, AC); assert.equal(a.resolved, true); assert.equal(a.reverted, undefined);
    assert.equal(b.after, ''); assert.equal(b.reverted, true);
    assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 0, reverted: 1 });
  });

  await test('H1（2 回目で直したとき、手を付けなかった文の止める行も残す）', async () => {
    const S = '制度Bでは届出が必要です。';
    const X1_FIRST = '制度Bでは申請が必要です。';
    const X1_SECOND = '届出の期限は10日以内です。';
    const X1 = X1_FIRST + X1_SECOND;
    const X2_FIRST = '制度Bでは承認が必要です。';
    const X2 = X2_FIRST + X1_SECOND;
    const body = `## 制度\n${S}\n`;
    const fn = async request => {
      if (request.task === 'extract') {
        if (request.user.includes(X2_FIRST) && request.user.includes(X1_SECOND)) return [{ s: 2, ...row(X2_FIRST, '判定', '制度B', X2_FIRST) }, { s: 4, ...row(X1_SECOND, '期限', '届出期限', X1_SECOND) }];
        if (request.user.includes(X1_FIRST) && request.user.includes(X1_SECOND)) return [{ s: 2, ...row(X1_FIRST, '判定', '制度B', X1_FIRST) }, { s: 4, ...row(X1_SECOND, '期限', '届出期限', X1_SECOND) }];
        return [{ s: 2, ...row(S, '判定', '制度B', S) }];
      }
      if (request.task === 'judge') {
        const data = H.readPayload(request);
        return data.claims.map(c => {
          if (c.sentence === S) return { id: c.id, status: '食い違い', quote: X1_FIRST, correct: X1, evidence_id: 'doc' };
          if (c.sentence === X1_FIRST) return { id: c.id, status: '食い違い', quote: X2_FIRST, correct: X2_FIRST, evidence_id: 'doc' };
          if (c.sentence === X2_FIRST) return { id: c.id, status: '裏付けあり', quote: X2_FIRST, evidence_id: 'doc' };
          if (c.sentence === X1_SECOND) return { id: c.id, status: '資料なし', quote: '', evidence_id: 'doc' };
          return { id: c.id, status: '資料なし' };
        });
      }
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.sentence === S ? X1 : X2_FIRST }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, callLLM: fn,
      searchEvidence: () => [ref('doc', '試験資料', `${X1_FIRST}\n${X2_FIRST}\n`)], loadEvidenceText: e => e.text });
    assert.equal(budget(r.record).repair, 2);
    // 1 文目は 2 回目で直り、2 文目の資料なし（数字）は再照合の結果として残って承認を止める。
    assert.equal(r.record.status, 'revise');
    assert.ok(r.body.includes(X2)); assert.ok(!r.body.includes(S)); assert.ok(!r.body.includes(X1_FIRST));
    assert.ok(r.record.remaining.some(c => c.sentence === X1_SECOND && c.status === '資料なし'));
    assert.ok(r.record.rechecked.some(c => c.sentence === X1_SECOND && c.status === '資料なし'));
    assert.ok(!r.record.rechecked.some(c => c.sentence === X1_FIRST));
    const correction = r.record.corrections.find(c => c.before === S);
    assert.equal(correction.after, X2);
    assert.equal(correction.retry.status, 'kept');
    assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 1, reverted: 0 });
  });

  await test('T8（S8）条件確認だけの指摘と、戻した食い違いが同じ記事で元の文に戻る', async () => {
    const old = process.env.FACT_CHECK_WRITER_MATERIALS;
    process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
    try {
      const A = '18歳以上の直系卑属または推定相続人が対象です。';
      const AF = '18歳以上の直系卑属である推定相続人または孫が対象です。';
      const B = '変更には届出が必要です。', BC = '変更には承認が必要です。', B2 = '変更には承認と確認が必要です。';
      const body = `## 制度\n${A}\n${B}\n`;
      const source = ref('gift', '相続時精算課税', `${AF}\n${BC}\n${B2}\n`);
      const fn = async request => {
        if (request.task === 'extract') {
          if (request.user.includes(B2)) return [row(B2, '手続', '棚卸資産', 'Bは承認と確認')];
          if (request.user.includes(AF) || request.user.includes(BC)) return [row(AF, '要件', '相続時精算課税'), row(BC, '手続', '棚卸資産')];
          return [row(A, '要件', '相続時精算課税'), row(B, '手続', '棚卸資産')];
        }
        if (request.task === 'condition_check') return { verdict: '不一致', conditions: [{ article: '直系卑属または推定相続人', source: '直系卑属である推定相続人または孫', match: '不一致' }], correct: AF };
        if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
          if (c.sentence === A) return { id: c.id, status: '裏付けあり', quote: AF, evidence_id: 'gift' };
          if (c.sentence === B || c.sentence === BC || c.sentence === B2) return { id: c.id, status: c.sentence === BC && request.user.includes('retry') ? c.status : (c.sentence === B ? '食い違い' : c.sentence === BC ? '食い違い' : '食い違い'), quote: BC, correct: c.sentence === B ? BC : B2, evidence_id: 'gift' };
          if (c.sentence === AF) return { id: c.id, status: '資料なし' };
          return { id: c.id, status: '資料なし' };
        });
        if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
          replacement: c.sentence === A ? AF : c.earlier_fix ? B2 : BC }));
        throw new Error('未定義: ' + request.task);
      };
      const r = await F.checkFacts(body, { ...options, writer_materials: ['ta:4103'], resolvedWriterMaterials: [source],
        callLLM: fn, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text });
      budget(r.record);
      assert.equal(r.record.status, 'revise');
      assert.ok(r.body.includes(A)); assert.ok(r.body.includes(B));
      assert.ok(!r.body.includes(AF)); assert.ok(!r.body.includes(BC)); assert.ok(!r.body.includes(B2));
      assert.ok(r.record.review_items.some(c => c.status === '条件の違いを要確認'));
      assert.ok(r.record.review_items.some(c => c.status === REVERTED));
      const a = r.record.corrections.find(c => c.before === A);
      assert.equal(a, undefined);
      const b = r.record.corrections.find(c => c.before === B);
      assert.equal(b.reverted, true); assert.equal(b.after, '');
    } finally {
      if (old === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS; else process.env.FACT_CHECK_WRITER_MATERIALS = old;
    }
  });

  await test('M1（止めない指摘だけの文は 2 回目の対象にしない）', async () => {
    const old = process.env.FACT_CHECK_WRITER_MATERIALS;
    process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
    try {
      const S = 'この制度の手続は所定の用紙で行います。';
      const GEN = 'この制度の手続は所定の用紙で行うため、詳しくは国税庁のページで確認してください。';
      const filler = ['この制度の金額は10万円です。', 'この制度の金額は20万円です。', 'この制度の金額は30万円です。', 'この制度の金額は40万円です。', 'この制度の金額は50万円です。'];
      const body = `## 制度\n${S}\n${filler.join('\n')}\n`;
      const source = ref('gift', '制度資料', `${GEN}\n${S}\n${filler.join('\n')}\n`);
      const fn = async request => {
        if (request.task === 'extract') {
          if (request.user.includes(GEN)) return [{ s: 2, ...row(GEN, '手続', '試験制度', GEN) }];
          return [{ s: 2, ...row(S, '手続', '試験制度', S) },
            ...filler.map((sentence, i) => ({ s: 3 + i, ...row(sentence, '金額', '試験制度', sentence) }))];
        }
        if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
          if (c.sentence === S) return { id: c.id, status: '資料なし' };
          if (c.sentence === GEN) return { id: c.id, status: '食い違い', quote: GEN, correct: S, evidence_id: 'gift' };
          return { id: c.id, status: '裏付けあり', quote: c.sentence, evidence_id: 'gift' };
        });
        if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: GEN }));
        throw new Error('未定義: ' + request.task);
      };
      const r = await F.checkFacts(body, { ...options, writer_materials: ['ta:4103'], resolvedWriterMaterials: [source],
        callLLM: fn, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text });
      budget(r.record);
      // 止めない指摘だけの文は 2 回目をせず、置き換えが残って再照合の誤りで止まる。
      assert.ok(!r.record.calls.some(c => c.task.startsWith('again_')));
      assert.equal(r.record.calls.filter(c => c.task === 'repair').length, 1);
      assert.equal(r.record.status, 'revise');
      assert.ok(r.body.includes(GEN));
      assert.ok(r.record.rechecked.some(c => c.sentence === GEN && c.status === '食い違い'));
      assert.equal(r.record.repair_retry, undefined);
    } finally {
      if (old === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS; else process.env.FACT_CHECK_WRITER_MATERIALS = old;
    }
  });

  await test('T9（期限）足した期限の文が再照合で食い違えば、元の文だけに戻る', async () => {
    const original = '住宅取得等資金の贈与の非課税制度があります。';
    const deadline = 'この制度は令和8年12月31日までの贈与が対象です。';
    const bad = 'この制度は令和9年12月31日までの贈与が対象です。';
    const second = 'この制度の対象は令和9年12月31日までの贈与です。';
    const body = `## 制度\n${original}\n`;
    const fn = async request => {
      if (request.task === 'extract') {
        if (request.user.includes(second)) return [row(second, '期限', '住宅取得等資金', second)];
        if (request.user.includes(deadline)) return [row(deadline, '期限', '住宅取得等資金', deadline)];
        return [row(original, '期限', '住宅取得等資金', original)];
      }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
        if (c.sentence === original) return { id: c.id, status: '期限の書き漏れ', quote: deadline, correct: deadline, evidence_id: 'doc2' };
        return { id: c.id, status: '食い違い', quote: bad, correct: bad, evidence_id: 'doc' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.earlier_fix ? second : original + deadline }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, callLLM: fn, searchEvidence: () => [ref('doc', '試験資料', `${bad}\n`), ref('doc2', '別の資料', `${deadline}\n`)], loadEvidenceText: e => e.text });
    budget(r.record);
    assert.equal(r.body, body);
    assert.ok(!r.body.includes(deadline)); assert.ok(!r.body.includes(second));
    const correction = r.record.corrections.find(c => c.before === original);
    assert.equal(correction.reverted, true);
    assert.equal(correction.retry.cause, '2 回目の再照合でも誤りが残りました');
  });

  await test('T10（#744）2 回目で言い回しを直して残す形と、2 回目もだめで戻す形', async () => {
    const kept = await run744(pr744());
    budget(kept.record);
    assert.equal(kept.record.status, 'ok');
    assert.ok(kept.body.includes(SECOND_744)); assert.ok(!kept.body.includes(FIRST_744)); assert.ok(!kept.body.includes(ORIG_744));
    const k = kept.record.corrections.find(c => c.before === ORIG_744);
    assert.equal(k.after, SECOND_744); assert.equal(k.resolved, true); assert.deepEqual(k.retry, { status: 'kept', first_after: FIRST_744 });

    const reverted = await run744(pr744({ secondStatus: '食い違い' }));
    budget(reverted.record);
    assert.equal(reverted.record.status, 'revise');
    assert.ok(rows(reverted.body).includes(ORIG_744));
    assert.ok(!reverted.body.includes(FIRST_744)); assert.ok(!reverted.body.includes(SECOND_744));
    const r = reverted.record.corrections.find(c => c.before === ORIG_744);
    assert.equal(r.after, ''); assert.equal(r.reverted, true); assert.equal(r.proposal, SECOND_744);
    assert.equal(r.retry.cause, '2 回目の再照合でも誤りが残りました');
    assert.ok(reverted.record.review_items.some(c => c.status === REVERTED));
  });

  await test('T11（R7・M2）保存の形の記録でも、戻した文・採らなかった修正案・再照合の引用を出し、危険な文字を実体化しない', () => {
    assert.equal(page.REVERTED_FIX_REVIEW, F.REVERTED_FIX_REVIEW);
    assert.equal(REVERTED, '自動修正を元の文に戻した（修正案を確かめる）');
    const quote = 'なお、国外事業者以外の事業者は<script>alert("quote")</script>とされています。';
    const record = {
      status: 'revise', corrections: [{ id: 'c1', before: '元の文です。', after: '', reverted: true, resolved: false,
        proposal: '<script>alert("proposal")</script>', status2: '食い違い' }],
      remaining: [], review_items: [{ id: 'c1', sentence: '元の文です。', heading: '制度', type: '判定', subject: '試験制度セ', claim: '主張',
        status: REVERTED, proposal: '<script>alert("proposal")</script>',
        recheck: [{ status: '食い違い', claim: '主張', correct: '<script>alert("correct")</script>', quote, evidence_id: 'e1' }],
        evidence: [{ id: 'e1', title: '資料', url: 'https://example.jp/e1' }] },
      { id: 'c9', sentence: 'AI項目の文です。', heading: '制度', type: '金額', subject: '試験制度', claim: '主張',
        status: 'AI は裏付けあり（数字は機械で確かめられなかった）', rejected_answer: { evidence: 'e2', quote: '引用です。' },
        evidence: [{ id: 'e2', title: '資料2', url: 'https://example.jp/e2' }] }],
    };
    // 保存した記録（compactRecord）でも、再照合の引用が画面に出る。
    const saved = F.compactRecord(record);
    const html = page.renderFactCheck({ fact_check_status: 'revise', fact_check_summary: '要約' }, saved);
    assert.ok(html.includes('元の文に戻しました（採らなかった修正案は人が確かめる箇所に載せています）'));
    assert.ok(html.includes('再照合後も未解決です'));
    assert.ok(html.includes('採らなかった修正案:'));
    assert.ok(html.includes('再照合の指摘（食い違い）:'));
    assert.ok(html.includes('なお、国外事業者以外の事業者は'));
    assert.ok(html.includes(REVERTED));
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('&lt;script&gt;alert'));
    const section = html.slice(html.indexOf('<details><summary>人が確かめる箇所'));
    assert.ok(section.indexOf(REVERTED) >= 0 && section.indexOf(REVERTED) < section.indexOf('AI は裏付けあり'), '戻した修正の項目を先頭に置く');
  });

  await test('T12（使い回し）T4 の記録を前回の記録として差し戻し後の照合が使い回せる', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-retry-cache-'));
    try {
      const raw = `---\ntitle: "再照合の試験"\nslug: "repair-retry-cache"\nrecommendation: "publish"\n---\n${BODY_755}`;
      const firstFake = pr755({ secondStatus: '食い違い' });
      const first = await F.checkArticle(raw, { ...options, callLLM: firstFake.fn, searchEvidence: () => refs755(), loadEvidenceText: e => e.text, recordDir: dir });
      assert.equal(matter(first.content).data.fact_check_status, 'revise');
      const nextFake = pr755({ secondStatus: '食い違い' });
      const next = await F.checkArticle(first.content, { ...options, callLLM: nextFake.fn, searchEvidence: () => refs755(), loadEvidenceText: e => e.text, recordDir: dir, persist: false, previousRaw: first.content });
      budget(next.record);
      assert.ok(next.record.incremental, JSON.stringify(next.record.incremental));
      assert.ok(next.record.claims.some(c => c.sentence === ORIG_755));
      assert.ok(!next.record.rechecked.some(c => [FIRST_755, SECOND_755].includes(c.sentence)));
      assert.ok(!next.record.corrections.some(c => [FIRST_755, SECOND_755].includes(c.after)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('F1（S3・記号）位置が無ければ戻し、$ を含む 2 回目の置き換えはそのまま入れる', async () => {
    // 置き換えの位置が文字どおり見つからない（空白だけ違う）入力を、X2 を作る関数に直接渡す。
    const first = '制度では承認が必要です。';
    const variant = '制度では 承認が必要です。';
    const second = '制度では許可が必要です。';
    assert.deepEqual(F.secondReplacement(first, new Map([[variant, second]])),
      { x2: first, reverted: true, reason: '置き換えの位置が見つかりません' });
    // 置き換えても 1 回目の置き換えのままなら、同じく戻す。
    assert.deepEqual(F.secondReplacement(first, new Map([[first, first]])),
      { x2: first, reverted: true, reason: '置き換えの位置が見つかりません' });
    // 位置が見つかれば 2 回目の置き換えにする。
    assert.deepEqual(F.secondReplacement(first, new Map([[first, second]])),
      { x2: second, reverted: false, reason: '' });
    // $&・$1・$$ を含む置き換えも、String.replace の記号として読まずにそのまま入れる。
    const symbols = '制度では US$100 と $& と $1 と $$ を確認してください。';
    assert.deepEqual(F.secondReplacement(first, new Map([[first, symbols]])),
      { x2: symbols, reverted: false, reason: '' });

    // checkFacts でも、2 回目の置き換えの $ を記号として読まず、AI が返した文が 1 字も違わず本文と記録に入る。
    const S = 'この制度は届出が必要です。';
    const X1 = 'この制度は承認が必要です。';
    const SECOND = 'この制度は US$100 と $& と $1 と $$ を確認してください。';
    const BASED = 'この制度は US$100 と $1 の承認が必要です。';
    const filler = 'この段落は試験のための埋め草で、制度の説明ではありません。'.repeat(4);
    const body = `## 制度\n${S}\n${filler}\n`;
    const fn = async request => {
      if (request.task === 'extract') {
        if (request.user.includes(SECOND)) return [row(SECOND, '判定', '試験制度', '記号を含む文を確認する')];
        if (request.user.includes(X1)) return [row(X1, '判定', '試験制度', '承認が必要')];
        return [row(S, '判定', '試験制度', '届出が必要')];
      }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
        if (c.sentence === S) return { id: c.id, status: '食い違い', quote: X1, correct: X1, evidence_id: 'doc' };
        // 2 回目の置き換えが足す 100 を、歯止めが根拠に無い数字として却下しないよう、根拠にもある文で返す。
        if (c.sentence === X1) return { id: c.id, status: '食い違い', quote: BASED, correct: BASED, evidence_id: 'doc' };
        if (c.sentence === SECOND) return { id: c.id, status: '裏付けあり', quote: SECOND, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.earlier_fix ? SECOND : X1 }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, callLLM: fn,
      searchEvidence: () => [ref('doc', '試験資料', `${X1}\n${BASED}\n${SECOND}\n`)], loadEvidenceText: e => e.text });
    const { repair, recheck } = budget(r.record);
    assert.equal(repair, 2); assert.equal(recheck, 2);
    assert.equal(r.record.status, 'ok');
    // 本文にも corrections.after にも、$ を含む文が 1 字も違わず入る。
    assert.deepEqual(rows(r.body).filter(t => t === SECOND), [SECOND]);
    assert.ok(!r.body.includes(X1));
    assert.ok(!rows(r.body).includes(S));
    const correction = r.record.corrections.find(c => c.before === S);
    assert.equal(correction.after, SECOND);
    assert.equal(correction.resolved, true);
    assert.deepEqual(correction.retry, { status: 'kept', first_after: X1 });
  });

  await test('F2（予備の道）作り直した本文を採れないときは、2 回目の判定で変える前の対応表を使う', async () => {
    // 1 回目の置き換えを含む本文は通し、元の文に戻した作り直しだけを偽にする。
    const fake = pr755({ secondStatus: '食い違い' });
    const r = await F.checkFacts(BODY_755, { ...options, callLLM: fake.fn, searchEvidence: () => refs755(),
      loadEvidenceText: e => e.text, validateRepair: text => !text.includes(ORIG_755) });
    budget(r.record);
    assert.equal(r.body, BODY_755);
    assert.equal(r.record.status, 'revise');
    assert.deepEqual(r.record.rechecked, []);
    assert.ok(r.record.corrections.length >= 1);
    for (const c of r.record.corrections) {
      assert.equal(c.reverted, true);
      assert.equal(c.after, '');
      assert.equal(c.resolved, false);
      assert.equal(c.retry.status, 'reverted');
      assert.equal(c.retry.first_after, FIRST_755);
      assert.ok(c.retry.first_after);
      assert.equal(c.retry.cause, '元の文に戻せなかったため、すべての修正を採りませんでした');
    }
  });

  await test('H2（予備の道）残すにした対象もすべて戻し、数と記録を合わせる', async () => {
    const A = '制度Aでは届出が必要です。', B = '制度Bでは承認が必要です。';
    const A1 = '制度Aでは申請が必要です。', B1 = '制度Bでは届出が必要です。';
    const A2 = '制度Aでは申請と確認が必要です。', B2 = '制度Bでは届出と確認が必要です。';
    const body = `## 制度\n${A}\n${B}\n`;
    const fn = async request => {
      if (request.task === 'extract') {
        if (request.user.includes(A2) || request.user.includes(B2)) {
          return [A2, B2].filter(s => request.user.includes(s)).map(s => row(s, '判定', s === A2 ? '制度A' : '制度B', s));
        }
        if (request.user.includes(A1) || request.user.includes(B1)) {
          return [A1, B1].filter(s => request.user.includes(s)).map(s => row(s, '判定', s === A1 ? '制度A' : '制度B', s));
        }
        return [row(A, '判定', '制度A', A), row(B, '判定', '制度B', B)];
      }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
        if (c.sentence === A) return { id: c.id, status: '食い違い', quote: A1, correct: A1, evidence_id: 'doc' };
        if (c.sentence === B) return { id: c.id, status: '食い違い', quote: B1, correct: B1, evidence_id: 'doc' };
        if (c.sentence === A1) return { id: c.id, status: '食い違い', quote: A2, correct: A2, evidence_id: 'doc' };
        if (c.sentence === B1) return { id: c.id, status: '食い違い', quote: B2, correct: B2, evidence_id: 'doc' };
        if (c.sentence === A2) return { id: c.id, status: '裏付けあり', quote: A2, evidence_id: 'doc' };
        if (c.sentence === B2) return { id: c.id, status: '食い違い', quote: B2, correct: B2, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.sentence === A ? A1 : c.sentence === B ? B1 : c.sentence === A1 ? A2 : B2 }));
      throw new Error('未定義: ' + request.task);
    };
    // 1 回目の置き換えを含む本文は通し、元の文に戻した作り直しだけを偽にする（対象 2 つ・片方は 2 回目で直る）。
    const r = await F.checkFacts(body, { ...options, callLLM: fn,
      searchEvidence: () => [ref('doc', '試験資料', `${A1}\n${B1}\n${A2}\n${B2}\n`)], loadEvidenceText: e => e.text,
      validateRepair: text => !text.includes(A) && !text.includes(B) });
    budget(r.record);
    assert.equal(r.body, body);
    assert.equal(r.record.status, 'revise');
    assert.deepEqual(r.record.rechecked, []);
    assert.deepEqual(r.record.repair_retry, { targets: 2, kept: 0, reverted: 2 });
    assert.equal(r.record.corrections.length, 2);
    for (const c of r.record.corrections) {
      assert.equal(c.reverted, true); assert.equal(c.after, ''); assert.equal(c.resolved, false);
      assert.equal(c.retry.status, 'reverted');
    }
    assert.ok(!r.record.corrections.some(c => c.retry.status === 'kept'));
    assert.ok(r.record.remaining.some(c => c.sentence === A));
    assert.ok(r.record.remaining.some(c => c.sentence === B));
    assert.equal(r.record.review_items.filter(c => c.status === REVERTED).length, 2);
  });

  await test('N1-1（形 1）1 回目の置き換えに同じ誤りの文が 2 回あっても、直すか戻して止める', async () => {
    const ORIG = '制度Bの手続は所定の方法で行います。';
    const BAD = '制度Bでは申請が必要です。';
    const GOOD = '制度Bでは承認が必要です。';
    const X1 = BAD + BAD;
    const body = `## 制度\n${ORIG}\n`;
    const fn = async request => {
      if (request.task === 'extract') {
        if (request.user.includes(GOOD)) return [row(GOOD, '判定', '制度B', GOOD)];
        if (request.user.includes(BAD)) return [row(BAD, '判定', '制度B', BAD)];
        return [row(ORIG, '判定', '制度B', ORIG)];
      }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
        if (c.sentence === ORIG) return { id: c.id, status: '食い違い', quote: BAD, correct: X1, evidence_id: 'doc' };
        if (c.sentence === BAD) return { id: c.id, status: '食い違い', quote: GOOD, correct: GOOD, evidence_id: 'doc' };
        if (c.sentence === GOOD) return { id: c.id, status: '裏付けあり', quote: GOOD, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.earlier_fix ? GOOD : X1 }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, callLLM: fn,
      searchEvidence: () => [ref('doc', '試験資料', `${BAD}\n${GOOD}\n`)], loadEvidenceText: e => e.text });
    budget(r.record);
    // 誤りの文が本文に残るなら、状態は revise（main と同じく止める）。直っていれば本文からその文が消える。
    assert.ok(!r.body.includes(BAD) || r.record.status === 'revise', '誤った文が本文に残ったまま止まっていない');
    // 2 回目の置き換えは置き換えの中の同じ文を全部直すので、1 回目の置き換えの文は本文に残らない。
    assert.ok(!r.body.includes(BAD));
    assert.equal(r.body.split(BAD).length - 1, 0);
    assert.equal(r.body.split(GOOD).length - 1, 2);
    assert.equal(r.record.status, 'ok');
    const correction = r.record.corrections.find(c => c.before === ORIG);
    assert.equal(correction.after, GOOD + GOOD);
    assert.equal(correction.resolved, true);
  });

  await test('N1-2（形 2）止めない指摘の置き換えに残った同じ案内文でも、本文に残るなら止める', async () => {
    const old = process.env.FACT_CHECK_WRITER_MATERIALS;
    process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
    try {
      const T = 'この制度の金額は10万円です。';
      const C = 'この制度の手続は所定の用紙で行います。';
      const GEN_T = 'この制度の金額は、詳しくは国税庁のページで確認してください。届出書は税務署に提出します。';
      const GEN_C = 'この制度の手続は、詳しくは国税庁のページで確認してください。届出書は税務署に提出します。';
      const BAD = '届出書は税務署に提出します。';
      const GOOD = '届出書は所轄の税務署に提出します。';
      const filler = ['この制度の金額は20万円です。', 'この制度の金額は30万円です。', 'この制度の金額は40万円です。', 'この制度の金額は50万円です。', 'この制度の金額は60万円です。'];
      const body = `## 制度\n${T}\n${C}\n${filler.join('\n')}\n`;
      const source = ref('gift', '制度資料', `${GEN_T}\n${GEN_C}\n${BAD}\n${GOOD}\n${T}\n${C}\n${filler.join('\n')}\n`);
      const fn = async request => {
        if (request.task === 'condition_check') return { verdict: '一致', conditions: [] };
        if (request.task === 'extract') {
          if (request.user.includes(GOOD)) return [row(GOOD, '手続', '試験制度', GOOD)];
          if (request.user.includes(BAD)) return [row(BAD, '手続', '試験制度', BAD)];
          return [row(T, '金額', '試験制度', T), row(C, '手続', '試験制度', C),
            ...filler.map(sentence => row(sentence, '金額', '試験制度', sentence))];
        }
        if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
          if (c.sentence === T || c.sentence === C) return { id: c.id, status: '資料なし' };
          if (c.sentence === BAD) return { id: c.id, status: '食い違い', quote: GOOD, correct: GOOD, evidence_id: 'gift' };
          if (c.sentence === GOOD) return { id: c.id, status: '裏付けあり', quote: GOOD, evidence_id: 'gift' };
          return { id: c.id, status: '裏付けあり', quote: c.sentence, evidence_id: 'gift' };
        });
        if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
          replacement: c.sentence === T ? GEN_T : c.sentence === C ? GEN_C : GOOD }));
        throw new Error('未定義: ' + request.task);
      };
      const r = await F.checkFacts(body, { ...options, writer_materials: ['ta:4103'], resolvedWriterMaterials: [source],
        callLLM: fn, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text });
      budget(r.record);
      // 止める指摘（T）は 2 回目で直るが、止めない指摘（C）の置き換えに残った同じ案内文は本文に残る。
      // その文の再照合の行は、消さずに残して状態を revise にする（main と同じく止める）。
      assert.ok(!r.body.includes(BAD) || r.record.status === 'revise', '誤った案内文が本文に残ったまま止まっていない');
      assert.equal(r.record.status, 'revise');
      assert.ok(r.body.includes(BAD));
      assert.ok(r.body.includes(GEN_T.replace(BAD, GOOD)));
      assert.ok(r.record.rechecked.some(c => c.sentence === BAD && c.status === '食い違い'));
      assert.ok(r.record.remaining.some(c => c.sentence === BAD && c.status === '食い違い'));
    } finally {
      if (old === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS; else process.env.FACT_CHECK_WRITER_MATERIALS = old;
    }
  });

  await test('N2（引用が空のときは空の引用枠を出さない）', () => {
    const item = quote => ({ id: 'r1', sentence: '元の文です。', heading: '制度', type: '判定', subject: '試験制度', claim: '主張',
      status: REVERTED, proposal: '採らなかった修正案です。',
      recheck: [{ status: '食い違い', claim: '主張', correct: '正しい内容です。', quote, evidence_id: 'e1' }],
      evidence: [{ id: 'e1', title: '資料', url: 'https://example.jp/e1' }] });
    const render = quote => page.renderFactCheck({ fact_check_status: 'revise', fact_check_summary: '要約' },
      F.compactRecord({ status: 'revise', corrections: [], remaining: [], review_items: [item(quote)] }));
    assert.ok(!render('').includes('<blockquote></blockquote>'), '引用が空でも空の引用枠が出ている');
    assert.ok(render('引用です。').includes('<blockquote>引用です。</blockquote>'));
  });

  await test('T13（S1）修正は 2 回・再照合は 2 回まで、repair: false では修正しない', async () => {
    const fake = pr755({ secondStatus: '食い違い' });
    const r = await run755(fake);
    const { repair, recheck } = budget(r.record);
    assert.equal(repair, 2); assert.equal(recheck, 2);
    assert.ok(!r.record.calls.some(c => c.task.startsWith('again_recheck_')));
    const off = pr755();
    const result = await F.checkFacts(BODY_755, { ...options, repair: false, callLLM: off.fn, searchEvidence: () => refs755(), loadEvidenceText: e => e.text });
    assert.equal(result.body, BODY_755);
    assert.ok(!result.record.calls.some(c => ['repair', 'again_repair'].includes(c.task)));
    assert.ok(!result.record.calls.some(c => c.task.startsWith('again_')));
    assert.equal(result.record.repair_retry, undefined);
  });

  console.log(`再照合の修正: PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

main();
