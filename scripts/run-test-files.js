'use strict';

// 試験ごとの出力を保ち、失敗しても後続を順番に実行する。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = process.argv.slice(2);
const resolvedFiles = files.map(file => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
});

if (files.length === 0) {
  console.error('試験ファイルを1本以上指定してください');
  process.exitCode = 1;
} else if (new Set(resolvedFiles).size !== files.length) {
  console.error('試験ファイルの指定が重複しています。何も実行しません');
  process.exitCode = 1;
} else {
  const failures = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      failures.push(`${file}（見つかりません）`);
      continue;
    }
    const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    if (result.error) {
      failures.push(`${file}（起動できません: ${result.error.message}）`);
    } else if (result.status === null) {
      failures.push(`${file}（シグナル ${result.signal || '不明'}）`);
    } else if (result.status !== 0) {
      failures.push(`${file}（終了コード ${result.status}）`);
    }
  }

  if (failures.length === 0) {
    console.log(`\n試験ファイル ${files.length} 本: すべて通過`);
    process.exitCode = 0;
  } else {
    console.error(`\n試験ファイル ${files.length} 本中 ${failures.length} 本が失敗`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}
