'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const workflows = fs.readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name)).sort()
  .map(filename => {
    const source = fs.readFileSync(path.join(WORKFLOWS, filename), 'utf8');
    const scalars = [];
    const starts = [];
    const document = yaml.load(source, { listener(event, state) {
      if (event === 'open') starts.push(state.position);
      else {
        const start = starts.pop();
        if (state.kind === 'scalar' && typeof state.result === 'string') {
          scalars.push({ value: state.result, start, end: state.position });
        }
      }
    } });
    return { filename, source, document, scalars };
  });
const dangerousExpression = /\$\{\{\s*(?:inputs\.|github\.event\.|steps\.[\w-]+\.outputs\.|needs\.[\w-]+\.outputs\.|github\.head_ref\b)[\s\S]*?\}\}/g;

let passed = 0;
let failed = 0;
function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${label}\n${error.message}`);
  }
}

test('試験1: 全ワークフローの実行コードに外部値を直接埋め込まない', () => {
  const findings = [];
  const counts = {};
  let expressionCount = 0;
  for (const { filename, source, document, scalars } of workflows) {
    const used = new Set();
    for (const [jobName, job] of Object.entries(document.jobs || {})) {
      for (const [index, step] of (job.steps || []).entries()) {
        const scripts = [['run', step.run]];
        if (/^actions\/github-script@/.test(step.uses || '')) {
          scripts.push(['with.script', step.with && step.with.script]);
        }
        for (const [field, script] of scripts) {
          if (typeof script !== 'string') continue;
          const scalar = scalars.find(value => value.value === script && !used.has(value.start));
          assert(scalar, `${filename}: 実行コードの位置を特定できません`);
          used.add(scalar.start);
          for (const match of source.slice(scalar.start, scalar.end).matchAll(dangerousExpression)) {
            const line = source.slice(0, scalar.start + match.index).split('\n').length;
            expressionCount++;
            if (!used.has(`line:${line}`)) {
              counts[filename] = (counts[filename] || 0) + 1;
              used.add(`line:${line}`);
            }
            findings.push(`${filename}:${line} ${jobName} / ${step.name || step.id || step.uses || index} (${field}): ${match[0]}`);
          }
        }
      }
    }
  }
  if (findings.length) {
    console.error(findings.join('\n'));
    console.error(`検出行数: ${JSON.stringify(counts)} / 合計 ${Object.values(counts).reduce((a, b) => a + b, 0)} 行・${expressionCount} 式`);
  }
  assert.strictEqual(findings.length, 0, `直接埋め込みが ${findings.length} か所あります`);
});

// Windows の標準 bash（WSL ランチャー）より Git Bash を優先する。
const bash = process.platform === 'win32'
  ? [
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe'),
  ].find(filename => fs.existsSync(filename)) || 'bash'
  : 'bash';
const toShellPath = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const shellEnvironment = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
  if (process.env[key] !== undefined) shellEnvironment[key] = process.env[key];
}

function spawnBash(args, options) {
  const result = spawnSync(bash, ['--noprofile', '--norc', ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    env: shellEnvironment, ...options,
  });
  if (result.error) throw new Error(`bash の起動に失敗: ${result.error.code}`);
  assert(!result.signal, `bash がシグナルで終了: ${result.signal}`);
  return result;
}

function stepIn(filename, name) {
  const workflow = workflows.find(value => value.filename === filename);
  const step = Object.values(workflow.document.jobs).flatMap(job => job.steps || [])
    .find(value => value.name === name);
  assert(step, `${filename}: 手順 ${name} がありません`);
  return step;
}

function resolveExpression(expression, values) {
  const [key, fallback] = expression.trim().split(/\s*\|\|\s*/);
  if (values[key]) return values[key];
  return fallback && /^'[^']*'$/.test(fallback) ? fallback.slice(1, -1) : '';
}

function render(value, values) {
  return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => resolveExpression(expr, values));
}

// 実際の run を実行し、外部送信・リポジトリ操作・固定パスへの書き込みを関数で置き換える。
function runStep(filename, name, makeValues, check) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-run-injection-'));
  try {
    const marker = path.join(temp, 'pwned');
    const payload = `題名 "引用" \`文字\` $(touch ${quote(toShellPath(marker))})`;
    const values = makeValues({ payload, multiline: `${payload}\n次の行`, marker: toShellPath(marker) });
    const step = stepIn(filename, name);
    const env = { ...shellEnvironment };
    for (const [key, value] of Object.entries(step.env || {})) env[key] = render(value, values);
    env.CAPTURE = toShellPath(path.join(temp, 'commands'));
    env.GITHUB_OUTPUT = toShellPath(path.join(temp, 'output'));
    env.GITHUB_STEP_SUMMARY = toShellPath(path.join(temp, 'summary'));
    const stubs = `
record_command() { local command="$1"; shift; printf '%s\\0' "$command" "$#" "$@" >> "$CAPTURE"; }
node() { record_command node "$@"; }
git() { record_command git "$@"; }
gh() { record_command gh "$@"; printf '%s\\n' 'https://example.test/pr/1'; }
cp() { record_command cp "$@"; }
mkdir() { record_command mkdir "$@"; }
curl() { record_command curl "$@"; }
tee() { record_command tee "$@"; cat; }
tail() { record_command tail "$@"; }
date() { printf '%s\\n' 2026; }
`;
    const result = spawnBash(['-e', '-o', 'pipefail'], {
      cwd: temp, env, input: stubs + '\n' + render(step.run, values),
    });
    assert(!fs.existsSync(marker), `${filename} / ${name}: 入力のコマンドが実行されました`);
    const read = basename => fs.existsSync(path.join(temp, basename))
      ? fs.readFileSync(path.join(temp, basename), 'utf8') : '';
    const words = read('commands').split('\0');
    const commands = [];
    for (let i = 0; i < words.length - 1;) {
      const command = words[i++];
      const count = Number(words[i++]);
      assert(Number.isInteger(count) && count >= 0, '引数の記録が壊れています');
      commands.push({ command, args: words.slice(i, i + count) });
      i += count;
    }
    check({ ...result, commands, output: read('output'), values, payload, multiline: `${payload}\n次の行` });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function success(result) {
  assert.strictEqual(result.status, 0, `手順が失敗: ${result.stderr}\n${result.stdout}`);
}

