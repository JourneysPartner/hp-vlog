'use strict';

const { parseMoneyInput } = require('../forms.js');
const { SozokuHeirsBuildError, buildHeirs } = require('./heirs-builder.js');

class SozokuInputBuildError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('\n'));
    this.name = 'SozokuInputBuildError';
    this.errors = Object.freeze(errors.map(item => Object.freeze({ ...item })));
    this.code = this.errors[0] && this.errors[0].code;
  }
}

function issue(code, fieldPath, message) {
  return { code, fieldPath, message };
}

function money(value, fieldPath, errors, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  const parsed = parseMoneyInput(String(value ?? ''));
  if (!parsed.ok) {
    errors.push(issue('SOZOKU_UI_MONEY_REQUIRED', fieldPath,
      '金額を0円以上の整数で入力してください'));
    return { unit: 'JPY', value: '0' };
  }
  return { unit: 'JPY', value: parsed.value };
}

function optionalAssetMoney(value, fieldPath, errors) {
  return money(value === undefined || value === null || value === '' ? '0' : value,
    fieldPath, errors);
}

function normalizeAreaText(value) {
  return String(value ?? '').replace(/[０-９]/g,
    digit => String('０１２３４５６７８９'.indexOf(digit)))
    .replace('．', '.').trim();
}

function area(value, fieldPath, errors) {
  const text = normalizeAreaText(value);
  if (!/^(?:\d+|\d+\.\d)$/.test(text)) {
    errors.push(issue('SOZOKU_UI_AREA_INVALID', fieldPath,
      '面積は0より大きい整数または小数第1位までで入力してください'));
    return { unit: 'SQM', num: '0', den: '1' };
  }
  const [whole, decimal] = text.split('.');
  const num = decimal === undefined ? BigInt(whole) : BigInt(whole) * 10n + BigInt(decimal);
  if (num <= 0n) {
    errors.push(issue('SOZOKU_UI_AREA_INVALID', fieldPath,
      '面積は0より大きい値で入力してください'));
  }
  return { unit: 'SQM', num: num.toString(10), den: decimal === undefined ? '1' : '10' };
}

function triState(value, fieldPath, errors, label, defaultValue) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!['yes', 'no', 'unknown'].includes(value)) {
    errors.push(issue('SOZOKU_UI_SELECTION_REQUIRED', fieldPath, `${label}を選択してください`));
    return 'unknown';
  }
  return value;
}

function realEstateRows(formState, level, errors) {
  return (formState.realEstate || formState.realEstates || []).map((row, index) => {
    const path = `$.assets.realEstate[${index}]`;
    const category = row.category || row.type;
    if (!['land', 'building'].includes(category)) {
      errors.push(issue('SOZOKU_UI_REAL_ESTATE_CATEGORY_REQUIRED', `${path}.category`,
        '不動産の種類を土地または建物から選択してください'));
    }
    const known = row.appraisalKnown ?? row.appraised ??
      (row.kind === 'appraised' ? 'yes' : row.kind && row.kind.startsWith('screening_') ? 'no' : undefined);
    if (!['yes', 'no', true, false].includes(known)) {
      errors.push(issue('SOZOKU_UI_APPRAISAL_SELECTION_REQUIRED', `${path}.kind`,
        '相続税評価額が分かるか選択してください'));
    }
    const directlyAppraised = known === 'yes' || known === true;
    if (level >= 2 && !directlyAppraised) {
      errors.push(issue('SOZOKU_LEVEL2_DIRECT_APPRAISAL_REQUIRED', path,
        'LEVEL 2では不動産の相続税評価額を直接入力してください'));
    }
    if (directlyAppraised) {
      return {
        kind: 'appraised',
        category: ['land', 'building'].includes(category) ? category : 'land',
        value: money(row.appraisedValue ?? row.value, `${path}.value.value`, errors),
      };
    }
    if (category === 'building') {
      return {
        kind: 'screening_building',
        fixedAssetTaxValue: money(row.fixedAssetTaxValue ?? row.value,
          `${path}.fixedAssetTaxValue.value`, errors),
      };
    }
    return {
      kind: 'screening_land',
      roadsideValuePerSqm: money(row.roadsideValuePerSqm ?? row.roadsideValue,
        `${path}.roadsideValuePerSqm.value`, errors),
      areaSqm: area(row.areaSqm ?? row.area, `${path}.areaSqm`, errors),
      isMultiplierArea: triState(row.isMultiplierArea, `${path}.isMultiplierArea`, errors,
        '倍率地域への該当', 'no'),
      hasLeaseholdOrRented: triState(row.hasLeaseholdOrRented,
        `${path}.hasLeaseholdOrRented`, errors, '借地・貸家・貸地への該当', 'no'),
    };
  });
}

