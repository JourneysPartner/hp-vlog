'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  narrowTopicToTerm,
  selectSourcesPerTerm,
  splitPrimaryAndSupplements,
} = require(path.join(ROOT, 'scripts/lib/topic-sources'));
const { evaluateSourceGuard } = require(path.join(ROOT, 'scripts/lib/source-guard'));

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

  console.log('\n=== Test 4: 11/23 の再現（実カタログ） ===');
{
  // run 45086695901 の4件。段 D の No.9205 が最高確信度でもカタログ外なので正本にしない。
  const results = [
    { term: '延滞税', no: '9205', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/osirase/9205.htm', confidence: 1 },
    { term: '法定調書', no: 'N/A', url: 'https://www.nta.go.jp/publication/pamph/hotei/tebiki2024/index.htm', confidence: 0.99 },
    { term: '無申告加算税', no: '2024', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2024.htm', confidence: 0.93 },
    { term: '重加算税', no: '2026', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2026.htm', confidence: 0.68 },
  ];
  const split = splitPrimaryAndSupplements(results);
  assert(split.primary && split.primary.no === '2024',
    'カタログ収録の No.2024 が正本になる');
  assert(split.supplements.length === 3
    && split.supplements.map(s => s.no).join(',') === '9205,N/A,2026',
  '補助は 9205・N/A・2026 の確信度順で3件');

  const withPrimary = (primary, supplements) => {
    const meta = {
      source_url: primary.url,
      source_title: primary.title || '',
      source_provenance: 'llm-auto',
      source_confidence: primary.confidence,
      source_term: primary.term,
      source_guard_version: 1,
      review_status: 'draft',
      tax_domain: 'income_tax',
    };
    supplements.forEach((s, i) => {
      const n = i + 2;
      meta[`source_${n}_url`] = s.url;
      meta[`source_${n}_title`] = s.title || '';
      meta[`source_${n}_term`] = s.term;
      meta[`source_${n}_confidence`] = s.confidence;
    });
    return meta;
  };
  const approved = evaluateSourceGuard(withPrimary(split.primary, split.supplements), { stage: 'approve' });
  assert(approved.blocked === false, '選ばれた正本は承認段階のガードを通る');
  const blocked = evaluateSourceGuard(withPrimary(results[0], split.supplements), { stage: 'approve' });
  assert(blocked.blocked === true, '正本を No.9205 にすると従来どおり止まる（判定は変えていない）');
}

console.log('\n=== Test 5: 資格のある候補が無い ===');
{
  const results = [
    { term: '先の論点', no: '1000', url: 'https://example.com/a', confidence: 0.95 },
    { term: '後の論点', no: '1001', url: 'https://example.com/b', confidence: 0.9 },
  ];
  const split = splitPrimaryAndSupplements(results, { isEligiblePrimary: () => false });
  assert(split.primary.no === '1000', '資格なしなら最高確信度が正本になる（今までの動き）');
  assert(split.skipped.length === 0, '飛ばしていなければ skipped は空');
}

console.log('\n=== Test 6: 資格はあるが確信度 0.9 未満 ===');
{
  // 本物の判定。カタログ収録でも確信度が 0.9 未満なら承認時のガードは通らない。
  const results = [
    { term: '無申告加算税', no: '2024', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2024.htm', confidence: 0.85 },
    { term: '延滞税', no: '9205', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/osirase/9205.htm', confidence: 1 },
  ];
  const split = splitPrimaryAndSupplements(results);
  assert(split.primary.no === '9205', '資格のある候補が無いので最高確信度の No.9205 が正本になる');
  assert(split.supplements.length === 1 && split.supplements[0].no === '2024',
    '飛ばした No.2024 は補助に回る');
}

console.log('\n=== Test 7: 同点 ===');
{
  const results = [
    { term: '先の論点', no: '2024', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2024.htm', confidence: 0.95 },
    { term: '後の論点', no: '2026', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2026.htm', confidence: 0.95 },
  ];
  const split = splitPrimaryAndSupplements(results);
  assert(split.primary.term === '先の論点', '資格のある2件が同点なら入力順の先が正本になる');
}

console.log('\n=== Test 8: 判定が例外 ===');
{
  const results = [
    { term: '第一論点', no: '1', url: 'https://example.com/1', confidence: 0.99 },
    { term: '第二論点', no: '2', url: 'https://example.com/2', confidence: 0.95 },
    { term: '第三論点', no: '3', url: 'https://example.com/3', confidence: 0.9 },
  ];
  const split = splitPrimaryAndSupplements(results, {
    isEligiblePrimary: (item) => {
      if (item.term === '第一論点') throw new Error('テスト用失敗');
      return item.term === '第三論点';
    },
  });
  assert(split.primary.term === '第三論点', '例外の候補は飛ばして次の資格候補を正本にする');
  assert(split.skipped.map(s => s.term).join(',') === '第一論点,第二論点',
    '飛ばした候補が skipped に順番どおり入る');

  const allThrow = splitPrimaryAndSupplements(results, {
    isEligiblePrimary: () => { throw new Error('テスト用失敗'); },
  });
  assert(allThrow.primary.term === '第一論点', '全部が例外なら最高確信度が正本になる（生成は止めない）');
}

console.log('\n=== Test 9: 補助の件数 ===');
{
  const results = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => ({
    term: `論点${key}`, no: String(i), url: `https://example.com/${key}`, confidence: 0.99 - i * 0.01,
  }));
  const split = splitPrimaryAndSupplements(results, {
    isEligiblePrimary: item => item.term === '論点c',
  });
  assert(split.primary.term === '論点c', '3番目の候補を正本にする');
  assert(split.supplements.length === 3, '正本が3番目でも補助は3件');
  assert(!split.supplements.includes(split.primary), '補助に正本を含めない');
  assert(split.supplements.map(s => s.term).join(',') === '論点a,論点b,論点d',
    '補助は確信度順のまま正本の次から詰める');
}

console.log('\n=== Test 10: skipped の中身 ===');
{
  const results = [
    { term: '延滞税', no: '9205', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/osirase/9205.htm', confidence: 1 },
    { term: '法定調書', no: 'N/A', url: 'https://www.nta.go.jp/publication/pamph/hotei/tebiki2024/index.htm', confidence: 0.99 },
    { term: '無申告加算税', no: '2024', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2024.htm', confidence: 0.93 },
  ];
  const split = splitPrimaryAndSupplements(results);
  assert(split.skipped.map(s => s.no).join(',') === '9205,N/A',
    'skipped は正本より前で飛ばした候補（通知ログの1行目に使う）');
  const noSkip = splitPrimaryAndSupplements([
    { term: '一個だけ', no: '2024', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2024.htm', confidence: 0.95 },
  ]);
  assert(noSkip.skipped.length === 0, '先頭が資格ありなら skipped は空');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
