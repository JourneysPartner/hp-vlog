'use strict';

/** 所得税エンジン第1版の単体・受け入れテスト。 */

const fs = require('fs');
const path = require('path');
const { money } = require('../../../src/tax-engine/common/money.js');
const salaryEngine = require('../../../src/tax-engine/income/salary-income.js');
const businessEngine = require('../../../src/tax-engine/income/business-income.js');
const deductionsEngine = require('../../../src/tax-engine/income/income-deductions.js');
const incomeTaxEngine = require('../../../src/tax-engine/income/income-tax.js');

const OPTIONS = { taxYear: 2025 };
const yen = value => money({ unit: 'JPY', value: BigInt(value) });
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function amount(value) {
  return value.value;
}

console.log('\n=== 給与所得: 別表第五の全1,175帯 ===');
{
  const fixture = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'fixtures',
    'appendix5-r7-golden.json'
  ), 'utf8'));
  const mismatches = [];
  for (const [lower, upperExclusive, expected] of fixture.bands) {
    for (const probe of [lower, upperExclusive - 1]) {
      const result = salaryEngine.calculateSalaryIncome(yen(probe), OPTIONS);
      if (amount(result.salaryIncome) !== BigInt(expected)) {
        mismatches.push({ probe, expected, actual: String(amount(result.salaryIncome)) });
      }
    }
  }
  assert(fixture.bands.length === 1175 && mismatches.length === 0,
    `全1,175帯の下限・上限直前が原表と一致（不一致 ${mismatches.length}件）`);
}
{
  const below = salaryEngine.calculateSalaryIncome(yen(6599999), OPTIONS);
  const boundary = salaryEngine.calculateSalaryIncome(yen(6600000), OPTIONS);
  assert(below.calculationMethod === 'appendix5' && amount(below.salaryIncome) === 4836800n,
    '6,599,999円は別表第五（帯下限6,596,000円）を使う');
  assert(boundary.calculationMethod === 'deduction_table' && amount(boundary.salaryIncome) === 4840000n,
    '6,600,000円は給与所得控除表を使う');
  assert(amount(boundary.salaryIncomeDeduction) === 1760000n,
    '660万円境界の給与所得控除は176万円');
}

console.log('\n=== 事業所得・青色申告特別控除 ===');
{
  const result = businessEngine.calculateBusinessIncome({
    revenue: yen(1000000), expenses: yen(100000), blueReturnTier: 'e_tax_650k',
  }, OPTIONS);
  assert(result.status === 'complete' && amount(result.blueReturnSpecialDeduction) === 650000n &&
    amount(result.businessIncome) === 250000n, 'e-Tax区分の65万円を控除する');
}
{
  const result = businessEngine.calculateBusinessIncome({
    revenue: yen(300000), expenses: yen(100000), blueReturnTier: 'bookkeeping_550k',
  }, OPTIONS);
  assert(amount(result.blueReturnSpecialDeduction) === 200000n && amount(result.businessIncome) === 0n,
    '青色申告特別控除を控除前事業所得で制限する');
}

