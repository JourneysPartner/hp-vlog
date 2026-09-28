'use strict';

const {
  tokenizeQuery,
  normalizeQuery,
  deriveIntentType,
  prefillTargetQuery,
  resolveTargetQuery,
  findTargetQueryOwner,
} = require('../target-query');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

(async () => {
  console.log('\n=== tokenizeQuery / normalizeQuery ===');
  assert(tokenizeQuery(' ＥＢＡＹ・消費税、還付／手順 ').join('|') === 'ebay|消費税|還付|手順',
    'NFKC・小文字化・区切り文字に対応');
  assert(normalizeQuery('勘定科目 塗料') === normalizeQuery('塗料・勘定科目'),
    '語順と区切りが違っても同じキー');

  console.log('\n=== deriveIntentType ===');
  for (const q of ['塗料 勘定科目', 'インボイス いつまで']) {
    assert(deriveIntentType(q) === 'answer', `${q} → answer`);
  }
  for (const q of ['青色申告 白色申告 違い', '法人化 すべき']) {
    assert(deriveIntentType(q) === 'decide', `${q} → decide`);
  }
  for (const q of ['確定申告 やり方', '還付 手順']) {
    assert(deriveIntentType(q) === 'guide', `${q} → guide`);
  }
  assert(deriveIntentType('ネットショップ 税務') === 'decide', '該当なし → decide');

  console.log('\n=== prefillTargetQuery ===');
  const suggestTopic = {
    demand_evidence: { kind: 'search-suggest', phrases: ['塗料 勘定科目', '塗料 仕訳'] },
  };
  const prefilled = prefillTargetQuery(suggestTopic);
  assert(prefilled.target_query === '塗料 勘定科目', 'suggest の先頭を主検索語にする');
  assert(prefilled.secondary_queries.join(',') === '塗料 仕訳', '残りを副検索語にする');
  assert(prefillTargetQuery({ demand_evidence: { kind: 'manual', phrases: ['x'] } }) === null,
    'suggest / gsc 以外は prefill しない');

  const base = {
    title: '塗料の経理処理', slug: 'pool-topic-id', primary_question: '塗料は何費ですか',
    reader_problem: '処理に迷う', search_intent: '塗料 勘定科目', persona: 'construction_solo',
    tax_domain: 'income_tax',
  };
  const goodJson = JSON.stringify({
    target_query: '塗料 勘定科目',
    secondary_queries: ['塗料 仕訳', 'ペンキ 経費', '勘定科目 塗料'],
    intent_type: 'answer',
    slug_words: 'paint-account-category-guide',
  });

  console.log('\n=== resolveTargetQuery ===');
  const good = await resolveTargetQuery(base, async () => goodJson, {
    suggestRaw: { seeds: [{ phrases: ['勘定科目 塗料', '塗料 勘定科目 個人事業主'] }] },
    gscQueries: [{ query: '塗料 勘定科目', impressions: 10, position: 9 }],
    existingSlugs: new Set(),
  });
  assert(good.target_query === '塗料 勘定科目', '正常 JSON を採用');
  assert(good.secondary_queries.length === 2, '主検索語との一致と重複を除外');
  assert(good.intent_type === 'answer', '正しい intent_type を採用');
  assert(good.slug_words === 'paint-account-category-guide', '正しい slug_words を採用');
  assert(good.evidence.suggest.length === 2 && good.evidence.gsc.length === 1, 'suggest / GSC の裏取りを収集');

  const withProse = await resolveTargetQuery(base, async () => `結果です。\n${goodJson}\n以上です。`, {});
  assert(withProse && withProse.target_query === '塗料 勘定科目', 'JSON 前後に文章があっても抽出');

  const fallback = await resolveTargetQuery(suggestTopic, async () => '{invalid', {});
  assert(fallback && fallback.target_query === '塗料 勘定科目', '不正 JSON は prefill にフォールバック');
  const noFallback = await resolveTargetQuery(base, async () => '{invalid', {});
  assert(noFallback === null, '不正 JSON かつ prefill 無しは null');

  const generic = await resolveTargetQuery(base, async () => JSON.stringify({
    target_query: '消費税 税金', secondary_queries: [], intent_type: 'answer', slug_words: 'tax-general-answer',
  }), {});
  assert(generic === null, '一般語だけの主検索語は不採用');

  const badIntent = await resolveTargetQuery(base, async () => JSON.stringify({
    target_query: '確定申告 やり方', secondary_queries: [], intent_type: 'other', slug_words: 'tax-return-filing-steps',
  }), {});
  assert(badIntent.intent_type === 'guide', '不正 intent_type は規則で補完');

  for (const [slugWords, existing, label] of [
    ['paint-guide', [], '語数不足'],
    ['suggest-paint-account-guide', [], '禁止接頭辞'],
    ['paint-account-category-guide', ['paint-account-category-guide'], '既存 slug 衝突'],
  ]) {
    const r = await resolveTargetQuery(base, async () => JSON.stringify({
      target_query: '塗料 勘定科目', secondary_queries: [], intent_type: 'answer', slug_words: slugWords,
    }), { existingSlugs: new Set(existing) });
    assert(r && r.slug_words === '', `不正 slug（${label}）は空にする`);
  }

  console.log('\n=== findTargetQueryOwner ===');
  const corpus = [
    { slug: 'owner', target_query: '勘定科目 塗料' },
    { slug: 'secondary-only', target_query: '別の 語', secondary_queries: '塗料 勘定科目' },
  ];
  assert(findTargetQueryOwner(normalizeQuery('塗料 勘定科目'), corpus).slug === 'owner',
    '語順違いの主検索語所有者を返す');
  assert(findTargetQueryOwner('別の副検索語', corpus) === null, '副検索語だけの一致は返さない');
  const inactiveCorpus = [
    { slug: 'dropped', target_query: '塗料 勘定科目', review_status: 'skipped' },
    { slug: 'merged-old', target_query: '塗料 勘定科目', review_status: 'merged' },
    { slug: 'live', target_query: '塗料 勘定科目', review_status: 'published' },
  ];
  assert(findTargetQueryOwner('塗料 勘定科目', inactiveCorpus).slug === 'live',
    '取り下げ済み・統合済みの記事は所有者に数えない');
  assert(findTargetQueryOwner('塗料 勘定科目', inactiveCorpus.slice(0, 2)) === null,
    '取り下げ済みしか無ければ所有者なし');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
