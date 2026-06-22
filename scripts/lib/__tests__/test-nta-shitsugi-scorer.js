'use strict';

/**
 * 質疑応答事例 スコアラのテスト
 *   node scripts/lib/__tests__/test-nta-shitsugi-scorer.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const scorer = require(path.join(ROOT, 'scripts/lib/nta-shitsugi-scorer'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. scorePersonaMatch ─────────────────────────────────────
console.log('\n=== Test 1: scorePersonaMatch ===');
{
  // 消費税 × EC キーワード豊富 → domestic_ec_seller スコア高
  const entry = {
    tax_category_code: 'shohi',
    title: 'Amazon の販売手数料の取扱い',
    body_combined: 'EC セラーが Amazon で販売する場合の消費税の取扱い。物販事業として継続的に行われる場合は課税対象となります。',
  };
  const r = scorer.scorePersonaMatch(entry);
  assert(r.persona === 'domestic_ec_seller',
    `persona=domestic_ec_seller (実: ${r.persona})`);
  assert(r.score >= 30, `score >= 30 (実: ${r.score})`);
  assert(r.macro === '物販', `macro=物販`);

  // 相続税 → inheritance_client
  const r2 = scorer.scorePersonaMatch({
    tax_category_code: 'sozoku',
    title: '配偶者の遺産分割',
    body_combined: '配偶者が相続した不動産の評価について',
  });
  assert(r2.persona === 'inheritance_client', `相続税 → inheritance_client`);
  assert(r2.score >= 30, `相続 score >= 30`);

  // 該当税目なし
  const r3 = scorer.scorePersonaMatch({ tax_category_code: 'unknown' });
  assert(r3.score === 0, `不明税目 → 0 点`);
}

// ── 2. scoreSearchNeed ─────────────────────────────────────
console.log('\n=== Test 2: scoreSearchNeed ===');
{
  // タイトルに高ニーズキーワード → 20 点
  const r1 = scorer.scoreSearchNeed({
    title: '確定申告における経費の取扱い',
    body_combined: '',
  });
  assert(r1 === 20, `title 高ニーズ → 20 (実: ${r1})`);

  // 中ニーズキーワードのみ
  const r2 = scorer.scoreSearchNeed({
    title: '取扱の判定について',
    body_combined: '',
  });
  assert(r2 >= 10 && r2 <= 15, `中ニーズ → 10-15 (実: ${r2})`);

  // 低ニーズ
  const r3 = scorer.scoreSearchNeed({
    title: '通則の規定',
    body_combined: '',
  });
  assert(r3 <= 5, `低ニーズ → <= 5 (実: ${r3})`);

  // 空
  const r4 = scorer.scoreSearchNeed({});
  assert(r4 === 5, `空入力 → ベースライン 5`);
}

// ── 3. scoreFreshness ────────────────────────────────────────
console.log('\n=== Test 3: scoreFreshness ===');
{
  // 令和7 (= currentYearReiwa=7) → 当年 = 10
  assert(scorer.scoreFreshness({ law_version: '令和7年8月1日現在の法令・通達等' }, 7) === 10,
    '令和7年 (当年) → 10');
  // 令和6年 → diff=1 → 9
  assert(scorer.scoreFreshness({ law_version: '令和6年4月1日現在' }, 7) === 9,
    '令和6年 → 9');
  // 令和4年 → diff=3 → 5
  assert(scorer.scoreFreshness({ law_version: '令和4年4月1日現在' }, 7) === 5,
    '令和4年 → 5');
  // 平成 → 2
  assert(scorer.scoreFreshness({ law_version: '平成30年4月1日現在' }, 7) === 2,
    '平成 → 2');
  // 不明
  assert(scorer.scoreFreshness({ law_version: '' }, 7) === 5,
    '空 → 5');
}

// ── 4. scoreAmbiguity ───────────────────────────────────────
console.log('\n=== Test 4: scoreAmbiguity ===');
{
  // 「総合的に判断」を含む
  const r1 = scorer.scoreAmbiguity({
    body_combined: 'これは事業に該当するかどうか総合的に判断する必要があります。',
  });
  assert(r1 >= 8, `総合的に判断 → 8+ (実: ${r1})`);

  // 「事実関係による」
  const r2 = scorer.scoreAmbiguity({
    body_combined: '判断は事実関係による',
  });
  assert(r2 >= 8, `事実関係による → 8+ (実: ${r2})`);

  // 中レベル
  const r3 = scorer.scoreAmbiguity({
    body_combined: 'ケースによる判断が必要',
  });
  assert(r3 >= 4 && r3 < 8, `ケースによる → 4-7 (実: ${r3})`);

  // 曖昧表現なし
  const r4 = scorer.scoreAmbiguity({ body_combined: '明確に課税対象です。' });
  assert(r4 === 0, `曖昧表現なし → 0 (実: ${r4})`);
}

// ── 5. scoreTaxAnswerSupport ────────────────────────────────
console.log('\n=== Test 5: scoreTaxAnswerSupport ===');
{
  // 消費税法 含む → 25
  const r1 = scorer.scoreTaxAnswerSupport({
    kankei_hourei: '消費税法第2条第1項第8号、消費税法基本通達5-1-1',
  });
  assert(r1 === 25, `消費税法あり → 25 (実: ${r1})`);

  // 通達のみ（法令名「所得税法」を含まないので中スコア）
  const r2 = scorer.scoreTaxAnswerSupport({
    kankei_hourei: '所得税基本通達9-12',
  });
  assert(r2 === 10, `通達のみ → 10 (実: ${r2})`);

  // 完全に未マッチ
  const r3 = scorer.scoreTaxAnswerSupport({
    kankei_hourei: '地方税法第1条',
  });
  assert(r3 === 5, `非対象法令 → 5 (実: ${r3})`);

  // 空
  const r4 = scorer.scoreTaxAnswerSupport({ kankei_hourei: null });
  assert(r4 === 0, `null → 0`);
}

// ── 6. scoreEntry: 統合スコア ─────────────────────────────────
console.log('\n=== Test 6: scoreEntry 統合 ===');
{
  // 全項目高スコア → 100 点近い
  const r1 = scorer.scoreEntry({
    tax_category_code: 'shohi',
    title: 'EC セラーが確定申告で経費の判定に迷うケース',
    body_combined: 'Amazon で物販する EC セラーが、経費の取扱いを総合的に判断する場合の事業所得',
    law_version: '令和7年8月1日現在',
    kankei_hourei: '消費税法第2条第1項第8号',
  }, { currentYearReiwa: 7 });
  assert(r1.score >= 80, `全項目高スコア → 80+ (実: ${r1.score})`);
  assert(r1.breakdown.persona_match >= 30, `persona_match >= 30`);
  assert(r1.breakdown.search_need >= 15, `search_need >= 15`);
  assert(r1.breakdown.freshness === 10, `freshness=10`);
  assert(r1.proposed.persona === 'domestic_ec_seller', `proposed.persona=domestic_ec_seller`);

  // 低スコア
  const r2 = scorer.scoreEntry({
    tax_category_code: 'unknown',
    title: '通則',
    body_combined: '明確に決まっています。',
    law_version: '平成20年',
    kankei_hourei: null,
  }, { currentYearReiwa: 7 });
  assert(r2.score < 30, `全項目低スコア → < 30 (実: ${r2.score})`);
}

// ── 7. score 上限 ─────────────────────────────────────────────
console.log('\n=== Test 7: score 上限 ===');
{
  // breakdown の各項目が上限を超えないことを確認
  const r = scorer.scoreEntry({
    tax_category_code: 'shohi',
    title: '経費 課税 控除 申告 インボイス 還付',
    body_combined: 'EC 物販 通信販売 在庫 Amazon 楽天 Yahoo Shopify メルカリ ヤフオク 総合的に判断 事実関係による ケースによる',
    law_version: '令和7年',
    kankei_hourei: '消費税法 所得税法 法人税法',
  });
  assert(r.breakdown.persona_match <= 30, `persona_match <= 30`);
  assert(r.breakdown.search_need <= 20, `search_need <= 20`);
  assert(r.breakdown.freshness <= 10, `freshness <= 10`);
  assert(r.breakdown.judgment_ambiguity <= 15, `judgment_ambiguity <= 15`);
  assert(r.breakdown.taxanswer_support <= 25, `taxanswer_support <= 25`);
  assert(r.score <= 100, `total <= 100`);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
