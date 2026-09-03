'use strict';

/**
 * 相続税計算エンジン（仕様書 §28-1、第1版対応範囲）。
 *
 * 入力はエンジン単体用で、各取得者を heirs（または people）に並べる。
 * 各取得者の金額欄は ordinaryAssets（taxablePrice も可）、lifeInsurance、
 * retirementAllowance、debts、funeralExpenses の Money とする。
 * 丸め前の金額は Exact のまま返し、Money への確定は rounding.js だけで行う。
 */

const {
  money,
  exact,
  rate,
  moneyToExact,
  multiplyRateByMoney,
  addExact,
  subtractExact,
  addMoney,
  subtractMoney,
  compareExact,
  compareExactToMoney,
} = require('../common/money.js');
const { applyRounding } = require('../common/rounding.js');
const masters = require('../masters/snapshot.js');

const BASE_ROUNDING_RULE_ID = 'R-TRUNC-1000-IHT-BASE';
const LEGAL_SHARE_ROUNDING_RULE_ID = 'R-TRUNC-1000-IHT-LEGAL-SHARE';
const FINAL_ROUNDING_RULE_ID = 'R-TRUNC-100-IHT-FINAL';
const NO_ROUNDING_RULE_ID = 'R-NONE';

function zeroMoney() {
  return money({ unit: 'JPY', value: 0n });
}

function zeroExact() {
  return moneyToExact(zeroMoney());
}

function masterMoney(value) {
  return money({ unit: value.unit, value: BigInt(value.value) });
}

function masterRate(value) {
  return rate({ num: BigInt(value.num), den: BigInt(value.den) });
}

function inputMoney(value, fieldName) {
  if (value === undefined || value === null) return zeroMoney();
  if (typeof value === 'object' && value.unit === 'JPY' && typeof value.value === 'string') {
    return money({ unit: 'JPY', value: BigInt(value.value) });
  }
  try {
    return money(value);
  } catch (error) {
    error.message = `${fieldName}: ${error.message}`;
    throw error;
  }
}

function sumMoney(values) {
  return values.reduce((total, value) => addMoney(total, value), zeroMoney());
}

function sumExact(values) {
  return values.reduce((total, value) => addExact(total, value), zeroExact());
}

function isPositive(value) {
  return compareExactToMoney(moneyToExact(value), zeroMoney()) > 0;
}

function minMoney(left, right) {
  return compareExact(moneyToExact(left), moneyToExact(right)) <= 0 ? left : right;
}

function validLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** 民法143条2項の暦の応当日。応当日がない場合はその月の末日。 */
function calendarYearsBefore(localDate, years) {
  if (!validLocalDate(localDate) || !Number.isInteger(years) || years < 0) return null;
  const [yearText, monthText, dayText] = localDate.split('-');
  const year = Number(yearText) - years;
  const month = Number(monthText);
  const day = Math.min(Number(dayText), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return `${String(year).padStart(4, '0')}-${monthText}-${String(day).padStart(2, '0')}`;
}

function previousLocalDate(localDate) {
  if (!validLocalDate(localDate)) return null;
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function standardGiftAddbackYears(periodRecord) {
  let current = periodRecord;
  let shortest = null;
  // 「相続開始前3年以内」の基礎部分も期間マスターの過去レコードから導く。
  // 経過措置・7年化後も、税法定数をコードへ直接置かない。
  while (current) {
    if (Number.isInteger(current.years_before_death) && current.years_before_death > 0) {
      shortest = shortest === null
        ? current.years_before_death : Math.min(shortest, current.years_before_death);
    }
    const priorDate = previousLocalDate(current.effective_from);
    current = priorDate
      ? masterRecord('inheritance_gift_addback_period', priorDate) : null;
  }
  return shortest;
}

function floorExactAtZero(value) {
  return compareExact(value, zeroExact()) < 0 ? zeroExact() : exact(value);
}

function isYes(value) {
  return value === true || value === 'yes';
}

function isRenounced(person) {
  return isYes(person.renounced);
}

function isDisqualifiedOrExcluded(person) {
  return isYes(person.disqualifiedOrExcluded);
}

function isAlive(person) {
  return person.isAlive !== false;
}

function addReason(reasons, code, message, personId) {
  if (reasons.some(reason => reason.code === code && reason.personId === personId)) return;
  const reason = { code, message };
  if (personId !== undefined) reason.personId = personId;
  reasons.push(reason);
}

function addWarning(warnings, code, message, personId) {
  const warning = { code, message };
  if (personId !== undefined) warning.personId = personId;
  warnings.push(warning);
}

function normalizePeople(input) {
  const source = Array.isArray(input.people) ? input.people : input.heirs;
  if (!Array.isArray(source)) return [];
  return source.map((person, index) => ({
    ...person,
    id: person.id || `person-${index + 1}`,
  }));
}

function firstMoneyField(person, names, label) {
  const name = names.find(candidate => person[candidate] !== undefined);
  return inputMoney(name === undefined ? undefined : person[name], `${person.id}.${label}`);
}

function amountsFor(person) {
  const ordinaryAssets = firstMoneyField(
    person,
    ['ordinaryAssets', 'acquiredProperty', 'property', 'taxablePrice'],
    'ordinaryAssets'
  );
  const lifeInsurance = firstMoneyField(person, ['lifeInsurance'], 'lifeInsurance');
  const retirementAllowance = firstMoneyField(
    person,
    ['retirementAllowance', 'retirementBenefits'],
    'retirementAllowance'
  );
  const debts = firstMoneyField(person, ['debts', 'debt'], 'debts');
  const funeralExpenses = firstMoneyField(person, ['funeralExpenses'], 'funeralExpenses');
  return { ordinaryAssets, lifeInsurance, retirementAllowance, debts, funeralExpenses };
}

function relationRank(relation) {
  if (relation === 'child' || relation === 'adopted_child' || relation === 'special_adopted_child') return 1;
  if (relation === 'parent') return 2;
  if (relation === 'grandparent') return 3;
  if (relation === 'sibling_full' || relation === 'sibling_half') return 4;
  return null;
}

/**
 * 民法上の相続人を、配偶者＋最上位の血族相続人として確定する。
 * ignoreRenunciation=true は相法15条2項の人数算定専用。
 */
function determineStatutoryHeirs(people, { ignoreRenunciation }) {
  const candidates = people.filter(person =>
    isAlive(person) && !isDisqualifiedOrExcluded(person) &&
    (ignoreRenunciation || !isRenounced(person)) && person.isStatutoryHeir !== false
  );
  const spouses = candidates.filter(person => person.relation === 'spouse');
  const ranked = candidates
    .map(person => ({ person, rank: relationRank(person.relation) }))
    .filter(item => item.rank !== null);
  const highestRank = ranked.length === 0
    ? null
    : ranked.reduce((lowest, item) => item.rank < lowest ? item.rank : lowest, ranked[0].rank);
  const bloodRelatives = highestRank === null
    ? []
    : ranked.filter(item => item.rank === highestRank).map(item => item.person);
  return { spouses, bloodRelatives, highestRank };
}

function masterRecord(valueKey, onDate, predicate) {
  const matches = masters.find(valueKey, { onDate }).filter(predicate || (() => true));
  return matches.length === 1 ? matches[0] : null;
}

function adoptionFactsAreComplete(person) {
  if (person.relation === 'special_adopted_child') return true;
  if (person.relation !== 'adopted_child') return true;
  return person.adoptionFacts !== null && typeof person.adoptionFacts === 'object' &&
    typeof person.adoptionFacts.isSpecialAdoption === 'boolean' &&
    typeof person.adoptionFacts.isStepChildOfSpouse === 'boolean';
}

function isDeemedRealChild(person) {
  return person.relation === 'special_adopted_child' ||
    (person.relation === 'adopted_child' &&
      (person.adoptionFacts.isSpecialAdoption || person.adoptionFacts.isStepChildOfSpouse));
}

function calculateHeirCount(heirs, { onDate } = {}) {
  const reasons = [];
  if (typeof onDate !== 'string') {
    addReason(reasons, 'IHT_ON_DATE_REQUIRED', '適用マスターを選ぶ相続開始日が必要です');
    return { status: 'blocked', blockedReasons: reasons, heirCountForTax: null };
  }

  for (const person of heirs) {
    if (person.substitutedFor !== undefined ||
        (person.adoptionFacts && person.adoptionFacts.isSubstituteForDescendant === true)) {
      addReason(
        reasons,
        'IHT_SUBSTITUTED_SUCCESSION_UNSUPPORTED',
        '代襲相続は第1版では計算できません',
        person.id
      );
    }
    if (isDisqualifiedOrExcluded(person) || person.disqualifiedOrExcluded === 'unknown') {
      addReason(
        reasons,
        'IHT_DISQUALIFICATION_EXCLUSION_UNSUPPORTED',
        '欠格・廃除を含む相続人確定は第1版では計算できません',
        person.id
      );
    }
    if (!adoptionFactsAreComplete(person)) {
      addReason(
        reasons,
        'IHT_ADOPTION_FACTS_REQUIRED',
        '養子を実子とみなす判定材料が不足しています',
        person.id
      );
    }
  }
  if (reasons.length > 0) {
    return { status: 'blocked', blockedReasons: reasons, heirCountForTax: null };
  }

  const legal = determineStatutoryHeirs(heirs, { ignoreRenunciation: true });
  const adoptedWithReal = masterRecord(
    'statutory_heir_count_adopted_limit',
    onDate,
    row => row.applicability_conditions.some(condition => condition.value === true)
  );
  const adoptedWithoutReal = masterRecord(
    'statutory_heir_count_adopted_limit',
    onDate,
    row => row.applicability_conditions.some(condition => condition.value === false)
  );
  const renunciationRule = masterRecord('statutory_heir_count_renunciation_rule', onDate);
  const deemedRealRules = masters.find('statutory_heir_count_deemed_real_child', { onDate });
  if (!adoptedWithReal || !adoptedWithoutReal || !renunciationRule || deemedRealRules.length === 0) {
    addReason(reasons, 'IHT_MASTER_UNAVAILABLE', '法定相続人の数の算定マスターが利用できません');
    return { status: 'blocked', blockedReasons: reasons, heirCountForTax: null };
  }
  if (renunciationRule.treat_renunciation_as_not_occurred !== true) {
    throw new Error('法定相続人の数の算定で相続放棄をなかったものとする不変条件に違反しました');
  }

  const childClass = legal.bloodRelatives.filter(person => relationRank(person.relation) === 1);
  const ordinaryAdopted = childClass.filter(person =>
    person.relation === 'adopted_child' && !isDeemedRealChild(person)
  );
  const realOrDeemedChildren = childClass.filter(person =>
    person.relation === 'child' || isDeemedRealChild(person)
  );
  const hasRealChild = realOrDeemedChildren.length > 0;
  const applicableLimit = hasRealChild ? adoptedWithReal : adoptedWithoutReal;
  const countableAdopted = Math.min(ordinaryAdopted.length, applicableLimit.adopted_children_countable);
  const nonChildBloodCount = legal.bloodRelatives.length - childClass.length;
  const count = BigInt(
    legal.spouses.length + realOrDeemedChildren.length + countableAdopted + nonChildBloodCount
  );

  return {
    status: 'complete',
    blockedReasons: [],
    heirCountForTax: count,
    statutoryHeirIdsIgnoringRenunciation: [
      ...legal.spouses.map(person => person.id),
      ...legal.bloodRelatives.map(person => person.id),
    ],
    countableAdoptedHeirIds: ordinaryAdopted.slice(0, countableAdopted).map(person => person.id),
  };
}

/**
 * 保険金・退職金の非課税枠を、対象者の取得比の Exact で配分する。
 */
function allocateNonTaxableAmount(recipients, limit) {
  const checkedLimit = money(limit);
  const eligible = recipients.filter(recipient => recipient.eligible);
  const eligibleTotal = sumMoney(eligible.map(recipient => money(recipient.amount)));
  const appliedTotal = minMoney(checkedLimit, eligibleTotal);
  const allocations = recipients.map(recipient => ({ id: recipient.id, amount: zeroExact() }));

  if (compareExact(moneyToExact(eligibleTotal), zeroExact()) === 0) {
    return { appliedTotal, allocations };
  }

  for (const allocation of allocations) {
    const recipient = eligible.find(item => item.id === allocation.id);
    if (!recipient) continue;
    allocation.amount = multiplyRateByMoney(
      rate({ num: money(recipient.amount).value, den: eligibleTotal.value }),
      appliedTotal
    );
  }

  const allocatedTotal = sumExact(allocations.map(allocation => allocation.amount));
  if (compareExact(allocatedTotal, moneyToExact(appliedTotal)) !== 0) {
    throw new Error('非課税限度額の配分合計が適用額と一致しません');
  }
  return { appliedTotal, allocations };
}

function rateForBloodRelative(person, bloodRelatives, groupShare, halfBloodRule) {
  if (person.relation !== 'sibling_full' && person.relation !== 'sibling_half') {
    return rate({
      num: BigInt(groupShare.num),
      den: BigInt(groupShare.den) * BigInt(bloodRelatives.length),
    });
  }

  const halfBloodRatio = masterRate(halfBloodRule.half_blood_ratio);
  const fullWeight = halfBloodRatio.den;
  const halfWeight = halfBloodRatio.num;
  const fullCount = BigInt(bloodRelatives.filter(item => item.relation === 'sibling_full').length);
  const halfCount = BigInt(bloodRelatives.filter(item => item.relation === 'sibling_half').length);
  const totalWeight = fullWeight * fullCount + halfWeight * halfCount;
  const personWeight = person.relation === 'sibling_half' ? halfWeight : fullWeight;
  return rate({
    num: BigInt(groupShare.num) * personWeight,
    den: BigInt(groupShare.den) * totalWeight,
  });
}

function legalCombination(legal) {
  if (legal.spouses.length > 0 && legal.bloodRelatives.length === 0) return 'spouse_only';
  if (legal.spouses.length === 0) return 'blood_relative_only';
  if (legal.highestRank === 1) return 'spouse_and_child';
  if (legal.highestRank === 2 || legal.highestRank === 3) return 'spouse_and_ascendant';
  if (legal.highestRank === 4) return 'spouse_and_sibling';
  return null;
}

function calculateTaxTotalFromTaxableEstate(taxableEstate, heirs, { onDate } = {}) {
  const reasons = [];
  if (typeof onDate !== 'string') {
    addReason(reasons, 'IHT_ON_DATE_REQUIRED', '適用マスターを選ぶ相続開始日が必要です');
    return { status: 'blocked', blockedReasons: reasons };
  }
  const estate = money(taxableEstate);
  const legal = determineStatutoryHeirs(heirs, { ignoreRenunciation: false });
  if (legal.spouses.length > 1) {
    addReason(reasons, 'IHT_MULTIPLE_SPOUSES', '配偶者を複数人に確定できません');
  }
  if (legal.spouses.length === 0 && legal.bloodRelatives.length === 0) {
    addReason(reasons, 'IHT_NO_STATUTORY_HEIR', '法定相続分を計算できる相続人がいません');
  }
  const combination = legalCombination(legal);
  const combinationRecord = combination
    ? masterRecord('statutory_share_by_combination', onDate, row => row.combination === combination)
    : null;
  const equalDivision = masterRecord(
    'statutory_share_equal_division',
    onDate,
    row => row.division_method === 'equal'
  );
  const halfBloodRule = masterRecord(
    'statutory_share_equal_division',
    onDate,
    row => row.division_method === 'half_blood_sibling_ratio'
  );
  const brackets = masters.find('inheritance_tax_brackets', { onDate });
  if (!combinationRecord || !equalDivision || !halfBloodRule || brackets.length === 0) {
    addReason(reasons, 'IHT_MASTER_UNAVAILABLE', '法定相続分または相続税率のマスターが利用できません');
  }
  if (reasons.length > 0) return { status: 'blocked', blockedReasons: reasons };
  if (!brackets.every(row => row.rounding_rule_id === LEGAL_SHARE_ROUNDING_RULE_ID)) {
    throw new Error('法定相続分に応ずる取得金額の端数規則が不一致です');
  }

  const shares = [];
  if (legal.spouses.length === 1) {
    shares.push({
      person: legal.spouses[0],
      share: masterRate(combinationRecord.spouse_share),
    });
  }
  if (legal.bloodRelatives.length > 0) {
    for (const person of legal.bloodRelatives) {
      shares.push({
        person,
        share: rateForBloodRelative(
          person,
          legal.bloodRelatives,
          combinationRecord.blood_relative_share,
          halfBloodRule
        ),
      });
    }
  }

  const statutoryShares = shares.map(item => {
    const legalShareAmount = applyRounding(
      multiplyRateByMoney(item.share, estate),
      LEGAL_SHARE_ROUNDING_RULE_ID
    );
    const bracket = masters.findBracket('inheritance_tax_brackets', legalShareAmount, { onDate });
    if (!bracket) throw new Error('相続税率表に該当する段がありません');
    const taxExact = subtractExact(
      multiplyRateByMoney(masterRate(bracket.rate), legalShareAmount),
      moneyToExact(masterMoney(bracket.quick_deduction))
    );
    const tax = applyRounding(taxExact, NO_ROUNDING_RULE_ID);
    return {
      id: item.person.id,
      relation: item.person.relation,
      share: item.share,
      legalShareAmount,
      tax,
    };
  });
  const totalTax = sumMoney(statutoryShares.map(item => item.tax));
  return { status: 'complete', blockedReasons: [], statutoryShares, totalTax };
}

function unsupportedInputReasons(input, people, amountRows) {
  const reasons = [];
  const decedentResidency = input.decedent && input.decedent.residencyStatus;
  if (decedentResidency && decedentResidency !== 'domestic_resident') {
    addReason(reasons, 'IHT_NON_RESIDENT', '非居住者は第1版の対応範囲外です');
  }
  if (input.residencyStatus && input.residencyStatus !== 'domestic_resident') {
    addReason(reasons, 'IHT_NON_RESIDENT', '非居住者は第1版の対応範囲外です');
  }
  if (isYes(input.hasForeignAssets) || input.assetsLocation === 'foreign') {
    addReason(reasons, 'IHT_FOREIGN_PROPERTY', '国外財産は第1版の対応範囲外です');
  }

  for (const person of people) {
    if (person.substitutedFor !== undefined ||
        (person.adoptionFacts && person.adoptionFacts.isSubstituteForDescendant === true)) {
      addReason(reasons, 'IHT_SUBSTITUTED_SUCCESSION_UNSUPPORTED', '代襲相続は第1版では計算できません', person.id);
    }
    if (isDisqualifiedOrExcluded(person)) {
      addReason(reasons, 'IHT_DISQUALIFICATION_EXCLUSION_UNSUPPORTED', '欠格・廃除は第1版では計算できません', person.id);
    }
    if (person.disqualifiedOrExcluded === 'unknown') {
      addReason(reasons, 'IHT_DISQUALIFICATION_STATUS_UNKNOWN', '欠格・廃除の有無を確定できません', person.id);
    }
    if (person.renounced === 'unknown') {
      addReason(reasons, 'IHT_RENUNCIATION_STATUS_UNKNOWN', '相続放棄の有無を確定できません', person.id);
    }
    if (!adoptionFactsAreComplete(person)) {
      addReason(reasons, 'IHT_ADOPTION_FACTS_REQUIRED', '養子を実子とみなす判定材料が不足しています', person.id);
    }
    if (person.residencyStatus && person.residencyStatus !== 'domestic_resident') {
      addReason(reasons, 'IHT_NON_RESIDENT', '非居住者は第1版の対応範囲外です', person.id);
    }
    if (person.previousInheritanceWithin10Years !== undefined) {
      addReason(reasons, 'IHT_SUCCESSIVE_INHERITANCE_CREDIT_UNSUPPORTED', '相次相続控除は第1版では計算できません', person.id);
    }
    if (person.foreignTaxCredit !== undefined) {
      addReason(reasons, 'IHT_FOREIGN_TAX_CREDIT_UNSUPPORTED', '外国税額控除は第1版では計算できません', person.id);
    }
    if (person.isMinor === true && !Number.isInteger(person.ageAtInheritance)) {
      addReason(reasons, 'IHT_MINOR_AGE_REQUIRED', '未成年者控除には相続開始時の満年齢が必要です', person.id);
    }
    if (person.disability && person.disability !== 'none' &&
        !Number.isInteger(person.ageAtInheritance)) {
      addReason(reasons, 'IHT_DISABILITY_AGE_REQUIRED', '障害者控除には相続開始時の満年齢が必要です', person.id);
    }
  }

  for (const row of amountRows) {
    const acquired = sumMoney([
      row.amounts.ordinaryAssets,
      row.amounts.lifeInsurance,
      row.amounts.retirementAllowance,
    ]);
    if (isRenounced(row.person) && isPositive(acquired)) {
      addReason(
        reasons,
        'IHT_RENOUNCER_ACQUIRED_PROPERTY',
        '相続放棄者が財産・保険金等を取得しているため計算できません',
        row.person.id
      );
    }
  }

  const assets = input.assets || {};
  const settlement = input.settlementTaxationGifts || assets.settlementTaxationGifts;
  if (settlement !== undefined && isPositive(inputMoney(settlement, 'settlementTaxationGifts'))) {
    addReason(reasons, 'IHT_SETTLEMENT_TAXATION_UNSUPPORTED', '相続時精算課税適用財産は第1版では計算できません');
  }
  if (input.successiveInheritanceCredit !== undefined) {
    addReason(reasons, 'IHT_SUCCESSIVE_INHERITANCE_CREDIT_UNSUPPORTED', '相次相続控除は第1版では計算できません');
  }
  if (input.foreignTaxCredit !== undefined) {
    addReason(reasons, 'IHT_FOREIGN_TAX_CREDIT_UNSUPPORTED', '外国税額控除は第1版では計算できません');
  }
  if (Array.isArray(input.smallResidentialLand) && input.smallResidentialLand.length > 0) {
    addReason(reasons, 'IHT_SMALL_RESIDENTIAL_LAND_UNSUPPORTED', '小規模宅地等の特例は第1版では直接計算できません');
  }
  if (Array.isArray(assets.realEstate) && assets.realEstate.some(item => item.kind !== 'appraised')) {
    addReason(reasons, 'IHT_DIRECT_APPRAISAL_REQUIRED', '不動産は評価額の直接入力が必要です');
  }

  const specialistChecks = input.specialistChecks || {};
  for (const [key, value] of Object.entries(specialistChecks)) {
    if (!isYes(value)) continue;
    if (/foreign|overseas|国外|non.?resident/i.test(key)) {
      addReason(reasons, 'IHT_FOREIGN_PROPERTY', '国外・非居住の専門判定項目があるため計算できません');
    }
    if (/small.*residential|小規模宅地/i.test(key)) {
      addReason(reasons, 'IHT_SMALL_RESIDENTIAL_LAND_UNSUPPORTED', '小規模宅地等の特例は第1版では直接計算できません');
    }
  }
  return reasons;
}

function limitFromPerHeir(record, heirCount) {
  return applyRounding(
    multiplyRateByMoney(rate({ num: heirCount, den: 1n }), masterMoney(record.per_heir_amount)),
    NO_ROUNDING_RULE_ID
  );
}

function calculateBasicDeduction(record, heirCount) {
  const perHeir = limitFromPerHeir(record, heirCount);
  return addMoney(masterMoney(record.base_amount), perHeir);
}

function creditEntitlement(record, age) {
  const years = BigInt(Math.max(0, record.age_threshold - age));
  return applyRounding(
    multiplyRateByMoney(rate({ num: years, den: 1n }), masterMoney(record.per_year_amount)),
    NO_ROUNDING_RULE_ID
  );
}

function applyCredit(currentTax, entitlement, warnings, warningCode, message, personId) {
  if (compareExact(currentTax, moneyToExact(entitlement)) >= 0) {
    return { remaining: subtractExact(currentTax, moneyToExact(entitlement)), applied: moneyToExact(entitlement) };
  }
  const applied = floorExactAtZero(currentTax);
  if (isPositive(entitlement) && compareExact(currentTax, moneyToExact(entitlement)) < 0) {
    addWarning(warnings, warningCode, message, personId);
  }
  return { remaining: zeroExact(), applied };
}

function giftAddbackInputs(input) {
  const assets = input.assets || {};
  return Array.isArray(input.giftAddback) ? input.giftAddback :
    Array.isArray(assets.giftAddback) ? assets.giftAddback : [];
}

function calculateGiftAddback(input, people, actualHeirIds, onDate, warnings) {
  const gifts = giftAddbackInputs(input);
  const empty = {
    periodRuleId: null,
    periodStartDate: null,
    threeYearStartDate: null,
    totalAddback: zeroMoney(),
    totalExtraDeduction: zeroMoney(),
    gifts: [],
    perRecipient: [],
  };
  if (gifts.length === 0) return { status: 'complete', ...empty };

  const periodRecord = masterRecord('inheritance_gift_addback_period', onDate);
  if (!periodRecord) {
    return {
      status: 'blocked',
      blockedReasons: [{
        code: 'IHT_MASTER_UNAVAILABLE',
        message: '生前贈与加算の対象期間に必要な承認済みマスターが利用できません',
      }],
    };
  }
  const standardYears = standardGiftAddbackYears(periodRecord);
  const threeYearStartDate = calendarYearsBefore(onDate, standardYears);
  const periodStartDate = periodRecord.period_method === 'fixed_start_to_death'
    ? periodRecord.fixed_start_date
    : calendarYearsBefore(onDate, periodRecord.years_before_death);
  if (!threeYearStartDate || !periodStartDate) {
    return {
      status: 'blocked',
      blockedReasons: [{ code: 'IHT_MASTER_UNAVAILABLE', message: '生前贈与加算期間を確定できません' }],
    };
  }

  const peopleById = new Map(people.map(person => [person.id, person]));
  const reasons = [];
  const details = gifts.map((gift, index) => {
    const recipient = peopleById.get(gift.recipientHeirId);
    if (!recipient || !actualHeirIds.has(gift.recipientHeirId)) {
      addReason(reasons, 'IHT_GIFT_ADDBACK_RECIPIENT_INVALID',
        `生前贈与${index + 1}の受贈者は既存の相続人から指定してください`, gift.recipientHeirId);
    }
    if (!validLocalDate(gift.giftedOn)) {
      addReason(reasons, 'IHT_GIFT_ADDBACK_DATE_INVALID',
        `生前贈与${index + 1}の贈与日を有効な日付で指定してください`);
    }
    const amount = inputMoney(gift.amount, `giftAddback[${index}].amount`);
    const giftTaxPaid = inputMoney(gift.giftTaxPaid, `giftAddback[${index}].giftTaxPaid`);
    if (amount.value < 0n || giftTaxPaid.value < 0n) {
      addReason(reasons, 'IHT_GIFT_ADDBACK_AMOUNT_INVALID',
        `生前贈与${index + 1}の金額は0円以上で指定してください`);
    }
    const withinPeriod = validLocalDate(gift.giftedOn) &&
      gift.giftedOn >= periodStartDate && gift.giftedOn <= onDate;
    const periodClassification = !withinPeriod ? 'outside_period' :
      gift.giftedOn >= threeYearStartDate ? 'within_three_years' : 'extended_period';
    return {
      index,
      giftedOn: gift.giftedOn,
      recipientHeirId: gift.recipientHeirId,
      amount,
      giftTaxPaid,
      isInAddbackPeriod: withinPeriod,
      periodClassification,
      extraDeductionApplied: zeroMoney(),
      addbackAmount: withinPeriod ? amount : zeroMoney(),
    };
  });
  if (reasons.length > 0) return { status: 'blocked', blockedReasons: reasons };

  const hasExtendedGifts = details.some(gift => gift.periodClassification === 'extended_period');
  let deductionLimit = zeroMoney();
  if (hasExtendedGifts) {
    const deductionRecord = masterRecord('inheritance_gift_addback_extra_deduction', onDate);
    if (!deductionRecord) {
      return {
        status: 'blocked',
        blockedReasons: [{
          code: 'IHT_MASTER_UNAVAILABLE',
          message: '生前贈与加算の延長期間控除に必要な承認済みマスターが利用できません',
        }],
      };
    }
    deductionLimit = masterMoney(deductionRecord.threshold_amount);
  }

  // マスターの「延長部分の合計に対して総額100万円」は、相法19条1項の
  // 「その者の相続税の課税価格に加算」の枠内を指すため、受贈者ごとに1枠を適用する。
  // 贈与ごとの明細化では入力順に枠を充当するが、受贈者別の最終加算額は順序に依存しない。
  const remainingDeductionByRecipient = new Map();
  for (const detail of details) {
    if (detail.periodClassification !== 'extended_period') continue;
    const remaining = remainingDeductionByRecipient.has(detail.recipientHeirId)
      ? remainingDeductionByRecipient.get(detail.recipientHeirId) : deductionLimit;
    const applied = minMoney(detail.amount, remaining);
    detail.extraDeductionApplied = applied;
    detail.addbackAmount = subtractMoney(detail.amount, applied);
    remainingDeductionByRecipient.set(detail.recipientHeirId, subtractMoney(remaining, applied));
  }

  const perRecipient = [];
  for (const person of people) {
    if (!actualHeirIds.has(person.id)) continue;
    const recipientGifts = details.filter(gift => gift.recipientHeirId === person.id);
    const addbackAmount = sumMoney(recipientGifts.map(gift => gift.addbackAmount));
    const extraDeductionApplied = sumMoney(recipientGifts.map(gift => gift.extraDeductionApplied));
    const giftTaxPaid = sumMoney(recipientGifts.filter(gift => gift.isInAddbackPeriod)
      .map(gift => gift.giftTaxPaid));
    const personAmounts = amountsFor(person);
    const acquiredBeforeAddback = sumMoney([
      personAmounts.ordinaryAssets,
      personAmounts.lifeInsurance,
      personAmounts.retirementAllowance,
    ]);
    if (addbackAmount.value > 0n &&
        ((person.divisionShare && person.divisionShare.num === 0n) ||
          acquiredBeforeAddback.value === 0n)) {
      addWarning(warnings, 'IHT_GIFT_ADDBACK_ZERO_SHARE',
        '分割割合0%または取得財産0円の相続人への贈与を、安全側として課税価格に加算しました', person.id);
    }
    perRecipient.push({
      recipientHeirId: person.id,
      addbackAmount,
      extraDeductionApplied,
      giftTaxPaid,
      giftTaxCreditApplied: zeroMoney(),
    });
  }
  return {
    status: 'complete',
    periodRuleId: periodRecord.record_id,
    periodStartDate,
    threeYearStartDate,
    totalAddback: sumMoney(perRecipient.map(row => row.addbackAmount)),
    totalExtraDeduction: sumMoney(perRecipient.map(row => row.extraDeductionApplied)),
    gifts: details,
    perRecipient,
  };
}

function spouseReliefExact(totalTax, totalTaxablePrice, spouseTaxablePrice, spouseShare, threshold) {
  const legalShareAmount = multiplyRateByMoney(spouseShare, totalTaxablePrice);
  const thresholdExact = moneyToExact(threshold);
  const maximumKind = compareExact(legalShareAmount, thresholdExact) >= 0 ? 'legal_share' : 'threshold';
  const maximum = maximumKind === 'legal_share' ? legalShareAmount : thresholdExact;

  if (compareExact(moneyToExact(spouseTaxablePrice), maximum) <= 0) {
    return multiplyRateByMoney(
      rate({ num: spouseTaxablePrice.value, den: totalTaxablePrice.value }),
      totalTax
    );
  }
  if (maximumKind === 'legal_share') return multiplyRateByMoney(spouseShare, totalTax);
  return multiplyRateByMoney(
    rate({ num: threshold.value, den: totalTaxablePrice.value }),
    totalTax
  );
}

function blockedResult(reasons, warnings, heirCountForTax) {
  return {
    status: 'blocked',
    blockedReasons: reasons,
    warnings,
    heirCountForTax: heirCountForTax === undefined ? null : heirCountForTax,
  };
}

function calculate(input, { onDate } = {}) {
  const warnings = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return blockedResult([{ code: 'IHT_INPUT_REQUIRED', message: '相続税計算の入力が必要です' }], warnings);
  }
  if (typeof onDate !== 'string') {
    return blockedResult([{ code: 'IHT_ON_DATE_REQUIRED', message: '適用マスターを選ぶ相続開始日が必要です' }], warnings);
  }

  const people = normalizePeople(input);
  if (people.length === 0) {
    return blockedResult([{ code: 'IHT_HEIRS_REQUIRED', message: '取得者・相続人の入力が必要です' }], warnings);
  }
  const amountRows = people.map(person => ({ person, amounts: amountsFor(person) }));
  const unsupported = unsupportedInputReasons(input, people, amountRows);
  if (unsupported.length > 0) return blockedResult(unsupported, warnings);

  const heirCountResult = calculateHeirCount(people, { onDate });
  if (heirCountResult.status === 'blocked') {
    return blockedResult(heirCountResult.blockedReasons, warnings);
  }
  const heirCountForTax = heirCountResult.heirCountForTax;

  const basicDeductionRecord = masterRecord('inheritance_basic_deduction', onDate);
  const insuranceRecord = masterRecord('life_insurance_exemption', onDate);
  const retirementRecord = masterRecord('retirement_allowance_exemption', onDate);
  const surchargeRecord = masterRecord('inheritance_two_tenths_surcharge', onDate);
  const spouseThresholdRecord = masterRecord('spouse_tax_relief_threshold', onDate);
  const minorCreditRecord = masterRecord('inheritance_minor_credit', onDate);
  const disabilityCreditRecords = masters.find('inheritance_disability_credit', { onDate });
  if (!basicDeductionRecord || !insuranceRecord || !retirementRecord || !surchargeRecord ||
      !spouseThresholdRecord || !minorCreditRecord || disabilityCreditRecords.length === 0) {
    return blockedResult(
      [{ code: 'IHT_MASTER_UNAVAILABLE', message: '相続税計算に必要な承認済みマスターが利用できません' }],
      warnings,
      heirCountForTax
    );
  }

  if (people.some(person => person.relation === 'adopted_child' || person.relation === 'special_adopted_child')) {
    addWarning(warnings, 'IHT_ADOPTION_ANTI_ABUSE_NOT_ASSESSED', '養子による租税負担の不当減少の否認可能性は判定していません');
    // 相法18条2項: 被相続人の直系卑属が養子となった者（いわゆる孫養子）は、
    // 代襲相続人である場合を除き一親等の血族から外れ、2割加算の対象になる。
    // 入力に孫養子かどうかの判定材料が無いため、第1版は「孫養子でない」ものとして
    // 加算なしで計算し、その前提を表示する（§10 の「前提を結果へ表示する」の流儀）。
    addWarning(warnings, 'IHT_ADOPTED_SURCHARGE_ASSUMPTION',
      '養子は孫養子（被相続人の直系卑属が養子となった者）でないものとして2割加算なしで計算しています。' +
      '代襲相続人でない孫養子は加算の対象です（相法18条2項）');
  }

  const actualLegal = determineStatutoryHeirs(people, { ignoreRenunciation: false });
  const actualHeirIds = new Set([
    ...actualLegal.spouses.map(person => person.id),
    ...actualLegal.bloodRelatives.map(person => person.id),
  ]);
  const giftAddback = calculateGiftAddback(input, people, actualHeirIds, onDate, warnings);
  if (giftAddback.status === 'blocked') {
    return blockedResult(giftAddback.blockedReasons, warnings, heirCountForTax);
  }
  const giftAddbackById = new Map(giftAddback.perRecipient.map(item =>
    [item.recipientHeirId, item.addbackAmount]));
  const giftTaxPaidById = new Map(giftAddback.perRecipient.map(item =>
    [item.recipientHeirId, item.giftTaxPaid]));
  const insuranceLimit = limitFromPerHeir(insuranceRecord, heirCountForTax);
  const retirementLimit = limitFromPerHeir(retirementRecord, heirCountForTax);
  const insuranceExemption = allocateNonTaxableAmount(
    amountRows.map(row => ({
      id: row.person.id,
      amount: row.amounts.lifeInsurance,
      eligible: actualHeirIds.has(row.person.id) && !isRenounced(row.person),
    })),
    insuranceLimit
  );
  const retirementExemption = allocateNonTaxableAmount(
    amountRows.map(row => ({
      id: row.person.id,
      amount: row.amounts.retirementAllowance,
      eligible: actualHeirIds.has(row.person.id) && !isRenounced(row.person),
    })),
    retirementLimit
  );
  const insuranceById = new Map(insuranceExemption.allocations.map(item => [item.id, item.amount]));
  const retirementById = new Map(retirementExemption.allocations.map(item => [item.id, item.amount]));

  // §28-1 段階1、2、4、6、7。段階6の生前贈与は控除後の正味額へ加え、
  // その後に段階7の各人1,000円未満切捨てを行う。
  const perPersonBase = amountRows.map(row => {
    const grossAcquisition = sumMoney([
      row.amounts.ordinaryAssets,
      row.amounts.lifeInsurance,
      row.amounts.retirementAllowance,
    ]);
    const afterExemptions = subtractExact(
      subtractExact(moneyToExact(grossAcquisition), insuranceById.get(row.person.id)),
      retirementById.get(row.person.id)
    );
    const deductions = sumMoney([row.amounts.debts, row.amounts.funeralExpenses]);
    const beforeBaseRounding = addExact(
      floorExactAtZero(subtractExact(afterExemptions, moneyToExact(deductions))),
      moneyToExact(giftAddbackById.get(row.person.id) || zeroMoney())
    );
    const taxablePrice = applyRounding(beforeBaseRounding, BASE_ROUNDING_RULE_ID);
    return {
      person: row.person,
      amounts: row.amounts,
      grossAcquisition,
      lifeInsuranceExemption: insuranceById.get(row.person.id),
      retirementAllowanceExemption: retirementById.get(row.person.id),
      giftAddback: giftAddbackById.get(row.person.id) || zeroMoney(),
      taxablePrice,
    };
  });

  // §28-1 段階8〜10。
  const totalTaxablePrice = sumMoney(perPersonBase.map(row => row.taxablePrice));
  const basicDeduction = calculateBasicDeduction(basicDeductionRecord, heirCountForTax);
  const taxableEstate = compareExact(moneyToExact(totalTaxablePrice), moneyToExact(basicDeduction)) <= 0
    ? zeroMoney()
    : subtractMoney(totalTaxablePrice, basicDeduction);

  if (compareExact(moneyToExact(taxableEstate), zeroExact()) === 0) {
    return {
      status: 'complete',
      blockedReasons: [],
      warnings,
      heirCountForTax,
      basicDeduction,
      totalTaxablePrice,
      taxableEstate,
      totalTax: zeroMoney(),
      giftAddback,
      allocationInvariant: { allocatedTaxTotal: zeroExact(), totalTax: zeroExact(), holds: true },
      perHeir: perPersonBase.map(row => ({
        id: row.person.id,
        taxablePrice: row.taxablePrice,
        grossAcquisition: row.grossAcquisition,
        lifeInsuranceExemption: row.lifeInsuranceExemption,
        retirementAllowanceExemption: row.retirementAllowanceExemption,
        allocatedTax: zeroExact(),
        surcharge: zeroExact(),
        credits: { giftTax: zeroExact(), spouseRelief: zeroExact(), minor: zeroExact(), disability: zeroExact() },
        payable: zeroMoney(),
      })),
    };
  }

  // §28-1 段階11〜13。
  const totalResult = calculateTaxTotalFromTaxableEstate(taxableEstate, people, { onDate });
  if (totalResult.status === 'blocked') {
    return blockedResult(totalResult.blockedReasons, warnings, heirCountForTax);
  }
  const totalTax = totalResult.totalTax;

  // §28-1 段階14〜15。割合を丸めず、Exact の合計を実行時に検証する。
  const allocatedRows = perPersonBase.map(row => ({
    ...row,
    allocatedTax: multiplyRateByMoney(
      rate({ num: row.taxablePrice.value, den: totalTaxablePrice.value }),
      totalTax
    ),
  }));
  const allocatedTaxTotal = sumExact(allocatedRows.map(row => row.allocatedTax));
  if (compareExact(allocatedTaxTotal, moneyToExact(totalTax)) !== 0) {
    throw new Error('各人の算出税額のExact合計が相続税の総額と一致しません');
  }

  // §28-1 段階16。総額×加算率をMoney化してから同じ取得比で配るのは
  // 各人のExact算出税額×加算率と代数的に同値である。
  const totalSurchargeBase = applyRounding(
    multiplyRateByMoney(masterRate(surchargeRecord.rate), totalTax),
    NO_ROUNDING_RULE_ID
  );
  for (const row of allocatedRows) {
    const exemptRelation = row.person.relation === 'spouse' ||
      row.person.relation === 'child' ||
      row.person.relation === 'adopted_child' ||
      row.person.relation === 'special_adopted_child' ||
      row.person.relation === 'parent';
    row.surcharge = exemptRelation
      ? zeroExact()
      : multiplyRateByMoney(
        rate({ num: row.taxablePrice.value, den: totalTaxablePrice.value }),
        totalSurchargeBase
      );
  }

  // §28-1 段階17。贈与税額控除→配偶者軽減→未成年者控除→障害者控除の順。
  const spouse = actualLegal.spouses[0];
  let spouseRelief = zeroExact();
  if (spouse && input.applySpouseRelief !== false) {
    const isDivided = input.isDivided !== undefined
      ? input.isDivided
      : input.division && input.division.isDivided;
    if (isDivided === 'yes') {
      const spouseShareRow = totalResult.statutoryShares.find(row => row.id === spouse.id);
      const spouseTaxableRow = allocatedRows.find(row => row.person.id === spouse.id);
      spouseRelief = spouseReliefExact(
        totalTax,
        totalTaxablePrice,
        spouseTaxableRow.taxablePrice,
        spouseShareRow.share,
        masterMoney(spouseThresholdRecord.threshold_amount)
      );
    } else {
      addWarning(
        warnings,
        'IHT_SPOUSE_RELIEF_NOT_APPLIED_UNDIVIDED',
        '未分割のため配偶者の税額軽減を適用していません',
        spouse.id
      );
    }
  }

  const perHeir = allocatedRows.map(row => {
    const credits = {
      giftTax: zeroExact(), spouseRelief: zeroExact(), minor: zeroExact(), disability: zeroExact(),
    };
    let currentTax = addExact(row.allocatedTax, row.surcharge);
    const giftTaxEntitlement = giftTaxPaidById.get(row.person.id) || zeroMoney();
    if (giftTaxEntitlement.value > 0n) {
      const giftTaxApplied = compareExact(currentTax, moneyToExact(giftTaxEntitlement)) >= 0
        ? moneyToExact(giftTaxEntitlement) : floorExactAtZero(currentTax);
      credits.giftTax = giftTaxApplied;
      currentTax = floorExactAtZero(subtractExact(currentTax, giftTaxApplied));
    }
    if (spouse && row.person.id === spouse.id) {
      const appliedSpouseRelief = compareExact(currentTax, spouseRelief) >= 0
        ? spouseRelief : floorExactAtZero(currentTax);
      credits.spouseRelief = appliedSpouseRelief;
      currentTax = floorExactAtZero(subtractExact(currentTax, appliedSpouseRelief));
    }

    if (actualHeirIds.has(row.person.id) && Number.isInteger(row.person.ageAtInheritance) &&
        row.person.ageAtInheritance < minorCreditRecord.age_threshold && row.person.isMinor !== false) {
      const entitlement = creditEntitlement(minorCreditRecord, row.person.ageAtInheritance);
      const applied = applyCredit(
        currentTax,
        entitlement,
        warnings,
        'IHT_MINOR_CREDIT_OVERFLOW_NOT_TRANSFERRED',
        '未成年者控除の控除不足額を扶養義務者へ移す処理は第1版では未実装です',
        row.person.id
      );
      currentTax = applied.remaining;
      credits.minor = applied.applied;
    }

    const disability = row.person.disability;
    if (actualHeirIds.has(row.person.id) && disability && disability !== 'none' &&
        Number.isInteger(row.person.ageAtInheritance)) {
      const category = disability === 'special_cohabiting' ? 'special' : disability;
      const record = disabilityCreditRecords.find(item => item.disability_category === category);
      if (!record) throw new Error(`障害者控除マスターに区分がありません: ${category}`);
      const entitlement = creditEntitlement(record, row.person.ageAtInheritance);
      const applied = applyCredit(
        currentTax,
        entitlement,
        warnings,
        'IHT_DISABILITY_CREDIT_OVERFLOW_NOT_TRANSFERRED',
        '障害者控除の控除不足額を扶養義務者へ移す処理は第1版では未実装です',
        row.person.id
      );
      currentTax = applied.remaining;
      credits.disability = applied.applied;
    }

    // §28-1 段階18。
    const payable = applyRounding(floorExactAtZero(currentTax), FINAL_ROUNDING_RULE_ID);
    return {
      id: row.person.id,
      taxablePrice: row.taxablePrice,
      grossAcquisition: row.grossAcquisition,
      lifeInsuranceExemption: row.lifeInsuranceExemption,
      retirementAllowanceExemption: row.retirementAllowanceExemption,
      allocatedTax: row.allocatedTax,
      surcharge: row.surcharge,
      credits,
      payable,
    };
  });

  return {
    status: 'complete',
    blockedReasons: [],
    warnings,
    heirCountForTax,
    basicDeduction,
    totalTaxablePrice,
    taxableEstate,
    totalTax,
    statutoryShares: totalResult.statutoryShares,
    allocationInvariant: {
      allocatedTaxTotal,
      totalTax: moneyToExact(totalTax),
      holds: true,
    },
    perHeir,
    giftAddback: {
      ...giftAddback,
      perRecipient: giftAddback.perRecipient.map(recipient => {
        const row = perHeir.find(item => item.id === recipient.recipientHeirId);
        return {
          ...recipient,
          giftTaxCreditApplied: row
            ? applyRounding(row.credits.giftTax, NO_ROUNDING_RULE_ID) : zeroMoney(),
        };
      }),
    },
  };
}

module.exports = {
  calculate,
  calculateHeirCount,
  allocateNonTaxableAmount,
  calculateTaxTotalFromTaxableEstate,
  calendarYearsBefore,
};
