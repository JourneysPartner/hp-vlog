'use strict';

const { formatYen } = require('../hojinnari/result-view-model.js');
const { incomeDeductionRows } = require('../income-deduction-view.js');

const WARNING_ORDER = Object.freeze({ critical: 0, attention: 1, info: 2 });
const CRITERION_PRESENTATION = Object.freeze({
  min_burden: Object.freeze({
    code: 'A',
    label: '税金＋社会保険負担が最小',
    outcome: '税金＋社会保険負担が最小',
  }),
  max_total_retained: Object.freeze({
    code: 'B',
    label: '法人＋個人の手残り最大',
    outcome: '法人＋個人の年間手残りが最大',
    assumption: '法人留保と個人可処分所得を同価値とみなす仮定です。',
  }),
  max_corporate_with_floor: Object.freeze({
    code: 'C',
    label: '個人手取りを確保しつつ会社に最も多く残す',
    outcome: '個人手取りの制約を満たしつつ会社に残る額が最大',
  }),
});
const OPTIMIZATION_DISCLAIMER =
  '税・社会保険上の数値比較であり、会社の資金繰りや生活費、将来の年金額等まで含めた「最適」を意味するものではありません。';
const ROW_SELECTION_DESCRIPTION =
  '既定表示は、最良点とその前後1刻み、探索の上下限、法人＋個人手残り・個人手取り・会社留保の符号が変わる点、手残り順位の転換点（隣接候補との増減方向が変わる点）です。';

function moneyValue(value) {
  if (!value || value.unit !== 'JPY' || typeof value.value !== 'bigint') {
    throw new TypeError('MoneyはJPYのbigintで指定してください');
  }
  return value.value;
}

function money(value) {
  return Object.freeze({ unit: 'JPY', value });
}

function sumMoney(values) {
  return money(values.reduce((total, value) => total + moneyValue(value), 0n));
}

function amountCell(value) {
  if (value === undefined) return Object.freeze({ kind: 'omitted', display: '―' });
  return Object.freeze({ kind: 'amount', amount: value, exactYen: moneyValue(value), display: formatYen(value) });
}

function sortedWarnings(warnings) {
  return Object.freeze([...(warnings || [])].sort((left, right) =>
    (WARNING_ORDER[left.level] ?? 99) - (WARNING_ORDER[right.level] ?? 99)));
}

function grounds(result) {
  const context = result.calculationContext || {};
  return Object.freeze({
    calculationVersion: result.calculationVersion,
    inputSchemaVersion: result.inputSchemaVersion,
    masterSnapshotId: context.masterSnapshotId,
    masterSnapshotHash: context.masterSnapshotHash,
    legalStatusAsOf: context.asOfDate,
    sources: Object.freeze([...(result.sources || [])]),
  });
}

function common(result, mode) {
  return {
    mode,
    resultStatus: result.resultStatus,
    periodLabel: result.periodLabel,
    heading: `${result.resultStatus === 'blocked' ? '試算停止' : '試算結果'}（${result.periodLabel}・${result.resultStatus}）`,
    warnings: sortedWarnings(result.warnings),
    assumptions: Object.freeze([...(result.assumptions || [])]),
    excludedItems: Object.freeze([...(result.excludedItems || [])]),
    grounds: grounds(result),
  };
}

function selectedCandidate(result, allowProvisional = false) {
  const data = result.breakdown && result.breakdown.data;
  if (!data || !Array.isArray(data.candidates)) return null;
  const planId = data.selectedPlanId || (allowProvisional ? data.provisionalPlanId : undefined);
  if (!planId) return null;
  return data.candidates.find(candidate => candidate.planId === planId) || null;
}

function modeCViewModel(result) {
  const candidate = selectedCandidate(result);
  if (!candidate) throw new TypeError('MODE Cの選択候補がありません');
  return Object.freeze({
    ...common(result, 'C'),
    keyResult: Object.freeze({
      label: '法人＋個人の手残り（年間）',
      qualifier: 'この試算では',
      amount: candidate.combinedCash,
      exactYen: moneyValue(candidate.combinedCash),
      display: formatYen(candidate.combinedCash),
    }),
    monthlyCompensation: candidate.monthlyCompensation,
    personalRows: Object.freeze([
      ['gross', '額面（年額）', candidate.annualCompensation, false],
      ['social_insurance', '社会保険', candidate.socialInsuranceEmployee, true],
      ['income_tax', '所得税', candidate.incomeTax, true],
      ['resident_tax', '住民税', candidate.residentTax, true],
      ['personal_net_cash', '個人手取り', candidate.personalNetCash, false],
    ].map(([code, label, value, deduction]) => Object.freeze({
      code, label, deduction, ...amountCell(value),
      display: `${deduction ? '▲' : ''}${formatYen(value)}`,
    }))),
    corporateRows: Object.freeze([
      ['annual_compensation', '役員報酬', candidate.annualCompensation, false],
      ['employer_social_insurance', '会社負担社会保険', candidate.socialInsuranceEmployer, true],
      ['corporate_income', '法人所得', candidate.corporateIncome, false],
      ['corporate_taxes', '法人税等', candidate.corporateTaxes, true],
      ['corporate_retained_cash', '税引後利益', candidate.corporateRetainedCash, false],
    ].map(([code, label, value, deduction]) => Object.freeze({
      code, label, deduction, ...amountCell(value),
      display: `${deduction ? '▲' : ''}${formatYen(value)}`,
    }))),
    combinedCash: candidate.combinedCash,
    incomeDeductionRows: incomeDeductionRows(candidate.orderedIncomeDeductions)
      .map(row => Object.freeze({ ...row, ...amountCell(row.amount) })),
    handoffAvailable: result.resultStatus !== 'blocked',
  });
}

