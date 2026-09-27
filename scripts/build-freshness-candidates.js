#!/usr/bin/env node
'use strict';

/**
 * 公開済み記事から更新候補を作る。記事本文や frontmatter は変更しない。
 *
 *   node scripts/build-freshness-candidates.js
 */

const fs = require('fs');
const path = require('path');
const freshness = require('./lib/freshness-candidates');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'freshness', 'candidates.json');

function run(options = {}) {
  const root = options.root || ROOT;
  const outputPath = options.outputPath || path.join(root, 'data', 'freshness', 'candidates.json');
  const now = options.now || new Date();
  const inputs = options.inputs || freshness.readInputs(root, now);
  const output = freshness.buildOutput(inputs, { now });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  (options.log || console.log)(`[freshness] → ${path.relative(root, outputPath)}（候補 ${output.candidates.length} 件）`);
  return output;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`[freshness] 生成に失敗しました: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ROOT, OUTPUT, run };
