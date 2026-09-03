'use strict';

/**
 * 相続税エンジン単体テスト。
 *   node scripts/lib/__tests__/test-inheritance-engine.js
 */

const {
  money,
  compareExact,
  compareExactToMoney,
  moneyToExact,
} = require('../../../src/tax-engine/common/money.js');
const {
  calculate,
  calculateHeirCount,
  calculateTaxTotalFromTaxableEstate,
  calendarYearsBefore,
} = require('../../../src/tax-engine/inheritance/inheritance-tax.js');

const ON_DATE = '2025-06-01';
const yen = value => money({ unit: 'JPY', value: BigInt(value) });
const adoptedFacts = { isSpecialAdoption: false, isStepChildOfSpouse: false };

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

function exactEqualsMoney(actual, expected) {
  return compareExactToMoney(actual, yen(expected)) === 0;
}

function complete(input) {
  const result = calculate(input, { onDate: ON_DATE });
  if (result.status !== 'complete') {
    throw new Error(`completeを期待しました: ${JSON.stringify(result.blockedReasons)}`);
  }
  return result;
}

console.log('\n=== 相続税エンジン: 法定相続人の数 ===');
{
  const result = calculateHeirCount([
    { id: 'spouse', relation: 'spouse', isAlive: true },
    { id: 'real', relation: 'child', isAlive: true },
    { id: 'adopted-1', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
    { id: 'adopted-2', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
  ], { onDate: ON_DATE });
  assert(result.heirCountForTax === 3n,
    '実子1人＋養子2人では養子1人だけ算入し、配偶者込み3人');
}
{
  const result = calculateHeirCount([
    { id: 'spouse', relation: 'spouse', isAlive: true },
    { id: 'adopted-1', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
    { id: 'adopted-2', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
    { id: 'adopted-3', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
  ], { onDate: ON_DATE });
  assert(result.heirCountForTax === 3n,
    '実子なし＋養子3人では養子2人まで算入し、配偶者込み3人');
}
{
  const result = calculateHeirCount([
    { id: 'spouse', relation: 'spouse', isAlive: true },
    {
      id: 'step-child',
      relation: 'adopted_child',
      isAlive: true,
      adoptionFacts: { isSpecialAdoption: false, isStepChildOfSpouse: true },
    },
    { id: 'adopted-1', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
    { id: 'adopted-2', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts },
  ], { onDate: ON_DATE });
  assert(result.heirCountForTax === 3n && result.countableAdoptedHeirIds.length === 1,
    '連れ子養子は枠を消費せず実子あり判定にも効く');
}
{
  const result = calculateHeirCount([
    { id: 'spouse', relation: 'spouse', isAlive: true },
    { id: 'renounced-child', relation: 'child', isAlive: true, renounced: 'yes' },
  ], { onDate: ON_DATE });
  assert(result.heirCountForTax === 2n, '相続放棄者も税法上の人数に数える');
}

console.log('\n=== 相続税エンジン: 非課税・法定相続分・加算 ===');
{
  const result = complete({
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, lifeInsurance: yen(30000000) },
      { id: 'child-1', relation: 'child', isAlive: true, lifeInsurance: yen(10000000) },
      { id: 'child-2', relation: 'child', isAlive: true },
      { id: 'legatee', relation: 'other', isAlive: true, lifeInsurance: yen(100000000) },
    ],
    applySpouseRelief: false,
  });
  const spouse = result.perHeir.find(row => row.id === 'spouse');
  const child = result.perHeir.find(row => row.id === 'child-1');
  const legatee = result.perHeir.find(row => row.id === 'legatee');
  assert(exactEqualsMoney(spouse.lifeInsuranceExemption, 11250000) &&
    exactEqualsMoney(child.lifeInsuranceExemption, 3750000),
  '保険金の1,500万円枠を相続人の取得比3:1で配分する');
  assert(exactEqualsMoney(legatee.lifeInsuranceExemption, 0),
    '相続人以外が取得した保険金には非課税枠を配分しない');
}
{
  const result = calculateTaxTotalFromTaxableEstate(yen(120000000), [
    { id: 'spouse', relation: 'spouse', isAlive: true },
    { id: 'full', relation: 'sibling_full', isAlive: true },
    { id: 'half', relation: 'sibling_half', isAlive: true },
  ], { onDate: ON_DATE });
  const full = result.statutoryShares.find(row => row.id === 'full');
  const half = result.statutoryShares.find(row => row.id === 'half');
  assert(full.legalShareAmount.value === 20000000n && half.legalShareAmount.value === 10000000n,
    '半血兄弟は全血兄弟の2分の1として同順位内を配分する');
}
{
  const result = complete({
    heirs: [{ id: 'sibling', relation: 'sibling_full', isAlive: true, taxablePrice: yen(100000000) }],
  });
  const sibling = result.perHeir[0];
  assert(exactEqualsMoney(sibling.allocatedTax, 12200000) &&
    exactEqualsMoney(sibling.surcharge, 2440000) && sibling.payable.value === 14640000n,
  '兄弟姉妹の取得には税額控除前に2割加算する');
}

console.log('\n=== 相続税エンジン: 税額控除と端数 ===');
{
  assert(calendarYearsBefore('2024-02-29', 3) === '2021-02-28',
    '応当日がないうるう日の年戻しはその月の末日に丸める');
}
{
  const result = calculate({
    heirs: [{ id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(50000000) }],
    giftAddback: [
      { giftedOn: '2023-08-29', recipientHeirId: 'child', amount: yen(1000000) },
      { giftedOn: '2023-08-28', recipientHeirId: 'child', amount: yen(2000000) },
    ],
  }, { onDate: '2026-08-29' });
  assert(result.status === 'complete' && result.giftAddback.gifts[0].isInAddbackPeriod &&
    !result.giftAddback.gifts[1].isInAddbackPeriod && result.giftAddback.totalAddback.value === 1000000n,
  '3年前の応当日当日は対象、前日は期間外になる');
}
{
  const result = calculate({
    heirs: [{ id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(37000000) }],
    giftAddback: [{
      giftedOn: '2025-01-01', recipientHeirId: 'child', amount: yen(1000000),
      giftTaxPaid: yen(10000000),
    }],
  }, { onDate: '2026-08-29' });
  assert(result.status === 'complete' && result.perHeir[0].payable.value === 0n &&
    exactEqualsMoney(result.perHeir[0].credits.giftTax, 200000),
  '贈与税額が算出税額を超えても0円で止め、還付額を作らない（適用額も算出税額200,000円で頭打ち）');
}
{
  const result = calculate({
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(50000000) },
      { id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(0),
        divisionShare: { num: 0n, den: 1n } },
    ],
    giftAddback: [{ giftedOn: '2025-01-01', recipientHeirId: 'child', amount: yen(2000000) }],
  }, { onDate: '2026-08-29' });
  assert(result.status === 'complete' && result.perHeir.find(row => row.id === 'child').taxablePrice.value === 2000000n &&
    result.warnings.some(warning => warning.code === 'IHT_GIFT_ADDBACK_ZERO_SHARE'),
  '分割割合0%の相続人への贈与も警告付きで加算する');
}
{
  const result = calculate({
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(48500000) },
      { id: 'child-1', relation: 'child', isAlive: true, taxablePrice: yen(24250000) },
      { id: 'child-2', relation: 'child', isAlive: true, taxablePrice: yen(24250000) },
    ],
    giftAddback: [
      { giftedOn: '2024-03-01', recipientHeirId: 'child-1', amount: yen(2000000) },
      { giftedOn: '2026-01-15', recipientHeirId: 'child-1', amount: yen(1500000) },
      { giftedOn: '2024-08-01', recipientHeirId: 'child-2', amount: yen(800000) },
    ],
  }, { onDate: '2028-06-01' });
  const child1 = result.giftAddback.perRecipient.find(row => row.recipientHeirId === 'child-1');
  const child2 = result.giftAddback.perRecipient.find(row => row.recipientHeirId === 'child-2');
  assert(child1.addbackAmount.value === 2500000n && child2.addbackAmount.value === 0n &&
    child1.extraDeductionApplied.value === 1000000n && child2.extraDeductionApplied.value === 800000n,
  '経過措置の延長期間100万円控除は全体1枠でなく受贈者ごとに適用する');
}
{
  const result = complete({
    heirs: [{
      id: 'minor-child',
      relation: 'child',
      isAlive: true,
      taxablePrice: yen(100000000),
      isMinor: true,
      ageAtInheritance: 15,
    }],
  });
  assert(exactEqualsMoney(result.perHeir[0].credits.minor, 300000),
    '15歳の未成年者控除は（18歳－15歳）×10万円＝30万円');
}
{
  const result = complete({
    heirs: [{
      id: 'minor-child',
      relation: 'child',
      isAlive: true,
      taxablePrice: yen(37000000),
      isMinor: true,
      ageAtInheritance: 15,
    }],
  });
  assert(result.perHeir[0].payable.value === 0n && result.warnings.some(
    warning => warning.code === 'IHT_MINOR_CREDIT_OVERFLOW_NOT_TRANSFERRED'
  ), '未成年者控除の不足額を扶養義務者へ移さず警告する');
}
{
  const result = complete({
    heirs: [{
      id: 'disabled-child',
      relation: 'child',
      isAlive: true,
      taxablePrice: yen(100000000),
      ageAtInheritance: 80,
      disability: 'general',
    }],
  });
  assert(exactEqualsMoney(result.perHeir[0].credits.disability, 500000),
    '一般障害者80歳の控除は（85歳－80歳）×10万円＝50万円');
}
{
  const result = complete({
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(100001234) },
      { id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(100000000) },
    ],
    applySpouseRelief: false,
  });
  const spouse = result.perHeir.find(row => row.id === 'spouse');
  assert(spouse.taxablePrice.value === 100001000n,
    '各人の課税価格で1,000円未満（入力の234円）を切り捨てる');
  assert(result.statutoryShares.every(row => row.legalShareAmount.value === 79000000n),
    '法定相続分で按分してから1,000円未満を切り捨てる');
  assert(spouse.payable.value % 100n === 0n &&
    compareExact(spouse.allocatedTax, moneyToExact(spouse.payable)) > 0,
  '各人の納付税額で100円未満を最後に切り捨てる');
}
{
  const result = complete({
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(100001000) },
      { id: 'child-1', relation: 'child', isAlive: true, taxablePrice: yen(50002000) },
      { id: 'child-2', relation: 'child', isAlive: true, taxablePrice: yen(50003000) },
    ],
    applySpouseRelief: false,
  });
  assert(result.allocationInvariant.holds && compareExact(
    result.allocationInvariant.allocatedTaxTotal,
    result.allocationInvariant.totalTax
  ) === 0, '端数のある課税価格でも按分Exactの合計は相続税総額と一致する');
}
{
  const result = complete({
    heirs: [{ id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(10000000) }],
  });
  assert(result.taxableEstate.value === 0n && result.totalTax.value === 0n &&
    result.perHeir[0].payable.value === 0n,
  '課税遺産総額が0ならcompleteかつ税額なしで確定する');
}
{
  const result = complete({
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(100000000) },
      { id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(50000000) },
    ],
    isDivided: 'no',
  });
  const spouse = result.perHeir.find(row => row.id === 'spouse');
  assert(exactEqualsMoney(spouse.credits.spouseRelief, 0) && result.warnings.some(
    warning => warning.code === 'IHT_SPOUSE_RELIEF_NOT_APPLIED_UNDIVIDED'
  ), '未分割では配偶者軽減を適用せず警告する');
}