function candidateRow(candidate) {
  const taxBurden = sumMoney([candidate.incomeTax, candidate.residentTax, candidate.corporateTaxes]);
  const socialInsuranceBurden = sumMoney([
    candidate.socialInsuranceEmployee,
    candidate.socialInsuranceEmployer,
  ]);
  return Object.freeze({
    planId: candidate.planId,
    monthlyCompensation: amountCell(candidate.monthlyCompensation),
    combinedCash: amountCell(candidate.combinedCash),
    personalNetCash: amountCell(candidate.personalNetCash),
    corporateRetainedCash: amountCell(candidate.corporateRetainedCash),
    taxBurden: amountCell(taxBurden),
    socialInsuranceBurden: amountCell(socialInsuranceBurden),
  });
}

function addSignBoundaries(indexes, candidates, field) {
  for (let index = 1; index < candidates.length; index++) {
    const previous = moneyValue(candidates[index - 1][field]);
    const current = moneyValue(candidates[index][field]);
    if ((previous < 0n && current >= 0n) || (previous >= 0n && current < 0n)) {
      indexes.add(index - 1);
      indexes.add(index);
    }
  }
}

function addDirectionBoundaries(indexes, candidates) {
  for (let index = 1; index < candidates.length - 1; index++) {
    const previous = moneyValue(candidates[index - 1].combinedCash);
    const current = moneyValue(candidates[index].combinedCash);
    const next = moneyValue(candidates[index + 1].combinedCash);
    const leftDirection = current === previous ? 0 : current > previous ? 1 : -1;
    const rightDirection = next === current ? 0 : next > current ? 1 : -1;
    if (leftDirection !== rightDirection) indexes.add(index);
  }
}

function selectDefaultCandidates(candidates, selectedPlanId) {
  if (!Array.isArray(candidates) || candidates.length === 0) return Object.freeze([]);
  const indexes = new Set([0, candidates.length - 1]);
  const selectedIndex = candidates.findIndex(candidate => candidate.planId === selectedPlanId);
  if (selectedIndex >= 0) {
    indexes.add(selectedIndex);
    if (selectedIndex > 0) indexes.add(selectedIndex - 1);
    if (selectedIndex + 1 < candidates.length) indexes.add(selectedIndex + 1);
  }
  for (const field of ['combinedCash', 'personalNetCash', 'corporateRetainedCash']) {
    addSignBoundaries(indexes, candidates, field);
  }
  addDirectionBoundaries(indexes, candidates);
  return Object.freeze([...indexes].sort((left, right) => left - right)
    .map(index => candidates[index]));
}

function criterionFromInput(criterion) {
  const presentation = CRITERION_PRESENTATION[criterion];
  if (!presentation) throw new TypeError('MODE Aの最適化基準が不明です');
  return presentation;
}

function modeAViewModel(result, options) {
  const data = result.breakdown.data;
  const criterion = criterionFromInput(options.optimizationCriterion);
  const nearUpperBound = data.nearUpperBound === true;
  const selected = selectedCandidate(result, true);
  const selectedPlanId = data.selectedPlanId || data.provisionalPlanId;
  const conclusion = nearUpperBound
    ? Object.freeze({
      amount: undefined,
      text: '探索上限の付近に最良点があります。上限を広げると結果が変わる可能性があるため、最適とは断定できません。',
      isProvisional: true,
    })
    : Object.freeze({
      amount: selected.monthlyCompensation,
      text: `今回の条件では、月額役員報酬 ${formatYen(selected.monthlyCompensation)}前後で${criterion.outcome}となる試算です。`,
      isProvisional: false,
    });
  const keyResult = nearUpperBound
    ? Object.freeze({
      label: '最適な役員報酬（月額）',
      qualifier: 'この試算では',
      amount: undefined,
      display: conclusion.text,
      isProvisional: true,
    })
    : Object.freeze({
      label: '最適な役員報酬（月額）',
      qualifier: 'この試算では',
      amount: selected.monthlyCompensation,
      exactYen: moneyValue(selected.monthlyCompensation),
      display: `${formatYen(selected.monthlyCompensation)}前後`,
      isProvisional: false,
    });
  const defaults = selectDefaultCandidates(data.candidates, selectedPlanId);
  return Object.freeze({
    ...common(result, 'A'),
    criterion,
    keyResult,
    criterionNotice: criterion.assumption,
    conclusion,
    optimizationDisclaimer: OPTIMIZATION_DISCLAIMER,
    nearUpperBound,
    rowSelectionDescription: ROW_SELECTION_DESCRIPTION,
    defaultCandidateRows: Object.freeze(defaults.map(candidateRow)),
    allCandidateRows: Object.freeze(data.candidates.map(candidateRow)),
    incomeDeductionRows: incomeDeductionRows(selected.orderedIncomeDeductions)
      .map(row => Object.freeze({ ...row, ...amountCell(row.amount) })),
    handoffAvailable: !nearUpperBound && Boolean(data.selectedPlanId),
  });
}

