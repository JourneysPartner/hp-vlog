'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const refresh = require('../freshness-refresh');
const workflow = require('../freshness-workflow');
const githubOutput = require('../github-output');
const sourceGuard = require('../source-guard');

const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function article({ version = true, body = '導入です。\n\n## 年分\n令和7年分の手続きを説明します。' } = {}) {
  return [
    '---',
    'title: "元の記事題名"',
    'summary: "元の要約"',
    'review_status: "published"',
    'review_comment: "既存コメント"',
    'created_at: "2025-01-01T00:00:00+09:00"',
    'updated_at: "2025-03-01T00:00:00+09:00"',
    'publish_at: "2025-02-01T00:00:00+09:00"',
    'published_at: "2025-02-01T00:00:00+09:00"',
    'publish_slot: "evening"',
    'approved_at: "2025-01-31T00:00:00+09:00"',
    'source_url: "https://www.nta.go.jp/example"',
    'source_title: "元の出典"',
    'source_confidence: 4',
    ...(version ? ['source_guard_version: 1'] : []),
    '---',
    body,
    '',
  ].join('\r\n');
}

function changedOutput(source, body, alterMetadata = false, warning = '') {
  const split = refresh.splitDocument(source);
  let fm = split.frontmatter;
  if (alterMetadata) {
    fm = fm.replace('title: "元の記事題名"', 'title: "LLMが変えた題名"')
      .replace('summary: "元の要約"', 'summary: "LLMが変えた要約"')
      .replace('updated_at: "2025-03-01T00:00:00+09:00"', 'updated_at: "2030-01-01"')
      .replace('source_url: "https://www.nta.go.jp/example"', 'source_url: "https://example.invalid/changed"');
  }
  if (warning) fm = fm.replace('review_comment: "既存コメント"', `review_comment: "${warning}"`);
  return fm + body;
}

async function runFake(content, reasons, output, options = {}) {
  const calls = [];
  const callback = async (source, instruction, classification) => {
    calls.push({ source, instruction, classification });
    return typeof output === 'function' ? output(source, calls.length) : output;
  };
  const result = await refresh.runRefresh({
    content,
    reasons,
    taxYear: 2026,
    now: new Date('2026-10-01T02:00:00Z'),
    regenerateSection: callback,
    regenerateTargeted: callback,
    findInternalProcessWords: options.findInternalProcessWords,
  });
  return { result, calls };
}

