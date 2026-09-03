'use strict';

/** 相続税「申告要否・税額」シミュレーター第1版。 */

const { validateInput } = require('../core/validator.js');
const { buildSimulationResult } = require('../core/result-builder.js');
const inheritanceTax = require('../../tax-engine/inheritance/inheritance-tax.js');
const snapshot = require('../../tax-engine/masters/snapshot.js');
const {
  money,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  multiplyRateByExact,
  multiplyAreaByMoney,
  addExact,
  subtractExact,
  addMoney,
  subtractMoney,
  compareExact,
} = require('../../tax-engine/common/money.js');
const { applyRounding } = require('../../tax-engine/common/rounding.js');

const ZERO = Object.freeze({ unit: 'JPY', value: 0n });
const ONE_YEN_ROUNDING = 'R-TRUNC-1-YEN';
const TAXABLE_PRICE_ROUNDING = 'R-TRUNC-1000-IHT-BASE';

function yen(value) {
  return money({ unit: 'JPY', value: BigInt(value) });
}

function zeroMoney() {
  return yen(ZERO.value);
}

function zeroExact() {
  return moneyToExact(zeroMoney());
}

function sumMoney(values) {
  return values.reduce((total, value) => addMoney(total, value), zeroMoney());
}

function sumExact(values) {
  return values.reduce((total, value) => addExact(total, value), zeroExact());
}

function exactToYen(value) {
  return applyRounding(value, ONE_YEN_ROUNDING);
}

function masterMoney(value) {
  return yen(value.value);
}

function masterRate(value) {
  return rate({ num: BigInt(value.num), den: BigInt(value.den) });
}

