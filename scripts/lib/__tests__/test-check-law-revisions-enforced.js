'use strict';

/**
 * 法令の版が施行済みかのチェッカーのテスト。
 *   node scripts/lib/__tests__/test-check-law-revisions-enforced.js
 *
 * ネットワークは使わない。偽の fetchImpl で e-Gov 法令 API の応答を差し替え、
 * 終了コード（0 = 施行済み / 1 = 未施行 / 2 = 確認できない）と判定の境目を確かめる。
 * 特に、日本時間の日付の境目（UTC 15:00）で「今日」と「明日」が入れ替わることを固定する。
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  checkRevisions,
  formatResultLine,
  isIsoDate,
  jstToday,
  report,
} = require(path.join(__dirname, '..', '..', 'check-law-revisions-enforced.js'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

// 日本時間 2026-12-01 0:00（UTC では 2026-11-30 15:00）
const NOW_JST_DEC1 = () => new Date('2026-11-30T15:00:00Z');
const NOW_JST_NOV30_LAST_SECOND = () => new Date('2026-11-30T14:59:59Z');

const INCOME_TAX_LAW = '340AC0000000033';
const LOCAL_TAX_LAW = '325AC0000000226';
const INCOME_TAX_R8 = `${INCOME_TAX_LAW}_20261201_508AC0000000012`;
const LOCAL_TAX_R9 = `${LOCAL_TAX_LAW}_20270101_508AC0000000012`;

function revision(id, status, date) {
  return {
    law_revision_id: id,
    current_revision_status: status,
    amendment_enforcement_date: date,
  };
}

/** 法令 ID ごとの revisions を返す偽 fetch。calls に URL を記録する。 */
function makeFetch(byLawId, calls = []) {
  return async (url) => {
    calls.push(url);
    const matched = /law_revisions\/([0-9A-Z]+)\?/.exec(String(url));
    if (!matched) throw new Error(`想定外の URL: ${url}`);
    const entry = byLawId[matched[1]];
    if (entry === undefined) throw new Error(`用意していない法令 ID: ${matched[1]}`);
    if (typeof entry === 'function') return entry();
    return {
      status: 200,
      async json() { return { revisions: entry }; },
    };
  };
}

function response(status, body) {
  return {
    status,
    async json() {
      if (body === '壊れた JSON') return JSON.parse('{壊れた JSON');
      return body;
    },
  };
}

function runCheck(ids, options) {
  return checkRevisions(ids, options);
}

