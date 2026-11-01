'use strict';

/**
 * 住民税エンジンの検証。
 *   node scripts/lib/__tests__/test-resident-tax-engine.js
 *
 * 固定したい要点。
 *   - 住民税の基礎控除は43万円のまま（所得税の令和7年分95万〜63万と違う）
 *   - 調整控除の3つの顔: 200万円以下の min、200万円超の5万円の下限、
 *     合計所得2,500万円超の適用なし
 *   - 非課税限度額の扶養親族には16歳未満も数える（所得税の扶養控除と違う）
 *   - 指定都市は市・県の按分が変わるだけで合計は変わらない
 *   - 100円未満切捨ては市・県それぞれで行う
 */

const rt = require('../../../src/tax-engine/resident-tax/resident-tax.js');
const income = require('../../../src/tax-engine/income/index.js');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const yen = (v) => ({ unit: 'JPY', value: BigInt(v) });
const JUR = { municipalityCode: '13113', isDesignatedCity: false };
const calc = (input, options = {}) => rt.calculate(
  { jurisdiction: JUR, deductions: {}, ...input },
  { incomeYear: 2025, ...options }
);

console.log('\n=== 住民税エンジン: 基礎控除が所得税と違う ===');
{
  // 同じ合計所得500万円で、所得税は63万円（令和7年分の上乗せ）・住民税は43万円。
  // 「所得税の課税所得へ住民税率を乗じる」誤りをこの差で検出する（§10）。
  const incomeTaxBasic = income.deductions.calculateBasicDeduction(yen(5000000), { taxYear: 2025 });
  const result = calc({
    previousYearTotalIncome: yen(5000000),
    deductions: { socialInsurance: { kind: 'total', annualTotal: yen(1000000) } },
  });
  assert(incomeTaxBasic.value === 630000n, '所得税の基礎控除は63万円（令和7年分）');
  assert(result.taxableTotalIncome.value === 3570000n,
    '住民税の課税所得は357万円（＝基礎控除43万円が効いている）');
}

console.log('\n=== 住民税エンジン: C-12の給与所得の端数 ===');
{
  const result = calc({ salaryRevenue: yen(8499999) });
  assert(result.status === 'complete' && result.salaryIncome.value === 6549999n,
    'C-12: 給与8,499,999円の住民税計算に使う給与所得は6,549,999円');
}

console.log('\n=== 住民税エンジン: 全工程（ゴールデンと同値） ===');
{
  const r = calc({
    previousYearTotalIncome: yen(5000000),
    deductions: { socialInsurance: { kind: 'total', annualTotal: yen(1000000) } },
  });
  assert(r.status === 'complete', '計算が完了する');
  assert(r.municipalIncomeLevy.value === 212700n && r.prefecturalIncomeLevy.value === 141800n,
    '所得割は市212,700円・県141,800円（調整控除の5万円下限が効く）');
  assert(r.municipalAdjustmentDeduction.value === 1500n && r.prefecturalAdjustmentDeduction.value === 1000n,
    '調整控除は市1,500円・県1,000円（下限5万円×3%/2%）');
  assert(r.perCapitaLevyTotal.value === 4000n && r.forestEnvironmentTax.value === 1000n,
    '均等割4,000円＋森林環境税1,000円');
  assert(r.annualTaxTotal.value === 359500n, '年税額359,500円');
}

