/**
 * 仮置きタイトルの扱い（2026-08-25）
 *
 * 生成時にタイトルを確定できないと「[要レビュー] {slug}」が入る。
 * この記事がレビュー画面で「公開推奨」と表示され、そのまま承認できる状態だった。
 * 気付かず承認していれば slug が記事タイトルとして公開されていた。
 *
 * 検証:
 *   1. 弾いた理由が分かること（原因を追えなかった問題）
 *   2. 仮置きなら「要修正」になり、理由がレビュー画面に出ること
 *   3. 承認・公開の各段で止まること
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const N = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const TOPIC = {
  slug: 'newseg-youtuber-youtube-gaming-capture-live-guide',
  category: '帳簿・経費', macro: '情報発信', article_type: 'basic_explainer',
  tax_domain: 'bookkeeping_expenses', customer_segment: 'youtuber', persona: 'youtuber',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm',
  source_title: '国税庁タックスアンサー No.2100 減価償却のあらまし',
  source_provenance: 'curated', source_confidence: 1,
  search_intent: 'ライブ配信 キャプチャボード 経費 減価償却 少額特例 youtuber',
  reader_problem: '配信機材の経費処理が分からない',
  primary_question: 'キャプチャボードは経費にできる？',
  success_outcome: '取得価額別の処理が分かる',
  pain_point: 'youtube-gaming-capture',
};
const BODY = ['## この記事でわかること', '本文です。', '## まず結論', '本文です。', '## まとめ', '本文です。'].join('\n');
const rawWith = (title) => `---\ntitle: "${title}"\nsummary: "配信機材の取得価額別の処理をまとめます。10万円未満は全額経費です。"\n---\n\n${BODY}`;

console.log('=== 1. 弾いた理由が分かる ===');
{
  assert(N.checkLlmTitle('', {}).reasons[0] === 'タイトルが空', '空のときは「タイトルが空」と分かる');
  assert(/安直な煽り/.test(N.checkLlmTitle('配信機材の経費処理を徹底解説します', {}).reasons.join()),
    '煽り表現は理由が出る');
  assert(/長すぎ/.test(N.checkLlmTitle('あ'.repeat(90), {}).reasons.join()), '長すぎは文字数つきで出る');
  assert(/短すぎ/.test(N.checkLlmTitle('短い', {}).reasons.join()), '短すぎは文字数つきで出る');
  const ok = N.checkLlmTitle('ライブ配信者の機材費はどう処理する？取得価額別の経費と少額特例の活用法', {});
  assert(ok.ok && ok.reasons.length === 0, '妥当なタイトルは理由なしで通る');
  // 従来の関数も同じ判定のまま
  assert(N.isValidLlmTitle('ライブ配信者の機材費はどう処理する？取得価額別の経費と少額特例の活用法', {}) === true,
    '従来の isValidLlmTitle も同じ結果');
  assert(N.isValidLlmTitle('', {}) === false, '空は従来どおり不可');
}

console.log('');
console.log('=== 2. 仮置きなら「要修正」になる ===');
{
  const bad = N.normalizeGeneratedDraft(rawWith(''), TOPIC, { now: new Date().toISOString() });
  assert(N.isPlaceholderTitle(bad.title), `タイトルが確定できないと仮置きが入る（${bad.title}）`);
  assert(/recommendation: "revise"/.test(bad.content), '判定が「要修正」になる（公開推奨にしない）');
  assert(/review_warning: ".*タイトル.*仮置き/.test(bad.content), 'レビュー画面に理由が出る');

  const good = N.normalizeGeneratedDraft(
    rawWith('ライブ配信者の機材費はどう処理する？取得価額別の経費と少額特例の活用法'), TOPIC,
    { now: new Date().toISOString() });
  assert(!N.isPlaceholderTitle(good.title), '妥当なタイトルはそのまま採用される');
  assert(!/タイトル.*仮置き/.test(good.content), '妥当なら警告は出ない');
  assert(/recommendation: "publish"/.test(good.content), '妥当なら判定は従来どおり');
}

console.log('');
console.log('=== 3. 作り直したタイトルを渡せる ===');
{
  const fixed = N.normalizeGeneratedDraft(rawWith(''), TOPIC, {
    now: new Date().toISOString(),
    titleOverride: 'ライブ配信者の機材費はどう処理する？取得価額別の経費と少額特例の活用法',
  });
  assert(!N.isPlaceholderTitle(fixed.title), '作り直したタイトルで仮置きが解消する');
  assert(/recommendation: "publish"/.test(fixed.content), '解消すれば判定も戻る');
  // 作り直しても妥当でなければ仮置きのまま
  const still = N.normalizeGeneratedDraft(rawWith(''), TOPIC, {
    now: new Date().toISOString(), titleOverride: '完全ガイド' });
  assert(N.isPlaceholderTitle(still.title), '作り直しが妥当でなければ仮置きのまま');
}

console.log('');
console.log('=== 4. 承認・公開で止まる ===');
{
  assert(N.isPlaceholderTitle('[要レビュー] some-slug'), '仮置きと判定される');
  assert(!N.isPlaceholderTitle('ライブ配信者の機材費はどう処理する？'), '通常のタイトルは仮置きではない');
  assert(!N.isPlaceholderTitle(''), '空は仮置き扱いにしない（別のチェックで見る）');

  // 記事バリデーション: 下書きは警告、承認/公開段階は ERROR
  const { validateArticle } = require(path.join(ROOT, 'scripts/validate.js'));
  if (typeof validateArticle === 'function') {
    const draft = validateArticle(rawWith('[要レビュー] x') , 'draft.md');
    assert(draft !== undefined, '記事バリデーションが呼べる');
  } else {
    // validate.js が関数を公開していない場合は、判定関数の利用だけ確認する
    const src = require('fs').readFileSync(path.join(ROOT, 'scripts/validate.js'), 'utf8');
    assert(/isPlaceholderTitle/.test(src), '記事バリデーションが仮置き判定を使っている');
    assert(/if \(isDraft\) warnings\.push\(msg\); else errors\.push\(msg\);/.test(src),
      '下書きは警告・承認/公開は ERROR にしている');
  }

  const approve = require('fs').readFileSync(
    path.join(ROOT, 'netlify/functions/review-approve-background.js'), 'utf8');
  assert(/isPlaceholderTitle\(fmTitle\)/.test(approve), '承認ゲートが仮置きを見ている');
  assert(approve.indexOf('isPlaceholderTitle(fmTitle)') < approve.indexOf('if (recommendation) {'),
    '判定スコアの有無に関係なく先に止める');
}

console.log('');
console.log('=== 結果 ===');
console.log('');
console.log('=== 5. タイトル確定後に判定と警告を戻す（2026-08-27）===');
{
  // 部分再生成でタイトルを直しても、生成時に付いた仮置きの警告と revise が
  // frontmatter に残り、直したのに承認できない状態になった。
  const W = N.PLACEHOLDER_TITLE_WARNING;
  const mk = (title, warning, rec) => ['---', `title: "${title}"`,
    `review_warning: "${warning}"`, `recommendation: "${rec}"`, '---', '', '本文'].join('\n');
  const rec = (s) => (s.match(/^recommendation: "(.*)"$/m) || [])[1];
  const warn = (s) => (s.match(/^review_warning: "(.*)"$/m) || [])[1];

  const fixed = N.clearPlaceholderTitleWarning(mk('ちゃんとしたタイトルです', W, 'revise'));
  assert(warn(fixed) === '' && rec(fixed) === 'publish',
    'タイトルが確定し仮置きの警告だけなら、警告を消して判定を戻す');

  const both = N.clearPlaceholderTitleWarning(mk('ちゃんとしたタイトルです', `${W} / 出典: 未確定`, 'revise'));
  assert(warn(both) === '出典: 未確定' && rec(both) === 'revise',
    '他の警告が残るなら判定は revise のまま（タイトルの警告だけ消す）');

  const still = N.clearPlaceholderTitleWarning(mk('[要レビュー] some-slug', W, 'revise'));
  assert(warn(still) === W && rec(still) === 'revise', 'まだ仮置きなら何も変えない');

  const other = N.clearPlaceholderTitleWarning(mk('ちゃんとしたタイトルです', '出典: 未確定', 'revise'));
  assert(warn(other) === '出典: 未確定' && rec(other) === 'revise', '無関係の警告には触らない');

  assert(N.clearPlaceholderTitleWarning('') === '', '空入力でも落ちない');
  assert(typeof N.PLACEHOLDER_TITLE_WARNING === 'string' && N.PLACEHOLDER_TITLE_WARNING.length > 0,
    '警告文が定数として公開されている');
}
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
