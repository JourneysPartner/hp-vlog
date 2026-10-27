'use strict';

/**
 * remote に残った draft/* 枝を整理する手動実行用スクリプト。
 * 既定は一覧表示だけで、--apply を付けた場合に限って削除する。
 */

const { spawnSync } = require('child_process');

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 50;

function runProcess(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `${command} が終了コード ${result.status} で失敗しました`);
  }
  return result.stdout || '';
}

function listRemoteBranches(run = runProcess) {
  return run('git', ['ls-remote', '--heads', 'origin'])
    .split(/\r?\n/)
    .map(line => (line.match(/\srefs\/heads\/(.+)$/) || [])[1])
    .filter(Boolean);
}

function listPullRequests(run = runProcess) {
  const raw = run('gh', [
    'pr', 'list', '--state', 'all', '--limit', '1000',
    '--json', 'number,headRefName,state,closedAt',
  ]);
  const prs = JSON.parse(raw);
  if (!Array.isArray(prs)) throw new Error('PR 一覧の形式が不正です');
  return prs;
}

function latestPrForBranch(prs) {
  const open = prs.find(pr => String(pr.state || '').toUpperCase() === 'OPEN');
  if (open) return open;
  return [...prs].sort((a, b) => {
    const dateDiff = Date.parse(b.closedAt || '') - Date.parse(a.closedAt || '');
    if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
    return Number(b.number || 0) - Number(a.number || 0);
  })[0] || null;
}

/**
 * 枝と PR のスナップショットだけから削除可否を決める。
 * 外部コマンドや現在時刻の取得を含まない純関数。
 */
function classifyBranches(branches, prs, now) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('now が有効な日時ではありません');

  const prsByBranch = new Map();
  for (const pr of prs || []) {
    if (!pr || !pr.headRefName) continue;
    if (!prsByBranch.has(pr.headRefName)) prsByBranch.set(pr.headRefName, []);
    prsByBranch.get(pr.headRefName).push(pr);
  }

  return (branches || []).map(branch => {
    const matching = prsByBranch.get(branch) || [];
    const pr = latestPrForBranch(matching);
    const state = pr ? String(pr.state || '').toUpperCase() : 'PRなし';
    const base = {
      branch,
      prNumber: pr && pr.number ? pr.number : null,
      state,
      closedAt: pr && pr.closedAt ? pr.closedAt : null,
      eligible: false,
      decision: '',
    };

    if (!String(branch).startsWith('draft/')) {
      return { ...base, decision: '対象外（draft/* 以外）' };
    }
    if (!pr) {
      return { ...base, decision: '対象外（PR なし）' };
    }
    if (state === 'OPEN') {
      return { ...base, decision: '対象外（OPEN）' };
    }
    if (state === 'MERGED') {
      return { ...base, eligible: true, decision: '削除候補（MERGED）' };
    }
    if (state === 'CLOSED') {
      const closedMs = Date.parse(pr.closedAt || '');
      if (Number.isFinite(closedMs) && nowMs - closedMs >= THREE_DAYS_MS) {
        return { ...base, eligible: true, decision: '削除候補（CLOSED から3日以上）' };
      }
      return { ...base, decision: '保留（CLOSED から3日未満）' };
    }
    return { ...base, decision: `対象外（状態: ${state || '不明'}）` };
  });
}

function formatClosedAt(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : String(value);
}

function printTable(rows, log = console.log) {
  log('枝名\tPR番号\t状態\t閉じた日\t判定');
  for (const row of rows) {
    log([
      row.branch,
      row.prNumber ? `#${row.prNumber}` : '-',
      row.state || '-',
      formatClosedAt(row.closedAt),
      row.decision,
    ].join('\t'));
  }
}

function redactSecrets(value, env = process.env) {
  let text = String(value || '').replace(/https:\/\/[^\s/@]+@/gi, 'https://***@');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = env[key];
    if (secret) text = text.split(secret).join('***');
  }
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function applyDeletions(rows, run = runProcess, env = process.env) {
  const targets = rows.filter(row => row.eligible).map(row => row.branch);
  const deleted = [];
  const failures = [];

  for (let i = 0; i < targets.length; i += DELETE_BATCH_SIZE) {
    const batch = targets.slice(i, i + DELETE_BATCH_SIZE);
    try {
      run('git', ['push', 'origin', '--delete', ...batch]);
      deleted.push(...batch);
    } catch (error) {
      const reason = redactSecrets(error.message, env) || '削除コマンドが失敗しました';
      for (const branch of batch) failures.push({ branch, reason });
    }
  }
  return { deleted, failures };
}

function printHelp(log = console.log) {
  log('使い方:');
  log('  node scripts/prune-draft-branches.js          # dry-run（一覧表示のみ）');
  log('  node scripts/prune-draft-branches.js --apply  # 削除を実行');
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const run = dependencies.run || runProcess;
  const log = dependencies.log || console.log;
  const errorLog = dependencies.error || console.error;
  const env = dependencies.env || process.env;

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(log);
    return 0;
  }
  const unknown = argv.filter(arg => arg !== '--apply');
  if (unknown.length > 0) {
    errorLog(`不明な引数です: ${unknown.join(' ')}`);
    printHelp(log);
    return 1;
  }

  let rows;
  try {
    const branches = listRemoteBranches(run);
    const prs = listPullRequests(run);
    rows = classifyBranches(branches, prs, dependencies.now || new Date());
  } catch (error) {
    errorLog(`一覧の取得に失敗しました: ${redactSecrets(error.message, env)}`);
    return 1;
  }

  printTable(rows, log);
  if (!argv.includes('--apply')) {
    log(`dry-run: 削除候補 ${rows.filter(row => row.eligible).length} 枝（削除は実行していません）`);
    return 0;
  }

  const result = applyDeletions(rows, run, env);
  log(`削除結果: 成功 ${result.deleted.length} / 失敗 ${result.failures.length}`);
  if (result.failures.length > 0) {
    log('削除に失敗した枝:');
    for (const failure of result.failures) log(`  - ${failure.branch}: ${failure.reason}`);
  }
  return result.failures.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  classifyBranches,
  listRemoteBranches,
  listPullRequests,
  applyDeletions,
  printTable,
  main,
};
