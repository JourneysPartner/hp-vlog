'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.join(__dirname, '..', '..', '..');
const { TOPICS } = require('../../topic-pool');
const {
  checkGeneratedArticle,
  generateFromTemplate,
  parseFrontmatter,
} = require('../../generate-draft');
const { buildGenerationPrompt } = require('../article-prompt-builder');
const { normalizeGeneratedDraft } = require('../draft-normalizer');
const { buildReplacementOutlineBlock } = require('../replaces');
const { validateFile } = require('../../validate');
const { applyReplaces, main: applyReplacesMain } = require('../../apply-replaces');

const results = Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map(key => [key, { passed: 0, failed: 0 }]));

function check(group, condition, label) {
  if (condition) {
    results[group].passed++;
    console.log(`  ✓ [${group}] ${label}`);
  } else {
    results[group].failed++;
    console.log(`  ✗ [${group}] ${label}`);
  }
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function post({ slug, title, status = 'published', replaces = '', headings = ['見出し'], body = '本文' }) {
  const replacesLine = replaces ? `\nreplaces: "${replaces}"` : '';
  return `---
title: "${title}"
slug: "${slug}"
category: "消費税"
primary_persona: "ebay_export_seller"
summary: "${title}のテスト用要約です。"
review_status: "${status}"${replacesLine}
---

${headings.map(heading => `## ${heading}\n\n${body}`).join('\n\n')}
`;
}

function fixtureSnapshot(paths) {
  return Object.fromEntries(paths.map(filePath => [filePath, fs.readFileSync(filePath, 'utf8')]));
}

function sameSnapshot(before, after) {
  return Object.keys(before).every(filePath => before[filePath] === after[filePath]);
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-vlog-replaces-'));
  const postsDir = path.join(tmpRoot, 'content', 'posts');
  const netlifyPath = path.join(tmpRoot, 'netlify.toml');
  const pickupPath = path.join(tmpRoot, 'data', 'pickup-posts.json');
  const hubConfigPath = path.join(tmpRoot, 'data', 'hub-config.json');
  const newSlug = 'new-complete-guide';
  const oldSlugs = ['old-basic', 'old-guide', 'old-documents'];

  try {
    console.log('=== R1: topic.replaces ===');
    const target = TOPICS.find(topic => topic.slug === 'ebay-export-consumption-tax-refund-complete-guide');
    check('R1', JSON.stringify(target && target.replaces) === JSON.stringify([
      'ebay-shouhizei-kanpu-kihon',
      'ebay-export-consumption-tax-refund-guide',
      'ebay-tax-refund-required-documents',
    ]), '完全ガイドが既存3記事を名指しする');
    check('R1', TOPICS.filter(topic => Object.prototype.hasOwnProperty.call(topic, 'replaces')).length === 1,
      '他のトピックに replaces を追加していない');

    console.log('\n=== R2: 生成後の重複判定 ===');
    const generated = `---\ntitle: "生成記事のタイトル"\nslug: "${newSlug}"\nsummary: "要約"\n---\n\n## 見出しA\n\n本文`;
    const topic = {
      slug: newSlug,
      persona: 'ebay_export_seller',
      category: '消費税',
      article_type: 'basic_explainer',
      replaces: oldSlugs,
    };
    const corpus = [
      { slug: newSlug }, { slug: oldSlugs[0] }, { slug: oldSlugs[1] },
      { slug: 'same-run' }, { slug: 'unrelated-post' },
    ];
    let receivedCorpus = [];
    const allowed = await checkGeneratedArticle(generated, topic, ['same-run'], {
      corpus,
      checkImpl: async (_article, checkedCorpus) => {
        receivedCorpus = checkedCorpus;
        return { duplicate: true, similar_to: oldSlugs[0], reason: '同一論点' };
      },
    });
    check('R2', receivedCorpus.map(item => item.slug).join(',') === 'unrelated-post',
      '置き換え対象・自身・同一実行の slug をコーパスから除外する');
    check('R2', allowed.duplicate === false && allowed.replacement_allowed === true,
      'similar_to が replaces 内なら重複を許容する');
    const blocked = await checkGeneratedArticle(generated, topic, [], {
      corpus,
      checkImpl: async () => ({ duplicate: true, similar_to: 'unrelated-post', reason: '別記事と重複' }),
    });
    check('R2', blocked.duplicate === true && blocked.similar_to === 'unrelated-post',
      'replaces 外の重複は従来どおり残す');

    console.log('\n=== R3: 置き換え記事の見出し ===');
    for (let i = 0; i < oldSlugs.length; i++) {
      write(path.join(postsDir, `2026-01-0${i + 1}-${oldSlugs[i]}.md`), post({
        slug: oldSlugs[i],
        title: `旧記事${i + 1}`,
        headings: [`論点${i + 1}A`, `論点${i + 1}B`],
        body: `プロンプトに入れない本文${i + 1}`,
      }));
    }
    const replacementTopic = { ...topic, replaces: [...oldSlugs, 'missing-post'] };
    const outlineBlock = buildReplacementOutlineBlock(replacementTopic, postsDir);
    check('R3', oldSlugs.every((_slug, i) => outlineBlock.includes(`旧記事${i + 1}`)
      && outlineBlock.includes(`H2: 論点${i + 1}A`)), '旧記事の title と H2 を読み込む');
    check('R3', !outlineBlock.includes('プロンプトに入れない本文')
      && outlineBlock.includes('ここで扱っている論点は漏れなく含める'),
    '本文は渡さず、網羅指示だけを渡す');
    const promptArgs = {
      topic: {
        slug: newSlug,
        title: '新記事',
        category: '消費税',
        persona: 'ebay_export_seller',
        macro: '物販',
        article_type: 'basic_explainer',
      },
      persona: { label: 'eBay輸出セラー' },
      cta: '相談してください',
      articleType: 'basic_explainer',
      articleRole: 'main',
      now: '2026-09-27T00:00:00.000Z',
    };
    const promptWithOutlines = buildGenerationPrompt({
      ...promptArgs,
      topic: { ...promptArgs.topic, replaces: oldSlugs },
      replacementOutlineBlock: outlineBlock,
    });
    check('R3', promptWithOutlines.dynamicSystem.includes('旧記事1')
      && promptWithOutlines.dynamicSystem.includes('H2: 論点1A'),
    'API生成の可変プロンプトに見出し一覧を入れる');
    const promptWithoutProperty = buildGenerationPrompt(promptArgs);
    const promptWithEmptyReplaces = buildGenerationPrompt({
      ...promptArgs,
      topic: { ...promptArgs.topic, replaces: [] },
      replacementOutlineBlock: buildReplacementOutlineBlock({ replaces: [] }, postsDir),
    });
    check('R3', JSON.stringify(promptWithoutProperty) === JSON.stringify(promptWithEmptyReplaces),
      'replaces が無い場合はプロンプトが1文字も変わらない');

    console.log('\n=== R4: frontmatter ===');
    const completeGuide = TOPICS.find(item => item.slug === 'ebay-export-consumption-tax-refund-complete-guide');
    const templateOutput = generateFromTemplate('2026-09-27', completeGuide, null);
    const templateMeta = parseFrontmatter(templateOutput).meta;
    check('R4', templateMeta.replaces === completeGuide.replaces.join(','),
      'テンプレート生成物にカンマ区切りの replaces を残す');
    const rawApiOutput = `---\ntitle: "eBay輸出の還付判定を確認するテスト記事"\nsummary: "還付判定のテスト用に具体的な要点を整理します。"\n---\n\n## 結論\n\n本文です。`;
    const normalized = normalizeGeneratedDraft(rawApiOutput, completeGuide, {
      now: '2026-09-27T00:00:00.000Z',
    });
    check('R4', parseFrontmatter(normalized.content).meta.replaces === completeGuide.replaces.join(','),
      'API生成の正規化後も replaces を残す');
    const noReplaceTopic = { ...promptArgs.topic, hint: 'テスト' };
    const templateWithoutProperty = generateFromTemplate('2026-09-27', noReplaceTopic, null);
    const templateWithEmptyReplaces = generateFromTemplate('2026-09-27', { ...noReplaceTopic, replaces: [] }, null);
    check('R4', templateWithoutProperty === templateWithEmptyReplaces
      && !/^replaces:/m.test(templateWithoutProperty),
    'replaces が無いテンプレート生成物は差分ゼロ');
    const normalizedWithoutProperty = normalizeGeneratedDraft(rawApiOutput, noReplaceTopic, {
      now: '2026-09-27T00:00:00.000Z',
    });
    const normalizedWithEmptyReplaces = normalizeGeneratedDraft(rawApiOutput, { ...noReplaceTopic, replaces: [] }, {
      now: '2026-09-27T00:00:00.000Z',
    });
    check('R4', normalizedWithoutProperty.content === normalizedWithEmptyReplaces.content
      && !/^replaces:/m.test(normalizedWithoutProperty.content),
    'replaces が無いAPI生成物も差分ゼロ');
    const validatePath = path.join(tmpRoot, 'validate-replaces.md');
    write(validatePath, templateOutput);
    const validation = validateFile(validatePath);
    check('R4', validation.errors.length === 0, 'validate.js は replaces 付き記事を許可する');

    console.log('\n=== R5: apply-replaces.js ===');
    write(path.join(postsDir, `2026-09-27-${newSlug}.md`), post({
      slug: newSlug,
      title: '新しい完全版',
      status: 'published',
      replaces: oldSlugs.join(','),
      headings: ['新記事'],
      body: '新本文',
    }));
    write(netlifyPath, `# Redirects\n\n# 統合した双子記事は、評価を残す本命記事へ恒久転送する。\n[[redirects]]\n  from = "/blog/twin-old/"\n  to = "/blog/twin-new/"\n  status = 301\n\n# 管理画面の入口\n[[redirects]]\n  from = "/admin"\n  to = "/.netlify/functions/admin-home"\n  status = 200\n`);
    write(pickupPath, `${JSON.stringify({
      _note: 'テスト',
      netshop_core: ['keep-first', oldSlugs[0], 'keep-middle', newSlug, oldSlugs[1], oldSlugs[2]],
      netshop_services: [],
    }, null, 2)}\n`);
    write(hubConfigPath, `${JSON.stringify({
      _note: 'テスト',
      retail: { featured: [oldSlugs[1], newSlug, 'keep-retail'] },
      wholesale: { featured: ['keep-wholesale', oldSlugs[2]] },
    }, null, 2)}\n`);

    const fixtureFiles = [
      ...oldSlugs.map((slug, i) => path.join(postsDir, `2026-01-0${i + 1}-${slug}.md`)),
      path.join(postsDir, `2026-09-27-${newSlug}.md`),
      netlifyPath, pickupPath, hubConfigPath,
    ];
    const cliArgs = [
      '--slug', newSlug, '--dry-run',
      '--posts-dir', postsDir,
      '--netlify', netlifyPath,
      '--pickup', pickupPath,
      '--hub-config', hubConfigPath,
    ];
    const beforeDryRun = fixtureSnapshot(fixtureFiles);
    const dryOutput = [];
    const dryExit = applyReplacesMain(cliArgs, {
      log: line => dryOutput.push(line),
      error: line => dryOutput.push(line),
    });
    const afterDryRun = fixtureSnapshot(fixtureFiles);
    check('R5', dryExit === 0 && sameSnapshot(beforeDryRun, afterDryRun),
      '--dry-run は成功し、1文字も書き込まない');
    check('R5', dryOutput.some(line => line.includes('変更したファイルと内容'))
      && dryOutput.some(line => line.includes('/blog/old-basic/')),
    '--dry-run で実行時と同じ変更内容を表示する');

    const applied = applyReplaces({
      slug: newSlug, postsDir, netlifyPath, pickupPath, hubConfigPath,
    });
    check('R5', applied.changedFiles.length === 6, '旧記事3本と設定3ファイルを更新する');
    for (let i = 0; i < oldSlugs.length; i++) {
      const filePath = path.join(postsDir, `2026-01-0${i + 1}-${oldSlugs[i]}.md`);
      const parsed = matter(fs.readFileSync(filePath, 'utf8'));
      check('R5', parsed.data.review_status === 'merged' && parsed.data.merged_into === newSlug,
        `${oldSlugs[i]} を merged にして統合先を残す`);
      check('R5', parsed.content === matter(beforeDryRun[filePath]).content,
        `${oldSlugs[i]} の本文は変更しない`);
    }
    const netlifyAfter = fs.readFileSync(netlifyPath, 'utf8');
    check('R5', oldSlugs.every(slug => (netlifyAfter.match(new RegExp(`from = "/blog/${slug}/"`, 'g')) || []).length === 1),
      '旧 slug ごとに301を1ブロックだけ追加する');
    check('R5', netlifyAfter.indexOf('/blog/twin-old/') < netlifyAfter.indexOf('/blog/old-basic/')
      && netlifyAfter.indexOf('/blog/old-documents/') < netlifyAfter.indexOf('# 管理画面の入口'),
    '01の統合ブロック直後に301を追加する');
    const pickupAfter = JSON.parse(fs.readFileSync(pickupPath, 'utf8'));
    check('R5', JSON.stringify(pickupAfter.netshop_core) === JSON.stringify([
      'keep-first', newSlug, 'keep-middle',
    ]), 'netshop_core は最初の位置を保って新 slug を1件にする');
    const hubsAfter = JSON.parse(fs.readFileSync(hubConfigPath, 'utf8'));
    check('R5', JSON.stringify(hubsAfter.retail.featured) === JSON.stringify([newSlug, 'keep-retail'])
      && JSON.stringify(hubsAfter.wholesale.featured) === JSON.stringify(['keep-wholesale', newSlug]),
    '各ハブの featured も順序を保って置き換える');

    const afterFirstApply = fixtureSnapshot(fixtureFiles);
    const second = applyReplaces({ slug: newSlug, postsDir, netlifyPath, pickupPath, hubConfigPath });
    const afterSecondApply = fixtureSnapshot(fixtureFiles);
    check('R5', second.changedFiles.length === 0 && sameSnapshot(afterFirstApply, afterSecondApply),
      '2回目の実行は完全に冪等');

    const newPostPath = path.join(postsDir, `2026-09-27-${newSlug}.md`);
    write(newPostPath, fs.readFileSync(newPostPath, 'utf8').replace('review_status: "published"', 'review_status: "draft"'));
    const beforeUnpublished = fixtureSnapshot(fixtureFiles);
    const unpublishedOutput = [];
    const unpublishedExit = applyReplacesMain(cliArgs.filter(arg => arg !== '--dry-run'), {
      log: line => unpublishedOutput.push(line),
      error: line => unpublishedOutput.push(line),
    });
    const afterUnpublished = fixtureSnapshot(fixtureFiles);
    check('R5', unpublishedExit === 1 && unpublishedOutput.some(line => line.includes('未公開のため中止'))
      && sameSnapshot(beforeUnpublished, afterUnpublished),
    '新記事が未公開なら exit 1 相当で無変更のまま中止する');

    console.log('\n=== R6: テスト登録 ===');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check('R6', packageJson.scripts['masters:test'].includes('test-replaces.js'),
      'test-replaces.js を npm run masters:test に登録する');
    check('R6', fs.existsSync(path.join(ROOT, 'scripts', 'lib', '__tests__', 'test-replaces.js')),
      '置き換え機能の専用テストが存在する');
  } finally {
    const resolvedTmp = path.resolve(tmpRoot);
    const resolvedOsTmp = path.resolve(os.tmpdir());
    if (resolvedTmp.startsWith(`${resolvedOsTmp}${path.sep}`)) {
      fs.rmSync(resolvedTmp, { recursive: true, force: true });
    }
  }

  console.log('\n=== 集計 ===');
  let failed = 0;
  for (const [group, count] of Object.entries(results)) {
    console.log(`${group}: PASS ${count.passed} / FAIL ${count.failed}`);
    failed += count.failed;
  }
  if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
