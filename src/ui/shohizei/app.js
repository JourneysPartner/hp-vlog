'use strict';

const { el } = require('../dom.js');
const { createStore } = require('../store.js');
const { createMoneyInput, createSelect, parseMoneyInput } = require('../forms.js');
const { announceStatus, announceAlert } = require('../a11y.js');
const { createSimulatorPageView } = require('../simulator-page-view.js');
const { queueEvent } = require('../analytics.js');
const { buildCalculationContext } = require('./context-builder.js');
const { ShohizeiInputBuildError, buildShohizeiInput } = require('./input-builder.js');
const { buildResultViewModel } = require('./result-view-model.js');

const TOTAL_STEPS = 2;
const TRI_STATE_OPTIONS = Object.freeze([
  { value: '', label: '選択してください' },
  { value: 'yes', label: 'はい・該当する' },
  { value: 'no', label: 'いいえ・該当しない' },
  { value: 'unknown', label: 'わからない' },
]);
const BASIS_OPTIONS = Object.freeze([
  { value: 'inclusive', label: '税込' },
  { value: 'exclusive', label: '税抜' },
]);
const INITIAL_FORM = Object.freeze({
  consumptionTaxYear: 2025,
  taxpayerType: '',
  invoiceRegistered: '',
  invoiceRegisteredOn: '',
  becameTaxableByRegistration: '',
  basePeriodExists: true,
  basePeriodTaxableSales: '',
  basePeriodLengthInMonths: '12',
  specifiedPeriodTaxableSales: '',
  specifiedPeriodSalaryPayments: '',
  simplifiedElectionStatus: '',
  simplifiedElectionEffectiveYear: '2025',
  taxablePersonElectionStatus: '',
  taxablePersonElectionEffectiveYear: '2025',
  isNewlyEstablished: '',
  isSpecifiedNewlyEstablished: '',
  inheritance: '',
  merger: '',
  corporateSplit: '',
  highValueAssetAcquisition: '',
  adjustableFixedAssetAcquisition: '',
  taxablePeriodShortened: '',
  reverseCharge: '',
  specificTaxablePurchase: '',
  complexTaxableSalesRatio: '',
  salesStandard10: '', salesStandard10Basis: 'inclusive',
  salesReduced8: '', salesReduced8Basis: 'inclusive',
  salesExportExempt: '', salesExportExemptBasis: 'inclusive',
  purchasesWithInvoiceStandard10: '', purchasesWithInvoiceStandard10Basis: 'inclusive',
  purchasesWithInvoiceReduced8: '', purchasesWithInvoiceReduced8Basis: 'inclusive',
  hasPurchasesWithoutInvoice: '',
  purchasesWithoutInvoiceBand: 'standard_10',
  purchasesWithoutInvoice: '', purchasesWithoutInvoiceBasis: 'inclusive',
  purchasesWithoutInvoiceAnnualTotal: '',
  purchasesWithoutInvoiceRecords: '',
  simplifiedCategory: '',
});

const FIELD_IDS = Object.freeze({
  '$.taxpayerType': 'sz-taxpayer-type',
  '$.eligibility.invoiceRegistration.registered': 'sz-invoice-registered',
  '$.eligibility.invoiceRegistration.registeredOn': 'sz-invoice-date',
  '$.eligibility.invoiceRegistration.becameTaxableByRegistration': 'sz-became-taxable',
  '$.eligibility.basePeriod.taxableSales.value': 'sz-base-sales',
  '$.eligibility.basePeriod.lengthInMonths': 'sz-base-months',
  '$.eligibility.specifiedPeriod.taxableSales.value': 'sz-specified-sales',
  '$.eligibility.specifiedPeriod.salaryPayments.value': 'sz-specified-salary',
  '$.eligibility.filings.simplified_election': 'sz-simplified-election',
  '$.eligibility.filings.taxable_person_election': 'sz-taxable-election',
  '$.eligibility.newCompany.isNewlyEstablished': 'sz-new-company',
  '$.eligibility.newCompany.isSpecifiedNewlyEstablished': 'sz-specified-new-company',
  '$.eligibility.events.inheritance': 'sz-inheritance',
  '$.eligibility.events.merger': 'sz-merger',
  '$.eligibility.events.corporateSplit': 'sz-corporate-split',
  '$.eligibility.events.highValueAssetAcquisition': 'sz-high-value-asset',
  '$.eligibility.events.adjustableFixedAssetAcquisition': 'sz-adjustable-asset',
  '$.eligibility.taxablePeriodShortened': 'sz-shortened',
  '$.specialistChecks.reverseCharge': 'sz-reverse-charge',
  '$.specialistChecks.specificTaxablePurchase': 'sz-specific-purchase',
  '$.specialistChecks.complexTaxableSalesRatio': 'sz-complex-ratio',
  '$.sales[0].value.taxable[0].amount.amount.value': 'sz-sales-10',
  '$.sales[0].value.taxable[1].amount.amount.value': 'sz-sales-8',
  '$.sales[0].value.exportExempt.amount.value': 'sz-sales-export',
  '$.purchases[0].value.taxableWithInvoice[0].amount.amount.value': 'sz-purchases-10',
  '$.purchases[0].value.taxableWithInvoice[1].amount.amount.value': 'sz-purchases-8',
  '$.purchases[0].value.taxableWithoutInvoice': 'sz-without-invoice',
  '$.purchases[0].value.taxableWithoutInvoice[0].amount.amount.value': 'sz-without-invoice-amount',
  '$.purchases[0].value.taxableWithoutInvoice[0].counterpartyAnnualTotal.amount.value': 'sz-without-invoice-total',
  '$.purchases[0].value.taxableWithoutInvoice[0].hasRequiredRecords': 'sz-without-invoice-records',
  '$.simplified.primaryCategory': 'sz-simplified-category',
});

