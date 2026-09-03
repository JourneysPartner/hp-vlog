'use strict';

/** 相続税シミュレーターサービス第1版の単体・受け入れテスト。 */

const fs = require('fs');
const path = require('path');
const service = require('../../../src/simulators/sozoku/index.js');
const masterSnapshot = require('../../../src/tax-engine/masters/snapshot.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const goldenDocument = JSON.parse(fs.readFileSync(path.join(
  REPO_ROOT, 'data', 'tax-simulator', 'golden-cases', 'official-examples.json'
), 'utf8'));
const golden = goldenDocument.cases.find(item => item.case_id === 'GC-SO-LEVEL2-FULL');
const secondaryGolden = goldenDocument.cases.find(item => item.case_id === 'GC-SO-SECONDARY-SCAN');
const snapshotInfo = masterSnapshot.getSnapshotInfo();
const yen = value => ({ unit: 'JPY', value: BigInt(value) });
const area = value => ({ unit: 'SQM', num: BigInt(value), den: 1n });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function throws(action) {
  try { action(); return false; } catch (_error) { return true; }
}

function clone(value) {
  if (typeof value === 'bigint') return BigInt(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function context(overrides = {}) {
  return {
    asOfDate: '2026-08-28',
    calculatedAt: '2026-08-28T12:00:00+09:00',
    inheritanceOpenDate: golden.inputs.inheritance_open_date,
    jurisdiction: { country: 'JP' },
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
    ...overrides,
  };
}

function heirs() {
  return golden.inputs.heirs.map(heir => ({
    ...heir,
    isAlive: true,
    residencyStatus: 'domestic_resident',
  }));
}

function fullInput() {
  return {
    level: 2,
    precision: 'detailed',
    decedent: { residencyStatus: 'domestic_resident' },
    heirs: heirs(),
    assets: {
      cash: yen(golden.inputs.cash),
      securities: yen(golden.inputs.securities),
      realEstate: [
        { kind: 'appraised', category: 'building', value: yen(golden.inputs.building_appraised) },
        { kind: 'appraised', category: 'land', value: yen(golden.inputs.land_appraised) },
      ],
    },
    debts: [],
    division: {
      isDivided: 'yes',
      acquisitions: Object.entries(golden.inputs.division_shares).map(([heirId, share]) => ({
        heirId,
        share: { num: BigInt(share.num), den: BigInt(share.den) },
      })),
    },
    smallResidentialLand: [{
      realEstateIndex: 1,
      category: golden.inputs.small_residential_land_category,
      areaSqm: area(golden.inputs.land_area_sqm),
      acquirerHeirId: golden.inputs.small_residential_land_acquirer,
      acquirerRelation: 'spouse',
    }],
    specialistChecks: {},
  };
}

function result(input = fullInput(), contextValue = context(), masters = snapshotInfo) {
  return service.simulate(input, contextValue, masters);
}

function data(simulation) {
  return simulation.breakdown && simulation.breakdown.data;
}

function allocation(simulation, heirId) {
  return data(simulation).allocations.find(row => row.heirId === heirId);
}

function hasWarning(simulation, code) {
  return simulation.warnings.some(item => item.code === code);
}

function warningIncludes(simulation, code, text) {
  const found = simulation.warnings.find(item => item.code === code);
  return found && `${found.basis || ''} ${found.userAction || ''}`.includes(text);
}

function toWire(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toWire(child)]));
  }
  return value;
}

