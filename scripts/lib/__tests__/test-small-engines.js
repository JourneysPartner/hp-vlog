'use strict';

/**
 * 法人成りの個人側で使う小エンジン3本の単体・ゴールデンテスト。
 *   node scripts/lib/__tests__/test-small-engines.js
 */

const fs = require('fs');
const path = require('path');
const nhi = require('../../../src/tax-engine/social-insurance/nhi-premium.js');
const businessTax = require('../../../src/tax-engine/business-tax/individual-business-tax.js');
const pension = require('../../../src/tax-engine/social-insurance/national-pension.js');

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const nhiInput = overrides => ({
  municipalityCode: '13113',
  taxYear: 2026,
  previousYearTotalIncome: '5000000',
  insuredAges: [39],
  ...overrides,
});

console.log('\n=== 国民健康保険料 ===');
{
  const high = nhi.calculate(nhiInput({ previousYearTotalIncome: '30000000' }));
  assert(high.components.medical.amount.value === 670000n && high.components.medical.capped,
    '所得3,000万円では医療分が67万円で頭打ちになる');

  const reduced = nhi.calculate(nhiInput({ previousYearTotalIncome: '430000' }));
  assert(reduced.reduction.tier === '70' &&
    reduced.components.medical.perCapitaLevyBeforeReduction.value === 47600n &&
    reduced.components.medical.fixedLevyAfterReduction.value === 14280n,
  '単身・所得43万円は7割軽減となり均等割が3割残る');

  const halfReduced = nhi.calculate(nhiInput({ previousYearTotalIncome: '500000' }));
  assert(halfReduced.reduction.tier === '50' &&
    halfReduced.components.medical.incomeLevy.value === 5257n &&
    halfReduced.components.medical.fixedLevyAfterReduction.value === 23800n,
  '軽減は均等割だけに適用し、所得割は減額しない');

  const noCare = nhi.calculate(nhiInput({ insuredAges: [39] }));
  const care = nhi.calculate(nhiInput({ insuredAges: [45] }));
  assert(noCare.components.nursing_care.amount.value === 0n &&
    care.components.nursing_care.amount.value > 0n &&
    care.annualPremium.value > noCare.annualPremium.value,
  '45歳の被保険者には介護分が乗る');

  const outside = nhi.calculate(nhiInput({ municipalityCode: '99999' }));
  assert(outside.status === 'blocked' && outside.blockedReasons.some(
    reason => reason.code === 'NHI_MUNICIPAL_RATE_NOT_REGISTERED'
  ), '登録外市町村は理由コード付きblockedになる');
  assert(noCare.notes.some(note => /選んだ自治体の料率による概算/.test(note.message)),
    'completeの結果には選択自治体による概算の注記が付く');
}