function modeBViewModel(result) {
  const base = common(result, 'B');
  if (result.summary.range) {
    const display = `${formatYen(result.summary.range.low)}〜${formatYen(result.summary.range.high)}`;
    return Object.freeze({
      ...base,
      keyResult: Object.freeze({
        label: '必要な役員報酬（月額）',
        qualifier: 'この試算では',
        range: Object.freeze({ low: result.summary.range.low, high: result.summary.range.high }),
        display,
      }),
      isRange: true,
      range: Object.freeze({
        low: result.summary.range.low,
        high: result.summary.range.high,
        display,
      }),
      conclusion: '希望手取りを満たす単一の報酬額は探索範囲内にないため、探索範囲として表示します。',
      forwardVerificationNotice: '各候補は順算関数で検証しています。',
      handoffAvailable: false,
      incomeDeductionRows: Object.freeze([]),
    });
  }
  const candidate = selectedCandidate(result);
  if (!candidate) throw new TypeError('MODE Bの選択候補がありません');
  return Object.freeze({
    ...base,
    keyResult: Object.freeze({
      label: '必要な役員報酬（月額）',
      qualifier: 'この試算では',
      amount: result.summary.amount,
      exactYen: moneyValue(result.summary.amount),
      display: `約${formatYen(result.summary.amount)}`,
    }),
    isRange: false,
    requiredMonthlyCompensation: result.summary.amount,
    employerSocialInsuranceAnnual: candidate.socialInsuranceEmployer,
    companyAnnualTotalCost: sumMoney([
      candidate.annualCompensation,
      candidate.socialInsuranceEmployer,
    ]),
    incomeDeductionRows: incomeDeductionRows(candidate.orderedIncomeDeductions)
      .map(row => Object.freeze({ ...row, ...amountCell(row.amount) })),
    forwardVerificationNotice: result.breakdown.data.inverseVerifiedByForwardCalculation
      ? '必要報酬は順算で再検証済みです。'
      : '各候補は順算関数で検証しています。',
    handoffAvailable: true,
  });
}

function blockedViewModel(result, mode) {
  const noCandidate = (result.warnings || []).some(warning =>
    warning.code === 'YH_NO_CANDIDATE_MEETS_CONSTRAINTS');
  return Object.freeze({
    ...common(result, mode),
    alerts: Object.freeze((result.warnings || []).map(warning => Object.freeze({
      code: warning.code,
      fieldPath: warning.fieldPath,
      message: warning.message,
    }))),
    constraintNotice: noCandidate
      ? '入力した制約を満たす候補がありません。最低個人手取りまたは最低法人留保の制約を緩和して再計算してください。'
      : undefined,
    handoffAvailable: false,
  });
}

function buildYakuinHoshuResultViewModel(result, options = {}) {
  if (!result || result.simulatorType !== 'yakuin_hoshu') {
    throw new TypeError('yakuin_hoshuのSimulationResultを指定してください');
  }
  const mode = options.mode;
  if (!['A', 'B', 'C'].includes(mode)) throw new TypeError('表示対象のmodeが必要です');
  if (result.resultStatus === 'blocked') return blockedViewModel(result, mode);
  if (!result.breakdown || result.breakdown.kind !== 'yakuin_hoshu') {
    throw new TypeError('結果表示に必要な役員報酬内訳がありません');
  }
  if (mode === 'A') return modeAViewModel(result, options);
  if (mode === 'B') return modeBViewModel(result);
  return modeCViewModel(result);
}

module.exports = Object.freeze({
  CRITERION_PRESENTATION,
  OPTIMIZATION_DISCLAIMER,
  ROW_SELECTION_DESCRIPTION,
  amountCell,
  sumMoney,
  selectDefaultCandidates,
  buildYakuinHoshuResultViewModel,
});