console.log('\n=== GC-SO-LEVEL2-FULL ===');
{
  const simulation = result();
  const expected = golden.expected;
  const breakdown = data(simulation);
  const spouse = allocation(simulation, 'spouse');
  const children = ['child-1', 'child-2'].map(id => allocation(simulation, id));
  assert(simulation.resultStatus === 'complete' && simulation.simulatorType === 'sozoku' &&
    simulation.inputSchemaVersion === 'sozoku-1.0',
  'SimulationResult契約とsozoku-1.0を返す');
  assert(breakdown.basicDeduction.value === BigInt(expected.basic_deduction),
    '法定相続人3人の基礎控除は48,000,000円');
  assert(breakdown.grossEstate.value === BigInt(expected.taxable_price_before_special_rule) &&
    breakdown.grossEstate.value - breakdown.taxablePriceTotal.value ===
      BigInt(expected.small_residential_land_reduction),
  '特例前140,000,000円と小規模宅地減額40,000,000円を分離する');
  assert(breakdown.taxablePriceTotal.value === BigInt(expected.taxable_price_total) &&
    spouse.acquiredAmount.value === BigInt(expected.spouse_taxable_price) &&
    children.every(row => row.acquiredAmount.value === BigInt(expected.child_taxable_price_each)),
  '特例後課税価格と各人の課税価格が一致する');
  assert(breakdown.taxableEstate.value === BigInt(expected.taxable_estate) &&
    breakdown.totalInheritanceTax.value === BigInt(expected.total_inheritance_tax),
  '課税遺産総額52,000,000円から相続税総額6,300,000円を算出する');
  assert(spouse.allocatedTaxBeforeCredits.value === BigInt(expected.spouse_allocated_tax) &&
    children.every(row => row.allocatedTaxBeforeCredits.value ===
      BigInt(expected.child_allocated_tax_each)),
  '相続税総額を配偶者3,150,000円、子各1,575,000円へ按分する');
  assert(spouse.credits.value === BigInt(expected.spouse_tax_relief) &&
    spouse.finalTax.value === BigInt(expected.spouse_final_tax) &&
    children.every(row => row.finalTax.value === BigInt(expected.child_final_tax_each)),
  '配偶者軽減の適用前税額・軽減額・適用後税額をallocationで表示する');
  assert(simulation.summary.amount.value === BigInt(expected.final_tax_total) &&
    breakdown.filingNeed === expected.filing_need,
  '最終納付合計3,150,000円とrequired_for_special_ruleを区別して返す');
}

console.log('\n=== 小規模宅地等の簡易適用 ===');
{
  const input = fullInput();
  input.smallResidentialLand[0].acquirerRelation = 'other';
  const simulation = result(input);
  assert(data(simulation).taxablePriceTotal.value === 140000000n &&
    warningIncludes(simulation, 'SOZOKU_SMALL_RESIDENTIAL_LAND_SPECIALIST_REVIEW',
      '適用できる可能性があります（専門相談）'),
  '要件不成立なら適用せず、専門相談の注記を出す');
}
{
  const input = fullInput();
  input.smallResidentialLand[0].areaSqm = area(400);
  input.smallResidentialLand[0].intendedAppliedAreaSqm = area(330);
  const simulation = result(input);
  assert(data(simulation).grossEstate.value - data(simulation).taxablePriceTotal.value === 33000000n &&
    data(simulation).taxablePriceTotal.value === 107000000n,
  '400㎡のうち330㎡へ80%を適用し33,000,000円を減額する');
}

console.log('\n=== LEVEL 1 申告要否 ===');
{
  const input = fullInput();
  input.level = 1;
  input.assets = {
    cash: yen(20000000),
    realEstate: [{
      kind: 'screening_land', roadsideValuePerSqm: yen(200000), areaSqm: area(150),
      isMultiplierArea: 'no', hasLeaseholdOrRented: 'no',
    }],
  };
  delete input.smallResidentialLand;
  delete input.division;
  const simulation = result(input);
  assert(data(simulation).taxablePriceTotal.value === 50000000n &&
    data(simulation).basicDeduction.value === 48000000n &&
    data(simulation).filingNeed === 'possibly_required' &&
    hasWarning(simulation, 'SOZOKU_SCREENING_REAL_ESTATE_ESTIMATE') &&
    !Object.hasOwn(data(simulation), 'totalInheritanceTax') &&
    !Object.hasOwn(simulation.summary, 'amount'),
  'screening土地は50,000,000円・possibly_required・税額なし・評価警告になる');
}
{
  const input = fullInput();
  input.level = 1;
  input.assets = { cash: yen(40000000) };
  delete input.smallResidentialLand;
  delete input.division;
  assert(data(result(input)).filingNeed === 'not_required',
    '現預金40,000,000円だけならnot_required');
}
{
  const input = fullInput();
  input.assets.realEstate[1] = {
    kind: 'screening_land', roadsideValuePerSqm: yen(200000), areaSqm: area(200),
    isMultiplierArea: 'no', hasLeaseholdOrRented: 'no',
  };
  const simulation = result(input);
  assert(simulation.resultStatus === 'blocked' &&
    hasWarning(simulation, 'SOZOKU_LEVEL2_DIRECT_APPRAISAL_REQUIRED'),
  'LEVEL 2のscreening入力は評価額直接入力を促してblocked');
}

