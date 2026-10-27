'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const runner = path.join(ROOT, 'scripts/run-test-files.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-files-'));
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function test(label, callback) {
  console.log(`\n=== ${label} ===`);
  try {
    callback();
  } catch (error) {
    assert(false, `${label}: ${error.message.split(/\r?\n/)[0]}`);
  }
}

function run(files) {
  fs.writeFileSync(path.join(tmp, 'order.txt'), '', 'utf8');
  const result = spawnSync(process.execPath, [runner, ...files], {
    cwd: tmp,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function summaryFailures(result) {
  return result.stderr.split(/\r?\n/).filter(line => line.startsWith('  - '));
}

try {
  // 空白を含むファイル名もシェルを介さず渡し、親の作業ディレクトリで実行する。
  for (const [file, marker, status] of [
    ['first pass.js', 'first', 0],
    ['middle fail.js', 'middle', 7],
    ['last pass.js', 'last', 0],
  ]) {
    fs.writeFileSync(path.join(tmp, file), [
      "require('fs').appendFileSync('order.txt', " + JSON.stringify(marker + '\n') + ");",
      'console.log(' + JSON.stringify(marker) + ');',
      'console.error(' + JSON.stringify(`標準エラー: ${marker}`) + ');',
      `process.exitCode = ${status};`,
      '',
    ].join('\n'), 'utf8');
  }

  test('途中で失敗しても順番に最後まで実行する', () => {
    const result = run(['first pass.js', 'middle fail.js', 'last pass.js']);
    assert(fs.readFileSync(path.join(tmp, 'order.txt'), 'utf8') === 'first\nmiddle\nlast\n',
      '3本を指定順に親と同じ作業ディレクトリで実行する');
    assert(result.stdout.includes('last'), '失敗後の3本目の標準出力も流す');
    assert(result.stderr.includes('標準エラー: last'), '子の標準エラーも流す');
    assert(result.status === 1, '途中失敗時は終了コード1');
    assert(result.stderr.includes('試験ファイル 3 本中 1 本が失敗'), '全体の本数と失敗数を要約する');
    const failures = summaryFailures(result);
    assert(failures.length === 1 && failures[0] === '  - middle fail.js（終了コード 7）',
      '要約には失敗した1本と終了コードだけを載せる');
  });

  test('全件成功の要約', () => {
    const result = run(['first pass.js', 'last pass.js']);
    assert(result.status === 0, '全件成功時は終了コード0');
    assert(result.stdout.includes('試験ファイル 2 本: すべて通過'), '全件成功の本数を要約する');
    assert(summaryFailures(result).length === 0, '成功したファイルは失敗一覧に載せない');
  });

  test('存在しないファイルがあっても他を実行する', () => {
    const result = run(['first pass.js', 'missing.js', 'last pass.js']);
    assert(result.status === 1, '存在しないファイルがあれば終了コード1');
    assert(fs.readFileSync(path.join(tmp, 'order.txt'), 'utf8') === 'first\nlast\n',
      '存在する前後のファイルを実行する');
    assert(result.stderr.includes('試験ファイル 3 本中 1 本が失敗'), '未存在の1本を失敗数に含める');
    const failures = summaryFailures(result);
    assert(failures.length === 1 && failures[0] === '  - missing.js（見つかりません）',
      '未存在のファイル名と理由を要約する');
    assert(!result.stderr.includes('MODULE_NOT_FOUND'), '未存在のファイルの子は起動しない');
  });

  test('引数なしは実行しない', () => {
    const result = run([]);
    assert(result.status === 1 && result.stderr.includes('1本以上指定'), '引数なしをエラーにする');
    assert(!result.stdout.includes('すべて通過'), '0本で全件成功にしない');
    assert(fs.readFileSync(path.join(tmp, 'order.txt'), 'utf8') === '', '引数なしでは何も実行しない');
  });

  test('重複指定は実行前に止める', () => {
    for (const duplicate of ['first pass.js', './first pass.js']) {
      const result = run(['first pass.js', duplicate]);
      assert(result.status === 1 && result.stderr.includes('重複'), '同じファイルの重複をエラーにする');
      assert(fs.readFileSync(path.join(tmp, 'order.txt'), 'utf8') === '' && !result.stdout.includes('first'),
        '重複時は1本目も実行しない');
    }
  });

  test('masters:test の登録内容', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const command = pkg.scripts['masters:test'];
    const prefix = 'node scripts/run-test-files.js ';
    assert(command.startsWith(prefix) && !command.includes('&&'), 'masters:test は実行役を使う');
    const files = command.slice(prefix.length).trim().split(/\s+/);
    assert(new Set(files.map(file => path.resolve(ROOT, file))).size === files.length, '登録ファイルに重複がない');
    assert(files.every(file => fs.existsSync(path.join(ROOT, file))), '登録したすべてのファイルが存在する');
    assert(files.includes('scripts/lib/__tests__/test-run-test-files.js'), 'この試験自身も登録されている');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