function beneficiaryRows(rows, inputPath, heirs, errors) {
  const ids = new Set(heirs.map(item => item.id));
  return (rows || []).map((row, index) => {
    const path = `${inputPath}[${index}]`;
    const selected = row.beneficiaryHeirId ?? row.beneficiary ?? row.recipient;
    const isHeir = row.isHeir !== undefined ? Boolean(row.isHeir) :
      selected !== 'non_heir' && selected !== 'other' && selected !== 'non-heir';
    const result = { isHeir, amount: money(row.amount, `${path}.amount.value`, errors) };
    if (isHeir) {
      if (!ids.has(selected)) errors.push(issue('SOZOKU_BENEFICIARY_HEIR_REQUIRED',
        `${path}.beneficiaryHeirId`, '受取人となる相続人を選択してください'));
      else result.beneficiaryHeirId = selected;
    }
    return result;
  });
}

function debtRows(rows, heirs, errors) {
  const ids = new Set(heirs.map(item => item.id));
  return (rows || []).map((row, index) => {
    const path = `$.debts[${index}]`;
    const kind = ['loan', 'unpaid', 'funeral', 'other'].includes(row.kind) ? row.kind : 'other';
    const bearerHeirId = row.bearerHeirId ?? row.bearer;
    if (!ids.has(bearerHeirId)) errors.push(issue('SOZOKU_DEBT_BEARER_REQUIRED',
      `${path}.bearerHeirId`, '債務・葬式費用を実際に負担する相続人を選択してください'));
    return {
      kind,
      amount: money(row.amount, `${path}.amount.value`, errors),
      ...(ids.has(bearerHeirId) ? { bearerHeirId } : {}),
    };
  });
}

function validLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function giftAddbackRows(rows, heirs, errors) {
  const ids = new Set(heirs.map(item => item.id));
  return (rows || []).map((row, index) => {
    const path = `$.assets.giftAddback[${index}]`;
    const giftedOn = String(row.giftedOn || row.date || '');
    const recipientHeirId = row.recipientHeirId || row.recipient;
    if (!validLocalDate(giftedOn)) {
      errors.push(issue('SOZOKU_UI_GIFT_DATE_REQUIRED', `${path}.giftedOn`,
        '贈与日を入力してください'));
    }
    if (!ids.has(recipientHeirId)) {
      errors.push(issue('SOZOKU_UI_GIFT_RECIPIENT_REQUIRED', `${path}.recipientHeirId`,
        '受贈者となる相続人を選択してください'));
    }
    const result = {
      giftedOn,
      recipientHeirId: ids.has(recipientHeirId) ? recipientHeirId : '',
      amount: money(row.amount, `${path}.amount.value`, errors),
    };
    const giftTaxPaid = money(row.giftTaxPaid, `${path}.giftTaxPaid.value`, errors, true);
    if (giftTaxPaid) result.giftTaxPaid = giftTaxPaid;
    return result;
  });
}