async function runAll() {
  // ── 1. 2 つの法令の版がどちらも施行済み ──────────────────────────
  console.log('\n=== Test 1: 2 件とも CurrentEnforced なら 0 ===');
  {
    const calls = [];
    const fetchImpl = makeFetch({
      [INCOME_TAX_LAW]: [revision(INCOME_TAX_R8, 'CurrentEnforced', '2026-12-01')],
      [LOCAL_TAX_LAW]: [revision(LOCAL_TAX_R9, 'CurrentEnforced', '2027-01-01')],
    }, calls);
    // 住民税の施行日 2027-01-01 を過ぎた時点（日本時間 2027-01-05）
    const now = () => new Date('2027-01-05T03:00:00+09:00');
    const outcome = await runCheck([INCOME_TAX_R8, LOCAL_TAX_R9], { fetchImpl, now, retryDelayMs: 0 });
    assert(outcome.exitCode === 0, '2 件とも施行済みなら exitCode 0');
    assert(outcome.results.length === 2, '2 件分の結果を返す');
    assert(outcome.results.every(r => r.enforced === true), '結果はどちらも施行済み');
    assert(calls.length === 2, '法令 ID ごとに 1 回ずつ取得する');
    assert(outcome.results[0].enforcementDate === '2026-12-01', '施行日をそのまま返す');
  }

  // ── 2. PreviousEnforced は施行済み扱い ────────────────────────────
  console.log('\n=== Test 2: PreviousEnforced は施行済み ===');
  {
    const fetchImpl = makeFetch({
      [INCOME_TAX_LAW]: [revision(INCOME_TAX_R8, 'PreviousEnforced', '2026-12-01')],
    });
    const outcome = await runCheck([INCOME_TAX_R8], { fetchImpl, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(outcome.exitCode === 0, 'PreviousEnforced なら exitCode 0');
    assert(outcome.results[0].enforced === true, 'PreviousEnforced は施行済み');
  }

  // ── 3. UnEnforced は未施行 ───────────────────────────────────────
  console.log('\n=== Test 3: UnEnforced は未施行 ===');
  {
    const fetchImpl = makeFetch({
      [INCOME_TAX_LAW]: [revision(INCOME_TAX_R8, 'UnEnforced', '2026-11-01')],
    });
    const outcome = await runCheck([INCOME_TAX_R8], { fetchImpl, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(outcome.exitCode === 1, 'UnEnforced なら exitCode 1');
    assert(outcome.results[0].enforced === false, 'UnEnforced は未施行');
    assert(outcome.results[0].status === 'UnEnforced', '状態をそのまま返す');
  }

  // ── 4. 施行日が未来（日本時間の境目） ────────────────────────────
  console.log('\n=== Test 4: 施行日が日本時間の明日なら 1 ===');
  {
    const fetchImpl = makeFetch({
      [INCOME_TAX_LAW]: [revision(INCOME_TAX_R8, 'CurrentEnforced', '2026-12-01')],
    });
    const boundaryToday = await runCheck([INCOME_TAX_R8], {
      fetchImpl, now: NOW_JST_DEC1, retryDelayMs: 0,
    });
    assert(boundaryToday.exitCode === 0, '日本時間 12/1 0:00 なら施行日 12/1 は今日（0）');
    const boundaryTomorrow = await runCheck([INCOME_TAX_R8], {
      fetchImpl, now: NOW_JST_NOV30_LAST_SECOND, retryDelayMs: 0,
    });
    assert(boundaryTomorrow.exitCode === 1, '日本時間 11/30 23:59:59 なら施行日 12/1 は明日（1）');
    assert(boundaryTomorrow.results[0].enforced === false, '明日の施行日は未施行');
    assert(jstToday(NOW_JST_DEC1) === '2026-12-01', 'jstToday は UTC+9 で 12/1 を返す');
    assert(jstToday(NOW_JST_NOV30_LAST_SECOND) === '2026-11-30', 'jstToday は UTC 14:59:59 では 11/30');
  }

  // ── 5. 版が無い・同じ ID が 2 件 ─────────────────────────────────
  console.log('\n=== Test 5: 版が無い・重複している ===');
  {
    const missingFetch = makeFetch({
      [INCOME_TAX_LAW]: [revision(`${INCOME_TAX_LAW}_20250101_000AC0000000001`, 'CurrentEnforced', '2025-01-01')],
    });
    const missing = await runCheck([INCOME_TAX_R8], { fetchImpl: missingFetch, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(missing.exitCode === 1, '版が見つからなければ exitCode 1');
    assert(missing.results[0].status === null, '版が無ければ状態は null');
    assert(missing.results[0].enforced === false, '版が無ければ未施行');

    const duplicatedFetch = makeFetch({
      [INCOME_TAX_LAW]: [
        revision(INCOME_TAX_R8, 'CurrentEnforced', '2026-12-01'),
        revision(INCOME_TAX_R8, 'CurrentEnforced', '2026-12-01'),
      ],
    });
    const duplicated = await runCheck([INCOME_TAX_R8], { fetchImpl: duplicatedFetch, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(duplicated.exitCode === 1, '同じ ID の版が 2 件なら exitCode 1');
    assert(duplicated.results[0].enforced === false, '同じ ID の版が 2 件なら未施行');
  }

  // ── 6. 知らない状態・施行日が無い ────────────────────────────────
  console.log('\n=== Test 6: 知らない状態・施行日なし ===');
  {
    const unknownFetch = makeFetch({
      [INCOME_TAX_LAW]: [revision(INCOME_TAX_R8, 'EnforcedSoon', '2026-11-01')],
    });
    const unknown = await runCheck([INCOME_TAX_R8], { fetchImpl: unknownFetch, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(unknown.exitCode === 1, '知らない状態なら exitCode 1');
    assert(unknown.results[0].enforced === false, '知らない状態は未施行');

    const noDateFetch = makeFetch({
      [INCOME_TAX_LAW]: [revision(INCOME_TAX_R8, 'CurrentEnforced', undefined)],
    });
    const noDate = await runCheck([INCOME_TAX_R8], { fetchImpl: noDateFetch, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(noDate.exitCode === 1, '施行日が無ければ exitCode 1');
    assert(noDate.results[0].enforcementDate === null, '施行日が無ければ null');
    assert(noDate.results[0].enforced === false, '施行日が無ければ未施行');
    assert(isIsoDate('2026-12-01') === true, '正しい YYYY-MM-DD を受け付ける');
    assert(isIsoDate('2026-02-30') === false, '実在しない日付は受け付けない');
  }

  // ── 7. 通信の失敗・応答の異常 ────────────────────────────────────
  console.log('\n=== Test 7: 通信の失敗・応答の異常は 2 ===');
  {
    const http500 = makeFetch({ [INCOME_TAX_LAW]: () => response(500, { revisions: [] }) });
    const http500Outcome = await runCheck([INCOME_TAX_R8], { fetchImpl: http500, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(http500Outcome.exitCode === 2, 'HTTP 500 なら exitCode 2');
    assert(typeof http500Outcome.reason === 'string' && http500Outcome.reason.length > 0, 'HTTP 500 は理由を返す');

    const throwing = async () => { throw new Error('通信できません'); };
    const throwingOutcome = await runCheck([INCOME_TAX_R8], { fetchImpl: throwing, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(throwingOutcome.exitCode === 2, 'fetch が例外なら exitCode 2');

    const brokenJson = makeFetch({ [INCOME_TAX_LAW]: () => response(200, '壊れた JSON') });
    const brokenJsonOutcome = await runCheck([INCOME_TAX_R8], { fetchImpl: brokenJson, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(brokenJsonOutcome.exitCode === 2, 'JSON が壊れていれば exitCode 2');

    const noRevisions = makeFetch({ [INCOME_TAX_LAW]: () => response(200, { revision_list: [] }) });
    const noRevisionsOutcome = await runCheck([INCOME_TAX_R8], { fetchImpl: noRevisions, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(noRevisionsOutcome.exitCode === 2, 'revisions が無ければ exitCode 2');

    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('1 回目だけ失敗');
      return response(200, { revisions: [revision(INCOME_TAX_R8, 'CurrentEnforced', '2026-12-01')] });
    };
    const flakyOutcome = await runCheck([INCOME_TAX_R8], { fetchImpl: flaky, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(flakyOutcome.exitCode === 0, '1 回目だけ失敗なら 2 回目で成功する（0）');
    assert(attempts === 2, 'やり直しは 1 回だけ（取得は 2 回）');

    let retriedAttempts = 0;
    const alwaysFailing = async () => { retriedAttempts += 1; throw new Error('毎回失敗'); };
    const alwaysFailingOutcome = await runCheck([INCOME_TAX_R8], {
      fetchImpl: alwaysFailing, now: NOW_JST_DEC1, retryDelayMs: 0,
    });
    assert(alwaysFailingOutcome.exitCode === 2, '毎回失敗なら exitCode 2');
    assert(retriedAttempts === 2, '毎回失敗でも取得は 2 回まで');
  }

  // ── 8. 引数の誤り ───────────────────────────────────────────────
  console.log('\n=== Test 8: 引数の誤りは 2 ===');
  {
    const calls = [];
    const fetchImpl = makeFetch({ [INCOME_TAX_LAW]: [] }, calls);
    const badShape = await runCheck(['340AC0000000033'], { fetchImpl, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(badShape.exitCode === 2, '版の ID の形が違えば exitCode 2');
    const empty = await runCheck([], { fetchImpl, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(empty.exitCode === 2, 'ID が 0 個なら exitCode 2');
    assert(calls.length === 0, '引数の誤りでは取得しない');
  }

  // ── 9. 同じ法令 ID の版を 2 つ渡しても取得は 1 回 ────────────────
  console.log('\n=== Test 9: 同じ法令 ID は 1 回だけ取得 ===');
  {
    const earlier = `${INCOME_TAX_LAW}_20260101_000AC0000000001`;
    const calls = [];
    const fetchImpl = makeFetch({
      [INCOME_TAX_LAW]: [
        revision(earlier, 'PreviousEnforced', '2026-01-01'),
        revision(INCOME_TAX_R8, 'CurrentEnforced', '2026-12-01'),
      ],
    }, calls);
    const outcome = await runCheck([earlier, INCOME_TAX_R8], { fetchImpl, now: NOW_JST_DEC1, retryDelayMs: 0 });
    assert(outcome.exitCode === 0, '同じ法令 ID の 2 版がどちらも施行済みなら 0');
    assert(calls.length === 1, '取得は法令 ID ごとに 1 回');
    assert(outcome.results.length === 2, '指定した 2 版分の結果を返す');
  }

  // ── 10. コマンドとして動かしたとき ──────────────────────────────
  console.log('\n=== Test 10: コマンドの終了コードと最後の行 ===');
  {
    const script = path.join(__dirname, '..', '..', 'check-law-revisions-enforced.js');
    const cases = [
      { args: [], expected: '結果: 確認できない（法令の版の ID を 1 つ以上指定してください）' },
      { args: ['340AC0000000033'], expected: '結果: 確認できない（版の ID の形が誤っています: 340AC0000000033）' },
      { args: ['--unknown-option', INCOME_TAX_R8], expected: '結果: 確認できない（知らないオプションです: --unknown-option）' },
    ];
    for (const testCase of cases) {
      const result = spawnSync(process.execPath, [script, ...testCase.args], { encoding: 'utf8' });
      const label = `引数 ${JSON.stringify(testCase.args)}`;
      if (result.error) {
        console.log(`  - ${label} は起動できないため飛ばします: ${result.error.message}`);
        continue;
      }
      const lines = String(result.stdout || '').split(/\r?\n/).filter(line => line.length > 0);
      assert(result.status === 2, `${label} の終了コードは 2`);
      assert(lines.length > 0 && lines[lines.length - 1] === testCase.expected, `${label} の最後の行は ${testCase.expected}`);
    }

    const jsonRun = spawnSync(process.execPath, [script, '--json', '340AC0000000033'], { encoding: 'utf8' });
    if (jsonRun.error) {
      console.log(`  - --json は起動できないため飛ばします: ${jsonRun.error.message}`);
    } else {
      let parsed = null;
      try { parsed = JSON.parse(String(jsonRun.stdout || '').trim()); } catch (error) { parsed = null; }
      assert(jsonRun.status === 2, '--json でも終了コードは 2');
      assert(parsed !== null && parsed.ok === false && Array.isArray(parsed.results), '--json は ok と results を持つ JSON を 1 つ出す');
    }
  }

  // ── 11. 出力の形（版ごとの 1 行と結果の行） ──────────────────────
  console.log('\n=== Test 11: 出力の形 ===');
  {
    assert(
      formatResultLine({ id: INCOME_TAX_R8, status: 'CurrentEnforced', enforcementDate: '2026-12-01', enforced: true })
        === `${INCOME_TAX_R8}\tCurrentEnforced\t2026-12-01\t施行済み`,
      '版ごとの行は ID・状態・施行日・判定をタブで区切る'
    );
    assert(
      formatResultLine({ id: INCOME_TAX_R8, status: null, enforcementDate: null, enforced: false })
        === `${INCOME_TAX_R8}\tなし\tなし\t未施行`,
      '版が無いときは状態と施行日に「なし」を出す'
    );

    const out = [];
    const err = [];
    const code = report(
      { exitCode: 1, results: [{ id: INCOME_TAX_R8, status: 'UnEnforced', enforcementDate: '2026-11-01', enforced: false }], reason: null },
      { stdout: line => out.push(line), stderr: line => err.push(line) }
    );
    assert(code === 1, 'report は終了コードを返す');
    assert(out.length === 2 && out[1] === '結果: 未施行', '未施行のときは最後に「結果: 未施行」を出す');
    assert(err.length === 0, '未施行は標準エラー出力に出さない');

    const jsonOut = [];
    const jsonCode = report({ exitCode: 2, results: [], reason: '通信できません' }, {
      json: true,
      stdout: line => jsonOut.push(line),
      stderr: () => {},
    });
    assert(jsonCode === 2 && jsonOut.length === 1, '--json は 1 行だけ出す');
    assert(JSON.parse(jsonOut[0]).ok === false, '--json の ok は失敗時に false');
  }
}

runAll().catch((error) => {
  failed++;
  console.error(`  ✗ 試験の実行中に例外: ${error && error.message}`);
}).finally(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
});