function rejected(result) {
  assert.notStrictEqual(result.status, 0, '不正な入力を受け入れました');
  assert(result.stdout.includes('::error::'), '入力拒否のエラーがありません');
  assert.deepStrictEqual(result.commands, [], '入力の拒否前にコマンドを呼んでいます');
  assert.strictEqual(result.output, '', '入力の拒否前に出力を書いています');
}

function nodeArgs(result) {
  success(result);
  const calls = result.commands.filter(value => value.command === 'node');
  assert.strictEqual(calls.length, 1, 'node の呼び出しは1回の想定です');
  return calls[0].args;
}

function argument(args, name) {
  const index = args.indexOf(name);
  assert(index >= 0, `引数 ${name} がありません`);
  return args[index + 1];
}

test('試験2: bash の全 run の構文を確認する', () => {
  let checked = 0;
  for (const { filename, document } of workflows) {
    for (const job of Object.values(document.jobs || {})) {
      for (const step of job.steps || []) {
        if (typeof step.run !== 'string') continue;
        const shell = step.shell || job.defaults?.run?.shell || document.defaults?.run?.shell;
        if (shell && !/^bash(?:\s|$)/.test(shell)) continue;
        const result = spawnBash(['-n'], { input: step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'test_value') });
        assert.strictEqual(result.status, 0, `${filename} / ${step.name || step.id}: ${result.stderr}`);
        checked++;
      }
    }
  }
  assert(checked > 0, '構文確認の対象がありません');
  console.log(`  ${checked} 手順の構文を確認`);
});