const STYLE_TEXT = `
.shohizei-app{color:#22293a;max-width:1080px;margin:0 auto;padding:24px;font-family:"Noto Sans JP",sans-serif;line-height:1.7}
.shohizei-app h1,.shohizei-app h2,.shohizei-app h3{color:#0B2045}.shohizei-card{background:#fff;border:1px solid #E3E8F0;border-radius:12px;padding:24px;margin:16px 0;box-shadow:var(--shadow-sm,0 2px 8px rgba(11,32,69,.08))}
.shohizei-conclusion{background:#FDF0EA;border-left:6px solid #E85320}.shohizei-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.shohizei-app button{min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid #0B2045;background:#fff;color:#0B2045;font:inherit}.shohizei-app button.shohizei-primary{background:#E85320;border-color:#E85320;color:#fff}
.shohizei-app input,.shohizei-app select{display:block;box-sizing:border-box;width:100%;max-width:38rem;min-height:44px;margin:6px 0 16px;padding:8px;border:1px solid #55607a;border-radius:8px;font:inherit}.shohizei-app input[type=checkbox]{display:inline-block;width:auto;min-height:auto;margin-right:8px}.shohizei-tax-field{border:1px solid #E3E8F0;border-radius:8px;padding:16px;margin:12px 0}.shohizei-tax-field .select-input select{max-width:12rem}
.shohizei-progress{font-weight:700}.shohizei-help{color:#55607a}.shohizei-error{color:#9b1c1c;font-weight:700}.shohizei-error-summary{border:2px solid #9b1c1c;padding:16px;margin:16px 0}.shohizei-status{font-size:1.2rem;font-weight:700}.shohizei-table-wrap{overflow-x:auto}.shohizei-app table{border-collapse:collapse;width:100%;min-width:520px}.shohizei-app th,.shohizei-app td{border:1px solid #E3E8F0;padding:10px;text-align:left}.shohizei-app td:last-child{text-align:right}.shohizei-level{font-weight:700}.shohizei-placeholder{border:1px dashed #55607a;padding:12px;color:#55607a}.simulator-live-region{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:480px){.shohizei-app{padding:12px}.shohizei-card{padding:16px}.shohizei-actions{display:block}.shohizei-actions button{width:100%;margin:5px 0}.shohizei-app table{min-width:0}}
@media print{.shohizei-no-print{display:none!important}.shohizei-app{max-width:none;padding:0}.shohizei-card{box-shadow:none;break-inside:avoid}.shohizei-print-page-number::after{content:" / ページ " counter(page)}@page{margin:15mm}}
`;

function cloneInitialForm() { return { ...INITIAL_FORM }; }

