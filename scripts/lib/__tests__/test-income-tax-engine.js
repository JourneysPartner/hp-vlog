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

console.log('\n=== 給与所得: C-12の1円未満切り捨て ===');
{
  // 期待値は指示書R2-1の手計算表から取り、マスターから生成しない。
  const cases = [
    [6599999, 4836800n, 1763199n, 'appendix5'],
    [6600000, 4840000n, 1760000n, 'deduction_table'],
    [6600001, 4840000n, 1760001n, 'deduction_table'],
    [6655556, 4890000n, 1765556n, 'deduction_table'],
    [7000000, 5200000n, 1800000n, 'deduction_table'],
    [7234567, 5411110n, 1823457n, 'deduction_table'],
    [8499999, 6549999n, 1950000n, 'deduction_table'],
    [8500000, 6550000n, 1950000n, 'deduction_table'],
    [10000000, 8050000n, 1950000n, 'deduction_table'],
  ];
  for (const [revenue, expectedIncome, expectedDeduction, expectedMethod] of cases) {
    const result = salaryEngine.calculateSalaryIncome(yen(revenue), OPTIONS);
    assert(amount(result.salaryIncome) === expectedIncome,
      `C-12: 収入${revenue}円の給与所得は${expectedIncome}円`);
    assert(amount(result.salaryIncomeDeduction) === expectedDeduction,
      `C-12: 収入${revenue}円の給与所得控除額は${expectedDeduction}円`);
    assert(result.calculationMethod === expectedMethod,
      `C-12: 収入${revenue}円の計算方式は${expectedMethod}`);
  }
}
{
  const lower = 6600000n;
  const upper = 8499999n;
  const probes = new Set([lower, upper]);
  for (let revenue = lower; revenue <= upper; revenue += 997n) probes.add(revenue);
  const mismatches = [];
  for (const revenue of probes) {
    // 国税庁の算式をBigIntで直接計算する（この範囲は正なので整数除算が切り捨てになる）。
    const expected = (revenue * 9n - 11000000n) / 10n;
    const actual = amount(salaryEngine.calculateSalaryIncome(yen(revenue), OPTIONS).salaryIncome);
    if (actual !== expected) {
      mismatches.push({ revenue: String(revenue), expected: String(expected), actual: String(actual) });
    }
  }
  assert(mismatches.length === 0,
    `C-12: 660万〜850万円未満の両端・997円刻み全${probes.size}点が国税庁の算式と一致（不一致 ${mismatches.length}件${mismatches.length ? ': ' + JSON.stringify(mismatches.slice(0, 3)) : ''}）`);
}
{
  const result = incomeTaxEngine.calculate({
    taxYear: 2025,
    salaryRevenue: yen(6655556),
    deductions: {},
  }, OPTIONS);
  assert(amount(result.totalIncome) === 4890000n,
    'C-12: 給与6,655,556円の合計所得は4,890,000円');
  assert(amount(result.incomeDeductions.basic) === 680000n,
    'C-12: 合計所得489万円以下の基礎控除は680,000円');
  assert(amount(result.payableIncomeTax) === 423200n,
    'C-12: 給与6,655,556円の所得税・復興特別所得税の納付税額は423,200円');
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

console.log('\n=== 給与所得: 令和8年分の承認状態と原表 ===');
{
  const mastersDir = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters');
  const readSalaryMaster = name => JSON.parse(fs.readFileSync(path.join(
    mastersDir, 'data', 'salary-income-deduction', name + '.json'
  ), 'utf8'));
  const appendixRecords = readSalaryMaster('appendix5').r8.records;
  const deductionRecords = readSalaryMaster('deductions').r8.records;
  const records = [...appendixRecords, ...deductionRecords];
  const approvedCount = records.filter(record => record.data_review_status === 'approved').length;
  assert(appendixRecords.length === 9 && deductionRecords.length === 5, '令和8年分の承認対象は別表第五9件と算式表5件の計14件');
  assert(approvedCount === 0 || approvedCount === 14,
    '14件をまとめて承認する（一部だけの承認は不可。承認済み ' + approvedCount + '件）');
  if (records.length === 14 && approvedCount === 14) {
    console.log('令和8年分の記録は承認済み: 期待値どおりであることを確かめる');
    const cases = [
      [0, 0], [690999, 0], [691000, 0], [740999, 0], [741000, 1000],
      [1000000, 260000], [2190999, 1450999], [2191000, 1451000], [2192999, 1451000],
      [2193000, 1453000], [2195999, 1453000], [2196000, 1456000], [2199999, 1456000],
      [2200000, 1460000], [2203999, 1460000], [2204000, 1462800], [3000000, 2020000],
      [3600000, 2440000], [3603999, 2440000], [3604000, 2443200], [6599999, 4836800],
      // 660万円以上は算式表（所法28条2項・3項）。1円未満の端数は給与所得の金額で切り捨てる（台帳 C-12）。
      [6600000, 4840000], [6655556, 4890000], [7000000, 5200000], [8499999, 6549999],
      [8500000, 6550000], [10000000, 8050000],
    ];
    for (const [revenue, income] of cases) {
      const result = salaryEngine.calculateSalaryIncome(yen(revenue), { taxYear: 2026 });
      assert(amount(result.salaryIncome) === BigInt(income), '令和8年分の収入 ' + revenue + '円 → 給与所得 ' + income + '円');
    }
    const fixture = JSON.parse(fs.readFileSync(path.join(mastersDir, 'fixtures', 'appendix5-r8-golden.json'), 'utf8'));
    const bands = fixture.bands.filter(([lower]) => lower >= 2200000);
    const bad = [];
    for (const [lower, upper, income] of bands) {
      for (const probe of [lower, upper - 1]) {
        const result = salaryEngine.calculateSalaryIncome(yen(probe), { taxYear: 2026 });
        if (amount(result.salaryIncome) !== BigInt(income)) {
          bad.push({ probe, expected: income, actual: String(amount(result.salaryIncome)) });
        }
      }
    }
    assert(bands.length === 1100 && bad.length === 0,
      '令和8年分の全' + bands.length + '帯の下端・上端直前が原表と一致（不一致 ' + bad.length + '件' +
      (bad.length ? ': ' + JSON.stringify(bad.slice(0, 3)) : '') + '）');
  } else if (approvedCount === 0) {
    console.log('令和8年分の記録は未承認: 止まることを確かめる');
    for (const revenue of [3000000, 8000000]) {
      let caught;
      try {
        salaryEngine.calculateSalaryIncome(yen(revenue), { taxYear: 2026 });
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof Error && caught.message.includes('別表第五の帯規則が利用できません'),
        '未承認の令和8年分の収入 ' + revenue + '円は前年の値を使わず例外で止まる');
    }
  } else {
    console.log('令和8年分の記録は一部だけ承認済み: 試験失敗');
  }
}


console.log('\n=== 段3: 62万円の所得要件（本物のデータ） ===');
const stage3MasterFiles = [
  path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data',
    'income-deduction', 'specific-relative-deduction.json'),
  path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data',
    'income-deduction', 'spouse-special-deduction.json'),
];
const stage3RecordIds = [
  'IDED-SPECREL-T00', 'IDED-SPECREL-T01', 'IDED-SPECREL-R8-T00', 'IDED-SPECREL-R8-T01',
  ...[1, 2, 3, 4].flatMap(n => ['IDED-SPOUSE-SP-S01-T' + n, 'IDED-SPOUSE-SP-R8-S01-T' + n]),
];

