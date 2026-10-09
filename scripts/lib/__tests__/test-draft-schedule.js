'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDraftCron, parseCron, latestExpectedSlot, judgeDraftRan } = require('../draft-schedule');
const { checkDraftRan } = require('../../check-draft-ran');
const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0, failed = 0;
function assert(ok, label) { console.log(`  ${ok ? '✓' : '✗'} ${label}`); ok ? passed++ : failed++; }
const cronText = readDraftCron(fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8'));
const cron = parseCron(cronText);
assert(cronText === '5 0 * * 1,3,5', 'R1: 実際の生成 cron を読み取る');
assert(readDraftCron('[functions."other"]\nschedule = "1 2 * * *"\n') === '', 'R1: 他の関数の予定を使わない');
assert(readDraftCron('[functions."scheduler-daily-draft"]\r\nschedule = "5 0 * * 1,3,5"\r\n[other]\n') === cronText, 'R1: CRLF と後続セクションも読める');
assert(parseCron('5 0 * * 0,7').days.join() === '0', 'R1: 0 と 7 は日曜');
assert(parseCron('59 23 * * 2').days.join() === '2', 'R1: 単一曜日と時刻の上端');
for (const expr of ['@daily', '5 0 1 * *', '5 0 * 1 *', '60 0 * * *', '5 24 * * *', '5 0 * * 1-5', '5 0 * * 8', '*/5 0 * * *', '']) {
  const parsed = parseCron(expr);
  assert(parsed.warning && parsed.days.length === 7 && parsed.hour === 0 && parsed.minute === 5, `R1: 読めない cron ${expr || '空'} は毎日扱いと警告`);
}
// すべて UTC。朝 00〜04 時は JST 09〜13 時。
for (const [now, expected] of [
  ['2026-10-04T01:00:00Z', '2026-10-02'],
  ['2026-10-05T00:30:00Z', '2026-10-02'],
  ['2026-10-05T04:00:00Z', '2026-10-05'],
  ['2026-10-06T01:00:00Z', '2026-10-05'],
  ['2026-10-08T01:00:00Z', '2026-10-07'],
  ['2026-10-10T01:00:00Z', '2026-10-09'],
  ['2026-10-05T03:04:59Z', '2026-10-02'],
  ['2026-10-05T03:05:00Z', '2026-10-05'],
]) assert(latestExpectedSlot(new Date(now), cron).toISOString() === `${expected}T00:05:00.000Z`, `R1: ${now} → ${expected} 00:05 UTC`);

const checks = [
  ['04', '00:16', '02'], ['05', '00:20', '02'], ['06', '01:59', '05'],
  ['07', '01:09', '05'], ['08', '01:27', '07'], ['09', '01:35', '07'],
];
const allRuns = ['02', '05', '07', '09'].map(day => ({ createdAt: `2026-10-${day}T00:05:00Z`, conclusion: 'success' }));
for (const [day, time, expected] of checks) {
  const now = new Date(`2026-10-${day}T${time}:00Z`);
  const slot = latestExpectedSlot(now, cron);
  const count = judgeDraftRan(allRuns.filter(run => new Date(run.createdAt) <= now), slot);
  assert(slot.toISOString() === `2026-10-${expected}T00:05:00.000Z` && count >= 1, `R1: 10/${day} ${time} UTC（JST ${Number(time.slice(0, 2)) + 9}:${time.slice(3)}）→ 10/${expected} 09:05 JST 成功 ${count} 件`);
}
const slot = new Date('2026-10-05T00:05:00Z');
assert(judgeDraftRan([{ createdAt: slot.toISOString(), conclusion: 'failure' }], slot) === 0, 'R1: 失敗だけなら 0 件');
assert(judgeDraftRan([{ createdAt: '2026-10-04T23:54:59Z', conclusion: 'success' }], slot) === 0, 'R1: 許容範囲より前の成功は数えない');
assert(judgeDraftRan([{ createdAt: '2026-10-04T23:55:00Z', conclusion: 'success' }], slot) === 1, 'R1: 許容 10 分の境界は数える');
assert(judgeDraftRan([{ createdAt: '2026-10-05T04:00:00Z', conclusion: 'success', displayTitle: '[source=manual]' }], slot) === 1, 'R1: 予定の後の手動成功も数える');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-schedule-'));
try {
  const runsFile = path.join(tmp, 'runs.json'), output = path.join(tmp, 'output');
  fs.writeFileSync(runsFile, JSON.stringify(allRuns));
  const messages = [];
  const result = checkDraftRan(['--runs', runsFile], { CHECK_NOW: '2026-10-08T01:27:00Z', GITHUB_OUTPUT: output }, line => messages.push(line));
  assert(result.count === 2 && result.expected_jst === '2026-10-07', 'R2: CHECK_NOW と偽の runs ファイルで点検');
  assert(fs.readFileSync(output, 'utf8').includes('count=2\n') && fs.readFileSync(output, 'utf8').includes('expected_jst=2026-10-07\n'), 'R2: GitHub 出力に count と expected_jst');
  assert(messages[0].includes('2026-10-07 09:05 JST（水）'), 'R2: 予定時刻と曜日を JST で表示');
  fs.writeFileSync(runsFile, '[]');
  messages.length = 0;
  const zero = checkDraftRan(['--runs', runsFile], { CHECK_NOW: '2026-10-08T01:27:00Z' }, line => messages.push(line));
  assert(zero.count === 0 && messages.some(line => line.startsWith('::error::')), 'R2: 0 件は error を出し正常に戻る');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/check-existing-posts.yml'), 'utf8');
assert(workflow.includes('id: draftrun') && workflow.includes('--limit 20 --json createdAt,conclusion,displayTitle') && workflow.includes('node scripts/check-draft-ran.js --runs /tmp/draft-runs.json'), 'R3: ステップ名・ID を保ち新しい点検に接続');
assert(workflow.includes('${{ steps.draftrun.outputs.expected_jst }}') && workflow.includes("steps.draftrun.outputs.count == '0'"), 'R3: 予定日を通知し既存の count 判定を保つ');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exitCode = failed ? 1 : 0;