console.log('\n=== C-16: 国保の前年度料率 ===');
{
  const priorCode = 'NHI_PRIOR_FISCAL_YEAR_RATE_APPLIED';
  const priorMessage = '国民健康保険料は、令和9年度の料率がまだ登録されていないため、令和8年度の料率（所得割率・均等割額・平等割額・賦課限度額）で計算した概算です。軽減判定の所得基準も令和9年度の改定を反映していない場合があり、令和9年度の実際の保険料とは異なることがあります。';
  const input = nhiInput({ taxYear: 2027, insuredAges: [45] });
  for (const flag of [undefined, false, 'yes', 1]) {
    const result = nhi.calculate({ ...input, allowPriorFiscalYearRate: flag });
    assert(result.status === 'blocked' &&
      result.blockedReasons[0].code === 'NHI_MUNICIPAL_RATE_NOT_REGISTERED' &&
      result.blockedReasons[0].message === '指定した市町村・年度の国民健康保険料率が登録されていません: 13113' &&
      result.blockedReasons[0].taxYear === 2027,
    `前年度料率の指定が${String(flag)}なら2027年度は従来どおり停止する`);
  }
  const prior = nhi.calculate({ ...input, allowPriorFiscalYearRate: true });
  assert(prior.status === 'complete' && prior.taxYear === 2027 && prior.rateFiscalYear === 2026,
    'trueの指定時だけ2027年度の計算に2026年度の自治体料率を使う');
  // 所得500万円・45歳・単身の4区分を手計算で固定する。
  for (const [component, incomeLevy, fixedLevy, amount] of [
    ['medical', 343207n, 47600n, 390807n],
    ['elderly_support', 127960n, 17600n, 145560n],
    ['child_rearing_support', 12339n, 1873n, 14212n],
    ['nursing_care', 111051n, 17800n, 128851n],
  ]) {
    const actual = prior.components[component];
    assert(actual.incomeLevy.value === incomeLevy &&
      actual.fixedLevyAfterReduction.value === fixedLevy && actual.amount.value === amount,
    `前年度代用の${component}は所得割・均等割・合計が手計算と一致する`);
  }
  assert(prior.annualPremium.value === 679430n && prior.totalPremium.value === 679430n,
    '前年度代用の国保年額は4区分合計679,430円になる');
  assert(prior.notes[0].code === priorCode && prior.notes[0].message === priorMessage &&
    prior.notes.filter(note => note.code === priorCode).length === 1,
  '前年度代用の注記は指定本文と完全一致しnotesの先頭に1回だけ付く');
  // 所得500万円・45歳・単身。期待値は指示書F3の手計算をそのまま固定する。
  for (const [municipalityCode, medical, support, child, nursing, total] of [
    ['13113', 390807n, 145560n, 14212n, 128851n, 679430n],
    ['14100', 421551n, 133114n, 17308n, 145988n, 717961n],
    ['23100', 454122n, 133690n, 13653n, 123058n, 724523n],
    ['27100', 503048n, 161878n, 14541n, 137502n, 816969n],
    ['40130', 293477n, 163777n, 14746n, 137188n, 609188n],
    ['01100', 446567n, 133332n, 15353n, 120051n, 715303n],
  ]) {
    const result = nhi.calculate({ ...input, municipalityCode, allowPriorFiscalYearRate: true });
    assert(result.status === 'complete' && result.taxYear === 2027 && result.rateFiscalYear === 2026,
      `F3 自治体${municipalityCode}は2027年度に2026年度料率を代用する`);
    for (const [component, expected] of [
      ['medical', medical], ['elderly_support', support],
      ['child_rearing_support', child], ['nursing_care', nursing],
    ]) {
      assert(result.components[component].amount.value === expected,
        `F3 自治体${municipalityCode}の${component}は手計算${expected}円と一致する`);
    }
    assert(result.annualPremium.value === total,
      `F3 自治体${municipalityCode}の国保合計は手計算${total}円と一致する`);
  }
  const current = nhi.calculate({ ...input, taxYear: 2026, allowPriorFiscalYearRate: true });
  const original = nhi.calculate({ ...input, taxYear: 2026 });
  assert(current.rateFiscalYear === 2026 && current.annualPremium.value === original.annualPremium.value &&
    !current.notes.some(note => note.code === priorCode),
  '当年度の料率があれば指定ありでも金額は変わらず代用注記も付かない');
  for (const overrides of [
    { taxYear: 2028 }, { taxYear: 2025 }, { municipalityCode: '99999' },
  ]) {
    const result = nhi.calculate({ ...input, allowPriorFiscalYearRate: true, ...overrides });
    const reason = result.blockedReasons[0];
    assert(result.status === 'blocked' && reason.code === 'NHI_MUNICIPAL_RATE_NOT_REGISTERED' &&
      reason.taxYear === (overrides.taxYear || 2027),
    `前年度にも登録がない入力は停止する: ${JSON.stringify(overrides)}`);
  }
  const reduced = nhi.calculate({
    ...input, previousYearTotalIncome: '430000', allowPriorFiscalYearRate: true,
  });
  assert(reduced.reduction.tier === '70' &&
    reduced.components.medical.fixedLevyAfterReduction.value === 14280n,
  '前年度代用でも所得43万円は7割軽減・医療分の均等割残額14,280円になる');

  // マスター本体を変えず、年度の参照先と登録途中の挙動を差し替えで確かめる。
  const snapshotPath = require.resolve('../../../src/tax-engine/masters/snapshot.js');
  const enginePath = require.resolve('../../../src/tax-engine/social-insurance/nhi-premium.js');
  const originalSnapshot = require.cache[snapshotPath].exports;
  const originalEngine = require.cache[enginePath];
  function withFind(find, action) {
    try {
      require.cache[snapshotPath].exports = { ...originalSnapshot, find };
      delete require.cache[enginePath];
      action(require(enginePath));
    } finally {
      require.cache[snapshotPath].exports = originalSnapshot;
      require.cache[enginePath] = originalEngine;
    }
  }
  const municipalKey = 'national_health_insurance_municipal_rate';
  const records = originalSnapshot.find(municipalKey, { onDate: '2026-04-01' })
    .filter(record => record.jurisdiction.municipalityCode === '13113');
  for (const fiscalYear of [2026, 2027]) {
    for (const count of [1, 2, 3]) {
      const dates = [];
      withFind((key, criterion) => {
        if (key === municipalKey) {
          dates.push(criterion.onDate);
          return criterion.onDate === `${fiscalYear}-04-01` ? records.slice(0, count) : [];
        }
        return originalSnapshot.find(key, criterion);
      }, engine => {
        let error;
        try { engine.calculate({ ...input, allowPriorFiscalYearRate: true }); }
        catch (caught) { error = caught; }
        assert(error && error.message === '国保料率の4区分がそろっていません: 13113' &&
          dates.length === (fiscalYear === 2027 ? 1 : 2),
        `${fiscalYear}年度の登録が${count}区分なら代用で隠さず例外になる`);
      });
    }
  }
  const nationalDates = [];
  withFind((key, criterion) => {
    if (key !== municipalKey) nationalDates.push(criterion.onDate);
    return originalSnapshot.find(key, criterion);
  }, engine => {
    engine.calculate({ ...input, allowPriorFiscalYearRate: true });
    assert(nationalDates.length === 3 && nationalDates.every(date => date === '2027-04-01'),
      '代用するのは自治体料率だけで基礎控除・軽減基準は2027年度を参照する');
  });
  const municipalDates = [];
  withFind((key, criterion) => {
    if (key === municipalKey) {
      municipalDates.push(criterion.onDate);
      if (criterion.onDate === '2027-04-01') return records;
    }
    return originalSnapshot.find(key, criterion);
  }, engine => {
    const result = engine.calculate({ ...input, allowPriorFiscalYearRate: true });
    assert(result.rateFiscalYear === 2027 && !result.notes.some(note => note.code === priorCode) &&
      municipalDates.length === 1,
    '対象自治体の2027年度料率を登録すれば自動で前年度代用を止める');
    const yokohama = engine.calculate({
      ...input, municipalityCode: '14100', allowPriorFiscalYearRate: true,
    });
    assert(yokohama.status === 'complete' && yokohama.rateFiscalYear === 2026 &&
      yokohama.annualPremium.value === 717961n &&
      yokohama.notes[0].code === priorCode && yokohama.notes[0].message === priorMessage,
    'F6 渋谷区だけ2027年度を登録しても横浜市は前年度代用と注記を続ける');
  });
}