function division(formState, heirs, errors) {
  const mode = formState.divisionMode || formState.divisionKind || 'statutory';
  if (mode === 'statutory' || mode === 'legal' || mode === 'default') {
    const isUndivided = ['no', 'unknown'].includes(formState.isDivided ?? formState.divisionStatus);
    const isLate = ['yes', 'unknown'].includes(formState.dividedAfterFilingDeadline);
    if (isUndivided || isLate) {
      errors.push(issue('SOZOKU_UI_DIVISION_PERCENT_REQUIRED_FOR_UNDIVIDED', '$.division',
        '未分割または申告期限後の分割見込みで軽減なしの税額を計算するには、現在の取得見込み割合を指定してください'));
    }
    return undefined;
  }
  if (mode !== 'specified') {
    errors.push(issue('SOZOKU_UI_DIVISION_MODE_REQUIRED', '$.division',
      '分割方法を選択してください'));
    return undefined;
  }
  const source = formState.divisionShares || formState.acquisitions || {};
  const values = Array.isArray(source) ? source : heirs.map(item => ({
    heirId: item.id,
    percent: source[item.id],
  }));
  let total = 0n;
  const acquisitions = values.map((row, index) => {
    const heirId = row.heirId;
    const text = String(row.percent ?? row.sharePercent ?? row.value ?? '');
    if (!/^\d+$/.test(text)) {
      errors.push(issue('SOZOKU_UI_DIVISION_PERCENT_INVALID',
        `$.division.acquisitions[${index}].share`, '取得割合は0〜100の整数で入力してください'));
    } else total += BigInt(text);
    return { heirId, share: { num: /^\d+$/.test(text) ? text : '0', den: '100' } };
  });
  if (total !== 100n) errors.push(issue('SOZOKU_DIVISION_SHARE_TOTAL_INVALID',
    '$.division.acquisitions', `取得割合の合計を100%にしてください（現在 ${total}%）`));
  return {
    isDivided: triState(formState.isDivided ?? formState.divisionStatus,
      '$.division.isDivided', errors, '未分割かどうか', 'yes'),
    acquisitions,
    ...(formState.dividedAfterFilingDeadline !== undefined ? {
      dividedAfterFilingDeadline: triState(formState.dividedAfterFilingDeadline,
        '$.division.dividedAfterFilingDeadline', errors, '申告期限後の分割見込み'),
    } : {}),
  };
}

function smallLand(formState, realEstate, heirs, errors) {
  const state = formState.smallResidentialLand;
  if (!state || state.enabled === false || state.apply === 'no' || state.use === 'no') {
    return { entries: undefined, possible: false };
  }
  const requested = state.enabled === true || state.apply === 'yes' || state.use === 'yes' ||
    state.realEstateIndex !== undefined;
  if (!requested) return { entries: undefined, possible: false };
  const index = Number(state.realEstateIndex ?? state.landIndex);
  const estate = Number.isInteger(index) ? realEstate[index] : undefined;
  const acquirerHeirId = state.acquirerHeirId ?? state.acquirer;
  const acquirer = heirs.find(item => item.id === acquirerHeirId);
  const relation = state.acquirerRelation || (acquirer && acquirer.relation === 'spouse'
    ? 'spouse' : state.isCohabitingRelative === 'yes' ? 'cohabiting_relative' : 'other');
  const spouseHolds = relation === 'spouse' && acquirer && acquirer.relation === 'spouse';
  const cohabitingHolds = relation === 'cohabiting_relative' &&
    state.acquirerResidesAndOwns === 'yes' && state.willHoldUntilFilingDeadline === 'yes';
  const eligible = estate && estate.kind === 'appraised' && estate.category === 'land' &&
    acquirer && (spouseHolds || cohabitingHolds);
  if (!eligible) return { entries: undefined, possible: true };
  const entry = {
    realEstateIndex: index,
    category: 'specified_residential',
    areaSqm: area(state.areaSqm ?? state.area, '$.smallResidentialLand[0].areaSqm', errors),
    acquirerHeirId,
    acquirerRelation: relation,
  };
  if (state.intendedAppliedAreaSqm !== undefined && state.intendedAppliedAreaSqm !== '') {
    entry.intendedAppliedAreaSqm = area(state.intendedAppliedAreaSqm,
      '$.smallResidentialLand[0].intendedAppliedAreaSqm', errors);
  }
  if (relation === 'cohabiting_relative') {
    entry.acquirerResidesAndOwns = state.acquirerResidesAndOwns;
    entry.willHoldUntilFilingDeadline = state.willHoldUntilFilingDeadline;
  }
  return { entries: [entry], possible: false };
}

