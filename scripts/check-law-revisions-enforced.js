'use strict';

/**
 * 法令の版が施行済みかを e-Gov 法令 API で確かめる。
 *
 *   node scripts/check-law-revisions-enforced.js 340AC0000000033_20261201_508AC0000000012
 *   node scripts/check-law-revisions-enforced.js --json <版の ID> [<版の ID> ...]
 *
 * 何をするか:
 *   指定した版（law_revision_id）ごとに、その法令の改正履歴を 1 回だけ取得し、
 *   「一致する版がちょうど 1 件」「状態が CurrentEnforced か PreviousEnforced」
 *   「施行日が日本時間の今日以前」のすべてを満たすときだけ施行済みと判定する。
 *
 * 何をしないか:
 *   ファイルもネットワークも書き換えない（取得のみ）。マスターや legal_status は触らない。
 *   施行の判断を人に代わって確定させる道具ではないので、出力は事実（状態・施行日）を添える。
 *
 * 終了コード:
 *   0 = 指定したすべての版が施行済み
 *   1 = 1 件でも未施行（版が無い・2 件以上・知らない状態・施行日が未来または無い）
 *   2 = 引数の誤り、通信の失敗、HTTP 200 以外、JSON が読めない、revisions が無い
 */

const EGOV_API = 'https://laws.e-gov.go.jp/api/2/law_revisions/';
const ID_PATTERN = /^[0-9A-Z]+_\d{8}_[0-9A-Z]+$/;
const ENFORCED_STATUSES = new Set(['CurrentEnforced', 'PreviousEnforced']);
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 5000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 版の ID の先頭 `_` までが法令 ID */
function lawIdOf(revisionId) {
  return String(revisionId).split('_')[0];
}

/** now() から日本時間（UTC+9）の今日を YYYY-MM-DD で求める。Intl は使わない。 */
function jstToday(now) {
  const value = now();
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error('now() が日時を返しません');
  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD として実在する日付か */
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function errorMessage(error) {
  if (!error) return '原因不明';
  return error.message || String(error);
}

/**
 * 1 法令分の改正履歴を取得する。失敗したら 1 回だけやり直す。
 * 戻り値: { ok: true, revisions } または { ok: false, error }
 */
async function fetchLawRevisions(lawId, { fetchImpl, retryDelayMs }) {
  const url = `${EGOV_API}${lawId}?response_format=json`;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'hp-vlog-law-enforcement-check' },
      });
      if (!response || response.status !== 200) {
        throw new Error(`HTTP ${response ? response.status : '不明'} ${url}`);
      }
      const data = await response.json();
      if (!data || !Array.isArray(data.revisions)) {
        throw new Error(`応答に revisions の配列がありません: ${url}`);
      }
      return { ok: true, revisions: data.revisions };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: `改正履歴を取得できません（${lawId}）: ${errorMessage(lastError)}` };
}

/** 一致する 1 件から施行済みかを判定する */
function evaluateRevision(id, revisions, today) {
  const matched = revisions.filter(item => item && item.law_revision_id === id);
  if (matched.length === 0) {
    return { id, status: null, enforcementDate: null, enforced: false, note: '版が見つかりません' };
  }
  if (matched.length > 1) {
    return { id, status: null, enforcementDate: null, enforced: false, note: `同じ ID の版が ${matched.length} 件あります` };
  }
  const revision = matched[0];
  const status = typeof revision.current_revision_status === 'string' ? revision.current_revision_status : null;
  const enforcementDate = typeof revision.amendment_enforcement_date === 'string'
    ? revision.amendment_enforcement_date
    : null;
  let note = null;
  if (status === null) note = '状態がありません';
  else if (!ENFORCED_STATUSES.has(status)) note = `状態が ${status} です`;
  else if (enforcementDate === null) note = '施行日がありません';
  else if (!isIsoDate(enforcementDate)) note = `施行日が読めません（${enforcementDate}）`;
  else if (enforcementDate > today) note = `施行日が未来です（${enforcementDate}）`;
  return { id, status, enforcementDate, enforced: note === null, note };
}

/**
 * 版の ID の一覧を調べる。
 *   checkRevisions(ids, { fetchImpl, now }) -> { exitCode, results, reason }
 * fetchImpl の既定は globalThis.fetch、now の既定は () => new Date()。
 * retryDelayMs は試験用（既定 5000）。
 */
async function checkRevisions(ids, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => new Date());
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : RETRY_DELAY_MS;

  if (!Array.isArray(ids) || ids.length === 0) {
    return { exitCode: 2, results: [], reason: '法令の版の ID を 1 つ以上指定してください' };
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return { exitCode: 2, results: [], reason: `版の ID の形が誤っています: ${id}` };
    }
  }
  if (typeof fetchImpl !== 'function') {
    return { exitCode: 2, results: [], reason: 'fetch が使えません（Node 18 以上が必要です）' };
  }
  let today;
  try {
    today = jstToday(now);
  } catch (error) {
    return { exitCode: 2, results: [], reason: `今日の日付を求められません: ${errorMessage(error)}` };
  }

  // 同じ法令 ID の版が複数あっても取得は 1 回にする（失敗も同じ扱いで使い回す）。
  const cache = new Map();
  const results = [];
  for (const id of ids) {
    const lawId = lawIdOf(id);
    if (!cache.has(lawId)) {
      cache.set(lawId, await fetchLawRevisions(lawId, { fetchImpl, retryDelayMs }));
    }
    const fetched = cache.get(lawId);
    if (!fetched.ok) return { exitCode: 2, results: [], reason: fetched.error };
    results.push(evaluateRevision(id, fetched.revisions, today));
  }

  const exitCode = results.every(result => result.enforced) ? 0 : 1;
  return { exitCode, results, reason: null };
}

/** 版ごとの 1 行 */
function formatResultLine(result) {
  return [
    result.id,
    result.status || 'なし',
    result.enforcementDate || 'なし',
    result.enforced ? '施行済み' : '未施行',
  ].join('\t');
}

/**
 * 標準出力・標準エラー出力へ書き、終了コードを返す。
 * 試験のため出力先を差し替えられるようにしてある。
 */
function report(outcome, { json = false, stdout = console.log, stderr = console.error } = {}) {
  if (json) {
    stdout(JSON.stringify({ ok: outcome.exitCode === 0, results: outcome.results }));
  } else {
    for (const result of outcome.results) stdout(formatResultLine(result));
  }
  if (outcome.exitCode === 2) {
    const reason = outcome.reason || '原因不明';
    if (json) {
      stderr(`エラー: ${reason}`);
    } else {
      stderr(`エラー: ${reason}`);
      stdout(`結果: 確認できない（${reason}）`);
    }
  } else if (!json) {
    stdout(`結果: ${outcome.exitCode === 0 ? '施行済み' : '未施行'}`);
  }
  return outcome.exitCode;
}

/** 引数を読み、調べて出力する。戻り値は終了コード。 */
async function main(argv, deps = {}) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  const unknown = rest.find(arg => typeof arg === 'string' && arg.startsWith('-'));
  if (unknown) {
    return report({ exitCode: 2, results: [], reason: `知らないオプションです: ${unknown}` }, { json, ...deps });
  }
  const outcome = await checkRevisions(rest, deps);
  return report(outcome, { json, ...deps });
}

module.exports = {
  checkRevisions,
  fetchLawRevisions,
  evaluateRevision,
  formatResultLine,
  jstToday,
  isIsoDate,
  lawIdOf,
  main,
  report,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(`エラー: ${errorMessage(error)}`);
    console.log('結果: 確認できない（内部エラー）');
    process.exitCode = 2;
  });
}