console.log('\n=== 住民税エンジン: 調整控除の3つの顔 ===');
{
  // 200万円以下: min(人的控除差, 課税所得) が課税所得側に倒れる例。
  // 合計所得47万 → 課税所得4万 → min(5万, 4万)=4万 → 市1,200円・県800円
  const low = calc({ previousYearTotalIncome: yen(470000) });
  assert(low.municipalAdjustmentDeduction.value === 1200n
    && low.prefecturalAdjustmentDeduction.value === 800n,
    '200万円以下では min(人的控除差, 課税所得) — 課税所得4万円側が効く');

  // 200万円超で下限が効かない例。配偶者＋扶養で人的控除差15万円、
  // 課税所得205万 → {15万 − 5万} = 10万 > 5万 → 市3,000円・県2,000円
  const mid = calc({
    previousYearTotalIncome: yen(3140000),
    spouse: { exists: true, ageAtYearEnd: 40, totalIncome: yen(400000) },
    dependents: [{ id: 'd1', relation: 'child', ageAtYearEnd: 17 }],
  });
  assert(mid.taxableTotalIncome.value === 2050000n,
    '課税所得205万円（基礎43万＋配偶者33万＋扶養33万）');
  assert(mid.municipalAdjustmentDeduction.value === 3000n
    && mid.prefecturalAdjustmentDeduction.value === 2000n,
    '200万円超・下限が効かない側: {15万−5万}=10万 → 市3,000円・県2,000円');

  // 合計所得2,500万円超: 調整控除なし（令和3年度以後）
  const rich = calc({ previousYearTotalIncome: yen(26000000) });
  assert(rich.municipalAdjustmentDeduction.value === 0n
    && rich.prefecturalAdjustmentDeduction.value === 0n,
    '合計所得2,500万円超は調整控除なし');
}

console.log('\n=== 住民税エンジン: 指定都市 ===');
{
  const ordinary = calc({
    previousYearTotalIncome: yen(5000000),
    deductions: { socialInsurance: { kind: 'total', annualTotal: yen(1000000) } },
  });
  const designated = rt.calculate({
    jurisdiction: { municipalityCode: '14100', isDesignatedCity: true },
    previousYearTotalIncome: yen(5000000),
    deductions: { socialInsurance: { kind: 'total', annualTotal: yen(1000000) } },
  }, { incomeYear: 2025 });
  assert(designated.annualTaxTotal.value === ordinary.annualTaxTotal.value,
    '指定都市でも年税額の合計は同じ（按分だけが変わる）');
  assert(designated.municipalIncomeLevy.value === 283600n
    && designated.prefecturalIncomeLevy.value === 70900n,
    '指定都市は市8%/県2%・調整控除4%/1%の按分（市283,600円・県70,900円）');
}

console.log('\n=== 住民税エンジン: 非課税限度額 ===');
{
  const exempt = calc({ previousYearTotalIncome: yen(440000) });
  assert(exempt.annualTaxTotal.value === 0n, '単身・所得44万円は全額0円（限度額45万円）');
  assert(exempt.forestEnvironmentTax.value === 0n, '均等割非課税なら森林環境税も0円');
  assert(exempt.warnings.some(w => w.code === 'RT_EXEMPTION_STANDARD_AMOUNT_ESTIMATE'),
    '基本額35万円は級地で下がりうる標準額のため概算警告が付く');

  const taxed = calc({ previousYearTotalIncome: yen(460000) });
  assert(taxed.annualTaxTotal.value === 6500n,
    '所得46万円は課税（所得割1,500円＋均等割4,000円＋森林1,000円＝6,500円）');

  // 扶養1人（10歳）: 限度額 35万×2＋10万＋21万 ＝ 101万円。
  // 16歳未満は所得控除の対象外だが、非課税判定の人数には数える。
  const dep10 = (v) => calc({
    previousYearTotalIncome: yen(v),
    dependents: [{ id: 'd1', relation: 'child', ageAtYearEnd: 10 }],
  });
  assert(dep10(1010000).annualTaxTotal.value === 0n,
    '10歳の扶養親族1人・所得101万円は非課税（16歳未満も人数に入る）');
  assert(dep10(1020000).annualTaxTotal.value > 0n,
    '所得102万円は課税側');
}

console.log('\n=== 住民税エンジン: 属性による非課税 ===');
{
  const disabled = calc({
    previousYearTotalIncome: yen(1350000),
    self: { disability: 'general' },
  });
  assert(disabled.annualTaxTotal.value === 0n,
    '障害者・合計所得135万円ちょうどは非課税（24条の5・295条）');
  const over = calc({
    previousYearTotalIncome: yen(1350001),
    self: { disability: 'general' },
  });
  assert(over.annualTaxTotal.value > 0n, '135万1円は課税側');
}

console.log('\n=== 住民税エンジン: 100円未満切捨て ===');
{
  // 合計所得46.1万 → 課税所得3.1万 → 市1,860−930=930→900円・県1,240−620=620→600円
  const r = calc({ previousYearTotalIncome: yen(461000) });
  assert(r.municipalIncomeLevy.value === 900n && r.prefecturalIncomeLevy.value === 600n,
    '市930→900円・県620→600円（それぞれで100円未満切捨て）');
}

