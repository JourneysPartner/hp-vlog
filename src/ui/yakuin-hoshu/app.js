'use strict';

const { el } = require('../dom.js');
const { createStore } = require('../store.js');
const { createMoneyInput, createSelect, createChoiceGroup, parseMoneyInput } = require('../forms.js');
const { announceStatus, announceAlert, focusResultHeading } = require('../a11y.js');
const { queueEvent } = require('../analytics.js');
const { MUNICIPALITIES, buildCalculationContext } = require('../hojinnari/context-builder.js');
const { formatYen } = require('../hojinnari/result-view-model.js');
const {
  YakuinHoshuInputBuildError,
  buildYakuinHoshuInput,
} = require('./input-builder.js');
const { buildYakuinHoshuResultViewModel } = require('./result-view-model.js');
const { createYakuinHoshuHandoff } = require('./handoff.js');

const TOTAL_INPUT_STEPS = 2;
const CONDITIONAL_KEYS = new Set(['municipalityKey', 'mode', 'optimizationCriterion']);
const INITIAL_FORM = Object.freeze({
  incomeTaxYear: 2025,
  mode: '',
  profitBeforeOfficerCompensation: '',
  capital: '',
  municipalityKey: '',
  otherPrefectureCode: '',
  otherMunicipalityCode: '',
  otherIsDesignatedCity: false,
  ageAtYearEnd: '',
  searchLowerBound: '',
  searchUpperBound: '',
  searchStep: '10000',
  optimizationCriterion: 'max_total_retained',
  minPersonalNetIncome: '',
  minCorporateRetained: '',
  desiredMonthlyNetIncome: '',
  monthlyCompensation: '',
});

const FIELD_IDS = Object.freeze({
  '$.mode': 'yh-mode',
  '$.profitBeforeOfficerCompensation.value': 'yh-profit',
  '$.capital.value': 'yh-capital',
  '$.officer.ageAtYearEnd': 'yh-age',
  '$.calculationContext.jurisdiction': 'yh-municipality',
  '$.previousMonthlyAmount.value': 'yh-search-low',
  '$.searchUpperBound.value': 'yh-search-high',
  '$.searchStep': 'yh-search-step',
  '$.optimizationCriterion': 'yh-criterion',
  '$.constraints.minPersonalNetIncome.value': 'yh-min-personal',
  '$.constraints.minCorporateRetained.value': 'yh-min-corporate',
  '$.desiredMonthlyNetIncome.value': 'yh-desired-net',
  '$.plan.monthlySegments[0].value.monthlyAmount.value': 'yh-monthly-compensation',
});

const STYLE_TEXT = `
.yakuin-hoshu-app{color:#22293a;max-width:1080px;margin:0 auto;padding:24px;font-family:"Noto Sans JP",sans-serif;line-height:1.7}
.yakuin-hoshu-app h1,.yakuin-hoshu-app h2,.yakuin-hoshu-app h3{color:#0B2045}
.yh-card{background:#fff;border:1px solid #E3E8F0;border-radius:12px;padding:24px;margin:16px 0;box-shadow:var(--shadow-sm,0 2px 8px rgba(11,32,69,.08))}
.yh-mode-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.yh-mode-card{width:100%;height:100%;text-align:left}
.yh-conclusion{background:#FDF0EA;border-left:6px solid #E85320}.yh-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
.yakuin-hoshu-app button{min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid #0B2045;background:#fff;color:#0B2045;font:inherit}
.yakuin-hoshu-app button.yh-primary{background:#E85320;border-color:#E85320;color:#fff}.yakuin-hoshu-app button[disabled]{opacity:.65}
.yakuin-hoshu-app input,.yakuin-hoshu-app select{display:block;box-sizing:border-box;width:100%;max-width:34rem;min-height:44px;margin:6px 0 16px;padding:8px;border:1px solid #55607a;border-radius:8px;font:inherit}
.yakuin-hoshu-app input[type=checkbox],.yakuin-hoshu-app input[type=radio]{display:inline-block;width:auto;min-height:auto;margin-right:8px}
.yakuin-hoshu-app fieldset{border:1px solid #E3E8F0;border-radius:8px;margin:16px 0;padding:12px}.yakuin-hoshu-app legend{font-weight:700}
.yh-progress{font-weight:700}.yh-help{color:#55607a}.yh-error{color:#9b1c1c;font-weight:700}.yh-error-summary{border:2px solid #9b1c1c;padding:16px;margin:16px 0}
.yh-table-wrap{overflow-x:auto}.yakuin-hoshu-app table{border-collapse:collapse;width:100%;min-width:760px}.yakuin-hoshu-app th,.yakuin-hoshu-app td{border:1px solid #E3E8F0;padding:10px;text-align:right}.yakuin-hoshu-app th:first-child,.yakuin-hoshu-app td:first-child{text-align:left}.yh-level{font-weight:700}
.simulator-live-region{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:720px){.yh-mode-grid{grid-template-columns:1fr}}@media(max-width:480px){.yakuin-hoshu-app{padding:12px}.yh-card{padding:16px}.yh-actions{display:block}.yh-actions button{width:100%;margin:5px 0}}
@media print{.yh-no-print{display:none!important}.yakuin-hoshu-app{max-width:none;padding:0}.yh-card{box-shadow:none;break-inside:avoid}@page{margin:15mm}}
`;

