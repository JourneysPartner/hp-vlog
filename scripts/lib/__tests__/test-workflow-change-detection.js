'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const TARGETS = {
  'crawl-nta-sources.yml': 'data/nta-sources',
  'crawl-nta-tsutatsu.yml': 'data/nta-tsutatsu',
  'refresh-nta-qa.yml': 'data/nta-qa',
  'crawl-law-sources.yml': 'data/law-sources',
  'export-contact-transitions.yml': 'data/contact-transitions.json',
  'update-suggest-topics.yml': 'data/search-suggest-topics.json data/search-suggest',
  'check-tax-reform.yml': 'data/tax-reform-outline.json',
};
const ARTICLE_WORKFLOWS = [
  'daily-draft.yml',
  'publish-scheduled.yml',
  'regenerate-draft.yml',
];

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

function readWorkflow(filename) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, filename), 'utf8');
}

console.log('\n=== workflow change detection ===');

for (const [filename, args] of Object.entries(TARGETS)) {
  test(`${filename} は共有スクリプトを正しい引数で呼ぶ`, () => {
    const source = readWorkflow(filename);
    assert(source.includes(`node scripts/has-substantive-change.js ${args} >> "$GITHUB_OUTPUT"`));
  });

  test(`${filename} の PR 作成条件は changed 出力を見る`, () => {
    const source = readWorkflow(filename);
    assert(/if:.*steps\.changes\.outputs\.changed\s*==\s*'true'/.test(source));
  });
}

test('旧 has_changes 出力への参照は全ワークフローでゼロ', () => {
  const references = fs.readdirSync(WORKFLOW_DIR)
    .filter(filename => /\.ya?ml$/.test(filename))
    .flatMap(filename => {
      const source = readWorkflow(filename);
      return source.includes('steps.changes.outputs.has_changes') ? [filename] : [];
    });
  assert.deepStrictEqual(references, []);
});

test('記事系ワークフローは作業ツリーで変更されていない', () => {
  const result = spawnSync(
    'git',
    ['diff', '--quiet', 'HEAD', '--', ...ARTICLE_WORKFLOWS.map(f => `.github/workflows/${f}`)],
    { cwd: ROOT },
  );
  assert.strictEqual(result.status, 0);
});

console.log(`\n${passed} tests passed`);
