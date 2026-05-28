'use strict';

/**
 * title-builder / title-lint のテスト。
 *   node scripts/lib/__tests__/test-title-builder.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { buildTitle } = require(path.join(ROOT, 'scripts/lib/title-builder'));
const { lintTitle, lintAll } = require(path.join(ROOT, 'scripts/lib/title-lint'));
const { expandAll, expandInheritance } = require(path.join(ROOT, 'scripts/lib/scenario-expansion'));

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. title-lint: 禁止フレーズを検出 ───────────────────────────
console.log('\n=== Test 1: 禁止フレーズの検出 ===');
{
  const r1 = lintTitle('〇〇に押さえる××の基本');
  assert(r1.fails.length > 0, '"に押さえる" は fail');
  const r2 = lintTitle('〇〇が直面するに××');
  assert(r2.fails.length > 0, '"が直面するに" は fail');
  const r3 = lintTitle('判断を判断する');
  assert(r3.fails.length > 0, '"判断を判断" は fail');
  const r4 = lintTitle('基本の基本');
  assert(r4.fails.length > 0, '"基本の基本" は fail');
  const r5 = lintTitle('{procedure} の手順');
  assert(r5.fails.length > 0, '未充足プレースホルダは fail');
}

// ── 2. title-lint: 通常タイトルは pass ──────────────────────────
console.log('\n=== Test 2: 自然なタイトルは fail/warn なし ===');
{
  const natural = [
    '自宅を相続したとき小規模宅地等の特例は使える？｜初動を整理',
    '相続で銀行口座が凍結されたらどうする？｜初動を整理',
    'メルカリの売上は確定申告が必要？｜判断ポイント',
    'YouTube収益は事業所得か雑所得か？｜判断の整理',
  ];
  for (const t of natural) {
    const r = lintTitle(t, { macro: '相続贈与' });
    assert(r.fails.length === 0, `pass: "${t}"`);
  }
}

// ── 3. title-lint: 長すぎる title は fail/warn ──────────────────
console.log('\n=== Test 3: 長さチェック ===');
{
  const tooLong = 'あ'.repeat(85);
  const r = lintTitle(tooLong);
  assert(r.fails.some(f => /長すぎ/.test(f)), '85字は fail');
  const slightlyLong = 'あ'.repeat(73);
  const r2 = lintTitle(slightlyLong);
  assert(r2.warns.some(w => /やや長い/.test(w)), '73字は warn');
}

// ── 4. buildTitle: 相続 × 自宅 × 小規模宅地等 ───────────────────
console.log('\n=== Test 4: 相続のタイトル生成 ===');
{
  const t1 = buildTitle({
    macro: '相続贈与', article_type: 'basic_explainer',
    life_stage: 'within-10months', asset_type: 'home',
    pain_point: 'small-residential-land',
  });
  assert(/自宅/.test(t1) && /小規模宅地等/.test(t1), `lead に自宅と小規模宅地等が含まれる: "${t1}"`);
  assert(!/に押さえる/.test(t1), '"に押さえる" を含まない');

  const t2 = buildTitle({
    macro: '相続贈与', article_type: 'filing_practice',
    life_stage: 'critical-immediate', asset_type: 'cash-deposits',
    pain_point: 'bank-frozen',
  });
  assert(/銀行口座/.test(t2) && /凍結/.test(t2), `銀行凍結の文脈が含まれる: "${t2}"`);

  const t3 = buildTitle({
    macro: '相続贈与', article_type: 'filing_practice',
    life_stage: 'within-4months', heir_role: 'sole-proprietor-family',
    pain_point: 'funeral-debt-deduction', procedure_stage: 'quasi-final-return',
  });
  assert(/個人事業主が亡くなった/.test(t3) || /準確定申告/.test(t3),
    `個人事業主の遺族 × 準確定の文脈: "${t3}"`);
}

// ── 5. buildTitle: 物販 ────────────────────────────────────────
console.log('\n=== Test 5: 物販のタイトル生成 ===');
{
  const t1 = buildTitle({
    macro: '物販', article_type: 'basic_explainer',
    cluster: 'yahoo-auction', platform_id: 'yahoo-auction',
    business_stage: 'just-opened', pain_point: 'consumption-tax-judgement',
  });
  assert(/ヤフオク/.test(t1) && /消費税/.test(t1) && /課税事業者/.test(t1),
    `物販タイトル自然: "${t1}"`);
  assert(!/に押さえる/.test(t1), '"に押さえる" を含まない');

  const t2 = buildTitle({
    macro: '物販', article_type: 'filing_practice',
    cluster: 'shopify', platform_id: 'shopify',
    pain_point: 'overseas-tax-uncertain',
  });
  assert(/Shopify/.test(t2) && /海外/.test(t2), `Shopify × 海外: "${t2}"`);
}

// ── 6. buildTitle: インフルエンサー ────────────────────────────
console.log('\n=== Test 6: インフルエンサーのタイトル生成 ===');
{
  const t = buildTitle({
    macro: 'インフルエンサー', article_type: 'basic_explainer',
    cluster: 'youtube', channel_id: 'youtube',
    pain_point: 'income-classification',
  });
  assert(/YouTube/.test(t) && /事業所得/.test(t) && /雑所得/.test(t), `自然: "${t}"`);
}

// ── 7. buildTitle: サロン ──────────────────────────────────────
console.log('\n=== Test 7: サロンのタイトル生成 ===');
{
  const t = buildTitle({
    macro: 'サロン', article_type: 'basic_explainer',
    cluster: 'nail-salon', salon_id: 'nail-salon',
    pain_point: 'expense-grayzone',
  });
  assert(/ネイルサロン/.test(t) && /経費/.test(t), `自然: "${t}"`);
}

// ── 8. Pattern C 切替後: expanded topics の title は空文字 ─────────
// 以前は title-builder で生成したタイトルが入っていたが、現在は
// 本文 LLM が生成するため、scenario-expansion 段階では空文字。
console.log('\n=== Test 8: expanded topics の title は空（LLM 生成のため）===');
{
  const topics = expandAll();
  const nonEmpty = topics.filter(t => t.title && t.title.length > 0);
  assert(nonEmpty.length === 0, `全 ${topics.length} 件で title が空（Pattern C）`);
}

// ── 9. 要求された相続サンプルの組み合わせが存在する ──────────────
// title の中身は LLM 任せだが、軸の組み合わせとしてのトピックは
// scenario-expansion が正しく生成しているか（slug/cluster/pain_point 等で確認）。
console.log('\n=== Test 9: 要求された相続サンプルの組み合わせが存在 ===');
{
  const inh = expandInheritance();
  const cases = [
    ['10か月×自宅×小規模宅地等', t => t.life_stage==='within-10months' && t.asset_type==='home' && t.pain_point==='small-residential-land'],
    ['10か月×賃貸不動産×評価', t => t.life_stage==='within-10months' && t.asset_type==='rental-property' && t.pain_point==='real-estate-valuation'],
    ['4か月×個人事業主の遺族×準確定', t => t.life_stage==='within-4months' && t.subcluster.includes('sole-proprietor-family')],
    ['逝去直後×預金×銀行凍結', t => t.life_stage==='critical-immediate' && t.asset_type==='cash-deposits' && t.pain_point==='bank-frozen'],
    ['生前準備×名義預金', t => t.life_stage==='pre-planning' && t.asset_type==='name-deposits'],
    ['二次相続×配偶者', t => t.life_stage==='second-inheritance' && t.subcluster.includes('spouse-')],
    ['会社オーナー×自社株', t => t.subcluster.includes('business-owner-family') && t.pain_point==='company-shares-valuation'],
    ['子なし夫婦×相続人確認', t => t.subcluster.includes('no-child-couple') && t.pain_point==='heir-confirmation'],
  ];
  for (const [label, pred] of cases) {
    const m = inh.find(pred);
    assert(!!m, `${label} の軸組み合わせが存在 (slug=${m && m.slug})`);
  }
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