console.log('\n=== 基礎・配偶者・扶養・特定親族 ===');
{
  const cases = [[1000000, 950000], [5000000, 630000], [23600000, 480000], [25100000, 0]];
  assert(cases.every(([income, expected]) => amount(
    deductionsEngine.calculateBasicDeduction(yen(income), OPTIONS)
  ) === BigInt(expected)), '令和7年分の基礎控除4境界（95万・63万・48万・0円）');
}
{
  const over = deductionsEngine.calculateSpouseDeduction(yen(10000001), {
    exists: true, ageAtYearEnd: 40, totalIncome: yen(400000),
  }, OPTIONS);
  const elderly = deductionsEngine.calculateSpouseDeduction(yen(5200000), {
    exists: true, ageAtYearEnd: 70, totalIncome: yen(400000),
  }, OPTIONS);
  const general = deductionsEngine.calculateSpouseDeduction(yen(5200000), {
    exists: true, ageAtYearEnd: 68, totalIncome: yen(400000),
  }, OPTIONS);
  assert(amount(over) === 0n, '本人合計所得1,000万円超はblockedでなく配偶者控除0円');
  assert(amount(elderly) === 480000n && amount(general) === 380000n,
    '老人配偶者48万円・一般配偶者38万円を区分する');
}
{
  // 配偶者の合計所得58万円の境界（令和7年改正で48万円から引き上げ）。
  // 一般配偶者は境界の両側とも38万円で見分けが付かないため、老人配偶者で固定する。
  // 58万円ちょうど → 配偶者控除（老人48万円）、58万1円 → 配偶者特別控除（38万円）。
  // 境界を48万円へ戻す退行（改正前の値の混入）はこのテストで落ちる。
  const atBoundary = deductionsEngine.calculateSpouseDeduction(yen(5200000), {
    exists: true, ageAtYearEnd: 72, totalIncome: yen(580000),
  }, OPTIONS);
  const overBoundary = deductionsEngine.calculateSpouseSpecialDeduction(yen(5200000), {
    exists: true, totalIncome: yen(580001),
  }, OPTIONS);
  assert(amount(atBoundary) === 480000n,
    '配偶者の合計所得58万円ちょうどは配偶者控除（老人48万円）');
  assert(amount(overBoundary) === 380000n,
    '58万1円からは配偶者特別控除（38万円）。境界はマスター由来の58万円（令和7年改正）');
}
{
  const lowerBand = deductionsEngine.calculateSpouseSpecialDeduction(yen(5000000), {
    exists: true, totalIncome: yen(950000),
  }, OPTIONS);
  const nextBand = deductionsEngine.calculateSpouseSpecialDeduction(yen(5000000), {
    exists: true, totalIncome: yen(950001),
  }, OPTIONS);
  assert(amount(lowerBand) === 380000n && amount(nextBand) === 360000n,
    '配偶者特別控除の95万円以下38万円と次帯の境界');
}
{
  const result = deductionsEngine.calculateDependentDeductions([
    { id: 'under-16', ageAtYearEnd: 15, relation: 'child', totalIncome: yen(0) },
    { id: 'specific', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
    { id: 'old-parent', ageAtYearEnd: 72, relation: 'parent', livesTogether: true, totalIncome: yen(0) },
  ], OPTIONS);
  const byId = new Map(result.rows.map(row => [row.id, row.amount.value]));
  assert(byId.get('under-16') === 0n && byId.get('specific') === 630000n &&
    byId.get('old-parent') === 580000n, '16歳未満0円・特定63万円・同居老親58万円');
}

console.log('\n=== 保険・医療・雑損・寄附金控除 ===');
{
  const life = deductionsEngine.calculateLifeInsuranceDeduction([
    { generation: 'new', category: 'life', annualPremium: yen(100000) },
    { generation: 'new', category: 'nursing_medical', annualPremium: yen(100000) },
    { generation: 'new', category: 'annuity', annualPremium: yen(100000) },
  ], OPTIONS);
  const earthquake = deductionsEngine.calculateEarthquakeInsuranceDeduction([
    { category: 'earthquake', annualPremium: yen(80000) },
  ], OPTIONS);
  assert(amount(life.amount) === 120000n, '新契約3区分が生命保険料控除の全体上限12万円に張り付く');
  assert(amount(earthquake.amount) === 50000n, '地震保険料控除は5万円上限');
}
{
  const lowIncome = deductionsEngine.calculateMedicalDeduction({
    medical: { mode: 'medical', paidAmount: yen(100000), insuranceReimbursement: yen(0) },
  }, yen(1000000), OPTIONS);
  const highIncome = deductionsEngine.calculateMedicalDeduction({
    medical: { mode: 'medical', paidAmount: yen(200000), insuranceReimbursement: yen(0) },
  }, yen(3000000), OPTIONS);
  assert(amount(lowIncome) === 50000n && amount(highIncome) === 100000n,
    '医療費の足切りは min(10万円, 総所得金額等×5%) の両側で働く');
}
{
  const casualty = deductionsEngine.calculateCasualtyLossDeduction({
    casualtyLossDetails: { netLossAmount: yen(500000), disasterRelatedExpenses: yen(200000) },
  }, yen(2000000), OPTIONS);
  const donation = deductionsEngine.calculateDonationDeduction(
    [{ amount: yen(1000000) }], yen(2000000), OPTIONS
  );
  assert(amount(casualty) === 300000n, '雑損控除はいずれか多い式を適用する');
  assert(amount(donation) === 798000n, '寄附金控除は総所得金額等40%上限から2,000円を引く');
}

console.log('\n=== 課税総所得・税額・端数 ===');
{
  const result = incomeTaxEngine.calculate({
    taxYear: 2025,
    business: { revenue: yen(2000999), expenses: yen(0) },
  }, OPTIONS);
  assert(amount(result.totalIncome) === 2000999n &&
    amount(result.incomeDeductions.basic) === 880000n &&
    amount(result.taxableTotalIncomeBeforeRounding) === 1120999n &&
    amount(result.taxableTotalIncome) === 1120000n,
  '合計所得で基礎控除を判定し、控除後に1,000円未満を切り捨てる');
}
{
  const result = incomeTaxEngine.calculate({
    taxYear: 2025,
    salaryRevenue: yen(7000000),
    deductions: { socialInsurance: yen(1000000) },
  }, OPTIONS);
  assert(amount(result.salary.salaryIncomeDeduction) === 1800000n &&
    amount(result.salaryIncome) === 5200000n && amount(result.totalIncome) === 5200000n &&
    amount(result.incomeDeductions.basic) === 630000n &&
    amount(result.taxableTotalIncome) === 3570000n, 'GC-IT-FULL-SALARY: 所得段階と控除');
  assert(amount(result.calculatedIncomeTax) === 286500n &&
    amount(result.reconstructionIncomeTax) === 6016n &&
    amount(result.totalIncomeTax) === 292516n && amount(result.payableIncomeTax) === 292500n,
  'GC-IT-FULL-SALARY: 復興税1円未満・納付税額100円未満を法定段階で切り捨てる');
}
{
  const result = incomeTaxEngine.calculateIncomeTax(yen(1000000), {
    housingLoan: yen(1000000),
  }, OPTIONS);
  assert(amount(result.baseIncomeTax) === 0n && amount(result.payableIncomeTax) === 0n &&
    result.warnings.some(warning => warning.code === 'IT_HOUSING_LOAN_CREDIT_EXCEEDS_TAX'),
  '住宅ローン控除で引き切れない税額を0止まりにして警告する');
}

console.log('\n=== blocked 理由コード ===');
{
  const loss = incomeTaxEngine.calculate({
    taxYear: 2025,
    business: { revenue: yen(100000), expenses: yen(200000) },
  }, OPTIONS);
  const medicalConflict = incomeTaxEngine.calculate({
    taxYear: 2025,
    salaryRevenue: yen(3000000),
    deductions: {
      medical: { mode: 'medical', paidAmount: yen(100000) },
      selfMedication: { paidAmount: yen(50000) },
    },
  }, OPTIONS);
  const overlap = incomeTaxEngine.calculate({
    taxYear: 2025,
    salaryRevenue: yen(3000000),
    dependents: [{
      id: 'relative', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(800000),
      claimsDependentDeduction: true, claimsSpecificRelativeSpecialDeduction: true,
    }],
  }, OPTIONS);
  const unsupported = incomeTaxEngine.calculate({
    taxYear: 2025,
    otherIncomes: [{ category: 'dividend', taxationMethod: 'aggregate', amount: yen(100000) }],
  }, OPTIONS);
  const separate = incomeTaxEngine.calculate({
    taxYear: 2025,
    otherIncomes: [{ category: 'salary', taxationMethod: 'separate_declared', amount: yen(100000) }],
  }, OPTIONS);
  const carryforwards = incomeTaxEngine.calculate({
    taxYear: 2025,
    netLossCarryforward: yen(1),
    casualtyLossCarryforward: yen(1),
  }, OPTIONS);
  assert(loss.status === 'blocked' && loss.blockedReasons.some(
    reason => reason.code === 'IT_BUSINESS_LOSS_OFFSET_UNSUPPORTED'
  ), '負の事業所得は損益通算の理由コード付きblocked');
  assert(medicalConflict.status === 'blocked' && medicalConflict.blockedReasons.some(
    reason => reason.code === 'IT_MEDICAL_DEDUCTION_ELECTION_CONFLICT'
  ), '医療費控除とセルフメディケーション併用は理由コード付きblocked');
  assert(overlap.status === 'blocked' && overlap.blockedReasons.some(
    reason => reason.code === 'IT_DEPENDENT_SPECIFIC_RELATIVE_OVERLAP'
  ), '扶養控除と特定親族特別控除の重複は理由コード付きblocked');
  assert(unsupported.status === 'blocked' && unsupported.blockedReasons.some(
    reason => reason.code === 'IT_INCOME_CATEGORY_UNSUPPORTED'
  ), '対象外所得区分を黙って無視せずblocked');
  assert(separate.status === 'blocked' && separate.blockedReasons.some(
    reason => reason.code === 'IT_SEPARATE_TAXATION_UNSUPPORTED'
  ), '分離課税所得は理由コード付きblocked');
  assert(carryforwards.status === 'blocked' && [
    'IT_NET_LOSS_CARRYFORWARD_UNSUPPORTED',
    'IT_CASUALTY_LOSS_CARRYFORWARD_UNSUPPORTED',
  ].every(code => carryforwards.blockedReasons.some(reason => reason.code === code)),
  '純損失・雑損失の繰越はそれぞれの理由コード付きblocked');
}

console.log('\n=== official-examples の所得税3ケース ===');
{
  const document = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
  ), 'utf8'));
  const cases = new Map(document.cases.map(item => [item.case_id, item]));
  const appendix = cases.get('GC-IT-APPENDIX5-500');
  const spouse = cases.get('GC-IT-SPOUSE-38');
  const full = cases.get('GC-IT-FULL-SALARY');
  const appendixResult = salaryEngine.calculateSalaryIncome(yen(appendix.inputs.salary_revenue), OPTIONS);
  const spouseResult = deductionsEngine.calculateSpouseDeduction(
    yen(spouse.inputs.taxpayer_total_income),
    {
      exists: true,
      ageAtYearEnd: spouse.inputs.spouse_age_at_year_end,
      totalIncome: yen(spouse.inputs.spouse_total_income),
    }, OPTIONS
  );
  const fullResult = incomeTaxEngine.calculate({
    taxYear: full.inputs.tax_year,
    salaryRevenue: yen(full.inputs.salary_revenue),
    deductions: { socialInsurance: yen(full.inputs.social_insurance_deduction) },
  }, OPTIONS);
  assert(amount(appendixResult.salaryIncome) === BigInt(appendix.expected.salary_income),
    'GC-IT-APPENDIX5-500 の期待値をそのまま照合');
  assert(amount(spouseResult) === BigInt(spouse.expected.spouse_deduction),
    'GC-IT-SPOUSE-38 の期待値をそのまま照合');
  assert(amount(fullResult.payableIncomeTax) === BigInt(full.expected.payable_income_tax),
    'GC-IT-FULL-SALARY の期待値をそのまま照合');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