console.log('\n=== 個人事業税 ===');
{
  const notListed = businessTax.calculate({
    businessCategory: 'not_listed', businessIncome: '5000000', businessMonths: 12,
  });
  assert(notListed.status === 'complete' && notListed.taxAmount.value === 0n,
    'not_listedは法定業種外として0円・completeになる');

  const unknown = businessTax.calculate({
    businessCategory: 'unknown', businessIncome: '5000000', businessMonths: 12,
  });
  assert(unknown.status === 'blocked' && unknown.blockedReasons.some(
    reason => reason.code === 'IBT_BUSINESS_CATEGORY_UNKNOWN'
  ), 'unknownは0円扱いせず理由コード付きblockedになる');

  const halfYear = businessTax.calculate({
    businessCategory: 'type1', businessIncome: '5000000', businessMonths: 6,
  });
  assert(halfYear.ownerDeduction.num / halfYear.ownerDeduction.den === 1450000n &&
    halfYear.taxableBase.value === 3550000n,
  '6か月では事業主控除が145万円へ月割される');

  const belowDeduction = businessTax.calculate({
    businessCategory: 'type1', businessIncome: '2900000', businessMonths: 12,
  });
  assert(belowDeduction.taxableBase.value === 0n && belowDeduction.taxAmount.value === 0n,
    '通年所得290万円以下では課税標準・税額が0円になる');
}

