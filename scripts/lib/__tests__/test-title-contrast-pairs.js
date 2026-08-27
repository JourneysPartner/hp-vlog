'use strict';
/**
 * タイトル判定の対比ペア誤検知（2026-08-27）
 *
 * 「インボイス2割特例はいつまで使える？対象者・期限・3割特例への移行を解説」が
 * 「同一名詞の繰り返し: "割特例" が2回」として弾かれ、作り直しも同じ理由で弾かれて
 * タイトルが仮置きのまま下書きが出た。
 *
 * 制度名を並べて比べるのは記事の主題そのもので、同語反復ではない。
 * 既にあった「課税事業者／免税事業者」の中和を、他の正当な対比にも広げた。
 *
 * あわせて、2割特例と3割特例の対象者を取り違えない再発防止ルールも検証する。
 * （2割特例は個人事業者・法人の両方が対象。個人事業者限定なのは3割特例）
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { lintTitle, CONTRAST_PAIRS } = require(path.join(ROOT, 'scripts/lib/title-lint'));
const { checkLlmTitle } = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));
const { CONDITIONAL_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const ctx = { macro: '税目実務', article_type: 'basic_explainer' };
const ok = (t) => lintTitle(t, ctx).fails.length === 0;

console.log('=== 1. 実際に弾かれたタイトルが通るようになる ===');
{
  assert(ok('インボイス2割特例はいつまで使える？対象者・期限・3割特例への移行を解説'),
    '却下されたタイトル（1回目）が通る');
  assert(ok('インボイス登録者向け2割特例の対象・期間・3割特例まとめ'),
    '却下されたタイトル（2回目・作り直し）が通る');
  assert(checkLlmTitle('インボイス2割特例はいつまで使える？対象者・期限・3割特例への移行を解説', ctx).ok,
    '生成側の判定でも採用される');
}

console.log('');
console.log('=== 2. 他の正当な対比も通る ===');
{
  assert(ok('課税事業者と免税事業者の違いは？判断の基準を解説'), '課税事業者／免税事業者（従来からの中和）');
  assert(ok('本則課税と簡易課税はどちらが有利？判断の手順'), '本則課税／簡易課税');
  assert(ok('白色申告と青色申告の違いを実務目線で整理する'), '白色申告／青色申告');
  assert(ok('相続時精算課税と暦年課税はどちらを選ぶべきか'), '相続時精算課税／暦年課税');
  assert(ok('給与所得と事業所得の区分はどこで判断するのか'), '給与所得／事業所得');
  assert(CONTRAST_PAIRS.some(p => p.includes('２割特例')), '全角の表記ゆれも登録されている');
}

console.log('');
console.log('=== 3. 本来の検知は維持される ===');
{
  assert(!ok('特例の特例について特例を解説する記事'), '本当の同語反復は今までどおり弾く');
  assert(!ok('2割特例の2割特例について解説する記事です'), '片方だけの重複は中和されない');
  assert(!checkLlmTitle('確定申告を徹底解説する記事です', ctx).ok, '安直な煽りは今までどおり弾く（生成側の判定）');
  assert(!ok('あ'.repeat(90)), '長すぎるタイトルは今までどおり弾く');
  // 対比ペアの片方しか無いときは中和しない
  assert(!ok('本則課税と本則課税の違いを整理する'), '対比の片方が揃わなければ中和しない');
}

console.log('');
console.log('=== 4. 2割特例／3割特例の対象者を取り違えない ===');
{
  const rule = CONDITIONAL_RULES.invoice_small_business_special;
  assert(!!rule, 'インボイス小規模事業者の論点別ルールがある');
  assert(rule.match({ tax_domain: 'invoice_system' }), 'インボイスの記事で発火する');
  assert(rule.match({ search_intent: 'インボイス 2割特例 いつまで' }), '検索語からも発火する');
  assert(/個人事業者・法人のどちらも対象/.test(rule.text),
    '2割特例は個人・法人の両方が対象だと明示している');
  assert(/2割特例は法人には適用されない/.test(rule.text),
    '「2割特例は法人に適用されない」を禁止表現として挙げている');
  assert(/法人は適用不可/.test(rule.text), '3割特例が法人不可であることは維持されている');
  // 非対称であること自体が明記されている（引きずられ防止）
  assert(/引きずられて/.test(rule.text), '3割特例に引きずられないよう注意書きがある');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