test('試験3: 記事1通知の題名・要約は改行を含め入力どおりに渡る', () => {
  runStep('daily-draft.yml', 'Notify article 1', ({ multiline }) => ({
    'steps.prep.outputs.title1': multiline,
    'steps.prep.outputs.summary1': multiline,
    'steps.prep.outputs.basename1': 'article.md',
    'steps.pr1.outputs.branch': 'draft/article',
    'steps.pr1.outputs.pr_url': 'https://example.test/pr/1',
  }), result => {
    const args = nodeArgs(result);
    assert.strictEqual(args[0], 'scripts/notify.js');
    assert.strictEqual(argument(args, '--title'), result.multiline);
    assert.strictEqual(argument(args, '--summary'), result.multiline);
  });
});

test('試験3: 記事1の PR 題名・本文のペア題名は入力どおりに渡る', () => {
  runStep('daily-draft.yml', 'Create branch & PR for article 1', ({ multiline }) => ({
    'steps.prep.outputs.date': '2026-10-20',
    'steps.prep.outputs.slug1': 'article',
    'steps.prep.outputs.basename1': 'article.md',
    'steps.prep.outputs.title1': multiline,
    'steps.prep.outputs.title2': multiline,
    'steps.prep.outputs.article_role1': 'main',
    'steps.prep.outputs.article_type1': 'guide',
  }), result => {
    success(result);
    const calls = result.commands.filter(value => value.command === 'gh');
    assert.strictEqual(calls.length, 1);
    const args = calls[0].args;
    assert.deepStrictEqual(args.slice(0, 2), ['pr', 'create']);
    assert.strictEqual(argument(args, '--title'), `【本命記事】${result.multiline}`);
    assert(argument(args, '--body').includes(`| ペア記事 | ${result.multiline} |`));
  });
});

test('試験3: 予約公開通知は題名をそのまま渡し、既存の先頭行だけの読み取りも維持する', () => {
  for (const withNewline of [false, true]) {
    runStep('publish-scheduled.yml', 'Notify Chatwork (per article)', ({ payload, multiline }) => ({
      'steps.promote.outputs.published_titles': withNewline ? multiline : payload,
      'steps.promote.outputs.published_slugs': 'article',
      'steps.promote.outputs.published_categories': 'tax',
      'steps.promote.outputs.published_personas': 'business',
    }), result => {
      const args = nodeArgs(result);
      assert.strictEqual(argument(args, '--title'), result.payload);
      assert.strictEqual(argument(args, '--public-url'), 'https://mori-zeirishi.net/blog/article/');
    });
  }
});

test('試験3: 税制改正の通知の報告文は改行を含め入力どおりに渡る', () => {
  runStep('check-tax-reform.yml', 'Notify', ({ multiline }) => ({
    'steps.year.outputs.year': '2026', 'steps.check.outputs.report': multiline,
  }), result => {
    const args = nodeArgs(result);
    assert.strictEqual(argument(args, '--title'), '税制改正の大綱に未登録の項目があります（2026年度）');
    assert.strictEqual(argument(args, '--comment'), result.multiline);
  });
});

test('試験3 R2: year は空または4桁だけを受け入れる', () => {
  for (const year of ['', '2026', '0000']) {
    runStep('check-tax-reform.yml', 'Determine year', () => ({ 'github.event.inputs.year': year }), result => {
      success(result);
      assert.strictEqual(result.output, `year=${year || '2026'}\n`);
    });
  }
  for (const year of ['202', '20260', '２０２６', '2026\nextra', '2026; touch pwned']) {
    runStep('check-tax-reform.yml', 'Determine year', () => ({ 'github.event.inputs.year': year }), rejected);
  }
});

test('試験3 R2: as_of は空または日付の形だけを受け入れる', () => {
  for (const asOf of ['', '2026-10-20']) {
    runStep('check-tax-simulator-masters.yml', 'Check master freshness', () => ({ 'github.event.inputs.as_of': asOf }), result => {
      assert.deepStrictEqual(nodeArgs(result), ['scripts/check-master-freshness.js', ...(asOf ? ['--as-of', asOf] : [])]);
    });
  }
  for (const asOf of ['2026-1-20', '2026/10/20', '2026-10-20\nextra', '2026-10-20; touch pwned']) {
    runStep('check-tax-simulator-masters.yml', 'Check master freshness', () => ({ 'github.event.inputs.as_of': asOf }), rejected);
  }
});

