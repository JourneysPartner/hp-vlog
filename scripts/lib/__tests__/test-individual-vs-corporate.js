'use strict';
/**
 * 個人（所得税）と法人（法人税）で扱いが違う論点（2026-08-29）
 *
 * 美容サロンオーナー（個人事業主）向けの「固定資産の取得価額」の記事に、
 * 法人税のタックスアンサー No.5400 だけが出典として割り当てられ、
 * 記事全体が法人税の基準で書かれた。
 *
 * 登録免許税は、法人では「取得価額に算入しないことができる」（任意）だが、
 * 個人では所基通49-3 により資産の種類ごとに扱いが分かれ、
 * 特許権・鉱業権のように登録により権利が発生する資産は逆に「算入する」。
 * 建物等は「算入しない」で、そもそも任意ではない。
 *
 * 法人が対象の記事を書くこと自体は問題ない。問題は片方の税目だけで書いて
 * もう片方の読者に誤った基準を示すこと。扱いが分かれる論点では両方を書かせる。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { CONDITIONAL_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));
const { findProvision } = require(path.join(ROOT, 'scripts/lib/nta-tsutatsu'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const rule = CONDITIONAL_RULES.individual_vs_corporate_treatment;

console.log('=== 1. ルールが必要な記事で発火する ===');
{
  assert(!!rule, 'ルールが登録されている');
  assert(rule.match({ search_intent: '固定資産 取得価額 付随費用 判定' }),
    '取得価額の記事で発火する（今回の事故の記事）');
  assert(rule.match({ primary_question: '登録免許税は取得価額に含める？' }), '登録免許税で発火する');
  assert(rule.match({ reader_problem: '不動産取得税の処理が分からない' }), '不動産取得税で発火する');
  assert(rule.match({ search_intent: '減価償却 サロン 機器' }), '減価償却で発火する');
  assert(rule.match({ search_intent: '役員報酬 決め方' }), '個人・法人で差がある他の論点でも発火する');
  assert(!rule.match({ search_intent: '相続税 いくらから 基礎控除' }),
    '無関係な論点では発火しない');
}

console.log('');
console.log('=== 2. 個人と法人の違いが正しく書かれている ===');
{
  // 所基通49-3 の3区分がそのまま入っていること
  assert(/特許権、鉱業権/.test(rule.text), '登録により権利が発生する資産の例が入っている');
  assert(/船舶、航空機、自動車/.test(rule.text), '登録を要する資産の例が入っている');
  assert(/算入する<\/strong>（法人と逆/.test(rule.text),
    '特許権等は個人では算入する（法人と逆）と明示している');
  assert(/算入しない<\/strong>（任意ではない）/.test(rule.text),
    '建物等は個人では任意ではないと明示している');
  assert(/必要経費に算入する/.test(rule.text), '所基通37-5 の必要経費算入が入っている');
  assert(/算入しないことができる<\/strong>（任意）/.test(rule.text),
    '法人側は任意であることが明示されている');

  // 通達番号が実在すること（記憶で書いていないか）
  assert(!!findProvision('49-3', 'shotoku'), '所基通49-3 が通達カタログに実在する');
  assert(!!findProvision('37-5', 'shotoku'), '所基通37-5 が通達カタログに実在する');
  assert(!!findProvision('7-3-3の2', 'hojin'), '法基通7-3-3の2 が通達カタログに実在する');
}

console.log('');
console.log('=== 3. 書き方の指示が入っている ===');
{
  assert(/両方|並べて示す/.test(rule.text), '両方の扱いを書くよう指示している');
  assert(/判定の列を1つにせず/.test(rule.text), '表を1つの判定列にまとめないよう指示している');
  assert(/❌/.test(rule.text) && /個人事業主向けに断定すること/.test(rule.text),
    '禁止表現として「法人の基準で個人向けに断定」を挙げている');
  assert(/法人が対象|法人の場合は/.test(rule.text),
    '法人向けに書くこと自体は禁じていない（対象を明示すればよい）');
}

console.log('');
console.log('=== 4. 通達原文との整合 ===');
{
  // ルールに書いた区分が、実際の所基通49-3 の原文と食い違っていないこと
  const p = findProvision('49-3', 'shotoku');
  const body = String((p && (p.text || p.body)) || '');
  assert(/取得価額に算入する/.test(body), '原文にも「取得価額に算入する」がある');
  assert(/算入しないことができる/.test(body), '原文にも「算入しないことができる」がある');
  assert(/取得価額に算入しない。/.test(body), '原文にも「取得価額に算入しない」がある');

  const p375 = findProvision('37-5', 'shotoku');
  assert(/必要経費に算入する/.test(String((p375 && (p375.text || p375.body)) || '')),
    '所基通37-5 の原文に必要経費算入がある');
}

console.log('');
console.log('=== 結果 ===');
console.log('');
console.log('=== 5. 再生成で frontmatter の管理項目が失われない ===');
{
  // 2026-08-29: 同じ記事の差し戻しで、適合スコア・recommendation・分類など
  // 15項目が失われ、レビュー画面に判定が出ない状態になった。
  const { restoreMissingSystemFields, SYSTEM_MANAGED_FIELDS } =
    require(path.join(ROOT, 'scripts/lib/source-guard'));
  const N = String.fromCharCode(10);
  const before = ['---', 'title: "旧タイトル"', 'slug: "s"', 'macro: "帳簿・経費"',
    'customer_fit_score: 5', 'source_alignment_score: 5', 'recommendation: "publish"',
    'review_warning: ""', 'customer_segment: "beauty_salon"', '---', '', '旧本文'].join(N);
  const after = ['---', 'title: "新タイトル"', 'slug: "s"', '---', '', '新本文'].join(N);

  const r = restoreMissingSystemFields(before, after);
  assert(r.restored.includes('recommendation'), '判定（recommendation）が復元される');
  assert(r.restored.includes('customer_fit_score') && r.restored.includes('source_alignment_score'),
    '適合スコアが復元される');
  assert(r.restored.includes('macro') && r.restored.includes('customer_segment'),
    '分類（macro / customer_segment）が復元される');
  assert(/^title: "新タイトル"$/m.test(r.content), '再生成が更新したタイトルは上書きしない');
  assert(/新本文/.test(r.content) && !/旧本文/.test(r.content), '本文は再生成の結果を使う');

  // 欠落が無ければ何もしない
  const intact = restoreMissingSystemFields(before, before);
  assert(intact.restored.length === 0 && intact.content === before,
    '欠落が無ければ内容を変えない');

  // 元に無い項目は補わない
  const thin = ['---', 'title: "t"', '---', '', '本文'].join(N);
  assert(restoreMissingSystemFields(thin, thin).restored.length === 0,
    '元記事にも無い項目は勝手に足さない');

  // frontmatter が無い入力でも落ちない
  assert(restoreMissingSystemFields('', '本文だけ').content === '本文だけ',
    'frontmatter が無くても落ちない');

  assert(SYSTEM_MANAGED_FIELDS.includes('review_status') && !SYSTEM_MANAGED_FIELDS.includes('summary'),
    '管理項目だけを対象にし、記事の内容（summary 等）は対象外');
}
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
