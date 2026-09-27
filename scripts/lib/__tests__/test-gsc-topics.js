'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const U = require(path.join(ROOT, 'scripts/update-gsc-topics'));
const G = require(path.join(ROOT, 'scripts/lib/gsc-topics'));
const SuggestUpdate = require(path.join(ROOT, 'scripts/update-suggest-topics'));
const { enforceDemandKindDailyLimit } = require(path.join(ROOT, 'scripts/lib/topic-selector'));

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-topics-'));
const TOPICS_FILE = path.join(TMP, 'gsc-topics.json');

function post(slug, overrides = {}) {
  return {
    slug,
    title: `題名 ${slug}`,
    review_status: 'published',
    target_query: '',
    ...overrides,
  };
}

function qp(query, page, impressions, position) {
  return { query, page, impressions, position, clicks: 0, ctr: 0 };
}

(async () => {
  console.log('=== 1. GSC 候補の抽出・除外・表記ゆれ統合 ===');
  const posts = [
    post('article-a'),
    post('article-b'),
    post('article-position'),
    post('target-owner', { target_query: '対象済み' }),
  ];
  const postContents = new Map([
    ['article-a', { title: 'インボイスの記事', headings: [], body: 'その他の本文です。' }],
    ['article-b', { title: '別の題名', headings: [], body: '記事内語を本文で解説します。' }],
    ['article-position', { title: '別の題名', headings: [], body: '順位だけを解説します。' }],
  ]);
  const queries = [
    { query: 'インボイス制度 レシート', impressions: 30, position: 15 },
    { query: 'イン ボイス 制度 レシート', impressions: 24, position: 16 },
    { query: '順位だけ', impressions: 20, position: 25 },
    { query: 'サービス候補', impressions: 15, position: 5 },
    { query: '最上位判定', impressions: 14, position: 10 },
    { query: '対象済み', impressions: 50, position: 25 },
    { query: '既出語', impressions: 40, position: 25 },
    { query: '定額減税 2024', impressions: 30, position: 25 },
    { query: '表示不足', impressions: 9, position: 25 },
    { query: '記事内語', impressions: 20, position: 15 },
  ];
  const queryPages = [
    qp('インボイス制度 レシート', 'https://mori-zeirishi.net/blog/article-a/', 30, 15),
    qp('イン ボイス 制度 レシート', 'https://mori-zeirishi.net/blog/article-a/', 24, 16),
    qp('順位だけ', 'https://mori-zeirishi.net/blog/article-position/', 20, 25),
    qp('サービス候補', 'https://mori-zeirishi.net/services/bookkeeping/', 15, 5),
    qp('最上位判定', 'https://mori-zeirishi.net/blog/article-a/', 100, 25),
    qp('最上位判定', 'https://mori-zeirishi.net/services/bookkeeping/', 1, 10),
    qp('対象済み', 'https://mori-zeirishi.net/blog/article-a/', 50, 25),
    qp('既出語', 'https://mori-zeirishi.net/blog/article-a/', 40, 25),
    qp('定額減税 2024', 'https://mori-zeirishi.net/blog/article-a/', 30, 25),
    qp('表示不足', 'https://mori-zeirishi.net/blog/article-a/', 9, 25),
    qp('記事内語', 'https://mori-zeirishi.net/blog/article-b/', 20, 15),
  ];
  const existingTopics = [{ slug: 'gsc-existing', phrases: ['既出語'] }];
  const denylist = { entries: [{ type: 'keyword', value: '定額減税', active: true }] };
  const extracted = U.extractGscCandidates({
    queries, queryPages, posts, postContents, existingTopics, denylist,
    now: new Date('2026-09-27T00:00:00Z'),
  });
  const invoice = extracted.find(item => item.phrases.includes('インボイス制度 レシート'));
  assert(invoice && invoice.phrases.length === 2 && invoice.impressions === 54,
    'normalizeQuery またはトークン包含で表記ゆれを1件にまとめる');
  assert(extracted.some(item => item.phrases.includes('順位だけ')), '最上位ページが20位超なら対象');
  assert(extracted.some(item => item.phrases.includes('サービス候補')), '最上位ページが記事以外なら対象');
  assert(extracted.find(item => item.phrases.includes('最上位判定')).page.includes('/services/'),
    '最上位ページは表示回数でなく順位で決める');
  assert(!extracted.some(item => item.phrases.includes('対象済み')), 'target_query 保有記事がある語を除外');
  assert(!extracted.some(item => item.phrases.includes('既出語')), '既存の GSC 候補を除外');
  assert(!extracted.some(item => item.phrases.includes('定額減税 2024')), 'denylist に当たる語を除外');
  assert(!extracted.some(item => item.phrases.includes('表示不足')), '表示10回未満を除外');
  assert(!extracted.some(item => item.phrases.includes('記事内語')), '順位20位以内で記事内に語があれば除外');

  console.log('\n=== 2. 偽 LLM での選別・検証・既存保持 ===');
  const retained = {
    slug: 'gsc-a1b2c3d4', phrases: ['保持する語'], impressions: 20, position: 22,
    page: 'https://mori-zeirishi.net/blog/old/', persona: 'general_individual_proprietor',
    tax_domain: 'income_tax', category: '所得税', article_type: 'basic_explainer',
    primary_question: '保持する問いは何か？', reader_problem: '保持する悩み', selected_at: '2026-09-20T00:00:00Z',
  };
  fs.writeFileSync(TOPICS_FILE, JSON.stringify({ version: 1, topics: [retained] }), 'utf8');
  let samePrompt = false;
  const selectedInputs = extracted.slice(0, 2);
  const fakeLLM = async (system) => {
    samePrompt = system === SuggestUpdate.SELECT_SYSTEM;
    return JSON.stringify({ topics: [
      {
        seed_id: selectedInputs[0].id, phrases: selectedInputs[0].phrases,
        persona: 'general_individual_proprietor', tax_domain: 'invoice_system', category: 'インボイス',
        article_type: 'basic_explainer', primary_question: 'インボイスのレシートはどう扱うか？',
        reader_problem: 'レシートの扱いが分からない',
      },
      {
        seed_id: selectedInputs[1].id, phrases: selectedInputs[1].phrases,
        persona: '不明', tax_domain: 'income_tax', category: '所得税',
        article_type: 'basic_explainer', primary_question: 'x', reader_problem: 'y',
      },
    ] });
  };
  const stats = await U.selectTopics({
    candidates: selectedInputs, callLLM: fakeLLM, topicsFile: TOPICS_FILE,
    logger: null, nowFn: () => '2026-09-27T01:00:00Z',
  });
  const saved = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
  const accepted = saved.topics.find(topic => topic.slug !== 'gsc-a1b2c3d4');
  assert(samePrompt, 'サジェスト側と同じ選別プロンプトを再利用する');
  assert(stats.accepted === 1 && stats.invalid === 1, '許容値外の LLM 提案を却下する');
  assert(saved.topics.some(topic => topic.slug === 'gsc-a1b2c3d4'), '既存の行を保持する');
  assert(accepted && accepted.slug === U.slugFor(accepted.phrases[0])
    && accepted.impressions === selectedInputs[0].impressions
    && accepted.position === selectedInputs[0].position
    && accepted.page === selectedInputs[0].page, '決定的 slug と GSC の根拠を保存する');

  const noKeyFile = path.join(TMP, 'no-key.json');
  const skipped = await U.run({
    env: {}, queries: [], queryPages: [], posts: [], postContents: new Map(),
    existingTopics: [], denylist: { entries: [] }, topicsFile: noKeyFile, logger: null,
  });
  assert(skipped.status === 'skipped' && !fs.existsSync(noKeyFile), 'API キーが無ければ何も書かず正常終了');

  console.log('\n=== 3. プール形式への変換・点数・無効化 ===');
  const expanded = G.expandGscTopics({ topicsFile: TOPICS_FILE, logger: null });
  const poolTopic = expanded.find(topic => topic.slug === accepted.slug);
  assert(expanded.length === 2, '既存候補と新規候補の両方を展開する');
  assert(poolTopic && poolTopic.title === '' && poolTopic.cluster === 'gsc-invoice_system'
    && poolTopic.subcluster === accepted.slug && poolTopic.pain_point === accepted.slug,
  'プールの slug・cluster・subcluster・pain_point へ変換する');
  assert(poolTopic && poolTopic.search_intent === accepted.phrases.join(' ')
    && poolTopic.demand_evidence.kind === 'gsc'
    && poolTopic.demand_evidence.impressions === accepted.impressions,
  '検索語と GSC 実測を需要の証拠にする');
  assert(G.scoreForImpressions(54) === 85 && G.scoreForImpressions(150) === 95,
    'score = min(95, 80 + floor(impressions / 10))');
  assert(G.validateTopic({ ...accepted, persona: '不明' }).includes('persona'), 'persona の許容値を検証する');
  assert(G.validateTopic({ ...accepted, tax_domain: '不明' }).includes('tax_domain'), 'tax_domain の許容値を検証する');
  assert(G.validateTopic({ ...accepted, category: '不明' }).includes('category'), 'category の許容値を検証する');
  assert(G.validateTopic({ ...accepted, article_type: '不明' }).includes('article_type'), 'article_type の許容値を検証する');
  assert(G.validateTopic({ ...accepted, phrases: [] }).includes('検索語'), 'phrases 必須を検証する');
  assert(G.validateTopic({ ...accepted, primary_question: '' }).includes('企画メタ'), '企画メタ必須を検証する');
  process.env.DISABLE_GSC_TOPICS = 'true';
  assert(G.expandGscTopics({ topicsFile: TOPICS_FILE, logger: null }).length === 0, 'DISABLE_GSC_TOPICS=true で空を返す');
  delete process.env.DISABLE_GSC_TOPICS;

  console.log('\n=== 4. GSC 由来は1日1本 ===');
  const scored = [1, 2, 3].map((number, index) => ({
    topic: {
      slug: `gsc-${number}`, search_intent: `GSC 候補 ${number}`, article_type: 'basic_explainer',
      demand_evidence: { kind: index < 2 ? 'gsc' : 'search-suggest', score: 85 },
    },
    priority: 3 - index,
    balance: 0,
  }));
  const limited = enforceDemandKindDailyLimit([scored[0].topic, scored[1].topic], scored);
  assert(limited.length === 2 && limited.some(topic => topic.slug === 'gsc-1')
    && limited.some(topic => topic.slug === 'gsc-3'), 'GSC 2本なら低優先度側を別種の次点へ差し替える');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => {
  console.error(error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
