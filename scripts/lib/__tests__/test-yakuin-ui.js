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
  YakuinHoshuInputBuildError,
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
    assert.strictEqual(Object.hasOwn(modeC.wire, 'spouse'), false);
    assert.strictEqual(Object.hasOwn(modeC.wire, 'dependents'), false);
  });
  const familyModeC = run(baseState({
    ageAtYearEnd: '45', spouseExists: 'yes', spouseTotalIncome: '0',
    spouseAge70OrOver: true,
    dependents16To18: '1', dependents19To22: '1', dependents23To69: '1',
    dependents70PlusCohabiting: '1', dependents70PlusSeparate: '1',
  }));
  check('配偶者と扶養5区分を代表年齢・親族関係・同居区分へ変換してWireへ載せる', () => {
    assert.deepStrictEqual(familyModeC.wire.spouse, {
      exists: true, totalIncome: { unit: 'JPY', value: '0' }, disability: 'none', ageAtYearEnd: 71,
    });
    const deductionRows = new Map(
      familyModeC.viewModel.incomeDeductionRows.map(row => [row.code, row.exactYen])
    );
    assert.strictEqual(deductionRows.get('spouse'), 480000n);
    assert.strictEqual(deductionRows.get('dependents'), 2450000n);
    assert.deepStrictEqual(familyModeC.wire.dependents.map(item => ({
      age: item.ageAtYearEnd, relation: item.relation, livesTogether: item.livesTogether,
    })), [
      { age: 17, relation: 'child', livesTogether: true },
      { age: 20, relation: 'child', livesTogether: true },
      { age: 40, relation: 'child', livesTogether: true },
      { age: 71, relation: 'parent', livesTogether: true },
      { age: 71, relation: 'parent', livesTogether: false },
    ]);
  });
  check('障害者区分と掛金をWireへ組み立て、一般障害者27万円・掛金27.6万円を反映する', () => {
    const deduction = run(baseState({
      ageAtYearEnd: '45', selfDisability: 'general',
      spouseExists: 'yes', spouseTotalIncome: '0', spouseDisability: 'none',
      dependents16To18: '1', dependents19To22: '1',
      smallEnterpriseMutualAid: '276000',
    }));
    assert.strictEqual(deduction.wire.officer.disability, 'general');
    assert.strictEqual(deduction.wire.deductions.smallEnterpriseMutualAid.value, '276000');
    const rows = new Map(deduction.viewModel.incomeDeductionRows
      .map(row => [row.code, row.exactYen]));
    assert.strictEqual(rows.get('disability'), 270000n);
    assert.strictEqual(rows.get('smallEnterpriseMutualAid'), 276000n);
    assert.strictEqual(deduction.viewModel.combinedCash.value, 8785400n);
  });
  check('控除第2弾をWireへ組み立て、④ゴールデン8,889,100円を画面経路で再現する', () => {
    const deduction2 = run(baseState({
      ageAtYearEnd: '45', selfDisability: 'general',
      spouseExists: 'yes', spouseTotalIncome: '0',
      dependents16To18: '1', dependents19To22: '1',
      smallEnterpriseMutualAid: '276000',
      lifeInsuranceNewLife: '120000',
      lifeInsuranceNewNursingMedical: '80000',
      earthquakeInsurancePremium: '50000',
      furusatoDonation: '20000',
      housingLoanCredit: '100000',
    }));
    assert.strictEqual(deduction2.wire.deductions.lifeInsurance.length, 5);
    assert.strictEqual(deduction2.wire.deductions.lifeInsurance[0].annualPremium.value, '120000');
    assert.strictEqual(deduction2.wire.deductions.earthquakeInsurance[0].annualPremium.value, '50000');
    assert.deepStrictEqual(deduction2.wire.deductions.donations,
      [{ kind: 'furusato', amount: { unit: 'JPY', value: '20000' } }]);
    assert.strictEqual(deduction2.wire.taxCredits.housingLoan.value, '100000');
    assert.strictEqual(deduction2.result.breakdown.data.candidates[0].combinedCash.value, 8889100n);
  });
  check('ふるさと納税52,000円の上限到達警告を表示用データへ渡す', () => {
    const overCap = run(baseState({
      ageAtYearEnd: '45', selfDisability: 'general',
      spouseExists: 'yes', spouseTotalIncome: '0',
      dependents16To18: '1', dependents19To22: '1',
      smallEnterpriseMutualAid: '276000',
      lifeInsuranceNewLife: '120000', lifeInsuranceNewNursingMedical: '80000',
      earthquakeInsurancePremium: '50000', furusatoDonation: '52000',
      housingLoanCredit: '100000',
    }));
    assert(overCap.viewModel.warnings.some(warning =>
      warning.code === 'RT_FURUSATO_SPECIAL_CREDIT_CAP_REACHED' &&
      warning.basis.includes('自己負担額が2,000円を超えます')));
  });
  check('扶養障害者は同居特別を同居扶養から先に割り当てる', () => {
    const allocated = run(baseState({
      dependents16To18: '1', dependents70PlusSeparate: '1',
      dependentDisabilityGeneral: '1', dependentDisabilitySpecialCohabiting: '1',
    }));
    assert.strictEqual(allocated.wire.dependents[0].disability, 'special_cohabiting');
    assert.strictEqual(allocated.wire.dependents[1].disability, 'general');
  });
  check('同居特別が同居扶養を超える場合と障害合計が扶養合計を超える場合は組立エラー', () => {
    const context = buildCalculationContext(baseState(), snapshotInfo, calculatedAt);
    assert.throws(() => buildYakuinHoshuInput(baseState({
      dependents70PlusSeparate: '1', dependentDisabilitySpecialCohabiting: '1',
    }), context), error => error instanceof YakuinHoshuInputBuildError && error.errors.some(item =>
      item.code === 'YH_UI_COHABITING_SPECIAL_DISABILITY_EXCEEDS_COHABITING_DEPENDENTS'));
    assert.throws(() => buildYakuinHoshuInput(baseState({
      dependents16To18: '1', dependentDisabilityGeneral: '1', dependentDisabilitySpecial: '1',
    }), context), error => error instanceof YakuinHoshuInputBuildError && error.errors.some(item =>
      item.code === 'YH_UI_DEPENDENT_DISABILITY_TOTAL_EXCEEDS_DEPENDENTS'));
  });
  // 画面経路で配偶者の合計所得が失われる誤り（0円化）は、配偶者控除38万と
  // 配特満額38万が同額のため所得0や95万の帯では見えない。金額が変わる帯
  // （所得105万円→配偶者特別控除へ切替・控除額も38万から減る）で固定する
  check('配偶者所得105万円は画面経路でも配偶者特別控除へ切り替わる', () => {
    const special = run(baseState({
      ageAtYearEnd: '45', spouseExists: 'yes', spouseTotalIncome: '1050000',
    }));
    assert.strictEqual(special.wire.spouse.totalIncome.value, '1050000');
    const rows = new Map(
      special.viewModel.incomeDeductionRows.map(row => [row.code, row.exactYen])
    );
    assert.strictEqual(rows.get('spouse'), 0n);
    assert(rows.get('spouseSpecial') > 0n && rows.get('spouseSpecial') < 380000n,
      '配偶者特別控除が38万円未満の段階額になる');
  });
  check('共通入力に家族欄・説明・対応準備中注記を表示し、結果詳細にも人的控除を表示する', () => {
    withFakeDocument(({ root }) => {
      const app = mountYakuinHoshuApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'input', step: 1,
        form: { ...state.form, mode: 'C', spouseExists: 'yes' } }));
      assert(root.textContent.includes('配偶者はいますか'));
      assert(root.textContent.includes('年収から55万円を引いた金額'));
      assert(root.textContent.includes('19〜22歳（特定扶養）'));
      assert(root.textContent.includes('16歳未満のお子さまは扶養控除の対象外'));
      assert(root.textContent.includes('本人の障害者区分'));
      assert(root.textContent.includes('うち障害のある方'));
      assert(root.textContent.includes('16歳未満の扶養親族に係る障害者控除は第1弾の対象外'));
      assert(root.textContent.includes('小規模企業共済・iDeCoの掛金（年額）'));
      assert(root.textContent.includes('新契約：一般生命保険料（年額）'));
      assert(root.textContent.includes('ふるさと納税の年間寄附額'));
      assert(root.textContent.includes('源泉徴収票の「住宅借入金等特別控除の額」または申告書の控除額'));
      assert(root.textContent.includes('医療費控除・雑損控除・ふるさと納税以外の寄附金控除は含みません'));
      assert(root.textContent.includes('ワンストップ特例は使用せず'));
      assert(!root.textContent.includes('単身'));
      app.store.setState(state => ({ ...state, screen: 'result',
        result: familyModeC.result, viewModel: familyModeC.viewModel }));
      assert(root.textContent.includes('所得控除の内訳'));
      assert(root.textContent.includes('配偶者控除'));
      assert(root.textContent.includes('扶養控除'));
      app.destroy();
    });
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
