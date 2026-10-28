'use strict';

// 通信は fetch で偽装する。git の試験だけ OS の一時フォルダを使う。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyRevision, extractSectionHint, splitRevisionPoints } = require('../revision-classifier');
const P = require('../partial-revise');
const G = require('../../generate-draft');
const root = path.resolve(__dirname, '../../..');
const fixtures = path.join(root, 'docs/codex-tasks/revise-multi-point/fixtures');
const read = name => fs.readFileSync(path.join(fixtures, name), 'utf8');
const existing = read('644-before.md');
const originalBody = G.parseFrontmatter(existing).body;
const comment = read('644-comment-1.txt');
const split = splitRevisionPoints(comment);
const sections = P.splitSections(originalBody).sections;
const replacements = split.points.map(point => {
  const match = point.text.match(/「([^」]+)」を、?「([^」]+)」(?:という内容)?に/);
  assert(match, `試験データの置換指摘 ${point.no}`);
  return { old: match[1], next: match[2] };
});
const sources = { combined: '【試験用出典本文】\n試験用の固定資料です。', figures: [] };
const saved = { env: { ...process.env }, fetch: global.fetch, log: console.log, warn: console.warn };
const requests = [], logs = [];
let reply;
let passed = 0, failed = 0, skipped = 0;

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
  Object.assign(process.env, saved.env);
}
function reset() {
  restoreEnv();
  for (const key of ['CONTENT_MODEL', 'ENABLE_MULTI_POINT_REVISE', 'ENABLE_PARTIAL_REVISE']) delete process.env[key];
  Object.assign(process.env, { CONTENT_MODEL_PROVIDER: 'gateway', AI_GATEWAY_API_KEY: 'test-only',
    FACT_PLAN_ENABLED: 'false', ENABLE_LLM_SOURCE_SELECT: 'false' });
  requests.length = logs.length = 0;
  reply = () => { throw new Error('偽の LLM の応答が未設定'); };
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions', '未偽装の通信先');
    const request = JSON.parse(options.body);
    const content = request.messages.find(message => message.role === 'user').content;
    const user = typeof content === 'string' ? content : content.map(part => part.text || '').join('');
    requests.push({ ...request, user });
    const output = await reply(user, requests.length);
    return { ok: true, json: async () => ({ choices: [{
      message: { content: typeof output === 'string' ? output : output.text },
      finish_reason: typeof output === 'string' ? 'stop' : output.finish,
    }] }) };
  };
  console.log = console.warn = (...args) => logs.push(args.join(' '));
}
async function test(name, run) {
  reset();
  try {
    const reason = await run();
    if (reason) { skipped++; saved.log(`SKIP ${name}: ${reason}`); }
    else { passed++; saved.log(`PASS ${name}`); }
  } catch (error) {
    failed++;
    saved.log(`FAIL ${name}\n${error.stack}`);
  }
}
function inputBody(user) {
  const marker = '【記事本文（現状）— これを全文ベースに、指摘箇所のみ最小修正したものを出力】\n';
  if (user.includes(marker)) return user.split(marker)[1].split('\n\n穏当な')[0];
  return user.split('【対象セクション（現状）】\n')[1].split('\n\n【試験用出典本文】')[0];
}
function fix(text, indexes) {
  for (const index of indexes) text = text.split(replacements[index].old).join(replacements[index].next);
  return text;
}
function fixturePlan() {
  const plan = G.getMultiPointRevisionPlan(existing, comment);
  assert(plan, '#644 の指摘は複数指摘の経路に進む');
  return plan;
}
function fixtureReply(user) {
  if (user.includes('JSON形式で {"title"')) {
    const { meta } = G.parseFrontmatter(existing);
    return JSON.stringify({ title: meta.title, summary: meta.summary });
  }
  const selected = split.points.filter(point => user.includes(point.text)).map(point => point.no - 1);
  assert.equal(selected.length, 1, 'その段の指摘だけを渡す');
  return fix(inputBody(user), selected);
}
const article = body => `---\ntitle: "試験用の記事タイトル"\nsummary: "試験用の要約"\nupdated_at: "2026-10-01"\nreview_status: "needs_revision"\nreview_comment: "確認"\n---\n${body}`;

