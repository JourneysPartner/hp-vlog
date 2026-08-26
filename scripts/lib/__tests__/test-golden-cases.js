'use strict';

/**
 * 公的計算例のゴールデンケース照合（仕様書 §63）。
 *   node scripts/lib/__tests__/test-golden-cases.js
 *
 * 各ケースの期待値は国税庁の計算例・公式の表・条文から取っている。
 * ここでの計算は「マスターの値」＋「文書化された計算手順」だけで行い、
 * 期待値そのものをマスターから導かない（同じ誤りを両側に入れると照合が無意味になる）。
 *
 * 計算エンジンができたら、同じケースをエンジンの受け入れテストとして流用する。
 * 期待値は変えない。
 *
 * この基盤の初仕事: 令和7年分の基礎控除に措法41条の16の2の上乗せが
 * 欠けていたことを GC-BD-R7-500 を作る過程で発見した（訂正済み）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator');
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'golden-cases', 'official-examples.json'), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

// ── マスターの読み取り ──────────────────────────────────────
function collect(file) {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'masters', 'data', file), 'utf8'));
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.value_key === 'string') out.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  walk(doc);
  return out;
}

const yen = (m) => BigInt(m.value);
// その年をカバーする行だけに絞る
const forYear = (rows, year) => rows.filter(r =>
  (r.effective_from || '') <= `${year}-12-31` && (r.effective_to || '9999') >= `${year}-01-01`);

// ── 計算手順（マスターの値＋文書化された手順のみで組む） ──────────

// 所得税の速算表: 該当する段を引き、金額×税率−速算控除
function incomeTaxQuickTable(taxableIncome, year) {
  const rows = forYear(collect('income-tax/brackets-h27.json')
    .filter(r => r.value_key === 'income_tax_brackets'), year);
  const x = BigInt(taxableIncome);
  const row = rows.find(r =>
    x >= yen(r.bracket_lower_inclusive) &&
    (!r.bracket_upper_inclusive || x <= yen(r.bracket_upper_inclusive)));
  if (!row) throw new Error(`速算表に該当なし: ${taxableIncome}`);
  return x * BigInt(row.rate.num) / BigInt(row.rate.den) - yen(row.quick_deduction);
}

// 相続税の総額: 法定相続分で按分 → 各人に速算表 → 合計
function inheritanceTaxTotal(estate, heirs) {
  const shares = collect('inheritance-tax/statutory-shares.json');
  const combo = shares.find(r => r.value_key === 'statutory_share_by_combination'
    && r.combination === 'spouse_and_child');
  const brackets = collect('inheritance-tax/brackets-h27.json')
    .filter(r => r.value_key === 'inheritance_tax_brackets');
  const taxOn = (x) => {
    const row = brackets.find(r =>
      x >= yen(r.bracket_lower_inclusive) &&
      (!r.bracket_upper_inclusive || x <= yen(r.bracket_upper_inclusive)));
    return x * BigInt(row.rate.num) / BigInt(row.rate.den) - yen(row.quick_deduction);
  };
  const e = BigInt(estate);
  const nChildren = BigInt(heirs.filter(h => h.relation === 'child').length);
  // 配偶者の取り分（900条1号）と、子の残りの均等分割（900条4号）
  const spouseAmount = e * BigInt(combo.spouse_share.num) / BigInt(combo.spouse_share.den);
  const childrenTotal = e * BigInt(combo.blood_relative_share.num) / BigInt(combo.blood_relative_share.den);
  const childAmount = childrenTotal / nChildren;
  const spouseTax = taxOn(spouseAmount);
  const childTax = taxOn(childAmount);
  return { spouseAmount, childAmount, spouseTax, childTax,
    total: spouseTax + childTax * nChildren };
}

// 給与所得控除（660万円以上の表）
function salaryIncomeDeduction(revenue, year) {
  const rows = forYear(collect('salary-income-deduction/deductions.json')
    .filter(r => r.value_key === 'salary_income_deduction_table'), year);
  const x = BigInt(revenue);
  const row = rows.find(r =>
    x >= yen(r.revenue_lower_inclusive) &&
    (!r.revenue_upper_inclusive || x <= yen(r.revenue_upper_inclusive)));
  if (!row) throw new Error(`給与所得控除の表に該当なし: ${revenue}`);
  if (row.deduction_type === 'fixed') return yen(row.fixed_amount);
  return x * BigInt(row.rate.num) / BigInt(row.rate.den) + yen(row.rate_addition);
}

// 基礎控除
function basicDeduction(totalIncome, year) {
  const rows = forYear(collect('basic-deduction/deductions.json')
    .filter(r => r.value_key === 'basic_deduction_table'), year);
  const x = BigInt(totalIncome);
  const row = rows.find(r =>
    x >= yen(r.income_lower_inclusive) &&
    (!r.income_upper_inclusive || x <= yen(r.income_upper_inclusive)));
  if (!row) throw new Error(`基礎控除の表に該当なし: ${totalIncome}`);
  return yen(row.deduction_amount);
}

// 2割特例
function smallBusinessSpecial(salesTax, periodFrom, periodTo) {
  const rows = collect('consumption-tax/small-business-special.json')
    .filter(r => r.value_key === 'small_business_special_deduction');
  // 課税期間がいずれかの日を含むか（period_match_rule: taxable_period_intersects）
  const row = rows.find(r =>
    periodTo >= r.effective_from && periodFrom <= r.effective_to);
  if (!row) throw new Error('特例の対象期間外');
  const x = BigInt(salesTax);
  const deduction = x * BigInt(row.special_deduction_rate.num) / BigInt(row.special_deduction_rate.den);
  return { deduction, payable: x - deduction };
}

// ── 照合 ────────────────────────────────────────────────────
const byId = new Map(CASES.cases.map(c => [c.case_id, c]));

console.log('\n=== §63 公的計算例との照合 ===');
{
  const c = byId.get('GC-IT-2260-700');
  assert(incomeTaxQuickTable(c.inputs.taxable_income, c.inputs.tax_year)
    === BigInt(c.expected.income_tax_before_credits),
    `${c.case_id}: 課税所得700万円 → 974,000円（No.2260の計算例）`);
}
{
  const c = byId.get('GC-IT-2260-BOUNDARY');
  assert(incomeTaxQuickTable(c.inputs.taxable_income, c.inputs.tax_year)
    === BigInt(c.expected.income_tax_before_credits),
    `${c.case_id}: 1,949,000円 → 97,450円（5%の段の上端）`);
  assert(incomeTaxQuickTable(c.inputs_2.taxable_income, c.inputs_2.tax_year)
    === BigInt(c.expected_2.income_tax_before_credits),
    `${c.case_id}: 1,950,000円 → 97,500円（10%の段の下端）`);
}
{
  const c = byId.get('GC-IHT-4155-WIFE-2KIDS');
  const r = inheritanceTaxTotal(c.inputs.taxable_estate_after_basic_deduction, c.inputs.heirs);
  assert(r.spouseAmount === BigInt(c.expected.spouse_share_amount),
    `${c.case_id}: 妻の法定相続分 7,600万円`);
  assert(r.childAmount === BigInt(c.expected.child_share_amount),
    `${c.case_id}: 子の法定相続分 各3,800万円`);
  assert(r.spouseTax === BigInt(c.expected.spouse_tax),
    `${c.case_id}: 妻の税額 1,580万円（30%−700万）`);
  assert(r.childTax === BigInt(c.expected.child_tax_each),
    `${c.case_id}: 子の税額 各560万円（20%−200万）`);
  assert(r.total === BigInt(c.expected.total_inheritance_tax),
    `${c.case_id}: 相続税の総額 2,700万円（No.4155の計算例）`);
}
{
  const c = byId.get('GC-SID-R7-CAP');
  assert(salaryIncomeDeduction(c.inputs.salary_revenue, c.inputs.tax_year)
    === BigInt(c.expected.salary_income_deduction),
    `${c.case_id}: 給与収入1,000万円 → 控除上限195万円`);
}
{
  const c = byId.get('GC-SID-R7-700');
  assert(salaryIncomeDeduction(c.inputs.salary_revenue, c.inputs.tax_year)
    === BigInt(c.expected.salary_income_deduction),
    `${c.case_id}: 給与収入700万円 → 控除180万円（×10%＋110万）`);
}
{
  const c = byId.get('GC-BD-R7-500');
  assert(basicDeduction(c.inputs.total_income, c.inputs.tax_year)
    === BigInt(c.expected.basic_deduction),
    `${c.case_id}: 合計所得500万円（令和7年分）→ 基礎控除63万円（欠落を発見したケース）`);
}
{
  const c = byId.get('GC-BD-R7-100');
  assert(basicDeduction(c.inputs.total_income, c.inputs.tax_year)
    === BigInt(c.expected.basic_deduction),
    `${c.case_id}: 合計所得100万円（令和7年分）→ 基礎控除95万円`);
}
{
  const c = byId.get('GC-CT-2WARI-70');
  const r = smallBusinessSpecial(c.inputs.sales_tax_after_returns,
    c.inputs.taxable_period.from, c.inputs.taxable_period.to);
  assert(r.deduction === BigInt(c.expected.special_deduction),
    `${c.case_id}: 特別控除 56万円（売上税額×80%）`);
  assert(r.payable === BigInt(c.expected.tax_payable),
    `${c.case_id}: 納付税額 14万円`);
}

console.log('\n=== ケースの体裁（§63 の要求） ===');
{
  for (const c of CASES.cases) {
    assert(c.source && c.source.url && c.source.retrieved_at && c.source.usage,
      `${c.case_id}: 出典・取得日・利用範囲が記録されている`);
    assert(c.kind === 'official_example' || c.kind === 'table_derived',
      `${c.case_id}: kind が区別されている（${c.kind}）`);
  }
  const official = CASES.cases.filter(c => c.kind === 'official_example');
  assert(official.length >= 2,
    `公式ページに明記された計算例が2件以上ある（実: ${official.length}件）`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
