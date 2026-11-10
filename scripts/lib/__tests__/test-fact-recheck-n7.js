'use strict';

// N7: 前に言葉を足す直し（置き換えが元の誤りの文を含む）は、その文を含む本文の文が
// 再照合で全部「裏付けあり」のときだけ「直った」「見直した」とする（1 回目と 2 回目）。
// N8: 2 回目に「全部が見直した文なら消す」の「全部」を確かめる。
// 通信は偽 LLM と偽の資料だけで行う。
const assert = require('assert/strict');
const H = require('./fact-pages-test-helpers');
const F = H.F;
const now = new Date('2026-11-10T00:00:00Z');
const options = { now, enabled: true, batch: false, repair: true };

let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.stack}`); }
}
const ref = (id, title, text) => ({ id, kind: 'taxanswer', title, url: `https://example.jp/${encodeURIComponent(id)}`, text, law_version: '令和8年4月1日現在法令等' });
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

// ── T1〜T3・T11: 1 回目の照合で、置き換えが元の誤りの文を含む形 ──────────
const G_S = '制度Gの届出書は郵送で出せます。';
const G_CORRECT = '制度Gの届出書は窓口に持参します。';
const G_A = '制度Gの届出は税務署に出します。';
const G_B = '原則として制度Gの届出書は郵送で出せます。';
const G_X1 = G_A + G_B;
const G_BODY = `## 制度\n${G_S}\n`;

async function runG1() {
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(G_B)) return [row(G_A, '手続', '制度G', G_A), row(G_B, '手続', '制度G', G_B)];
      return [row(G_S, '手続', '制度G', G_S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === G_S) return { id: c.id, status: '食い違い', quote: G_CORRECT, correct: G_CORRECT, evidence_id: 'doc' };
      if (c.sentence === G_A) return { id: c.id, status: '裏付けあり', quote: G_A, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: G_X1 }));
    throw new Error('未定義: ' + request.task);
  };
  return F.checkFacts(G_BODY, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${G_CORRECT}\n${G_A}\n${G_B}\n`)], loadEvidenceText: e => e.text });
}

async function main() {
await test('T1 1 回目・置き換えが 2 文: 元の誤りを含む 2 文目が資料なしなら止める', async () => {
  const r = await runG1();
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${G_X1}\n`);
  assert.equal(r.record.status, 'revise');
  assert.ok(r.record.remaining.some(c => c.sentence === G_S && c.status === '食い違い'), 'S の食い違いが残った指摘に無い');
  const correction = r.record.corrections.find(c => c.before === G_S);
  assert.equal(correction.after, G_X1);
  assert.equal(correction.resolved, false);
  const item = r.record.review_items.find(c => c.sentence === G_B);
  assert.equal(item?.status, '資料なし');
});