function warning(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function blockedReason(code, fieldPath, message) {
  return warning(code, fieldPath, message);
}

function assertSnapshotMatch(context, masters) {
  if (!context || !masters || context.masterSnapshotId !== masters.snapshotId ||
      context.masterSnapshotHash !== masters.snapshotHash) {
    throw new Error('マスタースナップショットと計算コンテキストが一致しません');
  }
}

function inheritanceOpenDateFrom(context) {
  if (!context || typeof context.inheritanceOpenDate !== 'string') {
    throw new TypeError('context.inheritanceOpenDate が必要です');
  }
  return context.inheritanceOpenDate;
}

function isYes(value) {
  return value === true || value === 'yes';
}

function firstMaster(valueKey, onDate, predicate = () => true) {
  const rows = snapshot.find(valueKey, { onDate }).filter(predicate);
  return rows.length === 1 ? rows[0] : null;
}

function uniqueWarnings(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = `${item.code}\u0000${item.fieldPath || ''}\u0000${item.message || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function supportedProfileReasons(input) {
  const reasons = [];
  if (input.assets.settlementTaxationGifts !== undefined) {
    reasons.push(blockedReason('IHT_SETTLEMENT_TAXATION_UNSUPPORTED',
      '$.assets.settlementTaxationGifts', '相続時精算課税適用財産は相続税エンジン第1版の対象外です'));
  }
  if (input.decedent.residencyStatus === 'non_resident' ||
      input.decedent.residencyStatus === 'unknown') {
    reasons.push(blockedReason('IHT_NON_RESIDENT', '$.decedent.residencyStatus',
      '被相続人の非居住・居住地不明は第1版の対応範囲外です'));
  }
  for (let index = 0; index < input.heirs.length; index++) {
    const heir = input.heirs[index];
    if (heir.residencyStatus === 'non_resident' || heir.residencyStatus === 'unknown') {
      reasons.push(blockedReason('IHT_NON_RESIDENT', `$.heirs[${index}].residencyStatus`,
        '相続人の非居住・居住地不明は第1版の対応範囲外です'));
    }
  }
  for (const [key, value] of Object.entries(input.specialistChecks || {})) {
    if (isYes(value)) {
      reasons.push(blockedReason('SOZOKU_SPECIALIST_CHECK_REQUIRED',
        `$.specialistChecks.${key}`, '専門判定が必要な項目があるため簡易計算できません'));
    }
  }
  const realEstate = input.assets.realEstate || [];
  for (let index = 0; index < realEstate.length; index++) {
    const item = realEstate[index];
    const path = `$.assets.realEstate[${index}]`;
    if (item.ownershipShare !== undefined) {
      reasons.push(blockedReason('SOZOKU_OWNERSHIP_SHARE_CONFIRMATION_REQUIRED',
        `${path}.ownershipShare`,
        '共有持分適用前後の評価額を判別できません。持分反映済みの評価額を入力してください'));
    }
    if (input.level >= 2 && item.kind !== 'appraised') {
      reasons.push(blockedReason('SOZOKU_LEVEL2_DIRECT_APPRAISAL_REQUIRED', path,
        'LEVEL 2では不動産の相続税評価額を直接入力してください'));
    }
    if (item.kind === 'screening_land') {
      if (item.isMultiplierArea === 'yes' || item.isMultiplierArea === 'unknown') {
        reasons.push(blockedReason('SOZOKU_MULTIPLIER_AREA_REQUIRES_APPRAISAL',
          `${path}.isMultiplierArea`, '倍率地域は評価額の直接入力または専門判定が必要です'));
      }
      if (item.hasLeaseholdOrRented === 'yes' || item.hasLeaseholdOrRented === 'unknown') {
        reasons.push(blockedReason('SOZOKU_LEASEHOLD_RENTED_REQUIRES_APPRAISAL',
          `${path}.hasLeaseholdOrRented`, '借地権・貸家建付地等は専門判定が必要です'));
      }
      if (item.areaSqm.num <= 0n) {
        reasons.push(blockedReason('SOZOKU_REAL_ESTATE_AREA_INVALID', `${path}.areaSqm`,
          '土地面積は0より大きい値を入力してください'));
      }
    }
  }
  for (let index = 0; index < input.debts.length; index++) {
    if (input.debts[index].bearerHeirId === undefined) {
      reasons.push(blockedReason('SOZOKU_DEBT_BEARER_REQUIRED',
        `$.debts[${index}].bearerHeirId`, '債務・葬式費用を実際に負担する相続人を指定してください'));
    }
  }
  return reasons;
}

function convertRealEstate(input) {
  const values = [];
  const warnings = [];
  for (let index = 0; index < (input.assets.realEstate || []).length; index++) {
    const item = input.assets.realEstate[index];
    if (item.kind === 'appraised') {
      values.push(item.value);
      continue;
    }
    warnings.push(warning('SOZOKU_SCREENING_REAL_ESTATE_ESTIMATE',
      `$.assets.realEstate[${index}]`, '実際の相続税評価額とは異なる場合があります'));
    if (item.kind === 'screening_land') {
      values.push(applyRounding(
        multiplyAreaByMoney(item.areaSqm, item.roadsideValuePerSqm),
        ONE_YEN_ROUNDING
      ));
    } else {
      values.push(item.fixedAssetTaxValue);
    }
  }
  return { values, warnings };
}

function compareArea(left, right) {
  const difference = left.num * right.den - right.num * left.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function minArea(values) {
  return values.reduce((smallest, value) => compareArea(value, smallest) < 0 ? value : smallest);
}

function smallLandNotAppliedWarning() {
  return warning('SOZOKU_SMALL_RESIDENTIAL_LAND_SPECIALIST_REVIEW',
    '$.smallResidentialLand',
    '小規模宅地等の特例を適用できる可能性があります（専門相談）。要件未確認のため適用前評価額で計算します');
}

function calculateSmallLandReduction(input, onDate, realEstateValues) {
  const entries = input.smallResidentialLand || [];
  if (entries.length === 0) return { reduction: zeroMoney(), warnings: [], applied: false };
  if (entries.length !== 1) {
    return { reduction: zeroMoney(), warnings: [smallLandNotAppliedWarning()], applied: false };
  }

  const entry = entries[0];
  const estate = (input.assets.realEstate || [])[entry.realEstateIndex];
  const acquirer = input.heirs.find(heir => heir.id === entry.acquirerHeirId);
  const spouseCondition = entry.acquirerRelation === 'spouse' &&
    acquirer && acquirer.relation === 'spouse';
  const cohabitingCondition = entry.acquirerRelation === 'cohabiting_relative' &&
    entry.acquirerResidesAndOwns === 'yes' &&
    entry.willHoldUntilFilingDeadline === 'yes';
  const wholeArea = entry.areaSqm;
  const intendedArea = entry.intendedAppliedAreaSqm || wholeArea;
  const conditionsHold = entry.category === 'specified_residential' &&
    estate && estate.kind === 'appraised' && estate.category === 'land' &&
    acquirer && (spouseCondition || cohabitingCondition) &&
    wholeArea.num > 0n && intendedArea.num > 0n;
  if (!conditionsHold) {
    return { reduction: zeroMoney(), warnings: [smallLandNotAppliedWarning()], applied: false };
  }

  const category = firstMaster('small_residential_land_category', onDate,
    row => row.land_category === 'specific_residence');
  const limitRule = firstMaster('small_residential_land_area_limit_rule', onDate,
    row => row.limit_rule === 'independent');
  if (!category || !limitRule) {
    return {
      blockedReasons: [blockedReason('IHT_MASTER_UNAVAILABLE', '$.smallResidentialLand',
        '小規模宅地等の特例に必要な承認済みマスターが利用できません')],
    };
  }
  if (!Number.isSafeInteger(category.area_limit_sqm) ||
      limitRule._residence_limit_sqm !== category.area_limit_sqm) {
    throw new Error('小規模宅地等の限度面積マスターが一致しません');
  }

  const limitArea = {
    unit: 'SQM', num: BigInt(category.area_limit_sqm), den: 1n,
  };
  const appliedArea = minArea([wholeArea, intendedArea, limitArea]);
  const areaRatio = rate({
    num: appliedArea.num * wholeArea.den,
    den: appliedArea.den * wholeArea.num,
  });
  const reductionExact = multiplyRateByExact(
    masterRate(category.reduction_rate),
    multiplyRateByMoney(areaRatio, realEstateValues[entry.realEstateIndex])
  );
  const reduction = applyRounding(reductionExact, ONE_YEN_ROUNDING);
  return {
    reduction,
    applied: reduction.value > 0n,
    warnings: [warning('SOZOKU_SMALL_RESIDENTIAL_LAND_SIMPLIFIED_APPLIED',
      '$.smallResidentialLand[0]',
      '特定居住用宅地等の確認済み入力に基づく簡易適用です。最終的な適用可否は申告前に確認してください')],
  };
}

function relationClass(relation) {
  if (['child', 'adopted_child', 'special_adopted_child'].includes(relation)) return 'child';
  if (relation === 'parent') return 'parent';
  if (relation === 'grandparent') return 'grandparent';
  if (relation === 'sibling_full' || relation === 'sibling_half') return 'sibling';
  return null;
}

function actualLegalHeirs(heirs) {
  const candidates = heirs.filter(heir => heir.isAlive !== false &&
    !isYes(heir.renounced) && !isYes(heir.disqualifiedOrExcluded));
  const spouses = candidates.filter(heir => heir.relation === 'spouse');
  const children = candidates.filter(heir => relationClass(heir.relation) === 'child');
  const parents = candidates.filter(heir => relationClass(heir.relation) === 'parent');
  const grandparents = candidates.filter(heir => relationClass(heir.relation) === 'grandparent');
  const siblings = candidates.filter(heir => relationClass(heir.relation) === 'sibling');
  const bloodRelatives = children.length > 0 ? children : parents.length > 0 ? parents :
    grandparents.length > 0 ? grandparents : siblings;
  const bloodClass = children.length > 0 ? 'child' : parents.length > 0 || grandparents.length > 0
    ? 'ascendant' : siblings.length > 0 ? 'sibling' : null;
  return { spouses, bloodRelatives, bloodClass };
}

function addRates(left, right) {
  return rate({ num: left.num * right.den + right.num * left.den, den: left.den * right.den });
}

function legalShares(heirs, onDate) {
  const legal = actualLegalHeirs(heirs);
  if (legal.spouses.length > 1 ||
      (legal.spouses.length === 0 && legal.bloodRelatives.length === 0)) {
    return { blockedReasons: [blockedReason('IHT_NO_STATUTORY_HEIR', '$.heirs',
      '法定相続分で仮配分できる相続人を確定できません')] };
  }
  const combination = legal.spouses.length > 0
    ? legal.bloodClass === null ? 'spouse_only' :
      legal.bloodClass === 'child' ? 'spouse_and_child' :
        legal.bloodClass === 'ascendant' ? 'spouse_and_ascendant' : 'spouse_and_sibling'
    : 'blood_relative_only';
  const combinationRecord = firstMaster('statutory_share_by_combination', onDate,
    row => row.combination === combination);
  const equalRule = firstMaster('statutory_share_equal_division', onDate,
    row => row.division_method === 'equal');
  const halfBloodRule = firstMaster('statutory_share_equal_division', onDate,
    row => row.division_method === 'half_blood_sibling_ratio');
  if (!combinationRecord || !equalRule || !halfBloodRule) {
    return { blockedReasons: [blockedReason('IHT_MASTER_UNAVAILABLE', '$.heirs',
      '法定相続分の仮配分に必要な承認済みマスターが利用できません')] };
  }

  const shares = [];
  if (legal.spouses.length === 1) {
    shares.push({ heirId: legal.spouses[0].id, share: masterRate(combinationRecord.spouse_share) });
  }
  if (legal.bloodRelatives.length > 0) {
    const groupShare = masterRate(combinationRecord.blood_relative_share);
    if (legal.bloodClass !== 'sibling') {
      for (const heir of legal.bloodRelatives) {
        shares.push({ heirId: heir.id, share: rate({
          num: groupShare.num,
          den: groupShare.den * BigInt(legal.bloodRelatives.length),
        }) });
      }
    } else {
      const halfRatio = masterRate(halfBloodRule.half_blood_ratio);
      const fullWeight = halfRatio.den;
      const halfWeight = halfRatio.num;
      const totalWeight = legal.bloodRelatives.reduce((total, heir) =>
        total + (heir.relation === 'sibling_half' ? halfWeight : fullWeight), 0n);
      for (const heir of legal.bloodRelatives) {
        const weight = heir.relation === 'sibling_half' ? halfWeight : fullWeight;
        shares.push({ heirId: heir.id, share: rate({
          num: groupShare.num * weight,
          den: groupShare.den * totalWeight,
        }) });
      }
    }
  }
  return { shares, actualHeirIds: new Set([
    ...legal.spouses.map(heir => heir.id),
    ...legal.bloodRelatives.map(heir => heir.id),
  ]) };
}

function divisionShares(input, onDate) {
  if (input.division === undefined) {
    const legal = legalShares(input.heirs, onDate);
    if (legal.blockedReasons) return legal;
    return {
      shares: legal.shares,
      assumption: '分割未確定のため法定相続分で仮計算しています',
    };
  }

  const knownIds = new Set(input.heirs.map(heir => heir.id));
  const seen = new Set();
  let total = rate({ num: 0n, den: 1n });
  const reasons = [];
  for (let index = 0; index < input.division.acquisitions.length; index++) {
    const acquisition = input.division.acquisitions[index];
    if (!knownIds.has(acquisition.heirId)) {
      reasons.push(blockedReason('SOZOKU_DIVISION_HEIR_UNKNOWN',
        `$.division.acquisitions[${index}].heirId`, '分割割合の相続人IDが相続人入力にありません'));
    }
    if (seen.has(acquisition.heirId)) {
      reasons.push(blockedReason('SOZOKU_DIVISION_HEIR_DUPLICATE',
        `$.division.acquisitions[${index}].heirId`, '同じ相続人の分割割合が重複しています'));
    }
    seen.add(acquisition.heirId);
    const share = rate(acquisition.share);
    if (share.num < 0n) {
      reasons.push(blockedReason('SOZOKU_DIVISION_SHARE_INVALID',
        `$.division.acquisitions[${index}].share`, '分割割合は0以上で入力してください'));
    }
    total = addRates(total, share);
  }
  if (total.num !== total.den) {
    reasons.push(blockedReason('SOZOKU_DIVISION_SHARE_TOTAL_INVALID',
      '$.division.acquisitions', '分割割合の合計を1にしてください'));
  }
  if (reasons.length > 0) return { blockedReasons: reasons };
  return { shares: input.division.acquisitions };
}

function allocateByShares(total, shares) {
  const byId = new Map();
  let allocated = zeroMoney();
  for (let index = 0; index < shares.length; index++) {
    const row = shares[index];
    const amount = index === shares.length - 1
      ? subtractMoney(total, allocated)
      : applyRounding(multiplyRateByMoney(row.share, total), ONE_YEN_ROUNDING);
    byId.set(row.heirId, addMoney(byId.get(row.heirId) || zeroMoney(), amount));
    allocated = addMoney(allocated, amount);
  }
  return byId;
}

function copyHeir(heir) {
  return {
    id: heir.id,
    relation: heir.relation,
    isAlive: heir.isAlive,
    ...(heir.renounced !== undefined ? { renounced: heir.renounced } : {}),
    ...(heir.disqualifiedOrExcluded !== undefined
      ? { disqualifiedOrExcluded: heir.disqualifiedOrExcluded } : {}),
    ...(heir.substitutedFor !== undefined ? { substitutedFor: heir.substitutedFor } : {}),
    ...(heir.adoptionFacts !== undefined ? { adoptionFacts: heir.adoptionFacts } : {}),
    ...(heir.isMinor !== undefined ? { isMinor: heir.isMinor } : {}),
    ...(heir.ageAtInheritance !== undefined ? { ageAtInheritance: heir.ageAtInheritance } : {}),
    ...(heir.disability !== undefined ? { disability: heir.disability } : {}),
    ...(heir.residencyStatus !== undefined ? { residencyStatus: heir.residencyStatus } : {}),
    ...(heir.previousInheritanceWithin10Years !== undefined
      ? { previousInheritanceWithin10Years: heir.previousInheritanceWithin10Years } : {}),
  };
}

function addAmount(person, field, amount) {
  person[field] = addMoney(person[field] || zeroMoney(), amount);
}

function buildEnginePeople(input, ordinaryById, shares) {
  const reasons = [];
  const people = input.heirs.map(copyHeir);
  const byId = new Map(people.map(person => [person.id, person]));
  if (byId.size !== people.length) {
    reasons.push(blockedReason('SOZOKU_HEIR_ID_DUPLICATE', '$.heirs',
      '相続人IDは重複しない値を指定してください'));
  }
  for (const person of people) addAmount(person, 'ordinaryAssets', ordinaryById.get(person.id) || zeroMoney());
  for (const row of shares || []) {
    const person = byId.get(row.heirId);
    if (person) person.divisionShare = rate(row.share);
  }

  function beneficiaryRows(rows, field, inputPath) {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      let person;
      if (row.isHeir) {
        person = row.beneficiaryHeirId === undefined ? null : byId.get(row.beneficiaryHeirId);
        if (!person) {
          reasons.push(blockedReason('SOZOKU_BENEFICIARY_HEIR_REQUIRED',
            `${inputPath}[${index}].beneficiaryHeirId`,
            '相続人が受取人の場合は相続人IDを指定してください'));
          continue;
        }
      } else {
        const baseId = row.beneficiaryHeirId || `non-heir-${field}-${index + 1}`;
        let id = baseId;
        while (byId.has(id)) id = `non-heir-${id}`;
        person = byId.get(id);
        if (!person) {
          person = { id, relation: 'other', isAlive: true, isStatutoryHeir: false };
          byId.set(id, person);
          people.push(person);
        }
      }
      addAmount(person, field, row.amount);
    }
  }

  beneficiaryRows(input.assets.lifeInsurance || [], 'lifeInsurance', '$.assets.lifeInsurance');
  beneficiaryRows(input.assets.retirementAllowance || [], 'retirementAllowance',
    '$.assets.retirementAllowance');
  for (let index = 0; index < input.debts.length; index++) {
    const debt = input.debts[index];
    const person = byId.get(debt.bearerHeirId);
    if (!person) {
      reasons.push(blockedReason('SOZOKU_DEBT_BEARER_UNKNOWN',
        `$.debts[${index}].bearerHeirId`, '負担者IDが相続人入力にありません'));
      continue;
    }
    addAmount(person, debt.kind === 'funeral' ? 'funeralExpenses' : 'debts', debt.amount);
  }
  return { people, reasons };
}

function baseEstateTotal(input, realEstateValues) {
  return sumMoney([
    input.assets.cash || zeroMoney(),
    input.assets.securities || zeroMoney(),
    input.assets.businessAssets || zeroMoney(),
    input.assets.otherAssets || zeroMoney(),
    ...realEstateValues,
  ]);
}

function grossEstateTotal(input, ordinaryBefore) {
  return sumMoney([
    ordinaryBefore,
    ...(input.assets.lifeInsurance || []).map(row => row.amount),
    ...(input.assets.retirementAllowance || []).map(row => row.amount),
  ]);
}

function deductibleTotal(input) {
  return sumMoney(input.debts.map(row => row.amount));
}

function basicDeduction(onDate, heirCount) {
  const record = firstMaster('inheritance_basic_deduction', onDate);
  if (!record) return null;
  return addMoney(masterMoney(record.base_amount),
    yen(BigInt(record.per_heir_amount.value) * heirCount));
}

function taxablePricesForLevel1(people, inputHeirs, onDate) {
  const countResult = inheritanceTax.calculateHeirCount(inputHeirs, { onDate });
  if (countResult.status !== 'complete') return countResult;
  const basic = basicDeduction(onDate, countResult.heirCountForTax);
  const insuranceRecord = firstMaster('life_insurance_exemption', onDate);
  const retirementRecord = firstMaster('retirement_allowance_exemption', onDate);
  if (!basic || !insuranceRecord || !retirementRecord) {
    return { status: 'blocked', blockedReasons: [{
      code: 'IHT_MASTER_UNAVAILABLE', message: '申告要否判定に必要な承認済みマスターが利用できません',
    }] };
  }
  const legalIds = actualLegalHeirs(inputHeirs);
  const actualIds = new Set([
    ...legalIds.spouses.map(heir => heir.id),
    ...legalIds.bloodRelatives.map(heir => heir.id),
  ]);
  const insuranceLimit = yen(BigInt(insuranceRecord.per_heir_amount.value) * countResult.heirCountForTax);
  const retirementLimit = yen(BigInt(retirementRecord.per_heir_amount.value) * countResult.heirCountForTax);
  const insurance = inheritanceTax.allocateNonTaxableAmount(people.map(person => ({
    id: person.id,
    amount: person.lifeInsurance || zeroMoney(),
    eligible: actualIds.has(person.id) && !isYes(person.renounced),
  })), insuranceLimit);
  const retirement = inheritanceTax.allocateNonTaxableAmount(people.map(person => ({
    id: person.id,
    amount: person.retirementAllowance || zeroMoney(),
    eligible: actualIds.has(person.id) && !isYes(person.renounced),
  })), retirementLimit);
  const insuranceById = new Map(insurance.allocations.map(row => [row.id, row.amount]));
  const retirementById = new Map(retirement.allocations.map(row => [row.id, row.amount]));
  const perHeir = people.map(person => {
    const gross = sumMoney([
      person.ordinaryAssets || zeroMoney(),
      person.lifeInsurance || zeroMoney(),
      person.retirementAllowance || zeroMoney(),
    ]);
    const deductions = sumMoney([person.debts || zeroMoney(), person.funeralExpenses || zeroMoney()]);
    let exactPrice = subtractExact(
      subtractExact(
        subtractExact(moneyToExact(gross), insuranceById.get(person.id)),
        retirementById.get(person.id)
      ),
      moneyToExact(deductions)
    );
    if (compareExact(exactPrice, zeroExact()) < 0) exactPrice = zeroExact();
    return { id: person.id, taxablePrice: applyRounding(exactPrice, TAXABLE_PRICE_ROUNDING) };
  });
  return {
    status: 'complete',
    heirCountForTax: countResult.heirCountForTax,
    basicDeduction: basic,
    totalTaxablePrice: sumMoney(perHeir.map(row => row.taxablePrice)),
    nonTaxableAmounts: addMoney(insurance.appliedTotal, retirement.appliedTotal),
    perHeir,
  };
}

function engineBlockedReasons(result) {
  return (result.blockedReasons || []).map(reason => blockedReason(
    reason.code || 'IHT_ENGINE_BLOCKED',
    reason.personId ? '$.heirs' : '$',
    reason.message || '相続税計算を完了できませんでした'
  ));
}

function totalPayable(result) {
  return sumMoney(result.perHeir.map(row => row.payable));
}

function totalCredits(row) {
  return sumExact(Object.values(row.credits || {}));
}

function allocationsFromEngine(result) {
  return result.perHeir.map(row => ({
    heirId: row.id,
    acquiredAmount: row.taxablePrice,
    allocatedTaxBeforeCredits: exactToYen(addExact(row.allocatedTax, row.surcharge)),
    credits: exactToYen(totalCredits(row)),
    creditDetails: {
      giftTax: exactToYen(row.credits.giftTax || zeroExact()),
      spouseRelief: exactToYen(row.credits.spouseRelief || zeroExact()),
      minor: exactToYen(row.credits.minor || zeroExact()),
      disability: exactToYen(row.credits.disability || zeroExact()),
    },
    finalTax: row.payable,
  }));
}

function blockedCalculation(reasons) {
  return {
    resultStatus: 'blocked',
    summary: { title: '第1版の対応範囲外または入力不足のため計算できません' },
    assumptions: [],
    warnings: reasons,
    excludedItems: [],
  };
}

function calculatePrimary(input, context) {
  const onDate = inheritanceOpenDateFrom(context);
  const blockers = supportedProfileReasons(input);
  if (blockers.length > 0) return blockedCalculation(blockers);

  const realEstate = convertRealEstate(input);
  const ordinaryBefore = baseEstateTotal(input, realEstate.values);
  const smallLand = calculateSmallLandReduction(input, onDate, realEstate.values);
  if (smallLand.blockedReasons) return blockedCalculation(smallLand.blockedReasons);
  const ordinaryAfter = subtractMoney(ordinaryBefore, smallLand.reduction);
  const selectedShares = divisionShares(input, onDate);
  if (selectedShares.blockedReasons) return blockedCalculation(selectedShares.blockedReasons);
  const ordinaryAfterById = allocateByShares(ordinaryAfter, selectedShares.shares);
  const ordinaryBeforeById = allocateByShares(ordinaryBefore, selectedShares.shares);

  const spouse = input.heirs.find(heir => heir.relation === 'spouse');
  if (input.division && input.division.spouseAcquisitionAmount !== undefined) {
    const calculated = spouse && ordinaryAfterById.get(spouse.id);
    if (!calculated || calculated.value !== input.division.spouseAcquisitionAmount.value) {
      return blockedCalculation([blockedReason('SOZOKU_SPOUSE_ACQUISITION_MISMATCH',
        '$.division.spouseAcquisitionAmount',
        '配偶者取得額が分割割合から算出した取得額と一致しません。入力内容を確認してください')]);
    }
  }

  const finalPeople = buildEnginePeople(input, ordinaryAfterById, selectedShares.shares);
  const beforePeople = buildEnginePeople(input, ordinaryBeforeById, selectedShares.shares);
  if (finalPeople.reasons.length > 0 || beforePeople.reasons.length > 0) {
    return blockedCalculation(uniqueWarnings([...finalPeople.reasons, ...beforePeople.reasons]));
  }

  const assumptions = selectedShares.assumption ? [selectedShares.assumption] : [];
  const warnings = [...realEstate.warnings, ...smallLand.warnings];
  const grossEstate = grossEstateTotal(input, ordinaryBefore);
  const debts = deductibleTotal(input);

  if (input.level === 1) {
    const engineInput = people => ({
      people,
      decedent: input.decedent,
      giftAddback: input.assets.giftAddback || [],
      isDivided: 'yes',
      applySpouseRelief: false,
    });
    const before = inheritanceTax.calculate(engineInput(beforePeople.people), { onDate });
    const after = inheritanceTax.calculate(engineInput(finalPeople.people), { onDate });
    if (before.status !== 'complete') return blockedCalculation(engineBlockedReasons(before));
    if (after.status !== 'complete') return blockedCalculation(engineBlockedReasons(after));
    const exceedsBasic = before.totalTaxablePrice.value > before.basicDeduction.value;
    const filingNeed = !exceedsBasic ? 'not_required' :
      smallLand.applied && after.totalTaxablePrice.value < before.totalTaxablePrice.value
        ? 'required_for_special_rule' : 'possibly_required';
    return {
      resultStatus: 'complete',
      summary: {
        title: filingNeed === 'not_required'
          ? '原則として相続税申告は不要です'
          : filingNeed === 'required_for_special_rule'
            ? '特例の利用には相続税申告が必要です'
            : '相続税申告が必要となる可能性があります',
      },
      breakdown: {
        kind: 'sozoku',
        data: {
          grossEstate,
          nonTaxableAmounts: exactToYen(sumExact(after.perHeir.map(row => addExact(
            row.lifeInsuranceExemption, row.retirementAllowanceExemption
          )))),
          deductibleDebtsAndFuneralCosts: debts,
          taxablePriceTotal: after.totalTaxablePrice,
          basicDeduction: after.basicDeduction,
          filingNeed,
          allocations: [],
          giftAddback: after.giftAddback,
        },
      },
      assumptions,
      warnings,
      excludedItems: [],
    };
  }

  const lateDivision = input.division &&
    (input.division.dividedAfterFilingDeadline === 'yes' ||
      input.division.dividedAfterFilingDeadline === 'unknown');
  const dividedForRelief = input.division === undefined ||
    (input.division.isDivided === 'yes' && !lateDivision);
  const beforeResult = inheritanceTax.calculate({
    people: beforePeople.people,
    decedent: input.decedent,
    isDivided: 'yes',
    applySpouseRelief: false,
    giftAddback: input.assets.giftAddback || [],
  }, { onDate });
  if (beforeResult.status !== 'complete') {
    return blockedCalculation(engineBlockedReasons(beforeResult));
  }
  const finalResult = inheritanceTax.calculate({
    people: finalPeople.people,
    decedent: input.decedent,
    isDivided: dividedForRelief ? 'yes' : 'no',
    applySpouseRelief: true,
    giftAddback: input.assets.giftAddback || [],
  }, { onDate });
  if (finalResult.status !== 'complete') {
    return blockedCalculation(engineBlockedReasons(finalResult));
  }
  warnings.push(...(finalResult.warnings || []).map(item => warning(
    item.code, item.personId ? '$.heirs' : '$', item.message
  )));
  if (lateDivision) {
    warnings.push(warning('SOZOKU_SPOUSE_RELIEF_NOT_APPLIED_LATE_DIVISION',
      '$.division.dividedAfterFilingDeadline',
      '申告期限後の分割または時期不明のため、配偶者の税額軽減を適用していません'));
  }

  const beforePayable = totalPayable(beforeResult);
  const finalPayable = totalPayable(finalResult);
  const spouseReliefApplied = finalResult.perHeir.some(row =>
    row.credits && compareExact(row.credits.spouseRelief, zeroExact()) > 0);
  const specialReducedTax = (smallLand.applied || spouseReliefApplied) &&
    finalPayable.value < beforePayable.value;
  const exceedsBasic = beforeResult.totalTaxablePrice.value > beforeResult.basicDeduction.value;
  const filingNeed = !exceedsBasic ? 'not_required' :
    specialReducedTax ? 'required_for_special_rule' : 'possibly_required';

  return {
    resultStatus: 'complete',
    summary: {
      title: filingNeed === 'required_for_special_rule'
        ? '特例の利用には相続税申告が必要です'
        : filingNeed === 'not_required'
          ? '原則として相続税申告は不要です'
          : '相続税申告が必要となる可能性があります',
      amount: finalPayable,
    },
    breakdown: {
      kind: 'sozoku',
      data: {
        grossEstate,
        nonTaxableAmounts: exactToYen(sumExact(finalResult.perHeir.map(row => addExact(
          row.lifeInsuranceExemption, row.retirementAllowanceExemption
        )))),
        deductibleDebtsAndFuneralCosts: debts,
        taxablePriceTotal: finalResult.totalTaxablePrice,
        basicDeduction: finalResult.basicDeduction,
        taxableEstate: finalResult.taxableEstate,
        totalInheritanceTax: finalResult.totalTax,
        filingNeed,
        allocations: allocationsFromEngine(finalResult),
        giftAddback: finalResult.giftAddback,
      },
    },
    assumptions,
    warnings: uniqueWarnings(warnings),
    excludedItems: [],
  };
}

/**
 * 配偶者の二次相続時点の財産を組成する純関数。
 * 金額・率はすべて厳密値のまま扱い、経年仮定は各年ごとに1円未満を切り捨てる。
 */
function composeSecondaryEstate({
  spouseOwnAssets,
  spouseAcquiredAmount,
  spousePrimaryTax,
  yearsUntilSecondary = 0,
  annualLivingCost = zeroMoney(),
  annualAssetChangeRate = rate({ num: 0n, den: 1n }),
}) {
  let estate = addMoney(spouseOwnAssets, spouseAcquiredAmount);
  estate = subtractMoney(estate, spousePrimaryTax);
  if (estate.value < 0n) estate = zeroMoney();

  const years = yearsUntilSecondary || 0;
  const change = rate(annualAssetChangeRate);
  const factor = rate({ num: change.den + change.num, den: change.den });
  for (let year = 0; year < years; year++) {
    const afterLivingCost = subtractMoney(estate, annualLivingCost || zeroMoney());
    if (afterLivingCost.value <= 0n) {
      estate = zeroMoney();
      break;
    }
    estate = applyRounding(multiplyRateByMoney(factor, afterLivingCost), ONE_YEN_ROUNDING);
    if (estate.value < 0n) {
      estate = zeroMoney();
      break;
    }
  }
  return estate;
}

function secondaryDivisionShares(input, onDate, spouseId, percent) {
  const legal = legalShares(input.heirs, onDate);
  if (legal.blockedReasons) return legal;
  const others = legal.shares.filter(row => row.heirId !== spouseId);
  if (others.length === 0 && percent !== 100) {
    return { blockedReasons: [blockedReason('IHT_NO_STATUTORY_HEIR', '$.heirs',
      '配偶者以外の法定相続人がいないため取得割合を走査できません')] };
  }
  const remaining = BigInt(100 - percent);
  const otherTotal = others.reduce((total, row) => addRates(total, rate(row.share)),
    rate({ num: 0n, den: 1n }));
  const shares = [{ heirId: spouseId, share: rate({ num: BigInt(percent), den: 100n }) }];
  for (const row of others) {
    const legalShare = rate(row.share);
    shares.push({
      heirId: row.heirId,
      share: rate({
        num: remaining * legalShare.num * otherTotal.den,
        den: 100n * legalShare.den * otherTotal.num,
      }),
    });
  }
  return { shares };
}

function secondaryTax(estate, expectedHeirs, onDate) {
  const count = expectedHeirs.length;
  const quotient = estate.value / BigInt(count);
  const remainder = estate.value - quotient * BigInt(count);
  const people = expectedHeirs.map((heir, index) => ({
    id: heir.id || `secondary-heir-${index + 1}`,
    relation: heir.relation === 'child' ? 'child' : 'sibling_full',
    isAlive: true,
    residencyStatus: 'domestic_resident',
    ordinaryAssets: yen(quotient + (index === 0 ? remainder : 0n)),
    divisionShare: rate({ num: 1n, den: BigInt(count) }),
  }));
  const result = inheritanceTax.calculate({
    people,
    decedent: {},
    isDivided: 'yes',
    applySpouseRelief: false,
    giftAddback: [],
  }, { onDate });
  if (result.status !== 'complete') return { blockedReasons: engineBlockedReasons(result) };
  return { tax: totalPayable(result), engineResult: result };
}

function calculateSecondaryInheritance(input, context, primaryCalculation) {
  const onDate = inheritanceOpenDateFrom(context);
  const secondary = input.secondaryInheritance;
  const spouse = input.heirs.find(heir => heir.relation === 'spouse');
  if (!spouse || primaryCalculation.resultStatus !== 'complete') return null;
  if (secondary.expectedHeirs.length === 0) {
    return { blockedReasons: [blockedReason('SOZOKU_SECONDARY_HEIRS_REQUIRED',
      '$.secondaryInheritance.expectedHeirs', '二次相続の想定相続人を1人以上指定してください')] };
  }

  const scenarios = [];
  for (let percent = 0; percent <= 100; percent += 10) {
    const selected = secondaryDivisionShares(input, onDate, spouse.id, percent);
    if (selected.blockedReasons) return { blockedReasons: selected.blockedReasons };
    const scenarioInput = {
      ...input,
      level: 2,
      division: {
        isDivided: 'yes',
        dividedAfterFilingDeadline: 'no',
        acquisitions: selected.shares,
      },
    };
    delete scenarioInput.secondaryInheritance;
    const primary = calculatePrimary(scenarioInput, context);
    if (primary.resultStatus !== 'complete') return { blockedReasons: primary.warnings };

    const primaryPayable = primary.summary.amount;
    const spouseAllocation = primary.breakdown.data.allocations.find(row => row.heirId === spouse.id);
    const spousePrimaryTax = spouseAllocation ? spouseAllocation.finalTax : zeroMoney();
    const spouseAcquiredAmount = applyRounding(multiplyRateByMoney(
      rate({ num: BigInt(percent), den: 100n }),
      primary.breakdown.data.taxablePriceTotal
    ), ONE_YEN_ROUNDING);
    const secondaryEstate = composeSecondaryEstate({
      spouseOwnAssets: secondary.spouseOwnAssets,
      spouseAcquiredAmount,
      spousePrimaryTax,
      yearsUntilSecondary: secondary.yearsUntilSecondary,
      annualLivingCost: secondary.annualLivingCost,
      annualAssetChangeRate: secondary.annualAssetChangeRate,
    });
    const calculatedSecondary = secondaryTax(secondaryEstate, secondary.expectedHeirs, onDate);
    if (calculatedSecondary.blockedReasons) return calculatedSecondary;
    scenarios.push({
      spouseAcquisitionPercent: percent,
      spouseAcquisitionRatio: rate({ num: BigInt(percent), den: 100n }),
      primaryPayableTotal: primaryPayable,
      spousePrimaryPayable: spousePrimaryTax,
      spouseAcquiredAmount,
      secondaryEstate,
      secondaryTaxTotal: calculatedSecondary.tax,
      combinedTaxTotal: addMoney(primaryPayable, calculatedSecondary.tax),
    });
  }
  const minimum = scenarios.reduce((best, scenario) =>
    scenario.combinedTaxTotal.value < best.combinedTaxTotal.value ? scenario : best);
  return {
    scenarios,
    minimumSpouseAcquisitionPercent: minimum.spouseAcquisitionPercent,
    minimumCombinedTaxTotal: minimum.combinedTaxTotal,
    successiveInheritanceCreditPossible: scenarios.some(row => row.spousePrimaryPayable.value > 0n) &&
      (secondary.yearsUntilSecondary === undefined || secondary.yearsUntilSecondary <= 10),
    yearsUntilSecondary: secondary.yearsUntilSecondary,
    annualLivingCost: secondary.annualLivingCost,
    annualAssetChangeRate: secondary.annualAssetChangeRate,
  };
}

function calculate(input, context) {
  const primary = calculatePrimary(input, context);
  if (!input.secondaryInheritance || input.level === 1 || primary.resultStatus !== 'complete') {
    return primary;
  }
  const secondary = calculateSecondaryInheritance(input, context, primary);
  if (secondary && secondary.blockedReasons) return blockedCalculation(secondary.blockedReasons);
  if (!secondary) return primary;
  return {
    ...primary,
    breakdown: {
      ...primary.breakdown,
      data: { ...primary.breakdown.data, secondaryInheritance: secondary },
    },
    assumptions: [...new Set([
      ...primary.assumptions,
      '二次相続の走査では、実際の分割状況にかかわらず分割済みとして配偶者の税額軽減を適用しています',
      '二次相続では配偶者の税額軽減・保険非課税・小規模宅地等・生前贈与加算・各種控除を適用していません',
      '相次相続控除はこの試算に適用していません',
    ])],
  };
}

function validate(wireInput) {
  const validation = validateInput('sozoku', wireInput);
  if (!validation.ok) return validation;
  if (validation.value.secondaryInheritance &&
      validation.value.secondaryInheritance.expectedHeirs.length === 0) {
    return {
      ok: false,
      errors: [warning('SOZOKU_SECONDARY_HEIRS_REQUIRED',
        '$.secondaryInheritance.expectedHeirs', '二次相続の想定相続人を1人以上指定してください')],
      normalizationSuggestions: [],
    };
  }
  return validation;
}

function simulate(input, context, masters) {
  assertSnapshotMatch(context, masters);
  snapshot.beginRecordTracking();
  let calculation;
  let usedMasterRecords;
  try {
    calculation = calculate(input, context);
    usedMasterRecords = snapshot.endRecordTracking();
  } catch (error) {
    snapshot.endRecordTracking();
    throw error;
  }
  return buildSimulationResult({
    simulatorType: 'sozoku',
    periodLabel: `相続開始日 ${inheritanceOpenDateFrom(context)}`,
    comparisonBasis: 'steady_state',
    resultStatus: calculation.resultStatus,
    summary: calculation.summary,
    breakdown: calculation.breakdown,
    assumptions: calculation.assumptions,
    warnings: calculation.warnings,
    masters,
    calculationContext: context,
    usedMasterRecords,
    precision: input.precision,
    excludedItems: calculation.excludedItems,
  });
}

module.exports = Object.freeze({ validate, simulate, composeSecondaryEstate });
