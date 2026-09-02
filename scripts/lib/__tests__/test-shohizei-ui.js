'use strict';

/** ②消費税シミュレーターUI（U4）のDOM非依存受け入れテスト。 */

const assert = require('assert');
const vm = require('vm');
const { webcrypto } = require('crypto');
const service = require('../../../src/simulators/shohizei/index.js');
const snapshot = require('../../../src/tax-engine/masters/snapshot.js');
const builder = require('../../build-simulator-bundle.js');
const { buildCalculationContext } = require('../../../src/ui/shohizei/context-builder.js');
const { buildShohizeiInput } = require('../../../src/ui/shohizei/input-builder.js');
const {
  QUESTION_CATALOG,
  SPEC_REASON_CODES,
  resolveQuestion,
} = require('../../../src/ui/shohizei/question-catalog.js');
const { buildResultViewModel } = require('../../../src/ui/shohizei/result-view-model.js');
const { mountShohizeiApp } = require('../../../src/ui/shohizei/app.js');
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
    consumptionTaxYear: 2025,
    taxpayerType: 'individual',
    invoiceRegistered: 'yes',
    invoiceRegisteredOn: '2023-10-01',
    becameTaxableByRegistration: 'yes',
    basePeriodExists: true,
    basePeriodTaxableSales: '9000000',
    basePeriodLengthInMonths: '12',
    specifiedPeriodTaxableSales: '9000000',
    specifiedPeriodSalaryPayments: '3000000',
    simplifiedElectionStatus: 'yes',
    simplifiedElectionEffectiveYear: '2025',
    taxablePersonElectionStatus: 'no',
    taxablePersonElectionEffectiveYear: '',
    isNewlyEstablished: 'no',
    isSpecifiedNewlyEstablished: 'no',
    inheritance: 'no',
    merger: 'no',
    corporateSplit: 'no',
    highValueAssetAcquisition: 'no',
    adjustableFixedAssetAcquisition: 'no',
    taxablePeriodShortened: 'no',
    reverseCharge: 'no',
    specificTaxablePurchase: 'no',
    complexTaxableSalesRatio: 'no',
    salesStandard10: '11000000',
    salesStandard10Basis: 'inclusive',
    salesReduced8: '0',
    salesReduced8Basis: 'inclusive',
    salesExportExempt: '0',
    salesExportExemptBasis: 'inclusive',
    purchasesWithInvoiceStandard10: '4400000',
    purchasesWithInvoiceStandard10Basis: 'inclusive',
    purchasesWithInvoiceReduced8: '0',
    purchasesWithInvoiceReduced8Basis: 'inclusive',
    hasPurchasesWithoutInvoice: 'no',
    purchasesWithoutInvoiceBand: 'standard_10',
    purchasesWithoutInvoice: '0',
    purchasesWithoutInvoiceBasis: 'inclusive',
    purchasesWithoutInvoiceAnnualTotal: '0',
    purchasesWithoutInvoiceRecords: 'yes',
    simplifiedCategory: 'type5',
    ...overrides,
  };
}

function run(formState, options) {
  const context = buildCalculationContext(formState, snapshotInfo, calculatedAt);
  const wire = buildShohizeiInput(formState, options);
  const validation = service.validate(wire);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors || []));
  const result = service.simulate(validation.value, context, snapshotInfo);
  return { context, wire, result, viewModel: buildResultViewModel(result) };
}

function method(viewModel, code) {
  return viewModel.eligibilityRows.find(row => row.methodCode === code);
}