function yesOrUnknown(value) {
  return value === true || value === 'yes' || value === 'unknown' || value === 'ある' || value === '不明';
}

function secondaryInheritance(formState, heirs, errors) {
  const enteredCount = String(formState.secondaryHeirCount ?? '').trim();
  const countText = enteredCount === ''
    ? String(heirs.filter(heir => heir.relation !== 'spouse').length)
    : enteredCount;
  if (!/^\d+$/.test(countText) || BigInt(countText) === 0n || BigInt(countText) > 100n) {
    errors.push(issue('SOZOKU_SECONDARY_HEIRS_REQUIRED',
      '$.secondaryInheritance.expectedHeirs', '二次相続の想定相続人を1人以上で入力してください'));
  }
  const count = /^\d+$/.test(countText) && BigInt(countText) > 0n && BigInt(countText) <= 100n
    ? Number(countText) : 0;
  const relationCategory = formState.secondaryHeirRelation || 'child';
  if (!['child', 'other'].includes(relationCategory)) {
    errors.push(issue('SOZOKU_SECONDARY_RELATION_REQUIRED',
      '$.secondaryInheritance.expectedHeirs', '二次相続の想定相続人の続柄を選択してください'));
  }
  const yearsText = String(formState.yearsUntilSecondary ?? '').trim();
  let years;
  if (yearsText !== '') {
    if (!/^\d+$/.test(yearsText) || Number(yearsText) > 100) {
      errors.push(issue('SOZOKU_SECONDARY_YEARS_INVALID',
        '$.secondaryInheritance.yearsUntilSecondary', '二次相続までの想定年数を0以上の整数で入力してください'));
    } else years = Number(yearsText);
  }
  const rateText = String(formState.annualAssetChangeRate ?? '0');
  if (!/^-?[0-5]$/.test(rateText)) {
    errors.push(issue('SOZOKU_SECONDARY_RATE_INVALID',
      '$.secondaryInheritance.annualAssetChangeRate', '年間の財産増減率を▲5%〜+5%から選択してください'));
  }
  const result = {
    spouseOwnAssets: money(formState.spouseOwnAssets,
      '$.secondaryInheritance.spouseOwnAssets.value', errors),
    spouseAcquisitionRatios: Array.from({ length: 11 }, (_, index) => ({
      num: String(index * 10), den: '100',
    })),
    expectedHeirs: Array.from({ length: count }, (_, index) => ({
      id: `secondary-heir-${index + 1}`,
      relation: relationCategory === 'child' ? 'child' : 'sibling_full',
      isAlive: true,
      residencyStatus: 'domestic_resident',
    })),
  };
  if (years !== undefined) {
    result.yearsUntilSecondary = years;
    result.annualLivingCost = optionalAssetMoney(formState.annualLivingCost,
      '$.secondaryInheritance.annualLivingCost.value', errors);
    result.annualAssetChangeRate = {
      num: /^-?[0-5]$/.test(rateText) ? rateText : '0', den: '100',
    };
  }
  return result;
}

