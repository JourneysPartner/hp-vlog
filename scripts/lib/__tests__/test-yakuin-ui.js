'use strict';

/** ④役員報酬シミュレーターUI（U3）のDOM非依存受け入れテスト。 */

const assert = require('assert');
const vm = require('vm');
const { webcrypto } = require('crypto');
const service = require('../../../src/simulators/yakuin-hoshu/index.js');
const snapshot = require('../../../src/tax-engine/masters/snapshot.js');
const builder = require('../../build-simulator-bundle.js');
const { buildCalculationContext } = require('../../../src/ui/hojinnari/context-builder.js');
const {
  buildYakuinHoshuInput,
} = require('../../../src/ui/yakuin-hoshu/input-builder.js');
const {
  buildYakuinHoshuResultViewModel,
} = require('../../../src/ui/yakuin-hoshu/result-view-model.js');
const {
  HANDOFF_PATHS,
  createYakuinHoshuHandoff,
  acceptYakuinHoshuHandoff,
} = require('../../../src/ui/yakuin-hoshu/handoff.js');
const { mountYakuinHoshuApp } = require('../../../src/ui/yakuin-hoshu/app.js');
const { withFakeDocument } = require('./helpers/fake-dom.js');

const snapshotInfo = snapshot.getSnapshotInfo();
const calculatedAt = '2026-08-29T12:00:00+09:00';
let passed = 0;

function check(label, action) {
  action();
  process.stdout.write(`  ✓ ${label}\n`);
  passed++;
}

function baseState(overrides = {}) {
  return {
    incomeTaxYear: 2025,
    municipalityKey: 'shibuya',
    mode: 'C',
    profitBeforeOfficerCompensation: '12000000',
    capital: '3000000',
    ageAtYearEnd: '39',
    monthlyCompensation: '500000',
    searchLowerBound: '400000',
    searchUpperBound: '600000',
    searchStep: '10000',
    optimizationCriterion: 'max_total_retained',
    desiredMonthlyNetIncome: '387775',
    minPersonalNetIncome: '300000',
    minCorporateRetained: '1000000',
    ...overrides,
  };
}

function run(formState) {
  const context = buildCalculationContext(formState, snapshotInfo, calculatedAt);
  const wire = buildYakuinHoshuInput(formState, context);
  const validation = service.validate(wire);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors || []));
  const startedAt = process.hrtime.bigint();
  const result = service.simulate(validation.value, context, snapshotInfo);
  const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const viewModel = buildYakuinHoshuResultViewModel(result, {
    mode: formState.mode,
    optimizationCriterion: formState.optimizationCriterion,
  });
  return { context, wire, validation, result, viewModel, elapsedMilliseconds };
}

function rowAmount(rows, code) {
  return rows.find(row => row.code === code).exactYen;
}