function modeCase(mode, max, check) {
  runStep('crawl-nta-sources.yml', 'Determine crawl mode', () => ({
    'github.event.inputs.mode': mode, 'github.event.inputs.max_pages': max,
  }), check);
}

test('試験3 R2: mode は既定値または既存の3択だけを受け入れる', () => {
  for (const mode of ['', 'incremental', 'full', 'backfill-figures']) {
    modeCase(mode, '', result => {
      success(result);
      const expectedMode = mode || 'incremental';
      const args = expectedMode === 'full' ? '' : expectedMode === 'incremental' ? '--incremental ' : '--backfill-figures ';
      assert.strictEqual(result.output, `args=${args}\nmode=${expectedMode}\n`);
    });
  }
  for (const mode of ['unknown', 'full --evil', 'full\nextra', 'full; touch pwned']) modeCase(mode, '', rejected);
});

test('試験3 R2: max_pages は空または1以上の整数だけを受け入れる', () => {
  for (const max of ['', '1', '42', '999999999999999999999999999999']) {
    for (const mode of ['incremental', 'full', 'backfill-figures']) {
      modeCase(mode, max, result => {
        success(result);
        const limit = max ? `--max-pages ${max}` : '';
        const prefix = mode === 'full' ? '' : mode === 'incremental' ? '--incremental ' : '--backfill-figures ';
        assert.strictEqual(result.output, `args=${prefix}${limit}\nmode=${mode}\n`);
      });
    }
  }
  for (const max of ['0', '-1', '1.5', '1 --evil', '1\nextra', '1; touch pwned']) modeCase('incremental', max, rejected);
});

for (const [filename, name, script, prefix] of [
  ['crawl-law-sources.yml', 'Run crawl', 'scripts/crawl-law-sources.js', ['--verbose']],
  ['crawl-nta-tsutatsu.yml', 'Crawl', 'scripts/crawl-nta-tsutatsu.js', []],
  ['refresh-nta-qa.yml', 'Crawl', 'scripts/crawl-nta-qa.js', []],
]) {
  test(`試験3 R2: ${filename} の only は許可文字だけを1引数で渡す`, () => {
    for (const only of ['', 'shotoku', 'minpo,koseki', 'Aa09_-,.:/']) {
      runStep(filename, name, () => ({ 'github.event.inputs.only': only }), result => {
        assert.deepStrictEqual(nodeArgs(result), [script, ...prefix, ...(only ? ['--only', only] : [])]);
      });
    }
    for (const only of ['a b', 'a\tb', 'a\nb', 'a*', 'a?', 'a[0]', 'a=1', 'a; touch pwned', '日本語']) {
      runStep(filename, name, () => ({ 'github.event.inputs.only': only }), rejected);
    }
    runStep(filename, name, ({ payload }) => ({ 'github.event.inputs.only': payload }), rejected);
  });
}

test('試験3 R2: クロールの出力引数は従来どおり空白で分けて渡す', () => {
  for (const [args, expected] of [
    ['', []], ['--incremental ', ['--incremental']],
    ['--max-pages 42', ['--max-pages', '42']],
    ['--incremental --max-pages 42', ['--incremental', '--max-pages', '42']],
    ['--backfill-figures --max-pages 42', ['--backfill-figures', '--max-pages', '42']],
  ]) {
    runStep('crawl-nta-sources.yml', 'Run crawl', () => ({ 'steps.mode.outputs.args': args }), result => {
      assert.deepStrictEqual(nodeArgs(result), ['scripts/crawl-nta-sources.js', ...expected]);
    });
  }
});

console.log(`\nPASS ${passed} / FAIL ${failed}`);
process.exitCode = failed ? 1 : 0;
