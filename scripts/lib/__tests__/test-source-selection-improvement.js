/**
 * 出典探しの改善（2026-08-24）
 *
 * 「オンライン講座＋個別コンサルのセット販売」の記事で、正解の
 * No.6165「前受金や前払金などがあるとき」が候補にすら入らず、
 * 代わりに No.6101「消費税の基本的なしくみ」が選ばれた事故への対応。
 *
 * 3つの変更を検証する:
 *   1. 珍しい語ほど重視して採点する
 *   2. 記事を書く前に決めた税務の論点語を採点に入れる
 *   3. 税目全体の総論ページを主出典にしない
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'scripts/lib/nta-source-matcher'));
const refs = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
const { parseTerms, buildUserPrompt, TOO_GENERIC } = require(path.join(ROOT, 'scripts/lib/tax-terms'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// 事故が起きた記事の企画（当時のフロントマターそのまま）
const ACCIDENT = {
  tax_domain: 'consumption_tax',
  pain_point: 'content-course-bundle',
  search_intent: 'オンライン講座 オンライン講座 コンサル セット 販売 区分 消費税',
  reader_problem: 'セット販売の対価区分と課税判定が不安',
  primary_question: '講座＋個別コンサルのセット販売は消費税・売上をどう区分する？',
  subcluster: 'consumption-tax-content-course-bundle-course',
};
const rank = (topic) => {
  const all = M.rankSources(topic, { limit: 2000 }).candidates || [];
  return no => all.findIndex(c => String(c.no) === String(no)) + 1;
};

console.log('=== 1. 珍しい語ほど重視する ===');
{
  // 「課税」は多くのページに出るので手がかりにならない。「前受金」は数ページにしかない。
  const common = M.tokenizeForMatcher('課税');
  const rare = M.tokenizeForMatcher('前受金');
  const titleWithRare = M.tokenizeForMatcher('前受金や前払金などがあるとき');
  const df = { docs: 672, min_df: 3, df: { 課税: 360, 前受金: 3 } };
  const rc = (q) => M.rarityCoverage(q, titleWithRare, df);
  assert(rc(rare) > rc(common), '珍しい語が一致した方が高く評価される');
  assert(M.rarityCoverage(rare, titleWithRare, null) === 0, '珍しさ表が無ければ 0（従来の採点のまま動く）');
  assert(M.RARITY_WEIGHT > 0 && M.RARITY_WEIGHT < 1, '珍しさは従来の採点と混ぜて使う');
}

console.log('');
console.log('=== 2. 税務の論点語を採点に入れる ===');
{
  const before = rank(ACCIDENT)('6165');
  const after = rank({ ...ACCIDENT, tax_terms: '前受金 売上計上時期' })('6165');
  assert(before > 5, `論点語が無いと正解は候補外（実測 ${before}位）`);
  assert(after === 1, `論点語を足すと正解が1位（実測 ${after}位）`);

  // 論点語は「読者の場面のことば」ではなく「税務の概念のことば」でなければ効かない
  const situational = rank({ ...ACCIDENT, tax_terms: 'オンライン講座 セット販売' })('6165');
  assert(situational > 5, '場面のことばを論点語にしても届かない');
}

console.log('');
console.log('=== 3. 総論ページを主出典にしない ===');
{
  const overview = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6101.htm';
  assert(refs.isDeniedSource(overview), 'No.6101 消費税の基本的なしくみ は主出典にできない');
  assert(refs.isDeniedSource('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1000.htm'),
    'No.1000 所得税のしくみ は主出典にできない');
  // 論点別の「あらまし」は主出典として妥当なので禁止しない（5記事が実際に使っている）
  assert(!refs.isDeniedSource('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm'),
    'No.2100 減価償却のあらまし は引き続き主出典にできる');
  assert(!refs.isDeniedSource('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6165.htm'),
    '論点に対応するページは当然使える');

  // 候補リストからも消えていること（残っていると LLM が選んでしまう）
  const all = M.rankSources(ACCIDENT, { limit: 2000 }).candidates || [];
  assert(!all.some(c => String(c.no) === '6101'), '総論ページは候補リストにも載らない');
  assert(all.length > 0, '禁止しても候補は残る');

  // 明示指定でも採用しない
  const r = refs.resolveSourceForTopic({
    source_provenance: 'explicit', source_url: overview, tax_domain: 'consumption_tax' });
  assert(r.url !== overview, '明示指定されても総論ページは採用しない');
}

console.log('');
console.log('=== 4. 論点語の受け取り方 ===');
{
  assert(parseTerms('{"tax_terms":["前受金","資産の譲渡等の時期"]}').length === 2, '正常なJSONから2語を取り出す');
  assert(parseTerms('前置き\n{"tax_terms":["前受金"]}\n後書き')[0] === '前受金', '前後に文が付いていても取り出せる');
  assert(parseTerms('壊れたJSON').length === 0, '壊れた出力は空にする（生成は止めない）');
  assert(parseTerms('{"tax_terms":[]}').length === 0, '該当なしは空のまま');
  assert(parseTerms('{"tax_terms":["消費税","課税"]}').length === 0,
    '一般的すぎる語だけなら採用しない（出典探しの役に立たない）');
  assert(parseTerms('{"tax_terms":["消費税","前受金"]}').length === 2,
    '一般語が混じっていても具体的な語があれば採用する');
  assert(parseTerms('{"tax_terms":["a","b","c","d","e","f"]}').length === 4, '多すぎる場合は4語まで');
  assert(TOO_GENERIC.has('消費税') && !TOO_GENERIC.has('前受金'), '一般的すぎる語の判定');
  assert(buildUserPrompt({ tax_domain: 'consumption_tax', primary_question: 'Q' }).includes('Q'),
    '企画の内容がプロンプトに入る');
}

console.log('');
console.log('=== 5. 従来の動きを壊していないこと ===');
{
  // 対応表で確定済みの論点は、論点語があってもなくても同じ出典に解決される
  const a = refs.resolveSourceForTopic({ pain_point: 'content-course-bundle', tax_domain: 'consumption_tax' });
  const b = refs.resolveSourceForTopic({ pain_point: 'content-course-bundle', tax_domain: 'consumption_tax', tax_terms: '前受金' });
  assert(a.provenance === 'curated' && a.url === b.url, '対応表で確定した出典は論点語に影響されない');

  // 珍しさ表が壊れていても落ちない
  M.setTokenDfForTest(null);
  const noDf = M.rankSources(ACCIDENT, { limit: 5 }).candidates || [];
  assert(noDf.length === 5, '珍しさ表が無くても候補は返る');
  M.setTokenDfForTest(undefined);

  const restored = M.rankSources(ACCIDENT, { limit: 5 }).candidates || [];
  assert(restored.length === 5, '表を戻しても候補は返る');
  assert(M.rankSources({}, { limit: 5 }).candidates.length === 0, '税目が無いトピックは従来どおり候補なし');
}

console.log('');
console.log(`=== 結果 ===`);
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