console.log('\n=== 分割・配偶者軽減 ===');
{
  const input = fullInput();
  delete input.division;
  const simulation = result(input);
  assert(simulation.resultStatus === 'complete' && simulation.assumptions.some(text =>
    text.includes('分割未確定') && text.includes('法定相続分')),
  'division省略時は法定相続分で仮配分し前提を表示する');
}
{
  const input = fullInput();
  input.division.isDivided = 'no';
  const simulation = result(input);
  assert(allocation(simulation, 'spouse').credits.value === 0n &&
    allocation(simulation, 'spouse').finalTax.value === 3150000n &&
    hasWarning(simulation, 'IHT_SPOUSE_RELIEF_NOT_APPLIED_UNDIVIDED'),
  '未分割は配偶者軽減を適用せず§30警告を出す');
}
{
  const input = fullInput();
  input.division.spouseAcquisitionAmount = yen(1);
  assert(result(input).resultStatus === 'blocked' &&
    hasWarning(result(input), 'SOZOKU_SPOUSE_ACQUISITION_MISMATCH'),
  '配偶者取得額がshare算出額と不一致なら質問コード付きblocked');
}

console.log('\n=== 保険金非課税と債務負担者 ===');
{
  const base = fullInput();
  base.assets = { cash: yen(80000000) };
  delete base.smallResidentialLand;
  const withInsurance = clone(base);
  withInsurance.assets.lifeInsurance = [{
    beneficiaryHeirId: 'spouse', isHeir: true, amount: yen(15000000),
  }];
  assert(data(result(base)).taxablePriceTotal.value ===
    data(result(withInsurance)).taxablePriceTotal.value,
  '相続人受取15,000,000円の死亡保険金は500万円×3人の枠内で全額非課税');
}
{
  const input = fullInput();
  input.debts = [{ kind: 'loan', amount: yen(1000000) }];
  const simulation = result(input);
  assert(simulation.resultStatus === 'blocked' &&
    hasWarning(simulation, 'SOZOKU_DEBT_BEARER_REQUIRED'),
  '債務のbearerHeirId省略は質問コード付きblocked');
}

console.log('\n=== 生前贈与加算・贈与税額控除 ===');
{
  const input = fullInput();
  input.assets = {
    cash: yen(97000000),
    giftAddback: [
      { giftedOn: '2024-06-01', recipientHeirId: 'child-1', amount: yen(3000000), giftTaxPaid: yen(190000) },
      { giftedOn: '2022-01-01', recipientHeirId: 'child-1', amount: yen(5000000) },
    ],
  };
  delete input.smallResidentialLand;
  const simulation = result(input, context({ inheritanceOpenDate: '2026-08-29' }));
  const breakdown = data(simulation);
  assert(simulation.resultStatus === 'complete' && breakdown.taxablePriceTotal.value === 100000000n &&
    breakdown.totalInheritanceTax.value === 6300000n && simulation.summary.amount.value === 3054400n,
  'GC-SO-GIFT-ADDBACK-3Y: 課税価格1億円・相続税総額630万円・納付合計3,054,400円');
  assert(breakdown.giftAddback.gifts[0].addbackAmount.value === 3000000n &&
    breakdown.giftAddback.gifts[1].addbackAmount.value === 0n &&
    allocation(simulation, 'child-1').creditDetails.giftTax.value === 190000n,
  '対象贈与と期間外贈与を明細に残し、子1の贈与税額控除19万円を返す');
}
{
  const input = fullInput();
  input.assets = {
    cash: yen(97000000),
    giftAddback: [
      { giftedOn: '2024-03-01', recipientHeirId: 'child-1', amount: yen(2000000) },
      { giftedOn: '2026-01-15', recipientHeirId: 'child-1', amount: yen(1500000) },
      { giftedOn: '2024-08-01', recipientHeirId: 'child-2', amount: yen(800000) },
    ],
  };
  delete input.smallResidentialLand;
  const simulation = result(input, context({ inheritanceOpenDate: '2028-06-01' }));
  const child1 = data(simulation).giftAddback.perRecipient.find(row => row.recipientHeirId === 'child-1');
  const child2 = data(simulation).giftAddback.perRecipient.find(row => row.recipientHeirId === 'child-2');
  assert(child1.addbackAmount.value === 2500000n && child2.addbackAmount.value === 0n &&
    child1.extraDeductionApplied.value === 1000000n && child2.extraDeductionApplied.value === 800000n,
  'GC-SO-GIFT-EXTRA-100: 100万円控除を受贈者ごとに適用する');
}

