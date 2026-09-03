'use strict';
/**
 * 記事の時間軸が「いま」に合っているか（2026-09-03）
 *
 * 何が起きたか:
 *   令和8年9月に生成した2記事が、どちらも令和7年分を「現在」として書いた。
 *   令和8年分は「これから引き上げられる予定です」と未来形になっていた。
 *
 * なぜ起きたか:
 *   生成プロンプトに今日の日付を一切渡していなかった。LLM は学習時点の年を
 *   基準に書くしかなく、年分がまるごと1年ずれた。
 *
 * なぜ金額まで壊れるか:
 *   年分を取り違えると、年分ごとに違う金額を平気で書く。実際に同じ日の2記事で
 *     ・基礎控除「48万円（令和7年分）」（48万円は令和6年分以前の金額）
 *     ・「103万円の壁（給与所得控除65万円＋所得58万円）」（足すと123万円。
 *       103万円は令和6年分以前の 55万＋48万）
 *   が出ている。時間軸は金額の正しさに直結する。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { currentTaxPeriod, buildTaxPeriodBlock, toReiwa } =
  require(path.join(ROOT, 'scripts/lib/current-tax-period'));
const { buildDynamicGenerationBlock } =
  require(path.join(ROOT, 'scripts/lib/article-prompt-builder'));
const { STATIC_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

console.log('=== 1. 西暦から令和を求める ===');
{
  assert(toReiwa(2019) === 1, '2019年は令和1年');
  assert(toReiwa(2026) === 8, '2026年は令和8年（今回ずれた年）');
  assert(toReiwa(2027) === 9, '2027年は令和9年');
  assert(toReiwa(2018) === null, '令和より前は扱わない');
}

console.log('');
console.log('=== 2. いま進行中の年分を返す ===');
{
  // 今回の事故が起きた日
  const p = currentTaxPeriod(new Date('2026-09-03T04:00:00Z'));
  assert(p.currentTaxYearReiwa === 8, 'いま稼いでいる分は令和8年分');
  assert(p.previousTaxYearReiwa === 7, 'ひとつ前は令和7年分');
  assert(p.currentFilingYearReiwa === 9, '令和8年分の申告は令和9年');
  assert(p.inFilingSeason === false, '9月は申告期間ではない');
  assert(p.today.year === 2026 && p.today.month === 9 && p.today.day === 3,
    '今日の日付を JST で持つ');
}

console.log('');
console.log('=== 3. 確定申告期間の最中は2つの年分が併存する ===');
{
  // 2月は「令和8年分を申告しつつ、令和9年分を稼いでいる」時期
  const p = currentTaxPeriod(new Date('2027-02-20T04:00:00Z'));
  assert(p.inFilingSeason === true, '2月は申告期間の最中');
  assert(p.currentTaxYearReiwa === 9, '稼いでいる分は令和9年分');
  assert(p.previousTaxYearReiwa === 8, '申告している分は令和8年分');

  const after = currentTaxPeriod(new Date('2027-03-16T04:00:00Z'));
  assert(after.inFilingSeason === false, '3月16日は期限を過ぎている');
  const onDeadline = currentTaxPeriod(new Date('2027-03-15T04:00:00Z'));
  assert(onDeadline.inFilingSeason === true, '3月15日当日はまだ期限内');
}

console.log('');
console.log('=== 4. JST で日付が変わる ===');
{
  // UTC 2026-09-02 16:00 は JST では 9/3 の 01:00
  const p = currentTaxPeriod(new Date('2026-09-02T16:00:00Z'));
  assert(p.today.day === 3, 'UTC夕方は JST では翌日');
}

console.log('');
console.log('=== 5. 壊れた日付でも落ちない ===');
{
  assert(currentTaxPeriod(undefined).currentTaxYear >= 2026, '未指定なら現在時刻');
  assert(currentTaxPeriod('こわれた日付').currentTaxYear >= 2026, '不正文字列でも落ちない');
  // 呼び出し側は now を ISO 文字列で持ち回っている
  const s = currentTaxPeriod('2026-09-03T04:00:00.000Z');
  assert(s.currentTaxYearReiwa === 8, 'ISO文字列でも受けられる');
}

console.log('');
console.log('=== 6. プロンプトのブロックに「いま」が入る ===');
{
  const block = buildTaxPeriodBlock(new Date('2026-09-03T04:00:00Z'));
  assert(/2026年9月3日（令和8年）/.test(block), '今日の日付が和暦つきで入る');
  assert(/いま進行中の年分は令和8年分/.test(block), 'いまの年分を明示する');
  assert(/令和9年（2027年）2月16日〜3月15日/.test(block), '申告時期を示す');
  assert(/すでに申告が終わった年分/.test(block), '前年分が過去だと示す');
  assert(/学習時点の年ではなく/.test(block), '学習時点の年を使わないよう指示する');
  assert(/引き上げられる予定です/.test(block), '今回の誤り方を例として挙げている');
  assert(/事業年度/.test(block), '法人は年分ではないと注意している');

  const inSeason = buildTaxPeriodBlock(new Date('2027-02-20T04:00:00Z'));
  assert(/確定申告期間の最中/.test(inSeason), '申告期間中はその旨を書く');
  assert(/書き分けること/.test(inSeason), '2つの年分の書き分けを指示する');
}

console.log('');
console.log('=== 7. 実際に生成プロンプトへ渡る ===');
{
  const dyn = buildDynamicGenerationBlock({
    topic: { slug: 't', category: '所得税', macro: '税目実務' },
    persona: { label: '一人親方' },
    cta: 'ご相談ください',
    articleType: 'basic_explainer',
    articleRole: 'main',
    now: '2026-09-03T04:00:00.000Z',
  });
  assert(/令和8年/.test(dyn), '可変ブロックに令和8年が入る');
  assert(dyn.indexOf('いま何年か') < dyn.indexOf('この記事の可変条件'),
    '可変条件より前に置かれる（先に読ませる）');

  // 日付を渡さなくても落ちない（既存の呼び出しを壊さない）
  const noDate = buildDynamicGenerationBlock({
    topic: { slug: 't' }, persona: { label: 'x' }, cta: '',
    articleType: 'basic_explainer', articleRole: 'main',
  });
  assert(/いま何年か/.test(noDate), '日付未指定でもブロックは入る');
}

console.log('');
console.log('=== 8. 固定ルールに年分の方針がある ===');
{
  assert(/年分・年度の書き方/.test(STATIC_RULES), '年分の方針が固定ルールにある');
  assert(/学習時点の年を「現在」だと思い込まない/.test(STATIC_RULES),
    '学習時点の年を使わないよう指示している');
  assert(/未来形で書かないこと/.test(STATIC_RULES),
    '適用済みの年分を未来形で書く誤りを禁止している');
  // 固定ルールは prompt caching の対象。日付そのものが入るとキャッシュが毎日壊れる
  assert(!/2026年9月|令和8年9月/.test(STATIC_RULES),
    '固定ルールに具体的な今日の日付は入れない（キャッシュを壊さない）');
}

console.log('');
console.log('=== 9. 基礎控除・給与所得控除が令和8年分に対応している ===');
{
  // 今回の誤りの直接の原因。48万円/103万円が「いまの値」として残っていた
  assert(/令和8年分・令和9年分/.test(STATIC_RULES), '令和8年分の基礎控除が入っている');
  assert(/489万円以下=<strong>104万円<\/strong>/.test(STATIC_RULES),
    '令和8年分の基礎控除104万円が入っている');
  assert(/「一律48万円」は令和6年分までの値/.test(STATIC_RULES),
    '48万円が過去の値だと明示している');
  assert(/令和8年分=<strong>74万円<\/strong>/.test(STATIC_RULES),
    '令和8年分の給与所得控除の最低保障74万円が入っている');
  assert(/「103万円の壁」は令和6年分以前の数字/.test(STATIC_RULES),
    '103万円が過去の値だと明示している');
  assert(/足し算が合わない数字を書かないこと/.test(STATIC_RULES),
    '壁の金額を検算するよう指示している');
  assert(!/令和9年分以後は合計所得2,350万円以下で一律58万円に戻る/.test(STATIC_RULES),
    '令和8年度改正前の古い記述が消えている');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