/** 照合表5-2の期待値を固定し、年ごとの控除の種類と金額を確かめる。 */
function checkStage3Examples(engine, label) {
  for (const year of [2025, 2026]) {
    const options = { taxYear: year };
    const r8 = year === 2026;
    const spouseCases = [
      [72, 620000, 5200000, r8 ? 480000n : 0n, r8 ? 0n : 380000n],
      [72, 620001, 5200000, 0n, 380000n],
      [40, 620000, 5200000, r8 ? 380000n : 0n, r8 ? 0n : 380000n],
      [72, 600000, 5200000, r8 ? 480000n : 0n, r8 ? 0n : 380000n],
      [72, 620001, 9200000, 0n, 260000n],
      [72, 620001, 9800000, 0n, 130000n],
      [72, 620001, 10000001, 0n, 0n],
      [72, 950000, 5200000, 0n, 380000n],
      [72, 950001, 5200000, 0n, 360000n],
    ];
    if (year === 2025) spouseCases.push(
      [72, 580000, 5200000, 480000n, 0n],
      [72, 580001, 5200000, 0n, 380000n]
    );
    for (const [age, income, self, expected, expectedSpecial] of spouseCases) {
      const spouse = { exists: true, ageAtYearEnd: age, totalIncome: yen(income) };
      const actual = engine.calculateSpouseDeduction(yen(self), spouse, options);
      const special = engine.calculateSpouseSpecialDeduction(yen(self), spouse, options);
      assert(amount(actual) === expected && amount(special) === expectedSpecial,
        label + ': ' + year + '年・配偶者' + age + '歳/' + income + '円・本人' + self +
        '円 → 配偶者控除' + expected + '円/特別' + expectedSpecial + '円');
    }

    const dependentCases = [
      [30, 620000, 'child', false, 'dependent', r8 ? 'general' : 'income_over_limit', r8 ? 380000n : 0n],
      [30, 620001, 'child', false, 'dependent', 'income_over_limit', 0n],
      [20, 620000, 'child', false, r8 ? 'dependent' : 'specific_relative_special',
        r8 ? 'specific' : 'specific_relative_special', 630000n],
      [20, 620001, 'child', false, 'specific_relative_special', 'specific_relative_special', 630000n],
      [20, 850000, 'child', false, 'specific_relative_special', 'specific_relative_special', 630000n],
      [20, 850001, 'child', false, 'specific_relative_special', 'specific_relative_special', 610000n],
      [75, 620000, 'parent', true, 'dependent', r8 ? 'elderly_cohabiting' : 'income_over_limit', r8 ? 580000n : 0n],
      [75, 620001, 'parent', true, 'dependent', 'income_over_limit', 0n],
      [30, 600000, 'child', false, 'dependent', r8 ? 'general' : 'income_over_limit', r8 ? 380000n : 0n],
      [20, 600000, 'child', false, r8 ? 'dependent' : 'specific_relative_special',
        r8 ? 'specific' : 'specific_relative_special', 630000n],
    ];
    if (year === 2025) dependentCases.push(
      [20, 580000, 'child', false, 'dependent', 'specific', 630000n],
      [20, 580001, 'child', false, 'specific_relative_special', 'specific_relative_special', 630000n]
    );
    for (const [age, income, relation, livesTogether, kind, category, expected] of dependentCases) {
      const result = engine.calculateDependentDeductions([
        { id: 'stage3', ageAtYearEnd: age, relation, livesTogether, totalIncome: yen(income) },
      ], options);
      const row = result.rows[0];
      assert(result.status === 'complete' && result.rows.length === 1 && row.kind === kind &&
        row.category === category && amount(row.amount) === expected && amount(result.total) === expected,
      label + ': ' + year + '年・親族' + age + '歳/' + income + '円 → ' + kind + '/' + category + '/' + expected + '円');
    }
  }
}