console.log('\n=== 第1版の対象外条件 ===');
{
  const cases = [
    ['IHT_SETTLEMENT_TAXATION_UNSUPPORTED', input => {
      input.assets.settlementTaxationGifts = yen(1);
    }],
    ['IHT_NON_RESIDENT', input => { input.heirs[0].residencyStatus = 'non_resident'; }],
    ['SOZOKU_SPECIALIST_CHECK_REQUIRED', input => { input.specialistChecks.nomineeDeposit = 'yes'; }],
    ['SOZOKU_OWNERSHIP_SHARE_CONFIRMATION_REQUIRED', input => {
      input.assets.realEstate[1].ownershipShare = { num: 1n, den: 2n };
    }],
    ['SOZOKU_MULTIPLIER_AREA_REQUIRES_APPRAISAL', input => {
      input.level = 1;
      input.assets.realEstate[1] = {
        kind: 'screening_land', roadsideValuePerSqm: yen(1), areaSqm: area(1),
        isMultiplierArea: 'yes', hasLeaseholdOrRented: 'no',
      };
    }],
  ];
  for (const [code, mutate] of cases) {
    const input = fullInput();
    mutate(input);
    const simulation = result(input);
    assert(simulation.resultStatus === 'blocked' && hasWarning(simulation, code),
      `${code} を理由コード付きblockedにする`);
  }
}

console.log('\n=== GC-SO-SECONDARY-SCAN ===');
{
  const input = fullInput();
  input.level = 3;
  input.assets = { cash: yen(secondaryGolden.inputs.estate_cash) };
  delete input.smallResidentialLand;
  input.secondaryInheritance = {
    spouseOwnAssets: yen(secondaryGolden.inputs.spouse_own_assets),
    spouseAcquisitionRatios: Array.from({ length: 11 }, (_, index) => ({
      num: BigInt(index * 10), den: 100n,
    })),
    expectedHeirs: [1, 2].map(index => ({
      id: `secondary-heir-${index}`, relation: 'child', isAlive: true,
      residencyStatus: 'domestic_resident',
    })),
  };
  const simulation = result(input);
  const secondary = data(simulation).secondaryInheritance;
  const scenario = percent => secondary.scenarios.find(row =>
    row.spouseAcquisitionPercent === percent);
  const expectedPercents = Array.from({ length: 11 }, (_, index) => index * 10);
  for (const percent of expectedPercents) {
    const actual = scenario(percent);
    const expected = secondaryGolden.expected[`percent_${percent}`];
    assert(actual && expected &&
      actual.primaryPayableTotal.value === BigInt(expected.primary_tax) &&
      actual.secondaryEstate.value === BigInt(expected.secondary_estate) &&
      actual.secondaryTaxTotal.value === BigInt(expected.secondary_tax) &&
      actual.combinedTaxTotal.value === BigInt(expected.combined_tax),
    `X=${percent}%の一次・二次財産・二次税・合計が手計算値と一致する`);
  }
  assert(secondary.scenarios.length === secondaryGolden.expected.scenario_count &&
    secondary.scenarios.every(row => row.combinedTaxTotal.value ===
      row.primaryPayableTotal.value + row.secondaryTaxTotal.value),
  '11行すべてで合計税額が一次＋二次と一致する');
  assert(secondary.minimumSpouseAcquisitionPercent ===
    secondaryGolden.expected.minimum_spouse_acquisition_percent &&
    secondary.minimumCombinedTaxTotal.value === BigInt(secondaryGolden.expected.minimum_combined_tax),
  '最小行選定は配偶者取得割合10%・5,670,000円（最大行を選ぶ実装では失敗）');
  assert(simulation.assumptions.some(text => text.includes('分割済み') && text.includes('配偶者の税額軽減')),
    '実入力が未分割でも走査では分割済みとして軽減を適用する前提を明示する');
}