console.log('\n=== 相続税エンジン: blocked 理由コード ===');
{
  const result = calculate({
    heirs: [{ id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(10000000) }],
    giftAddback: [{ giftedOn: '2013-01-01', recipientHeirId: 'child', amount: yen(1000000) }],
  }, { onDate: '2014-12-31' });
  assert(result.status === 'blocked' && result.blockedReasons.some(reason =>
    reason.code === 'IHT_MASTER_UNAVAILABLE'),
  '2015年より前で該当期間マスターがない相続開始日は理由コード付きblockedになる');
}
{
  const result = calculate({
    heirs: [
      {
        id: 'substitute',
        relation: 'grandchild',
        isAlive: true,
        substitutedFor: 'dead-child',
      },
      {
        id: 'excluded',
        relation: 'parent',
        isAlive: true,
        disqualifiedOrExcluded: 'yes',
      },
      {
        id: 'adopted',
        relation: 'adopted_child',
        isAlive: true,
      },
      {
        id: 'renouncer',
        relation: 'child',
        isAlive: true,
        renounced: 'yes',
        taxablePrice: yen(1000),
      },
      {
        id: 'non-resident',
        relation: 'other',
        isAlive: true,
        residencyStatus: 'non_resident',
        previousInheritanceWithin10Years: {},
        foreignTaxCredit: yen(1),
      },
    ],
    settlementTaxationGifts: yen(1),
    hasForeignAssets: 'yes',
    smallResidentialLand: [{}],
  }, { onDate: ON_DATE });
  const codes = new Set(result.blockedReasons.map(reason => reason.code));
  const expectedCodes = [
    'IHT_SUBSTITUTED_SUCCESSION_UNSUPPORTED',
    'IHT_DISQUALIFICATION_EXCLUSION_UNSUPPORTED',
    'IHT_ADOPTION_FACTS_REQUIRED',
    'IHT_RENOUNCER_ACQUIRED_PROPERTY',
    'IHT_SETTLEMENT_TAXATION_UNSUPPORTED',
    'IHT_SUCCESSIVE_INHERITANCE_CREDIT_UNSUPPORTED',
    'IHT_FOREIGN_TAX_CREDIT_UNSUPPORTED',
    'IHT_NON_RESIDENT',
    'IHT_FOREIGN_PROPERTY',
    'IHT_SMALL_RESIDENTIAL_LAND_UNSUPPORTED',
  ];
  assert(result.status === 'blocked' && expectedCodes.every(code => codes.has(code)),
    '対応外入力を黙って無視せず、各理由コード付きのblockedで返す');
}