{
  const records = stage3MasterFiles.flatMap(file => JSON.parse(fs.readFileSync(file, 'utf8')).records)
    .filter(record => stage3RecordIds.includes(record.record_id));
  const approvedCount = records.filter(record => record.data_review_status === 'approved').length;
  if (records.length === 12 && approvedCount === 12) {
    checkStage3Examples(deductionsEngine, '本物のデータ');
  } else {
    assert(false, '段 3 の 12 件がまとめて承認されていない（承認済み ' + approvedCount + ' 件）');
  }
}

/** ファイルは書かずに差し替え、読取関数・モジュールキャッシュを必ず元に戻す。 */
function loadStage3Deductions(changeRecords = () => {}) {
  const snapshotPath = require.resolve('../../../src/tax-engine/masters/snapshot.js');
  const deductionsPath = require.resolve('../../../src/tax-engine/income/income-deductions.js');
  const targetFiles = new Set(stage3MasterFiles.map(file => path.normalize(file)));
  const originalReadFileSync = fs.readFileSync;
  const originalCache = new Map(Object.entries(require.cache));
  const originalChildren = new Map([...originalCache].map(([id, entry]) => [id, entry.children.slice()]));
  // スナップショットを読むモジュールと、その呼出元も読み直しの対象にする。
  const affected = new Set([snapshotPath, deductionsPath]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, entry] of originalCache) {
      if (!affected.has(id) && entry.children.some(child => affected.has(child.id))) {
        affected.add(id);
        changed = true;
      }
    }
  }
  for (const id of affected) delete require.cache[id];
  try {
    fs.readFileSync = function readStage3Master(file, ...args) {
      const source = originalReadFileSync.call(fs, file, ...args);
      if (!targetFiles.has(path.normalize(String(file)))) return source;
      const document = JSON.parse(source);
      for (const record of document.records) {
        if (stage3RecordIds.includes(record.record_id)) record.data_review_status = 'approved';
      }
      changeRecords(document.records);
      const replaced = JSON.stringify(document);
      return Buffer.isBuffer(source) ? Buffer.from(replaced, 'utf8') : replaced;
    };
    return require(deductionsPath);
  } finally {
    fs.readFileSync = originalReadFileSync;
    for (const id of Object.keys(require.cache)) {
      if (!originalCache.has(id)) delete require.cache[id];
    }
    for (const [id, entry] of originalCache) {
      entry.children = originalChildren.get(id);
      require.cache[id] = entry;
    }
  }
}

function stage3Throws(action, message) {
  try {
    action();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(message);
  }
}