console.log('\n=== 二次相続財産の組成 ===');
{
  const composed = service.composeSecondaryEstate({
    spouseOwnAssets: yen(30000000), spouseAcquiredAmount: yen(400000000),
    spousePrimaryTax: yen(55320000),
  });
  assert(composed.value === BigInt(secondaryGolden.expected.composition_with_primary_tax),
    '一次納付税額55,320,000円を控除して374,680,000円を組成する');
}
{
  const composed = service.composeSecondaryEstate({
    spouseOwnAssets: yen(80000000), spouseAcquiredAmount: yen(0), spousePrimaryTax: yen(0),
    yearsUntilSecondary: 10, annualLivingCost: yen(3000000),
    annualAssetChangeRate: { num: 1n, den: 100n },
  });
  assert(composed.value === BigInt(secondaryGolden.expected.ten_year_estate),
    '10年・+1%・生活費300万円を逐年切捨てして56,669,263円にする');
}
{
  const composed = service.composeSecondaryEstate({
    spouseOwnAssets: yen(5000000), spouseAcquiredAmount: yen(0), spousePrimaryTax: yen(0),
    yearsUntilSecondary: 3, annualLivingCost: yen(3000000),
    annualAssetChangeRate: { num: 1n, den: 100n },
  });
  assert(composed.value === 0n, '生活費控除で途中から負になる財産は0円を下限にする');
}

console.log('\n=== validate とスナップショット ===');
{
  const minimalWire = toWire({
    level: 1,
    precision: 'simple',
    decedent: { residencyStatus: 'domestic_resident' },
    heirs: [{
      id: 'spouse', relation: 'spouse', isAlive: true, residencyStatus: 'domestic_resident',
    }],
    assets: { cash: yen(1000) },
    debts: [],
    specialistChecks: {},
  });
  const valid = service.validate(minimalWire);
  assert(valid.ok && valid.value.assets.cash.value === 1000n,
    '正しい最小Wire入力を検証しMoneyをbigintへ変換する');
  minimalWire.assets.cash.value = '1e3';
  assert(!service.validate(minimalWire).ok,
    'Moneyの指数表記1e3をok:falseにする');
}
{
  const input = fullInput();
  input.level = 3;
  input.secondaryInheritance = {
    spouseOwnAssets: yen(0), spouseAcquisitionRatios: [], expectedHeirs: [],
  };
  const invalid = service.validate(toWire(input));
  assert(!invalid.ok && invalid.errors.some(item => item.code === 'SOZOKU_SECONDARY_HEIRS_REQUIRED'),
    '二次相続の想定相続人0人はvalidateで入力エラーにする');
}
{
  const mismatched = { ...snapshotInfo, snapshotHash: 'not-the-current-snapshot' };
  assert(throws(() => result(fullInput(), context(), mismatched)),
    'マスタースナップショット不一致を例外にする');
}

// §29・§31 の核心: 小規模宅地の適用で課税価格が基礎控除以下へ落ちても
// 「申告不要」と誤判定しない（申告要否は特例適用前の課税価格で判定する）。
// 現預金1,000万＋土地5,000万(200㎡・配偶者取得・80%減) → 適用前6,000万>基礎控除4,800万、
// 適用後2,000万≤4,800万。
{
  const dropsBelowBasic = overrides => ({
    ...fullInput(),
    assets: {
      cash: yen(10000000),
      realEstate: [
        { kind: 'appraised', category: 'land', value: yen(50000000) },
      ],
    },
    smallResidentialLand: [{
      realEstateIndex: 0,
      category: 'specified_residential',
      areaSqm: area(200),
      acquirerHeirId: golden.inputs.small_residential_land_acquirer,
      acquirerRelation: 'spouse',
    }],
    ...overrides,
  });
  const level1 = result(dropsBelowBasic({ level: 1 }));
  assert(data(level1).filingNeed === 'required_for_special_rule' &&
    data(level1).taxablePriceTotal.value <= data(level1).basicDeduction.value,
  'LEVEL1: 特例で基礎控除以下へ落ちるケースを not_required にしない');
  const level2 = result(dropsBelowBasic({ level: 2 }));
  assert(data(level2).filingNeed === 'required_for_special_rule' &&
    data(level2).totalInheritanceTax.value === 0n,
  'LEVEL2: 税額0円でも特例利用のため申告必要（税額0円≠申告不要）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