function cloneInitialForm() { return { ...INITIAL_FORM }; }
function nextTask() { return new Promise(resolve => setTimeout(resolve, 0)); }

function mountYakuinHoshuApp(rootElement, { services, snapshotInfo, now, onHandoff } = {}) {
  if (!rootElement || typeof rootElement.replaceChildren !== 'function') {
    throw new TypeError('マウント先のDOM要素が必要です');
  }
  const service = services && services.yakuinHoshu ? services.yakuinHoshu : services;
  if (!service || typeof service.validate !== 'function' || typeof service.simulate !== 'function') {
    throw new TypeError('yakuin_hoshuサービスが必要です');
  }
  const nowProvider = typeof now === 'function' ? now : () => new Date().toISOString();
  const browserWindow = rootElement.ownerDocument && rootElement.ownerDocument.defaultView;
  const store = createStore({
    screen: 'mode', step: 1, form: cloneInitialForm(), errors: [], result: null,
    viewModel: null, canCancel: false,
  });
  let destroyed = false;
  let calculationToken = 0;
  rootElement.classList.add('yakuin-hoshu-app');
  queueEvent('simulator_view', { tool: 'yakuinHoshu' });

  function updateForm(key, value) {
    store.setState(state => ({ ...state, form: { ...state.form, [key]: value } }));
  }

  function setErrors(errors) { store.setState(state => ({ ...state, errors })); }
  function localError(fieldPath, message, code = 'YH_UI_INPUT_REQUIRED') {
    return { code, fieldPath, message };
  }
  function errorFor(path) { return store.getState().errors.find(item => item.fieldPath === path); }

  function addControlError(control, path) {
    const found = errorFor(path);
    if (!found) return null;
    const id = `${control.id || FIELD_IDS[path] || 'yh-field'}-error`;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), id]
      .filter(Boolean).join(' '));
    return el('p', { id, className: 'yh-error' }, found.message);
  }

  function errorSummary() {
    const errors = store.getState().errors;
    if (errors.length === 0) return null;
    return el('div', { className: 'yh-error-summary', tabindex: '-1' }, [
      el('h2', {}, '入力内容を確認してください'),
      el('ul', {}, errors.map(item => {
        const target = FIELD_IDS[item.fieldPath];
        return el('li', {}, target ? el('a', { href: `#${target}` }, item.message) : item.message);
      })),
    ]);
  }

  function moneyField(key, id, label, description, path) {
    const field = createMoneyInput({ id, label, description, value: store.getState().form[key] });
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
        if (CONDITIONAL_KEYS.has(key)) render();
      },
    });
    return [field.element, addControlError(field.select, path)];
  }

  function stepHeader(step, title) {
    return [
      el('p', { className: 'yh-progress', role: 'status',
        'aria-label': `${TOTAL_INPUT_STEPS}ステップ中${step}番目` },
      `STEP ${step} / ${TOTAL_INPUT_STEPS}`),
      el('h1', {}, title),
    ];
  }

  function selectMode(mode) {
    updateForm('mode', mode);
    queueEvent('simulator_mode', { tool: 'yakuinHoshu', mode });
    queueEvent('simulator_start', { tool: 'yakuinHoshu' });
    store.setState(state => ({ ...state, screen: 'input', step: 1, errors: [] }));
  }

  function renderMode() {
    const cards = [
      ['A', '最適な役員報酬を探す（MODE A）', '探索範囲と基準を指定して比較します。'],
      ['B', '欲しい手取りから逆算（MODE B）', '希望する手取り月額から必要報酬を探します。'],
      ['C', '役員報酬から手取り計算（MODE C）', '報酬月額から個人と法人の手残りを順算します。'],
    ];
    return el('main', { className: 'yh-no-print' }, [
      el('h1', {}, '役員報酬シミュレーター'),
      el('p', {}, '計算したい内容を選んでください。'),
      el('div', { className: 'yh-card' }, [
        el('h2', {}, 'ご利用の前に'),
        el('p', {}, '本ツールは一般的な前提による試算で、申告・届出や個別の税務判断には使用できません。'),
        el('p', {}, '入力と計算はブラウザ内で完結します。共用端末・画面共有・印刷物の管理にご注意ください。'),
      ]),
      el('div', { className: 'yh-mode-grid', id: 'yh-mode' }, cards.map(([mode, title, help]) =>
        el('button', { type: 'button', className: 'yh-card yh-mode-card', onClick: () => selectMode(mode) }, [
          el('strong', {}, title), el('span', {}, help),
        ]))),
    ]);
  }

  function pageActions({ previous, next, calculate } = {}) {
    return el('div', { className: 'yh-actions yh-no-print' }, [
      previous ? el('button', { type: 'button', onClick: previous }, '戻る') : null,
      next ? el('button', { type: 'button', className: 'yh-primary', onClick: nextStep }, '次へ') : null,
      calculate ? el('button', { type: 'button', className: 'yh-primary', onClick: calculateNow }, '計算する') : null,
      el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
    ]);
  }

  function renderCommonInput() {
    const form = store.getState().form;
    const age = el('input', { id: 'yh-age', type: 'text', inputmode: 'numeric', autocomplete: 'off',
      value: form.ageAtYearEnd, onInput: event => updateForm('ageAtYearEnd', event.currentTarget.value),
      'aria-describedby': 'yh-age-description' });
    return el('main', { className: 'yh-no-print' }, [
      ...stepHeader(1, '共通の条件'), errorSummary(),
      el('p', {}, `選択中：MODE ${form.mode}`),
      ...moneyField('profitBeforeOfficerCompensation', 'yh-profit', '役員報酬控除前利益（年額・円）',
        '会計上の税引前当期純利益から役員報酬と会社負担社会保険料を除いた金額。申告調整前・繰越欠損金控除前です。',
        '$.profitBeforeOfficerCompensation.value'),
      ...moneyField('capital', 'yh-capital', '資本金（円）',
        '1,000万円以上は消費税・住民税均等割に影響します。', '$.capital.value'),
      ...selectField('municipalityKey', 'yh-municipality', '会社の所在市区町村',
        '役員の住所地も同じ自治体である場合だけ計算できます。', [
          { value: '', label: '選択してください' },
          ...MUNICIPALITIES.map(item => ({ value: item.key, label: item.label })),
          { value: 'other', label: 'その他（団体コードを入力）' },
        ], '$.calculationContext.jurisdiction'),
      form.municipalityKey === 'other' ? el('div', { className: 'yh-card' }, [
        el('label', { for: 'yh-other-prefecture' }, '都道府県コード（2桁）'),
        el('input', { id: 'yh-other-prefecture', value: form.otherPrefectureCode, inputmode: 'numeric',
          onInput: event => updateForm('otherPrefectureCode', event.currentTarget.value) }),
        el('label', { for: 'yh-other-municipality' }, '市区町村コード（5桁）'),
        el('input', { id: 'yh-other-municipality', value: form.otherMunicipalityCode, inputmode: 'numeric',
          onInput: event => updateForm('otherMunicipalityCode', event.currentTarget.value) }),
        el('div', {}, [el('input', { id: 'yh-other-designated', type: 'checkbox',
          checked: form.otherIsDesignatedCity,
          onChange: event => updateForm('otherIsDesignatedCity', event.currentTarget.checked) }),
        el('label', { for: 'yh-other-designated' }, '政令指定都市に該当する')]),
      ]) : null,
      el('label', { for: age.id }, '役員の年齢（年末時点）'),
      el('p', { id: 'yh-age-description' }, '介護保険（40〜64歳）・厚生年金の判定に使います。'), age,
      addControlError(age, '$.officer.ageAtYearEnd'),
      el('div', { className: 'yh-card' }, [
        el('h2', {}, '固定している前提'),
        el('p', {}, '2025年・暦年事業年度（1/1〜12/31）、協会けんぽ、従業員0人、単身、賞与なし、期中改定なし、12か月同額です。'),
        el('p', {}, '役員住所と会社所在地が異なる場合は第1版の対象外です。'),
      ]),
      pageActions({ previous: () => store.setState(state => ({ ...state, screen: 'mode', errors: [] })), next: true }),
    ]);
  }

  function renderModeInput() {
    const form = store.getState().form;
    const mode = form.mode;
    const content = [];
    if (mode === 'A') {
      const criterion = createChoiceGroup({
        id: 'yh-criterion', label: '最適化基準', value: form.optimizationCriterion,
        options: [
          { value: 'min_burden', label: '基準A：税金＋社会保険負担が最小' },
          { value: 'max_total_retained', label: '基準B：法人＋個人の手残り最大' },
          { value: 'max_corporate_with_floor', label: '基準C：個人手取りを確保しつつ会社に最も多く残す' },
        ],
        onChange: value => { updateForm('optimizationCriterion', value); render(); },
      });
      content.push(
        ...moneyField('searchLowerBound', 'yh-search-low', '現在の月額または探索下限（円）',
          '刻みの整数倍で入力してください。', '$.previousMonthlyAmount.value'),
        ...moneyField('searchUpperBound', 'yh-search-high', '探索上限（円）',
          '探索下限以上で、刻みの整数倍を入力してください。', '$.searchUpperBound.value'),
        ...selectField('searchStep', 'yh-search-step', '探索の刻み', '', [
          { value: '10000', label: '1万円' }, { value: '50000', label: '5万円' },
        ], '$.searchStep'), criterion.element,
        addControlError(criterion.inputs[0], '$.optimizationCriterion'),
      );
      if (form.optimizationCriterion === 'max_corporate_with_floor') content.push(
        ...moneyField('minPersonalNetIncome', 'yh-min-personal', '最低限確保したい個人手取り（月額・円）',
          'サービスの第1版契約に従い、入力した月額をそのまま制約へ使います。',
          '$.constraints.minPersonalNetIncome.value'),
        ...moneyField('minCorporateRetained', 'yh-min-corporate', '会社に最低残したい額（年額・円）',
          '0円以上の整数で入力してください。', '$.constraints.minCorporateRetained.value'));
    } else if (mode === 'B') {
      content.push(
        ...moneyField('desiredMonthlyNetIncome', 'yh-desired-net', '希望手取り月額（円）',
          '0円以上の整数で入力してください。', '$.desiredMonthlyNetIncome.value'),
        ...selectField('searchStep', 'yh-search-step', '探索の刻み', '', [
          { value: '10000', label: '1万円' }, { value: '50000', label: '5万円' },
        ], '$.searchStep'));
    } else {
      content.push(...moneyField('monthlyCompensation', 'yh-monthly-compensation', '役員報酬月額（円）',
        '賞与なし・12か月同額として入力します。',
        '$.plan.monthlySegments[0].value.monthlyAmount.value'));
    }
    return el('main', { className: 'yh-no-print' }, [
      ...stepHeader(2, `MODE ${mode} の条件`), errorSummary(), content,
      pageActions({ previous: () => goToStep(1), calculate: true }),
    ]);
  }

  function validateStep(step) {
    const form = store.getState().form;
    const errors = [];
    const requireMoney = (value, path, label) => {
      if (!parseMoneyInput(String(value)).ok) errors.push(localError(path, `${label}を円単位で入力してください`));
    };
    if (step === 1) {
      requireMoney(form.profitBeforeOfficerCompensation, '$.profitBeforeOfficerCompensation.value', '役員報酬控除前利益');
      requireMoney(form.capital, '$.capital.value', '資本金');
      if (!form.municipalityKey) errors.push(localError('$.calculationContext.jurisdiction', '会社の所在市区町村を選択してください'));
      if (form.municipalityKey === 'other' &&
          (!/^\d{2}$/.test(form.otherPrefectureCode) || !/^\d{5}$/.test(form.otherMunicipalityCode))) {
        errors.push(localError('$.calculationContext.jurisdiction', '都道府県コード2桁と市区町村コード5桁を入力してください'));
      }
      if (!/^\d+$/.test(String(form.ageAtYearEnd))) errors.push(localError('$.officer.ageAtYearEnd', '役員の年齢を整数で入力してください'));
    } else if (form.mode === 'A') {
      requireMoney(form.searchLowerBound, '$.previousMonthlyAmount.value', '探索下限');
      requireMoney(form.searchUpperBound, '$.searchUpperBound.value', '探索上限');
      if (form.optimizationCriterion === 'max_corporate_with_floor') {
        requireMoney(form.minPersonalNetIncome, '$.constraints.minPersonalNetIncome.value', '最低個人手取り');
        requireMoney(form.minCorporateRetained, '$.constraints.minCorporateRetained.value', '最低法人留保');
      }
    } else if (form.mode === 'B') {
      requireMoney(form.desiredMonthlyNetIncome, '$.desiredMonthlyNetIncome.value', '希望手取り月額');
    } else {
      requireMoney(form.monthlyCompensation,
        '$.plan.monthlySegments[0].value.monthlyAmount.value', '役員報酬月額');
    }
    setErrors(errors);
    if (errors.length > 0) announceAlert('入力内容に確認が必要な項目があります');
    return errors.length === 0;
  }

  function goToStep(step) {
    if (step < 1 || step > TOTAL_INPUT_STEPS) return;
    store.setState(state => ({ ...state, screen: 'input', step, errors: [] }));
  }
  function nextStep() { if (validateStep(1)) goToStep(2); }
  function validationErrors(validation) {
    return (validation.errors || []).map(item => ({
      code: item.code || 'YH_SERVICE_VALIDATION_ERROR', fieldPath: item.fieldPath,
      message: item.message || '入力内容を確認してください',
    }));
  }

  async function calculateNow() {
    if (!validateStep(2)) return;
    const token = ++calculationToken;
    store.setState(state => ({ ...state, screen: 'calculating', errors: [], result: null,
      viewModel: null, canCancel: true }));
    await announceStatus('計算中です。実行前は中止できます');
    await nextTask();
    if (token !== calculationToken) return;
    store.setState(state => ({ ...state, canCancel: false }));
    let context;
    let wire;
    try {
      context = buildCalculationContext(store.getState().form, snapshotInfo, nowProvider());
      wire = buildYakuinHoshuInput(store.getState().form, context);
    } catch (error) {
      const errors = error instanceof YakuinHoshuInputBuildError
        ? [...error.errors] : [localError('$.calculationContext.jurisdiction', error.message)];
      store.setState(state => ({ ...state, screen: 'input', step: 2, errors }));
      await announceAlert('入力内容に確認が必要な項目があります');
      return;
    }
    const validation = service.validate(wire);
    if (!validation.ok) {
      store.setState(state => ({ ...state, screen: 'input', step: 2,
        errors: validationErrors(validation) }));
      await announceAlert('入力内容に確認が必要な項目があります');
      return;
    }
    try {
      const result = await service.simulate(validation.value, context, snapshotInfo);
      const viewModel = buildYakuinHoshuResultViewModel(result, {
        mode: store.getState().form.mode,
        optimizationCriterion: store.getState().form.optimizationCriterion,
      });
      store.setState(state => ({ ...state,
        screen: result.resultStatus === 'blocked' ? 'blocked' : 'result', result, viewModel }));
      queueEvent('simulator_complete', { tool: 'yakuinHoshu', resultStatus: result.resultStatus });
      if (result.resultStatus === 'blocked') await announceAlert('条件を確認できないため計算を停止しました');
      else {
        const heading = rootElement.querySelector('#yh-result-heading');
        if (heading) await focusResultHeading(heading);
      }
    } catch (_error) {
      store.setState(state => ({ ...state, screen: 'input', step: 2, errors: [localError(
        '$.calculationContext', '計算を完了できませんでした。入力内容とマスターの検証状態をご確認ください')] }));
      await announceAlert('計算を完了できませんでした');
    }
  }

  async function cancelCalculation() {
    if (!store.getState().canCancel) return;
    calculationToken++;
    store.setState(state => ({ ...state, screen: 'input', step: 2, canCancel: false }));
    await announceStatus('計算を中止しました');
  }

  function resetState() {
    calculationToken++;
    store.setState({ screen: 'mode', step: 1, form: cloneInitialForm(), errors: [],
      result: null, viewModel: null, canCancel: false });
  }
  function clearAll() {
    const accepted = !browserWindow || typeof browserWindow.confirm !== 'function' ||
      browserWindow.confirm('入力と試算結果をすべてクリアしますか？');
    if (accepted) resetState();
  }
  function printResult() {
    queueEvent('simulator_cta_click', { tool: 'yakuinHoshu' });
    if (browserWindow && typeof browserWindow.print === 'function') browserWindow.print();
  }
  function handoffToHojinnari() {
    try {
      const handoff = createYakuinHoshuHandoff(store.getState().result);
      queueEvent('simulator_cta_click', { tool: 'yakuinHoshu' });
      if (typeof onHandoff !== 'function') throw new Error('法人成りシミュレーターへの遷移先がありません');
      onHandoff(handoff);
    } catch (error) {
      announceAlert(error.message);
    }
  }

  function definitionList(items) {
    return el('dl', {}, items.flatMap(([term, description]) => [el('dt', {}, term), el('dd', {}, description)]));
  }
  function renderWarningsAndGrounds(viewModel) {
    return [
      el('section', {}, [el('h2', {}, '警告'), el('ul', {}, viewModel.warnings.map(warning =>
        el('li', {}, [el('span', { className: 'yh-level' }, warning.level ? `[${warning.level}] ` : ''),
          warning.message || warning.basis || warning.code])))]),
      el('details', {}, [el('summary', {}, '前提をすべて表示'),
        el('ul', {}, viewModel.assumptions.map(text => el('li', {}, text)))]),
      el('section', { className: 'yh-card' }, [el('h2', {}, '根拠'), definitionList([
        ['計算版', viewModel.grounds.calculationVersion],
        ['マスタースナップショットID', viewModel.grounds.masterSnapshotId],
        ['法令基準日', viewModel.grounds.legalStatusAsOf],
      ]), el('h3', {}, '出典'), el('ul', {}, viewModel.grounds.sources.map(source =>
        el('li', {}, source.url ? el('a', { href: source.url, rel: 'noreferrer' },
          `${source.authority}：${source.title}`) : source.title)))]),
    ];
  }
  function resultActions(viewModel) {
    return el('div', { className: 'yh-actions yh-no-print' }, [
      viewModel.handoffAvailable ? el('button', { type: 'button', className: 'yh-primary',
        onClick: handoffToHojinnari }, 'この報酬額で法人成りの損得を比較する →') : null,
      el('button', { type: 'button', onClick: () => goToStep(2) }, '入力を修正する'),
      el('button', { type: 'button', onClick: clearAll }, '入力をクリア'),
      el('button', { type: 'button', onClick: printResult }, '結果を印刷 / PDF保存'),
    ]);
  }

  function renderModeC(viewModel) {
    const rowList = rows => el('dl', {}, rows.flatMap(row => [
      el('dt', {}, row.label), el('dd', {}, row.display),
    ]));
    return [
      el('section', { className: 'yh-card yh-conclusion' }, [el('h2', {}, '個人側（年額）'),
        rowList(viewModel.personalRows)]),
      el('section', { className: 'yh-card' }, [el('h2', {}, '法人側（年額）'),
        rowList(viewModel.corporateRows)]),
      el('section', { className: 'yh-card' }, [el('h2', {}, '法人＋個人手残り'),
        el('p', {}, formatYen(viewModel.combinedCash))]),
    ];
  }
  function candidateTable(rows) {
    return el('div', { className: 'yh-table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['月額', '法人＋個人手残り', '個人手取り', '会社留保', '税負担', '社会保険負担']
        .map(label => el('th', { scope: 'col' }, label)))),
      el('tbody', {}, rows.map(row => el('tr', {}, [
        el('th', { scope: 'row' }, row.monthlyCompensation.display),
        el('td', {}, row.combinedCash.display), el('td', {}, row.personalNetCash.display),
        el('td', {}, row.corporateRetainedCash.display), el('td', {}, row.taxBurden.display),
        el('td', {}, row.socialInsuranceBurden.display),
      ]))),
    ]));
  }
  function renderModeA(viewModel) {
    return [
      el('section', { className: 'yh-card yh-conclusion' }, [el('h2', {}, '結論'),
        el('p', {}, viewModel.conclusion.text), el('p', {}, `選択基準：${viewModel.criterion.label}`),
        viewModel.criterionNotice ? el('p', {}, viewModel.criterionNotice) : null,
        el('p', {}, viewModel.optimizationDisclaimer)]),
      el('section', {}, [el('h2', {}, '候補表'), el('p', {}, viewModel.rowSelectionDescription),
        candidateTable(viewModel.defaultCandidateRows),
        el('details', {}, [el('summary', {}, `全候補を表示（${viewModel.allCandidateRows.length}件）`),
          candidateTable(viewModel.allCandidateRows)])]),
    ];
  }
  function renderModeB(viewModel) {
    if (viewModel.isRange) return [el('section', { className: 'yh-card yh-conclusion' }, [
      el('h2', {}, '逆算結果'), el('p', {}, viewModel.conclusion),
      el('p', {}, `探索範囲：${viewModel.range.display}`), el('p', {}, viewModel.forwardVerificationNotice),
    ])];
    return [el('section', { className: 'yh-card yh-conclusion' }, [
      el('h2', {}, '逆算結果'), definitionList([
        ['必要役員報酬', `約${formatYen(viewModel.requiredMonthlyCompensation)}/月`],
        ['会社負担社会保険（年額）', formatYen(viewModel.employerSocialInsuranceAnnual)],
        ['会社年間総コスト', formatYen(viewModel.companyAnnualTotalCost)],
      ]), el('p', {}, viewModel.forwardVerificationNotice),
    ])];
  }
  function renderBlocked(viewModel) {
    return el('main', {}, [
      el('h1', { id: 'yh-result-heading', tabindex: '-1' }, viewModel.heading),
      viewModel.constraintNotice ? el('p', { className: 'yh-error' }, viewModel.constraintNotice) : null,
      ...viewModel.alerts.map(alert => el('section', { className: 'yh-card' }, [
        el('h2', {}, alert.code), el('p', {}, alert.message),
      ])),
      resultActions(viewModel),
    ]);
  }
  function renderResult(viewModel) {
    const modeContent = viewModel.mode === 'A' ? renderModeA(viewModel)
      : viewModel.mode === 'B' ? renderModeB(viewModel) : renderModeC(viewModel);
    return el('main', {}, [
      el('p', { className: 'yh-help' }, 'この印刷物は申告・届出に使用できません。利用後は「入力をクリア」を実行してください。'),
      el('h1', { id: 'yh-result-heading', tabindex: '-1' }, viewModel.heading),
      modeContent, renderWarningsAndGrounds(viewModel), resultActions(viewModel),
    ]);
  }

  function render() {
    if (destroyed) return;
    const state = store.getState();
    let content;
    if (state.screen === 'mode') content = renderMode();
    else if (state.screen === 'input') content = state.step === 1 ? renderCommonInput() : renderModeInput();
    else if (state.screen === 'calculating') content = el('main', { className: 'yh-no-print' }, [
      el('h1', {}, '計算中'), el('p', {}, '候補を順算して試算しています。'),
      el('button', { type: 'button', disabled: !state.canCancel,
        'aria-disabled': state.canCancel ? 'false' : 'true', onClick: cancelCalculation },
      state.canCancel ? '計算を中止' : '計算を実行しています'),
    ]);
    else if (state.screen === 'blocked') content = renderBlocked(state.viewModel);
    else content = renderResult(state.viewModel);
    rootElement.replaceChildren(el('style', { textContent: STYLE_TEXT }), content);
    const summary = rootElement.querySelector('.yh-error-summary');
    if (summary) summary.focus();
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.screen !== previous.screen || state.step !== previous.step ||
        state.errors !== previous.errors || state.result !== previous.result ||
        state.viewModel !== previous.viewModel || state.canCancel !== previous.canCancel) render();
  });
  const pageshowHandler = event => { if (event.persisted) resetState(); };
  if (browserWindow) browserWindow.addEventListener('pageshow', pageshowHandler);
  render();
  return Object.freeze({
    store,
    destroy() {
      destroyed = true;
      calculationToken++;
      unsubscribe();
      if (browserWindow) browserWindow.removeEventListener('pageshow', pageshowHandler);
      rootElement.classList.remove('yakuin-hoshu-app');
      rootElement.replaceChildren();
    },
  });
}

module.exports = Object.freeze({ mountYakuinHoshuApp, INITIAL_FORM });