console.log('\n=== 段3: 差し替えデータ（B0〜B7） ===');
{
  const readFileSyncBefore = fs.readFileSync;
  const snapshotBefore = require('../../../src/tax-engine/masters/snapshot.js');
  const b0 = loadStage3Deductions();
  checkStage3Examples(b0, 'B0');

  const spouse = { exists: true, ageAtYearEnd: 72, totalIncome: yen(600000) };
  const spouseCalc = (engine, year) => engine.calculateSpouseDeduction(yen(5200000), spouse, { taxYear: year });
  const b1 = loadStage3Deductions(records => {
    for (const record of records) {
      if (/^IDED-SPOUSE-SP-R8-S01-T[1-4]$/.test(record.record_id)) record.data_review_status = 'unverified';
    }
  });
  assert(stage3Throws(() => spouseCalc(b1, 2026), '一意に決まりません'),
    'B1: 2026年の最下段が未承認なら止まる');
  assert(amount(spouseCalc(b1, 2025)) === 0n, 'B1: 2025年の計算は0円で止まらない');

  const b2 = loadStage3Deductions(records => {
    for (const record of records) {
      if (/^IDED-SPOUSE-SP-S01-T[1-4]$/.test(record.record_id)) record.effective_to = null;
    }
  });
  assert(stage3Throws(() => spouseCalc(b2, 2026), '一意に決まりません'),
    'B2: 配偶者特別控除の2世代が重なると止まる');

  const b3 = loadStage3Deductions(records => {
    const record = records.find(item => item.record_id === 'IDED-SPECREL-T00');
    if (record) record.effective_to = null;
  });
  assert(stage3Throws(() => b3.calculateDependentDeductions([
    { id: 'b3', ageAtYearEnd: 30, totalIncome: yen(600000) },
  ], { taxYear: 2026 }), '一意に決まりません'), 'B3: 扶養の0円の段が重なると止まる');

  const b4 = loadStage3Deductions(records => {
    const record = records.find(item => item.record_id === 'IDED-SPECREL-R8-T01');
    if (record) record.data_review_status = 'unverified';
  });
  assert(stage3Throws(() => b4.calculateDependentDeductions([
    { id: 'b4', ageAtYearEnd: 20, totalIncome: yen(700000) },
  ], { taxYear: 2026 }), '特定親族特別控除の段がありません: 700000'), 'B4: 特定親族の段が欠けると止まる');
  const eligible = b4.calculateDependentDeductions([
    { id: 'b4-zero', ageAtYearEnd: 20, totalIncome: yen(0) },
  ], { taxYear: 2026 });
  assert(eligible.rows[0].kind === 'dependent' && eligible.rows[0].category === 'specific' &&
    amount(eligible.rows[0].amount) === 630000n, 'B4: 所得0円は特定扶養63万円で止まらない');

  const b5 = loadStage3Deductions(records => {
    const record = records.find(item => item.record_id === 'IDED-SPECREL-R8-T00');
    if (record) record.data_review_status = 'unverified';
  });
  const dependent = { id: 'b5', ageAtYearEnd: 30, totalIncome: yen(0) };
  assert(stage3Throws(() => b5.calculateDependentDeductions([dependent], { taxYear: 2026 }),
    '特定親族特別控除の所得要件を取得できません'), 'B5: 2026年の0円の段が未承認なら止まる');
  const previousYear = b5.calculateDependentDeductions([dependent], { taxYear: 2025 });
  assert(amount(previousYear.total) === 380000n, 'B5: 2025年の同じ親族は扶養控除38万円で止まらない');

  const b6 = loadStage3Deductions(records => {
    const record = records.find(item => item.record_id === 'IDED-SPOUSE-SP-S02-T1');
    if (record) {
      const lower = record.applicability_conditions.find(condition =>
        condition.subject === 'spouse_total_income' && condition.operator === 'gte');
      lower.value.value = '600000';
    }
  });
  assert(stage3Throws(() => spouseCalc(b6, 2026), '一意に決まりません'),
    'B6: 最下段の下限が全記録の最小値と異なると止まる');

  const b7 = loadStage3Deductions(records => {
    const record = records.find(item => item.record_id === 'IDED-SPOUSE-SP-R8-S01-T2');
    if (record) record.data_review_status = 'unverified';
  });
  const specialCalc = (self, income) => b7.calculateSpouseSpecialDeduction(yen(self),
    { exists: true, totalIncome: yen(income) }, { taxYear: 2026 });
  assert(stage3Throws(() => specialCalc(9200000, 700000), '本人の所得の段がありません: 9200000'),
    'B7: 配偶者の所得に当たる表で本人の段が欠けると止まる');
  assert(amount(specialCalc(5200000, 700000)) === 380000n,
    'B7: 本人520万円の段は38万円で止まらない');
  assert(amount(specialCalc(5200000, 600000)) === 0n,
    'B7: 配偶者60万円は配偶者特別控除の表に当たらず0円で止まらない');

  assert(fs.readFileSync === readFileSyncBefore &&
    require('../../../src/tax-engine/income/income-deductions.js') === deductionsEngine &&
    require('../../../src/tax-engine/masters/snapshot.js') === snapshotBefore,
  'B0〜B7の後は読取関数と本物のモジュールキャッシュに戻る');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