function main() {
  process.stdout.write('\n=== 初期画面・ページ遷移 ===\n');
  check('マウント直後はSTEP 1で、遷移時に先頭スクロール後フォーカスしintroを圧縮・復元する', () => {
    withFakeDocument(({ root, intro }) => {
      const calls = [];
      const app = mountShohizeiApp(root, {
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

  process.stdout.write('\n=== GC-SZ-COMPARE-R7 統合 ===\n');
  const complete = run(baseState());
  check('組立→validate→simulateで4方式を正しく判定する', () => {
    assert.strictEqual(complete.result.resultStatus, 'complete');
    assert.deepStrictEqual(complete.viewModel.eligibilityRows.map(row =>
      [row.methodName, row.symbol]), [
      ['一般課税', '○'], ['簡易課税', '○'], ['2割特例', '○'], ['3割特例', '×'],
    ]);
    assert(method(complete.viewModel, 'thirty_percent_special').reason.includes('対象課税期間ではありません'));
  });
  check('比較はeligibleかつ税額ありだけを昇順に並べる', () => {
    assert.deepStrictEqual(complete.viewModel.comparisonRows.map(row =>
      [row.methodName, row.exactYen]), [
      ['2割特例', 200000n], ['簡易課税', 500000n], ['一般課税', 600000n],
    ]);
    assert(!complete.viewModel.comparisonRows.some(row => row.methodCode === 'thirty_percent_special'));
    const contaminated = {
      ...complete.result,
      breakdown: {
        ...complete.result.breakdown,
        data: {
          ...complete.result.breakdown.data,
          methodResults: complete.result.breakdown.data.methodResults.map(row =>
            row.methodCode === 'thirty_percent_special'
              ? { ...row, taxPayable: { unit: 'JPY', value: 1n } }
              : row),
        },
      },
    };
    assert(!buildResultViewModel(contaminated).comparisonRows.some(row =>
      row.methodCode === 'thirty_percent_special'));
  });
  check('結論と一般課税との差額が指定文言・▲400,000円になる', () => {
    assert(complete.viewModel.conclusion.includes('2割特例'));
    assert.strictEqual(complete.viewModel.keyResult.label, '最も納税額が少ない方式');
    assert.strictEqual(complete.viewModel.keyResult.value, '2割特例');
    assert.strictEqual(complete.viewModel.keyResult.exactYen, 200000n);
    assert.strictEqual(complete.viewModel.keyResult.display, '200,000円');
    assert.strictEqual(complete.viewModel.differenceFromGeneral.display, '▲400,000円');
    assert(!/(絶対|必ず)/.test(complete.viewModel.conclusion));
  });
  check('結果見出し直下に推奨方式と納付額の主役ブロックを描画する', () => {
    withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'result',
        result: complete.result, viewModel: complete.viewModel }));
      const block = root.querySelector('.simulator-key-result');
      assert(block);
      assert(block.textContent.includes('最も納税額が少ない方式（この試算では）'));
      assert(block.textContent.includes('2割特例200,000円'));
      app.destroy();
    });
  });

  process.stdout.write('\n=== 免税・届出・専門判定 ===\n');
  check('免税は方式比較なし・納税義務なしの案内になる', () => {
    const exempt = run(baseState({
      invoiceRegistered: 'no', becameTaxableByRegistration: '',
      basePeriodTaxableSales: '8000000',
      specifiedPeriodTaxableSales: '8000000', specifiedPeriodSalaryPayments: '2000000',
      simplifiedElectionStatus: 'no', simplifiedElectionEffectiveYear: '',
      simplifiedCategory: '', salesStandard10: '0', purchasesWithInvoiceStandard10: '0',
    }), { emptyTransactions: true });
    assert.strictEqual(exempt.viewModel.isExempt, true);
    assert.strictEqual(exempt.viewModel.comparisonRows.length, 0);
    assert.strictEqual(exempt.viewModel.keyResult.value, '納税義務なし（免税事業者）');
    assert(exempt.viewModel.exemptNotice.includes('納税義務がない'));
    assert(exempt.viewModel.exemptNotice.includes('登録済みとして再計算'));
    withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'result',
        result: exempt.result, viewModel: exempt.viewModel }));
      assert(root.querySelector('.simulator-key-result').textContent
        .includes('納税義務なし（免税事業者）'));
      app.destroy();
    });
  });
  check('簡易課税の届出未提出で届出案内フラグが立つ', () => {
    const noFiling = run(baseState({
      simplifiedElectionStatus: 'no', simplifiedElectionEffectiveYear: '', simplifiedCategory: '',
    }));
    assert.strictEqual(method(noFiling.viewModel, 'simplified').status, 'ineligible');
    assert.strictEqual(noFiling.viewModel.simplifiedFilingGuidance, true);
  });
  check('2025年の法人は3割特例が期間または法人理由で対象外になる', () => {
    const corporation = run(baseState({ taxpayerType: 'corporation' }));
    const three = method(corporation.viewModel, 'thirty_percent_special');
    assert.strictEqual(three.status, 'ineligible');
    assert(/対象課税期間|法人/.test(three.reason));
  });
  check('課税期間短縮yesはblockedとカタログ文言になる', () => {
    const blocked = run(baseState({ taxablePeriodShortened: 'yes' }), { emptyTransactions: true });
    assert.strictEqual(blocked.result.resultStatus, 'blocked');
    assert(blocked.viewModel.alerts.some(alert =>
      alert.code === 'SZ_TAXABLE_PERIOD_SHORTENED_UNSUPPORTED' &&
      alert.description.includes('第1版の対象外')));
  });
  check('専門確認項目のわからないは確認要としてblockedになる', () => {
    const blocked = run(baseState({ reverseCharge: 'unknown' }), { emptyTransactions: true });
    assert.strictEqual(blocked.result.resultStatus, 'blocked');
    assert(blocked.viewModel.alerts.some(alert => alert.code === 'SZ_SPECIALIST_CHECK_UNSUPPORTED'));
  });

  process.stdout.write('\n=== 輸出・税込税抜・インボイスなし仕入 ===\n');
  check('輸出売上は一般課税を確定せず、除外項目へ明示する', () => {
    const exported = run(baseState({ salesExportExempt: '1000000' }));
    const general = method(exported.viewModel, 'general');
    assert.strictEqual(general.status, 'blocked');
    assert.strictEqual(exported.viewModel.differenceFromGeneral.available, false);
    assert(exported.viewModel.differenceFromGeneral.reason.includes('差額を表示しません'));
    assert(exported.viewModel.excludedItems.some(item => item.code === 'SZ_EXPORT_REFUND_FUTURE_EXTENSION'));
  });
  check('税抜1,000万円と税込1,100万円で一般課税の納付額が一致する', () => {
    const exclusive = run(baseState({ salesStandard10: '10000000', salesStandard10Basis: 'exclusive' }));
    const inclusiveAmount = complete.viewModel.comparisonRows.find(row => row.methodCode === 'general').exactYen;
    const exclusiveAmount = exclusive.viewModel.comparisonRows.find(row => row.methodCode === 'general').exactYen;
    assert.strictEqual(exclusiveAmount, inclusiveAmount);
  });
  check('インボイスなし仕入の3点セットをTransitionalPurchaseへ組み立てる', () => {
    const state = baseState({
      hasPurchasesWithoutInvoice: 'yes', purchasesWithoutInvoice: '110000',
      purchasesWithoutInvoiceAnnualTotal: '220000', purchasesWithoutInvoiceRecords: 'yes',
    });
    const wire = buildShohizeiInput(state);
    const purchase = wire.purchases[0].value.taxableWithoutInvoice[0];
    assert.strictEqual(purchase.amount.amount.value, '110000');
    assert.strictEqual(purchase.counterpartyAnnualTotal.amount.value, '220000');
    assert.strictEqual(purchase.hasRequiredRecords, 'yes');
  });

  process.stdout.write('\n=== カタログ・コンテキスト・バンドル ===\n');
  check('サービスのSZ理由コードをカタログが網羅し、未知コードはフォールバックする', () => {
    for (const code of SPEC_REASON_CODES) assert(Object.hasOwn(QUESTION_CATALOG, code), code);
    const fallback = resolveQuestion({ code: 'SZ_UNKNOWN_TEST', message: '原文メッセージ' });
    assert.strictEqual(fallback.isFallback, true);
    assert.strictEqual(fallback.description, '原文メッセージ');
  });
  check('コンテキストは国税用2025暦年・snapshot・calculatedAtを持つ', () => {
    assert.deepStrictEqual(complete.context.consumptionTaxPeriod,
      { from: '2025-01-01', to: '2025-12-31' });
    assert.deepStrictEqual(complete.context.jurisdiction, { country: 'JP' });
    assert.strictEqual(complete.context.calculatedAt, calculatedAt);
    assert.strictEqual(complete.context.masterSnapshotId, snapshotInfo.snapshotId);
  });
  check('vm評価でTaxSimulator.mountShohizeiが関数として公開される', () => {
    const built = builder.build();
    const context = { window: {}, crypto: webcrypto, TextEncoder, Uint8Array, ArrayBuffer };
    vm.runInNewContext(built.bundle, context, { filename: 'tax-simulator.bundle.js' });
    assert.strictEqual(typeof context.window.TaxSimulator.mountShohizei, 'function');
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
