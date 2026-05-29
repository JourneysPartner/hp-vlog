'use strict';

/**
 * cross-domain refs（getRefsForTopic 拡張）のテスト。
 *   node scripts/lib/__tests__/test-cross-domain-refs.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { getRefsForTopic } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}
function hasNo(refs, no) { return refs.some(r => r.no === no); }

// ── 1. 事故ケース: income_tax + 消費税論点 → 6505 が含まれる ─────
// これが今回のハルシネーション事故の真因対策。
console.log('\n=== Test 1: 所得税の確定申告で消費税判定の話 → 簡易課税 ref が渡る ===');
{
  const topic = {
    tax_domain: 'income_tax', category: '所得税',
    pain_point: 'consumption-tax-judgement',
    cluster: 'income-tax-basics',
    subcluster: 'final-return-consumption-tax-judgement',
    primary_question: '所得税における消費税課税事業者の判定は確定申告でどう扱うべきか？',
    search_intent: '所得税の確定申告で消費税課税事業者の判定に向き合いたい',
    reader_problem: '消費税課税事業者の判定',
  };
  const refs = getRefsForTopic(topic);
  assert(hasNo(refs, '6505'), 'No.6505 簡易課税制度 が含まれる（みなし仕入率の根拠）');
  assert(hasNo(refs, '6501'), 'No.6501 納税義務の免除 が含まれる');
}

// ── 2. 法人化検討記事 → 消費税 refs が高優先で渡る ─────────────
console.log('\n=== Test 2: 法人化検討（売上 1000 万円ライン）→ 消費税 refs ===');
{
  const topic = {
    tax_domain: 'income_tax', category: '所得税',
    pain_point: 'incorporation-threshold',
    primary_question: 'メルカリ販売で法人化を考えるべき売上ラインは？',
  };
  const refs = getRefsForTopic(topic);
  assert(hasNo(refs, '6501') || hasNo(refs, '6505'),
    '消費税 refs（納税義務免除 or 簡易課税）が含まれる');
}

// ── 3. インボイス論点 → invoice_system refs ─────────────────
console.log('\n=== Test 3: インボイス判断の記事 → invoice_system refs ===');
{
  const topic = {
    tax_domain: 'income_tax', category: '所得税',
    pain_point: 'invoice-judgement',
    primary_question: 'eBay 輸出セラーはインボイス登録すべき？',
  };
  const refs = getRefsForTopic(topic);
  assert(refs.some(r => /invoice/i.test(r.url || '') || /インボイス/.test(r.title || '')),
    'インボイス系 ref が含まれる');
}

// ── 4. 通常の消費税記事は影響なし ─────────────────────────────
console.log('\n=== Test 4: 通常の消費税記事は従来通り ===');
{
  const topic = {
    tax_domain: 'consumption_tax', category: '消費税',
    pain_point: 'consumption-tax-judgement',
    primary_question: '消費税の納税義務はどう判定？',
  };
  const refs = getRefsForTopic(topic);
  assert(hasNo(refs, '6501') && hasNo(refs, '6505'),
    'consumption_tax の代表 refs が含まれる');
  assert(refs.length <= 4, `refs 件数 ${refs.length} <= limit 4`);
}

// ── 5. 通常の所得税記事（cross-domain 無し）─────────────────
console.log('\n=== Test 5: cross-domain 論点を持たない所得税記事 ===');
{
  const topic = {
    tax_domain: 'income_tax', category: '所得税',
    pain_point: 'spouse-deduction',
    primary_question: '配偶者控除の所得要件は？',
    search_intent: '配偶者控除を受けるための要件',
    reader_problem: '所得要件の判断',
  };
  const refs = getRefsForTopic(topic);
  assert(!hasNo(refs, '6505'), '消費税ハイ優先 ref は含まれない（cross-domain 無いため）');
  assert(refs.length > 0, 'income_tax の通常 refs が含まれる');
}

// ── 6. limit パラメータが効く ───────────────────────────────
console.log('\n=== Test 6: limit が機能 ===');
{
  const topic = { tax_domain: 'income_tax', category: '所得税' };
  assert(getRefsForTopic(topic, 2).length === 2, 'limit=2 で 2 件');
  assert(getRefsForTopic(topic, 6).length <= 6, 'limit=6 で <= 6 件');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
