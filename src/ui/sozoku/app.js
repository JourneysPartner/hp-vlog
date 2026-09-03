'use strict';

const { el } = require('../dom.js');
const { createStore } = require('../store.js');
const { createMoneyInput, createSelect } = require('../forms.js');
const { announceStatus, announceAlert } = require('../a11y.js');
const { createSimulatorPageView } = require('../simulator-page-view.js');
const { queueEvent } = require('../analytics.js');
const {
  SozokuInputBuildError,
  buildSozokuInputWithMeta,
  buildSozokuCalculationContext,
} = require('./input-builder.js');
const { buildSozokuResultViewModel, formatYen } = require('./result-view-model.js');

const TOTAL_STEPS = 3;
const YES_NO = Object.freeze([
  { value: '', label: '選択してください' },
  { value: 'yes', label: 'はい' },
  { value: 'no', label: 'いいえ' },
]);
const TRI_STATE = Object.freeze([
  ...YES_NO,
  { value: 'unknown', label: 'わからない' },
]);
const INITIAL_FORM = Object.freeze({
  level: 1,
  hasSpouse: '',
  childCount: '0',
  adoptedChildCount: '0',
  parentCount: '0',
  siblingCount: '0',
  deceasedDescendant: '',
  renunciation: '',
  specialOrStepchildAdoption: '',
  overseasResident: '',
  cash: '',
  securities: '',
  businessAssets: '',
  otherAssets: '',
  realEstate: Object.freeze([]),
  lifeInsurance: Object.freeze([]),
  retirementAllowance: Object.freeze([]),
  debts: Object.freeze([]),
  hasGiftAddback: '',
  giftAddback: Object.freeze([]),
  hasSettlementTaxationGifts: '',
  divisionMode: 'statutory',
  divisionStatus: 'yes',
  dividedAfterFilingDeadline: 'no',
  divisionShares: Object.freeze({}),
  smallResidentialLand: null,
  spouseOwnAssets: '',
  secondaryHeirCount: '',
  secondaryHeirRelation: 'child',
  yearsUntilSecondary: '',
  annualLivingCost: '',
  annualAssetChangeRate: '0',
});

const STATIC_FIELD_IDS = Object.freeze({
  '$.hasSpouse': 'so-spouse',
  '$.childCount': 'so-child-count',
  '$.adoptedChildCount': 'so-adopted-count',
  '$.parentCount': 'so-parent-count',
  '$.siblingCount': 'so-sibling-count',
  '$.heirSpecialistChecks': 'so-deceased-check',
  '$.assets.cash.value': 'so-cash',
  '$.assets.securities.value': 'so-securities',
  '$.assets.businessAssets.value': 'so-business-assets',
  '$.assets.otherAssets.value': 'so-other-assets',
  '$.assets.giftAddback': 'so-gift-addback',
  '$.assets.settlementTaxationGifts': 'so-settlement-gifts',
  '$.division': 'so-division-mode',
  '$.division.acquisitions': 'so-division-shares',
  '$.smallResidentialLand[0].areaSqm': 'so-small-land-area',
  '$.secondaryInheritance.spouseOwnAssets.value': 'so-secondary-own-assets',
  '$.secondaryInheritance.expectedHeirs': 'so-secondary-heir-count',
  '$.secondaryInheritance.yearsUntilSecondary': 'so-secondary-years',
  '$.secondaryInheritance.annualLivingCost.value': 'so-secondary-living-cost',
  '$.secondaryInheritance.annualAssetChangeRate': 'so-secondary-rate',
});

const STYLE_TEXT = `
.sozoku-app{color:#22293a;max-width:1080px;margin:0 auto;padding:24px;font-family:"Noto Sans JP",sans-serif;line-height:1.7}.sozoku-app h1,.sozoku-app h2,.sozoku-app h3{color:#0B2045}.sozoku-card{background:#fff;border:1px solid #E3E8F0;border-radius:12px;padding:24px;margin:16px 0;box-shadow:var(--shadow-sm,0 2px 8px rgba(11,32,69,.08))}.sozoku-conclusion{background:#FDF0EA;border-left:6px solid #E85320}.sozoku-warning{border:2px solid #9b1c1c;padding:16px}.sozoku-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.sozoku-app button{min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid #0B2045;background:#fff;color:#0B2045;font:inherit}.sozoku-app button.sozoku-primary{background:#E85320;border-color:#E85320;color:#fff}.sozoku-app input,.sozoku-app select{display:block;box-sizing:border-box;width:100%;max-width:38rem;min-height:44px;margin:6px 0 16px;padding:8px;border:1px solid #55607a;border-radius:8px;font:inherit}.sozoku-app input[type=radio]{display:inline-block;width:auto;min-height:auto;margin-right:8px}.sozoku-progress{font-weight:700}.sozoku-help{color:#55607a}.sozoku-error{color:#9b1c1c;font-weight:700}.sozoku-error-summary{border:2px solid #9b1c1c;padding:16px;margin:16px 0}.sozoku-row{border:1px solid #E3E8F0;border-radius:8px;padding:16px;margin:12px 0}.sozoku-table-wrap{overflow-x:auto}.sozoku-app table{border-collapse:collapse;width:100%;min-width:680px}.sozoku-app th,.sozoku-app td{border:1px solid #E3E8F0;padding:10px;text-align:left}.sozoku-app td{text-align:right}.sozoku-level{font-weight:700}.sozoku-placeholder{border:1px dashed #55607a;padding:12px;color:#55607a}.sozoku-secondary-minimum{background:#FDF0EA;font-weight:700}.sozoku-minimum-label{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#E85320;color:#fff;font-size:.85em}.sozoku-tax-bar{height:12px;min-width:120px;background:#E3E8F0;border-radius:999px;overflow:hidden}.sozoku-tax-bar-fill{display:block;height:100%;background:#0B6E75;border-radius:999px}.simulator-live-region{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}@media(max-width:480px){.sozoku-app{padding:12px}.sozoku-card{padding:16px}.sozoku-actions{display:block}.sozoku-actions button{width:100%;margin:5px 0}.sozoku-app table{min-width:0}.sozoku-app thead{position:absolute;width:1px;height:1px;overflow:hidden}.sozoku-app tr,.sozoku-app td,.sozoku-app th{display:block;text-align:left}}@media print{.sozoku-no-print{display:none!important}.sozoku-app{max-width:none;padding:0}.sozoku-card{box-shadow:none;break-inside:avoid}.sozoku-tax-bar-fill,.sozoku-secondary-minimum,.sozoku-minimum-label{-webkit-print-color-adjust:exact;print-color-adjust:exact}.sozoku-print-page-number::after{content:" / ページ " counter(page)}@page{margin:15mm}}
`;

