'use strict';

/**
 * llm-auto の出典を条件つきで信頼する仕組みのテスト。
 *   node scripts/lib/__tests__/test-llm-auto-trust.js
 *
 * 2026-08-20: 対応表（DEFAULT_SOURCE_BY_PAIN）に無い論点の記事が、
 * すべて「出典の由来が未確認」で承認ブロックされていた。
 * scenario-deep-dive の81論点のうち73件が未登録で、その論点から生成される
 * 記事はほぼ全部ブロックされる状態だった。
 *
 * Luna は検証済みカタログから作った候補リストの番号を選ぶだけなので、
 * 実在しないページを出典にする事故は構造的に起きない。
 * 確信度・カタログ収録・未削除を満たすものは信頼する。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const sa = require(path.join(ROOT, 'scripts/lib/source-alignment'));
const { checkSourceAlignment, evaluateLlmAutoSource, taxCategoryNote, LLM_AUTO_MIN_CONFIDENCE } = sa;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const TA = n => `https://www.nta.go.jp/taxes/shiraberu/taxanswer/${n}.htm`;
const LEASE  = TA('hojin/5702');    // 法人税・リース取引の概要
const REPAIR = TA('shotoku/1379');  // 所得税・修繕費とならないものの判定
const SHOHI  = TA('shohi/6163');    // 消費税・リース取引の消費税

// ── 1. 実際にブロックされた2本が通ること ──────────────────────
console.log('\n=== Test 1: 2026-08-20 にブロックされた2本 ===');
{
  const lease = {
    source_url: LEASE, source_provenance: 'llm-auto', source_confidence: 0.98,
    tax_domain: 'bookkeeping_expenses', pain_point: 'lease-transaction',
  };
  const r1 = checkSourceAlignment(lease);
  assert(r1.needs_source_review === false, 'リース記事: 人の確認が不要になる');
  assert(r1.score >= 4, `リース記事: スコア ${r1.score}（4以上）`);

  const repair = {
    source_url: REPAIR, source_provenance: 'llm-auto', source_confidence: 0.98,
    tax_domain: 'bookkeeping_expenses', pain_point: 'capital-expenditure-vs-repair',
  };
  const r2 = checkSourceAlignment(repair);
  assert(r2.needs_source_review === false, '修繕費記事: 人の確認が不要になる');
  assert(r2.score === 5, `修繕費記事: スコア5（実: ${r2.score}）`);
  assert(!r2.reason, '修繕費記事: 注意書きなし（所得税のページで税目が合う）');
}

// ── 2. 信頼する条件 ────────────────────────────────────────────
console.log('\n=== Test 2: 信頼の条件 ===');
{
  const base = { source_url: REPAIR, source_provenance: 'llm-auto', tax_domain: 'bookkeeping_expenses' };

  assert(evaluateLlmAutoSource({ ...base, source_confidence: 0.98 }).ok, '確信度0.98 → 信頼する');
  assert(evaluateLlmAutoSource({ ...base, source_confidence: LLM_AUTO_MIN_CONFIDENCE }).ok,
    `確信度がちょうど閾値（${LLM_AUTO_MIN_CONFIDENCE}）→ 信頼する`);
  assert(!evaluateLlmAutoSource({ ...base, source_confidence: 0.89 }).ok, '確信度0.89 → 信頼しない');
  assert(!evaluateLlmAutoSource({ ...base, source_confidence: 0.6 }).ok, '確信度0.6 → 信頼しない');
  assert(!evaluateLlmAutoSource({ ...base }).ok, '確信度が無い → 信頼しない');
  assert(!evaluateLlmAutoSource({ ...base, source_confidence: 'abc' }).ok, '確信度が数値でない → 信頼しない');

  // カタログ収録が必須
  const notInCatalog = evaluateLlmAutoSource({
    source_url: 'https://www.nta.go.jp/foo/bar.htm', source_provenance: 'llm-auto', source_confidence: 0.99,
  });
  assert(!notInCatalog.ok, 'カタログ未収録のURL → 信頼しない');
  assert(/カタログ未収録/.test(notInCatalog.reason), '理由が分かる');

  assert(!evaluateLlmAutoSource({ source_url: '', source_provenance: 'llm-auto', source_confidence: 0.99 }).ok,
    'URLが空 → 信頼しない');
}

// ── 3. 信頼しない場合は従来どおりブロックする ──────────────────
console.log('\n=== Test 3: 条件を満たさなければ従来どおり ===');
{
  const low = checkSourceAlignment({
    source_url: REPAIR, source_provenance: 'llm-auto', source_confidence: 0.6,
    tax_domain: 'bookkeeping_expenses',
  });
  assert(low.needs_source_review === true, '確信度が低ければ人の確認が必要');
  assert(/確信度/.test(low.reason), '理由に確信度が出る（何を直せばよいか分かる）');

  const other = checkSourceAlignment({
    source_url: TA('shotoku/2210'), source_provenance: 'domain-fallback', source_confidence: 0.5,
    tax_domain: 'bookkeeping_expenses',
  });
  assert(other.needs_source_review === true, 'domain-fallback は従来どおりブロック');

  const unknown = checkSourceAlignment({
    source_url: TA('shotoku/2210'), source_provenance: 'unknown', tax_domain: 'income_tax',
  });
  assert(unknown.needs_source_review === true, 'unknown も従来どおりブロック');
}

// ── 4. 税目の食い違いは「注意書き」でありブロックではない ────────
console.log('\n=== Test 4: 税目の食い違い ===');
{
  // リースのタックスアンサーは法人税にしか無い（No.5700〜5705／消費税の6163のみ）。
  // 個人事業主の記事でも法人税のページを引くほかないため、ブロックしてはいけない。
  const lease = checkSourceAlignment({
    source_url: LEASE, source_provenance: 'llm-auto', source_confidence: 0.98,
    tax_domain: 'bookkeeping_expenses',
  });
  assert(lease.needs_source_review === false,
    '帳簿・経費の記事が法人税のページを引いてもブロックしない');

  const mismatch = checkSourceAlignment({
    source_url: SHOHI, source_provenance: 'llm-auto', source_confidence: 0.95,
    tax_domain: 'income_tax',
  });
  assert(mismatch.needs_source_review === false, '税目が違ってもブロックはしない');
  assert(mismatch.score === 4, `注意書きつきはスコア4（実: ${mismatch.score}）`);
  assert(/消費税のページです/.test(mismatch.reason), '税目の食い違いが注意書きに出る');

  assert(taxCategoryNote({ tax_domain: 'income_tax' }, { tax_category: '所得税' }) === '',
    '税目が合えば注意書きなし');
  assert(taxCategoryNote({ tax_domain: 'unknown_domain' }, { tax_category: '所得税' }) === '',
    '未知の tax_domain では注意書きを出さない（誤検知を避ける）');
  assert(taxCategoryNote({ tax_domain: 'income_tax' }, null) === '', 'カタログ情報が無ければ注意書きなし');
}

// ── 5. 既存の provenance の挙動を変えない ──────────────────────
console.log('\n=== Test 5: 既存の挙動 ===');
{
  const explicit = checkSourceAlignment({
    source_url: REPAIR, source_provenance: 'explicit', tax_domain: 'bookkeeping_expenses',
  });
  assert(explicit.needs_source_review === false && explicit.score === 5,
    'explicit は従来どおり信頼される');

  const empty = checkSourceAlignment({ source_provenance: 'llm-auto', source_confidence: 0.99 });
  assert(empty.needs_source_review === true, '出典が空なら信頼しない');
}

// -- 6. 対応表の一括登録 ----------------------------------------------
// scenario-deep-dive の81論点のうち73件に curated 登録が無く、
// そこから生成される記事がほぼ全部ブロックされていた。
console.log('');
console.log('=== Test 6: 対応表の登録 ===');
{
  const t = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
  const map = t.DEFAULT_SOURCE_BY_PAIN || {};

  // 今日ブロックされた2件が curated で解決すること
  const lease = t.resolveSourceForTopic({ pain_point: 'lease-transaction', tax_domain: 'bookkeeping_expenses' });
  assert(lease.provenance === 'curated', `リース: curated（実: ${lease.provenance}）`);
  assert(/5702/.test(lease.url), 'リース: No.5702');

  const repair = t.resolveSourceForTopic({ pain_point: 'capital-expenditure-vs-repair', tax_domain: 'bookkeeping_expenses' });
  assert(repair.provenance === 'curated', `修繕費: curated（実: ${repair.provenance}）`);
  assert(/shotoku\/1379/.test(repair.url), '修繕費: 所得税版の No.1379（法人税版ではない）');

  // 個人事業者向けに所得税のページを優先したもの
  const family = t.resolveSourceForTopic({ pain_point: 'expense-family-salary' });
  assert(/shotoku\/2075/.test(family.url), '家族への給与: No.2075（所得税）');
  const fixedAsset = t.resolveSourceForTopic({ pain_point: 'fixed-asset-tax' });
  assert(/shotoku\/2215/.test(fixedAsset.url), '固定資産税: No.2215（所得税）');

  // 経費判断系はまとめて No.2210
  for (const pain of ['expense-suit-shoes', 'expense-home-office', 'expense-taxi-late-night']) {
    const r = t.resolveSourceForTopic({ pain_point: pain });
    assert(r.provenance === 'curated' && /2210/.test(r.url), `${pain}: No.2210`);
  }

  // 登録した出典はすべてカタログに実在し、削除されていないこと
  const idx = require(path.join(ROOT, 'data/nta-sources/index.json'));
  const list = Array.isArray(idx) ? idx : (idx.entries || idx.items || []);
  const byUrl = new Map(list.map(e => [String(e.url || '').split('#')[0], e]));
  const promotions = require(path.join(ROOT, 'data/curated-source-promotions.json'));
  let bad = 0;
  for (const [pain, src] of Object.entries(promotions)) {
    const e = byUrl.get(String(src.url).split('#')[0]);
    if (!e || e.deleted === true) { bad++; console.error(`      ${pain} → ${src.url}`); }
  }
  assert(bad === 0, `登録した出典がすべてカタログに実在し未削除（不正: ${bad}）`);
  assert(Object.keys(promotions).length >= 60, `対応表が増えている（実: ${Object.keys(promotions).length}）`);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