async function main() {
  await test('1 番号付き指摘の分割・原文・前置き', () => {
    assert.equal(split.preface, comment.split(/\r?\n/)[0]);
    assert.deepEqual(split.points.map(point => point.no), [1, 2, 3]);
    assert.deepEqual(split.points.map(point => point.text), comment.trim().split(/\r?\n\s*\r?\n/).slice(1));
    for (const text of ['①一つ目\n続き\n\n②二つ目', '（1）一つ目\n（2）二つ目',
      '１．一つ目\n２．二つ目', ' 1) 一つ目\n 2) 二つ目', '1、あ\n2、い', '(1)あ\n(2)い']) {
      assert.deepEqual(splitRevisionPoints(text).points.map(point => point.no), [1, 2]);
    }
    for (const text of ['1.あ\n3.い', '1.あ', '・あ\n・い', '-あ\n-い', '*あ\n●い',
      '前置きだけ', '2.あ\n3.い', '1.あ\n2)い', '①あ\n2.い', '1.あ\n2.い\n2.う', '¹.あ\n².い']) {
      assert.deepEqual(splitRevisionPoints(text).points, []);
    }
  });
  await test('2 #644 の分類・h3 の親・段順・指示の分離', () => {
    const plan = P.planRevisionSteps(split, sections);
    assert.equal(plan.fallback, false);
    assert.deepEqual(plan.steps.map(step => [step.kind, step.points, step.heading]), [
      ['section', [1], '贈与税の非課税制度 一覧比較'],
      ['section', [3], '各制度の詳細と判断ポイント'], ['targeted', [2], undefined],
    ]);
    for (const step of plan.steps) for (const point of split.points) {
      assert.equal(step.instruction.includes(point.text), step.points.includes(point.no));
      assert(step.instruction.includes(split.preface));
    }
  });
  await test('3 全文再生成・禁止意図があれば既存経路', () => {
    for (const text of ['全体的に書き直してください', 'このテーマは今後書かないでください']) {
      assert.equal(P.planRevisionSteps(splitRevisionPoints(`1. 表を直してください\n2. ${text}`), sections).fallback, true);
      assert.equal(P.planRevisionSteps(splitRevisionPoints(`1. 表を直してください\n2. ${text}${'補足の説明です。'.repeat(20)}`), sections).fallback, true);
    }
  });
  await test('3b 長さだけで全文分類された具体的な置換指摘は targeted', () => {
    const point = `2. 「変更前の文章です」を「変更後の文章です」に直してください。${'確認する資料の記載を根拠にしてください。'.repeat(8)}`;
    assert(point.length > 120);
    assert.equal(classifyRevision(point).type, 'full_regenerate', '単独コメントの既存分類は変えない');
    const plan = P.planRevisionSteps(splitRevisionPoints(`1. 表を直してください\n${point}`), sections);
    assert.equal(plan.fallback, false);
    const targeted = plan.steps.find(step => step.kind === 'targeted');
    assert.deepEqual(targeted.points, [2]);
    assert.deepEqual(targeted.classification, {
      type: 'factual_correction', scope: 'targeted', sectionHint: '変更前の文章です',
      reason: '指摘が長い（複数の指摘の 1 つなので全文の最小修正）', denySuppression: false,
    });
    assert(targeted.instruction.includes(point));
  });
  await test('4 実際の混入行を除去し、段落の混入と税務の文章を区別', () => {
    const after = G.parseFrontmatter(read('644-after-run-40484642578.md')).body;
    const notes = P.removeNewInternalNotes(originalBody, after);
    assert.equal(notes.removed.length, 1);
    assert(notes.removed[0].startsWith('※差し戻しコメントの2・3は'));
    assert.equal(notes.contaminated, false);
    assert(!notes.body.includes('差し戻しコメント'));
    assert.equal(P.removeNewInternalNotes(originalBody, `${originalBody}\n差し戻しコメントの2は対象外のため変更していません。`).contaminated, true);
    const tax = '税務署からの指摘で修正申告をしました。';
    const next = `${originalBody}\n${tax}\n税務調査で指摘を受けたら修正申告を検討します。`;
    const clean = P.removeNewInternalNotes(`${originalBody}\n${tax}`, next);
    assert.equal(clean.body, next);
    assert.equal(clean.contaminated, false);
  });
  await test('5 #644 の通し: 資料は1回、本文LLMは3回、タイトル・要約を保持', async () => {
    reply = user => {
      assert(!user.includes('JSON形式で {"title"'), 'title の段がない場合は本文だけを修正する');
      return fixtureReply(user);
    };
    let materials = 0;
    const output = await G.regenerateMultiPoint(existing, comment, fixturePlan(), {
      buildSourceBlocks: async meta => { materials++; meta.tax_terms = '試験資料'; return sources; },
    });
    assert.equal(materials, 1);
    const bodyRequests = requests.filter(request => request.user.includes('【対象セクション（現状）】') || request.user.includes('【記事本文（現状）—'));
    const titleRequests = requests.filter(request => request.user.includes('JSON形式で {"title"'));
    assert.equal(bodyRequests.length, 3);
    assert.equal(titleRequests.length, 0);
    assert.equal(requests.length, bodyRequests.length + titleRequests.length);
    assert(inputBody(bodyRequests[0].user).startsWith('## 贈与税の非課税制度 一覧比較'));
    assert(inputBody(bodyRequests[1].user).startsWith('## 各制度の詳細と判断ポイント'));
    assert(inputBody(bodyRequests[2].user).includes('## よくある質問'));
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.review_status, 'draft');
    assert.equal(meta.review_comment, '');
    assert.equal(meta.tax_terms, '試験資料');
    assert.equal(meta.title, G.parseFrontmatter(existing).meta.title);
    assert.equal(meta.summary, G.parseFrontmatter(existing).meta.summary);
    for (const swap of replacements) { assert(!body.includes(swap.old)); assert(body.includes(swap.next)); }
    assert(inputBody(bodyRequests[2].user).includes(replacements[0].next));
    assert(inputBody(bodyRequests[2].user).includes(replacements[2].next));
  });
  await test('6 章の末尾に追加された作業注記を最終本文から除去', async () => {
    reply = (user, no) => fixtureReply(user) + (no === 1 ? '\n\n※差し戻しコメントの2・3は対象外のため変更していません。' : '');
    const output = await G.regenerateMultiPoint(existing, comment, fixturePlan(), { sourceBlocks: sources });
    assert(!G.parseFrontmatter(output).body.includes('差し戻しコメント'));
    assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
    assert(logs.some(line => line.includes('作業の注記を除去')));
  });
  await test('7 1点目だけ反映し、2・3点目の未反映を警告', async () => {
    reply = (user, no) => no === 1 ? fixtureReply(user)
      : user.includes('JSON形式で {"title"') ? fixtureReply(user) : inputBody(user);
    const output = await G.regenerateMultiPoint(existing, comment, fixturePlan(), { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert(!body.includes(replacements[0].old));
    assert(body.includes(replacements[1].old));
    assert(body.includes(replacements[2].old));
    assert.equal(meta.review_status, 'needs_revision');
    for (const text of ['【自動反映は一部のみ】', '2 点目', '3 点目']) assert(meta.review_comment.includes(text));
  });
  await test('8 false のときはコメント全体の分類と1回のLLM', async () => {
    process.env.ENABLE_MULTI_POINT_REVISE = 'FaLsE';
    assert.equal(G.getMultiPointRevisionPlan(existing, comment), null);
    const classification = classifyRevision(comment);
    assert.equal(classification.type, 'table_fix');
    reply = user => fix(inputBody(user), [0]);
    await G.regenerateSection(existing, comment, classification, { sourceBlocks: sources });
    assert.equal(requests.length, 1);
    for (const point of split.points) assert(requests[0].user.includes(point.text));
    process.env.ENABLE_MULTI_POINT_REVISE = 'true';
    process.env.ENABLE_PARTIAL_REVISE = 'FALSE';
    assert.equal(G.getMultiPointRevisionPlan(existing, comment), null);
  });
  await test('9 単一指摘 targeted の注記除去・段落混入時は元本文', async () => {
    const body = '## 確認事項\n\n十分な長さの確認事項です。'.repeat(4);
    for (const inline of [false, true]) {
      requests.length = 0;
      reply = () => `${body}\n\n${inline ? '' : '※'}差し戻しコメントは対象外のため変更していません。`;
      const output = await G.regenerateTargeted(article(body), '確認事項の誤字を修正してください', {
        preserveTitle: true, sourceBlocks: sources,
      });
      assert.equal(requests.length, 1);
      const parsed = G.parseFrontmatter(output);
      assert(!parsed.body.includes('差し戻しコメント'));
      assert.equal(parsed.meta.review_status, inline ? 'needs_revision' : 'draft');
      if (inline) { assert(parsed.meta.review_comment.includes('【自動再生成の警告】')); assert.equal(parsed.body.trim(), body); }
    }
  });
  await test('10 ワークフローの data 復元順・env・run の式禁止', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/regenerate-draft.yml'), 'utf8');
    const checkout = workflow.indexOf('git checkout --no-overlay origin/main -- scripts/ data/');
    const restore = workflow.indexOf('git checkout --no-overlay HEAD -- data/fact-check/ 2>/dev/null || true');
    assert(checkout > 0 && restore > checkout && restore < workflow.indexOf('git reset -q'));
    assert(workflow.includes('git checkout origin/main -- package.json package-lock.json'));
    const regen = workflow.split('- name: Regenerate draft')[1].split('\n      - ')[0];
    assert(regen.includes('ENABLE_PARTIAL_REVISE: ${{ vars.ENABLE_PARTIAL_REVISE }}\n          ENABLE_MULTI_POINT_REVISE: ${{ vars.ENABLE_MULTI_POINT_REVISE }}'));
    let runIndent = null;
    for (const line of workflow.split(/\r?\n/)) {
      if (runIndent !== null && line.trim() && line.match(/^\s*/)[0].length <= runIndent) runIndent = null;
      const run = line.match(/^(\s*)run: \|/);
      if (run) runIndent = run[1].length;
      else if (runIndent !== null) assert(!line.includes('${{'), 'run 内に式を埋め込まない');
    }
    const script = fs.readFileSync(path.join(root, 'scripts/generate-draft.js'), 'utf8');
    assert(script.includes("type: 'multi_point', scope:"));
    assert(script.includes("writeGithubOutputs(ghOut, { revision_type: classification.type, revision_scope: scope })"));
  });
  await test('11 古い draft に main のデータを補い、照合記録と空のindexを保持', () => {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return `git を利用できない: ${probe.error?.code === 'EPERM' ? '隔離による EPERM' : probe.error?.message || probe.stderr}`;
    let dir;
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revise-multi-point-')); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return `OS の一時フォルダへ書けない: ${error.code}`; throw error; }
    const gitConfig = path.join(dir, 'empty-global-gitconfig');
    let repoDir;
    const runGit = (args, allowFailure = false) => {
      const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      } });
      if (result.error) throw result.error;
      if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout;
    };
    const git = (...args) => runGit(args);
    const write = (name, value) => {
      const file = path.join(repoDir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    };
    try {
      fs.writeFileSync(gitConfig, '');
      for (const hasRecord of [true, false]) {
        repoDir = path.join(dir, hasRecord ? 'with-record' : 'without-record');
        fs.mkdirSync(repoDir);
        git('init', '-b', 'main');
        write('old.txt', 'old'); write('data/deleted.json', '{"obsolete":true}');
        write('content/posts/a.md', 'old');
        git('add', '.'); git('commit', '-m', 'old'); git('branch', 'draft');
        write('scripts/x.js', "console.log(require('../data/new.json').value);");
        fs.unlinkSync(path.join(repoDir, 'data/deleted.json'));
        write('data/new.json', '{"value":"main"}'); write('data/fact-check/a.json', 'main');
        write('package.json', '{}'); write('package-lock.json', '{}');
        git('add', '.'); git('commit', '-m', 'main data');
        git('checkout', 'draft'); write('content/posts/a.md', 'draft');
        if (hasRecord) write('data/fact-check/a.json', 'draft');
        git('add', '.'); git('commit', '-m', 'draft record');
        git('checkout', '--no-overlay', 'main', '--', 'scripts/', 'data/');
        git('checkout', 'main', '--', 'package.json', 'package-lock.json');
        runGit(['checkout', '--no-overlay', 'HEAD', '--', 'data/fact-check/'], true);
        git('reset', '-q');
        const result = spawnSync(process.execPath, ['scripts/x.js'], { cwd: repoDir, encoding: 'utf8' });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'main');
        assert.equal(fs.existsSync(path.join(repoDir, 'data/deleted.json')), false, 'main で消えたデータは残さない');
        if (hasRecord) assert.equal(fs.readFileSync(path.join(repoDir, 'data/fact-check/a.json'), 'utf8'), 'draft');
        assert.equal(git('diff', '--cached'), '');
        // ワークフローと同じ記事・対応照合記録だけの add でも main の記録を混入させない。
        write('content/posts/a.md', 'regenerated'); git('add', 'content/posts/a.md');
        if (fs.existsSync(path.join(repoDir, 'data/fact-check/a.json'))) git('add', 'data/fact-check/a.json');
        assert.deepEqual(git('diff', '--cached', '--name-only').trim().split(/\r?\n/), ['content/posts/a.md']);
      }
    } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) return `一時 git 試験を実行できない: ${error.code === 'EPERM' ? '隔離による EPERM' : error.code}`;
      throw error;
    } finally {
      const resolved = path.resolve(dir), tempRoot = path.resolve(os.tmpdir()) + path.sep;
      assert(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('revise-multi-point-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  await test('F1 表の指摘は表のない h3 の親を選ばない', () => {
    const classification = classifyRevision('表の「相続時精算課税」の行の対象者の欄を「正しい対象者」に直してください。');
    assert.equal(classification.type, 'table_fix');
    assert.equal(P.findTargetSectionIndex(sections, classification.sectionHint, classification.type), 3);
    assert.equal(sections[3].heading, '贈与税の非課税制度 一覧比較');
    const nestedTable = P.splitSections('## 詳細\n### 対象者\n|項目|内容|\n|---|---|\n|対象|説明|').sections;
    assert.equal(P.findTargetSectionIndex(nestedTable, '対象者', 'table_fix'), 0);
  });
  await test('F2 節税・節約を章指定にせず、本来の節指定は維持', () => {
    for (const text of ['「小規模企業共済」の節税効果の説明が分かりにくいので直してください',
      '「iDeCo」の節税メリットを具体的な金額で示してください', '「経費管理」の節約効果を説明してください']) {
      assert.equal(classifyRevision(text).type, 'factual_correction');
    }
    assert.equal(extractSectionHint('小規模企業共済の節税効果'), '');
    assert.equal(extractSectionHint('経費管理の節約効果'), '');
    assert.equal(classifyRevision('「確認事項」の節を直してください').type, 'section_only');
  });
  await test('F3 本文の太字・箇条書きを保ち、作業の断り書きだけ除去', () => {
    for (const line of ['**2点目：修正申告の期限が変更されます**', '* 1点目は、申告期限の変更です']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, line); assert.deepEqual(notes.removed, []); assert.equal(notes.contaminated, false);
    }
    const tax = '※税務署からご指摘を受けた場合は修正申告を検討します。';
    const notes = P.removeNewInternalNotes('', tax);
    assert.equal(notes.body, tax); assert.deepEqual(notes.removed, []); assert.equal(notes.contaminated, true);
    for (const line of ['※ほかの指摘は別の段で直すため、ここでは変更していません。',
      '※その他の箇所は変更していません。']) {
      const cleaned = P.removeNewInternalNotes('', line);
      assert.equal(cleaned.body, ''); assert.deepEqual(cleaned.removed, [line]); assert.equal(cleaned.contaminated, false);
    }
    const completed = P.removeNewInternalNotes('', '※変更しました。');
    assert.equal(completed.body, '※変更しました。'); assert.deepEqual(completed.removed, []); assert.equal(completed.contaminated, false);
    const untouched = P.removeNewInternalNotes('', '※触れていません。');
    assert.equal(untouched.body, '※触れていません。'); assert.deepEqual(untouched.removed, []); assert.equal(untouched.contaminated, true);
    for (const context of ['この段', '別の段', 'ほかの指摘', '他の指摘', 'ほかの箇所', '他の箇所', 'その他の箇所', 'その他の指摘']) {
      assert.equal(P.removeNewInternalNotes('', `${context}はそのままです。`).contaminated, true);
    }
    assert.equal(P.removeNewInternalNotes('', '**この段は修正しました。**').contaminated, true);
    assert.equal(P.removeNewInternalNotes('', '* ご依頼の内容を変更しました。').contaminated, true);
  });
  await test('F4 新文が旧文を含む置換は新文の増加で判定', async () => {
    const old = '暦年課税の基礎控除は年110万円です', next = `${old}（受贈者1人あたり）`;
    const source = article(`## 確認事項\n\n${old}。\n\n既存の説明：${next}。`);
    const text = `1. 「${old}」を「${next}」に直してください\n2. 語尾を丁寧にしてください`;
    for (const applied of [true, false]) {
      reply = user => applied ? inputBody(user).replace(old, next) : inputBody(user).replace('既存の説明', '別の説明');
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const { meta, body } = G.parseFrontmatter(output);
      assert.equal(meta.review_status, applied ? 'draft' : 'needs_revision');
      assert.equal(body.split(next).length - 1, applied ? 2 : 1);
      if (applied) assert.equal(meta.review_comment, '');
      else assert(meta.review_comment.includes('1 点目（指定の文が残っている）'));
    }
  });
  await test('F4 追加の指摘を置換と誤認しない', async () => {
    const old = '贈与税の配偶者控除の要件';
    const source = article(`## 確認事項\n\n${old}。\n\n## よくある質問\n\n回答です。`);
    const text = `1. 「${old}」を「よくある質問」に追加してください\n2. 語尾を丁寧にしてください`;
    reply = user => inputBody(user).replace('回答です。', `回答です。${old}も確認してください。`);
    const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
    assert.equal(G.parseFrontmatter(output).body.split(old).length - 1, 2);
  });
  await test('F5 前置きの全文書き直し・禁止意図を保持し、長さだけなら継続', () => {
    const points = '\n1. 誤字を修正してください\n2. 語尾を丁寧にしてください';
    for (const preface of ['全体的に書き直してください。特に次の点です。', 'このテーマは今後書かないでください']) {
      assert.equal(P.planRevisionSteps(splitRevisionPoints(preface + points), sections).fallback, true);
    }
    assert.equal(P.planRevisionSteps(splitRevisionPoints('読みやすさを確認してください。'.repeat(15) + points), sections).fallback, false);
    const fixture = fixturePlan();
    assert(!fixture.steps.some(step => step.kind === 'title'));
  });
  await test('F5 前置きのタイトル指示を最後の段で実行し、重複を統合', async () => {
    const preface = 'タイトルも合わせて自然にしてください。';
    const text = `${preface}\n1. 誤字を修正してください\n2. 語尾を丁寧にしてください`;
    const source = article('## 確認事項\n\n文章です。');
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['targeted', 'title']);
    reply = user => user.includes('【記事本文（現状）—') ? inputBody(user).replace('文章です。', '文章でした。')
      : JSON.stringify({ title: '自然な記事タイトル', summary: '自然な要約です。' });
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.title, '自然な記事タイトル');
    assert(G.parseFrontmatter(output).body.includes('文章でした。'));
    assert.equal(requests.length, 2); assert(requests[1].user.includes(preface));
    const merged = P.planRevisionSteps(splitRevisionPoints(`${preface}\n1. タイトルだけ修正してください\n2. 誤字を修正してください`), sections);
    assert.equal(merged.steps.filter(step => step.kind === 'title').length, 1);
    assert.deepEqual(merged.steps.find(step => step.kind === 'title').points, [1]);
  });
  await test('F6 注記を除くと入力と同じ章は未反映として前の本文を保持', async () => {
    const source = article('## 一つ目の章\n\n一つ目の説明です。\n\n## 二つ目の章\n\n二つ目の説明です。');
    const text = '1. 「一つ目の章」の章を直してください\n2. 「二つ目の章」の章を直してください';
    for (const spaces of [false, true]) {
      reply = (user, no) => no % 2 === 1
        ? (spaces ? inputBody(user).replace(/\n/g, ' \r\n') : inputBody(user)) + '\n\n※この段の指摘には対応していません。'
        : inputBody(user).replace('二つ目の説明', '改善した説明');
      requests.length = 0;
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const { meta, body } = G.parseFrontmatter(output);
      assert.equal(meta.review_status, 'needs_revision');
      assert(meta.review_comment.includes('1 点目（出力が入力と同じ）'));
      assert(body.includes('一つ目の説明です。')); assert(body.includes('改善した説明です。'));
      assert(!body.includes('この段'));
    }
  });
  await test('F6 全文の段も入力と同じなら未反映、F7 失敗理由を保持', async () => {
    const source = article('## 確認事項\n\n最初の文章です。');
    const text = '1. 「確認事項」の章を直してください\n2. 誤字を修正してください';
    for (const contaminated of [false, true]) {
      requests.length = 0;
      reply = (user, no) => no === 1 ? inputBody(user).replace('最初の文章', '改善した文章')
        : inputBody(user) + (contaminated ? '\n差し戻しコメントの内容は修正していません。' : '\n※その他の箇所は変更していません。');
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const { meta, body } = G.parseFrontmatter(output);
      assert.equal(meta.review_status, 'needs_revision'); assert(body.includes('改善した文章'));
      assert(meta.review_comment.includes(contaminated ? '2 点目（作業の説明を本文に書いたため）' : '2 点目（出力が入力と同じ）'));
    }
  });
  await test('F7 最初と異なる番号の種類は指摘内の列挙として保持', () => {
    const text = '前置き\n1. 確認事項を直してください\n(1) 期限\n(2) 書類\n2. 語尾を直してください';
    const result = splitRevisionPoints(text);
    assert.deepEqual(result.points.map(point => point.no), [1, 2]);
    assert.equal(result.points[0].text, '1. 確認事項を直してください\n(1) 期限\n(2) 書類');
    assert.deepEqual(splitRevisionPoints('1. 一つ目\n(1) 補足\n3. 三つ目').points, []);
  });
  await test('F7 README は更新案にも R4 が効くことを明示', () => {
    assert(fs.readFileSync(path.join(root, 'docs/codex-tasks/revise-multi-point/README.md'), 'utf8')
      .includes('ただし R4（作業の注記の除去・混入の扱い）は更新案にも効く'));
  });

  await test('G1 文脈語・報告・注記の印がそろった断り書きだけ除去', () => {
    for (const line of ['※上記以外の部分は変更しておりません。', '※ここは直していません。',
      '（ほかの部分は変更していません）', '※それ以外の文は修正しておりません。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, ''); assert.deepEqual(notes.removed, [line]); assert.equal(notes.contaminated, false);
    }
    for (const line of ['※変更しておりません。', '※直していません。', '触れておりません。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, line); assert.deepEqual(notes.removed, []); assert.equal(notes.contaminated, true);
      assert.equal(P.removeNewInternalNotes(line, line).contaminated, false, '既存の行は保持');
    }
    for (const line of ['※対応しました。', '*1 免税事業者は対象外です。', '※白色申告者は対象外です。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, line); assert.deepEqual(notes.removed, []); assert.equal(notes.contaminated, false);
    }
  });
  await test('G1 税務上の対象外の注記を保持して章を採用', async () => {
    for (const line of ['※白色申告者は対象外です。', '*1 免税事業者は対象外です。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, line); assert.equal(notes.contaminated, false, line);
      const source = article('## 確認事項\n\n元の説明を確認します。');
      reply = user => inputBody(user).replace('元の説明', '改善した説明') + '\n\n' + line;
      const output = await G.regenerateSection(source, '「確認事項」の章を直してください', {
        type: 'section_only', sectionHint: '確認事項',
      }, { sourceBlocks: sources });
      assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
      assert(G.parseFrontmatter(output).body.includes(line));
    }
  });
  await test('G1 記事の対象範囲の否定報告は消さずに混入とし、その段を破棄', async () => {
    const line = '※本記事では住民税には触れていません。';
    const notes = P.removeNewInternalNotes('', line);
    assert.equal(notes.body, line); assert.deepEqual(notes.removed, []); assert.equal(notes.contaminated, true);
    const source = article('## 確認事項\n\n元の説明を確認します。\n\n## 別の章\n\n別の説明を確認します。');
    const text = '1. 「確認事項」の章を直してください\n2. 「別の章」の章を直してください';
    reply = user => inputBody(user).includes('## 確認事項')
      ? inputBody(user).replace('元の説明', '改善した説明') + '\n\n' + line
      : inputBody(user).replace('別の説明', '改善した別の説明');
    const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.review_status, 'needs_revision');
    assert(meta.review_comment.includes('1 点目（LLM が作業の説明を本文に書いたため）'));
    assert(body.includes('元の説明を確認します。')); assert(body.includes('改善した別の説明を確認します。'));
    assert(!body.includes(line)); assert(!body.includes('改善した説明'));
  });
  await test('G1 期限の税務注記を修正した行が残り、複数指摘の段が成功', async () => {
    const old = '※令和8年3月31日までの契約が対象で、それ以後は対象外です。';
    const next = '※令和9年3月31日までの契約が対象で、それ以後は対象外です。';
    const source = article(`## 制度の期限\n\n${old}\n\n## 確認事項\n\n元の説明を確認します。`);
    const text = '1. 「制度の期限」の章で契約期限を直してください\n2. 「確認事項」の章を直してください';
    reply = user => inputBody(user).replace(old, next).replace('元の説明', '改善した説明');
    const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.review_status, 'draft'); assert.equal(meta.review_comment, '');
    assert(body.includes(next)); assert(!body.includes(old));
  });
  await test('G2 否定の前置き・指摘で全文書き直しやタイトル段を選ばない', () => {
    const points = '\n1. 誤字を修正してください\n2. 語尾を丁寧にしてください';
    for (const preface of ['構成を変えずに、次の点を直してください。', '対象読者は変えずに次を直してください。',
      'テーマを変えずに直してください。', 'タイトルは変えないでください。']) {
      const plan = P.planRevisionSteps(splitRevisionPoints(preface + points), sections);
      assert.equal(plan.fallback, false, preface); assert(!plan.steps.some(step => step.kind === 'title'), preface);
      assert(plan.steps.every(step => step.instruction.includes(preface)), '原文の制約は指示に保持');
    }
    const plan = P.planRevisionSteps(splitRevisionPoints('1. 誤字を修正してください\n2. 構成を変えずに表現を直す'), sections);
    assert.equal(plan.fallback, false); assert(plan.steps.every(step => step.kind !== 'title'));
    assert.equal(P.planRevisionSteps(splitRevisionPoints('全体的に書き直してください。特に次の点です。' + points), sections).fallback, true);
    for (const deny of ['このテーマは今後書かないでください。' + points,
      '1. 誤字を修正してください\n2. このテーマは今後書かないでください。']) {
      assert.equal(P.planRevisionSteps(splitRevisionPoints(deny), sections).fallback, true, '禁止意図は元の文で判定');
    }
    for (const negative of ['ないで', 'ずに', 'せず', 'ません', 'ないよう', 'しない']) {
      const split = splitRevisionPoints(`構成を変え${negative}。タイトルだけ自然にしてください。${points}`);
      const mixed = P.planRevisionSteps(split, sections);
      assert.equal(mixed.fallback, false); assert(mixed.steps.some(step => step.kind === 'title'));
    }
  });
  await test('G3 変えてください等の置換でも旧文が残れば未反映', async () => {
    const old = '古い説明の文章です', next = '新しい説明の文章です';
    const source = article(`## 確認事項\n\n${old}。補足です。`);
    for (const verb of ['変えてください', ' 変更してください', '直してください', '修正してください', '訂正してください',
      '置き換えてください', '置換してください', '書き換えてください', '書換してください', '差し替えてください',
      '差替してください', '改めてください', '統一してください', 'してください', 'します']) {
      const text = `1. 「${old}」を「${next}」に${verb}\n2. 語尾を丁寧にしてください`;
      reply = user => inputBody(user).replace('補足です。', '補足を追加しました。');
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const parsed = G.parseFrontmatter(output);
      assert.equal(parsed.meta.review_status, 'needs_revision', verb);
      assert(parsed.meta.review_comment.includes('1 点目（指定の文が残っている）'), verb);
      assert(parsed.body.includes(old));
    }
    const text = `1. 「${old}」を「よくある質問」に直接追加してください\n2. 語尾を丁寧にしてください`;
    reply = user => inputBody(user) + `\n\nよくある質問：${old}。`;
    const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft', '直接追加は置換ではない');
  });
  await test('G4 禁止表現の置換だけでは章・全文の指摘を成功にしない', async () => {
    const source = article('## 確認事項\n\n読後に書類を確認します。\n\n## 別の章\n\n元の説明を確認します。');
    const text = '1. 「確認事項」の章を直してください\n2. 「別の章」の章を直してください';
    reply = user => inputBody(user).replace('元の説明', '改善した説明');
    const section = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    assert(G.parseFrontmatter(section).meta.review_comment.includes('1 点目（出力が入力と同じ）'));
    assert.equal(G.parseFrontmatter(section).meta.review_status, 'needs_revision');
    const targetedText = '1. 「別の章」の章を直してください\n2. 語尾を丁寧にしてください';
    const targeted = await G.regenerateMultiPoint(source, targetedText, G.getMultiPointRevisionPlan(source, targetedText), { sourceBlocks: sources });
    assert(G.parseFrontmatter(targeted).meta.review_comment.includes('2 点目（出力が入力と同じ）'));
    assert.equal(G.parseFrontmatter(targeted).meta.review_status, 'needs_revision');
  });
  await test('G4 節減・節目・節度を章の指定と読まない', () => {
    for (const text of ['「交際費」の節減効果', '「定年」の節目', '「会食」の節度']) {
      assert.notEqual(classifyRevision(text).type, 'section_only');
    }
    for (const text of ['交際費の節減効果', '定年の節目', '会食の節度']) assert.equal(extractSectionHint(text), '');
    assert.equal(classifyRevision('「確認事項」の節を直してください').type, 'section_only');
  });

  await test('H1 弱い文脈語の触れ・反映・対応は削除せず混入、変更・修正・直し・変えだけ除去', () => {
    for (const line of ['※ここでは住民税には触れていません。', '（ここでは贈与税には触れていません）',
      '※上記以外の所得控除は反映していません。', '※ここでは対応しておりません。',
      '※ここでは変更しましたが、住民税には触れていません。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, line); assert.deepEqual(notes.removed, []); assert.equal(notes.contaminated, true, line);
      assert.equal(P.removeNewInternalNotes(line, line).contaminated, false, '既存の行は保持');
    }
    for (const line of ['※上記以外の部分は変更しておりません。', '※ここは直していません。',
      '（ほかの部分は変更していません）', '※それ以外の文は修正しておりません。', '※ここは変えておりません。',
      '※ご指摘以外の箇所には触れていません。', '※差し戻しコメントの内容は反映していません。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, ''); assert.deepEqual(notes.removed, [line]); assert.equal(notes.contaminated, false, line);
    }
    for (const line of ['※他の記述は変えていません。', '※指摘以外の箇所はそのままです。']) {
      const notes = P.removeNewInternalNotes('', line);
      assert.equal(notes.body, line); assert.equal(notes.contaminated, true, line);
    }
  });
  await test('H1 単一の章・全文と複数指摘で税務注記を含む出力を捨てる', async () => {
    const source = article('## 確認事項\n\n元の説明を確認します。\n\n## 別の章\n\n別の説明を確認します。');
    const text = '1. 「確認事項」の章を直してください\n2. 「別の章」の章を直してください';
    for (const line of ['※ここでは住民税には触れていません。', '（ここでは贈与税には触れていません）',
      '※上記以外の所得控除は反映していません。']) {
      reply = user => inputBody(user).replace('元の説明', '改善した説明') + '\n\n' + line;
      const section = await G.regenerateSection(source, '「確認事項」の章を直してください', {
        type: 'section_only', sectionHint: '確認事項',
      }, { sourceBlocks: sources });
      const targeted = await G.regenerateTargeted(source, '誤字を修正してください', { preserveTitle: true, sourceBlocks: sources });
      for (const output of [section, targeted]) {
        const { meta, body } = G.parseFrontmatter(output);
        assert.equal(meta.review_status, 'needs_revision'); assert(meta.review_comment.includes('【自動再生成の警告】'));
        assert.equal(body.trim(), G.parseFrontmatter(source).body.trim());
      }
      reply = user => inputBody(user).includes('## 確認事項')
        ? inputBody(user).replace('元の説明', '改善した説明') + '\n\n' + line
        : inputBody(user).replace('別の説明', '改善した別の説明');
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const { meta, body } = G.parseFrontmatter(output);
      assert.equal(meta.review_status, 'needs_revision'); assert(meta.review_comment.includes('1 点目（LLM が作業の説明を本文に書いたため）'));
      assert(body.includes('元の説明を確認します。')); assert(body.includes('改善した別の説明を確認します。')); assert(!body.includes(line));
    }
  });
  await test('H2 引用内の否定語と区切りは保持し、否定節の後のタイトル指示を実行', async () => {
    const source = article('## 確認事項\n\n元の説明を確認します。');
    for (const quoted of ['「登録しないとどうなる？」', '『登録しない、場合。どうする？』']) {
      const text = `1. 「確認事項」の章を直してください\n2. タイトルを${quoted}に変更してください`;
      const plan = G.getMultiPointRevisionPlan(source, text);
      assert.deepEqual(plan.steps.map(step => step.kind), ['section', 'title']);
      reply = user => user.includes('【対象セクション（現状）】') ? inputBody(user).replace('元の説明', '改善した説明')
        : JSON.stringify({ title: quoted.slice(1, -1), summary: '要約です。' });
      const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
      assert.equal(G.parseFrontmatter(output).meta.title, quoted.slice(1, -1));
      assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
    }
    const text = '構成は変えずに、タイトルだけ自然にしてください。\n1. 誤字を修正してください\n2. 語尾を丁寧にしてください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['targeted', 'title']);
    reply = user => user.includes('【記事本文（現状）—') ? inputBody(user).replace('元の説明', '改善した説明')
      : JSON.stringify({ title: '自然な記事タイトル', summary: '要約です。' });
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.title, '自然な記事タイトル');
  });
  await test('H2 否定節の後の章追加を保持して実行', async () => {
    const source = article('## 確認事項\n\n元の説明を確認します。\n\n## まとめ\n\nまとめです。');
    const text = '1. 「確認事項」の章を直してください\n2. 既存の章は変えずに、注意点の章を追加してください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['section', 'add_section']);
    reply = user => user.includes('【対象セクション（現状）】') ? inputBody(user).replace('元の説明', '改善した説明')
      : '## 注意点\n\n必要な書類を確認してください。';
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
    assert(G.parseFrontmatter(output).body.includes('## 注意点'));
  });
  await test('H2 否定節に明示された対象章への具体例は targeted の段で扱う', () => {
    const source = article('## 確認事項\n\n元の説明です。');
    const text = '1. 誤字を修正してください\n2. 「確認事項」の章は削らずに、具体例を足してください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    const step = plan.steps.find(step => step.points.includes(2));
    assert.equal(step.kind, 'targeted');
    assert(step.instruction.includes('「確認事項」の章は削らずに、具体例を足してください'));
  });
  await test('H3 「にする場合」の説明追記を置換と読まない', async () => {
    const source = article('## 確認事項\n\n簡易課税制度の適用を確認します。');
    const text = '1. 「簡易課税制度」を「原則課税」にする場合の注意を追記してください\n2. 語尾を丁寧にしてください';
    reply = user => inputBody(user) + '\n\n原則課税にする場合は、必要な手続きを確認してください。';
    const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.review_status, 'draft'); assert.equal(meta.review_comment, '');
    assert(body.includes('簡易課税制度')); assert(body.includes('原則課税にする場合'));
  });

  await test('I1 a タイトルの否定は語尾の修正を妨げず、タイトル・要約を保持', async () => {
    const source = article('## 確認事項\n\n元の説明を確認する。');
    const text = '1. 「確認事項」の章を直してください\n2. タイトルは変えないで、語尾を丁寧にしてください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['section', 'targeted']);
    reply = user => user.includes('【対象セクション（現状）】') ? inputBody(user).replace('元の説明', '改善した説明')
      : inputBody(user).replace('確認する。', '確認します。');
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.review_status, 'draft'); assert(body.includes('確認します。'));
    assert.equal(meta.title, G.parseFrontmatter(source).meta.title);
    assert.equal(meta.summary, G.parseFrontmatter(source).meta.summary);
    assert.equal(requests.length, 2);
    assert(requests[1].user.includes(splitRevisionPoints(text).points[1].text), '否定の制約は原文で渡す');
  });
  await test('I1 b 章追加の否定は既存の注意点の章への追記として実行', async () => {
    const source = article('## 確認事項\n\n元の説明です。\n\n## 注意点\n\n既存の注意事項です。');
    const text = '1. 「確認事項」の章を直してください\n2. 新しい章を追加せず、既存の「注意点」の章に追記してください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => [step.kind, step.heading]), [['section', '確認事項'], ['section', '注意点']]);
    reply = user => inputBody(user).replace('元の説明', '改善した説明').replace('既存の注意事項です。', '既存の注意事項です。必要な書類も確認します。');
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.review_status, 'draft'); assert(body.includes('必要な書類も確認します。'));
    assert.deepEqual(P.splitSections(body).sections.map(section => section.heading), ['確認事項', '注意点']);
    assert.equal(requests.length, 2);
  });
  await test('I1 c・d 指摘番号や結びを肯定の手がかりにしてタイトル段を作らない', () => {
    const markers = [['1.', '2.'], ['１．', '２．'], ['1)', '2)'], ['１）', '２）'], ['1、', '2、'],
      ['(1)', '(2)'], ['（１）', '（２）'], ['①', '②']];
    for (const [first, second] of markers) {
      for (const ending of ['', '。よろしくお願いします。']) {
        const text = `${first} 誤字を修正してください\n${second}タイトルは変えないでください${ending}`;
        const points = splitRevisionPoints(text);
        assert.equal(points.points.length, 2, text);
        const plan = P.planRevisionSteps(points, sections);
        assert.equal(plan.fallback, false, text);
        assert.deepEqual(plan.steps.map(step => step.kind), ['targeted'], text);
        assert.deepEqual(plan.steps[0].points, [1, 2], text);
        assert(plan.steps[0].instruction.includes(points.points[1].text), '元の番号は指示に保持');
      }
    }
  });
  await test('I1 e 前置きのタイトル禁止からタイトル段を作らない', () => {
    for (const preface of ['タイトルは変えないで、次の点を直してください。', 'タイトルは変えずに、語尾を丁寧にしてください。']) {
      const text = preface + '\n1. 誤字を修正してください\n2. 語尾を丁寧にしてください';
      const plan = P.planRevisionSteps(splitRevisionPoints(text), sections);
      assert.equal(plan.fallback, false, preface);
      assert.deepEqual(plan.steps.map(step => step.kind), ['targeted'], preface);
      assert(plan.steps[0].instruction.includes(preface));
    }
  });
  await test('I1 f 否定された「はじめに」の章を対象にせず全文で最小修正', () => {
    const source = article('## はじめに\n\n導入です。\n\n## 注意点\n\n注意事項です。');
    const text = '1. 誤字を修正してください\n2. 「はじめに」の章は変えずに、「注意点」の説明を詳しくしてください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['targeted']);
    assert.deepEqual(plan.steps[0].points, [1, 2]);
    assert(plan.steps[0].instruction.includes(splitRevisionPoints(text).points[1].text));
  });
  await test('I1 否定節だけではタイトル分類にならない場合は安全網を保持', async () => {
    const source = article('## 確認事項\n\n元の説明です。');
    const text = '1. 誤字を修正してください\n2. タイトルの「完全ガイド」は消さずに、短く直してください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['targeted', 'title']);
    reply = user => user.includes('【記事本文（現状）—') ? inputBody(user).replace('元の説明', '改善した説明')
      : JSON.stringify({ title: '税務の完全ガイド', summary: '短い要約です。' });
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.title, '税務の完全ガイド');
    assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
  });
  await test('I2 読点なしの否定・改行の後のタイトル依頼を実行', async () => {
    const source = article('## 確認事項\n\n元の説明です。');
    for (const instruction of ['構成は変えずにタイトルだけ自然にしてください',
      'タイトルを変更してください\n既存の章は変えないでください']) {
      const text = '1. 誤字を修正してください\n2. ' + instruction;
      const plan = G.getMultiPointRevisionPlan(source, text);
      assert.deepEqual(plan.steps.map(step => step.kind), ['targeted', 'title'], instruction);
      reply = user => user.includes('【記事本文（現状）—') ? inputBody(user).replace('元の説明', '改善した説明')
        : JSON.stringify({ title: '自然な記事タイトル', summary: '要約です。' });
      const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
      assert.equal(G.parseFrontmatter(output).meta.title, '自然な記事タイトル');
      assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
      assert(requests[requests.length - 1].user.includes(instruction), '改行を含めて元の指示を渡す');
    }
  });
  await test('I2 読点なしの章追加を実行し、否定の終端と改行を区切る', async () => {
    const source = article('## 確認事項\n\n元の説明です。\n\n## まとめ\n\nまとめです。');
    const text = '1. 「確認事項」の章を直してください\n2. 既存の章は変えずに注意点の章を追加してください';
    const plan = G.getMultiPointRevisionPlan(source, text);
    assert.deepEqual(plan.steps.map(step => step.kind), ['section', 'add_section']);
    reply = user => user.includes('【対象セクション（現状）】') ? inputBody(user).replace('元の説明', '改善した説明')
      : '## 注意点\n\n必要な書類を確認してください。';
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    assert.equal(G.parseFrontmatter(output).meta.review_status, 'draft');
    assert(G.parseFrontmatter(output).body.includes('## 注意点'));
    for (const negative of ['既存の章を変更せずに', '既存の章は変えないで',
      '既存の章を変更しないでください\n', '既存の章を変更しないでください\r\n']) {
      const text = `1. 誤字を修正してください\n2. ${negative}注意点の章を追加してください`;
      const plan = G.getMultiPointRevisionPlan(source, text);
      assert.equal(plan.steps.find(step => step.points.includes(2)).kind, 'add_section', negative);
    }
  });
  await test('I2 ないでに依頼の語尾が続く場合は区切らず、引用内の区切りも保護', () => {
    for (const ending of ['ください', '下さい', 'ほしいです', 'いただけますか', 'もらえますか']) {
      const text = `1. 誤字を修正してください\n2. タイトルは変えないで${ending}`;
      const plan = P.planRevisionSteps(splitRevisionPoints(text), sections);
      assert.deepEqual(plan.steps.map(step => step.kind), ['targeted'], ending);
    }
    const text = '1. 誤字を修正してください\n2. タイトルを『変えないでタイトルだけ\nそのままずに。』に変更してください';
    const plan = P.planRevisionSteps(splitRevisionPoints(text), sections);
    assert.deepEqual(plan.steps.map(step => step.kind), ['targeted', 'title']);
    assert(plan.steps[1].instruction.includes(splitRevisionPoints(text).points[1].text));
  });

  await test('補足: 同じ章の指摘を統合し、追加・全文・タイトルを順序づける', () => {
    const points = splitRevisionPoints('前置き\n1. タイトルだけ自然にしてください\n2. 具体例の章を追加してください\n3. 「確認事項」の章を直してください\n4. 「確認事項」の章だけ丁寧にしてください\n5. 誤字を修正してください\n6. 注意点の章を追加してください');
    const plan = P.planRevisionSteps(points, P.splitSections('## 確認事項\n本文です。').sections);
    assert.equal(plan.fallback, false);
    assert.deepEqual(plan.steps.map(step => [step.kind, step.points]), [
      ['section', [3, 4]], ['add_section', [2]], ['add_section', [6]], ['targeted', [5]], ['title', [1]],
    ]);
  });
  await test('補足: 節・h3 の完全一致、表記揺れ、fuzzy と h2 優先', () => {
    assert.equal(classifyRevision('「確認事項」の節を直してください').type, 'section_only');
    assert.equal(extractSectionHint('確認事項の節を直してください'), '確認事項');
    const nested = P.splitSections('## 親の章\n### この記事で分かること\n本文\n### 申請書類の確認手順\n本文\n## この記事でわかること\n本文').sections;
    assert.equal(P.findTargetSectionIndex(nested, 'この記事でわかること', ''), 1);
    assert.equal(P.findTargetSectionIndex(nested.slice(0, 1), 'この記事でわかること', ''), 0);
    assert.equal(P.findTargetSectionIndex(nested, '申請書類の確認手順です', ''), 0);
  });
  await test('補足: 注記の各接頭辞、出現回数、既存の語を保全', () => {
    for (const prefix of ['※', '＊', '*', '注:', '注：', '（※', '(※', '【注']) {
      const notes = P.removeNewInternalNotes('前\n\n後', `前\n\n${prefix}ご指示どおり変更しました。\n\n後`);
      assert.equal(notes.body, '前\n\n後'); assert.equal(notes.contaminated, false);
    }
    const old = '差し戻しコメントに対応した記録です。';
    assert.equal(P.removeNewInternalNotes(old, old).contaminated, false);
    assert.equal(P.removeNewInternalNotes(old, `${old}\n${old}`).contaminated, true);
    assert.equal(P.removeNewInternalNotes('', '出典本文ブロック').contaminated, true);
    const spaced = '前\n\n\n中\n\n後';
    assert.equal(P.removeNewInternalNotes(spaced, '前\n\n\n中\n\n※ご依頼に対応しました。\n\n後').body, spaced);
  });
  await test('補足: 短縮再試行でも注記を除去し、混入は入力に戻す', async () => {
    const body = '## 確認事項\n\n' + '確認する文章を維持します。'.repeat(100);
    for (const inline of [false, true]) {
      requests.length = 0;
      reply = (_, no) => no === 1 ? '短い出力' : `${body}\n\n${inline ? '' : '※'}ご指示に従って修正しました。`;
      const output = await G.regenerateTargeted(article(body), '誤字を修正してください', { preserveTitle: true, sourceBlocks: sources });
      assert.equal(requests.length, 2);
      assert.equal(G.parseFrontmatter(output).meta.review_status, inline ? 'needs_revision' : 'draft');
      assert(!G.parseFrontmatter(output).body.includes('ご指示'));
    }
  });
  await test('補足: 単一の章の差し替え・追加にも混入ガード', async () => {
    const body = '## 確認事項\n\n元の文章です。\n\n## まとめ\n\nまとめです。';
    for (const type of ['section_only', 'add_section']) for (const inline of [false, true]) {
      requests.length = 0;
      reply = () => `## 補足事項\n\n修正後の説明です。\n\n${inline ? '' : '※'}ご依頼の内容を修正しました。`;
      const output = await G.regenerateSection(article(body), '説明を直してください', { type, sectionHint: '確認事項' }, { sourceBlocks: sources });
      assert.equal(requests.length, 1);
      assert.equal(G.parseFrontmatter(output).meta.review_status, inline ? 'needs_revision' : 'draft');
      assert(!G.parseFrontmatter(output).body.includes('ご依頼'));
    }
  });
  await test('補足: 全段未反映なら元本文を保持し警告', async () => {
    const body = '## 確認事項\n\n古い文章の一つ目です。古い文章の二つ目です。';
    const text = '1. 「古い文章の一つ目」を「新しい文章の一つ目」に修正してください\n2. 『古い文章の二つ目』を、削除してください';
    const source = article(body), plan = G.getMultiPointRevisionPlan(source, text);
    reply = user => inputBody(user);
    const output = await G.regenerateMultiPoint(source, text, plan, { sourceBlocks: sources });
    const parsed = G.parseFrontmatter(output);
    assert.equal(parsed.body.trim(), body);
    assert.equal(parsed.meta.review_status, 'needs_revision');
    assert(parsed.meta.review_comment.includes('【自動再生成の警告】'));
  });
  await test('補足: 一部の章が短縮・混入・不正でも成功した段を保持', async () => {
    const body = '## 一つ目の章\n\n最初の文章は維持します。\n\n## 二つ目の章\n\n' + '二つ目の文章を維持します。'.repeat(40);
    const source = article(body), text = '1. 「一つ目の章」の章を直してください\n2. 「二つ目の章」の章を直してください';
    for (const bad of ['## 二つ目の章\n短縮', '章の見出しのない説明文', `## 二つ目の章\n${'本文です。'.repeat(150)}\nご指摘の内容を修正しました。`]) {
      requests.length = 0;
      reply = (user, no) => no === 1 ? inputBody(user).replace('最初の文章', '改善した文章') : bad;
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const parsed = G.parseFrontmatter(output);
      assert(parsed.body.includes('改善した文章')); assert(parsed.body.includes('二つ目の文章を維持します。'));
      assert(parsed.meta.review_comment.includes('2 点目'));
    }
  });
  await test('補足: 章・追加・全文・タイトルを実行し、まとめの前へ追加', async () => {
    const source = article('## 確認事項\n\n最初の文章です。\n\n## まとめ\n\nまとめの文章です。');
    const text = '1. タイトルを「新しい記事タイトル」に変更してください\n2. 注意点の章を追加してください\n3. 「確認事項」の章を直してください\n4. 誤字を修正してください';
    reply = (user, no) => no === 2 ? '## 注意点\n\n追加した文章です。\n\n※ご指示どおり追加対応しました。'
      : inputBody(user).replace(no === 1 ? '最初の文章' : 'まとめの文章', no === 1 ? '改善した文章' : '確認した文章');
    const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
    const { meta, body } = G.parseFrontmatter(output);
    assert.equal(meta.title, '新しい記事タイトル');
    assert.equal(meta.review_status, 'draft');
    assert.equal(meta.review_comment, '');
    assert.equal(requests.length, 3, 'タイトルの直接指定では追加のLLMを呼ばない');
    assert(body.includes('改善した文章')); assert(body.includes('確認した文章'));
    assert(body.indexOf('## 注意点') < body.indexOf('## まとめ'));
    assert(!body.includes('ご指示'));
    assert(inputBody(requests[2].user).includes('改善した文章'));
    assert(inputBody(requests[2].user).includes('追加した文章'));
  });
  await test('補足: 全文の段が短縮再試行・混入で失敗しても前段を保持', async () => {
    const body = '## 確認事項\n\n最初の文章です。\n\n## 維持事項\n\n' + '古い全文の文章を含め、文章はそのまま維持します。'.repeat(40);
    const source = article(body);
    const text = '1. 「確認事項」の章を直してください\n2. 「古い全文の文章」を「新しい全文の文章」に修正してください';
    for (const contaminated of [false, true]) {
      requests.length = 0;
      reply = (user, no) => no === 1 ? inputBody(user).replace('最初の文章', '改善した文章')
        : contaminated ? `${inputBody(user)}\nご依頼の内容を変更しました。` : '短い出力';
      const output = await G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources });
      const { meta, body: revised } = G.parseFrontmatter(output);
      assert.equal(requests.length, contaminated ? 2 : 3);
      assert(revised.includes('改善した文章')); assert(revised.includes('古い全文の文章'));
      assert(!revised.includes('ご依頼'));
      assert.equal(meta.review_status, 'needs_revision');
      assert(meta.review_comment.includes('【自動反映は一部のみ】'));
      assert(meta.review_comment.includes('2 点目'));
    }
  });
  await test('補足: 段の途切れ・モデル例外を握りつぶさない', async () => {
    const source = article('## 一つ目の章\n本文です。\n## 二つ目の章\n本文です。');
    const text = '1. 「一つ目の章」の章を直してください\n2. 「二つ目の章」の章を直してください';
    reply = (user, no) => no === 1 ? inputBody(user) : { text: '## 二つ目の章\n途中', finish: 'length' };
    await assert.rejects(G.regenerateMultiPoint(source, text, G.getMultiPointRevisionPlan(source, text), { sourceBlocks: sources }), error => error.contentBodyTruncated === true);
  });
}

main().catch(error => { failed++; saved.log(error.stack); }).finally(() => {
  restoreEnv(); global.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn;
  saved.log(`\nPASS: ${passed} / FAIL: ${failed} / SKIP: ${skipped}`);
  if (failed) process.exitCode = 1;
});
