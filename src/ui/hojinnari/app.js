'use strict';

const { el } = require('../dom.js');
const { createStore } = require('../store.js');
const { createMoneyInput, createSelect, createChoiceGroup, parseMoneyInput } = require('../forms.js');
const { announceStatus, announceAlert } = require('../a11y.js');
const { createSimulatorPageView } = require('../simulator-page-view.js');
const { queueEvent } = require('../analytics.js');
const { MUNICIPALITIES, buildCalculationContext } = require('./context-builder.js');
const { HojinnariInputBuildError, buildHojinnariInput } = require('./input-builder.js');
const { resolveQuestion } = require('./question-catalog.js');
const { buildResultViewModel, formatYen, formatSignedYen } = require('./result-view-model.js');
const { acceptYakuinHoshuHandoff } = require('../yakuin-hoshu/handoff.js');
const { DEPENDENT_BANDS, DISABILITY_FIELDS, dependentCount } = require('../family-input.js');

const TOTAL_STEPS = 3;
const CONDITIONAL_FORM_KEYS = new Set([
  'municipalityKey', 'nationalHealthInsuranceKind', 'nationalPensionKind',
  'locationSameAsResidence', 'spouseExists',
]);
const INITIAL_FORM = Object.freeze({
  incomeTaxYear: 2025,
  revenue: '',
  expenses: '',
  expensesConfirmed: false,
  blueReturn: '',
  businessTaxCategory: '',
  ageAtYearEnd: '',
  selfDisability: 'none',
  spouseExists: 'no',
  spouseTotalIncome: '',
  spouseAge70OrOver: false,
  spouseDisability: 'none',
  dependents16To18: '0',
  dependents19To22: '0',
  dependents23To69: '0',
  dependents70PlusCohabiting: '0',
  dependents70PlusSeparate: '0',
  dependentDisabilityGeneral: '0',
  dependentDisabilitySpecial: '0',
  dependentDisabilitySpecialCohabiting: '0',
  individualSmallEnterpriseMutualAid: '0',
  municipalityKey: '',
  otherPrefectureCode: '',
  otherMunicipalityCode: '',
  nationalHealthInsuranceKind: '',
  nationalHealthInsuranceActual: '',
  nationalPensionKind: '',
  nationalPensionActual: '',
  officerCompensationMonthly: '',
  corporateSmallEnterpriseMutualAid: '0',
  capital: '',
  locationSameAsResidence: '',
  corporateSameAsIndividual: true,
  corporateRevenue: '',
  corporateExpenses: '',
});

const FIELD_IDS = Object.freeze({
  '$.individual.business.revenue[0].value.value': 'hj-revenue',
  '$.individual.business.expenses[0].value.value': 'hj-expenses',
  '$.individual.business.expensesExcludeSocialInsuranceAndMutualAid': 'hj-expenses-confirmed',
  '$.individual.blueReturn': 'hj-blue-return',
  '$.individual.blueReturn.status': 'hj-blue-return',
  '$.individual.blueReturn.specialDeductionCategory': 'hj-blue-return',
  '$.individual.business.businessTaxCategory': 'hj-business-tax-category',
  '$.individual.self.ageAtYearEnd': 'hj-age',
  '$.individual.self.disability': 'hj-self-disability',
  '$.individual.spouse.totalIncome.value': 'hj-spouse-income',
  '$.individual.spouse.disability': 'hj-spouse-disability',
  '$.individual.dependents.dependents16To18': 'hj-dependents-16-18',
  '$.individual.dependents.dependents19To22': 'hj-dependents-19-22',
  '$.individual.dependents.dependents23To69': 'hj-dependents-23-69',
  '$.individual.dependents.dependents70PlusCohabiting': 'hj-dependents-70-cohabiting',
  '$.individual.dependents.dependents70PlusSeparate': 'hj-dependents-70-separate',
  '$.individual.dependents.dependentDisabilityGeneral': 'hj-disability-general',
  '$.individual.dependents.dependentDisabilitySpecial': 'hj-disability-special',
  '$.individual.dependents.dependentDisabilitySpecialCohabiting': 'hj-disability-cohabiting',
  '$.individual.deductions.smallEnterpriseMutualAid.value': 'hj-mutual-aid-current',
  '$.individual.nationalHealthInsurance': 'hj-nhi-kind',
  '$.individual.nationalHealthInsurance.annualAmount.value': 'hj-nhi-actual',
  '$.individual.nationalPension': 'hj-pension-kind',
  '$.individual.nationalPension.annualAmount.value': 'hj-pension-actual',
  '$.corporate.capital.value': 'hj-capital',
  '$.corporate.officerCompensation.monthlySegments[0].value.monthlyAmount.value': 'hj-officer-compensation',
  '$.corporate.deductions.smallEnterpriseMutualAid.value': 'hj-mutual-aid-corporate',
  '$.corporate.locationSameAsResidence': 'hj-location',
  '$.corporate.revenue[0].value.value': 'hj-corporate-revenue',
  '$.corporate.expenses[0].value.value': 'hj-corporate-expenses',
});

