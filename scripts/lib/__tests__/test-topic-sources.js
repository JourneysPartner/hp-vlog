'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  narrowTopicToTerm,
  selectSourcesPerTerm,
  splitPrimaryAndSupplements,
} = require(path.join(ROOT, 'scripts/lib/topic-sources'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

async function main() {
  console.log('\n=== Test 1: 論点を絞る ===');
  {
    const topic = {
      title: '土地・家を生前贈与するには？',
      tax_terms: '不動産の贈与税評価額 相続時精算課税',
      pain_point: 'property-gift',
      search_intent: '土地 贈与 手続き',
      reader_problem: 'どの制度を選べばよいか分からない',
      primary_question: '生前贈与はどう進める？',
      subcluster: 'gift-property',
      tax_domain: 'inheritance_tax',
      customer_segment: 'inheritance_client',
    };
    const before = JSON.stringify(topic);
    const narrowed = narrowTopicToTerm(topic, '相続時精算課税');
    assert(narrowed.tax_terms === '相続時精算課税' && narrowed.pain_point === '相続時精算課税'
      && narrowed.title === '相続時精算課税', '選定に使う3項目が論点語になる');
    assert(['search_intent', 'reader_problem', 'primary_question', 'subcluster']
      .every(key => narrowed[key] === ''), '記事全体の語を落とす');
    assert(narrowed.tax_domain === topic.tax_domain
      && narrowed.customer_segment === topic.customer_segment, '候補プールに要る項目を残す');
    assert(JSON.stringify(topic) === before, '元の topic を書き換えない');
  }

  console.log('\n=== Test 2: 論点ごとの選定 ===');
  {
    const terms = ['論点A', '論点B', '論点C', '論点D'];
    let calls = 0;
    const results = await selectSourcesPerTerm({}, terms, async (topic) => {
      calls++;
      if (topic.tax_terms === '論点B') return null;
      return {
        url: `https://example.com/${topic.tax_terms}`,
        title: `${topic.tax_terms}の出典`,
        no: topic.tax_terms,
        confidence: topic.tax_terms === '論点A' ? 0.8 : (topic.tax_terms === '論点C' ? 0.9 : 0.95),
        tier: 'A',
        reason: '',
      };
    });
    assert(calls === 4, '4論点なら4回 resolveSource を呼ぶ');
    assert(results.length === 3 && !results.some(r => r.term === '論点B'),
      'null の論点だけを落として残り3論点を返す');
    assert(results[0].term === '論点D' && results[2].term === '論点A',
      '確信度の降順に並ぶ');

    const afterError = await selectSourcesPerTerm({}, terms, async (topic) => {
      if (topic.tax_terms === '論点C') throw new Error('テスト用失敗');
      return {
        url: `https://example.com/error/${topic.tax_terms}`,
        title: topic.tax_terms,
        confidence: 0.9,
      };
    });
    assert(afterError.length === 3 && !afterError.some(r => r.term === '論点C'),
      '例外の論点だけを落として残りを返す');

    const duplicated = await selectSourcesPerTerm({}, ['先の論点', '後の論点'], async (topic) => ({
      url: 'https://example.com/same',
      title: topic.tax_terms,
      no: '1000',
      confidence: topic.tax_terms === '先の論点' ? 0.7 : 0.96,
      tier: 'A',
      reason: '',
    }));
    assert(duplicated.length === 1 && duplicated[0].term === '後の論点',
      'URL 重複時は確信度が高い論点だけを残す');
  }

  console.log('\n=== Test 3: 正本と補助の切り分け ===');
  {
    const results = [
      { term: '第一論点', confidence: 0.99 },
      { term: '第二論点', confidence: 0.95 },
      { term: '第三論点', confidence: 0.94 },
      { term: '第四論点', confidence: 0.93 },
      { term: '第五論点', confidence: 0.92 },
    ];
    const split = splitPrimaryAndSupplements(results);
    assert(split.primary.term === '第一論点', '最高確信度が正本になる');
    assert(split.supplements.length === 3 && !split.supplements.includes(results[4]),
      '補助出典は最大3件に切る');
    const tied = splitPrimaryAndSupplements([
      { term: '先の論点', confidence: 0.95 },
      { term: '後の論点', confidence: 0.95 },
    ]);
    assert(tied.primary.term === '先の論点', '同点なら先の論点語が正本になる');
    const empty = splitPrimaryAndSupplements([]);
    assert(empty.primary === null && empty.supplements.length === 0, '空配列なら正本は null');
  }

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