function main() {
  process.stdout.write('\n=== 初期画面・ページ遷移 ===\n');
  check('マウント直後はモード選択で、遷移時に先頭スクロール後フォーカスしintroを圧縮・復元する', () => {
    withFakeDocument(({ root, intro }) => {
      const calls = [];
      const app = mountYakuinHoshuApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
        introElement: intro,
        scrollToAppTop() { calls.push('scroll'); },
        focusHeading() { calls.push('focus'); },
      });
      assert.strictEqual(app.store.getState().screen, 'mode');
      assert(root.textContent.includes('入力と計算はこのブラウザ内で完結し、金額を保存・解析送信しません。'));
      assert(!root.textContent.includes('ご利用の前に'));
      assert(!intro.classList.contains('simulator-intro--compact'));
      app.store.setState(state => ({ ...state, screen: 'input', step: 1 }));
      assert.deepStrictEqual(calls, ['scroll', 'focus']);
      assert(intro.classList.contains('simulator-intro--compact'));
      app.store.setState(state => ({ ...state, screen: 'mode' }));
      assert.deepStrictEqual(calls, ['scroll', 'focus', 'scroll', 'focus']);
      assert(!intro.classList.contains('simulator-intro--compact'));
      app.destroy();
    });
  });

  process.stdout.write('\n=== MODE C: ゴールデン統合 ===\n');
  const modeC = run(baseState());
  check('組立→validate→simulate→表示が④ゴールデン値と一致する', () => {
    assert.strictEqual(modeC.result.resultStatus, 'complete');
    assert.strictEqual(rowAmount(modeC.viewModel.personalRows, 'personal_net_cash'), 4653300n);
    assert.strictEqual(rowAmount(modeC.viewModel.personalRows, 'social_insurance'), 846300n);
    assert.strictEqual(rowAmount(modeC.viewModel.personalRows, 'income_tax'), 189700n);
    assert.strictEqual(rowAmount(modeC.viewModel.personalRows, 'resident_tax'), 310700n);
    assert.strictEqual(rowAmount(modeC.viewModel.corporateRows, 'corporate_retained_cash'), 3885600n);
    assert.strictEqual(modeC.viewModel.combinedCash.value, 8538900n);
  });
  check('12か月同額・協会けんぽ・従業員0等の固定契約をWireへ載せる', () => {
    assert.strictEqual(modeC.wire.officerResidenceSameAsCompany, 'yes');
    assert.strictEqual(modeC.wire.employeeCount, 0);
    assert.strictEqual(modeC.wire.healthInsurer.kind, 'kyokai_kenpo');
    assert.deepStrictEqual(modeC.wire.specialistChecks, {});
    assert.strictEqual(modeC.wire.plan.monthlySegments.length, 1);
    assert.deepStrictEqual(modeC.wire.plan.monthlySegments[0].period, modeC.context.fiscalPeriod);
  });

  process.stdout.write('\n=== MODE A: 探索・候補表 ===\n');
  const modeA = run(baseState({ mode: 'A' }));
  check('40万〜60万円・1万円刻みは21候補でMODE C単発と最良値が一致する', () => {
    assert.strictEqual(modeA.viewModel.allCandidateRows.length, 21);
    const selected = modeA.result.breakdown.data.candidates.find(candidate =>
      candidate.planId === modeA.result.breakdown.data.selectedPlanId);
    const single = run(baseState({ monthlyCompensation: selected.monthlyCompensation.value.toString() }));
    assert.strictEqual(selected.combinedCash.value, single.viewModel.combinedCash.value);
  });
  check('基準Bの同価値仮定を結論付近へ明示する', () => {
    assert(modeA.viewModel.criterionNotice.includes('同価値'));
    assert(modeA.viewModel.conclusion.text.includes('法人＋個人の年間手残りが最大'));
    assert(modeA.viewModel.optimizationDisclaimer.includes('「最適」を意味するものではありません'));
  });
  check('既定行は最良点・上下限を含み全件より少なく、選定規則を説明する', () => {
    const rows = modeA.viewModel.defaultCandidateRows;
    const ids = rows.map(row => row.planId);
    assert(ids.includes(modeA.result.breakdown.data.selectedPlanId));
    assert(ids.includes('monthly-400000'));
    assert(ids.includes('monthly-600000'));
    assert(rows.length < modeA.viewModel.allCandidateRows.length);
    assert(modeA.viewModel.rowSelectionDescription.includes('探索の上下限'));
  });
  check('MODE A/Bの実サービス走査はプレビュー要件の数秒以内で完了する', () => {
    assert(modeA.elapsedMilliseconds < 3000, `${modeA.elapsedMilliseconds}ms`);
  });

  process.stdout.write('\n=== MODE A: 上限付近・基準C ===\n');
  const upper = run(baseState({ mode: 'A', searchUpperBound: '420000' }));
  check('上限付近は金額を断定せず可能性の文言を表示する', () => {
    assert.strictEqual(upper.viewModel.nearUpperBound, true);
    assert.strictEqual(upper.viewModel.conclusion.amount, undefined);
    assert(upper.viewModel.conclusion.text.includes('上限を広げると結果が変わる可能性'));
    assert(!upper.viewModel.handoffAvailable);
  });
  check('基準Cの最低個人手取りは月額入力を年額変換せずWireへ載せる', () => {
    const state = baseState({ mode: 'A', optimizationCriterion: 'max_corporate_with_floor' });
    const context = buildCalculationContext(state, snapshotInfo, calculatedAt);
    const wire = buildYakuinHoshuInput(state, context);
    assert.strictEqual(wire.constraints.minPersonalNetIncome.value, state.minPersonalNetIncome);
    assert.strictEqual(wire.constraints.minCorporateRetained.value, state.minCorporateRetained);
    assert.strictEqual(service.validate(wire).ok, true);
  });
  check('基準Cで制約を満たす候補が無いと制約緩和の案内を返す', () => {
    const blocked = run(baseState({
      mode: 'A', optimizationCriterion: 'max_corporate_with_floor',
      minPersonalNetIncome: '99999999',
    }));
    assert.strictEqual(blocked.result.resultStatus, 'blocked');
    assert(blocked.viewModel.constraintNotice.includes('制約を緩和'));
  });

  process.stdout.write('\n=== MODE B: 手取り逆算 ===\n');
  const modeB = run(baseState({ mode: 'B' }));
  check('希望月額387,775円は必要報酬50万円・会社年間総コスト6,867,900円になる', () => {
    assert.strictEqual(modeB.viewModel.requiredMonthlyCompensation.value, 500000n);
    assert.strictEqual(modeB.viewModel.employerSocialInsuranceAnnual.value, 867900n);
    assert.strictEqual(modeB.viewModel.companyAnnualTotalCost.value, 6000000n + 867900n);
    assert(modeB.viewModel.forwardVerificationNotice.includes('順算で再検証済み'));
    assert(modeB.elapsedMilliseconds < 3000, `${modeB.elapsedMilliseconds}ms`);
  });
  check('希望手取りが探索外なら単一額を断定せず範囲を返す', () => {
    const range = run(baseState({ mode: 'B', desiredMonthlyNetIncome: '9999999' }));
    assert.strictEqual(range.result.resultStatus, 'partial');
    assert.strictEqual(range.viewModel.isRange, true);
    assert(range.viewModel.conclusion.includes('探索範囲として表示'));
    assert.strictEqual(range.viewModel.requiredMonthlyCompensation, undefined);
  });

  process.stdout.write('\n=== ④→① Handoff ===\n');
  const handoff = createYakuinHoshuHandoff(modeC.result);
  const hojinnariForm = { officerCompensationMonthly: '' };
  check('complete結果を①が検証し役員報酬月額だけをフォームへ入れる', () => {
    const accepted = acceptYakuinHoshuHandoff(handoff, hojinnariForm, modeC.context);
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(accepted.formState.officerCompensationMonthly, '500000');
    assert.strictEqual(accepted.message, '④の結果から引き継ぎました');
  });
  check('スナップショットハッシュ不一致は理由付きで拒否し月額を入れない', () => {
    const changed = {
      ...handoff,
      calculationContext: { ...handoff.calculationContext, masterSnapshotHash: '0'.repeat(64) },
    };
    const rejected = acceptYakuinHoshuHandoff(changed, hojinnariForm, modeC.context);
    assert.strictEqual(rejected.accepted, false);
    assert.strictEqual(rejected.reason, 'master_snapshot_hash_mismatch');
    assert.strictEqual(rejected.formState.officerCompensationMonthly, '');
  });
  check('スナップショットIDまたは事業年度の不一致も理由付きで拒否する', () => {
    const changedId = {
      ...handoff,
      calculationContext: { ...handoff.calculationContext, masterSnapshotId: 'different' },
    };
    const idRejected = acceptYakuinHoshuHandoff(changedId, hojinnariForm, modeC.context);
    assert.strictEqual(idRejected.accepted, false);
    assert.strictEqual(idRejected.reason, 'master_snapshot_id_mismatch');
    const changedPeriod = {
      ...modeC.context,
      fiscalPeriod: { from: '2025-04-01', to: '2026-03-31' },
    };
    const periodRejected = acceptYakuinHoshuHandoff(handoff, hojinnariForm, changedPeriod);
    assert.strictEqual(periodRejected.accepted, false);
    assert.strictEqual(periodRejected.reason, 'fiscal_period_mismatch');
  });
  check('blocked結果からHandoffを作成できない', () => {
    assert.throws(() => createYakuinHoshuHandoff({
      simulatorType: 'yakuin_hoshu', resultStatus: 'blocked',
    }), /blocked結果/);
  });
  check('HandoffFieldに税額・手取りフィールドが存在しない', () => {
    assert.strictEqual(handoff.fields.some(item =>
      /(incomeTax|residentTax|corporateTax|personalNet|combinedCash|手取り|税額)/i.test(item.path)), false);
    assert.deepStrictEqual(Object.keys(HANDOFF_PATHS).sort(), [
      'appointedOn', 'bonusPlan', 'fiscalPeriodFrom', 'fiscalPeriodTo',
      'healthInsurerKind', 'healthInsurerPrefectureCode', 'monthlyCompensation',
      'planKind', 'revision', 'standardRemunerationDecisionKind',
    ]);
  });

  process.stdout.write('\n=== 生成バンドルの公開API ===\n');
  check('vm評価でTaxSimulator.mountYakuinHoshuが関数として公開される', () => {
    const built = builder.build();
    const context = { window: {}, crypto: webcrypto, TextEncoder, Uint8Array, ArrayBuffer };
    vm.runInNewContext(built.bundle, context, { filename: 'tax-simulator.bundle.js' });
    assert.strictEqual(typeof context.window.TaxSimulator.mountYakuinHoshu, 'function');
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
