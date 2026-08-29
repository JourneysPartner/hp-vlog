'use strict';
/**
 * 記事の必須メタが欠けないこと（2026-08-28/29 の生成停止）
 *
 * 何が起きたか:
 *   段階1・3改で追加した候補（質疑応答由来・検索需要由来）に success_outcome を
 *   入れていなかった。下書きのうちは警告どまりだが、承認して main に入った瞬間から
 *   毎日の validate が ERROR を返すようになり、日次生成ジョブが
 *   バリデーションごと落ちて2日連続で下書きが作られなかった。
 *   記事自体は生成できていたのに、ジョブが exit 1 になって PR が作られず失われた。
 *
 * 検証:
 *   1. すべての候補源が必須メタを備えている
 *   2. 記事生成時、トピックに無くても success_outcome が空にならない
 *   3. 公開中・承認済みの記事に必須メタの欠落が無い
 */
const fs = require('fs');
const path = require('path');
const matter = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'gray-matter'));
const ROOT = path.join(__dirname, '..', '..', '..');
const { expandShitsugiTopics } = require(path.join(ROOT, 'scripts/lib/shitsugi-topics'));
const { expandSuggestTopics } = require(path.join(ROOT, 'scripts/lib/suggest-topics'));
const N = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// validate.js が承認/公開段階で必須にしている企画メタ
const REQUIRED = ['search_intent', 'reader_problem', 'success_outcome', 'primary_question'];
const missingOf = (obj) => REQUIRED.filter(k => !obj[k]);

console.log('=== 1. 候補源が必須メタを備えている ===');
{
  const shitsugi = expandShitsugiTopics({ logger: null });
  const bad1 = shitsugi.filter(t => missingOf(t).length > 0);
  assert(shitsugi.length > 0, `質疑応答由来の候補がある（${shitsugi.length}件）`);
  assert(bad1.length === 0,
    `質疑応答由来に必須メタの欠落なし（欠落 ${bad1.length}件${bad1[0] ? ` 例: ${bad1[0].slug} → ${missingOf(bad1[0])}` : ''}）`);

  const suggest = expandSuggestTopics({ logger: null });
  const bad2 = suggest.filter(t => missingOf(t).length > 0);
  assert(suggest.length > 0, `検索需要由来の候補がある（${suggest.length}件）`);
  assert(bad2.length === 0,
    `検索需要由来に必須メタの欠落なし（欠落 ${bad2.length}件${bad2[0] ? ` 例: ${bad2[0].slug} → ${missingOf(bad2[0])}` : ''}）`);

  // 既存の掛け算プールも含めて、日次生成が選びうる全候補を確認する
  const { TOPICS } = require(path.join(ROOT, 'scripts/topic-pool'));
  const bad3 = TOPICS.filter(t => missingOf(t).length > 0);
  assert(bad3.length === 0,
    `候補プール全体に欠落なし（${TOPICS.length}件中 ${bad3.length}件${bad3[0] ? ` 例: ${bad3[0].slug} → ${missingOf(bad3[0])}` : ''}）`);
}

console.log('');
console.log('=== 2. 生成時に success_outcome が空にならない ===');
{
  const base = {
    slug: 'test-topic', category: '消費税', macro: '税目実務', article_type: 'basic_explainer',
    tax_domain: 'consumption_tax', persona: 'general_individual_proprietor',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6165.htm',
    source_provenance: 'curated', source_confidence: 1,
    search_intent: '検索意図', reader_problem: '読者の悩み',
  };
  const raw = ['---', 'title: "テスト記事のタイトルです"',
    'summary: "要約の文章がここに入ります。十分な長さがあります。"', '---', '', '## 見出し', '本文'].join('\n');
  const outcomeOf = (topic) => {
    const c = N.normalizeGeneratedDraft(raw, topic, { now: new Date().toISOString() }).content;
    return (c.match(/^success_outcome: "(.*)"$/m) || [])[1];
  };

  assert(outcomeOf({ ...base, primary_question: '2割特例は誰が使える？' }),
    'トピックに無くても、読者の問いから組み立てられる');
  assert(outcomeOf(base), '読者の問いも無い場合はタイトルから組み立てられる');
  assert(outcomeOf({ ...base, success_outcome: '指定した達成状態' }) === '指定した達成状態',
    'トピックにあればそれをそのまま使う');
  assert(!outcomeOf(base).includes('？') && !outcomeOf({ ...base, primary_question: 'これは使える？' }).includes('？'),
    '問いの末尾の疑問符は落とされる');
}

console.log('');
console.log('=== 3. 既存記事に必須メタの欠落が無い ===');
{
  const dir = path.join(ROOT, 'content', 'posts');
  const LIVE = new Set(['approved', 'scheduled', 'published']);
  const broken = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const fm = matter(fs.readFileSync(path.join(dir, file), 'utf8')).data || {};
    if (!LIVE.has(String(fm.review_status || ''))) continue;
    // 2026-05-01 より前の記事は後方互換で警告どまり（validate.js と同じ扱い）
    const createdAt = fm.created_at ? new Date(fm.created_at) : null;
    if (!createdAt || createdAt < new Date('2026-05-01T00:00:00+09:00')) continue;
    const miss = missingOf(fm);
    if (miss.length) broken.push(`${file} → ${miss.join(', ')}`);
  }
  assert(broken.length === 0,
    `承認済み・公開済みの記事に欠落なし${broken.length ? `（${broken.length}件: ${broken[0]}）` : ''}`);
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