await test('T2 1 回目・1 文から主張 2 つ: 片方が資料なしなら止める', async () => {
  const X1 = G_B;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(X1)) return [row(X1, '要件', '制度G', '届出書の提出が必要'), row(X1, '手続', '制度G', '郵送で出せる')];
      return [row(G_S, '手続', '制度G', G_S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === G_S) return { id: c.id, status: '食い違い', quote: G_CORRECT, correct: G_CORRECT, evidence_id: 'doc' };
      if (c.sentence === X1 && c.type === '要件') return { id: c.id, status: '裏付けあり', quote: X1, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(G_BODY, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${G_CORRECT}\n${X1}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${X1}\n`);
  assert.equal(r.record.status, 'revise');
  assert.ok(r.record.remaining.some(c => c.sentence === G_S && c.status === '食い違い'), 'S の食い違いが残った指摘に無い');
  assert.equal(r.record.corrections.find(c => c.before === G_S).resolved, false);
});

await test('T3 1 回目・含む文から主張なし: 行が無いので止める', async () => {
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(G_B)) return [row(G_A, '手続', '制度G', G_A)];
      return [row(G_S, '手続', '制度G', G_S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === G_S) return { id: c.id, status: '食い違い', quote: G_CORRECT, correct: G_CORRECT, evidence_id: 'doc' };
      return { id: c.id, status: '裏付けあり', quote: G_A, evidence_id: 'doc' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: G_X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(G_BODY, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${G_CORRECT}\n${G_A}\n${G_B}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${G_X1}\n`);
  assert.equal(r.record.status, 'revise');
  assert.ok(r.record.remaining.some(c => c.sentence === G_S && c.status === '食い違い'), 'S の食い違いが残った指摘に無い');
  assert.equal(r.record.corrections.find(c => c.before === G_S).resolved, false);
});

await test('T4 1 回目・前に言葉を足して正しく直った: 含む文が裏付けありなら通す', async () => {
  const S = '制度Hの届出書を提出します。';
  const X1 = '開業した年は制度Hの届出書を提出します。';
  const body = `## 制度\n${S}\n`;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(X1)) return [row(X1, '手続', '制度H', X1)];
      return [row(S, '手続', '制度H', S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === S) return { id: c.id, status: '食い違い', quote: X1, correct: X1, evidence_id: 'doc' };
      return { id: c.id, status: '裏付けあり', quote: X1, evidence_id: 'doc' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${X1}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${X1}\n`);
  assert.equal(r.record.status, 'ok');
  assert.deepEqual(r.record.remaining, []);
  const correction = r.record.corrections.find(c => c.before === S);
  assert.equal(correction.after, X1);
  assert.equal(correction.resolved, true);
});

await test('T5 1 回目・期限の書き漏れは今と同じ: 含む文に資料なしがあっても期限追記は通す', async () => {
  const S = '制度Lの届出書を提出します。';
  const CORRECT = '制度Lの届出書は開業の日から1か月以内に提出します。';
  const DEADLINE = '提出の期限は開業の日から1か月以内です。';
  const X1 = S + DEADLINE;
  const body = `## 制度\n${S}\n`;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(DEADLINE)) return [row(S, '手続', '制度L', S), row(S, '判定', '制度L', '提出の期限は資料で確認が必要'),
        row(DEADLINE, '期限', '制度L', DEADLINE)];
      return [row(S, '手続', '制度L', S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === S && c.type === '手続') return request.user.includes(DEADLINE)
        ? { id: c.id, status: '裏付けあり', quote: S, evidence_id: 'doc' }
        : { id: c.id, status: '期限の書き漏れ', quote: CORRECT, correct: CORRECT, evidence_id: 'doc' };
      if (c.sentence === DEADLINE) return { id: c.id, status: '裏付けあり', quote: CORRECT, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${CORRECT}\n${S}\n${DEADLINE}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${X1}\n`);
  assert.equal(r.record.status, 'ok');
  assert.deepEqual(r.record.remaining, []);
  const correction = r.record.corrections.find(c => c.before === S);
  assert.equal(correction.status, '期限の書き漏れ');
  assert.equal(correction.resolved, true);
  const item = r.record.review_items.find(c => c.sentence === S && c.status === '資料なし');
  assert.equal(item?.type, '判定');
});

// ── T6: 2 回目（review-01d の N7） ───────────────────────────────
await test('T6 2 回目・前に言葉を足した直しが資料なしなら、1 回目の食い違いの行を残す', async () => {
  const S = '制度Fの届出は市役所に出します。';
  const A = '制度Fの届出は税務署に出します。';
  const B = '制度Fの届出書は郵送で出せます。';
  const B2 = '原則として制度Fの届出書は郵送で出せます。';
  const CORRECT_B = '制度Fの届出書は窓口に持参します。';
  const X1 = A + B;
  const body = `## 制度\n${S}\n`;
  let judges = 0;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(B2)) return [row(A, '手続', '制度F', A), row(B2, '手続', '制度F', B2)];
      if (request.user.includes(B)) return [row(A, '手続', '制度F', A), row(B, '手続', '制度F', B)];
      return [row(S, '手続', '制度F', S)];
    }
    if (request.task === 'judge') {
      judges++;
      return H.readPayload(request).claims.map(c => {
        if (c.sentence === S) return { id: c.id, status: '食い違い', quote: A, correct: X1, evidence_id: 'doc' };
        if (c.sentence === A) return { id: c.id, status: '裏付けあり', quote: A, evidence_id: 'doc' };
        if (c.sentence === B) return { id: c.id, status: '食い違い', quote: CORRECT_B, correct: CORRECT_B, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
    }
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? B2 : X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${A}\n${CORRECT_B}\n${B}\n${B2}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(judges, 3);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${A}${B2}\n`);
  assert.equal(r.record.status, 'revise');
  assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 1, reverted: 0 });
  assert.ok(r.record.rechecked.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いの行が再照合に残っていない');
  assert.ok(r.record.remaining.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いが残った指摘に無い');
  // 残した 1 回目の止める行（B）が置き換えの中にあるので、S の修正も直ったにしない（L1）。
  assert.equal(r.record.corrections.find(c => c.before === S).resolved, false);
  const item = r.record.review_items.find(c => c.sentence === B2);
  assert.equal(item?.status, '資料なし');
});

// ── T7: 2 回目・前に言葉を足して正しく直った（N5-1 の形） ───────────────
await test('T7 2 回目・含む文から 2 つの主張がどちらも裏付けありなら通す', async () => {
  const S = '制度Bの提出書類は届出書です。';
  const BAD = '制度Bの届出書を提出します。';
  const GOOD = '開業した年は制度Bの届出書を提出します。';
  const body = `## 制度\n${S}\n`;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(GOOD)) return [row(GOOD, '手続', '制度B', GOOD), row(GOOD, '要件', '制度B', '届出書の提出が必要')];
      if (request.user.includes(BAD)) return [row(BAD, '手続', '制度B', BAD)];
      return [row(S, '手続', '制度B', S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === S) return { id: c.id, status: '食い違い', quote: BAD, correct: BAD, evidence_id: 'doc' };
      if (c.sentence === BAD) return { id: c.id, status: '食い違い', quote: GOOD, correct: GOOD, evidence_id: 'doc' };
      return { id: c.id, status: '裏付けあり', quote: GOOD, evidence_id: 'doc' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? GOOD : BAD }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${BAD}\n${GOOD}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${GOOD}\n`);
  assert.equal(r.record.status, 'ok');
  assert.deepEqual(r.record.remaining, []);
  assert.ok(!r.record.rechecked.some(c => c.sentence === BAD && c.status !== '裏付けあり'));
  const correction = r.record.corrections.find(c => c.before === S);
  assert.equal(correction.after, GOOD);
  assert.equal(correction.resolved, true);
});

// ── T8: 2 回目・期限の書き漏れの行は今と同じ ─────────────────────
await test('T8 2 回目・期限の書き漏れの行は今と同じく消す', async () => {
  const S = '制度Mの届出は市役所に出します。';
  const A = '制度Mの届出は税務署に出します。';
  const T = '制度Mの届出書を提出します。';
  const CORRECT_T = '制度Mの届出書は開業の日から1か月以内に提出します。';
  const DEADLINE = '提出の期限は開業の日から1か月以内です。';
  const X1 = A + T;
  const body = `## 制度\n${S}\n`;
  let judges = 0;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(DEADLINE)) return [row(A, '手続', '制度M', A), row(T, '手続', '制度M', T),
        row(T, '判定', '制度M', '提出の期限は資料で確認が必要'), row(DEADLINE, '期限', '制度M', DEADLINE)];
      if (request.user.includes(T)) return [row(A, '手続', '制度M', A), row(T, '手続', '制度M', T)];
      return [row(S, '手続', '制度M', S)];
    }
    if (request.task === 'judge') {
      judges++;
      return H.readPayload(request).claims.map(c => {
        if (c.sentence === S) return { id: c.id, status: '食い違い', quote: A, correct: X1, evidence_id: 'doc' };
        if (c.sentence === A) return { id: c.id, status: '裏付けあり', quote: A, evidence_id: 'doc' };
        if (c.sentence === T && c.type === '手続') return judges >= 3
          ? { id: c.id, status: '裏付けあり', quote: T, evidence_id: 'doc' }
          : { id: c.id, status: '期限の書き漏れ', quote: CORRECT_T, correct: CORRECT_T, evidence_id: 'doc' };
        if (c.sentence === DEADLINE) return { id: c.id, status: '裏付けあり', quote: CORRECT_T, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
    }
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? T + DEADLINE : X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${A}\n${T}\n${CORRECT_T}\n${DEADLINE}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(judges, 3);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${A}${T}${DEADLINE}\n`);
  assert.equal(r.record.status, 'ok');
  assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 1, reverted: 0 });
  assert.deepEqual(r.record.remaining, []);
  const correction = r.record.corrections.find(c => c.before === S);
  assert.equal(correction.retry.status, 'kept');
  assert.equal(correction.resolved, true);
});

// ── T9: 2 回目・残した置き換えに元の文が残る（R3） ─────────────────
await test('T9 2 回目・残した置き換えの中の元の誤りを含む文が資料なしなら止める', async () => {
  const S = '制度Kの届出書は郵送で出せます。';
  const CORRECT_S = '制度Kの届出書は窓口に持参します。';
  const SP = '原則として制度Kの届出書は郵送で出せます。';
  const E = '制度Kの届出は市役所に出します。';
  const E2 = '制度Kの届出は税務署に出します。';
  const X1 = SP + E;
  const body = `## 制度\n${S}\n`;
  let judges = 0;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(E2)) return [row(SP, '手続', '制度K', SP), row(E2, '手続', '制度K', E2)];
      if (request.user.includes(E)) return [row(SP, '手続', '制度K', SP), row(E, '手続', '制度K', E)];
      return [row(S, '手続', '制度K', S)];
    }
    if (request.task === 'judge') {
      judges++;
      return H.readPayload(request).claims.map(c => {
        if (c.sentence === S) return { id: c.id, status: '食い違い', quote: CORRECT_S, correct: CORRECT_S, evidence_id: 'doc' };
        if (c.sentence === E) return { id: c.id, status: '食い違い', quote: E2, correct: E2, evidence_id: 'doc' };
        if (c.sentence === E2) return { id: c.id, status: '裏付けあり', quote: E2, evidence_id: 'doc' };
        if (c.sentence === SP) return judges >= 3
          ? { id: c.id, status: '資料なし' }
          : { id: c.id, status: '裏付けあり', quote: SP, evidence_id: 'doc' };
        return { id: c.id, status: '資料なし' };
      });
    }
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? E2 : X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${CORRECT_S}\n${SP}\n${E}\n${E2}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(judges, 3);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${SP}${E2}\n`);
  assert.equal(r.record.status, 'revise');
  assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 1, reverted: 0 });
  assert.ok(r.record.rechecked.some(c => c.sentence === SP && c.status === '資料なし'), 'SP の資料なしの行が再照合に無い');
  const correction = r.record.corrections.find(c => c.before === S);
  assert.equal(correction.retry.status, 'kept');
  assert.equal(correction.after, SP + E2);
  assert.equal(correction.resolved, false);
  assert.ok(r.record.remaining.some(c => c.sentence === S && c.status === '食い違い'), 'S の食い違いが残った指摘に無い');
});

// ── T10: N8（「全部」の試験） ────────────────────────────────
await test('T10 N8: 前に言葉を足す直しでも、誤りの案内文が別の置き換えに単独で残れば止める', async () => {
  const old = process.env.FACT_CHECK_WRITER_MATERIALS;
  process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
  try {
    const T = 'この制度の金額は10万円です。';
    const C = 'この制度の手続は所定の用紙で行います。';
    const GEN_T = 'この制度の金額は、詳しくは国税庁のページで確認してください。届出書は税務署に提出します。';
    const GEN_C = 'この制度の手続は、詳しくは国税庁のページで確認してください。届出書は税務署に提出します。';
    const BAD = '届出書は税務署に提出します。';
    const CORRECT_BAD = '届出書は所轄の税務署に提出します。';
    const GOOD = '原則として届出書は税務署に提出します。';
    const filler = ['この制度の金額は20万円です。', 'この制度の金額は30万円です。', 'この制度の金額は40万円です。', 'この制度の金額は50万円です。', 'この制度の金額は60万円です。'];
    const body = `## 制度\n${T}\n${C}\n${filler.join('\n')}\n`;
    const source = ref('gift', '制度資料', `${GEN_T}\n${GEN_C}\n${BAD}\n${GOOD}\n${CORRECT_BAD}\n${T}\n${C}\n${filler.join('\n')}\n`);
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
        if (c.sentence === BAD) return { id: c.id, status: '食い違い', quote: CORRECT_BAD, correct: CORRECT_BAD, evidence_id: 'gift' };
        if (c.sentence === GOOD) return { id: c.id, status: '裏付けあり', quote: GOOD, evidence_id: 'gift' };
        return { id: c.id, status: '裏付けあり', quote: c.sentence, evidence_id: 'gift' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
        replacement: c.sentence === T ? GEN_T : c.sentence === C ? GEN_C : GOOD }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, writer_materials: ['ta:4103'], resolvedWriterMaterials: [source],
      callLLM: fn, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text });
    const { repair, recheck } = budget(r.record);
    assert.equal(repair, 2); assert.equal(recheck, 2);
    // 誤りの案内文は、2 回目に手を付けなかった置き換え（GEN_C）の中に単独の文として残る。
    assert.equal(r.body, `## 制度\n${GEN_T.replace(BAD, GOOD)}\n${GEN_C}\n${filler.join('\n')}\n`);
    assert.ok(r.body.includes(GEN_C), 'BAD が単独の文で残っていない');
    assert.equal(r.record.status, 'revise');
    assert.ok(r.record.rechecked.some(c => c.sentence === BAD && c.status === '食い違い'), 'BAD の食い違いの行が再照合に残っていない');
    assert.ok(r.record.remaining.some(c => c.sentence === BAD && c.status === '食い違い'), 'BAD の食い違いが残った指摘に無い');
  } finally {
    if (old === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS; else process.env.FACT_CHECK_WRITER_MATERIALS = old;
  }
});

// ── T11: 版 ─────────────────────────────────────────────
await test('T11 版: 記録の logic_version が plan2-s9', async () => {
  const r = await runG1();
  budget(r.record);
  assert.equal(r.record.logic_version, 'plan2-s9');
});

// ── T12: 1 回目の条件確認だけの修正は、今のとおり通す（L2） ───────────
await test('T12 条件確認だけの修正は、置き換えの含む文に資料なしがあっても今のとおり直す', async () => {
  const old = process.env.FACT_CHECK_WRITER_MATERIALS;
  process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
  try {
    const S = '制度Hの届出書を提出します。';
    const X1 = '開業した年は制度Hの届出書を提出します。';
    const MISSING = '提出の期限は資料で確認が必要';
    const body = `## 制度\n${S}\n`;
    const source = ref('gift', '制度Hの資料', `${X1}\n${S}\n`);
    const fn = async request => {
      if (request.task === 'condition_check') {
        const data = JSON.parse(request.user);
        if (data.article === S) return { verdict: '不一致', correct: X1,
          conditions: [{ article: '提出する書類', source: '開業した年の届出書', match: '不一致' }] };
        return { verdict: '一致', conditions: [] };
      }
      if (request.task === 'extract') {
        if (request.user.includes(X1)) return [row(X1, '手続', '制度H', X1), row(X1, '判定', '制度H', MISSING)];
        return [row(S, '手続', '制度H', S)];
      }
      if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
        if (c.sentence === X1 && c.type === '判定') return { id: c.id, status: '資料なし' };
        return { id: c.id, status: '裏付けあり', quote: X1, evidence_id: 'gift' };
      });
      if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: X1 }));
      throw new Error('未定義: ' + request.task);
    };
    const r = await F.checkFacts(body, { ...options, writer_materials: ['ta:4103'], resolvedWriterMaterials: [source],
      callLLM: fn, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text });
    const { repair, recheck } = budget(r.record);
    assert.equal(repair, 1); assert.equal(recheck, 1);
    // 条件確認の除外（c.condition_mismatch）を外すと、本文が元の文に戻り、修正の記録が消える。
    assert.equal(r.body, `## 制度\n${X1}\n`);
    assert.equal(r.record.status, 'ok');
    assert.deepEqual(r.record.remaining, []);
    const correction = r.record.corrections.find(c => c.before === S);
    assert.equal(correction.status, '食い違い');
    assert.equal(correction.condition_mismatch, true);
    assert.equal(correction.after, X1);
    assert.equal(correction.resolved, true);
    const missing = r.record.review_items.find(c => c.sentence === X1 && c.status === '資料なし');
    assert.equal(missing?.type, '判定');
    assert.ok(!r.record.review_items.some(c => c.status === '条件の違いを要確認'), '条件確認だけの項目が人に回っている');
  } finally {
    if (old === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS; else process.env.FACT_CHECK_WRITER_MATERIALS = old;
  }
});

