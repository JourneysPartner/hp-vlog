'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'withdrawn-cli-'));
let passed = 0, failed = 0;
function assert(ok, label) {
  console.log(`  ${ok ? '✓' : '✗'} F2: ${label}`);
  ok ? passed++ : failed++;
}
try {
  // 実際の CLI を隔離したコピーで起動し、本番の記録ファイルは書き換えない。
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'));
  for (const file of ['scripts/record-withdrawn-topics.js', 'scripts/lib/withdrawn-topics.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(tmp, file));
  }
  const input = path.join(tmp, 'new.json');
  const target = path.join(tmp, 'data', 'withdrawn-topics.json');
  const entry = { topic_id: 'cli-test', stage: 'select-dedup', date: '2026-10-09' };
  fs.writeFileSync(input, JSON.stringify([entry]));
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(tmp, 'scripts', 'record-withdrawn-topics.js'), input], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  for (const [label, source] of [['壊れた JSON', '{壊れた JSON'], ['entries が配列でない JSON', '{"entries":{}}']]) {
    fs.writeFileSync(target, source);
    assert(run().status === 1, label + ' では終了コード 1');
    assert(fs.readFileSync(target, 'utf8') === source, label + ' ではファイルを変更しない');
  }
  fs.unlinkSync(target);
  assert(run().status === 0, 'ファイル無しでは終了コード 0');
  assert(JSON.stringify(JSON.parse(fs.readFileSync(target, 'utf8')).entries) === JSON.stringify([entry]), 'ファイル無しでは新規作成して記録を保存');
} catch (error) {
  failed++;
  console.error(error.code || error.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}
