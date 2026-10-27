'use strict';

// マスター鮮度の通知条件と起動条件を、通知を実送信せずに確認する。
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..', '..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/check-tax-simulator-masters.yml'), 'utf8');
const workflow = yaml.load(source);
const steps = workflow.jobs.check.steps;
const step = name => steps.find(item => item.name === name);

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== マスター鮮度ワークフロー ===');
for (const [name, condition] of [
  ['Validate master data', '${{ !cancelled() }}'],
  ['Check master freshness', "${{ !cancelled() && steps.validate.outcome == 'success' }}"],
  ['Comment on PR', "${{ !cancelled() && github.event_name == 'pull_request' && steps.check.outputs.needs_attention != '' }}"],
  ['Notify', "${{ !cancelled() && github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && steps.check.outputs.needs_attention != '' && steps.check.outputs.needs_attention != '0' }}"],
  ['Emit job summary', 'always()'],
  ['Fail if sources are unreachable', "${{ !cancelled() && steps.check.outcome == 'failure' }}"],
]) {
  assert(step(name)?.if === condition, `${name} の実行条件が指定どおり`);
}
assert(step('Validate master data')?.id === 'validate', '形式検証の結果を validate で参照できる');
assert(step('Check master freshness')?.id === 'check', '鮮度チェックの結果を check で参照できる');
assert(step('Check master freshness')?.['continue-on-error'] === true, '鮮度チェックの失敗後も通知まで進める');
assert(step('Run master tests') && !step('Run master tests')['continue-on-error'], '試験の失敗はジョブの失敗として残す');

for (const forbidden of ['CHATWORK_API_TOKEN', 'CHATWORK_ROOM_ID', 'api.chatwork.com']) {
  assert(!source.includes(forbidden), `ワークフローに ${forbidden} が無い`);
}

const notify = step('Notify');
assert(typeof notify?.run === 'string' && !notify.run.includes('${{'), '通知の実行コードに式の直接埋め込みが無い');
assert(notify?.run?.includes('scripts/notify.js') && notify.run.includes('--event master_freshness'),
  '共通の通知スクリプトに master_freshness を渡す');
assert(notify?.run?.trim() === [
  'if [ -n "$INPUT_AS_OF" ]; then',
  '  echo "::notice::基準日を指定した試行のため通知しません（基準日 ${INPUT_AS_OF}）"',
  '  exit 0',
  'fi',
  'if [ -z "$NETLIFY_NOTIFY_URL" ]; then',
  '  echo "::warning::通知先（vars.NETLIFY_NOTIFY_URL）が未設定のため通知できません"',
  '  exit 0',
  'fi',
  'NOTIFY_OUTPUT=$(node scripts/notify.js --event master_freshness --title "税シミュレーターのマスター鮮度チェック" --summary "$NOTIFY_SUMMARY" --pr-url "$RUN_URL" 2>&1) || true',
  'printf \'%s\\n\' "$NOTIFY_OUTPUT"',
  'if [[ "$NOTIFY_OUTPUT" != *"[notify] 送信完了"* ]]; then',
  '  echo "::warning::通知の送信を確認できませんでした（上のログを確認）"',
  'fi',
  'exit 0',
].join('\n'), '試行とURL未設定では送らず、要約と実行URLを引用し、両出力の完了確認後は常に正常終了する');
const expectedEnv = {
  INPUT_AS_OF: '${{ github.event.inputs.as_of }}',
  NETLIFY_NOTIFY_URL: '${{ vars.NETLIFY_NOTIFY_URL }}',
  NOTIFY_WEBHOOK_SECRET: '${{ secrets.NOTIFY_WEBHOOK_SECRET }}',
  NOTIFY_SUMMARY: '${{ steps.check.outputs.notify_summary }}',
  RUN_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
};
for (const [key, value] of Object.entries(expectedEnv)) {
  assert(notify?.env?.[key] === value, `通知の環境変数 ${key} が指定どおり`);
}
assert(JSON.stringify(Object.keys(notify?.env || {}).sort()) === JSON.stringify(Object.keys(expectedEnv).sort()),
  '通知の環境変数は指定の5項目だけ');

assert(JSON.stringify(steps.map(item => item.name || item.uses)) === JSON.stringify([
  'actions/checkout@v4', 'actions/setup-node@v4', '入力型の生成差分を検査',
  'Validate master data', 'Install dependencies', 'Run master tests',
  'Check master freshness', 'Comment on PR', 'Notify',
  'Emit job summary', 'Fail if sources are unreachable',
]), '既存の段を残し、試験から鮮度チェック・通知・失敗報告の順に実行する');

const expectedPaths = [
  'data/tax-simulator/masters/**',
  'data/tax-simulator/schemas/input/**',
  'scripts/generate-input-types.js',
  'scripts/lib/input-types/**',
  'scripts/lib/__tests__/**',
  'package.json',
  'scripts/check-master-freshness.js',
  'scripts/run-test-files.js',
  'scripts/validate-masters.js',
  'scripts/approve-records.js',
  'scripts/fetch-kenpo-rates.js',
  'scripts/verify-source-urls.js',
  'scripts/lib/**',
  'scripts/update-gsc-topics.js',
  'scripts/notify.js',
  'netlify/functions/lib/notify/**',
  'data/gsc-topics.json',
  'data/query-synonyms.json',
  'docs/codex-tasks/weekly-signal-fixes/*.json',
  '.github/workflows/check-tax-simulator-masters.yml',
];
for (const pattern of expectedPaths) {
  assert(workflow.on.pull_request.paths.includes(pattern), `PRの起動対象に ${pattern} がある`);
}
assert(JSON.stringify(workflow.on.pull_request.paths) === JSON.stringify(expectedPaths),
  '既存の起動対象と順番を保ち、指定の8項目だけを追加する');

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