// ── T13: 2 回目・その文の行が全部裏付けありか（L2） ────────────────
await test('T13 2 回目・B2 の 2 つの主張のどちらかが資料なしなら、1 回目の食い違いの行を残す', async () => {
  const S = '制度Fの届出は市役所に出します。';
  const A = '制度Fの届出は税務署に出します。';
  const B = '制度Fの届出書は郵送で出せます。';
  const B2 = '原則として制度Fの届出書は郵送で出せます。';
  const CORRECT_B = '制度Fの届出書は窓口に持参します。';
  const REQUIRED = '届出書の提出が必要';
  const MAIL = '郵送で出せる';
  const X1 = A + B;
  const body = `## 制度\n${S}\n`;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(B2)) return [row(A, '手続', '制度F', A), row(B2, '要件', '制度F', REQUIRED), row(B2, '手続', '制度F', MAIL)];
      if (request.user.includes(B)) return [row(A, '手続', '制度F', A), row(B, '手続', '制度F', B)];
      return [row(S, '手続', '制度F', S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === S) return { id: c.id, status: '食い違い', quote: A, correct: X1, evidence_id: 'doc' };
      if (c.sentence === A) return { id: c.id, status: '裏付けあり', quote: A, evidence_id: 'doc' };
      if (c.sentence === B) return { id: c.id, status: '食い違い', quote: CORRECT_B, correct: CORRECT_B, evidence_id: 'doc' };
      if (c.sentence === B2 && c.type === '要件') return { id: c.id, status: '裏付けあり', quote: B2, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? B2 : X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${A}\n${CORRECT_B}\n${B}\n${B2}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${A}${B2}\n`);
  assert.equal(r.record.status, 'revise');
  // B2 の行が 1 つでも裏付けありでないなら、B の食い違いの行を消さない（every を some にすると落ちる）。
  assert.ok(r.record.rechecked.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いの行が再照合に残っていない');
  assert.ok(r.record.remaining.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いが残った指摘に無い');
});

// ── T14: 1 回目・含む文が全部裏付けありか（L2） ─────────────────────
await test('T14 1 回目・含む文が 2 つあり片方が資料なしなら止める', async () => {
  const B = '原則として制度Gの届出書は郵送で出せます。';
  const E = '例外として、制度Gの届出書は郵送で出せます。';
  const X1 = B + E;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(E)) return [row(B, '手続', '制度G', B), row(E, '手続', '制度G', E)];
      return [row(G_S, '手続', '制度G', G_S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === G_S) return { id: c.id, status: '食い違い', quote: G_CORRECT, correct: G_CORRECT, evidence_id: 'doc' };
      if (c.sentence === B) return { id: c.id, status: '裏付けあり', quote: B, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(G_BODY, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${G_CORRECT}\n${B}\n${E}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${X1}\n`);
  assert.equal(r.record.status, 'revise');
  // 含む文の every を some にすると、1 文目だけで通って落ちる。
  assert.ok(r.record.remaining.some(c => c.sentence === G_S && c.status === '食い違い'), 'S の食い違いが残った指摘に無い');
  assert.equal(r.record.corrections.find(c => c.before === G_S).resolved, false);
});