console.log('\n=== 国民年金 ===');
{
  const r7 = pension.calculate({ taxYear: 2025 });
  assert(r7.monthlyPremium.value === 17510n && r7.totalPremium.value === 210120n,
    '令和7年度は月額17,510円を基礎に計算する');
  const additional = pension.calculate({ taxYear: 2026, includeAdditionalPremium: true });
  assert(additional.additionalMonthlyPremium.value === 400n &&
    additional.additionalPremium.value === 4800n &&
    additional.totalPremium.value === 219840n,
  '付加保険料は月額400円を納付月数分だけ加算する');
  for (const [field, code] of [
    ['prepaymentDiscount', 'NP_PREPAYMENT_DISCOUNT_UNSUPPORTED'],
    ['exemption', 'NP_EXEMPTION_UNSUPPORTED'],
    ['deferral', 'NP_DEFERRAL_UNSUPPORTED'],
  ]) {
    const result = pension.calculate({ taxYear: 2026, [field]: true });
    assert(result.status === 'blocked' && result.blockedReasons.some(reason => reason.code === code),
      `${field} は第1版対象外としてblockedになる`);
  }
}

console.log('\n=== official-examples の固定期待値 ===');
{
  const document = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
  ), 'utf8'));
  const cases = new Map(document.cases.map(item => [item.case_id, item]));

  const nhiCase = cases.get('GC-NHI-SHIBUYA-500');
  const nhiResult = nhi.calculate({
    municipalityCode: nhiCase.inputs.municipality_code,
    taxYear: nhiCase.inputs.tax_year,
    previousYearTotalIncome: nhiCase.inputs.previous_year_total_income,
    insuredAges: nhiCase.inputs.insured_ages,
  });
  assert(nhiResult.assessmentBase.value === BigInt(nhiCase.expected.assessment_base) &&
    nhiResult.components.medical.incomeLevy.value === BigInt(nhiCase.expected.medical_income_levy) &&
    nhiResult.components.medical.perCapitaLevyBeforeReduction.value ===
      BigInt(nhiCase.expected.medical_per_capita_levy) &&
    nhiResult.components.medical.amount.value === BigInt(nhiCase.expected.medical) &&
    nhiResult.components.elderly_support.incomeLevy.value ===
      BigInt(nhiCase.expected.elderly_support_income_levy) &&
    nhiResult.components.elderly_support.perCapitaLevyBeforeReduction.value ===
      BigInt(nhiCase.expected.elderly_support_per_capita_levy) &&
    nhiResult.components.elderly_support.amount.value === BigInt(nhiCase.expected.elderly_support) &&
    nhiResult.components.child_rearing_support.incomeLevy.value ===
      BigInt(nhiCase.expected.child_rearing_support_income_levy) &&
    nhiResult.components.child_rearing_support.perCapitaLevyBeforeReduction.value ===
      BigInt(nhiCase.expected.child_rearing_support_per_capita_levy) &&
    nhiResult.components.child_rearing_support.amount.value === BigInt(nhiCase.expected.child_rearing_support) &&
    nhiResult.components.nursing_care.amount.value === BigInt(nhiCase.expected.nursing_care) &&
    nhiResult.annualPremium.value === BigInt(nhiCase.expected.annual_premium),
  'GC-NHI-SHIBUYA-500 の区分別・年間期待値と一致する');

  const ibtCase = cases.get('GC-IBT-TYPE3-500');
  const ibtResult = businessTax.calculate({
    businessCategory: ibtCase.inputs.business_category,
    businessIncome: ibtCase.inputs.business_income,
    businessMonths: ibtCase.inputs.business_months,
  });
  assert(ibtResult.ownerDeduction.num / ibtResult.ownerDeduction.den ===
    BigInt(ibtCase.expected.owner_deduction) &&
    ibtResult.taxableBase.value === BigInt(ibtCase.expected.taxable_base) &&
    ibtResult.taxAmount.value === BigInt(ibtCase.expected.tax_amount),
    'GC-IBT-TYPE3-500 は105,000円になる');

  const npCase = cases.get('GC-NP-R8');
  const npResult = pension.calculate({
    taxYear: npCase.inputs.tax_year,
    paymentMonths: npCase.inputs.payment_months,
    includeAdditionalPremium: npCase.inputs.include_additional_premium,
  });
  assert(npResult.monthlyPremium.value === BigInt(npCase.expected.monthly_premium) &&
    npResult.totalPremium.value === BigInt(npCase.expected.total_premium),
    'GC-NP-R8 は215,040円になる');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