console.log('\n=== GC-YH-DEDUCTIONS2-500K: 住民税単体 ===');
{
  const deductionInput = donation => ({
    previousYearTotalIncome: yen(4360000),
    self: { disability: 'general' },
    spouse: { exists: true, ageAtYearEnd: 40, totalIncome: yen(0) },
    dependents: [
      { id: 'specific-1', ageAtYearEnd: 20, relation: 'child', totalIncome: yen(0) },
      { id: 'general-1', ageAtYearEnd: 17, relation: 'child', totalIncome: yen(0) },
    ],
    deductions: {
      socialInsurance: { kind: 'total', annualTotal: yen(894000) },
      smallEnterpriseMutualAid: yen(276000),
      lifeInsurance: [
        { generation: 'new', category: 'life', annualPremium: yen(120000) },
        { generation: 'new', category: 'nursing_medical', annualPremium: yen(80000) },
      ],
      earthquakeInsurance: [{ category: 'earthquake', annualPremium: yen(50000) }],
      donations: [{ kind: 'furusato', amount: yen(donation) }],
    },
    incomeTaxTaxableTotalIncome: yen(702000),
    unappliedHousingLoanCredit: yen(64900),
  });
  const result = calc(deductionInput(20000));
  assert(result.incomeDeductions.lifeInsurance.value === 56000n &&
    result.incomeDeductions.earthquakeInsurance.value === 25000n,
  '住民税の生保5.6万円・地震2.5万円をマスター表から計算する');
  assert(result.taxableTotalIncome.value === 1309000n &&
    result.municipalAdjustmentDeduction.value + result.prefecturalAdjustmentDeduction.value === 17000n,
  '課税所得130.9万円・調整控除1.7万円になる');
  assert(result.donationCredit.basis.value === 969000n &&
    result.donationCredit.specialRate.num * 100n / result.donationCredit.specialRate.den === 85n,
  '特例控除率は人的控除差後96.9万円の条文表85%帯を使う');
  assert(result.donationCredit.prefecturalBasic.value === 720n &&
    result.donationCredit.municipalBasic.value === 1080n &&
    result.donationCredit.prefecturalSpecial.value === 6120n &&
    result.donationCredit.municipalSpecial.value === 9180n,
  '寄附金税額控除を基本720/1,080円・特例6,120/9,180円へ按分する');
  assert(result.housingLoanCredit.incomeBasedLimit.value === 35100n &&
    result.housingLoanCredit.amount.value === 35100n &&
    result.housingLoanCredit.prefectural.value === 14040n &&
    result.housingLoanCredit.municipal.value === 21060n,
  '住宅ローン控除は所得税課税所得×5%の35,100円で頭打ちにして按分する');
  assert(result.prefecturalIncomeLevy.value === 24600n &&
    result.municipalIncomeLevy.value === 37000n && result.annualTaxTotal.value === 66600n,
  '全控除後に100円未満を切り捨て、県24,600円・区37,000円・年税66,600円になる');

  const overCap = calc(deductionInput(52000));
  assert(overCap.donationCredit.specialBeforeCap.value === 42500n &&
    overCap.donationCredit.special.value === 22780n && overCap.donationCredit.capReached,
  '寄附52,000円では特例控除42,500円を上限22,780円で止める');
  assert(overCap.warnings.some(warning =>
    warning.code === 'RT_FURUSATO_SPECIAL_CREDIT_CAP_REACHED' &&
    warning.message.includes('自己負担額が2,000円を超えます')),
  '上限到達時に自己負担が2,000円を超える警告を返す');
}

console.log('\n=== 住民税エンジン: blocked ===');
{
  const r = rt.calculate({ previousYearTotalIncome: yen(5000000), deductions: {} },
    { incomeYear: 2025 });
  assert(r.status === 'blocked' &&
    r.blockedReasons.some(x => x.code === 'RT_MUNICIPALITY_CODE_REQUIRED'),
    '市区町村コードが無ければ blocked（§3-2 の粒度表）');
}