function cloneInitialForm() {
  return { ...INITIAL_FORM, realEstate: [], lifeInsurance: [], retirementAllowance: [], debts: [],
    giftAddback: [], divisionShares: {} };
}

function mountSozokuApp(rootElement, {
  services, snapshotInfo, now, scrollToAppTop, focusHeading, introElement,
} = {}) {
  if (!rootElement || typeof rootElement.replaceChildren !== 'function') {
    throw new TypeError('マウント先のDOM要素が必要です');
  }
  const service = services && services.sozoku ? services.sozoku : services;
  if (!service || typeof service.validate !== 'function' || typeof service.simulate !== 'function') {
    throw new TypeError('sozokuサービスが必要です');
  }
  const nowProvider = typeof now === 'function' ? now : () => new Date().toISOString();
  const browserWindow = rootElement.ownerDocument && rootElement.ownerDocument.defaultView;
  const store = createStore({ screen: 'input', step: 1, form: cloneInitialForm(), errors: [], result: null,
    viewModel: null, buildMeta: null });
  let nextRowId = 1;
  let destroyed = false;
  rootElement.classList.add('sozoku-app');
  const pageView = createSimulatorPageView(rootElement, {
    isFirstView: state => state.screen === 'input' && state.step === 1,
    scrollToAppTop, focusHeading, introElement,
  });
  queueEvent('simulator_view', { tool: 'sozoku' });
  queueEvent('simulator_start', { tool: 'sozoku' });

  function updateForm(key, value, rerender = false) {
    store.setState(state => ({ ...state, form: { ...state.form, [key]: value } }));
    if (rerender) render();
  }
  function dynamicFieldId(path) {
    const match = /^\$\.assets\.realEstate\[(\d+)\](.*)$/.exec(path);
    if (match) return `so-real-estate-${match[1]}${match[2].includes('area') ? '-area' :
      match[2].includes('roadside') ? '-roadside' : '-value'}`;
    const debt = /^\$\.debts\[(\d+)\](.*)$/.exec(path);
    if (debt) return `so-debt-${debt[1]}${debt[2].includes('bearer') ? '-bearer' : '-amount'}`;
    const benefit = /^\$\.assets\.(lifeInsurance|retirementAllowance)\[(\d+)\](.*)$/.exec(path);
    if (benefit) return `so-${benefit[1]}-${benefit[2]}${benefit[3].includes('beneficiary') ? '-beneficiary' : '-amount'}`;
    const gift = /^\$\.assets\.giftAddback\[(\d+)\](.*)$/.exec(path);
    if (gift) return `so-gift-${gift[1]}${gift[2].includes('giftedOn') ? '-date' :
      gift[2].includes('recipient') ? '-recipient' : gift[2].includes('giftTaxPaid') ? '-tax' : '-amount'}`;
    const division = /^\$\.division\.acquisitions\[(\d+)\]/.exec(path);
    return division ? `so-division-${division[1]}` : STATIC_FIELD_IDS[path];
  }
  function errorFor(path) { return store.getState().errors.find(item => item.fieldPath === path); }
  function addControlError(control, path) {
    const found = errorFor(path);
    if (!found) return null;
    const id = `${control.id || dynamicFieldId(path) || 'so-field'}-error`;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    return el('p', { id, className: 'sozoku-error' }, found.message);
  }
  function errorSummary() {
    const errors = store.getState().errors;
    if (errors.length === 0) return null;
    return el('div', { className: 'sozoku-error-summary', tabindex: '-1' }, [
      el('h2', {}, '入力内容を確認してください'),
      el('ul', {}, errors.map(item => {
        const id = dynamicFieldId(item.fieldPath);
        return el('li', {}, id ? el('a', { href: `#${id}` }, item.message) : item.message);
      })),
    ]);
  }
  function selectField(key, id, label, description, options, path, rerender = false) {
    const field = createSelect({ id, label, description, options, value: store.getState().form[key],
      onChange: value => updateForm(key, value, rerender) });
    return [field.element, addControlError(field.select, path)];
  }
  function moneyField(key, id, label, path, description = '0円以上の整数。全角数字・万単位も入力できます。') {
    const field = createMoneyInput({ id, label, description, value: store.getState().form[key] });
    field.input.addEventListener('input', () => {
      const parsed = field.read();
      updateForm(key, parsed.ok ? parsed.value : field.input.value);
    });
    return [field.element, addControlError(field.input, path)];
  }
  function nestedMoney(rowKey, index, property, id, label, path, description) {
    const row = store.getState().form[rowKey][index];
    const field = createMoneyInput({ id, label, description: description || '0円以上の整数。', value: row[property] });
    field.input.addEventListener('input', () => {
      const parsed = field.read();
      updateRow(rowKey, index, property, parsed.ok ? parsed.value : field.input.value);
    });
    return [field.element, addControlError(field.input, path)];
  }
  function nestedSelect(rowKey, index, property, id, label, options, path, rerender = false, description = '') {
    const row = store.getState().form[rowKey][index];
    const field = createSelect({ id, label, description, options, value: row[property], onChange: value => {
      updateRow(rowKey, index, property, value);
      if (rerender) render();
    } });
    return [field.element, addControlError(field.select, path)];
  }
  function updateRow(key, index, property, value) {
    const rows = store.getState().form[key].map((row, rowIndex) => rowIndex === index ? { ...row, [property]: value } : row);
    updateForm(key, rows);
  }
  function addRow(key, row) {
    updateForm(key, [...store.getState().form[key], { uiId: nextRowId++, ...row }], true);
  }
  function removeRow(key, index, addButtonId, removePrefix) {
    const rows = store.getState().form[key].filter((_, rowIndex) => rowIndex !== index);
    updateForm(key, rows, true);
    const focusId = index > 0 ? `${removePrefix}-${index - 1}-remove` : addButtonId;
    setTimeout(() => { const target = rootElement.querySelector(`#${focusId}`); if (target) target.focus(); }, 0);
  }
  function stepHeader(step, title) {
    return [el('p', { className: 'sozoku-progress', role: 'status', 'aria-label': `${TOTAL_STEPS}ステップ中${step}番目` },
      `STEP ${step} / ${TOTAL_STEPS}`), el('h1', {}, title)];
  }
  function actionBar(nodes) { return el('div', { className: 'sozoku-actions sozoku-no-print' }, nodes); }
  function countInput(key, id, label, path) {
    const input = el('input', { id, type: 'text', inputmode: 'numeric', value: store.getState().form[key],
      onInput: event => updateForm(key, event.currentTarget.value, true) });
    return [el('label', { for: id }, label), input, addControlError(input, path)];
  }

  function renderStep1() {
    const form = store.getState().form;
    const totalChildren = Number(form.childCount || 0) + Number(form.adoptedChildCount || 0);
    return el('main', { className: 'sozoku-no-print' }, [
      ...stepHeader(1, '相続人'), errorSummary(),
      el('p', { className: 'sozoku-help' },
        '入力と計算はこのブラウザ内で完結し、金額を保存・解析送信しません。'),
      ...selectField('hasSpouse', 'so-spouse', '配偶者はいますか', '', YES_NO, '$.hasSpouse'),
      ...countInput('childCount', 'so-child-count', 'お子さまの人数（実子）', '$.childCount'),
      ...countInput('adoptedChildCount', 'so-adopted-count', '養子の人数', '$.adoptedChildCount'),
      totalChildren === 0 ? countInput('parentCount', 'so-parent-count', 'ご両親・祖父母でご存命の方の人数', '$.parentCount') : null,
      totalChildren === 0 && Number(form.parentCount || 0) === 0
        ? countInput('siblingCount', 'so-sibling-count', '兄弟姉妹の人数', '$.siblingCount') : null,
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '該当の確認'),
        el('p', { className: 'sozoku-help' }, '「はい」または「わからない」の場合は、専門判定をご案内します。'),
        ...selectField('deceasedDescendant', 'so-deceased-check', '子や兄弟姉妹で亡くなっている方がいる（代襲）', '', TRI_STATE, '$.heirSpecialistChecks'),
        ...selectField('renunciation', 'so-renunciation-check', '相続放棄をした・する予定の方がいる', '', TRI_STATE, '$.heirSpecialistChecks'),
        ...selectField('specialOrStepchildAdoption', 'so-adoption-check', '特別養子・配偶者の連れ子養子がいる', '', TRI_STATE, '$.heirSpecialistChecks'),
        ...selectField('overseasResident', 'so-overseas-check', '海外在住の方がいる', '', TRI_STATE, '$.heirSpecialistChecks'),
      ]),
      el('p', { className: 'sozoku-help' }, '未成年または障害のある相続人がいる場合、実際の税額はこの試算より少なくなることがあります。'),
      actionBar([el('button', { type: 'button', className: 'sozoku-primary', onClick: () => goToStep(2) }, '次へ'),
        el('button', { type: 'button', onClick: clearAll }, '入力をクリア')]),
    ]);
  }

  function renderRealEstateRows() {
    const rows = store.getState().form.realEstate;
    return [rows.map((row, index) => {
      const path = `$.assets.realEstate[${index}]`;
      return el('section', { className: 'sozoku-row' }, [
        el('h3', {}, `不動産 ${index + 1}`),
        ...nestedSelect('realEstate', index, 'category', `so-real-estate-${index}-category`, '種類', [
          { value: 'land', label: '土地' }, { value: 'building', label: '建物' },
        ], `${path}.category`, true),
        ...nestedSelect('realEstate', index, 'appraisalKnown', `so-real-estate-${index}-known`, '相続税評価額が分かりますか', YES_NO, `${path}.kind`, true),
        row.appraisalKnown === 'yes'
          ? nestedMoney('realEstate', index, 'appraisedValue', `so-real-estate-${index}-value`, '相続税評価（円）', `${path}.value.value`)
          : row.category === 'land' ? [
            nestedMoney('realEstate', index, 'roadsideValuePerSqm', `so-real-estate-${index}-roadside`, '路線価（1㎡あたり・円）', `${path}.roadsideValuePerSqm.value`),
            el('label', { for: `so-real-estate-${index}-area` }, '面積（㎡、小数第1位まで）'),
            el('input', { id: `so-real-estate-${index}-area`, type: 'text', inputmode: 'decimal', value: row.areaSqm,
              onInput: event => updateRow('realEstate', index, 'areaSqm', event.currentTarget.value) }),
            el('p', { className: 'sozoku-warning' }, '実際の相続税評価額とは異なる場合があります。'),
          ] : nestedMoney('realEstate', index, 'fixedAssetTaxValue', `so-real-estate-${index}-value`, '固定資産税評価額（円）', `${path}.fixedAssetTaxValue.value`),
        el('button', { id: `so-real-estate-${index}-remove`, type: 'button', onClick: () =>
          removeRow('realEstate', index, 'so-real-estate-add', 'so-real-estate') }, 'この不動産を削除'),
      ]);
    }), rows.length < 4 ? el('button', { id: 'so-real-estate-add', type: 'button', onClick: () =>
      addRow('realEstate', { category: 'land', appraisalKnown: 'yes', appraisedValue: '', roadsideValuePerSqm: '', areaSqm: '', fixedAssetTaxValue: '' }) }, '不動産を追加') : null];
  }

  function heirOptions(includeNonHeir = false) {
    let heirs = [];
    try { heirs = buildSozokuInputWithMeta({ ...store.getState().form, level: 1, cash: '0', securities: '0',
      businessAssets: '0', otherAssets: '0', realEstate: [], lifeInsurance: [], retirementAllowance: [], debts: [],
      hasGiftAddback: 'no', hasSettlementTaxationGifts: 'no', divisionMode: 'statutory',
      divisionStatus: 'yes', dividedAfterFilingDeadline: 'no', smallResidentialLand: null }).wire.heirs; }
    catch (_error) { /* STEP1エラーは送信時に表示 */ }
    const labels = heirs.map((item, index) => ({ value: item.id, label: item.relation === 'spouse' ? '配偶者' :
      item.relation === 'child' ? `お子さま${index}` : item.relation === 'adopted_child' ? `養子${index}` : `相続人${index + 1}` }));
    return [{ value: '', label: '選択してください' }, ...labels,
      ...(includeNonHeir ? [{ value: 'non_heir', label: '相続人以外' }] : [])];
  }
  function renderBenefitRows(key, title, addId) {
    const rows = store.getState().form[key];
    return el('section', { className: 'sozoku-card' }, [el('h2', {}, title),
      el('p', { className: 'sozoku-help' }, '相続人が受け取る分には非課税枠（500万円×法定相続人の数）があります。'),
      rows.map((row, index) => el('div', { className: 'sozoku-row' }, [
        ...nestedSelect(key, index, 'beneficiaryHeirId', `so-${key}-${index}-beneficiary`, '受取人', heirOptions(true), `$.assets.${key}[${index}].beneficiaryHeirId`),
        ...nestedMoney(key, index, 'amount', `so-${key}-${index}-amount`, '金額（円）', `$.assets.${key}[${index}].amount.value`),
        el('button', { id: `so-${key}-${index}-remove`, type: 'button', onClick: () => removeRow(key, index, addId, `so-${key}`) }, 'この行を削除'),
      ])),
      el('button', { id: addId, type: 'button', onClick: () => addRow(key, { beneficiaryHeirId: '', amount: '' }) }, `${title}を追加`),
    ]);
  }
  function renderDebtRows() {
    const rows = store.getState().form.debts;
    return el('section', { className: 'sozoku-card' }, [el('h2', {}, '債務・葬式費用'),
      rows.map((row, index) => el('div', { className: 'sozoku-row' }, [
        ...nestedSelect('debts', index, 'kind', `so-debt-${index}-kind`, '種類', [
          { value: 'loan', label: '借入金' }, { value: 'unpaid', label: '未払金' },
          { value: 'funeral', label: '葬式費用' }, { value: 'other', label: 'その他' },
        ], `$.debts[${index}].kind`),
        ...nestedMoney('debts', index, 'amount', `so-debt-${index}-amount`, '金額（円）', `$.debts[${index}].amount.value`),
        ...nestedSelect('debts', index, 'bearerHeirId', `so-debt-${index}-bearer`, '負担する人', heirOptions(), `$.debts[${index}].bearerHeirId`),
        el('button', { id: `so-debt-${index}-remove`, type: 'button', onClick: () => removeRow('debts', index, 'so-debt-add', 'so-debt') }, 'この行を削除'),
      ])),
      el('button', { id: 'so-debt-add', type: 'button', onClick: () => addRow('debts', { kind: 'loan', amount: '', bearerHeirId: '' }) }, '債務・葬式費用を追加'),
    ]);
  }

  function renderGiftRows() {
    const rows = store.getState().form.giftAddback;
    return el('div', { id: 'so-gift-rows' }, [
      rows.map((row, index) => {
        const path = `$.assets.giftAddback[${index}]`;
        const dateInput = el('input', {
          id: `so-gift-${index}-date`, type: 'date', value: row.giftedOn || '',
          onInput: event => updateRow('giftAddback', index, 'giftedOn', event.currentTarget.value),
        });
        return el('section', { className: 'sozoku-row' }, [
          el('h3', {}, `生前贈与 ${index + 1}`),
          el('label', { for: `so-gift-${index}-date` }, '贈与日'), dateInput,
          addControlError(dateInput, `${path}.giftedOn`),
          ...nestedSelect('giftAddback', index, 'recipientHeirId', `so-gift-${index}-recipient`,
            '受贈者', heirOptions(), `${path}.recipientHeirId`),
          ...nestedMoney('giftAddback', index, 'amount', `so-gift-${index}-amount`,
            '贈与時の価額（円）', `${path}.amount.value`),
          ...nestedMoney('giftAddback', index, 'giftTaxPaid', `so-gift-${index}-tax`,
            '納付した贈与税額（任意・円）', `${path}.giftTaxPaid.value`, '空欄にできます。'),
          el('button', { id: `so-gift-${index}-remove`, type: 'button', onClick: () =>
            removeRow('giftAddback', index, 'so-gift-add', 'so-gift') }, 'この贈与を削除'),
        ]);
      }),
      el('button', { id: 'so-gift-add', type: 'button', onClick: () => addRow('giftAddback', {
        giftedOn: '', recipientHeirId: '', amount: '', giftTaxPaid: '',
      }) }, '生前贈与を追加'),
    ]);
  }

  function renderStep2() {
    return el('main', { className: 'sozoku-no-print' }, [
      ...stepHeader(2, '財産と債務'), errorSummary(),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '財産'),
        moneyField('cash', 'so-cash', '現預金（円）', '$.assets.cash.value'),
        moneyField('securities', 'so-securities', '有価証券（円）', '$.assets.securities.value'),
        moneyField('businessAssets', 'so-business-assets', '事業用資産（円）', '$.assets.businessAssets.value'),
        moneyField('otherAssets', 'so-other-assets', 'その他財産（円）', '$.assets.otherAssets.value'),
      ]),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '不動産（最大4件）'), renderRealEstateRows()]),
      renderBenefitRows('lifeInsurance', '死亡保険金', 'so-lifeInsurance-add'),
      renderBenefitRows('retirementAllowance', '死亡退職金', 'so-retirementAllowance-add'),
      renderDebtRows(),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '贈与の確認'),
        ...selectField('hasGiftAddback', 'so-gift-addback',
          '相続人が受けた生前贈与はありますか（相続開始前7年以内）', '', TRI_STATE,
          '$.assets.giftAddback', true),
        el('p', { className: 'sozoku-help' },
          '受贈者は相続人から選択してください。相続や遺贈で財産を取得しない人への贈与は含めません。贈与税の配偶者控除を受けた居住用財産の贈与分は金額に含めないでください。相続時精算課税を選んだ贈与は下の別の質問で回答してください。'),
        store.getState().form.hasGiftAddback === 'yes' ? renderGiftRows() : null,
        ...selectField('hasSettlementTaxationGifts', 'so-settlement-gifts',
          '相続時精算課税の適用財産がありますか', '', TRI_STATE,
          '$.assets.settlementTaxationGifts'),
      ]),
      actionBar([el('button', { type: 'button', onClick: () => goToStep(1) }, '戻る'),
        el('button', { type: 'button', className: 'sozoku-primary', onClick: () => calculate(1) }, '申告要否を診断'),
        el('button', { type: 'button', onClick: clearAll }, '入力をクリア')]),
    ]);
  }

  function renderStep3() {
    const form = store.getState().form;
    let heirs = [];
    try { heirs = buildSozokuInputWithMeta({ ...form, level: 2, divisionMode: 'statutory', smallResidentialLand: null }).wire.heirs; }
    catch (_error) { /* 計算時に表示 */ }
    const directLands = form.realEstate.map((row, index) => ({ row, index })).filter(item =>
      item.row.category === 'land' && item.row.appraisalKnown === 'yes');
    const small = form.smallResidentialLand || {};
    const setSmall = (key, value) => updateForm('smallResidentialLand', { ...small, [key]: value }, true);
    return el('main', { className: 'sozoku-no-print' }, [
      ...stepHeader(3, '分割と特例'), errorSummary(),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '財産の分割'),
        ...selectField('divisionMode', 'so-division-mode', '計算に使う取得割合', '', [
          { value: 'statutory', label: '法定相続分で計算（仮）' },
          { value: 'specified', label: '割合を指定' },
        ], '$.division', true),
        form.divisionMode === 'statutory' ? el('p', { className: 'sozoku-help' }, '分割未確定のため法定相続分で仮計算します。') :
          el('div', { id: 'so-division-shares' }, heirs.map((heir, index) => {
            const id = `so-division-${index}`;
            const input = el('input', { id, type: 'text', inputmode: 'numeric', value: form.divisionShares[heir.id] ?? '',
              onInput: event => updateForm('divisionShares', { ...store.getState().form.divisionShares, [heir.id]: event.currentTarget.value }) });
            return el('div', {}, [el('label', { for: id }, `${heir.relation === 'spouse' ? '配偶者' : `相続人${index + 1}`}の取得割合（%）`),
              input, addControlError(input, `$.division.acquisitions[${index}].share`)]);
          })),
        ...selectField('divisionStatus', 'so-division-status', '申告期限までに分割済みの見込みですか', '', TRI_STATE, '$.division.isDivided'),
        ...selectField('dividedAfterFilingDeadline', 'so-late-division', '分割は申告期限後になる見込みですか', '', TRI_STATE, '$.division.dividedAfterFilingDeadline'),
        form.divisionStatus !== 'yes' || form.dividedAfterFilingDeadline !== 'no'
          ? el('p', { className: 'sozoku-warning' }, '未分割または申告期限後の分割では、配偶者の税額軽減を使わず計算します。') : null,
      ]),
      directLands.length > 0 ? el('section', { className: 'sozoku-card' }, [el('h2', {}, '小規模宅地等（特定居住用）'),
        createSelect({ id: 'so-small-land-use', label: '特例の可能性を試算しますか', options: YES_NO,
          value: small.apply || 'no', onChange: value => setSmall('apply', value) }).element,
        small.apply === 'yes' ? [
          createSelect({ id: 'so-small-land-index', label: '対象の土地', options: [{ value: '', label: '選択してください' },
            ...directLands.map(item => ({ value: String(item.index), label: `土地 ${item.index + 1}` }))], value: small.realEstateIndex,
            onChange: value => setSmall('realEstateIndex', value) }).element,
          el('label', { for: 'so-small-land-area' }, '対象土地の面積（㎡、小数第1位まで）'),
          el('input', { id: 'so-small-land-area', type: 'text', inputmode: 'decimal', value: small.areaSqm || '',
            onInput: event => updateForm('smallResidentialLand', { ...store.getState().form.smallResidentialLand, areaSqm: event.currentTarget.value }) }),
          createSelect({ id: 'so-small-land-acquirer', label: '取得する人', options: heirOptions(), value: small.acquirerHeirId,
            onChange: value => setSmall('acquirerHeirId', value) }).element,
          createSelect({ id: 'so-small-land-relation', label: '取得者の要件', options: [
            { value: '', label: '選択してください' }, { value: 'spouse', label: '配偶者' },
            { value: 'cohabiting_relative', label: '同居の親族' }, { value: 'other', label: 'その他' },
          ], value: small.acquirerRelation, onChange: value => setSmall('acquirerRelation', value) }).element,
          small.acquirerRelation === 'cohabiting_relative' ? [
            createSelect({ id: 'so-small-land-reside', label: '取得者は居住を継続する見込みですか', options: TRI_STATE,
              value: small.acquirerResidesAndOwns, onChange: value => setSmall('acquirerResidesAndOwns', value) }).element,
            createSelect({ id: 'so-small-land-hold', label: '申告期限まで保有する見込みですか', options: TRI_STATE,
              value: small.willHoldUntilFilingDeadline, onChange: value => setSmall('willHoldUntilFilingDeadline', value) }).element,
          ] : null,
          small.acquirerRelation === 'other' ? el('p', { className: 'sozoku-help' }, '要件が揃わないため特例を適用せず計算し、適用できる可能性を注記します。') : null,
        ] : null,
      ]) : null,
      actionBar([el('button', { type: 'button', onClick: () => goToStep(2) }, '戻る'),
        el('button', { type: 'button', className: 'sozoku-primary', onClick: () => calculate(2) }, '税額まで計算'),
        el('button', { type: 'button', onClick: clearAll }, '入力をクリア')]),
    ]);
  }

  function validationErrors(validation) {
    return (validation.errors || []).map(item => ({ code: item.code || 'SOZOKU_SERVICE_VALIDATION_ERROR',
      fieldPath: item.fieldPath, message: item.message || '入力内容を確認してください' }));
  }
  function setBuildErrors(error, fallbackStep) {
    const errors = error instanceof SozokuInputBuildError ? [...error.errors] : [{
      code: 'SOZOKU_UI_BUILD_ERROR', fieldPath: '$', message: error.message,
    }];
    store.setState(state => ({ ...state, screen: 'input', step: fallbackStep, errors }));
    announceAlert('入力内容に確認が必要な項目があります');
  }
  function goToStep(step) { store.setState(state => ({ ...state, screen: 'input', step, errors: [] })); }
  async function calculate(level) {
    let built; let context;
    try {
      const form = { ...store.getState().form, level };
      built = buildSozokuInputWithMeta(form);
      context = buildSozokuCalculationContext(snapshotInfo, nowProvider());
    } catch (error) { setBuildErrors(error, level === 1 ? 2 : 3); return; }
    const validation = service.validate(built.wire);
    if (!validation.ok) {
      store.setState(state => ({ ...state, errors: validationErrors(validation) }));
      await announceAlert('入力内容に確認が必要な項目があります'); return;
    }
    store.setState(state => ({ ...state, screen: 'calculating', errors: [], result: null, viewModel: null, buildMeta: built }));
    await announceStatus(level === 1 ? '申告要否を判定しています' : '相続税を計算しています');
    try {
      const result = await service.simulate(validation.value, context, snapshotInfo);
      showResult(result, built);
    } catch (error) { setBuildErrors(error, level === 1 ? 2 : 3); }
  }
  function showResult(result, built) {
    const small = store.getState().form.smallResidentialLand;
    const viewModel = buildSozokuResultViewModel(result, {
      smallResidentialLandPossibility: built.smallResidentialLandPossibility,
      smallResidentialLandArea: small && small.areaSqm ? `${small.areaSqm}㎡` : undefined,
    });
    store.setState(state => ({ ...state, screen: result.resultStatus === 'blocked' ? 'blocked' : 'result', result, viewModel }));
    queueEvent('simulator_complete', { tool: 'sozoku', resultStatus: result.resultStatus });
    if (result.resultStatus === 'blocked') announceAlert('条件を確認できないため計算を停止しました');
  }
  function continueToLevel2() {
    const screeningIndex = store.getState().form.realEstate.findIndex(row => row.appraisalKnown !== 'yes');
    if (screeningIndex >= 0) {
      store.setState(state => ({ ...state, screen: 'input', step: 2, errors: [issue(
        'SOZOKU_LEVEL2_DIRECT_APPRAISAL_REQUIRED', `$.assets.realEstate[${screeningIndex}]`,
        '税額まで計算するには、この不動産の相続税評価額を直接入力してください')]}));
      announceAlert('不動産の直接評価額が必要です');
      setTimeout(() => { const field = rootElement.querySelector(`#so-real-estate-${screeningIndex}-known`); if (field) field.focus(); }, 0);
      return;
    }
    queueEvent('simulator_mode', { tool: 'sozoku', mode: 'level2' });
    goToStep(3);
  }
  function resetState() { store.setState({ screen: 'input', step: 1, form: cloneInitialForm(), errors: [], result: null, viewModel: null, buildMeta: null }); }
  function clearAll() {
    if (browserWindow && typeof browserWindow.confirm === 'function' && !browserWindow.confirm('入力と試算結果をすべてクリアしますか？')) return;
    resetState();
  }
  function printResult() { queueEvent('simulator_cta_click', { tool: 'sozoku' }); if (browserWindow && typeof browserWindow.print === 'function') browserWindow.print(); }
  function definitionList(items) { return el('dl', {}, items.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])); }
  function commonResultSections(viewModel) {
    return [
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '警告'), el('ul', {}, viewModel.warnings.map(warning => el('li', {}, [
        el('span', { className: 'sozoku-level' }, `[${warning.level}] `), warning.basis || warning.code,
        warning.userAction ? ` 対応：${warning.userAction}` : '',
      ])))]),
      el('details', {}, [el('summary', {}, '前提をすべて表示'), el('ul', {}, viewModel.assumptions.map(text => el('li', {}, text)))]),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '計算範囲'),
        el('p', {}, `計算済み ${viewModel.calculationRange.calculatedCount} / 対象 ${viewModel.calculationRange.targetCount} 項目`),
        el('ul', {}, viewModel.calculationRange.excluded.map(item => el('li', {}, `${item.label}：LEVEL 1では計算対象外`)))]),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, '根拠'), definitionList([
        ['計算版', viewModel.grounds.calculationVersion], ['マスタースナップショットID', viewModel.grounds.masterSnapshotId], ['法令基準日', viewModel.grounds.legalStatusAsOf],
      ]), el('h3', {}, '出典'), el('ul', {}, viewModel.grounds.sources.map(source => el('li', {}, source.url
        ? el('a', { href: source.url, rel: 'noreferrer' }, `${source.authority}：${source.title}`) : source.title)))]),
    ];
  }
  function resultActions(level) {
    return actionBar([el('button', { type: 'button', onClick: () => goToStep(level === 1 ? 2 : 3) }, '入力を修正する'),
      el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
      el('button', { type: 'button', onClick: printResult }, '結果を印刷 / PDF保存')]);
  }
  function keyResultSection(keyResult) {
    return el('section', { className: 'simulator-key-result', 'aria-label': keyResult.label }, [
      el('p', { className: 'simulator-key-result-label' }, [
        keyResult.label,
        el('span', { className: 'simulator-key-result-qualifier' }, `（${keyResult.qualifier}）`),
      ]),
      el('p', { className: 'simulator-key-result-value' }, keyResult.amount
        ? el('span', { className: 'simulator-key-result-amount' }, keyResult.display)
        : keyResult.value),
    ]);
  }
  function giftAddbackSection(viewModel) {
    if (!viewModel.giftAddback || viewModel.giftAddback.gifts.length === 0) return null;
    return el('section', { className: 'sozoku-card' }, [
      el('h2', {}, '生前贈与加算の内訳'),
      definitionList([
        ['加算対象期間の開始日', viewModel.giftAddback.periodStartDate],
        ['生前贈与の加算額合計', viewModel.giftAddback.totalAddback.display],
        ['延長期間の100万円控除適用額', viewModel.giftAddback.totalExtraDeduction.display],
      ]),
      el('ul', {}, viewModel.giftAddback.gifts.map(gift => el('li', {},
        `${gift.giftedOn}・${gift.recipientLabel}・${gift.amount.display}：${gift.statusText}`))),
      el('h3', {}, '受贈者ごとの加算・贈与税額控除'),
      el('ul', {}, viewModel.giftAddback.perRecipient.filter(row =>
        row.addbackAmount.exactYen > 0n || row.extraDeductionApplied.exactYen > 0n ||
          row.giftTaxCreditApplied.exactYen > 0n).map(row => el('li', {},
        `${row.recipientLabel}：延長期間控除 ${row.extraDeductionApplied.display}、加算 ${row.addbackAmount.display}、贈与税額控除 ${row.giftTaxCreditApplied.display}`))),
    ]);
  }
  function secondaryKeyResult(value) {
    return el('section', { className: 'simulator-key-result', 'aria-label': value.keyResult.label }, [
      el('p', { className: 'simulator-key-result-label' }, [
        value.keyResult.label,
        el('span', { className: 'simulator-key-result-qualifier' }, `（${value.keyResult.qualifier}）`),
      ]),
      el('p', { className: 'simulator-key-result-value' }, [
        el('span', { className: 'simulator-key-result-amount' }, value.keyResult.value),
        `・合計 ${value.keyResult.display}`,
      ]),
    ]);
  }
  function secondaryResult(value) {
    return [
      secondaryKeyResult(value),
      el('div', { className: 'sozoku-table-wrap' }, el('table', { className: 'sozoku-secondary-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { scope: 'col' }, '配偶者の取得割合'),
          el('th', { scope: 'col' }, '一次相続税（納付合計）'),
          el('th', { scope: 'col' }, '二次相続税（総額）'),
          el('th', { scope: 'col' }, '合計'),
          el('th', { scope: 'col' }, '合計税額の比較'),
        ])),
        el('tbody', {}, value.scenarios.map(row => el('tr', {
          className: row.isMinimum ? 'sozoku-secondary-minimum' : '',
        }, [
          el('th', { scope: 'row' }, [row.spouseAcquisitionLabel,
            row.isMinimum ? el('span', { className: 'sozoku-minimum-label' }, '最小') : null]),
          el('td', {}, row.primaryPayableTotal.display),
          el('td', {}, row.secondaryTaxTotal.display),
          el('td', {}, row.combinedTaxTotal.display),
          el('td', {}, el('div', { className: 'sozoku-tax-bar', 'aria-label': row.combinedTaxTotal.display },
            el('span', { className: 'sozoku-tax-bar-fill', style: `width:${row.barPercent}%` }))),
        ]))),
      ])),
      el('ul', { className: 'sozoku-help' }, value.notes.map(note => el('li', {}, note))),
    ];
  }
  function renderSecondarySection(viewModel) {
    if (!viewModel.secondaryAvailable) return null;
    const form = store.getState().form;
    const defaultCount = viewModel.allocations.filter(row => row.heirId !== 'spouse').length;
    const countInputElement = el('input', {
      id: 'so-secondary-heir-count', type: 'text', inputmode: 'numeric',
      value: form.secondaryHeirCount === '' ? String(defaultCount) : form.secondaryHeirCount,
      onInput: event => updateForm('secondaryHeirCount', event.currentTarget.value),
    });
    const yearsInput = el('input', {
      id: 'so-secondary-years', type: 'text', inputmode: 'numeric', value: form.yearsUntilSecondary,
      onInput: event => updateForm('yearsUntilSecondary', event.currentTarget.value, true),
    });
    const rateOptions = Array.from({ length: 11 }, (_, index) => index - 5).map(value => ({
      value: String(value), label: value < 0 ? `▲${-value}%` : value > 0 ? `+${value}%` : '0%',
    }));
    return el('details', { className: 'sozoku-card sozoku-secondary', open: Boolean(viewModel.secondaryInheritance) }, [
      el('summary', {}, '二次相続もあわせて比較する（LEVEL 3）'),
      el('div', { className: 'sozoku-no-print' }, [
        el('h2', {}, '二次相続の追加入力'),
        moneyField('spouseOwnAssets', 'so-secondary-own-assets', '配偶者の固有財産（円）',
          '$.secondaryInheritance.spouseOwnAssets.value', '配偶者名義の預貯金・不動産等の現在額（概算）。0円も入力できます。'),
        el('label', { for: 'so-secondary-heir-count' }, '二次相続の想定相続人（人数）'),
        countInputElement,
        addControlError(countInputElement, '$.secondaryInheritance.expectedHeirs'),
        ...selectField('secondaryHeirRelation', 'so-secondary-relation', '想定相続人の続柄', '', [
          { value: 'child', label: '子' }, { value: 'other', label: '子以外（2割加算）' },
        ], '$.secondaryInheritance.expectedHeirs'),
        el('label', { for: 'so-secondary-years' }, '二次相続までの想定年数（任意）'),
        yearsInput,
        addControlError(yearsInput, '$.secondaryInheritance.yearsUntilSecondary'),
        form.yearsUntilSecondary !== '' ? [
          moneyField('annualLivingCost', 'so-secondary-living-cost', '年間生活費（円）',
            '$.secondaryInheritance.annualLivingCost.value'),
          ...selectField('annualAssetChangeRate', 'so-secondary-rate', '年間の財産増減率', '', rateOptions,
            '$.secondaryInheritance.annualAssetChangeRate'),
        ] : null,
        el('button', { type: 'button', className: 'sozoku-primary', onClick: () => calculate(3) }, '二次相続を試算'),
      ]),
      viewModel.secondaryInheritance ? secondaryResult(viewModel.secondaryInheritance) : null,
    ]);
  }
  function renderBlocked(viewModel) {
    return el('main', {}, [el('h1', { id: 'so-result-heading', tabindex: '-1' }, viewModel.heading),
      ...viewModel.alerts.map(alert => el('section', { className: 'sozoku-card', role: 'alert' }, [el('h2', {}, alert.heading), el('p', {}, alert.description),
        alert.resolutionType === 'consultation' ? el('p', { className: 'sozoku-placeholder' }, '個別相談（公開準備中）') : null])),
      ...commonResultSections({ ...viewModel, calculationRange: { calculatedCount: 0, targetCount: 6, excluded: [] } }), resultActions(1)]);
  }
  function renderResult(viewModel) {
    return el('main', {}, [
      el('p', { className: 'sozoku-help' }, 'この印刷物は申告に使用できません。利用後は「入力をクリア」を実行してください。'),
      el('h1', { id: 'so-result-heading', tabindex: '-1' }, viewModel.heading),
      keyResultSection(viewModel.keyResult),
      el('section', { className: 'sozoku-card sozoku-conclusion' }, [el('h2', {}, '申告要否の試算'), el('p', {}, viewModel.conclusion.text)]),
      el('section', { className: 'sozoku-card' }, [el('h2', {}, viewModel.level === 1 ? '簡易診断の金額' : '相続税の試算'),
        definitionList([['課税価格の合計', viewModel.taxablePriceTotal.display], ['基礎控除', viewModel.basicDeduction.display],
          ...(viewModel.level >= 2 ? [['相続税の総額', viewModel.totalInheritanceTax.display], ['納付税額の合計', viewModel.totalPayableTax.display]] : [])]),
        viewModel.screeningWarning ? el('p', { className: 'sozoku-warning' }, viewModel.screeningWarning) : null,
        viewModel.defaultDivisionAssumption ? el('p', { className: 'sozoku-help' }, viewModel.defaultDivisionAssumption) : null,
      ]),
      giftAddbackSection(viewModel),
      viewModel.level >= 2 ? [
        el('section', { className: 'sozoku-card' }, [el('h2', {}, '相続人ごとの試算'), el('div', { className: 'sozoku-table-wrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, '相続人'), el('th', { scope: 'col' }, '取得財産（課税価格）'), el('th', { scope: 'col' }, '算出税額'), el('th', { scope: 'col' }, '控除'), el('th', { scope: 'col' }, '納付税額')])),
          el('tbody', {}, viewModel.allocations.map(row => el('tr', {}, [
            el('th', { scope: 'row' }, row.label), el('td', {}, row.acquiredAmount.display),
            el('td', {}, row.taxBeforeCredits.display),
            el('td', {}, [row.credits.display,
              row.creditDetails.giftTax.exactYen > 0n
                ? el('small', {}, `（うち贈与税額控除 ${row.creditDetails.giftTax.display}）`) : null]),
            el('td', {}, row.finalTax.display),
          ]))),
        ]))]),
        viewModel.spouseRelief ? el('section', { className: 'sozoku-card' }, [el('h2', {}, '配偶者の税額軽減'), definitionList([
          ['適用前税額', viewModel.spouseRelief.before.display], ['適用後税額', viewModel.spouseRelief.after.display], ['軽減額', viewModel.spouseRelief.reduction.display],
        ]), viewModel.undividedWarning ? el('p', { className: 'sozoku-warning' }, viewModel.undividedWarning) : null]) : null,
        viewModel.smallResidentialLand.applied || viewModel.smallResidentialLand.possibility ? el('section', { className: 'sozoku-card' }, [el('h2', {}, '小規模宅地等'),
          viewModel.smallResidentialLand.applied ? definitionList([['減額額', viewModel.smallResidentialLand.reduction.display], ['適用面積', viewModel.smallResidentialLand.appliedArea || '入力面積']])
            : el('p', {}, '特例を適用せず計算しました。適用できる可能性があります（要件の確認は専門家へご相談ください）。')]) : null,
      ] : el('button', { type: 'button', className: 'sozoku-primary sozoku-no-print', onClick: continueToLevel2 }, 'もっと詳しく（税額まで計算）'),
      ...commonResultSections(viewModel), renderSecondarySection(viewModel),
      el('p', { className: 'sozoku-print-page-number' }, `結果状態：${viewModel.resultStatus}`),
      resultActions(viewModel.level), el('p', { className: 'sozoku-placeholder sozoku-no-print' }, '個別相談（公開準備中・金額は送信しません）'),
    ]);
  }
  function render(previous) {
    if (destroyed) return;
    const state = store.getState();
    let content;
    if (state.screen === 'input') content = state.step === 1 ? renderStep1() : state.step === 2 ? renderStep2() : renderStep3();
    else if (state.screen === 'calculating') content = el('main', { className: 'sozoku-no-print' }, [el('h1', {}, '計算中'), el('p', {}, '税務マスターを使って試算しています。'), el('button', { type: 'button', disabled: true, 'aria-disabled': 'true' }, '計算中です')]);
    else if (state.screen === 'blocked') content = renderBlocked(state.viewModel);
    else content = renderResult(state.viewModel);
    rootElement.replaceChildren(el('style', { textContent: STYLE_TEXT }), content);
    const summary = rootElement.querySelector('.sozoku-error-summary'); if (summary) summary.focus();
    pageView.afterRender(state, previous);
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.screen !== previous.screen || state.step !== previous.step || state.errors !== previous.errors || state.result !== previous.result || state.viewModel !== previous.viewModel) render(previous);
  });
  const pageshowHandler = event => { if (event.persisted) resetState(); };
  if (browserWindow) browserWindow.addEventListener('pageshow', pageshowHandler);
  render();
  return Object.freeze({ store, destroy() { destroyed = true; unsubscribe(); if (browserWindow) browserWindow.removeEventListener('pageshow', pageshowHandler); pageView.destroy(); rootElement.classList.remove('sozoku-app'); rootElement.replaceChildren(); } });
}

function issue(code, fieldPath, message) { return { code, fieldPath, message }; }

module.exports = Object.freeze({ mountSozokuApp, INITIAL_FORM });
