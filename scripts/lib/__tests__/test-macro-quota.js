'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const corpus = require('../site-corpus');
const { ALL_MACROS, resolveCluster } = require('../cluster-taxonomy');

const NOW = new Date('2026-10-27T12:00:00+09:00');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = days => new Date(NOW.getTime() - days * DAY).toISOString();
const quotaPath = path.resolve(__dirname, '../../../data/macro-quota.json');
const balancePath = require.resolve('../category-balance');
const selectorPath = require.resolve('../topic-selector');
const savedBalance = require.cache[balancePath];
const savedSelector = require.cache[selectorPath];
const savedReadWindow = corpus.readPostsWithinDays;
const savedReadAll = corpus.readAllPostsSorted;
let main = [];
let passed = 0;
let failed = 0;

function test(label, run) {
  main = [];
  try {
    run();
    passed++;
    console.log(`  PASS ${label}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${label}\n${error.stack}`);
  }
}

function post(slug, days = 1, extra = {}) {
  const result = {
    slug, file: `${slug}.md`, published_at: daysAgo(days),
    primary_persona: 'inheritance_client', review_status: 'published', ...extra,
  };
  return { ...result, ...resolveCluster(result) };
}

function pending(slug, days = 1, extra = {}) {
  return {
    slug, created_at: daysAgo(days), primary_persona: 'inheritance_client',
    review_status: 'draft', ...extra,
  };
}

// 記事ファイルや Git を書き換えず、実際の分類・日付解決を使う。
corpus.readPostsWithinDays = (days, now) => main.filter(p => (
  corpus.postReferenceDate(p).getTime() >= now.getTime() - days * DAY
));
corpus.readAllPostsSorted = () => main.slice();
delete require.cache[balancePath];
delete require.cache[selectorPath];