console.log('\n=== C-15: 配偶者の所得だけで控除を判定する ===');
{
  const cases = [
    [0, 330000, 0, 526500], [580000, 330000, 0, 526500],
    [580001, 0, 330000, 526500], [1000000, 0, 330000, 526500],
    [1000001, 0, 310000, 528500], [1300000, 0, 60000, 553500],
    [1300001, 0, 30000, 556500], [1330000, 0, 30000, 556500],
    [1330001, 0, 0, 559500], [2000000, 0, 0, 559500],
  ];
  for (const [spouseIncome, spouse, special, annual] of cases) {
    const r = calc({ previousYearTotalIncome: yen(6000000),
      spouse: { exists: true, totalIncome: yen(spouseIncome) } });
    for (const [label, actual, expected] of [
      ['配偶者控除', r.incomeDeductions.spouse.value, spouse],
      ['配偶者特別控除', r.incomeDeductions.spouseSpecial.value, special],
      ['年税額', r.annualTaxTotal.value, annual],
    ]) assert(actual === BigInt(expected),
      `配偶者所得${spouseIncome}円: ${label}は${expected}円 (実際${actual}円)`);
  }
  for (const [spouseIncome, spouse, special] of [[580000, 380000, 0], [580001, 0, 330000]]) {
    const r = calc({ previousYearTotalIncome: yen(6000000),
      spouse: { ageAtYearEnd: 71, totalIncome: yen(spouseIncome) } });
    assert(r.incomeDeductions.spouse.value === BigInt(spouse) &&
      r.incomeDeductions.spouseSpecial.value === BigInt(special),
    `71歳・所得${spouseIncome}円: 配偶者${spouse}円・特別${special}円`);
  }
  for (const [taxpayer, spouseIncome, expected] of [[9500000, 1000000, 220000],
    [10000001, 1000000, 0], [10000001, 0, 0]]) {
    const r = calc({ previousYearTotalIncome: yen(taxpayer), spouse: { totalIncome: yen(spouseIncome) } });
    assert(r.incomeDeductions.spouseSpecial.value === BigInt(expected) &&
      r.incomeDeductions.spouse.value === 0n,
    `本人${taxpayer}円・配偶者${spouseIncome}円: 配偶者特別控除${expected}円`);
  }
  for (const flags of [{ claimsSpouseSpecialDeduction: true }, { deductionType: 'special' }]) {
    const low = calc({ previousYearTotalIncome: yen(6000000), spouse: { totalIncome: yen(0), ...flags } });
    const high = calc({ previousYearTotalIncome: yen(6000000),
      spouse: { totalIncome: yen(1300000), ...flags } });
    assert(low.incomeDeductions.spouse.value === 330000n &&
      low.incomeDeductions.spouseSpecial.value === 0n &&
      high.incomeDeductions.spouse.value === 0n && high.incomeDeductions.spouseSpecial.value === 60000n,
    `旧指定${Object.keys(flags)[0]}があっても所得で決める`);
  }
  const unknown = calc({ previousYearTotalIncome: yen(6000000), spouse: { exists: true } });
  assert(unknown.deductionDetails.spouse === null && unknown.incomeDeductions.spouse.value === 0n &&
    unknown.incomeDeductions.spouseSpecial.value === 0n, '配偶者の所得なしは従来どおり控除なし');
  const r = calc({ previousYearTotalIncome: yen(2500000), spouse: { totalIncome: yen(900000) } });
  assert(r.taxableTotalIncome.value === 1740000n && r.adjustmentDifference.value === 50000n &&
    r.municipalAdjustmentDeduction.value === 1500n && r.prefecturalAdjustmentDeduction.value === 1000n &&
    r.annualTaxTotal.value === 176500n,
  `本人250万円・配偶者90万円: 課税174万円、差5万円、市調整1500円・県1000円、年税176500円 (実際${r.annualTaxTotal.value}円)`);
  assert(!r.warnings.some(w => w.code === 'RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED'),
    '配偶者特別控除の人的控除差0円を未登録と警告しない');
}

