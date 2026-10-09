'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkArticle } = require('./lib/fact-check');
const ROOT = path.join(__dirname, '..');

async function run(args = process.argv.slice(2), dependencies = {}) {
  const filename = args[0];
  if (!filename || filename.startsWith('-')) throw new Error('記事ファイルを指定してください');
  const absolute = path.resolve(ROOT, filename);
  const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
  if (relative.startsWith('../') || path.isAbsolute(relative) || !relative.endsWith('.md')) throw new Error('リポジトリ内の記事ファイルを指定してください');
  const refAt = args.indexOf('--ref');
  const ref = refAt >= 0 ? args[refAt + 1] : '';
  if (refAt >= 0 && (!ref || !/^[\w./-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..'))) throw new Error('枝名が不正です');
  const write = args.includes('--write');
  const read = dependencies.readArticle || ((file, branch) => branch
    ? execFileSync('git', ['show', `${branch}:${relative}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    : fs.readFileSync(file, 'utf8'));
  const raw = read(absolute, ref);
  const result = await (dependencies.checkArticle || checkArticle)(raw, { ...dependencies, repair: write });
  if (write) (dependencies.writeArticle || ((file, content) => fs.writeFileSync(file, content, 'utf8')))(absolute, result.content);
  const output = `事実の照合: ${result.record.status}\n${result.record.summary}\n記録: data/fact-check/${result.record.slug}.json`;
  (dependencies.log || console.log)(output);
  if (process.env.GITHUB_STEP_SUMMARY && !dependencies.skipSummary) {
    // 記事由来の内容でMarkdownを組み立てず、固定形式の要約とJSONを載せる。
    const summary = `事実の照合: ${result.record.status}\n\n${result.record.summary}\n\n` +
      '````json\n' + JSON.stringify(result.record, null, 2).replace(/`/g, '\\u0060') + '\n````\n';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
  return result;
}

if (require.main === module) run().catch(() => {
  console.error('照合処理を完了できませんでした。記事ファイル・枝名・設定を確認してください。');
  process.exitCode = 1;
});
module.exports = { run };