async function main() {
console.log('\n=== 更新案の計画 ===');
{
  const reasons = [
    { kind: 'fiscal_year', detail: '年分の古さ', where: '## 手続き' },
    { kind: 'tax_reform', detail: '制度改正', where: '## 控除' },
    { kind: 'tax_reform', detail: '同じ節', where: '## 手続き' },
    { kind: 'search_decline', detail: '検索低下', where: '検索結果' },
    { kind: 'source_updated', detail: '出典の本文が改訂', where: '出典欄' },
  ];
  const planBody = '## 手続き\n説明\n\n## 控除\n説明';
  const plan = refresh.buildRefreshPlan({ body: planBody }, reasons, { taxYear: 2026 });
  assert(plan.length === 3 && plan[0].heading === '手続き' && plan[1].heading === '控除'
    && plan[2].scope === 'targeted', '理由順で節を選び、同じ見出しを重複させず出典を最後に回す');
  assert(plan[0].instruction.includes('2026 年分（令和 8 年分）')
    && plan[0].instruction.includes('年分の古さ'), '年度の指示文に詳細と現在年度を含める');
  assert(plan[2].instruction.startsWith('出典の本文が改訂。添付の出典本文が最新版です。'),
    '出典更新の指示文に detail をそのまま含める');
  const nested = refresh.buildRefreshPlan({ body: '## 控除\n概要\n### 少額特例\n年分の説明' }, [
    { kind: 'fiscal_year', detail: '年分の古さ', where: '### 少額特例' },
  ], { taxYear: 2026 });
  assert(nested[0].scope === 'section' && nested[0].heading === '控除'
    && nested[0].instruction.startsWith('「控除」の節には年分の記述があります'),
  '### 以下の理由は親の ## 節を対象にし、案内文に対象見出しを含める');
  const bodyTarget = refresh.buildRefreshPlan({ body: '導入文です。' }, [
    { kind: 'tax_reform', detail: '改正点', where: '本文' },
  ]);
  assert(bodyTarget[0].scope === 'targeted' && bodyTarget[0].instruction.startsWith('本文の制度に関係する税制改正があります'),
    '本文・導入部の理由は targeted として本文の案内文にする');
  const missingHeading = refresh.buildRefreshPlan({ body: '本文です。' }, [
    { kind: 'fiscal_year', detail: '年分', where: '### 見つからない見出し' },
  ], { taxYear: 2026 });
  assert(missingHeading[0].scope === 'targeted'
    && missingHeading[0].instruction.startsWith('「見つからない見出し」の節には'),
  '見出しが見つからない場合も理由の見出しを含めて targeted にする');
  const capped = refresh.buildRefreshPlan({ body: '' }, [
    { kind: 'fiscal_year', detail: '1', where: '## 一' },
    { kind: 'tax_reform', detail: '2', where: '## 二' },
    { kind: 'fiscal_year', detail: '3', where: '## 三' },
    { kind: 'tax_reform', detail: '4', where: '## 四' },
  ], { taxYear: 2026 });
  assert(capped.length === 3, '節の計画は最大3件');
  assert(refresh.buildRefreshPlan({}, [{ kind: 'seo_growable', detail: 'seo', where: '題名' }]).length === 0,
    '検索理由だけでは計画を作らない');
}

console.log('\n=== 期限切れテーマの注意 ===');
{
  assert(refresh.isExpiredRefreshTheme({ historical_only: 'true' }, new Date('2026-10-01')),
    'historical_only の更新案は注意対象');
  assert(refresh.isExpiredRefreshTheme({ valid_to: '2026-09-30' }, new Date('2026-10-01')),
    'valid_to を過ぎた更新案は注意対象');
  assert(!refresh.isExpiredRefreshTheme({ valid_to: '2026-12-31' }, new Date('2026-10-01')),
    '期限前の更新案には注意を出さない');
  const prBody = workflow.buildPullRequestBody({
    reasons: [{ detail: '期限確認', where: '本文' }],
    diff: [{
      heading: '控除',
      changedParagraphs: {
        before: [{ text: '変更前段落', changed: true }, { text: '共通段落', changed: false }],
        after: [{ text: '変更後段落', changed: true }, { text: '共通段落', changed: false }],
      },
    }],
    reviewUrl: 'https://example.invalid/review',
    expiredTheme: true,
  });
  assert(prBody.includes('期限切れのテーマです。更新ではなく公開停止も検討してください'),
    '期限切れ注意を PR 本文へ表示');
  assert(prBody.startsWith('> **このPRはマージしないでください。**'),
    'PR 本文の先頭に「マージしない」の注意を出す');
  {
    const refreshYaml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'refresh-article.yml'), 'utf8');
    assert(refreshYaml.includes('--title "【更新】$TITLE（マージしない）"'), 'PR の題名に「マージしない」を付ける');
  }
  assert(prBody.includes('変更前段落') && prBody.includes('変更後段落') && !prBody.includes('共通段落'),
    'PR 本文は変更された段落だけを表示');
  assert(workflow.formatDiff([{
    heading: '長い節',
    changedParagraphs: {
      before: [{ text: 'あ'.repeat(1000), changed: true }],
      after: [{ text: 'い'.repeat(1000), changed: true }],
    },
  }]).length <= 600, 'PR 本文の各節は600字以内');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-pr-body-'));
  try {
    const reasonsFile = path.join(directory, 'reasons.json');
    const diffFile = path.join(directory, 'diff.json');
    const bodyFile = path.join(directory, 'body.md');
    fs.writeFileSync(reasonsFile, JSON.stringify([{ detail: '期限確認', where: '本文' }]), 'utf8');
    fs.writeFileSync(diffFile, JSON.stringify([]), 'utf8');
    workflow.writePullRequestBody({ reasonsFile, diffFile, reviewUrl: 'https://example.invalid/review', expiredTheme: true, bodyFile });
    assert(fs.readFileSync(bodyFile, 'utf8').includes('期限切れのテーマです。更新ではなく公開停止も検討してください'),
      'PR本文作成関数が期限切れ情報を buildPullRequestBody に渡す');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

console.log('\n=== 本文だけの合成とメタデータ ===');
{
  const source = article();
  const reasons = [{ kind: 'fiscal_year', detail: '令和7年分', where: '## 年分' }];
  const updatedBody = '導入です。\n\n## 年分\n令和8年分の手続きを説明します。';
  const { result, calls } = await runFake(source, reasons,
    (input) => changedOutput(input, updatedBody, true));
  assert(result.status === 'changed' && calls.length === 1, '更新案は既存の節再生成を1回呼ぶ');
  const fm = refresh.splitDocument(result.content).frontmatter;
  assert(/title: "元の記事題名"/.test(fm) && /summary: "元の要約"/.test(fm), 'LLMが題名・要約を変えても元の値を残す');
  assert(/updated_at: "2025-03-01/.test(fm) && /publish_at: "2025-02-01/.test(fm)
    && /published_at: "2025-02-01/.test(fm) && /publish_slot: "evening"/.test(fm)
    && /approved_at: "2025-01-31/.test(fm), '元の公開・更新日と公開枠を保持');
  assert(/source_url: "https:\/\/www\.nta\.go\.jp\/example"/.test(fm)
    && /source_title: "元の出典"/.test(fm) && /source_confidence: 4/.test(fm)
    && /source_guard_version: 1/.test(fm), '出典項目と出典ガードの値を元のまま保持');
  assert(/review_status: "draft"/.test(fm) && /review_comment: ""/.test(fm)
    && /refresh_of: "published"/.test(fm) && /refresh_requested_at: "2026-10-01T11:00:00\+09:00"/.test(fm)
    && /refresh_note: "令和7年分（## 年分）"/.test(fm)
    && fm.includes(`refresh_base_hash: "${refresh.refreshBaseHash(refresh.splitDocument(source).body)}"`),
  '更新案用の値と元本文の基準hashを設定');
  assert(result.content.endsWith(updatedBody) && !result.content.includes('LLMが変えた'), '本文だけを次の成果に採用');

  const legacy = article({ version: false });
  const legacyResult = await runFake(legacy, reasons, input => changedOutput(input, updatedBody));
  assert(!/source_guard_version:/.test(refresh.splitDocument(legacyResult.result.content).frontmatter),
    'source_guard_version が無い記事には追加しない');
}

console.log('\n=== GitHub Actions 出力の複数行値 ===');
{
  const delimiterA = `CODEX_${'01'.repeat(18)}`;
  const value = `割合 100%\n2行目\n${delimiterA} は値の一部`;
  let call = 0;
  const output = githubOutput.formatGithubOutputs({ refresh_reason: value }, () => {
    call++;
    return Buffer.alloc(18, call === 1 ? 1 : 2);
  });
  const lines = output.split('\n');
  const delimiter = lines[0].slice('refresh_reason<<'.length);
  const end = lines.indexOf(delimiter, 1);
  const parsedValue = lines.slice(1, end).join('\n');
  assert(call === 2 && delimiter !== delimiterA && parsedValue === value,
    '出力区切りは値に含まれないランダム文字列で、%と複数行をそのまま保持');
  assert(!output.includes('%25') && !output.includes('%0A'), 'GitHub出力で%や改行を置換しない');
  const workflowSource = fs.readFileSync(path.join(ROOT, 'scripts/lib/freshness-workflow.js'), 'utf8');
  const generatorSource = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  assert(!workflowSource.includes("replace(/%/g, '%25')")
    && !generatorSource.includes("replace(/%/g, '%25')"), '更新案の出力処理に旧エスケープを残さない');
}

console.log('\n=== PRを作らない判定 ===');
{
  const source = article();
  const reason = [{ kind: 'fiscal_year', detail: '年分', where: '## 年分' }];
  const original = refresh.splitDocument(source).body;
  const same = await runFake(source, reason, input => changedOutput(input, `${original} `));
  assert(same.result.status === 'no_change', 'NFKCと空白除去後に同じなら no_change');

  const warning = await runFake(source, reason, input => changedOutput(input, original,
    false, '【自動再生成の警告】手動確認'));
  assert(warning.result.status === 'failed', '警告つきで元本文が返っても no_change にしない');

  const noCommentNeedsRevision = await runFake(source, reason, input => {
    const parts = refresh.splitDocument(input);
    const frontmatter = parts.frontmatter
      .replace(/^review_comment:.*\r?\n/m, '')
      .replace('review_status: "published"', 'review_status: "needs_revision"');
    return frontmatter + original.replace('令和7年分', '令和8年分');
  });
  assert(noCommentNeedsRevision.result.status === 'failed',
    'review_comment がなくても review_status: needs_revision は failed');

  const reordered = '導入です。\n\n## 新しい見出し\n令和8年分の手続きを説明します。';
  const h2 = await runFake(source, reason, input => changedOutput(input, reordered));
  assert(h2.result.status === 'failed' && /h2/.test(h2.result.reason), 'h2見出しの変更は failed');

  const short = await runFake(source, reason, input => changedOutput(input, '## 年分\nx'));
  assert(short.result.status === 'failed' && /85%/.test(short.result.reason), '本文が85%未満なら failed');

  const longBody = `導入です。\n\n## 年分\n${'令和8年分の説明です。'.repeat(20)}`;
  const long = await runFake(source, reason, input => changedOutput(input, longBody));
  assert(long.result.status === 'failed' && /130%/.test(long.result.reason), '本文が130%を超えたら failed');

  const internal = await runFake(source, reason,
    input => changedOutput(input, refresh.splitDocument(input).body.replace('令和7年分', '令和8年分').replace('説明します。', '添付資料を確認します。')));
  assert(internal.result.status === 'failed' && /作業語/.test(internal.result.reason), '作業語が増えたら failed');

  const alreadyPresent = article({ body: '導入です。添付資料を確認します。\n\n## 年分\n令和7年分の手続きを説明します。' });
  const unchangedWord = await runFake(alreadyPresent, reason,
    input => changedOutput(input, refresh.splitDocument(input).body.replace('令和7年分', '令和8年分')));
  assert(unchangedWord.result.status === 'changed', '元本文と同じ回数の作業語は増加していないため許可');
}

console.log('\n=== 節差分 ===');
{
  const before = '導入の前。\n\n## 変更節\n共通の段落です。\n\n古い段落です。\n\n## 同じ節\n変更なし。';
  const after = '導入の後。\n\n## 変更節\n共通の段落です。\n\n新しい段落です。\n\n## 同じ節\n変更なし。';
  const diff = refresh.diffSections(before, after);
  assert(diff.length === 2 && diff[0].heading === '（導入）' && diff[1].heading === '変更節',
    '変わった節だけを返し、導入部を（導入）とする');
  assert(diff[1].changedParagraphs.before.some(row => row.text === '古い段落です。' && row.changed)
    && diff[1].changedParagraphs.after.some(row => row.text === '新しい段落です。' && row.changed)
    && diff[1].changedParagraphs.after.some(row => row.text === '共通の段落です。' && !row.changed),
    '差分段落に印を付け、共通段落は印を付けない');
  assert(refresh.diffSections('## 同じ\n本文', '## 同じ\n本文').length === 0, '変更の無い本文は空配列');
  const whitespaceOnly = refresh.diffSections('## 見出し  \r\n段落です。\r\n', '## 見出し\n\n段落です。\n');
  assert(whitespaceOnly.length === 0, '段落が同じなら空白・改行・見出し末尾空白だけを差分にしない');

  const original = '導入です。\r\n\r\n## 年分  \r\n令和7年分の手続きを説明します。\r\n\r\n## 変更なし  \r\n補足の段落です。\r\n';
  const generated = '導入です。\n\n## 年分\n令和8年分の手続きを説明します。\n\n## 変更なし\n\n補足の段落です。\n';
  const spliced = refresh.spliceChangedSections(original, generated);
  assert(spliced.ok && spliced.body.includes('## 変更なし  \r\n補足の段落です。\r\n'),
    '書き換わっていない節の heading・CRLF・空白を元のまま保持');

  const tableAndListCRLF = '## 控除\r\n概要です。\r\n\r\n| 区分 | 金額 |\r\n|---|---:|\r\n| A | 1,000円 |\r\n\r\n- 対象です\r\n- 申告します\r\n';
  const tableAndListLF = tableAndListCRLF.replace(/\r\n/g, '\n');
  assert(refresh.diffSections(tableAndListCRLF, tableAndListLF).length === 0
    && refresh.spliceChangedSections(tableAndListCRLF, tableAndListLF).body === tableAndListCRLF,
  '表と箇条書きを含むCRLFの未変更節を差分にせず元の改行で保つ');
}

console.log('\n=== 差し戻し再生成の更新案制約 ===');
{
  const existing = refresh.setRefreshFrontmatter(refresh.splitDocument(article({ version: false })).frontmatter, {
    review_status: 'needs_revision', review_comment: '年分を更新してください',
    refresh_of: 'published', refresh_requested_at: '2026-10-01T10:00:00+09:00',
    refresh_note: '年分（## 年分）',
  }) + article().match(/---\r?\n([\s\S]+?\r?\n---\r?\n)([\s\S]*)$/)[2];
  const originalMeta = refresh.splitDocument(existing).frontmatter;
  let targetedCalls = 0;
  const full = await refresh.regenerateRefreshDraft({
    existing,
    comment: '本文全体を整えてください',
    classification: { scope: 'full', type: 'content', reason: '全文' },
    regenerateSection: async () => { throw new Error('section は呼ばない'); },
    regenerateTargeted: async () => {
      targetedCalls++;
      const sourceParts = refresh.splitDocument(existing);
      const changedFm = sourceParts.frontmatter.replace('title: "元の記事題名"', 'title: "変更された題名"')
        .replace('summary: "元の要約"', 'summary: "変更された要約"')
        .replace('source_url: "https://www.nta.go.jp/example"', 'source_url: "https://example.invalid/changed"')
        .replace('review_status: "needs_revision"', 'review_status: "draft"')
        .replace('review_comment: "年分を更新してください"', 'review_comment: ""');
      return changedFm + '導入です。\n\n## 年分\n令和8年分に修正します。';
    },
  });
  const fullParts = refresh.splitDocument(full.content);
  const stableFm = value => value.split(/\r?\n/).filter(line => !/^review_(status|comment):/.test(line)).join('\n');
  assert(targetedCalls === 1 && full.scope === 'targeted', '更新案の full 分類は targeted の偽物生成器へ送る');
  assert(stableFm(fullParts.frontmatter) === stableFm(originalMeta)
    && /review_status: "draft"/.test(fullParts.frontmatter) && /review_comment: ""/.test(fullParts.frontmatter),
  '更新案の再生成は元の frontmatter を使い、review_status・review_comment のみ再生成結果を反映');

  let titleCalls = 0;
  const titleOnly = await refresh.regenerateRefreshDraft({
    existing,
    comment: '題名を変更してください',
    classification: { scope: 'frontmatter', type: 'title_only', reason: '題名' },
    regenerateSection: async () => { titleCalls++; },
    regenerateTargeted: async () => { titleCalls++; },
  });
  const titleParts = refresh.splitDocument(titleOnly.content);
  assert(titleCalls === 0 && titleParts.body === refresh.splitDocument(existing).body,
    '更新案の題名・要約分類では生成器を呼ばず本文を保つ');
  assert(/review_status: "needs_revision"/.test(titleParts.frontmatter)
    && /自動再生成の警告: 更新案では題名・要約は変えられません。題名の変更は別の作業で行います。/.test(titleParts.frontmatter),
  '題名・要約の警告を記録して needs_revision にする');

  let addSectionTargetedCalls = 0;
  let addSectionSectionCalls = 0;
  const addSection = await refresh.regenerateRefreshDraft({
    existing,
    comment: '申告時の確認手順を追加してください',
    classification: { scope: 'section', type: 'add_section', reason: '章追加' },
    regenerateSection: async () => { addSectionSectionCalls++; return existing; },
    regenerateTargeted: async source => {
      addSectionTargetedCalls++;
      const parts = refresh.splitDocument(source);
      return parts.frontmatter + parts.body.replace('令和7年分の手続きを説明します。', '令和7年分の手続きを確認します。');
    },
  });
  assert(addSectionTargetedCalls === 1 && addSectionSectionCalls === 0 && addSection.scope === 'targeted',
    'add_section 分類は targeted の偽物生成器を使う');

  const changedChapters = await refresh.regenerateRefreshDraft({
    existing,
    comment: '章を追加してください',
    classification: { scope: 'targeted', type: 'add_section', reason: '章追加' },
    regenerateSection: async () => existing,
    regenerateTargeted: async source => {
      const parts = refresh.splitDocument(source);
      return parts.frontmatter + `${parts.body}\n## 追加した章\n新しい内容です。\n`;
    },
  });
  const changedChapterParts = refresh.splitDocument(changedChapters.content);
  assert(/review_status: "needs_revision"/.test(changedChapterParts.frontmatter)
    && changedChapterParts.frontmatter.includes('review_comment: "自動再生成の警告: 更新案では章の追加・見出しの変更はできません。本文の中で補う形の指示にして差し戻してください。"')
    && changedChapterParts.body === refresh.splitDocument(existing).body,
  '章数や見出しが変わる出力は例外にせず元本文と所定の警告を返す');

  const failedGeneration = await refresh.regenerateRefreshDraft({
    existing,
    comment: '見出しを修正してください',
    classification: { scope: 'targeted', type: 'content', reason: '本文' },
    regenerateSection: async () => existing,
    regenerateTargeted: async () => { throw new Error('対象見出しが見つかりません'); },
  });
  assert(/review_status: "needs_revision"/.test(refresh.splitDocument(failedGeneration.content).frontmatter)
    && refresh.splitDocument(failedGeneration.content).body === refresh.splitDocument(existing).body,
  '更新案の差し戻しで生成例外が起きてもジョブを落とさず警告を記録');
  assert(refresh.splitDocument(failedGeneration.content).frontmatter.includes('review_comment: "自動再生成の警告: 再生成処理に失敗しました。時間をおいて差し戻し直してください。"')
    && !refresh.splitDocument(failedGeneration.content).frontmatter.includes('章の追加・見出しの変更はできません'),
  '生成の例外は「章の追加はできません」ではなく再生成の失敗として案内する');

  const regenerateWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/regenerate-draft.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(regenerateWorkflow.includes("grep -qE '自動再生成の警告|自動反映は一部のみ' \"$FILE\"; then")
    && /review_comment: `自動再生成の警告: /.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/freshness-refresh.js'), 'utf8')),
    '更新案の題名警告は既存の目印を使い、通常の差し戻しの未反映判定は変えない');
}

console.log('\n=== 更新ワークフローの入力検査 ===');
{
  const yaml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'refresh-article.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(/workflow_dispatch:/.test(yaml) && /inputs:\n\s+slug:/.test(yaml), 'workflow_dispatch の入力は slug のみ');
  assert(/run-name:\s*記事の更新案\s+\$\{\{\s*inputs\.slug\s*\}\}/.test(yaml), '実行タイトルに入力slugを含める');
  assert(/group:\s*refresh-\$\{\{\s*inputs\.slug\s*\}\}/.test(yaml), '同じslugの同時実行を抑止');
  assert(/SLUG:\s*\$\{\{\s*inputs\.slug\s*\}\}/.test(yaml), '入力slugをenv経由で渡す');
  assert(/EXPIRED_THEME:\s*\$\{\{\s*steps\.candidate\.outputs\.expired_theme\s*\}\}/.test(yaml),
    '候補の期限切れ情報をPR本文作成へ渡す');
  const steps = yaml.split(/(?=^      - )/m).filter(section => /^      - /m.test(section));
  const runSections = steps.filter(section => /^        run:/m.test(section));
  assert(runSections.length > 0 && runSections.every(section => {
    const runAt = section.search(/^        run:/m);
    return !/\$\{\{\s*inputs\.slug\s*\}\}/.test(section.slice(runAt));
  }),
    'run本文へ inputs.slug を直接展開しない');
}

console.log('\n=== 更新案の差し戻し再生成 ===');
{
  assert(refresh.isRefreshArticle({ refresh_of: 'published' })
    && !refresh.shouldCheckRegenerateDenylist({ refresh_of: 'published' }),
  'refresh_of: published の差し戻しはテーマ禁止判定を通さない');
  assert(refresh.shouldCheckRegenerateDenylist({ refresh_of: undefined }),
    '通常下書きのテーマ禁止判定は今までどおり有効');

  const beforeBase = refresh.splitDocument(article({ version: false }));
  const before = refresh.setRefreshFrontmatter(beforeBase.frontmatter, {
    review_status: 'needs_revision',
    refresh_of: 'published',
    refresh_requested_at: '2026-10-01T10:00:00+09:00',
    refresh_note: '制度改正（## 控除）',
    refresh_base_hash: refresh.refreshBaseHash(beforeBase.body),
  }) + beforeBase.body;
  const after = article({ version: false, body: '差し戻し後の本文です。' })
    .replace('review_status: "published"', 'review_status: "draft"')
    .replace('refresh_of: "published"', 'refresh_of: "changed-by-llm"')
    .replace(/\r\n/g, '\n');
  const withRestoredGuard = sourceGuard.restoreSourceGuardFields(before.replace(/\r\n/g, '\n'), after);
  assert(/source_guard_version: 1/.test(withRestoredGuard), '既存の復元処理が再生成結果へ version を追加することを確認');
  const noNewVersion = refresh.removeFrontmatterFields(withRestoredGuard, ['source_guard_version']);
  const withMarkers = refresh.restoreRefreshMarkers(before.replace(/\r\n/g, '\n'), noNewVersion);
  const fm = refresh.splitDocument(withMarkers).frontmatter;
  assert(!/source_guard_version:/.test(fm), '元に version が無い更新案は復元後も version 無し');
  assert(/refresh_of: "published"/.test(fm)
    && /refresh_requested_at: "2026-10-01T10:00:00\+09:00"/.test(fm)
    && /refresh_note: "制度改正（## 控除）"/.test(fm)
    && fm.includes(`refresh_base_hash: "${refresh.refreshBaseHash(beforeBase.body)}"`),
  '更新案の印と基準hashは差し戻し再生成後も元の値を保つ');
  assert(fm.includes('title: "元の記事題名"') && fm.includes('source_url: "https://www.nta.go.jp/example"'),
    '差し戻し処理の検証で元の題名と出典項目を維持');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