// ── T15: 2 回目・止める行だけを「全部」の対象にする（L2） ──────────────
await test('T15 2 回目・止めない行は今のとおり消し、止める行だけを残す', async () => {
  const S = '制度Fの届出は市役所に出します。';
  const A = '制度Fの届出は税務署に出します。';
  const B = '制度Fの届出書は郵送で出せます。';
  const B2 = '原則として制度Fの届出書は郵送で出せます。';
  const N = '制度Fの窓口は平日に開いています。';
  const CORRECT_B = '制度Fの届出書は窓口に持参します。';
  const FIRST_CLAIM = '窓口の開館時間は資料で確認が必要';
  const SECOND_CLAIM = '窓口は平日に開いている';
  const X1 = A + B + N;
  const body = `## 制度\n${S}\n`;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(B2)) return [row(A, '手続', '制度F', A), row(B2, '手続', '制度F', B2), row(N, '手続', '制度F', SECOND_CLAIM)];
      if (request.user.includes(B)) return [row(A, '手続', '制度F', A), row(B, '手続', '制度F', B), row(N, '手続', '制度F', FIRST_CLAIM)];
      return [row(S, '手続', '制度F', S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === S) return { id: c.id, status: '食い違い', quote: A, correct: X1, evidence_id: 'doc' };
      if (c.sentence === A) return { id: c.id, status: '裏付けあり', quote: A, evidence_id: 'doc' };
      if (c.sentence === B) return { id: c.id, status: '食い違い', quote: CORRECT_B, correct: CORRECT_B, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? B2 : X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${A}\n${CORRECT_B}\n${B}\n${B2}\n${N}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${A}${B2}${N}\n`);
  assert.equal(r.record.status, 'revise');
  assert.deepEqual(r.record.repair_retry, { targets: 1, kept: 1, reverted: 0 });
  assert.ok(r.record.remaining.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いが残った指摘に無い');
  // 止めない行（N）の 1 回目の行は今のとおり消す。R2 の「止める行だけ」の限定を外すと残って落ちる。
  assert.ok(!r.record.rechecked.some(c => c.sentence === N && c.claim === FIRST_CLAIM), '止めない行の 1 回目の行が消えていない');
  assert.ok(r.record.rechecked.some(c => c.sentence === N && c.claim === SECOND_CLAIM), '止めない行の 2 回目の行が再照合に無い');
});

// ── T16: R7・1 回目（後ろに句を足した直し） ───────────────────────
await test('T16 1 回目・後ろに句を足した直しの 2 文目が資料なしなら止める', async () => {
  const B2 = '制度Gの届出書は郵送で出せますが、例外があります。';
  const X1 = G_A + B2;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(B2)) return [row(G_A, '手続', '制度G', G_A), row(B2, '手続', '制度G', B2)];
      return [row(G_S, '手続', '制度G', G_S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === G_S) return { id: c.id, status: '食い違い', quote: G_CORRECT, correct: G_CORRECT, evidence_id: 'doc' };
      if (c.sentence === G_A) return { id: c.id, status: '裏付けあり', quote: G_A, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id, replacement: X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(G_BODY, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${G_CORRECT}\n${G_A}\n${B2}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 1); assert.equal(recheck, 1);
  assert.equal(r.body, `## 制度\n${X1}\n`);
  assert.equal(r.record.status, 'revise');
  // 終わりの句点まで比べると含む文が無くなり、resolved: true になって落ちる（R7）。
  assert.equal(r.record.corrections.find(c => c.before === G_S).resolved, false);
  assert.ok(r.record.remaining.some(c => c.sentence === G_S && c.status === '食い違い'), 'S の食い違いが残った指摘に無い');
});

// ── T17: R7・2 回目（後ろに句を足した直し） ───────────────────────
await test('T17 2 回目・後ろに句を足した直しが資料なしなら、1 回目の食い違いの行を残す', async () => {
  const S = '制度Fの届出は市役所に出します。';
  const A = '制度Fの届出は税務署に出します。';
  const B = '制度Fの届出書は郵送で出せます。';
  const B2 = '制度Fの届出書は郵送で出せますが、例外があります。';
  const CORRECT_B = '制度Fの届出書は窓口に持参します。';
  const X1 = A + B;
  const body = `## 制度\n${S}\n`;
  const fn = async request => {
    if (request.task === 'extract') {
      if (request.user.includes(B2)) return [row(A, '手続', '制度F', A), row(B2, '手続', '制度F', B2)];
      if (request.user.includes(B)) return [row(A, '手続', '制度F', A), row(B, '手続', '制度F', B)];
      return [row(S, '手続', '制度F', S)];
    }
    if (request.task === 'judge') return H.readPayload(request).claims.map(c => {
      if (c.sentence === S) return { id: c.id, status: '食い違い', quote: A, correct: X1, evidence_id: 'doc' };
      if (c.sentence === A) return { id: c.id, status: '裏付けあり', quote: A, evidence_id: 'doc' };
      if (c.sentence === B) return { id: c.id, status: '食い違い', quote: CORRECT_B, correct: CORRECT_B, evidence_id: 'doc' };
      return { id: c.id, status: '資料なし' };
    });
    if (request.task === 'repair') return JSON.parse(request.user).corrections.map(c => ({ id: c.id,
      replacement: c.earlier_fix ? B2 : X1 }));
    throw new Error('未定義: ' + request.task);
  };
  const r = await F.checkFacts(body, { ...options, callLLM: fn,
    searchEvidence: () => [ref('doc', '試験資料', `${A}\n${CORRECT_B}\n${B}\n${B2}\n`)], loadEvidenceText: e => e.text });
  const { repair, recheck } = budget(r.record);
  assert.equal(repair, 2); assert.equal(recheck, 2);
  assert.equal(r.body, `## 制度\n${A}${B2}\n`);
  assert.equal(r.record.status, 'revise');
  // 終わりの句点まで比べると、B を含む本文の文が無いとみなされて B の行が消え、ok になって落ちる（R7）。
  assert.ok(r.record.rechecked.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いの行が再照合に残っていない');
  assert.ok(r.record.remaining.some(c => c.sentence === B && c.status === '食い違い'), 'B の食い違いが残った指摘に無い');
});

console.log(`\n${passed} 件通過・${failed} 件失敗`);
if (failed) process.exitCode = 1;
}

main();