console.log('\n=== C-15: 親族の所得要件・人的控除差 ===');
{
  const cases = [[17, 580000, 'dependent', 'general', 330000],
    [17, 580001, 'dependent', 'income_over_limit', 0],
    [20, 580000, 'dependent', 'specific', 450000],
    [20, 580001, 'specificRelativeSpecial', 'specific_relative_special', 450000],
    [20, 950001, 'specificRelativeSpecial', 'specific_relative_special', 410000],
    [20, 1230001, 'specificRelativeSpecial', 'specific_relative_special', 0],
    [17, undefined, 'dependent', 'general', 330000]];
  for (const [age, total, kind, category, amount] of cases) {
    const r = calc({ previousYearTotalIncome: yen(6000000), dependents: [{ id: 'child',
      ageAtYearEnd: age, ...(total === undefined ? {} : { totalIncome: yen(total) }) }] });
    const row = r.deductionDetails.dependents[0];
    assert(row.id === 'child' && row.kind === kind && row.category === category &&
      row.amount.value === BigInt(amount),
    `${age}歳・所得${total ?? 'なし'}円: ${kind}/${category} ${amount}円 (実際${row.amount.value}円)`);
    if (total === 580001 || total === 1230001) assert(row.differenceSuffix === null,
      `${age}歳・所得${total}円: 人的控除差の対象外`);
  }
  for (const [total, expected] of [[580000, 230000], [580001, 50000]]) {
    const r = calc({ previousYearTotalIncome: yen(6000000),
      dependents: [{ id: 'child', ageAtYearEnd: 20, totalIncome: yen(total) }] });
    assert(r.adjustmentDifference.value === BigInt(expected),
      `20歳・所得${total}円: 基礎と特定扶養の人的控除差は${expected}円`);
    assert(!r.warnings.some(w => w.code === 'RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED'),
      `20歳・所得${total}円: 特定親族特別控除の差0円に警告なし`);
  }
  for (const [age, total, expectedKind, amount] of [[17, 580001, 'dependent', 0],
    [20, 580000, 'dependent', 450000], [20, 580001, 'specificRelativeSpecial', 450000]]) {
    const r = calc({ previousYearTotalIncome: yen(6000000), dependents: [{ id: 'flag',
      ageAtYearEnd: age, totalIncome: yen(total), claimsSpecificRelativeSpecialDeduction: true }] });
    const row = r.deductionDetails.dependents[0];
    assert(row.kind === expectedKind && row.amount.value === BigInt(amount),
      `特定親族の旧指定があっても${age}歳・所得${total}円で判定する`);
  }
  const overlap = calc({ previousYearTotalIncome: yen(6000000), dependents: [{ id: 'both',
    ageAtYearEnd: 20, totalIncome: yen(580001), claimsDependentDeduction: true,
    claimsSpecificRelativeSpecialDeduction: true }] });
  assert(overlap.status === 'blocked' && overlap.blockedReasons.some(reason =>
    reason.code === 'RT_DEPENDENT_SPECIFIC_RELATIVE_OVERLAP'), '扶養と特定親族の重複指定は引き続き止める');
}

console.log('\n=== C-15: 非課税人数は同一生計配偶者・扶養親族だけ ===');
{
  const exemption = input => rt.calculateExemption(input, yen(2000000), { taxYear: 2025 });
  for (const [total, count, threshold] of [[0, 2, 1010000], [580000, 2, 1010000],
    [580001, 1, 450000], [undefined, 2, 1010000]]) {
    const r = exemption({ spouse: { exists: true,
      ...(total === undefined ? {} : { totalIncome: yen(total) }) } });
    assert(r.personCount === count && r.threshold.value === BigInt(threshold),
      `配偶者所得${total ?? 'なし'}円: 非課税人数${count}人・限度額${threshold}円`);
  }
  for (const age of [10, 17, 20]) {
    for (const [total, count, threshold] of [[580000, 2, 1010000], [580001, 1, 450000],
      [undefined, 2, 1010000]]) {
      const r = exemption({ dependents: [{ ageAtYearEnd: age,
        ...(total === undefined ? {} : { totalIncome: yen(total) }) }] });
      assert(r.personCount === count && r.threshold.value === BigInt(threshold),
        `${age}歳・所得${total ?? 'なし'}円: 非課税人数${count}人・限度額${threshold}円`);
    }
  }
  const excluded = exemption({ spouse: { exists: false, totalIncome: yen(0) },
    dependents: [{ ageAtYearEnd: 10, totalIncome: yen(0), countsForResidentTaxExemption: false }] });
  assert(excluded.personCount === 1, '既存の人数除外指定を維持する');
}