const STYLE_TEXT = `
.hojinnari-app{color:#22293a;max-width:1080px;margin:0 auto;padding:24px;font-family:"Noto Sans JP",sans-serif;line-height:1.7}
.hojinnari-app h1,.hojinnari-app h2,.hojinnari-app h3{color:#0B2045}
.hojinnari-card{background:#fff;border:1px solid #E3E8F0;border-radius:12px;padding:24px;margin:16px 0;box-shadow:var(--shadow-sm,0 2px 8px rgba(11,32,69,.08))}
.hojinnari-conclusion{background:#FDF0EA;border-left:6px solid #E85320}
.hojinnari-verdict-summary{margin:16px 0 24px;border:1px solid #E3E8F0;border-radius:12px;background:#fff;overflow:hidden;box-shadow:var(--shadow-sm,0 2px 8px rgba(11,32,69,.08))}
.hojinnari-verdict-banner{margin:0;padding:18px 24px;background:#0B2045;color:#fff;font-size:clamp(1.35rem,3vw,1.75rem);font-weight:700;text-align:center}
.hojinnari-verdict-emphasis{color:#E85320}.hojinnari-benefit{display:flex;justify-content:center;align-items:baseline;gap:12px;margin:0;padding:16px 24px;font-weight:700}
.hojinnari-benefit-amount{font-size:1.35rem}.hojinnari-amount-positive{color:#C64312;font-weight:700}.hojinnari-amount-negative{color:#9b1c1c;font-weight:700}
.hojinnari-verdict-table-wrap{margin:0 24px}.hojinnari-summary-table{min-width:780px}.hojinnari-app .hojinnari-summary-table thead th{background:#0B2045;color:#fff;text-align:center}
.hojinnari-app .hojinnari-summary-table th:first-child,.hojinnari-app .hojinnari-summary-table td:first-child{text-align:left}.hojinnari-app .hojinnari-summary-table th:last-child,.hojinnari-app .hojinnari-summary-table td:last-child{text-align:left}
.hojinnari-summary-total th,.hojinnari-summary-total td{background:#FDF0EA;font-weight:700}.hojinnari-verdict-note{margin:0;padding:14px 24px 18px;color:#55607a;font-size:.9rem}
.hojinnari-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
.hojinnari-app button{min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid #0B2045;background:#fff;color:#0B2045;font:inherit}
.hojinnari-app button.hojinnari-primary{background:#E85320;border-color:#E85320;color:#fff}
.hojinnari-app input,.hojinnari-app select{display:block;box-sizing:border-box;width:100%;max-width:34rem;min-height:44px;margin:6px 0 16px;padding:8px;border:1px solid #55607a;border-radius:8px;font:inherit}
.hojinnari-app input[type=checkbox],.hojinnari-app input[type=radio]{display:inline-block;width:auto;min-height:auto;margin-right:8px}
.hojinnari-app fieldset{border:1px solid #E3E8F0;border-radius:8px;margin:16px 0;padding:12px}.hojinnari-app legend{font-weight:700}
.hojinnari-progress{font-weight:700}.hojinnari-help{color:#55607a}.hojinnari-error{color:#9b1c1c;font-weight:700}.hojinnari-error-summary{border:2px solid #9b1c1c;padding:16px;margin:16px 0}
.hojinnari-table-wrap{overflow-x:auto}.hojinnari-app table{border-collapse:collapse;width:100%;min-width:620px}.hojinnari-app th,.hojinnari-app td{border:1px solid #E3E8F0;padding:10px;text-align:right}.hojinnari-app th:first-child,.hojinnari-app td:first-child{text-align:left}.hojinnari-app thead th:nth-child(2){background:#F5F7FA}.hojinnari-app thead th:nth-child(3){background:#FDF0EA}
.hojinnari-level{font-weight:700}.hojinnari-placeholder{border:1px dashed #55607a;padding:12px;color:#55607a}.simulator-live-region{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:480px){.hojinnari-app{padding:12px}.hojinnari-card{padding:16px}.hojinnari-actions{display:block}.hojinnari-actions button{width:100%;margin:5px 0}.hojinnari-benefit{display:block;padding:14px 16px}.hojinnari-benefit-amount{display:block}.hojinnari-verdict-table-wrap{margin:0}.hojinnari-verdict-note{padding:12px 16px 16px}}
@media print{.hojinnari-no-print{display:none!important}.hojinnari-app{max-width:none;padding:0}.hojinnari-print{display:block;color:#000}.hojinnari-card,.hojinnari-verdict-summary{box-shadow:none;break-inside:avoid}.hojinnari-verdict-table-wrap{overflow:visible;margin:0}.hojinnari-summary-table{min-width:0;font-size:9pt}.hojinnari-verdict-banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}.hojinnari-summary-total th,.hojinnari-summary-total td{-webkit-print-color-adjust:exact;print-color-adjust:exact}.hojinnari-print-page-number::after{content:" / ページ " counter(page)}@page{margin:15mm}}
`;

function cloneInitialForm() {
  return { ...INITIAL_FORM };
}