function mountShohizeiApp(rootElement, {
  services, snapshotInfo, now, scrollToAppTop, focusHeading, introElement,
} = {}) {
  if (!rootElement || typeof rootElement.replaceChildren !== 'function') {
    throw new TypeError('マウント先のDOM要素が必要です');
  }
  const service = services && services.shohizei ? services.shohizei : services;
  if (!service || typeof service.validate !== 'function' || typeof service.simulate !== 'function') {
    throw new TypeError('shohizeiサービスが必要です');
  }
  const nowProvider = typeof now === 'function' ? now : () => new Date().toISOString();
  const browserWindow = rootElement.ownerDocument && rootElement.ownerDocument.defaultView;
  const store = createStore({ screen: 'input', step: 1, form: cloneInitialForm(), errors: [], result: null, viewModel: null });
  let destroyed = false;
  rootElement.classList.add('shohizei-app');
  const pageView = createSimulatorPageView(rootElement, {
    isFirstView: state => state.screen === 'input' && state.step === 1,
    scrollToAppTop, focusHeading, introElement,
  });
  queueEvent('simulator_view', { tool: 'shohizei' });
  queueEvent('simulator_start', { tool: 'shohizei' });

  function updateForm(key, value) {
    store.setState(state => ({ ...state, form: { ...state.form, [key]: value } }));
  }
  function errorFor(path) { return store.getState().errors.find(item => item.fieldPath === path); }
  function addControlError(control, path) {
    const found = errorFor(path);
    if (!found) return null;
    const id = `${control.id || FIELD_IDS[path] || 'sz-field'}-error`;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    return el('p', { id, className: 'shohizei-error' }, found.message);
  }
  function errorSummary() {
    const errors = store.getState().errors;
    if (errors.length === 0) return null;
    return el('div', { className: 'shohizei-error-summary', tabindex: '-1' }, [
      el('h2', {}, '入力内容を確認してください'),
      el('ul', {}, errors.map(item => el('li', {}, FIELD_IDS[item.fieldPath]
        ? el('a', { href: `#${FIELD_IDS[item.fieldPath]}` }, item.message) : item.message))),
    ]);
  }
  function selectField(key, id, label, description, options, path, rerender = false) {
    const field = createSelect({ id, label, description, options, value: store.getState().form[key], onChange: value => {
      updateForm(key, value);
      if (rerender) render();
    } });
    return [field.element, addControlError(field.select, path)];
  }
  function moneyField(key, id, label, description, path, afterInput) {
    const field = createMoneyInput({ id, label, description, value: store.getState().form[key] });
    field.input.addEventListener('input', () => {
      const parsed = field.read();
      updateForm(key, parsed.ok ? parsed.value : field.input.value);
      if (afterInput) afterInput(parsed, field);
    });
    return { nodes: [field.element, addControlError(field.input, path)], field };
  }
  function taxField(key, basisKey, id, label, path, afterInput) {
    const amount = moneyField(key, id, `${label}（円）`, '0円以上の整数。全角数字・万単位も入力できます。', `${path}.amount.value`, afterInput);
    const basis = createSelect({ id: `${id}-basis`, label: `${label}の入力区分`, options: BASIS_OPTIONS,
      value: store.getState().form[basisKey], onChange: value => updateForm(basisKey, value) });
    return el('div', { className: 'shohizei-tax-field' }, [amount.nodes, basis.element,
      addControlError(basis.select, `${path}.basis`)]);
  }
  function stepHeader(step, title) {
    return [el('p', { className: 'shohizei-progress', role: 'status', 'aria-label': `2ステップ中${step}番目` },
      `STEP ${step} / ${TOTAL_STEPS}`), el('h1', {}, title)];
  }
  function actions({ previous, next, calculate } = {}) {
    return el('div', { className: 'shohizei-actions shohizei-no-print' }, [
      previous ? el('button', { type: 'button', onClick: () => goToStep(1) }, '戻る') : null,
      next ? el('button', { type: 'button', className: 'shohizei-primary', onClick: probeLiability }, '次へ') : null,
      calculate ? el('button', { type: 'button', className: 'shohizei-primary', onClick: calculateNow }, '計算する') : null,
      el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
    ]);
  }
  function checkGroup(title, rows) {
    return el('section', { className: 'shohizei-card' }, [el('h2', {}, title), rows]);
  }

  function renderStep1() {
    const form = store.getState().form;
    const baseExists = el('input', { id: 'sz-base-exists', type: 'checkbox', checked: !form.basePeriodExists,
      onChange: event => { updateForm('basePeriodExists', !event.currentTarget.checked); render(); } });
    const invoiceDate = el('input', { id: 'sz-invoice-date', type: 'date', value: form.invoiceRegisteredOn,
      onInput: event => updateForm('invoiceRegisteredOn', event.currentTarget.value) });
    return el('main', { className: 'shohizei-no-print' }, [
      ...stepHeader(1, '事業者の状況'), errorSummary(),
      el('p', { className: 'shohizei-help' },
        '入力と計算はこのブラウザ内で完結し、金額を保存・解析送信しません。'),
      el('p', {}, '課税期間：2025年1月1日〜12月31日（第1版固定）'),
      ...selectField('taxpayerType', 'sz-taxpayer-type', '事業者の区分', '3割特例の判定に影響します。', [
        { value: '', label: '選択してください' }, { value: 'individual', label: '個人事業者' }, { value: 'corporation', label: '法人' },
      ], '$.taxpayerType', true),
      form.taxpayerType === 'corporation' ? el('p', { className: 'shohizei-help' },
        '事業年度が暦年と異なる法人は対応準備中です。') : null,
      ...selectField('invoiceRegistered', 'sz-invoice-registered', 'インボイス登録', '', TRI_STATE_OPTIONS,
        '$.eligibility.invoiceRegistration.registered', true),
      form.invoiceRegistered === 'yes' ? el('div', { className: 'shohizei-card' }, [
        el('label', { for: 'sz-invoice-date' }, 'インボイス登録日（任意）'),
        invoiceDate,
        addControlError(invoiceDate, '$.eligibility.invoiceRegistration.registeredOn'),
        ...selectField('becameTaxableByRegistration', 'sz-became-taxable',
          '登録を機に免税事業者から課税事業者になりましたか', '', TRI_STATE_OPTIONS,
          '$.eligibility.invoiceRegistration.becameTaxableByRegistration'),
      ]) : null,
      el('div', {}, [baseExists, el('label', { for: baseExists.id }, '基準期間がない（開業2年以内など）')]),
      form.basePeriodExists ? moneyField('basePeriodTaxableSales', 'sz-base-sales',
        '基準期間（前々年）の課税売上高（円）', '0円以上の整数。',
        '$.eligibility.basePeriod.taxableSales.value').nodes : null,
      form.basePeriodExists && form.taxpayerType === 'corporation' ? [
        el('label', { for: 'sz-base-months' }, '基準期間の月数'),
        el('input', { id: 'sz-base-months', type: 'text', inputmode: 'numeric', value: form.basePeriodLengthInMonths,
          onInput: event => updateForm('basePeriodLengthInMonths', event.currentTarget.value) }),
        el('p', { className: 'shohizei-help' }, '12か月以外は12か月換算して判定します。'),
      ] : null,
      moneyField('specifiedPeriodTaxableSales', 'sz-specified-sales', '特定期間（前年上半期）の課税売上高（円）',
        '課税売上高または給与等支払額のどちらかが免税点以下なら免税側の判定になります。',
        '$.eligibility.specifiedPeriod.taxableSales.value').nodes,
      moneyField('specifiedPeriodSalaryPayments', 'sz-specified-salary', '特定期間（前年上半期）の給与等支払額（円）',
        '0円以上の整数。', '$.eligibility.specifiedPeriod.salaryPayments.value').nodes,
      ...selectField('simplifiedElectionStatus', 'sz-simplified-election', '簡易課税選択届出書', '', TRI_STATE_OPTIONS,
        '$.eligibility.filings.simplified_election', true),
      form.simplifiedElectionStatus === 'yes' ? [
        el('label', { for: 'sz-simplified-year' }, '簡易課税選択届出書の効力開始年'),
        el('input', { id: 'sz-simplified-year', type: 'text', inputmode: 'numeric', value: form.simplifiedElectionEffectiveYear,
          onInput: event => updateForm('simplifiedElectionEffectiveYear', event.currentTarget.value) }),
      ] : null,
      ...selectField('taxablePersonElectionStatus', 'sz-taxable-election', '課税事業者選択届出書',
        '提出済みの場合、2割特例の適用可否は専門判定になります。', TRI_STATE_OPTIONS,
        '$.eligibility.filings.taxable_person_election', true),
      form.taxablePersonElectionStatus === 'yes' ? [
        el('label', { for: 'sz-taxable-year' }, '課税事業者選択届出書の効力開始年'),
        el('input', { id: 'sz-taxable-year', type: 'text', inputmode: 'numeric', value: form.taxablePersonElectionEffectiveYear,
          onInput: event => updateForm('taxablePersonElectionEffectiveYear', event.currentTarget.value) }),
      ] : null,
      checkGroup('該当の確認', [
        el('p', { className: 'shohizei-help' }, '「該当する」「わからない」の条件は、専門判定または対応範囲外として案内します。'),
        ...selectField('isNewlyEstablished', 'sz-new-company', '新設法人（資本金1,000万円以上等）', '', TRI_STATE_OPTIONS, '$.eligibility.newCompany.isNewlyEstablished'),
        ...selectField('isSpecifiedNewlyEstablished', 'sz-specified-new-company', '特定新設法人', '', TRI_STATE_OPTIONS, '$.eligibility.newCompany.isSpecifiedNewlyEstablished'),
        ...selectField('inheritance', 'sz-inheritance', '相続', '', TRI_STATE_OPTIONS, '$.eligibility.events.inheritance'),
        ...selectField('merger', 'sz-merger', '合併', '', TRI_STATE_OPTIONS, '$.eligibility.events.merger'),
        ...selectField('corporateSplit', 'sz-corporate-split', '会社分割', '', TRI_STATE_OPTIONS, '$.eligibility.events.corporateSplit'),
        ...selectField('highValueAssetAcquisition', 'sz-high-value-asset', '高額特定資産の取得', '', TRI_STATE_OPTIONS, '$.eligibility.events.highValueAssetAcquisition'),
        ...selectField('adjustableFixedAssetAcquisition', 'sz-adjustable-asset', '調整対象固定資産の取得', '', TRI_STATE_OPTIONS, '$.eligibility.events.adjustableFixedAssetAcquisition'),
        ...selectField('taxablePeriodShortened', 'sz-shortened', '課税期間の短縮', '', TRI_STATE_OPTIONS, '$.eligibility.taxablePeriodShortened'),
        ...selectField('reverseCharge', 'sz-reverse-charge', 'リバースチャージ', '', TRI_STATE_OPTIONS, '$.specialistChecks.reverseCharge'),
        ...selectField('specificTaxablePurchase', 'sz-specific-purchase', '特定課税仕入れ', '', TRI_STATE_OPTIONS, '$.specialistChecks.specificTaxablePurchase'),
        ...selectField('complexTaxableSalesRatio', 'sz-complex-ratio', '複雑な課税売上割合', '', TRI_STATE_OPTIONS, '$.specialistChecks.complexTaxableSalesRatio'),
      ]),
      actions({ next: true }),
    ]);
  }

  function renderStep2() {
    const form = store.getState().form;
    const exportWarning = el('p', { id: 'sz-export-warning', className: 'shohizei-error' },
      parseMoneyInput(String(form.salesExportExempt)).ok && BigInt(parseMoneyInput(String(form.salesExportExempt)).value) > 0n
        ? '一般課税の確定額を出せません（対応準備中）' : '');
    return el('main', { className: 'shohizei-no-print' }, [
      ...stepHeader(2, '売上と仕入'), errorSummary(),
      el('p', {}, '税込・税抜は金額欄ごとに選択してください。'),
      el('section', { className: 'shohizei-card' }, [
        el('h2', {}, '売上'),
        taxField('salesStandard10', 'salesStandard10Basis', 'sz-sales-10', '10%対象の課税売上', '$.sales[0].value.taxable[0].amount'),
        taxField('salesReduced8', 'salesReduced8Basis', 'sz-sales-8', '8%（軽減税率）対象の課税売上', '$.sales[0].value.taxable[1].amount'),
        taxField('salesExportExempt', 'salesExportExemptBasis', 'sz-sales-export', '輸出免税売上', '$.sales[0].value.exportExempt',
          parsed => { exportWarning.textContent = parsed.ok && BigInt(parsed.value) > 0n
            ? '一般課税の確定額を出せません（対応準備中）' : ''; }),
        exportWarning,
      ]),
      el('section', { className: 'shohizei-card' }, [
        el('h2', {}, '仕入'),
        taxField('purchasesWithInvoiceStandard10', 'purchasesWithInvoiceStandard10Basis', 'sz-purchases-10',
          'インボイスあり課税仕入（10%）', '$.purchases[0].value.taxableWithInvoice[0].amount'),
        taxField('purchasesWithInvoiceReduced8', 'purchasesWithInvoiceReduced8Basis', 'sz-purchases-8',
          'インボイスあり課税仕入（8%）', '$.purchases[0].value.taxableWithInvoice[1].amount'),
        ...selectField('hasPurchasesWithoutInvoice', 'sz-without-invoice',
          'インボイスなし（免税事業者等から）の課税仕入',
          '判定できない場合は一般課税の確定額を表示できません。', [
            { value: '', label: '選択してください' }, { value: 'no', label: 'ない' }, { value: 'yes', label: 'ある' },
          ], '$.purchases[0].value.taxableWithoutInvoice', true),
        form.hasPurchasesWithoutInvoice === 'yes' ? el('div', { className: 'shohizei-tax-field' }, [
          ...selectField('purchasesWithoutInvoiceBand', 'sz-without-invoice-band', '税率区分', '', [
            { value: 'standard_10', label: '10%' }, { value: 'reduced_8', label: '8%（軽減税率）' },
          ], '$.purchases[0].value.taxableWithoutInvoice[0].band'),
          taxField('purchasesWithoutInvoice', 'purchasesWithoutInvoiceBasis', 'sz-without-invoice-amount',
            'インボイスなし課税仕入', '$.purchases[0].value.taxableWithoutInvoice[0].amount'),
          moneyField('purchasesWithoutInvoiceAnnualTotal', 'sz-without-invoice-total',
            'その相手先からの年間仕入合計（税込・円）', '相手先別上限の判定に使います。',
            '$.purchases[0].value.taxableWithoutInvoice[0].counterpartyAnnualTotal.amount.value').nodes,
          ...selectField('purchasesWithoutInvoiceRecords', 'sz-without-invoice-records',
            '帳簿と請求書の保存要件を満たしますか', '', TRI_STATE_OPTIONS,
            '$.purchases[0].value.taxableWithoutInvoice[0].hasRequiredRecords'),
        ]) : null,
      ]),
      form.simplifiedElectionStatus === 'yes' ? el('section', { className: 'shohizei-card' }, [
        el('h2', {}, '簡易課税の事業区分'),
        ...selectField('simplifiedCategory', 'sz-simplified-category', '主な事業区分（ご自身で選択）', '', [
          { value: '', label: '選択してください' },
          { value: 'type1', label: '卸売業【第1種・みなし仕入率90%】' },
          { value: 'type2', label: '小売業（仕入れた物をそのまま売る。ネット物販含む）【第2種・80%】' },
          { value: 'type3', label: '製造業・建設業【第3種・70%】' },
          { value: 'type4', label: '飲食店業など【第4種・60%】' },
          { value: 'type5', label: 'サービス業・コンサルタントなど【第5種・50%】' },
          { value: 'type6', label: '不動産業【第6種・40%】' },
          { value: 'unclassifiable', label: '複数の事業・わからない → 専門判定' },
        ], '$.simplified.primaryCategory'),
        el('p', { className: 'shohizei-help' }, '事業区分は自動推定しません。複数事業の特例計算は対応準備中です。'),
      ]) : null,
      actions({ previous: true, calculate: true }),
    ]);
  }

  function validationErrors(validation) {
    return (validation.errors || []).map(item => ({ code: item.code || 'SZ_SERVICE_VALIDATION_ERROR',
      fieldPath: item.fieldPath, message: item.message || '入力内容を確認してください' }));
  }
  function setBuildErrors(error, fallbackStep) {
    const errors = error instanceof ShohizeiInputBuildError ? [...error.errors] : [{
      code: 'SZ_UI_BUILD_ERROR', fieldPath: '$.calculationContext', message: error.message,
    }];
    store.setState(state => ({ ...state, screen: 'input', step: fallbackStep, errors }));
    announceAlert('入力内容に確認が必要な項目があります');
  }
  function goToStep(step) {
    store.setState(state => ({ ...state, screen: 'input', step, errors: [] }));
  }
  async function probeLiability() {
    let context; let wire;
    try {
      context = buildCalculationContext(store.getState().form, snapshotInfo, nowProvider());
      wire = buildShohizeiInput(store.getState().form, { emptyTransactions: true });
    } catch (error) { setBuildErrors(error, 1); return; }
    const validation = service.validate(wire);
    if (!validation.ok) {
      store.setState(state => ({ ...state, errors: validationErrors(validation) }));
      await announceAlert('入力内容に確認が必要な項目があります'); return;
    }
    store.setState(state => ({ ...state, screen: 'calculating', errors: [], result: null, viewModel: null }));
    await announceStatus('納税義務を判定しています');
    try {
      const result = await service.simulate(validation.value, context, snapshotInfo);
      const exempt = result.resultStatus === 'complete' && result.breakdown &&
        result.breakdown.kind === 'shohizei' && result.breakdown.data.methodResults.length === 0;
      if (exempt) { showResult(result); return; }
      if ((result.applicableMethods || []).length > 0) { goToStep(2); return; }
      showResult(result);
    } catch (error) { setBuildErrors(error, 1); }
  }
  async function calculateNow() {
    let context; let wire;
    try {
      context = buildCalculationContext(store.getState().form, snapshotInfo, nowProvider());
      wire = buildShohizeiInput(store.getState().form);
    } catch (error) { setBuildErrors(error, 2); return; }
    const validation = service.validate(wire);
    if (!validation.ok) {
      store.setState(state => ({ ...state, errors: validationErrors(validation) }));
      await announceAlert('入力内容に確認が必要な項目があります'); return;
    }
    store.setState(state => ({ ...state, screen: 'calculating', errors: [], result: null, viewModel: null }));
    await announceStatus('計算中です');
    try { showResult(await service.simulate(validation.value, context, snapshotInfo)); }
    catch (error) { setBuildErrors(error, 2); }
  }
  function showResult(result) {
    const viewModel = buildResultViewModel(result);
    store.setState(state => ({ ...state, screen: result.resultStatus === 'blocked' ? 'blocked' : 'result', result, viewModel }));
    queueEvent('simulator_complete', { tool: 'shohizei', resultStatus: result.resultStatus });
    if (result.resultStatus === 'blocked') announceAlert('条件を確認できないため計算を停止しました');
  }
  function resetState() {
    store.setState({ screen: 'input', step: 1, form: cloneInitialForm(), errors: [], result: null, viewModel: null });
  }
  function clearAll() {
    if (browserWindow && typeof browserWindow.confirm === 'function' &&
        !browserWindow.confirm('入力と試算結果をすべてクリアしますか？')) return;
    resetState();
  }
  function printResult() {
    queueEvent('simulator_cta_click', { tool: 'shohizei' });
    if (browserWindow && typeof browserWindow.print === 'function') browserWindow.print();
  }
  function definitionList(items) {
    return el('dl', {}, items.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]));
  }
  function eligibilitySection(viewModel) {
    if (viewModel.eligibilityRows.length === 0) return null;
    return el('section', { className: 'shohizei-card' }, [el('h2', {}, '利用できる方式'),
      el('ul', {}, viewModel.eligibilityRows.map(row => el('li', {}, [
        el('span', { className: 'shohizei-status' }, `${row.symbol} ${row.methodName}`), `：${row.reason}`,
      ])))]);
  }
  function commonResultSections(viewModel) {
    return [
      el('section', {}, [el('h2', {}, '警告'), el('ul', {}, viewModel.warnings.map(warning =>
        el('li', {}, [el('span', { className: 'shohizei-level' }, `[${warning.level}] `),
          warning.basis || warning.code, warning.userAction ? ` 対応：${warning.userAction}` : ''])))]),
      el('details', {}, [el('summary', {}, '前提をすべて表示'),
        el('ul', {}, viewModel.assumptions.map(text => el('li', {}, text)))]),
      el('section', { className: 'shohizei-card' }, [el('h2', {}, '計算範囲・除外項目'),
        el('p', {}, `計算済み ${viewModel.calculationRange.calculatedCount} / 対象 ${viewModel.calculationRange.targetCount} 方式`),
        el('ul', {}, viewModel.excludedItems.map(item => el('li', {}, `${item.label}：${item.reason}`)))]),
      el('section', { className: 'shohizei-card' }, [el('h2', {}, '根拠'), definitionList([
        ['計算版', viewModel.grounds.calculationVersion], ['マスタースナップショットID', viewModel.grounds.masterSnapshotId],
        ['法令基準日', viewModel.grounds.legalStatusAsOf],
      ]), el('h3', {}, '出典'), el('ul', {}, viewModel.grounds.sources.map(source => el('li', {},
        source.url ? el('a', { href: source.url, rel: 'noreferrer' }, `${source.authority}：${source.title}`) : source.title)))]),
    ];
  }
  function resultActions() {
    return el('div', { className: 'shohizei-actions shohizei-no-print' }, [
      el('button', { type: 'button', onClick: () => goToStep(1) }, '入力を修正する'),
      el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
      el('button', { type: 'button', onClick: printResult }, '結果を印刷 / PDF保存'),
    ]);
  }
  function keyResultSection(keyResult) {
    if (!keyResult) return null;
    return el('section', { className: 'simulator-key-result', 'aria-label': keyResult.label }, [
      el('p', { className: 'simulator-key-result-label' }, [
        keyResult.label,
        el('span', { className: 'simulator-key-result-qualifier' }, `（${keyResult.qualifier}）`),
      ]),
      el('p', { className: 'simulator-key-result-value' }, [
        keyResult.value ? el('span', {}, keyResult.value) : null,
        keyResult.amount ? el('span', { className: 'simulator-key-result-amount' }, keyResult.display) : null,
      ]),
    ]);
  }
  function renderBlocked(viewModel) {
    return el('main', {}, [
      el('h1', { id: 'sz-result-heading', tabindex: '-1' }, viewModel.heading),
      eligibilitySection(viewModel),
      ...viewModel.alerts.map(alert => el('section', { className: 'shohizei-card', role: 'alert' }, [
        el('h2', {}, alert.heading), el('p', {}, alert.description),
        alert.resolutionType === 'consultation' ? el('p', { className: 'shohizei-placeholder' }, '個別相談（公開準備中）') : null,
      ])),
      viewModel.differenceFromGeneral ? el('p', {}, viewModel.differenceFromGeneral.reason) : null,
      ...commonResultSections(viewModel), resultActions(),
    ]);
  }
  function renderResult(viewModel) {
    return el('main', {}, [
      el('p', { className: 'shohizei-help' }, 'この印刷物は申告・届出に使用できません。利用後は「入力をクリア」を実行してください。'),
      el('h1', { id: 'sz-result-heading', tabindex: '-1' }, viewModel.heading),
      keyResultSection(viewModel.keyResult),
      viewModel.isExempt ? el('section', { className: 'shohizei-card shohizei-conclusion' }, [
        el('h2', {}, viewModel.exemptTitle), el('p', {}, viewModel.exemptNotice),
      ]) : [
        eligibilitySection(viewModel),
        el('section', { className: 'shohizei-card' }, [el('h2', {}, '納税額の比較'),
          el('div', { className: 'shohizei-table-wrap' }, el('table', {}, [
            el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, '方式'), el('th', { scope: 'col' }, '納税額')])),
            el('tbody', {}, viewModel.comparisonRows.map(row => el('tr', {}, [
              el('th', { scope: 'row' }, row.methodName), el('td', {}, row.display),
            ]))),
          ]))]),
        el('section', { className: 'shohizei-card shohizei-conclusion' }, [el('h2', {}, '結論'),
          viewModel.conclusion ? el('p', {}, viewModel.conclusion) : el('p', {}, '比較できる方式がありません。'),
          viewModel.differenceFromGeneral.available
            ? el('p', {}, `一般課税との差額：${viewModel.differenceFromGeneral.display}`)
            : el('p', {}, viewModel.differenceFromGeneral.reason),
          viewModel.simplifiedFilingGuidance ? el('p', {}, viewModel.simplifiedFilingNotice) : null,
        ]),
      ],
      ...commonResultSections(viewModel),
      el('p', { className: 'shohizei-print-page-number' }, `結果状態：${viewModel.resultStatus}`),
      resultActions(), el('p', { className: 'shohizei-placeholder shohizei-no-print' }, '個別相談（公開準備中・金額は送信しません）'),
    ]);
  }
  function render(previous) {
    if (destroyed) return;
    const state = store.getState();
    let content;
    if (state.screen === 'input') content = state.step === 1 ? renderStep1() : renderStep2();
    else if (state.screen === 'calculating') content = el('main', { className: 'shohizei-no-print' }, [
      el('h1', {}, '計算中'), el('p', {}, '税務マスターを使って試算しています。'),
      el('button', { type: 'button', disabled: true, 'aria-disabled': 'true' }, '計算中です'),
    ]);
    else if (state.screen === 'blocked') content = renderBlocked(state.viewModel);
    else content = renderResult(state.viewModel);
    rootElement.replaceChildren(el('style', { textContent: STYLE_TEXT }), content);
    const summary = rootElement.querySelector('.shohizei-error-summary');
    if (summary) summary.focus();
    pageView.afterRender(state, previous);
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.screen !== previous.screen || state.step !== previous.step || state.errors !== previous.errors ||
        state.result !== previous.result || state.viewModel !== previous.viewModel) render(previous);
  });
  const pageshowHandler = event => { if (event.persisted) resetState(); };
  if (browserWindow) browserWindow.addEventListener('pageshow', pageshowHandler);
  render();
  return Object.freeze({ store, destroy() {
    destroyed = true; unsubscribe();
    if (browserWindow) browserWindow.removeEventListener('pageshow', pageshowHandler);
    pageView.destroy();
    rootElement.classList.remove('shohizei-app'); rootElement.replaceChildren();
  } });
}

module.exports = Object.freeze({ mountShohizeiApp, INITIAL_FORM });