function buildSozokuInputWithMeta(formState) {
  if (!formState || typeof formState !== 'object') {
    throw new TypeError('フォーム状態はオブジェクトで指定してください');
  }
  const errors = [];
  let heirs;
  try {
    heirs = Array.isArray(formState.heirs) ? formState.heirs.map(item => ({ ...item })) : buildHeirs(formState);
  } catch (error) {
    if (error instanceof SozokuHeirsBuildError) errors.push(...error.errors);
    else throw error;
    heirs = [];
  }
  const level = Number(formState.level || 1);
  if (![1, 2, 3].includes(level)) errors.push(issue('SOZOKU_UI_LEVEL_INVALID', '$.level',
    '計算レベルは1〜3で指定してください'));
  const giftStatus = formState.hasGiftAddback ?? formState.giftAddbackStatus;
  const settlementStatus = formState.hasSettlementTaxationGifts ?? formState.settlementTaxationStatus;
  if (giftStatus === 'unknown') {
    errors.push(issue('SOZOKU_UI_GIFT_STATUS_REQUIRED', '$.assets.giftAddback',
      '生前贈与の有無を確認してから入力してください'));
  }
  if (yesOrUnknown(settlementStatus)) {
    errors.push(issue('SOZOKU_UI_SETTLEMENT_GIFT_SPECIALIST_REVIEW_REQUIRED',
      '$.assets.settlementTaxationGifts',
      '相続時精算課税を選んだ贈与はこの簡易試算の対象外です。専門家へご相談ください'));
  }

  const realEstate = realEstateRows(formState, level, errors);
  const assets = {
    cash: optionalAssetMoney(formState.cash, '$.assets.cash.value', errors),
    securities: optionalAssetMoney(formState.securities, '$.assets.securities.value', errors),
    businessAssets: optionalAssetMoney(formState.businessAssets, '$.assets.businessAssets.value', errors),
    otherAssets: optionalAssetMoney(formState.otherAssets, '$.assets.otherAssets.value', errors),
  };
  if (realEstate.length > 0) assets.realEstate = realEstate;
  const lifeInsurance = beneficiaryRows(formState.lifeInsurance,
    '$.assets.lifeInsurance', heirs, errors);
  const retirementAllowance = beneficiaryRows(formState.retirementAllowance,
    '$.assets.retirementAllowance', heirs, errors);
  if (lifeInsurance.length > 0) assets.lifeInsurance = lifeInsurance;
  if (retirementAllowance.length > 0) assets.retirementAllowance = retirementAllowance;
  if (giftStatus === true || giftStatus === 'yes' || giftStatus === 'ある') {
    const gifts = giftAddbackRows(formState.giftAddback, heirs, errors);
    if (gifts.length === 0) {
      errors.push(issue('SOZOKU_UI_GIFT_ROW_REQUIRED', '$.assets.giftAddback',
        '生前贈与の明細を1件以上追加してください'));
    } else {
      assets.giftAddback = gifts;
    }
  }
  const selectedDivision = division(formState, heirs, errors);
  const selectedSmallLand = smallLand(formState, realEstate, heirs, errors);

  const wire = {
    level: [1, 2, 3].includes(level) ? level : 1,
    precision: level === 1 ? 'simple' : 'detailed',
    decedent: { residencyStatus: 'domestic_resident' },
    heirs,
    assets,
    debts: debtRows(formState.debts, heirs, errors),
    specialistChecks: {},
    ...(selectedDivision ? { division: selectedDivision } : {}),
    ...(selectedSmallLand.entries ? { smallResidentialLand: selectedSmallLand.entries } : {}),
    ...(level === 3 ? { secondaryInheritance: secondaryInheritance(formState, heirs, errors) } : {}),
  };
  if (errors.length > 0) throw new SozokuInputBuildError(errors);
  return Object.freeze({
    wire: Object.freeze(wire),
    smallResidentialLandPossibility: selectedSmallLand.possible,
  });
}

function buildSozokuInput(formState) {
  return buildSozokuInputWithMeta(formState).wire;
}

function buildSozokuCalculationContext(snapshotInfo, calculatedAt = new Date().toISOString()) {
  if (!snapshotInfo || typeof snapshotInfo !== 'object') {
    throw new TypeError('マスタースナップショット情報が必要です');
  }
  return Object.freeze({
    asOfDate: String(calculatedAt).slice(0, 10),
    calculatedAt,
    inheritanceOpenDate: '2026-08-29',
    jurisdiction: Object.freeze({ country: 'JP' }),
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
  });
}

module.exports = Object.freeze({
  SozokuInputBuildError,
  buildSozokuInput,
  buildSozokuInputWithMeta,
  buildSozokuInputResult: buildSozokuInputWithMeta,
  buildSozokuCalculationContext,
  areaToWire: area,
});