console.log('\n=== C-15: 障害者控除と人的控除差の所得要件 ===');
{
  for (const who of ['spouse', 'dependent', 'childUnder16', 'specificRelative']) {
    for (const [total, expected] of [[580000, 260000], [580001, 0], [undefined, 260000]]) {
      const person = { id: who, disability: 'general',
        ...(total === undefined ? {} : { totalIncome: yen(total) }) };
      const input = who === 'spouse' ? { spouse: person } : { dependents: [{ ...person,
        ageAtYearEnd: who === 'childUnder16' ? 10 : who === 'specificRelative' ? 20 : 17 }] };
      const r = calc({ previousYearTotalIncome: yen(6000000), ...input });
      assert(r.incomeDeductions.disability.value === BigInt(expected) &&
        r.deductionDetails.disabilities.length === (expected > 0 ? 1 : 0),
      `${who}・所得${total ?? 'なし'}円: 障害者控除${expected}円`);
      const diff = r.adjustmentDifferenceDetails.filter(row => row.code === 'disability')
        .reduce((sum, row) => sum + row.amount.value, 0n);
      assert(diff === (expected > 0 ? 10000n : 0n),
        `${who}・所得${total ?? 'なし'}円: 障害者の人的控除差も連動する`);
    }
  }
  for (const total of [6000000, 30000000]) {
    const r = calc({ previousYearTotalIncome: yen(total), self: { id: 'self', disability: 'general' } });
    assert(r.incomeDeductions.disability.value === 260000n &&
      r.adjustmentDifferenceDetails.some(row => row.code === 'disability' && row.amount.value === 10000n),
    `本人所得${total}円: 障害者控除26万円と人的控除差1万円は本人所得で除かない`);
  }
}

/** 記録の異常はメモリ内だけで作り、キャッシュを必ず戻す。 */
function loadC15Resident(changeRecords) {
  const snapshotPath = require.resolve('../../../src/tax-engine/masters/snapshot.js');
  const residentPath = require.resolve('../../../src/tax-engine/resident-tax/resident-tax.js');
  const real = require(snapshotPath);
  const originalCache = new Map(Object.entries(require.cache));
  const originalChildren = new Map([...originalCache].map(([id, entry]) => [id, entry.children.slice()]));
  const originalExports = require.cache[snapshotPath].exports;
  try {
    require.cache[snapshotPath].exports = Object.assign({}, real, {
      find(key, searchCriterion) {
        return changeRecords(key, real.find(key, searchCriterion).map(record => structuredClone(record)));
      },
    });
    delete require.cache[residentPath];
    return require(residentPath);
  } finally {
    require.cache[snapshotPath].exports = originalExports;
    for (const id of Object.keys(require.cache)) if (!originalCache.has(id)) delete require.cache[id];
    for (const [id, entry] of originalCache) { entry.children = originalChildren.get(id); require.cache[id] = entry; }
  }
}
function c15Throws(action, message) {
  try { action(); return false; } catch (error) { return error instanceof Error && error.message.includes(message); }
}
console.log('\n=== C-15: 所得要件の記録の欠け・重なりでは停止する ===');
{
  const relativeKey = 'resident_tax_deduction_specific_relative_special';
  const spouseKey = 'resident_tax_deduction_spouse_special';
  const run = (engine, input) => engine.calculate({ jurisdiction: JUR, deductions: {},
    previousYearTotalIncome: yen(6000000), ...input }, { incomeYear: 2025 });
  for (const mode of ['missing', 'duplicate']) {
    const engine = loadC15Resident((key, records) => {
      if (key !== relativeKey) return records;
      const zero = records.find(row => row.calculation_order === 0);
      return mode === 'missing' ? records.filter(row => row.calculation_order !== 0)
        : [...records, { ...zero, record_id: zero.record_id + '-DUP' }];
    });
    const expected = mode === 'missing' ? '特定親族特別控除の所得要件を取得できません'
      : '特定親族特別控除の所得要件（0円の段）が一意に決まりません';
    assert(c15Throws(() => run(engine, { dependents: [{ ageAtYearEnd: 20, totalIncome: yen(580001) }] }), expected),
      `特定親族の0円の段が${mode}なら止まる`);
    assert(run(engine, {}).status === 'complete', '親族0人なら所得要件の任意記録を引かない');
  }
  for (const mode of ['missing', 'ambiguous', 'notMinimum']) {
    const engine = loadC15Resident((key, records) => {
      if (key !== spouseKey) return records;
      if (mode === 'missing') return records.filter(row => row.deduction_category !== 'spouse_special_s1');
      const record = records.find(row => row.deduction_category === 'spouse_special_s1');
      const target = mode === 'ambiguous' ? record
        : records.find(row => row.deduction_category !== 'spouse_special_s1');
      const lower = target.applicability_conditions.find(c => c.subject === 'spouse_total_income' && c.operator === 'gte');
      lower.value.value = mode === 'ambiguous' ? '580002' : '580000';
      return records;
    });
    assert(c15Throws(() => run(engine, { spouse: { totalIncome: yen(0) } }),
      '配偶者特別控除の最下段（配偶者の所得要件）が一意に決まりません'),
    `配偶者の最下段が${mode}なら止まる`);
  }
  const gap = loadC15Resident((key, records) => key === relativeKey
    ? records.filter(row => row.calculation_order === 0) : records);
  assert(c15Throws(() => run(gap, { dependents: [{ ageAtYearEnd: 20, totalIncome: yen(580001) }] }),
    '特定親族特別控除の段がありません: 580001'), '所得に対応する特定親族の段が欠けたら0円で通さず止まる');
  assert(require('../../../src/tax-engine/resident-tax/resident-tax.js') === rt,
    '異常記録の試験後は本物の住民税モジュールに戻る');
}


