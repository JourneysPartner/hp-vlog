'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { evaluateSourceGuard } = require(path.join(ROOT, 'scripts/lib/source-guard'));
const { LLM_AUTO_MIN_CONFIDENCE } = require(path.join(ROOT, 'scripts/lib/source-alignment'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const REPAIR = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1379.htm';
const base = {
  source_url: REPAIR,
  source_title: '修繕費とならないものの判定',
  source_provenance: 'llm-auto',
  source_confidence: 0.98,
  source_guard_version: 1,
  tax_domain: 'bookkeeping_expenses',
  pain_point: 'capital-expenditure-vs-repair',
  review_status: 'approved',
};
const approve = meta => evaluateSourceGuard(meta, { stage: 'approve' });

console.log('\n=== Test 1: 補助出典が無い記事の回帰 ===');
{
  assert(approve(base).blocked === false, '正本0.98・カタログ収録なら通る');
  assert(approve({ ...base, source_confidence: 0.62 }).blocked === true,
    '正本0.62なら要修正');
  assert(approve({ ...base, source_url: 'https://www.nta.go.jp/not-in-catalog.htm' }).blocked === true,
    '正本がカタログ未収録なら要修正');
  assert(LLM_AUTO_MIN_CONFIDENCE === 0.9, '確信度の基準は0.9のまま');
}

console.log('\n=== Test 2: 補助出典は承認をブロックしない ===');
{
  const lowSupplement = {
    ...base,
    source_confidence: 0.97,
    source_2_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/inshi/7191.htm',
    source_2_title: '登録免許税の税額表',
    source_2_term: '登録免許税',
    source_2_confidence: 0.62,
  };
  const passedGuard = approve(lowSupplement);
  assert(passedGuard.blocked === false, '正本0.97なら補助0.62があっても通る');
  assert(/補助出典の確信度が低い論点/.test(passedGuard.alignment.reason)
    && /登録免許税/.test(passedGuard.alignment.reason), '注意書きに弱い論点語が出る');

  const weakPrimary = approve({
    ...lowSupplement,
    source_confidence: 0.62,
    source_2_confidence: 0.95,
  });
  assert(weakPrimary.blocked === true, '補助が0.95でも正本0.62なら要修正');
}

console.log('\n=== Test 3: 補助出典があっても正本の規則は同じ ===');
{
  const result = approve({
    ...base,
    source_url: 'https://www.nta.go.jp/not-in-catalog.htm',
    source_2_url: REPAIR,
    source_2_title: '修繕費とならないものの判定',
    source_2_term: '修繕費',
    source_2_confidence: 0.99,
  });
  assert(result.blocked === true, '補助があっても正本がカタログ未収録なら要修正');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
