'use strict';

/** ③相続税シミュレーターUI（U5）のDOM非依存受け入れテスト。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const service = require('../../../src/simulators/sozoku/index.js');
const snapshot = require('../../../src/tax-engine/masters/snapshot.js');
const builder = require('../../build-simulator-bundle.js');
const { SozokuHeirsBuildError, buildHeirs } = require('../../../src/ui/sozoku/heirs-builder.js');
const {
  SozokuInputBuildError,
  buildSozokuInput,
  buildSozokuInputWithMeta,
  buildSozokuCalculationContext,
} = require('../../../src/ui/sozoku/input-builder.js');
const {
  QUESTION_CATALOG,
  resolveQuestion,
} = require('../../../src/ui/sozoku/question-catalog.js');
const {
  FILING_NEED_TEXT,
  buildSozokuResultViewModel,
} = require('../../../src/ui/sozoku/result-view-model.js');
const { mountSozokuApp } = require('../../../src/ui/sozoku/app.js');
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
    level: 2,
    hasSpouse: 'yes',
    childCount: '2',
    adoptedChildCount: '0',
    parentCount: '0',
    siblingCount: '0',
    deceasedDescendant: 'no',
    renunciation: 'no',
    specialOrStepchildAdoption: 'no',
    overseasResident: 'no',
    cash: '60000000',
    securities: '20000000',
    businessAssets: '0',
    otherAssets: '0',
    realEstate: [
      { category: 'building', appraisalKnown: 'yes', appraisedValue: '10000000' },
      { category: 'land', appraisalKnown: 'yes', appraisedValue: '50000000' },
    ],
    lifeInsurance: [],
    retirementAllowance: [],
    debts: [],
    hasGiftAddback: 'no',
    hasSettlementTaxationGifts: 'no',
    divisionMode: 'specified',
    divisionStatus: 'yes',
    dividedAfterFilingDeadline: 'no',
    divisionShares: { spouse: '50', 'child-1': '25', 'child-2': '25' },
    smallResidentialLand: {
      apply: 'yes', realEstateIndex: 1, areaSqm: '200',
      acquirerHeirId: 'spouse', acquirerRelation: 'spouse',
    },
    ...overrides,
  };
}

function run(formState) {
  const built = buildSozokuInputWithMeta(formState);
  const context = buildSozokuCalculationContext(snapshotInfo, calculatedAt);
  const validation = service.validate(built.wire);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors || []));
  const result = service.simulate(validation.value, context, snapshotInfo);
  const viewModel = buildSozokuResultViewModel(result, {
    smallResidentialLandPossibility: built.smallResidentialLandPossibility,
    smallResidentialLandArea: formState.smallResidentialLand && `${formState.smallResidentialLand.areaSqm}㎡`,
  });
  return { built, context, validation, result, viewModel };
}

function sourceReasonCodes() {
  const roots = [
    path.join(__dirname, '..', '..', '..', 'src', 'simulators', 'sozoku'),
    path.join(__dirname, '..', '..', '..', 'src', 'tax-engine', 'inheritance'),
  ];
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
  }
  roots.forEach(visit);
  const codes = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:IHT|SOZOKU)_[A-Z0-9_]+/g)) {
      codes.add(match[0]);
    }
  }
  return [...codes].sort();
}

function main() {
  process.stdout.write('\n=== 初期画面・ページ遷移 ===\n');
  check('マウント直後はSTEP 1で、遷移時に先頭スクロール後フォーカスしintroを圧縮・復元する', () => {
    withFakeDocument(({ root, intro }) => {
      const calls = [];
      const app = mountSozokuApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
        introElement: intro,
        scrollToAppTop() { calls.push('scroll'); },
        focusHeading() { calls.push('focus'); },
      });
      assert.deepStrictEqual({ screen: app.store.getState().screen, step: app.store.getState().step },
        { screen: 'input', step: 1 });
      assert(root.textContent.includes('入力と計算はこのブラウザ内で完結し、金額を保存・解析送信しません。'));
      assert(!root.textContent.includes('ご利用の前に'));
      assert(!intro.classList.contains('simulator-intro--compact'));
      app.store.setState(state => ({ ...state, step: 2 }));
      assert.deepStrictEqual(calls, ['scroll', 'focus']);
      assert(intro.classList.contains('simulator-intro--compact'));
      app.store.setState(state => ({ ...state, step: 1 }));
      assert.deepStrictEqual(calls, ['scroll', 'focus', 'scroll', 'focus']);
      assert(!intro.classList.contains('simulator-intro--compact'));
      app.destroy();
    });
  });

  process.stdout.write('\n=== GC-SO-LEVEL2-FULL 統合・結果表示 ===\n');
  const full = run(baseState());
  check('組立→validate→simulate→表示がゴールデン値になる', () => {
    assert.strictEqual(full.result.resultStatus, 'complete');
    assert.strictEqual(full.viewModel.totalInheritanceTax.exactYen, 6300000n);
    assert.strictEqual(full.viewModel.spouseRelief.reduction.exactYen, 3150000n);
    assert.strictEqual(full.viewModel.totalPayableTax.exactYen, 3150000n);
    assert.strictEqual(full.viewModel.allocations.find(row => row.heirId === 'spouse').finalTax.exactYen, 0n);
    assert.strictEqual(full.viewModel.smallResidentialLand.reduction.exactYen, 40000000n);
  });
  check('required_for_special_ruleの結論は税額0円でも申告不要にならないと明記する', () => {
    assert.strictEqual(full.viewModel.filingNeed, 'required_for_special_rule');
    assert(full.viewModel.conclusion.text.includes('税額0円でも申告不要にはなりません'));
    assert(FILING_NEED_TEXT.required_for_special_rule.includes('申告不要にはなりません'));
  });
  check('各人の表はUI表示名とサービス4金額を持つ', () => {
    assert.deepStrictEqual(full.viewModel.allocations.map(row => row.label), ['配偶者', 'お子さま1', 'お子さま2']);
    assert.deepStrictEqual(full.viewModel.allocations[0].acquiredAmount.exactYen, 50000000n);
    assert.deepStrictEqual(full.viewModel.allocations[0].taxBeforeCredits.exactYen, 3150000n);
    assert.deepStrictEqual(full.viewModel.allocations[0].credits.exactYen, 3150000n);
  });

  process.stdout.write('\n=== LEVEL 1・申告要否の核心 ===\n');
  check('路線価20万円×150㎡＋現預金2,000万円はpossibly_requiredと概算警告', () => {
    const level1 = run(baseState({
      level: 1, cash: '20000000', securities: '0', businessAssets: '0', otherAssets: '0',
      realEstate: [{ category: 'land', appraisalKnown: 'no', roadsideValuePerSqm: '200000', areaSqm: '150',
        isMultiplierArea: 'no', hasLeaseholdOrRented: 'no' }],
      divisionMode: 'statutory', smallResidentialLand: null,
    }));
    assert.strictEqual(level1.viewModel.filingNeed, 'possibly_required');
    assert.strictEqual(level1.viewModel.taxablePriceTotal.exactYen, 50000000n);
    assert.strictEqual(level1.viewModel.screeningEstimateUsed, true);
    assert(level1.viewModel.screeningWarning.includes('実際の相続税評価額'));
  });
  check('現預金4,000万円のみはnot_required', () => {
    const level1 = run(baseState({ level: 1, cash: '40000000', securities: '0', businessAssets: '0', otherAssets: '0',
      realEstate: [], divisionMode: 'statutory', smallResidentialLand: null }));
    assert.strictEqual(level1.viewModel.filingNeed, 'not_required');
  });
  check('特例前6,000万円から特例後2,000万円になってもLEVEL 1/2ともrequired', () => {
    const common = {
      cash: '10000000', securities: '0', businessAssets: '0', otherAssets: '0',
      realEstate: [{ category: 'land', appraisalKnown: 'yes', appraisedValue: '50000000' }],
      smallResidentialLand: { apply: 'yes', realEstateIndex: 0, areaSqm: '200', acquirerHeirId: 'spouse', acquirerRelation: 'spouse' },
    };
    const level1 = run(baseState({ ...common, level: 1 }));
    const level2 = run(baseState({ ...common, level: 2 }));
    assert.strictEqual(level1.viewModel.filingNeed, 'required_for_special_rule');
    assert.strictEqual(level2.viewModel.filingNeed, 'required_for_special_rule');
    assert.strictEqual(level2.viewModel.totalInheritanceTax.exactYen, 0n);
  });

  process.stdout.write('\n=== 分割・特例・対象外 ===\n');
  check('法定相続分の仮計算はdivisionを送らず前提文言が出る', () => {
    const state = baseState({ divisionMode: 'statutory' });
    const wire = buildSozokuInput(state);
    assert.strictEqual(Object.hasOwn(wire, 'division'), false);
    const provisional = run(state);
    assert(provisional.viewModel.defaultDivisionAssumption.includes('法定相続分で仮計算'));
  });
  check('未分割は配偶者軽減なしで計算し警告する', () => {
    const undivided = run(baseState({ divisionStatus: 'no' }));
    assert.strictEqual(undivided.viewModel.spouseRelief.reduction.exactYen, 0n);
    assert(undivided.viewModel.undividedWarning.includes('軽減なし'));
  });
  check('小規模宅地の取得者がその他ならWireに付けず可能性だけ注記する', () => {
    const notEligible = run(baseState({ smallResidentialLand: {
      apply: 'yes', realEstateIndex: 1, areaSqm: '200', acquirerHeirId: 'child-1', acquirerRelation: 'other',
    } }));
    assert.strictEqual(Object.hasOwn(notEligible.built.wire, 'smallResidentialLand'), false);
    assert.strictEqual(notEligible.built.smallResidentialLandPossibility, true);
    assert.strictEqual(notEligible.viewModel.smallResidentialLand.applied, false);
    assert.strictEqual(notEligible.viewModel.smallResidentialLand.possibility, true);
    assert.strictEqual(notEligible.viewModel.taxablePriceTotal.exactYen, 140000000n);
  });
  check('代襲・放棄・精算課税「ある」は組立段階で専門判定とし、サービスを呼べるWireを作らない', () => {
    let serviceCalls = 0;
    const buildThenValidate = state => {
      const wire = buildSozokuInput(state);
      serviceCalls++;
      return service.validate(wire);
    };
    for (const state of [
      baseState({ deceasedDescendant: 'yes' }),
      baseState({ renunciation: 'unknown' }),
      baseState({ hasGiftAddback: 'yes' }),
      baseState({ hasSettlementTaxationGifts: 'yes' }),
    ]) assert.throws(() => buildThenValidate(state), error =>
      error instanceof SozokuInputBuildError || error instanceof SozokuHeirsBuildError);
    assert.strictEqual(serviceCalls, 0);
  });
  check('STEP1はIDを自動採番し国内居住・存命のHeirInputを作る', () => {
    const heirs = buildHeirs(baseState());
    assert.deepStrictEqual(heirs.map(item => item.id), ['spouse', 'child-1', 'child-2']);
    assert(heirs.every(item => item.isAlive && item.residencyStatus === 'domestic_resident'));
  });
  check('面積165.5㎡はArea {num:1655, den:10}のWireになる', () => {
    const wire = buildSozokuInput(baseState({ smallResidentialLand: {
      apply: 'yes', realEstateIndex: 1, areaSqm: '165.5', acquirerHeirId: 'spouse', acquirerRelation: 'spouse',
    } }));
    assert.deepStrictEqual(wire.smallResidentialLand[0].areaSqm, { unit: 'SQM', num: '1655', den: '10' });
  });
  check('指定分割はshare {num,den:100}で、合計99%は組立エラー', () => {
    assert.deepStrictEqual(full.built.wire.division.acquisitions[0].share, { num: '50', den: '100' });
    assert.throws(() => buildSozokuInput(baseState({ divisionShares: { spouse: '50', 'child-1': '25', 'child-2': '24' } })),
      error => error instanceof SozokuInputBuildError && error.code === 'SOZOKU_DIVISION_SHARE_TOTAL_INVALID');
  });
  check('保険金・退職金は受取人別、債務は負担者付きのWireになる', () => {
    const wire = buildSozokuInput(baseState({
      lifeInsurance: [
        { beneficiaryHeirId: 'spouse', amount: '15000000' },
        { beneficiaryHeirId: 'non_heir', amount: '1000000' },
      ],
      retirementAllowance: [{ beneficiaryHeirId: 'child-1', amount: '5000000' }],
      debts: [{ kind: 'funeral', amount: '1000000', bearerHeirId: 'child-2' }],
    }));
    assert.deepStrictEqual(wire.assets.lifeInsurance.map(row => row.isHeir), [true, false]);
    assert.strictEqual(wire.assets.lifeInsurance[0].beneficiaryHeirId, 'spouse');
    assert.strictEqual(Object.hasOwn(wire.assets.lifeInsurance[1], 'beneficiaryHeirId'), false);
    assert.strictEqual(wire.assets.retirementAllowance[0].beneficiaryHeirId, 'child-1');
    assert.strictEqual(wire.debts[0].bearerHeirId, 'child-2');
    assert.strictEqual(service.validate(wire).ok, true);
  });
  check('LEVEL 2に概算不動産が残っていれば直接評価額の入力エラーにする', () => {
    assert.throws(() => buildSozokuInput(baseState({ realEstate: [{
      category: 'land', appraisalKnown: 'no', roadsideValuePerSqm: '200000', areaSqm: '150',
      isMultiplierArea: 'no', hasLeaseholdOrRented: 'no',
    }], smallResidentialLand: null })), error =>
      error instanceof SozokuInputBuildError && error.errors.some(item =>
        item.code === 'SOZOKU_LEVEL2_DIRECT_APPRAISAL_REQUIRED'));
  });

  process.stdout.write('\n=== カタログ・コンテキスト・バンドル ===\n');
  check('サービス/相続エンジンのIHT_/SOZOKU_コードを全てカタログ化し、未知は原文を残す', () => {
    for (const code of sourceReasonCodes()) {
      assert(Object.hasOwn(QUESTION_CATALOG, code), code);
    }
    const fallback = resolveQuestion({ code: 'SOZOKU_UNKNOWN_TEST', message: '原文メッセージ' });
    assert.strictEqual(fallback.isFallback, true);
    assert.strictEqual(fallback.description, '原文メッセージ');
  });
  check('コンテキストは2025年中の代表日・国内・snapshotを持つ', () => {
    assert.strictEqual(full.context.inheritanceOpenDate, '2025-06-30');
    assert.deepStrictEqual(full.context.jurisdiction, { country: 'JP' });
    assert.strictEqual(full.context.masterSnapshotId, snapshotInfo.snapshotId);
    assert.strictEqual(full.context.calculatedAt, calculatedAt);
  });
  check('vm評価でTaxSimulator.mountSozokuが関数として公開される', () => {
    const built = builder.build();
    const context = { window: {}, crypto: webcrypto, TextEncoder, Uint8Array, ArrayBuffer };
    vm.runInNewContext(built.bundle, context, { filename: 'tax-simulator.bundle.js' });
    assert.strictEqual(typeof context.window.TaxSimulator.mountSozoku, 'function');
  });

  // 検分（2026-09-02）で発見: 「該当の確認」がすべて「いいえ」の普通の養子が
  // adoptionFacts 未設定のためエンジンで blocked になっていた。UI組立が確認済みの
  // 事実（すべて該当なし）を明示して渡し、算入制限（実子あり→養子算入）が効くことを固定する。
  check('普通の養子（特別養子・連れ子・代襲なし）が計算でき、法定相続人3人になる', () => {
    const withAdopted = run(baseState({
      childCount: '1', adoptedChildCount: '1',
      divisionShares: { spouse: '50', 'child-1': '25', 'adopted-child-1': '25' },
      smallResidentialLand: undefined,
      realEstate: [], cash: '90000000', securities: '0',
    }));
    assert.strictEqual(withAdopted.result.resultStatus, 'complete');
    assert.strictEqual(
      withAdopted.result.breakdown.data.basicDeduction.value, 48000000n
    );
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
