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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
