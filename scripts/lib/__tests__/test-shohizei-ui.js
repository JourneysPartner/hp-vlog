'use strict';

/** ②消費税シミュレーターUI（U4）のDOM非依存受け入れテスト。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const service = require('../../../src/simulators/shohizei/index.js');
const snapshot = require('../../../src/tax-engine/masters/snapshot.js');
const builder = require('../../build-simulator-bundle.js');
const {
  buildCalculationContext, consumptionTaxPeriodFor, INVOICE_TRANSITION_CHANGE_DATE, invoiceTransitionSplit,
} = require('../../../src/ui/shohizei/context-builder.js');
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
const goldenDocument = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'data', 'tax-simulator', 'golden-cases',
  'official-examples.json'
), 'utf8'));
const exportMixedGolden = goldenDocument.cases.find(item =>
  item.case_id === 'GC-CT-EXPORT-MIXED');
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

function run(formState, options = {}) {
  const context = buildCalculationContext(formState, snapshotInfo, calculatedAt);
  const wire = buildShohizeiInput(formState, { consumptionTaxPeriod: consumptionTaxPeriodFor(formState.consumptionTaxYear), ...options });
  const validation = service.validate(wire);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors || []));
  const result = service.simulate(validation.value, context, snapshotInfo);
  return { context, wire, result, viewModel: buildResultViewModel(result) };
}

function runAtPeriod(formState, period) {
  const context = {
    ...buildCalculationContext(formState, snapshotInfo, calculatedAt),
    consumptionTaxPeriod: { ...period },
  };
  const wire = buildShohizeiInput(formState, { consumptionTaxPeriod: period });
  for (const segment of [...wire.sales, ...wire.purchases]) segment.period = { ...period };
  const validation = service.validate(wire);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors || []));
  const result = service.simulate(validation.value, context, snapshotInfo);
  return { context, wire, result, viewModel: buildResultViewModel(result) };
}

function method(viewModel, code) {
  return viewModel.eligibilityRows.find(row => row.methodCode === code);
}

async function main() {
  process.stdout.write('\n=== 初期画面・ページ遷移 ===\n');
  check('マウント直後はSTEP 1で、遷移時に先頭スクロール後フォーカスしintroを圧縮・復元する', () => {
    withFakeDocument(({ root, intro }) => {
      const calls = [];
      const app = mountShohizeiApp(root, {
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
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
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
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
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'result',
        result: exempt.result, viewModel: exempt.viewModel }));
      assert(root.querySelector('.simulator-key-result').textContent
        .includes('納税義務なし（免税事業者）'));
      app.destroy();
    });
  });
  check('免税事業者×輸出売上は還付不可と課税事業者での再計算を案内する', () => {
    const exemptExport = run(baseState({
      invoiceRegistered: 'no', becameTaxableByRegistration: '',
      basePeriodTaxableSales: '8000000',
      specifiedPeriodTaxableSales: '8000000', specifiedPeriodSalaryPayments: '2000000',
      simplifiedElectionStatus: 'no', simplifiedElectionEffectiveYear: '', simplifiedCategory: '',
      salesStandard10: '0', salesExportExempt: '12000000',
      purchasesWithInvoiceStandard10: '8800000',
    }));
    assert.strictEqual(exemptExport.viewModel.isExempt, true);
    assert(exemptExport.viewModel.exemptNotice.includes('免税事業者は仕入税額の還付を受けられません'));
    assert(exemptExport.viewModel.exemptNotice.includes('登録済みとして再計算'));
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
  const exported = runAtPeriod(baseState({
    basePeriodTaxableSales: exportMixedGolden.inputs.base_period_taxable_sales,
    simplifiedElectionEffectiveYear: '2026',
    salesStandard10: exportMixedGolden.inputs.standard_rate_tax_inclusive_sales,
    salesExportExempt: exportMixedGolden.inputs.export_exempt_sales,
    purchasesWithInvoiceStandard10:
      exportMixedGolden.inputs.standard_rate_tax_inclusive_purchases_with_invoice,
    simplifiedCategory: `type${exportMixedGolden.inputs.simplified_business_type}`,
  }), exportMixedGolden.inputs.taxable_period);
  check('GC-CT-EXPORT-MIXEDの主役数値を概算還付額600,000円として表示する', () => {
    const general = exported.viewModel.comparisonRows.find(row => row.methodCode === 'general');
    const simplified = exported.viewModel.comparisonRows.find(row => row.methodCode === 'simplified');
    assert.strictEqual(exported.result.periodLabel, '2026-01-01～2026-12-31');
    assert.strictEqual(general.exactYen,
      BigInt(exportMixedGolden.expected.general_total_payable));
    assert.strictEqual(general.display, '還付 600,000円');
    assert.strictEqual(simplified.exactYen,
      BigInt(exportMixedGolden.expected.simplified_total_payable));
    assert.strictEqual(simplified.display, '40,000円');
    assert.strictEqual(exported.viewModel.recommendedMethodCode, 'general');
    assert.strictEqual(exported.viewModel.keyResult.label, '概算還付額');
    assert.strictEqual(exported.viewModel.keyResult.exactYen,
      BigInt(exportMixedGolden.expected.total_refund));
    assert.strictEqual(exported.viewModel.keyResult.display, '600,000円');
    assert.strictEqual(exported.viewModel.excludedItems.length, 0);
    withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, {
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'result',
        result: exported.result, viewModel: exported.viewModel }));
      const block = root.querySelector('.simulator-key-result');
      assert(block.textContent.includes('概算還付額（この試算では）'));
      assert(block.textContent.includes('600,000円'));
      assert(root.textContent.includes('実額の仕入税額控除のため、控除不足額は還付の対象'));
      assert(simplified.refundExplanation.includes(
        'みなし仕入率で売上税額から控除額を算出するため、還付は生じません'));
      app.destroy();
    });
  });
  check('輸出欄と基準期間欄に§20の区別・算入ヘルプを表示する', () => {
    withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, {
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      assert(root.textContent.includes('輸出免税売上も含めた金額'));
      app.store.setState(state => ({ ...state, step: 2 }));
      assert(root.textContent.includes('国内から商品を発送して海外へ販売した売上（eBay輸出など）'));
      assert(root.textContent.includes('国外で完結する取引（不課税）は含めません'));
      app.destroy();
    });
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
    const wire = buildShohizeiInput(state, { consumptionTaxPeriod: consumptionTaxPeriodFor(2025) });
    const purchase = wire.purchases[0].value.taxableWithoutInvoice[0];
    assert.strictEqual(purchase.amount.amount.value, '110000');
    assert.strictEqual(purchase.counterpartyAnnualTotal.amount.value, '220000');
    assert.strictEqual(purchase.hasRequiredRecords, 'yes');
  });

  process.stdout.write('\n=== C-18: インボイスなし仕入の期間分割 ===\n');
  const period2026 = { from: '2026-01-01', to: '2026-12-31' };
  const splitState = baseState({
    hasPurchasesWithoutInvoice: 'yes', purchasesWithoutInvoice: '1100000',
    purchasesWithoutInvoiceBeforeChange: '2200000',
    purchasesWithoutInvoiceBeforeChangeBasis: 'exclusive',
    purchasesWithoutInvoiceAnnualTotal: '3520000',
  });
  check('2025年は従来の1行・取引日なしで、変更前の欄を要求しない', () => {
    const wire = buildShohizeiInput({ ...splitState, purchasesWithoutInvoiceBeforeChange: '' }, { consumptionTaxPeriod: consumptionTaxPeriodFor(2025) });
    const rows = wire.purchases[0].value.taxableWithoutInvoice;
    assert.strictEqual(rows.length, 1);
    assert(!Object.hasOwn(rows[0], 'transactionDate'));
    assert.strictEqual(rows[0].amount.amount.value, '1100000');
    assert.deepStrictEqual(wire.sales[0].period, { from: '2025-01-01', to: '2025-12-31' });
    assert.deepStrictEqual(wire.purchases[0].period, wire.sales[0].period);
  });
  check('2026年は変更後・変更前の順で金額・区分・共通項目と期間を送る', () => {
    for (const band of ['standard_10', 'reduced_8']) {
      const wire = buildShohizeiInput({ ...splitState, purchasesWithoutInvoiceBand: band,
        purchasesWithoutInvoiceRecords: 'no' }, { consumptionTaxPeriod: period2026 });
      assert.deepStrictEqual(wire.sales[0].period, period2026);
      assert.deepStrictEqual(wire.purchases[0].period, period2026);
      assert.deepStrictEqual(wire.purchases[0].value.taxableWithoutInvoice,
        [['2026-10-01', '1100000', 'inclusive'], ['2026-09-30', '2200000', 'exclusive']]
          .map(([transactionDate, amount, basis]) => ({
            transactionDate, band, amount: { basis, amount: { unit: 'JPY', value: amount } },
            counterpartyAnnualTotal: { basis: 'inclusive', amount: { unit: 'JPY', value: '3520000' } },
            hasRequiredRecords: 'no',
          })));
    }
  });
  check('両方の金額を必須とし、0は受け付け、共通項目のエラーを重複させない', () => {
    for (const [key, index] of [['purchasesWithoutInvoice', 0], ['purchasesWithoutInvoiceBeforeChange', 1]]) {
      assert.throws(() => buildShohizeiInput({ ...splitState, [key]: '' },
        { consumptionTaxPeriod: period2026 }), error => error.errors.length === 1 &&
        error.errors[0].fieldPath === `$.purchases[0].value.taxableWithoutInvoice[${index}].amount.amount.value`);
      const wire = buildShohizeiInput({ ...splitState, [key]: '0' }, { consumptionTaxPeriod: period2026 });
      assert.strictEqual(wire.purchases[0].value.taxableWithoutInvoice[index].amount.amount.value, '0');
    }
    assert.throws(() => buildShohizeiInput({ ...splitState,
      purchasesWithoutInvoiceAnnualTotal: '', purchasesWithoutInvoiceRecords: '' },
    { consumptionTaxPeriod: period2026 }), error => {
      assert.deepStrictEqual(error.errors.map(item => item.fieldPath), [
        '$.purchases[0].value.taxableWithoutInvoice[0].counterpartyAnnualTotal.amount.value',
        '$.purchases[0].value.taxableWithoutInvoice[0].hasRequiredRecords',
      ]);
      return true;
    });
  });
  check('変更日の境界だけをまたぐときに分割する', () => {
    for (const period of [
      { from: '2025-01-01', to: '2025-12-31' },
      { from: '2026-01-01', to: '2026-09-30' },
      { from: '2026-10-01', to: '2026-12-31' },
    ]) {
      assert.strictEqual(invoiceTransitionSplit(period), null);
      const rows = buildShohizeiInput(splitState, { consumptionTaxPeriod: period })
        .purchases[0].value.taxableWithoutInvoice;
      assert.strictEqual(rows.length, 1);
      assert(!Object.hasOwn(rows[0], 'transactionDate'));
    }
    assert(invoiceTransitionSplit({ from: '2026-09-30', to: '2026-10-01' }));
    assert.deepStrictEqual(buildShohizeiInput(baseState(), { consumptionTaxPeriod: period2026 })
      .purchases[0].value.taxableWithoutInvoice, []);
  });
  check('変更日と前日がマスターのINV-TRANS-02・01の境界に一致する', () => {
    const masters = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..',
      'data/tax-simulator/masters/data/consumption-tax/rates-and-thresholds.json'), 'utf8'));
    const records = Object.values(masters).filter(Array.isArray).flat();
    const split = invoiceTransitionSplit(period2026);
    assert.strictEqual(INVOICE_TRANSITION_CHANGE_DATE,
      records.find(item => item.record_id === 'INV-TRANS-02').applies_to_transaction_from);
    assert.strictEqual(split.beforeDate,
      records.find(item => item.record_id === 'INV-TRANS-01').applies_to_transaction_to);
    assert.strictEqual(new Date(`${split.afterDate}T00:00:00Z`).getTime() -
      new Date(`${split.beforeDate}T00:00:00Z`).getTime(), 24 * 60 * 60 * 1000);
  });
  check('2026年だけ2欄と説明を表示し、共通の入力は1組で前の金額を先に並べる', () => {
    for (const consumptionTaxPeriod of [consumptionTaxPeriodFor(2025), period2026, undefined]) {
      withFakeDocument(({ root }) => {
        const app = mountShohizeiApp(root, {
          services: { validate() { return { ok: true }; }, simulate() {} }, consumptionTaxPeriod,
        });
        try {
          assert.strictEqual(app.store.getState().form.purchasesWithoutInvoiceBeforeChange, '');
          assert.strictEqual(app.store.getState().form.purchasesWithoutInvoiceBeforeChangeBasis, 'inclusive');
          app.store.setState(state => ({ ...state, step: 2, form: { ...state.form, ...splitState } }));
          const before = root.querySelector('#sz-without-invoice-amount-before');
          assert.strictEqual(Boolean(before), consumptionTaxPeriod?.from !== '2025-01-01');
          assert(root.querySelector('#sz-without-invoice-amount'));
          const explanation = '経過措置の控除割合が2026年10月1日に変わるので、取引日で分けて入力してください。どちらかが無ければ0を入力してください。';
          assert.strictEqual(root.textContent.includes(explanation), consumptionTaxPeriod?.from !== '2025-01-01');
          if (consumptionTaxPeriod?.from !== '2025-01-01') {
            const beforeLabel = 'インボイスなし課税仕入（2026年9月30日まで・80%控除）';
            const afterLabel = 'インボイスなし課税仕入（2026年10月1日以後・70%控除）';
            assert(root.textContent.includes(beforeLabel));
            assert(root.textContent.includes(afterLabel));
            assert(root.textContent.indexOf(beforeLabel) < root.textContent.indexOf(afterLabel));
            before.value = '3300000';
            // 簡易DOMは同種のリスナーを1個だけ保持するため、金額の解析をchangeで先に実行する。
            before.listeners.get('change')();
            before.listeners.get('input')();
            assert.strictEqual(app.store.getState().form.purchasesWithoutInvoiceBeforeChange, '3300000');
            const basis = root.querySelector('#sz-without-invoice-amount-before-basis');
            basis.value = 'inclusive';
            basis.listeners.get('change')();
            assert.strictEqual(app.store.getState().form.purchasesWithoutInvoiceBeforeChangeBasis, 'inclusive');
          } else {
            assert(!root.textContent.includes('80%控除'));
            assert(!root.textContent.includes('70%控除'));
          }
        } finally { app.destroy(); }
      });
    }
  });
  check('変更前の空欄エラーを対応する金額欄と要約リンクに結びつける', () => {
    withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, {
        services: service, snapshotInfo,
        now: () => calculatedAt, consumptionTaxPeriod: period2026 });
      try {
        app.store.setState(state => ({ ...state, step: 2,
          form: { ...state.form, ...splitState, purchasesWithoutInvoiceBeforeChange: '' } }));
        root.querySelector('.shohizei-primary').listeners.get('click')();
        assert.deepStrictEqual(app.store.getState().errors.map(item => item.fieldPath),
          ['$.purchases[0].value.taxableWithoutInvoice[1].amount.amount.value']);
        const before = root.querySelector('#sz-without-invoice-amount-before');
        assert.strictEqual(before.getAttribute('aria-invalid'), 'true');
        assert(before.getAttribute('aria-describedby').includes('sz-without-invoice-amount-before-error'));
        assert.strictEqual(root.querySelector('.shohizei-error-summary').querySelector('a')
          .getAttribute('href'), '#sz-without-invoice-amount-before');
      } finally { app.destroy(); }
    });
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


  check('R8: 施行前注記を見出し直後に表示し、通常結果には表示しない', () => {
    const original = run(baseState()).result;
    const noticeText = '施行前・概算：画面に引き継ぐ本文';
    for (const includeNotice of [true, false]) {
      const injected = { ...original, resultStatus: includeNotice ? 'partial' : original.resultStatus,
        warnings: includeNotice
          ? [...original.warnings, { code: 'MASTER_PENDING_LAW_APPLIED', basis: noticeText }]
          : original.warnings };
      const viewModel = buildResultViewModel(injected);
      assert.strictEqual(viewModel.pendingLawNotice, includeNotice ? noticeText : undefined);
      withFakeDocument(({ root }) => {
        const app = mountShohizeiApp(root, {
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
          services: { validate() { return { ok: true }; }, simulate() {} },
        });
        app.store.setState(state => ({ ...state, screen: 'result', result: injected, viewModel }));
        const notice = root.querySelector('.shohizei-pending-law-notice');
        if (includeNotice) {
          assert(notice);
          assert.strictEqual(notice.tagName, 'P');
          assert.strictEqual(notice.textContent, noticeText);
          const heading = root.querySelector('#sz-result-heading');
          const siblings = heading.parentNode.children;
          assert.strictEqual(siblings.indexOf(notice), siblings.indexOf(heading) + 1);
          assert(siblings.indexOf(notice) < siblings.indexOf(root.querySelector('.simulator-key-result')));
          for (let ancestor = notice; ancestor; ancestor = ancestor.parentNode) {
            assert(!ancestor.classList.contains('shohizei-no-print'));
          }
        } else {
          assert.strictEqual(notice, null);
        }
        app.destroy();
      });
    }
    const injected = { ...original, resultStatus: 'blocked',
      warnings: [{ code: 'MASTER_PENDING_LAW_APPLIED', basis: noticeText }],
      summary: { title: '試算停止' } };
    delete injected.breakdown;
    const blockedViewModel = buildResultViewModel(injected);
    assert.strictEqual(blockedViewModel.pendingLawNotice, undefined);
    withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, {
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'blocked', result: injected, viewModel: blockedViewModel }));
      assert.strictEqual(root.querySelector('.shohizei-pending-law-notice'), null);
      app.destroy();
    });
  });


  process.stdout.write('\n=== R8: partialの免税表示 ===\n');
  {
    const exempt = run(baseState({
      invoiceRegistered: 'no', becameTaxableByRegistration: '',
      basePeriodTaxableSales: '8000000',
      specifiedPeriodTaxableSales: '8000000', specifiedPeriodSalaryPayments: '2000000',
      simplifiedElectionStatus: 'no', simplifiedElectionEffectiveYear: '',
      simplifiedCategory: '', salesStandard10: '0', purchasesWithInvoiceStandard10: '0',
    }), { emptyTransactions: true });
    const injected = { ...exempt.result, resultStatus: 'partial',
      warnings: [{ code: 'MASTER_PENDING_LAW_APPLIED', basis: '施行前・概算：免税の試験' }] };
    const viewModel = buildResultViewModel(injected);
    assert.strictEqual(viewModel.isExempt, true);
    assert(viewModel.heading.includes('一部概算'));
    assert(!viewModel.heading.includes('partial'));
    const { createFakeDom } = require('./helpers/fake-dom.js');
    const previousDocument = global.document;
    const dom = createFakeDom();
    global.document = dom.document;
    let app;
    try {
      app = mountShohizeiApp(dom.root, {
          consumptionTaxPeriod: consumptionTaxPeriodFor(2025),
        services: { validate() { return { ok: true, value: {} }; }, simulate() { return injected; } },
        snapshotInfo, now: () => calculatedAt,
      });
      app.store.setState(state => ({ ...state, screen: 'input', step: 1,
        form: { ...state.form, ...baseState() } }));
      const next = dom.root.querySelector('.shohizei-primary');
      assert(next);
      await next.listeners.get('click')();
      assert.strictEqual(app.store.getState().screen, 'result');
      assert.strictEqual(app.store.getState().viewModel.isExempt, true);
      assert(dom.root.textContent.includes('納税義務なし（免税事業者）'));
      assert(dom.root.querySelector('.shohizei-pending-law-notice'));
      process.stdout.write('  ✓ partialでも方式0件なら納税義務の判定から免税結果を表示\n');
      passed++;
    } finally {
      if (app) app.destroy();
      if (previousDocument === undefined) delete global.document;
      else global.document = previousDocument;
    }
  }

  process.stdout.write('\n=== 段5: 2026年の既定・課税期間・日本語の結果状態 ===\n');
  check('既定の文脈と入力は2026暦年で、対応年の期間は凍結され範囲外は拒否する', () => {
    const { DEFAULT_YEAR, SUPPORTED_YEARS } = require('../../../src/ui/shohizei/context-builder.js');
    assert.strictEqual(DEFAULT_YEAR, 2026);
    assert(Object.isFrozen(SUPPORTED_YEARS));
    assert.deepStrictEqual(SUPPORTED_YEARS, [2025, 2026]);
    const form = baseState({ consumptionTaxYear: undefined });
    const context = buildCalculationContext(form, snapshotInfo, calculatedAt);
    const input = buildShohizeiInput(form);
    assert.deepStrictEqual(context.consumptionTaxPeriod, { from: '2026-01-01', to: '2026-12-31' });
    assert.deepStrictEqual(input.sales[0].period, context.consumptionTaxPeriod);
    assert.deepStrictEqual(input.purchases[0].period, context.consumptionTaxPeriod);
    assert(Object.isFrozen(consumptionTaxPeriodFor(2026)));
    for (const consumptionTaxYear of [2024, 2027]) {
      assert.throws(() => consumptionTaxPeriodFor(consumptionTaxYear), RangeError);
      assert.throws(() => buildCalculationContext({ consumptionTaxYear }, snapshotInfo, calculatedAt), RangeError);
    }
  });
  check('2026年既定と2025年指定は文言・届出効力年・文脈と入力の期間が一致する', () => {
    for (const consumptionTaxPeriod of [undefined, consumptionTaxPeriodFor(2025)]) withFakeDocument(({ root }) => {
      const app = mountShohizeiApp(root, { services: service, consumptionTaxPeriod });
      try {
        const form = app.store.getState().form;
        const year = consumptionTaxPeriod ? 2025 : 2026;
        assert.strictEqual(form.consumptionTaxYear, year);
        assert.strictEqual(form.simplifiedElectionEffectiveYear, String(year));
        assert.strictEqual(form.taxablePersonElectionEffectiveYear, String(year));
        assert(root.textContent.includes(`課税期間：${year}年1月1日〜12月31日（第1版固定）`));
        const context = buildCalculationContext(form, snapshotInfo, calculatedAt);
        const input = buildShohizeiInput(baseState({ consumptionTaxYear: year }),
          { consumptionTaxPeriod: consumptionTaxPeriodFor(year) });
        assert.deepStrictEqual(input.sales[0].period, context.consumptionTaxPeriod);
        assert.deepStrictEqual(input.purchases[0].period, context.consumptionTaxPeriod);
      } finally { app.destroy(); }
    });
    withFakeDocument(({ root }) => {
      for (const consumptionTaxPeriod of [null, {}, { from: '2026-04-01', to: '2027-03-31' },
        { from: '2026-01-01', to: '2026-12-30' }, { from: '2027-01-01', to: '2027-12-31' }]) {
        assert.throws(() => mountShohizeiApp(root, { services: service, consumptionTaxPeriod }), RangeError);
      }
    });
  });
  check('②の見出しと印刷は全状態を日本語で表示し、未知の状態はTypeError', () => {
    for (const [status, label] of [['complete', '計算完了'], ['partial', '一部概算'], ['blocked', '停止']]) {
      const result = { ...complete.result, resultStatus: status };
      if (status === 'blocked') delete result.breakdown;
      const viewModel = buildResultViewModel(result);
      assert.strictEqual(viewModel.resultStatus, status);
      assert.strictEqual(viewModel.resultStatusLabel, label);
      assert(viewModel.heading.includes(label));
      assert(!viewModel.heading.includes(status));
      withFakeDocument(({ root }) => {
        const app = mountShohizeiApp(root, { services: service });
        try {
          app.store.setState(state => ({ ...state, screen: status === 'blocked' ? 'blocked' : 'result', result, viewModel }));
          assert(root.textContent.includes(`結果状態：${label}`));
          assert(!root.textContent.includes(`結果状態：${status}`));
        } finally { app.destroy(); }
      });
    }
    assert.throws(() => buildResultViewModel({ ...complete.result, resultStatus: 'unknown' }), TypeError);
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