console.log('\n=== C-15記録: 所得年ごとの58万円・62万円の境界 ===');
for (const [year, total, spouse, special] of [
  [2025, 580000, 330000n, 0n], [2025, 580001, 0n, 330000n],
  [2026, 580001, 330000n, 0n], [2026, 620000, 330000n, 0n],
  [2026, 620001, 0n, 330000n],
]) {
  const r = calc({ previousYearTotalIncome: yen(6000000),
    spouse: { exists: true, totalIncome: yen(total) } }, { incomeYear: year });
  assert(r.status === 'complete', year + '年・配偶者所得' + total + '円の計算が完了する');
  for (const [label, actual, expected] of [
    ['配偶者控除', r.incomeDeductions.spouse.value, spouse],
    ['配偶者特別控除', r.incomeDeductions.spouseSpecial.value, special],
    ['年税額', r.annualTaxTotal.value, 526500n],
  ]) assert(actual === expected,
    year + '年・配偶者所得' + total + '円: ' + label + 'は' + expected + '円 (実際' + actual + '円)');
}
for (const [year, boundary] of [[2025, 580000], [2026, 620000]]) {
  for (const [age, total, kind, amount] of [
    [17, boundary, 'dependent', 330000n], [17, boundary + 1, 'dependent', 0n],
    [20, boundary, 'dependent', 450000n], [20, boundary + 1, 'specificRelativeSpecial', 450000n],
  ]) {
    const r = calc({ previousYearTotalIncome: yen(6000000),
      dependents: [{ id: 'boundary-child', ageAtYearEnd: age, totalIncome: yen(total) }] },
    { incomeYear: year });
    const row = r.deductionDetails.dependents[0];
    assert(r.status === 'complete' && row.kind === kind && row.amount.value === amount,
      year + '年・' + age + '歳・所得' + total + '円: ' + kind + 'は' + amount + '円 (実際' + row.amount.value + '円)');
    assert(r.incomeDeductions.dependents.value === (kind === 'dependent' ? amount : 0n) &&
      r.incomeDeductions.specificRelativeSpecial.value === (kind === 'specificRelativeSpecial' ? amount : 0n),
    year + '年・' + age + '歳・所得' + total + '円: 扶養と特定親族特別控除を重複適用しない');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