try {
  const {
    TARGET_RATIOS, validateTargetRatios, quotaLimitFor, computeMacroQuota,
    applyMacroQuota, computeMacroRatios, loadMacroQuota,
  } = require('../category-balance');
  const { selectDailyTopics } = require('../topic-selector');
  const { CURATED_TOPICS } = require('../../topic-pool');
  const quota = extraCorpus => computeMacroQuota(NOW, { extraCorpus })['相続贈与'];

  console.log('=== 1. 目標比率と上限計算 ===');
  test('目標比率の表が指定どおりで合計 1.00', () => {
    assert.deepEqual(TARGET_RATIOS, {
      物販: 0.50, 建設: 0.08, コンテンツ販売: 0.08, インフルエンサー: 0.07,
      小売: 0.05, 一般事業者: 0.05, YouTube: 0.03, サロン: 0.02, 卸売: 0.02, 相続贈与: 0.10,
    });
    assert.equal(validateTargetRatios().valid, true);
    assert.ok(Math.abs(validateTargetRatios().total - 1) < 1e-9);
  });
  for (const [macro, limit] of [['相続贈与', 2], ['卸売', 1], ['物販', 7]]) {
    test(`${macro} の上限は ${limit} 本`, () => assert.equal(quotaLimitFor(macro), limit));
  }
  test('目標 0 でも最小上限は 1 本', () => assert.equal(quotaLimitFor('税目実務'), 1));

  console.log('\n=== 2. 本数・日付・状態・slug の集計 ===');
  test('main 2 本で上限に達する', () => {
    main = [post('main-a'), post('main-b')];
    assert.equal(quota().count, 2);
    assert.equal(quota().blocked, true);
  });
  test('main 1 本と未分類の下書き 1 本で上限に達する', () => {
    main = [post('main-a')];
    assert.equal(quota([pending('draft-a')]).count, 2);
    assert.equal(quota([pending('draft-a')]).blocked, true);
  });
  test('main 1 本だけなら除外しない', () => {
    main = [post('main-a')];
    assert.equal(quota().blocked, false);
  });
  test('31 日前は main・下書きとも数えない', () => {
    main = [post('main-a'), post('old-main', 31)];
    assert.equal(quota([pending('old-draft', 31)]).count, 1);
  });
  test('30 日ちょうどは含め、それより 1 ms 前は数えない', () => {
    main = [post('boundary', 30), post('outside', 30, { published_at: new Date(NOW - 30 * DAY - 1).toISOString() })];
    assert.equal(quota().count, 1);
  });
  test('main と下書きの同じ slug は main を優先し 1 本', () => {
    main = [post('shared')];
    assert.equal(quota([pending('shared'), pending('shared')]).count, 1);
  });
  test('下書き内の同じ slug も 1 本', () => {
    assert.equal(quota([pending('shared'), pending('shared')]).count, 1);
  });
  for (const status of ['merged', 'skipped', 'rejected']) {
    test(`${status} は main・下書きとも上限に数えない`, () => {
      main = [post('inactive-main', 1, { review_status: status })];
      assert.equal(quota([pending('inactive-draft', 1, { review_status: status })]).count, 0);
    });
  }
  test('published_at を更新日より優先する', () => {
    main = [post('old-published', 31, { updated_at: daysAgo(1) })];
    assert.equal(quota().count, 0);
  });
  test('下書きは publish_at・updated_at・created_at・ファイル名の日付を使う', () => {
    const drafts = [
      pending('scheduled', 31, { publish_at: daysAgo(1) }),
      pending('updated', 31, { updated_at: daysAgo(1) }),
      pending('created'),
      pending('filename', 31, { created_at: '', file: '2026-10-26-filename.md' }),
    ];
    assert.equal(quota(drafts).count, 4);
  });
  test('分類は明示指定・slug・persona を記事と同じ方法で解決する', () => {
    const drafts = [
      pending('explicit', 1, { cluster: 'gift', macro: '相続贈与', primary_persona: '' }),
      pending('inheritance-quota-slug', 1, { primary_persona: '' }),
      pending('persona-only'),
      pending('ebay-quota-retail', 1, { primary_persona: '' }),
    ];
    assert.equal(quota(drafts).count, 3);
  });
  test('設定した window_days と strict_macros に従う', () => {
    main = [post('outside', 8), post('retail', 1, { primary_persona: 'ebay_export_seller' })];
    const result = computeMacroQuota(NOW, {
      config: { window_days: 7, planned_per_window: 13, strict_macros: ['相続贈与', '物販'] },
    });
    assert.equal(result['相続贈与'].count, 0);
    assert.equal(result['物販'].count, 1);
    assert.equal(result['物販'].limit, 7);
  });

  console.log('\n=== 3. 選定・説明・救済 ===');
  const inheritance = {
    ...CURATED_TOPICS.find(t => t.persona === 'inheritance_client' && t.article_type === 'basic_explainer'),
    slug: 'quota-inheritance-candidate', subcluster: 'quota-inheritance-candidate',
  };
  const retail = {
    ...CURATED_TOPICS.find(t => t.persona === 'ebay_export_seller' && t.article_type === 'basic_explainer'),
    slug: 'quota-retail-candidate', subcluster: 'quota-retail-candidate',
  };
  const select = (topics, options = {}) => selectDailyTopics(topics.map(t => ({ ...t })), {
    now: NOW, count: 1, withdrawn: [], ...options,
  });
  test('上限未達なら相続候補が選定される', () => {
    main = [post('main-a')];
    const result = select([inheritance]);
    assert.deepEqual(result.picks.map(p => p.slug), [inheritance.slug]);
    assert.equal(result.explanation.steps.find(s => s.step === 'macro-quota').blocked, 0);
  });
  test('main が上限なら物販だけが残り macro-quota に理由が出る', () => {
    main = [post('main-a'), post('main-b')];
    const result = select([inheritance, retail], { count: 2 });
    assert.deepEqual(result.picks.map(p => p.slug), [retail.slug]);
    const step = result.explanation.steps.find(s => s.step === 'macro-quota');
    assert.equal(step.blocked, 1);
    assert.equal(step.remaining, 1);
    assert.equal(step.blockedDetails[0].macro, '相続贈与');
    assert.match(step.blockedDetails[0].reason, /直近30日で 2 本（上限 2 本・目標 10%）/);
    assert.ok(result.explanation.topCandidates.every(t => t.macro !== '相続贈与'));
  });
  test('selector が読み込んだ下書きも上限・比率に渡す', () => {
    main = [post('main-a')];
    const result = select([inheritance, retail], { extraCorpus: [pending('draft-a')] });
    assert.deepEqual(result.picks.map(p => p.slug), [retail.slug]);
    assert.equal(result.explanation.steps.find(s => s.step === 'macro-quota').blocked, 1);
    assert.equal(result.explanation.steps.find(s => s.step === 'apply-balance').macroRatios7['相続贈与'], 1);
  });
  for (const count of [1, 2]) {
    test(`相続候補だけなら ${count} 本モードでも空になり救済で戻らない`, () => {
      main = [post('main-a'), post('main-b')];
      const result = select([inheritance], { count });
      assert.deepEqual(result.picks, []);
      assert.equal(result.explanation.steps.find(s => s.step === 'macro-quota').remaining, 0);
      assert.ok(!(result.explanation.warnings || []).some(w => w.includes('カテゴリ偏りハードブロックで全滅')));
    });
  }
  test('既存 hardCap の全滅救済は物販だけを戻す', () => {
    main = [post('inheritance-a'), post('inheritance-b'), ...Array.from({ length: 14 }, (_, i) => (
      post(`retail-${i}`, 1, { primary_persona: 'ebay_export_seller' })
    ))];
    const result = select([inheritance, retail], { count: 2 });
    assert.deepEqual(result.picks.map(p => p.slug), [retail.slug]);
    assert.equal(result.explanation.steps.find(s => s.step === 'apply-balance').blocked, 1);
    assert.ok(result.explanation.warnings.some(w => w.includes('カテゴリ偏りハードブロックで全滅')));
  });

  console.log('\n=== 4. 設定欠落・読み取り失敗・未知の分類 ===');
  function withConfigFile(value, run) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (path.resolve(String(file)) !== quotaPath) return read.call(this, file, ...args);
      if (value instanceof Error) throw value;
      return JSON.stringify(value);
    };
    try { run(); } finally { fs.readFileSync = read; }
  }
  for (const code of ['ENOENT', 'EACCES']) {
    test(`${code}: 起動時に警告 1 行、上限なしで選定を続ける`, () => {
      withConfigFile(Object.assign(new Error(code), { code }), () => {
        const warnings = [];
        const warn = console.warn;
        console.warn = line => warnings.push(line);
        delete require.cache[balancePath];
        delete require.cache[selectorPath];
        try {
          const balance = require('../category-balance');
          const selector = require('../topic-selector');
          assert.equal(warnings.length, 1);
          assert.ok(!warnings[0].includes('\n'));
          main = [post('main-a'), post('main-b')];
          assert.deepEqual(balance.computeMacroQuota(NOW), {});
          assert.equal(balance.applyMacroQuota([inheritance]).passed.length, 1);
          const result = selector.selectDailyTopics([{ ...inheritance }], { now: NOW, count: 1, withdrawn: [] });
          assert.deepEqual(result.picks.map(p => p.slug), [inheritance.slug]);
        } finally {
          console.warn = warn;
          delete require.cache[balancePath];
          delete require.cache[selectorPath];
        }
      });
    });
  }
  for (const macro of ['未知の分類', '税目実務']) {
    test(`配分表にない ${macro} は起動時に例外`, () => {
      assert.ok(macro === '税目実務' ? ALL_MACROS.includes(macro) : !ALL_MACROS.includes(macro));
      withConfigFile({ window_days: 30, planned_per_window: 13, strict_macros: [macro] }, () => {
        delete require.cache[balancePath];
        assert.throws(() => require('../category-balance'), /macro 上限設定の分類が不正/);
      });
    });
  }
  test('読めない設定は警告つきで無効になる', () => {
    const warnings = [];
    const config = loadMacroQuota(path.join(__dirname, 'nonexistent-macro-quota.json'), line => warnings.push(line));
    assert.equal(config, null);
    assert.equal(warnings.length, 1);
    assert.deepEqual(applyMacroQuota([inheritance], {}).passed, [inheritance]);
  });

  console.log('\n=== 5. 比率への下書き加算と後方互換 ===');
  test('下書きは 7・14・30 日それぞれの日付に応じて加算される', () => {
    main = [post('main-retail', 1, { primary_persona: 'ebay_export_seller' })];
    const result = computeMacroRatios(NOW, { extraCorpus: [pending('d3', 3), pending('d10', 10), pending('d20', 20), pending('d31', 31)] });
    assert.deepEqual(result.totals, { 7: 2, 14: 3, 30: 4 });
    assert.equal(result.ratios[7]['相続贈与'], 1 / 2);
    assert.equal(result.ratios[14]['相続贈与'], 2 / 3);
    assert.equal(result.ratios[30]['相続贈与'], 3 / 4);
  });
  test('比率でも main・下書きの同じ slug は 1 本', () => {
    main = [post('shared')];
    assert.deepEqual(computeMacroRatios(NOW, { extraCorpus: [pending('shared')] }), computeMacroRatios(NOW));
  });
  test('下書きを渡さない既存の呼び出しは main の従来集計と一致する', () => {
    main = [post('recent'), post('old', 31), post('merged', 1, { review_status: 'merged' })];
    const result = computeMacroRatios(NOW);
    assert.deepEqual(result, computeMacroRatios(NOW, { extraCorpus: [] }));
    for (const days of [7, 14, 30]) {
      const posts = corpus.readPostsWithinDays(days, NOW);
      assert.equal(result.totals[days], posts.length);
      for (const macro of ALL_MACROS) {
        assert.equal(result.ratios[days][macro], posts.filter(p => p.macro === macro).length / posts.length);
      }
    }
  });
} finally {
  corpus.readPostsWithinDays = savedReadWindow;
  corpus.readAllPostsSorted = savedReadAll;
  delete require.cache[balancePath];
  delete require.cache[selectorPath];
  if (savedBalance) require.cache[balancePath] = savedBalance;
  if (savedSelector) require.cache[selectorPath] = savedSelector;
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