function mountHojinnariApp(rootElement, {
  services, snapshotInfo, now, handoff, handoffExpectedContext,
  scrollToAppTop, focusHeading, introElement,
} = {}) {
  if (!rootElement || typeof rootElement.replaceChildren !== 'function') {
    throw new TypeError('マウント先のDOM要素が必要です');
  }
  const service = services && services.hojinnari ? services.hojinnari : services;
  if (!service || typeof service.validate !== 'function' || typeof service.simulate !== 'function') {
    throw new TypeError('hojinnariサービスが必要です');
  }
  const nowProvider = typeof now === 'function' ? now : () => new Date().toISOString();
  const browserWindow = rootElement.ownerDocument && rootElement.ownerDocument.defaultView;
  let initialForm = cloneInitialForm();
  let handoffNotice = null;
  let initialStep = 1;
  if (handoff !== undefined) {
    const received = acceptYakuinHoshuHandoff(handoff, initialForm, handoffExpectedContext);
    initialForm = { ...received.formState };
    handoffNotice = Object.freeze({ accepted: received.accepted, message: received.message });
    if (received.accepted) {
      initialStep = 3;
    }
  }
  const store = createStore({
    screen: 'input', step: initialStep, form: initialForm, errors: [], result: null,
    viewModel: null, handoffNotice, sourceHandoff: handoffNotice && handoffNotice.accepted ? handoff : null,
  });
  let destroyed = false;

  rootElement.classList.add('hojinnari-app');
  const pageView = createSimulatorPageView(rootElement, {
    isFirstView: state => state.screen === 'input' && state.step === 1,
    scrollToAppTop, focusHeading, introElement,
  });
  rootElement.appendChild(el('style', { textContent: STYLE_TEXT }));
  queueEvent('simulator_view', { tool: 'hojinnari' });
  queueEvent('simulator_start', { tool: 'hojinnari' });

  function updateForm(key, value) {
    store.setState(state => ({ ...state, form: { ...state.form, [key]: value } }));
  }

  function setErrors(errors) {
    store.setState(state => ({ ...state, errors }));
  }

  function errorFor(path) {
    return store.getState().errors.find(item => item.fieldPath === path);
  }

  function addControlError(control, path) {
    const found = errorFor(path);
    if (!found) return null;
    const id = `${control.id || FIELD_IDS[path] || 'hj-field'}-error`;
    control.setAttribute('aria-invalid', 'true');
    const describedBy = [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' ');
    control.setAttribute('aria-describedby', describedBy);
    return el('p', { id, className: 'hojinnari-error' }, found.message);
  }

  function errorSummary() {
    const errors = store.getState().errors;
    if (errors.length === 0) return null;
    const summary = el('div', { className: 'hojinnari-error-summary', tabindex: '-1' }, [
      el('h2', {}, '入力内容を確認してください'),
      el('ul', {}, errors.map(item => {
        const target = FIELD_IDS[item.fieldPath];
        return el('li', {}, target
          ? el('a', { href: `#${target}` }, item.message)
          : item.message);
      })),
    ]);
    return summary;
  }

  function moneyField(key, id, label, description, path) {
    const field = createMoneyInput({
      id, label, description, value: store.getState().form[key],
    });
    field.input.addEventListener('input', () => {
      const parsed = field.read();
      updateForm(key, parsed.ok ? parsed.value : field.input.value);
    });
    return [field.element, addControlError(field.input, path)];
  }

  function selectField(key, id, label, description, options, path) {
    const field = createSelect({
      id, label, description, options, value: store.getState().form[key],
      onChange: value => {
        updateForm(key, value);
        if (CONDITIONAL_FORM_KEYS.has(key)) render();
      },
    });
    return [field.element, addControlError(field.select, path)];
  }

  function familyFields() {
    const form = store.getState().form;
    const spouse = [
      ...selectField('spouseExists', 'hj-spouse-exists', '配偶者はいますか', '', [
        { value: 'no', label: 'いいえ' },
        { value: 'yes', label: 'はい' },
      ], '$.individual.spouse'),
    ];
    if (form.spouseExists === 'yes') {
      spouse.push(
        ...moneyField('spouseTotalIncome', 'hj-spouse-income', '配偶者の合計所得金額',
          '収入が給与だけなら、年収から55万円を引いた金額が目安です。収入がなければ0円',
          '$.individual.spouse.totalIncome.value'),
        el('div', {}, [
          el('input', {
            id: 'hj-spouse-elderly', type: 'checkbox', checked: form.spouseAge70OrOver,
            onChange: event => updateForm('spouseAge70OrOver', event.currentTarget.checked),
          }),
          el('label', { for: 'hj-spouse-elderly' }, '70歳以上'),
        ]),
        ...selectField('spouseDisability', 'hj-spouse-disability', '配偶者の障害者区分', '', [
          { value: 'none', label: '対象外' },
          { value: 'general', label: '一般障害者' },
          { value: 'special', label: '特別障害者' },
          { value: 'special_cohabiting', label: '特別障害者（同居）' },
        ], '$.individual.spouse.disability')
      );
    }
    const dependentInputs = DEPENDENT_BANDS.map(band => {
      const idSuffix = {
        dependents16To18: '16-18',
        dependents19To22: '19-22',
        dependents23To69: '23-69',
        dependents70PlusCohabiting: '70-cohabiting',
        dependents70PlusSeparate: '70-separate',
      }[band.key];
      const path = `$.individual.dependents.${band.key}`;
      const input = el('input', {
        id: `hj-dependents-${idSuffix}`, type: 'number', min: '0', step: '1', inputmode: 'numeric',
        value: form[band.key],
        onInput: event => updateForm(band.key, event.currentTarget.value),
      });
      return el('div', {}, [
        el('label', { for: input.id }, band.label),
        input,
        addControlError(input, path),
      ]);
    });
    const disabilityInputs = DISABILITY_FIELDS.map((field, index) => {
      const ids = ['general', 'special', 'cohabiting'];
      const path = `$.individual.dependents.${field.key}`;
      const input = el('input', {
        id: `hj-disability-${ids[index]}`, type: 'number', min: '0', step: '1',
        inputmode: 'numeric', value: form[field.key],
        onInput: event => updateForm(field.key, event.currentTarget.value),
      });
      return el('div', {}, [
        el('label', { for: input.id }, `${field.label}（人）`), input,
        addControlError(input, path),
      ]);
    });
    return [
      el('fieldset', {}, [el('legend', {}, '配偶者'), spouse]),
      el('fieldset', {}, [
        el('legend', {}, '扶養親族の人数'),
        dependentInputs,
        el('p', { className: 'hojinnari-help' },
          '16歳未満のお子さまは扶養控除の対象外のため入力不要です'),
        el('h3', {}, 'うち障害のある方'),
        disabilityInputs,
        el('p', { className: 'hojinnari-help' },
          '16歳未満の扶養親族に係る障害者控除は第1弾の対象外です'),
      ]),
    ];
  }

  function pageActions({ previous, next, calculate } = {}) {
    return el('div', { className: 'hojinnari-actions hojinnari-no-print' }, [
      previous ? el('button', { type: 'button', onClick: () => goToStep(store.getState().step - 1) }, '戻る') : null,
      next ? el('button', { type: 'button', className: 'hojinnari-primary', onClick: nextStep }, '次へ') : null,
      calculate ? el('button', { type: 'button', className: 'hojinnari-primary', onClick: calculateNow }, '計算する') : null,
      el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
    ]);
  }

  function stepHeader(step, title) {
    return [
      el('p', {
        className: 'hojinnari-progress',
        role: 'status',
        'aria-label': `3ステップ中${step}番目`,
      }, `STEP ${step} / ${TOTAL_STEPS}`),
      el('h1', {}, title),
    ];
  }

  function renderStep1() {
    const form = store.getState().form;
    const checkbox = el('input', {
      id: 'hj-expenses-confirmed', type: 'checkbox', checked: form.expensesConfirmed,
      onChange: event => updateForm('expensesConfirmed', event.currentTarget.checked),
    });
    const checkError = addControlError(checkbox,
      '$.individual.business.expensesExcludeSocialInsuranceAndMutualAid');
    return el('main', { className: 'hojinnari-no-print' }, [
      ...stepHeader(1, '事業の状況'), errorSummary(),
      el('p', { className: 'hojinnari-help' },
        '入力と計算はこのブラウザ内で完結し、金額を保存・解析送信しません。'),
      store.getState().handoffNotice && !store.getState().handoffNotice.accepted
        ? el('p', { className: 'hojinnari-error', role: 'alert' }, store.getState().handoffNotice.message)
        : null,
      el('p', {}, '計算対象年：2025年（令和7年分）'),
      ...moneyField('revenue', 'hj-revenue', '年間売上高（円）',
        '0円以上の整数。全角数字・万単位も入力できます。',
        '$.individual.business.revenue[0].value.value'),
      ...moneyField('expenses', 'hj-expenses', '年間経費（円）',
        '役員報酬を除いた事業経費。0円以上の整数で入力してください。' +
        'ご家族に専従者給与を支払っていて、その方が法人化後に役員になる予定の場合は、その専従者給与も除いてください。',
        '$.individual.business.expenses[0].value.value'),
      el('div', {}, [checkbox, el('label', { for: checkbox.id },
        '経費に国民健康保険料・国民年金・小規模企業共済等の掛金を含めていません'), checkError]),
      ...selectField('blueReturn', 'hj-blue-return', '青色申告', '', [
        { value: '', label: '選択してください' },
        { value: 'e_tax_650k', label: '65万円控除（e-Tax）' },
        { value: 'bookkeeping_550k', label: '55万円控除' },
        { value: 'simple_100k', label: '10万円控除' },
        { value: 'none', label: '青色だが控除なし' },
        { value: 'white', label: '白色申告' },
        { value: 'unknown', label: 'わからない' },
      ], '$.individual.blueReturn'),
      ...selectField('businessTaxCategory', 'hj-business-tax-category', '事業の種類',
        '個人事業税の業種区分です。都道府県の納税通知書でも確認できます。', [
          { value: '', label: '選択してください' },
          { value: 'type1', label: '物品販売（ネット販売・輸出を含む）・製造・飲食・請負・不動産貸付など【第1種・5%】' },
          { value: 'type2', label: '畜産・水産など【第2種・4%】' },
          { value: 'type3_standard', label: '医療・士業・コンサルタント・デザインなどの自由業【第3種・5%】' },
          { value: 'type3_reduced', label: 'あん摩・マッサージ・はり・きゅう・柔道整復など【第3種・3%】' },
          { value: 'not_listed', label: '上のどれにもあてはまらない（文筆業・画家・音楽家など → 個人事業税なし）' },
          { value: 'unknown', label: 'わからない' },
        ], '$.individual.business.businessTaxCategory'),
      pageActions({ next: true }),
    ]);
  }

  function renderStep2() {
    const form = store.getState().form;
    const age = el('input', {
      id: 'hj-age', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: form.ageAtYearEnd,
      onInput: event => updateForm('ageAtYearEnd', event.currentTarget.value),
      'aria-describedby': 'hj-age-description',
    });
    return el('main', { className: 'hojinnari-no-print' }, [
      ...stepHeader(2, 'あなたの状況'), errorSummary(),
      el('label', { for: age.id }, '年末時点の年齢'),
      el('p', { id: 'hj-age-description' }, '介護保険（40〜64歳）・厚生年金の判定に使います。'), age,
      addControlError(age, '$.individual.self.ageAtYearEnd'),
      ...selectField('selfDisability', 'hj-self-disability', '本人の障害者区分', '', [
        { value: 'none', label: '対象外' },
        { value: 'general', label: '一般障害者' },
        { value: 'special', label: '特別障害者' },
      ], '$.individual.self.disability'),
      ...familyFields(),
      ...moneyField('individualSmallEnterpriseMutualAid', 'hj-mutual-aid-current',
        '小規模企業共済・iDeCoの掛金（年額・現在）',
        '掛金がなければ0円。税負担の軽減効果だけに反映します。',
        '$.individual.deductions.smallEnterpriseMutualAid.value'),
      ...selectField('municipalityKey', 'hj-municipality', 'お住まいの市区町村',
        '国民健康保険料を概算できる登録自治体です。', [
          { value: '', label: '選択してください' },
          ...MUNICIPALITIES.map(item => ({ value: item.key, label: item.label })),
          { value: 'other', label: 'その他' },
        ], '$.calculationContext.jurisdiction'),
      form.municipalityKey === 'other' ? el('div', { className: 'hojinnari-card' }, [
        el('p', {}, 'その他の自治体は国保実額に加え、計算用の団体コードが必要です。'),
        el('label', { for: 'hj-other-prefecture' }, '都道府県コード（2桁）'),
        el('input', { id: 'hj-other-prefecture', value: form.otherPrefectureCode, inputmode: 'numeric',
          onInput: event => updateForm('otherPrefectureCode', event.currentTarget.value) }),
        el('label', { for: 'hj-other-municipality' }, '市区町村コード（5桁）'),
        el('input', { id: 'hj-other-municipality', value: form.otherMunicipalityCode, inputmode: 'numeric',
          onInput: event => updateForm('otherMunicipalityCode', event.currentTarget.value) }),
      ]) : null,
      ...selectField('nationalHealthInsuranceKind', 'hj-nhi-kind', '国民健康保険料', '', [
        { value: '', label: '選択してください' },
        { value: 'actual', label: '実額を入力する' },
        { value: 'estimate', label: '選んだ自治体の料率で概算する' },
      ], '$.individual.nationalHealthInsurance'),
      form.nationalHealthInsuranceKind === 'estimate'
        ? el('p', { className: 'hojinnari-help' }, '自治体の登録年度料率による概算です。') : null,
      form.nationalHealthInsuranceKind === 'actual'
        ? moneyField('nationalHealthInsuranceActual', 'hj-nhi-actual', '国保の年間実額（円）',
          '0円以上の整数。', '$.individual.nationalHealthInsurance.annualAmount.value') : null,
      ...selectField('nationalPensionKind', 'hj-pension-kind', '国民年金', '', [
        { value: '', label: '選択してください' },
        { value: 'standard', label: '通常どおり納付（12か月）' },
        { value: 'actual', label: '実額を入力する' },
        { value: 'exempted', label: '免除を受けている' },
      ], '$.individual.nationalPension'),
      form.nationalPensionKind === 'actual'
        ? moneyField('nationalPensionActual', 'hj-pension-actual', '国民年金の年間実額（円）',
          '0円以上の整数。', '$.individual.nationalPension.annualAmount.value') : null,
      el('p', { className: 'hojinnari-help' },
        '生命保険料控除・地震保険料控除・寄附金控除・住宅ローン控除などは対応準備中です'),
      pageActions({ previous: true, next: true }),
    ]);
  }

  function renderStep3() {
    const form = store.getState().form;
    const sameChoice = createChoiceGroup({
      id: 'hj-corporate-same', label: '法人側の売上・経費',
      options: [{ value: 'same', label: '個人事業と同じ' }, { value: 'different', label: '変更する' }],
      value: form.corporateSameAsIndividual ? 'same' : 'different',
      onChange: value => {
        updateForm('corporateSameAsIndividual', value === 'same');
        render();
      },
    });
    return el('main', { className: 'hojinnari-no-print' }, [
      ...stepHeader(3, '法人化の想定'), errorSummary(),
      store.getState().handoffNotice ? el('p', {
        className: store.getState().handoffNotice.accepted ? 'hojinnari-card' : 'hojinnari-error',
        role: store.getState().handoffNotice.accepted ? 'status' : 'alert',
      }, store.getState().handoffNotice.message) : null,
      store.getState().handoffNotice && store.getState().handoffNotice.accepted
        ? el('p', { className: 'hojinnari-help' },
          '引き継いだ値はメモリ内だけに保持され、リロードすると消えます。') : null,
      ...moneyField('officerCompensationMonthly', 'hj-officer-compensation', '役員報酬（月額・円）',
        '12か月同額として0円以上の整数で入力します。',
        '$.corporate.officerCompensation.monthlySegments[0].value.monthlyAmount.value'),
      ...moneyField('corporateSmallEnterpriseMutualAid', 'hj-mutual-aid-corporate',
        '法人化後の掛金予定（年額）',
        'iDeCoは会社役員になると上限が月23,000円（年276,000円）に変わります。小規模企業共済は小規模法人の役員であれば継続できます',
        '$.corporate.deductions.smallEnterpriseMutualAid.value'),
      el('p', { className: 'hojinnari-placeholder' }, '役員報酬の最適化シミュレーター（公開準備中）'),
      ...moneyField('capital', 'hj-capital', '資本金（円）',
        '1,000万円以上は消費税・住民税均等割に影響します。', '$.corporate.capital.value'),
      ...selectField('locationSameAsResidence', 'hj-location', '法人の所在地', '', [
        { value: '', label: '選択してください' },
        { value: 'yes', label: '自宅住所と同じ' }, { value: 'no', label: '違う・未定' },
      ], '$.corporate.locationSameAsResidence'),
      form.locationSameAsResidence === 'no'
        ? el('p', { className: 'hojinnari-help' }, '所在地固有の税率を除外するため、結果はpartial（一部概算）になります。') : null,
      sameChoice.element,
      !form.corporateSameAsIndividual ? [
        ...moneyField('corporateRevenue', 'hj-corporate-revenue', '法人側の年間売上（円）',
          '事業年度は1/1〜12/31です。', '$.corporate.revenue[0].value.value'),
        ...moneyField('corporateExpenses', 'hj-corporate-expenses', '法人側の年間経費（円）',
          '事業年度は1/1〜12/31です。', '$.corporate.expenses[0].value.value'),
      ] : el('p', {}, '法人側の売上・経費は個人事業と同じ。事業年度は1/1〜12/31です。'),
      el('p', { className: 'hojinnari-help' }, '従業員数は0人（役員のみ）。従業員を雇っている場合は対応準備中です。'),
      el('p', { className: 'hojinnari-help' }, '健康保険は選択した都道府県の協会けんぽを使います。消費税は比較対象外です。'),
      pageActions({ previous: true, calculate: true }),
    ]);
  }

  function localError(fieldPath, message, code = 'HJ_UI_INPUT_REQUIRED') {
    return { code, fieldPath, message };
  }

  function validateStep(step) {
    const form = store.getState().form;
    const errors = [];
    const requireMoney = (value, path, label) => {
      if (!parseMoneyInput(String(value)).ok) errors.push(localError(path, `${label}を円単位で入力してください`));
    };
    if (step === 1) {
      requireMoney(form.revenue, '$.individual.business.revenue[0].value.value', '年間売上高');
      requireMoney(form.expenses, '$.individual.business.expenses[0].value.value', '年間経費');
      if (!form.expensesConfirmed) errors.push(localError(
        '$.individual.business.expensesExcludeSocialInsuranceAndMutualAid',
        '経費に社会保険料等を含めていないことの確認が必要です',
        'HJ_EXPENSES_EXCLUSION_CONFIRMATION_REQUIRED'));
      if (!form.blueReturn || form.blueReturn === 'unknown') errors.push(localError('$.individual.blueReturn', resolveQuestion('HJ_BLUE_RETURN_STATUS_UNKNOWN').description));
      if (!form.businessTaxCategory || form.businessTaxCategory === 'unknown') errors.push(localError('$.individual.business.businessTaxCategory', resolveQuestion('HJ_BUSINESS_TAX_CATEGORY_UNKNOWN').description));
    } else if (step === 2) {
      if (!/^\d+$/.test(String(form.ageAtYearEnd))) errors.push(localError('$.individual.self.ageAtYearEnd', '年齢を整数で入力してください'));
      if (form.spouseExists === 'yes') requireMoney(form.spouseTotalIncome,
        '$.individual.spouse.totalIncome.value', '配偶者の合計所得金額');
      for (const band of DEPENDENT_BANDS) {
        if (dependentCount(form[band.key]) === null) errors.push(localError(
          `$.individual.dependents.${band.key}`, `${band.label}の人数を0以上の整数で入力してください`));
      }
      for (const field of DISABILITY_FIELDS) {
        if (dependentCount(form[field.key]) === null) errors.push(localError(
          `$.individual.dependents.${field.key}`,
          `うち${field.label}の人数を0以上の整数で入力してください`));
      }
      requireMoney(form.individualSmallEnterpriseMutualAid,
        '$.individual.deductions.smallEnterpriseMutualAid.value',
        '小規模企業共済・iDeCoの掛金（年額・現在）');
      if (!form.municipalityKey) errors.push(localError('$.calculationContext.jurisdiction', 'お住まいの市区町村を選択してください'));
      if (form.municipalityKey === 'other' &&
          (!/^\d{2}$/.test(form.otherPrefectureCode) || !/^\d{5}$/.test(form.otherMunicipalityCode))) {
        errors.push(localError('$.calculationContext.jurisdiction',
          'その他の自治体は都道府県コード2桁と市区町村コード5桁を入力してください'));
      }
      if (!form.nationalHealthInsuranceKind) errors.push(localError('$.individual.nationalHealthInsurance', '国民健康保険料の入力方法を選択してください'));
      if (form.municipalityKey === 'other' && form.nationalHealthInsuranceKind !== 'actual') errors.push(localError(
        '$.individual.nationalHealthInsurance', resolveQuestion('HJ_UI_NHI_ACTUAL_REQUIRED_FOR_OTHER_MUNICIPALITY').description,
        'HJ_UI_NHI_ACTUAL_REQUIRED_FOR_OTHER_MUNICIPALITY'));
      if (form.nationalHealthInsuranceKind === 'actual') requireMoney(form.nationalHealthInsuranceActual,
        '$.individual.nationalHealthInsurance.annualAmount.value', '国保の年間実額');
      if (!form.nationalPensionKind) errors.push(localError('$.individual.nationalPension', '国民年金の納付状況を選択してください'));
      if (form.nationalPensionKind === 'actual') requireMoney(form.nationalPensionActual,
        '$.individual.nationalPension.annualAmount.value', '国民年金の年間実額');
    } else {
      requireMoney(form.officerCompensationMonthly,
        '$.corporate.officerCompensation.monthlySegments[0].value.monthlyAmount.value', '役員報酬');
      requireMoney(form.corporateSmallEnterpriseMutualAid,
        '$.corporate.deductions.smallEnterpriseMutualAid.value', '法人化後の掛金予定');
      requireMoney(form.capital, '$.corporate.capital.value', '資本金');
      if (!form.locationSameAsResidence) errors.push(localError('$.corporate.locationSameAsResidence', '法人の所在地を選択してください'));
      if (!form.corporateSameAsIndividual) {
        requireMoney(form.corporateRevenue, '$.corporate.revenue[0].value.value', '法人側の年間売上');
        requireMoney(form.corporateExpenses, '$.corporate.expenses[0].value.value', '法人側の年間経費');
      }
    }
    setErrors(errors);
    if (errors.length > 0) announceAlert('入力内容に確認が必要な項目があります');
    return errors.length === 0;
  }

  function goToStep(step) {
    if (step < 1 || step > TOTAL_STEPS) return;
    store.setState(state => ({ ...state, screen: 'input', step, errors: [] }));
  }

  function nextStep() {
    const step = store.getState().step;
    if (validateStep(step)) goToStep(step + 1);
  }

  function validationErrors(validation) {
    return (validation.errors || []).map(item => ({
      code: item.code || 'HJ_SERVICE_VALIDATION_ERROR',
      fieldPath: item.fieldPath,
      message: item.message || '入力内容を確認してください',
    }));
  }

  async function calculateNow() {
    if (!validateStep(3)) return;
    store.setState(state => ({ ...state, screen: 'calculating', errors: [], result: null, viewModel: null }));
    await announceStatus('計算中です');
    let context;
    let wire;
    try {
      context = buildCalculationContext(store.getState().form, snapshotInfo, nowProvider());
      wire = buildHojinnariInput(store.getState().form, context);
    } catch (error) {
      const errors = error instanceof HojinnariInputBuildError
        ? [...error.errors]
        : [localError('$.calculationContext.jurisdiction', error.message)];
      store.setState(state => ({ ...state, screen: 'input', step: Math.min(state.step, 3), errors }));
      await announceAlert('入力内容に確認が必要な項目があります');
      return;
    }
    const validation = service.validate(wire);
    if (!validation.ok) {
      store.setState(state => ({ ...state, screen: 'input', step: 3, errors: validationErrors(validation) }));
      await announceAlert('入力内容に確認が必要な項目があります');
      return;
    }
    try {
      const simulated = await service.simulate(validation.value, context, snapshotInfo);
      const sourceHandoff = store.getState().sourceHandoff;
      // §13-1: partialの送信元を受けた結果をcompleteへ格上げしない。
      const result = sourceHandoff && sourceHandoff.sourceResultStatus === 'partial' &&
          simulated.resultStatus === 'complete'
        ? Object.freeze({
          ...simulated,
          resultStatus: 'partial',
          warnings: Object.freeze([...(sourceHandoff.warnings || []), ...(simulated.warnings || [])]),
          excludedItems: Object.freeze([
            ...(sourceHandoff.excludedItems || []), ...(simulated.excludedItems || []),
          ]),
        })
        : simulated;
      const viewModel = buildResultViewModel(result);
      store.setState(state => ({ ...state, screen: result.resultStatus === 'blocked' ? 'blocked' : 'result', result, viewModel }));
      queueEvent('simulator_complete', { tool: 'hojinnari', resultStatus: result.resultStatus });
      if (result.resultStatus === 'blocked') await announceAlert('条件を確認できないため計算を停止しました');
    } catch (_error) {
      store.setState(state => ({ ...state, screen: 'input', step: 3, errors: [localError(
        '$.calculationContext', '計算を完了できませんでした。入力内容とマスターの検証状態をご確認ください')]}));
      await announceAlert('計算を完了できませんでした');
    }
  }

  function clearAll() {
    const accepted = !browserWindow || typeof browserWindow.confirm !== 'function' ||
      browserWindow.confirm('入力と試算結果をすべてクリアしますか？');
    if (!accepted) return;
    resetState();
  }

  function resetState() {
    store.setState({ screen: 'input', step: 1, form: cloneInitialForm(), errors: [], result: null,
      viewModel: null, handoffNotice: null, sourceHandoff: null });
  }

  function printResult() {
    queueEvent('simulator_cta_click', { tool: 'hojinnari' });
    if (browserWindow && typeof browserWindow.print === 'function') browserWindow.print();
  }

  function definitionList(items) {
    return el('dl', {}, items.flatMap(([term, description]) => [el('dt', {}, term), el('dd', {}, description)]));
  }

  function renderBlocked(viewModel) {
    return el('main', {}, [
      el('h1', { id: 'hj-result-heading', tabindex: '-1' }, viewModel.heading),
      ...viewModel.alerts.map(alert => el('section', { className: 'hojinnari-card' }, [
        el('h2', {}, alert.heading), el('p', {}, alert.description),
        alert.resolutionType === 'consultation'
          ? el('p', { className: 'hojinnari-placeholder' }, '個別相談（公開準備中）') : null,
        alert.fieldPath && FIELD_IDS[alert.fieldPath]
          ? el('button', { type: 'button', onClick: () => goToStep(alert.fieldPath.includes('business') || alert.fieldPath.includes('blueReturn') ? 1 : 2) }, '該当の入力を修正') : null,
      ])),
      pageActions({ previous: true }),
    ]);
  }

  function renderResult(viewModel) {
    const range = viewModel.calculationRange;
    const summary = viewModel.verdictSummary;
    return el('main', {}, [
      el('div', { className: 'hojinnari-print' }, [
        el('p', { className: 'hojinnari-help' }, 'この印刷物は申告・届出に使用できません。クラウド印刷等の利用時はブラウザ内完結の対象外です。利用後は「入力をクリア」を実行してください。'),
        el('h1', { id: 'hj-result-heading', tabindex: '-1' }, viewModel.heading),
        el('section', { className: 'hojinnari-verdict-summary', 'aria-label': '判定サマリー' }, [
          el('p', { className: 'hojinnari-verdict-banner' }, [
            el('span', { className: 'hojinnari-verdict-emphasis' }, summary.verdict.emphasisText),
            summary.verdict.suffixText,
          ]),
          el('p', { className: 'hojinnari-benefit' }, [
            el('span', {}, summary.benefit.label),
            el('span', {
              className: `hojinnari-benefit-amount hojinnari-amount-${summary.benefit.direction}`,
            }, summary.benefit.display),
          ]),
          el('div', { className: 'hojinnari-table-wrap hojinnari-verdict-table-wrap' }, el('table', { className: 'hojinnari-summary-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', { scope: 'col' }, '項目'),
              el('th', { scope: 'col' }, '①個人事業'),
              el('th', { scope: 'col' }, '②法人成り'),
              el('th', { scope: 'col' }, '①−②差引'),
              el('th', { scope: 'col' }, 'コメント'),
            ])),
            el('tbody', {}, summary.rows.map(row => el('tr', {
              className: row.isTotal ? 'hojinnari-summary-total' : undefined,
            }, [
              el('th', { scope: 'row' }, row.label),
              el('td', {}, row.soleProprietor.display),
              el('td', {}, row.corporation.display),
              el('td', { className: `hojinnari-amount-${row.difference.direction}` }, row.difference.display),
              el('td', {}, row.comment),
            ]))),
          ])),
          el('p', { className: 'hojinnari-verdict-note' }, summary.note),
        ]),
        viewModel.isPartial ? el('p', { className: 'hojinnari-error' }, viewModel.partialNotice) : null,
        el('section', { className: 'hojinnari-card hojinnari-conclusion' }, [
          el('h2', {}, '結論'), el('p', {}, viewModel.conclusion.text),
          el('p', {}, `正確な参考差額：${formatSignedYen({ unit: 'JPY', value: viewModel.conclusion.exactAmount })}`),
          definitionList([
            ['個人事業の手取り', formatYen(viewModel.pairedFigures.solePersonalDisposableCash)],
            ['法人化後に個人が使える資金', formatYen(viewModel.pairedFigures.corporationPersonalDisposableCash)],
            ['法人に残る資金', formatYen(viewModel.pairedFigures.corporateRetainedCash)],
            ['税・社会保険の合計負担（個人事業 / 法人化）',
              `${formatYen(viewModel.pairedFigures.taxAndInsuranceBurden.soleProprietor)} / ${formatYen(viewModel.pairedFigures.taxAndInsuranceBurden.corporation)}`],
          ]),
          el('p', {}, viewModel.corporateRetainedWarning),
          viewModel.setupAndMaintenanceCostsNotice ? el('p', {}, viewModel.setupAndMaintenanceCostsNotice) : null,
        ]),
        el('section', {}, [el('h2', {}, '比較表'), el('div', { className: 'hojinnari-table-wrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, '項目'), el('th', { scope: 'col' }, '個人事業'), el('th', { scope: 'col' }, '法人化')])),
          el('tbody', {}, viewModel.comparisonRows.map(row => el('tr', {}, [
            el('th', { scope: 'row' }, [row.label, row.note ? el('small', {}, `（${row.note}）`) : null]),
            el('td', {}, row.soleProprietor.display), el('td', {}, row.corporation.display),
          ]))),
        ]))]),
        el('details', { className: 'hojinnari-card' }, [
          el('summary', {}, '結果の詳細'),
          el('h2', {}, '所得控除の内訳'),
          el('div', { className: 'hojinnari-table-wrap' }, el('table', {}, [
            el('thead', {}, el('tr', {}, [
              el('th', { scope: 'col' }, '所得控除'),
              el('th', { scope: 'col' }, '個人事業'),
              el('th', { scope: 'col' }, '法人化'),
            ])),
            el('tbody', {}, viewModel.incomeDeductionRows.map(row => el('tr', {}, [
              el('th', { scope: 'row' }, row.label),
              el('td', {}, row.soleProprietor.display),
              el('td', {}, row.corporation.display),
            ]))),
          ])),
        ]),
        el('section', { className: 'hojinnari-card' }, [
          el('h2', {}, '消費税・除外項目'), el('p', {}, viewModel.consumptionTaxBadge),
          el('ul', {}, viewModel.excludedItems.map(item => el('li', {}, `${item.label}：${item.reason}`))),
        ]),
        el('section', { className: 'hojinnari-card' }, [
          el('h2', {}, '計算範囲'), el('p', {}, `計算済み ${range.calculatedCount} / 対象 ${range.targetCount} 項目`),
          definitionList([
            ['直接入力', range.directInput.map(item => item.label).join('、') || 'なし'],
            ['制度既定値', range.defaults.map(item => item.label).join('、') || 'なし'],
            ['概算', range.estimates.map(item => item.label).join('、') || 'なし'],
            ['除外', range.excluded.map(item => item.label).join('、') || 'なし'],
          ]),
        ]),
        el('section', {}, [el('h2', {}, '警告'), el('ul', {}, viewModel.warnings.map(warning =>
          el('li', {}, [el('span', { className: 'hojinnari-level' }, `[${warning.level}] `), warning.basis || warning.code,
            warning.userAction ? ` 対応：${warning.userAction}` : ''])))]),
        el('details', {}, [el('summary', {}, '前提をすべて表示'), el('ul', {}, viewModel.assumptions.map(text => el('li', {}, text)))]),
        el('section', { className: 'hojinnari-card' }, [el('h2', {}, '根拠'), definitionList([
          ['計算版', viewModel.grounds.calculationVersion], ['マスタースナップショットID', viewModel.grounds.masterSnapshotId],
          ['法令基準日', viewModel.grounds.legalStatusAsOf],
        ]), el('h3', {}, '出典'), el('ul', {}, viewModel.grounds.sources.map(source =>
          el('li', {}, source.url ? el('a', { href: source.url, rel: 'noreferrer' }, `${source.authority}：${source.title}`) : source.title)))]),
        el('p', { className: 'hojinnari-print-page-number' }, `結果状態：${viewModel.resultStatusLabel}`),
      ]),
      el('div', { className: 'hojinnari-actions hojinnari-no-print' }, [
        el('button', { type: 'button', onClick: () => goToStep(1) }, '入力を修正する'),
        el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
        el('button', { type: 'button', onClick: printResult }, '結果を印刷 / PDF保存'),
      ]),
      el('p', { className: 'hojinnari-placeholder hojinnari-no-print' }, '役員報酬の最適化（公開準備中）'),
      el('p', { className: 'hojinnari-placeholder hojinnari-no-print' }, '個別相談（公開準備中・金額は送信しません）'),
    ]);
  }

  function render(previous) {
    if (destroyed) return;
    const state = store.getState();
    let content;
    if (state.screen === 'input') content = state.step === 1 ? renderStep1() : state.step === 2 ? renderStep2() : renderStep3();
    else if (state.screen === 'calculating') content = el('main', { className: 'hojinnari-no-print' }, [
      el('h1', {}, '計算中'), el('p', {}, '税務マスターを使って試算しています。'),
      el('button', { type: 'button', disabled: true, 'aria-disabled': 'true' }, '計算中です'),
    ]);
    else if (state.screen === 'blocked') content = renderBlocked(state.viewModel);
    else content = renderResult(state.viewModel);
    rootElement.replaceChildren(el('style', { textContent: STYLE_TEXT }), content);
    const summary = rootElement.querySelector('.hojinnari-error-summary');
    if (summary) summary.focus();
    pageView.afterRender(state, previous);
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.screen !== previous.screen || state.step !== previous.step ||
        state.errors !== previous.errors || state.result !== previous.result ||
        state.viewModel !== previous.viewModel) render(previous);
  });
  const pageshowHandler = event => { if (event.persisted) resetState(); };
  if (browserWindow) browserWindow.addEventListener('pageshow', pageshowHandler);
  render();

  return Object.freeze({
    store,
    destroy() {
      destroyed = true;
      unsubscribe();
      if (browserWindow) browserWindow.removeEventListener('pageshow', pageshowHandler);
      pageView.destroy();
      rootElement.classList.remove('hojinnari-app');
      rootElement.replaceChildren();
    },
  });
}

module.exports = Object.freeze({ mountHojinnariApp, INITIAL_FORM });