console.log('\n=== 相続税エンジン: 配偶者軽減の1億6,000万円の下限 ===');
{
  // 妻が法定相続分（1/2＝1億円）を超える1.4億円を取得するが、1.6億円以下の場合。
  // 軽減の上限は min(実際の取得1.4億, max(法定相続分1億, 1.6億)=1.6億) = 1.4億 となり、
  // 妻の納付は0円。1.6億円の下限を落とした実装（max を取らない）だと上限が1億になり、
  // 妻に納付が残ってしまう。この下限は配偶者が法定相続分より多く取る場面の本丸。
  // 数値: 相続人は妻と子1人。課税価格合計2億 → 基礎控除4,200万 → 課税遺産総額1.58億
  //  → 法定相続分に応ずる取得金額 各7,900万 → 各1,670万（30%−700万）→ 総額3,340万
  //  → 妻の按分 3,340万×1.4/2 = 2,338万 → 軽減2,338万 → 納付0
  const result = complete({
    isDivided: 'yes',
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(140000000) },
      { id: 'child', relation: 'child', isAlive: true, taxablePrice: yen(60000000) },
    ],
  });
  const spouse = result.perHeir.find(row => row.id === 'spouse');
  const child = result.perHeir.find(row => row.id === 'child');
  assert(result.totalTax.value === 33400000n, '相続税の総額は3,340万円');
  assert(exactEqualsMoney(spouse.credits.spouseRelief, 23380000),
    '軽減額は2,338万円（上限は1.6億の下限が効いて実際の取得1.4億まで）');
  assert(spouse.payable.value === 0n,
    '法定相続分を超えて取得しても1.6億円以下なら妻の納付は0円');
  assert(child.payable.value === 10020000n, '子の納付は1,002万円');
}

console.log('\n=== 相続税エンジン: 孫養子の前提表示 ===');
{
  const result = complete({
    isDivided: 'yes',
    heirs: [
      { id: 'spouse', relation: 'spouse', isAlive: true, taxablePrice: yen(100000000) },
      { id: 'adopted', relation: 'adopted_child', isAlive: true, adoptionFacts: adoptedFacts, taxablePrice: yen(50000000) },
    ],
  });
  assert(result.warnings.some(w => w.code === 'IHT_ADOPTED_SURCHARGE_ASSUMPTION'),
    '孫養子でない前提で2割加算なしとした旨を表示する（相法18条2項）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
