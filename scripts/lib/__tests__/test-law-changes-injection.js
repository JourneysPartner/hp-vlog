'use strict';

/**
 * 改正論点の注入条件のテスト。
 *   node scripts/lib/__tests__/test-law-changes-injection.js
 *
 * 2026-08-18: 改正論点は topic.freshness_sensitive が真のトピックにしか
 * 渡していなかったが、フラグが立っているのは 1,800 件中 10 件（1%）だけで、
 * 99% のトピックではこの経路が機能していなかった。
 * 新セグメント由来のトピックは既定 false のため、新しく増えたテーマほど
 * 改正情報が届かないという逆の挙動になっていた。
 * フラグ判定を廃止し、税目・ペルソナの一致だけで渡す。
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const { CHANGES, getChangesForTopic, formatChangesForPrompt } =
  require(path.join(ROOT, 'scripts/lib/tax-law-changes'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. フラグが無くても改正論点が返る ─────────────────────────
console.log('\n=== Test 1: freshness_sensitive が無くても返る ===');
{
  // 実際に取りこぼしていたトピック形（新セグメント由来。フラグ指定なし）
  const noFlag = { tax_domain: 'invoice_system', persona: 'beauty_salon_owner' };
  assert(noFlag.freshness_sensitive === undefined, '前提: フラグは未設定');
  const got = getChangesForTopic(noFlag, 2);
  assert(got.length > 0, `フラグ無しでも改正論点が返る（${got.length} 件）`);

  // フラグの有無で結果が変わらないこと（getChangesForTopic はフラグを見ない）
  const withFlag = { ...noFlag, freshness_sensitive: true };
  assert(getChangesForTopic(withFlag, 2).length === got.length,
    'フラグの有無で結果が変わらない');
  const falseFlag = { ...noFlag, freshness_sensitive: false };
  assert(getChangesForTopic(falseFlag, 2).length === got.length,
    'フラグが false でも同じ結果');
}

// ── 2. 絞り込みは効いている（無関係な改正は返さない）──────────
console.log('\n=== Test 2: 税目・ペルソナで絞り込む ===');
{
  const inv = getChangesForTopic({ tax_domain: 'invoice_system', persona: 'beauty_salon_owner' }, 5);
  assert(inv.every(c => c.tax_domain === 'invoice_system'), '税目が一致するものだけ');

  const inh = getChangesForTopic({ tax_domain: 'inheritance_tax', persona: 'inheritance_client' }, 5);
  assert(inh.every(c => c.tax_domain === 'inheritance_tax'), '相続は相続の改正だけ');
  assert(!inh.some(c => c.tax_domain === 'invoice_system'), '相続にインボイスの改正は混ざらない');

  // ペルソナが一致しなければ返らない
  const wrongPersona = getChangesForTopic(
    { tax_domain: 'inheritance_tax', persona: 'beauty_salon_owner' }, 5);
  assert(wrongPersona.length === 0, 'ペルソナが一致しなければ返らない');

  // 上限が効く
  assert(getChangesForTopic({ tax_domain: 'inheritance_tax', persona: 'inheritance_client' }, 1).length <= 1,
    'limit=1 で1件まで');
}

// ── 3. 期限切れ・参考のみは返さない ────────────────────────────
console.log('\n=== Test 3: expired / historical_reference は返さない ===');
{
  const expired = CHANGES.filter(c => c.status === 'expired');
  assert(expired.length > 0, '前提: expired のエントリが存在する（定額減税など）');
  for (const c of expired) {
    const got = getChangesForTopic({ tax_domain: c.tax_domain, persona: c.personas[0] }, 5);
    assert(!got.some(x => x.key === c.key), `expired は返らない: ${c.title.slice(0, 24)}`);
  }
  for (const c of CHANGES.filter(x => x.status === 'historical_reference')) {
    const got = getChangesForTopic({ tax_domain: c.tax_domain, persona: c.personas[0] }, 5);
    assert(!got.some(x => x.key === c.key), `historical_reference は返らない: ${c.title.slice(0, 24)}`);
  }
}

// ── 4. プロンプト用の整形 ──────────────────────────────────────
console.log('\n=== Test 4: 整形 ===');
{
  const got = getChangesForTopic({ tax_domain: 'invoice_system', persona: 'beauty_salon_owner' }, 2);
  const text = formatChangesForPrompt(got);
  assert(text.length > 0, 'テキストが組まれる');
  assert(/根拠:/.test(text), '根拠URLが含まれる');
  assert(formatChangesForPrompt([]) === '', '空配列なら空文字');
  assert(formatChangesForPrompt(null) === '', 'null なら空文字');
}

// ── 5. 呼び出し側からフラグ判定が消えている ────────────────────
console.log('\n=== Test 5: 呼び出し側 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  assert(!/freshness_sensitive\s*\?/.test(src),
    'freshness_sensitive による三項演算子のゲートが残っていない');
  assert(/const lawChanges = getChangesForTopic\(topic, 2\);/.test(src),
    '通常生成はフラグ無しで呼ぶ');
  assert(/const changes = getChangesForTopic\(topicLike, 2\);/.test(src),
    '差し戻し再生成でも呼ぶ');
  assert(/LAW_CHANGES_HEADING/.test(src), '見出しは定数で共有している');
  // 見出しの二重定義が無いこと（文言のズレ防止）
  assert((src.match(/近年の改正・制度変更で参考になる論点/g) || []).length === 1,
    '見出し文言は1箇所だけ（通常生成と再生成で共有）');
  assert(/\$\{changesBlock\}/.test(src), '再生成の combined に改正ブロックが入る');
}

// -- 6. 新セグメントのペルソナでも届く --------------------------------
// 2026-08-18: 新セグメント（youtuber / content_seller / construction_solo /
// retail_store / wholesale）のペルソナ名が改正カタログの語彙と全く重なって
// おらず、フラグを外しても改正論点が1件も渡らなかった。
// 未知のペルソナのときは tax_domain だけで照合する。
console.log('');
console.log('=== Test 6: 新セグメントのペルソナ ===');
{
  const NEW_SEGMENT_PERSONAS = ['youtuber', 'content_seller', 'construction_solo',
    'retail_store', 'wholesale'];
  for (const persona of NEW_SEGMENT_PERSONAS) {
    const got = getChangesForTopic({ tax_domain: 'invoice_system', persona }, 2);
    assert(got.length > 0, `${persona}: インボイスの改正が届く（${got.length} 件）`);
    assert(got.every(c => c.tax_domain === 'invoice_system'),
      `${persona}: 税目は一致している`);
  }

  // 今日実際に取りこぼした形
  const game = { tax_domain: 'bookkeeping_expenses', persona: 'youtuber' };
  assert(getChangesForTopic(game, 2).length > 0,
    '減価償却記事（youtuber × 帳簿経費）に改正論点が届く');

  // 未知ペルソナでも税目が違えば返らない（無条件に何でも渡すわけではない）
  const wrongDomain = getChangesForTopic({ tax_domain: 'inheritance_tax', persona: 'youtuber' }, 5);
  assert(wrongDomain.every(c => c.tax_domain === 'inheritance_tax'),
    '未知ペルソナでも税目の絞り込みは効く');
  // 期限切れ（定額減税）が混ざらないこと。
  // 令和8年度改正の登録で income_tax にも現役の改正が入ったため、
  // 件数ではなく「expired が返らない」ことで判定する。
  const incomeTax = getChangesForTopic({ tax_domain: 'income_tax', persona: 'youtuber' }, 5);
  assert(incomeTax.every(c => c.status !== 'expired'),
    '期限切れ（定額減税）は返らない');
  assert(!incomeTax.some(c => /定額減税/.test(c.title)),
    '定額減税が混ざらない');

  // 既知ペルソナの厳格な照合は維持される（従来の挙動を壊さない）
  assert(getChangesForTopic({ tax_domain: 'inheritance_tax', persona: 'beauty_salon_owner' }, 5).length === 0,
    '既知ペルソナは従来どおり厳格に照合される');
}

// -- 7. 令和8年度税制改正の一括登録 -----------------------------------
// 2026-08-20: 大綱と国税庁の改正の概要から、当ブログが扱う領域の項目を登録した。
console.log('');
console.log('=== Test 7: 令和8年度税制改正の登録 ===');
{
  const byKey = Object.fromEntries(CHANGES.map(c => [c.key, c]));
  const EXPECTED = [
    'r8_basic_deduction_and_dependent_threshold',
    'r8_employment_income_deduction',
    'r8_small_depreciable_assets',
    'r8_invoice_30pct_special',
    'r8_education_fund_gift_end',
  ];
  for (const k of EXPECTED) {
    assert(!!byKey[k], `登録されている: ${k}`);
  }

  // 扶養の所得ライン（公開済み記事が古い数値を書いていた論点）
  const dep = byKey.r8_basic_deduction_and_dependent_threshold;
  assert(/62万円以下（現行：58万円以下）/.test(dep.summary), '大綱の原文（62万円以下）を持っている');
  assert(/令和8年分以後/.test(dep.summary), '適用年分が入っている');
  assert(/推測で書かないこと/.test(dep.summary), '配偶者特別控除は推測で書かない注意がある');
  assert(dep.tax_domain === 'income_tax', '税目は所得税');

  // 少額減価償却資産
  const dep2 = byKey.r8_small_depreciable_assets;
  assert(/40万円未満/.test(dep2.summary) && /取得等をする日/.test(dep2.summary),
    '40万円未満と取得等の日での判定');
  assert(/令和7年4月1日現在法令等のまま/.test(dep2.summary),
    'タックスアンサーが未反映である注意');

  // 教育資金の一括贈与は期限つき
  const edu = byKey.r8_education_fund_gift_end;
  assert(edu.valid_to === '2026-03-31', '教育資金は valid_to が設定されている');
  assert(edu.tax_domain === 'inheritance_tax', '税目は相続税');

  // 実際にトピックへ届くこと
  assert(getChangesForTopic({ tax_domain: 'income_tax', persona: 'youtuber' }, 3)
    .some(c => c.key === 'r8_basic_deduction_and_dependent_threshold'),
    '所得税の記事に扶養の所得ラインが届く');
  assert(getChangesForTopic({ tax_domain: 'bookkeeping_expenses', persona: 'construction_solo' }, 3)
    .some(c => c.key === 'r8_small_depreciable_assets'),
    '帳簿経費の記事に少額減価償却が届く');
  assert(getChangesForTopic({ tax_domain: 'inheritance_tax', persona: 'inheritance_client' }, 5)
    .every(c => c.tax_domain === 'inheritance_tax'),
    '相続の記事には相続の改正だけ');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
