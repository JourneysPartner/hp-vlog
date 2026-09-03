'use strict';

/** ①法人成りシミュレーターUI（U2）のDOM非依存受け入れテスト。 */

const assert = require('assert');
const vm = require('vm');
const { webcrypto } = require('crypto');
const service = require('../../../src/simulators/hojinnari/index.js');
const snapshot = require('../../../src/tax-engine/masters/snapshot.js');
const builder = require('../../build-simulator-bundle.js');
const {
  MUNICIPALITIES,
  buildCalculationContext,
} = require('../../../src/ui/hojinnari/context-builder.js');
const {
  HojinnariInputBuildError,
  buildHojinnariInput,
} = require('../../../src/ui/hojinnari/input-builder.js');
const {
  SPEC_REASON_CODES,
  QUESTION_CATALOG,
  resolveQuestion,
} = require('../../../src/ui/hojinnari/question-catalog.js');
const {
  formatApproxManYen,
  buildResultViewModel,
} = require('../../../src/ui/hojinnari/result-view-model.js');
const { mountHojinnariApp } = require('../../../src/ui/hojinnari/app.js');
const { withFakeDocument } = require('./helpers/fake-dom.js');

const snapshotInfo = snapshot.getSnapshotInfo();
const calculatedAt = '2026-08-29T12:00:00+09:00';
let passed = 0;

function check(label, action) {
  action();
  process.stdout.write(`  ✓ ${label}\n`);
  passed++;
}

function goldenState(overrides = {}) {
  return {
    incomeTaxYear: 2025,
    revenue: '20000000',
    expenses: '8000000',
    expensesConfirmed: true,
    blueReturn: 'e_tax_650k',
    businessTaxCategory: 'type3_standard',
    ageAtYearEnd: 39,
    municipalityKey: 'shibuya',
    nationalHealthInsuranceKind: 'estimate',
    nationalPensionKind: 'standard',
    officerCompensationMonthly: '500000',
    capital: '3000000',
    locationSameAsResidence: 'yes',
    corporateSameAsIndividual: true,
    ...overrides,
  };
}

function transitionState(overrides = {}) {
  return goldenState({
    comparisonBasis: 'transition_year',
    establishedOn: '2025-07-01',
    revenue: '9000000',
    expenses: '3000000',
    ageAtYearEnd: '45',
    capital: '1000000',
    corporateSameAsIndividual: false,
    corporateRevenue: '9000000',
    corporateExpenses: '3000000',
    ...overrides,
  });
}

function run(formState) {
  const context = buildCalculationContext(formState, snapshotInfo, calculatedAt);
  const wire = buildHojinnariInput(formState, context);
  const validation = service.validate(wire);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors || []));
  const result = service.simulate(validation.value, context, snapshotInfo);
  return { context, wire, result, viewModel: buildResultViewModel(result) };
}

function value(cell) {
  return cell.kind === 'amount' ? cell.exactYen : null;
}

function moneySnapshot(result) {
  const data = result.breakdown.data;
  const pick = scenario => ({
    personalDisposableCash: scenario.personalDisposableCash.value.toString(),
    corporateRetainedCash: scenario.corporateRetainedCash && scenario.corporateRetainedCash.value.toString(),
    burdens: Object.fromEntries(Object.entries(scenario.burdens)
      .map(([key, item]) => [key, item.value.toString()])),
  });
  return { sole: pick(data.soleProprietor), corporation: pick(data.corporation) };
}

function main() {
  process.stdout.write('\n=== 初期画面・ページ遷移 ===\n');
  check('マウント直後はSTEP 1で、遷移時に先頭スクロール後フォーカスしintroを圧縮・復元する', () => {
    withFakeDocument(({ root, intro }) => {
      const calls = [];
      const app = mountHojinnariApp(root, {
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

  process.stdout.write('\n=== ゴールデン統合・結果表示 ===\n');
  const complete = run(goldenState());
  const transition = run(transitionState());
  check('input-builder → validate → simulate がGC-HJ-STEADY-1200になる', () => {
    assert.strictEqual(complete.result.resultStatus, 'complete');
    assert.strictEqual(complete.result.summary.amount.value, 807220n);
    assert.strictEqual(complete.viewModel.conclusion.exactAmount, 807220n);
    assert.strictEqual(complete.viewModel.conclusion.approximate, '約81万円');
    assert(complete.viewModel.conclusion.text.includes('法人化した場合のほうが'));
    assert.strictEqual(Object.hasOwn(complete.wire.individual, 'spouse'), false);
    assert.strictEqual(Object.hasOwn(complete.wire.individual, 'dependents'), false);
  });
  const family = run(goldenState({
    ageAtYearEnd: '45', spouseExists: 'yes', spouseTotalIncome: '0',
    dependents16To18: '1', dependents19To22: '1',
  }));
  check('①Wireの家族入力を組み立て、結果詳細で個人・法人化の配偶者控除差を表示する', () => {
    assert.strictEqual(family.wire.individual.spouse.totalIncome.value, '0');
    assert.deepStrictEqual(family.wire.individual.dependents.map(item => item.ageAtYearEnd), [17, 20]);
    const rows = new Map(family.viewModel.incomeDeductionRows.map(row => [row.code, row]));
    assert.strictEqual(rows.get('spouse').soleProprietor.exactYen, 0n);
    assert.strictEqual(rows.get('spouse').corporation.exactYen, 380000n);
    assert.strictEqual(rows.get('dependents').soleProprietor.exactYen, 1010000n);
    assert.strictEqual(rows.get('dependents').corporation.exactYen, 1010000n);
  });
  check('①の現在掛金と法人化後掛金を別々のWireと控除へ反映する', () => {
    const deduction = run(goldenState({
      ageAtYearEnd: '45', selfDisability: 'general',
      spouseExists: 'yes', spouseTotalIncome: '0',
      dependents16To18: '1', dependents19To22: '1',
      individualSmallEnterpriseMutualAid: '840000',
      corporateSmallEnterpriseMutualAid: '276000',
    }));
    assert.strictEqual(deduction.wire.individual.deductions.smallEnterpriseMutualAid.value,
      '840000');
    assert.strictEqual(deduction.wire.corporate.deductions.smallEnterpriseMutualAid.value,
      '276000');
    const rows = new Map(deduction.viewModel.incomeDeductionRows.map(row => [row.code, row]));
    assert.strictEqual(rows.get('disability').soleProprietor.exactYen, 270000n);
    assert.strictEqual(rows.get('disability').corporation.exactYen, 270000n);
    assert.strictEqual(rows.get('smallEnterpriseMutualAid').soleProprietor.exactYen, 840000n);
    assert.strictEqual(rows.get('smallEnterpriseMutualAid').corporation.exactYen, 276000n);
    assert.strictEqual(deduction.result.summary.amount.value, 419820n);
  });
  check('モード選択から移行年度の追加入力4点を表示する', () => {
    withFakeDocument(({ root }) => {
      const app = mountHojinnariApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      assert(root.textContent.includes('平年度で比較（毎年の定常状態）'));
      assert(root.textContent.includes('法人成りする年で比較（年の途中で法人化）'));
      const transitionRadio = root.querySelector('#hj-comparison-basis-2');
      transitionRadio.checked = true;
      transitionRadio.listeners.get('change')();
      assert(root.querySelector('#hj-established-on'));
      assert(root.textContent.includes('個人期間の売上'));
      assert(root.textContent.includes('個人期間の経費'));
      app.store.setState(state => ({ ...state, step: 3,
        form: { ...state.form, comparisonBasis: 'transition_year' } }));
      assert(root.textContent.includes('法人期間の売上'));
      assert(root.textContent.includes('法人期間の経費'));
      assert(root.textContent.includes('法人設立月から12月まで毎月同額'));
      app.destroy();
    });
  });
  check('移行年度Wire・判定バナー・期間注記・9行比較表・平年度導線を統合する', () => {
    assert.strictEqual(transition.wire.comparisonBasis, 'transition_year');
    assert.strictEqual(transition.wire.individual.business.periodFacts.closedOn, '2025-06-30');
    assert.strictEqual(transition.wire.corporate.establishedOn, '2025-07-01');
    assert.strictEqual(transition.context.fiscalPeriod.from, '2025-07-01');
    assert.strictEqual(transition.result.summary.amount.value, 792278n);
    assert.strictEqual(transition.viewModel.verdictSummary.benefit.display, '＋792,278円');
    assert.strictEqual(transition.viewModel.comparisonRows.length, 9);
    assert.strictEqual(transition.viewModel.comparisonRows.find(row =>
      row.code === 'sole_proprietor_enterprise_tax').corporation.exactYen, 227500n);
    assert(transition.viewModel.transitionPeriodNote.includes('2025-01-01〜2025-06-30'));
    assert(transition.viewModel.transitionPeriodNote.includes('2025-07-01〜2025-12-31'));
    assert(transition.viewModel.transitionPeriodNote.includes('12月決算'));
    withFakeDocument(({ root }) => {
      const app = mountHojinnariApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, screen: 'result',
        result: transition.result, viewModel: transition.viewModel }));
      assert.strictEqual(root.querySelector('.simulator-key-result-amount').textContent,
        '＋792,278円');
      assert(root.textContent.includes('個人期間 2025-01-01〜2025-06-30'));
      assert(root.textContent.includes('法人期間 2025-07-01〜2025-12-31'));
      assert(root.textContent.includes('平年度（毎年）の比較は平年度モードで'));
      assert(root.textContent.includes('①個人のまま②この年に法人化'));
      app.destroy();
    });
  });
  check('控除第2弾の同じ本人事実をWireへ載せ、①ゴールデン差額364,620円を再現する', () => {
    const deduction2 = run(goldenState({
      ageAtYearEnd: '45', selfDisability: 'general',
      spouseExists: 'yes', spouseTotalIncome: '0',
      dependents16To18: '1', dependents19To22: '1',
      individualSmallEnterpriseMutualAid: '840000',
      corporateSmallEnterpriseMutualAid: '276000',
      lifeInsuranceNewLife: '120000',
      lifeInsuranceNewNursingMedical: '80000',
      earthquakeInsurancePremium: '50000',
      furusatoDonation: '20000',
      housingLoanCredit: '100000',
    }));
    assert.strictEqual(deduction2.wire.individual.deductions.lifeInsurance[0].annualPremium.value,
      '120000');
    assert.strictEqual(deduction2.wire.individual.deductions.donations[0].kind, 'furusato');
    assert.strictEqual(deduction2.wire.individual.taxCredits.housingLoan.value, '100000');
    assert.strictEqual(deduction2.result.summary.amount.value, 364620n);
    assert.strictEqual(deduction2.result.breakdown.data.corporation.residentTaxHousingLoanCredit.amount.value,
      35100n);
  });
  check('STEP2に家族欄と新注記を表示し、単身向け注記を撤去する', () => {
    withFakeDocument(({ root }) => {
      const app = mountHojinnariApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, step: 2,
        form: { ...state.form, spouseExists: 'yes' } }));
      const age = root.querySelector('#hj-age');
      const ageLabel = age.parentNode.children.find(node =>
        node.tagName === 'LABEL' && node.getAttribute('for') === 'hj-age');
      assert.strictEqual(ageLabel.textContent, '年齢を入力してください');
      assert(root.textContent.includes('介護保険（40〜64歳）・厚生年金の判定に使います。'));
      assert(root.textContent.includes('配偶者はいますか'));
      assert(root.textContent.includes('年収から55万円を引いた金額'));
      assert(root.textContent.includes('70歳以上・同居の親等'));
      assert(root.textContent.includes('16歳未満のお子さまは扶養控除の対象外'));
      assert(root.textContent.includes('本人の障害者区分'));
      assert(root.textContent.includes('うち障害のある方'));
      assert(root.textContent.includes('16歳未満の扶養親族に係る障害者控除は第1弾の対象外'));
      assert(root.textContent.includes('小規模企業共済・iDeCoの掛金（年額・現在）'));
      assert(root.textContent.includes('新契約：一般生命保険料（年額）'));
      assert(root.textContent.includes('ふるさと納税の年間寄附額'));
      assert(root.textContent.includes('源泉徴収票の「住宅借入金等特別控除の額」または申告書の控除額'));
      assert(root.textContent.includes('医療費控除・雑損控除・ふるさと納税以外の寄附金控除は含みません'));
      assert(root.textContent.includes('ワンストップ特例は使用せず'));
      assert(!root.textContent.includes('単身の方向け'));
      app.store.setState(state => ({ ...state, screen: 'result',
        result: family.result, viewModel: family.viewModel }));
      assert(root.textContent.includes('所得控除の内訳'));
      assert(root.textContent.includes('配偶者控除'));
      assert(root.textContent.includes('扶養控除'));
      app.destroy();
    });
  });
  check('STEP3に法人化後掛金を別欄で表示し、役員上限と共済継続を説明する', () => {
    withFakeDocument(({ root }) => {
      const app = mountHojinnariApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({ ...state, step: 3 }));
      assert(root.textContent.includes('法人化後の掛金予定（年額）'));
      assert(root.textContent.includes('月23,000円（年276,000円）'));
      assert(root.textContent.includes('小規模法人の役員であれば継続できます'));
      app.destroy();
    });
  });
  check('判定サマリーはゴールデンの税金・社会保険・計を会社負担込みで表示する', () => {
    const summary = complete.viewModel.verdictSummary;
    assert.strictEqual(summary.verdict.bannerText, '法人化が有利の試算');
    assert.strictEqual(summary.benefit.exactYen, 807220n);
    assert.strictEqual(summary.benefit.display, '807,220円');
    assert.deepStrictEqual(summary.rows.map(row => ({
      code: row.code,
      soleProprietor: row.soleProprietor.exactYen,
      corporation: row.corporation.exactYen,
      difference: row.difference.exactYen,
      display: row.difference.display,
      comment: row.comment,
    })), [
      {
        code: 'tax', soleProprietor: 3098200n, corporation: 1746900n,
        difference: 1351300n, display: '1,351,300円', comment: '税金の負担減',
      },
      {
        code: 'social_insurance', soleProprietor: 1170120n, corporation: 1714200n,
        difference: -544080n, display: '▲544,080円', comment: '社会保険の負担増',
      },
      {
        code: 'total', soleProprietor: 4268320n, corporation: 3461100n,
        difference: 807220n, display: '807,220円', comment: '法人化有利',
      },
    ]);
    assert.strictEqual(summary.rows[2].difference.exactYen,
      complete.result.breakdown.data.combinedReferenceDifference.value);
    assert(summary.note.includes('役員本人負担と会社負担の両方'));
  });
  check('比較表9行の個人・法人値がゴールデンと一致する', () => {
    const rows = complete.viewModel.comparisonRows;
    assert.strictEqual(rows.length, 9);
    assert.deepStrictEqual(rows.map(row => value(row.soleProprietor)), [
      1665900n, 977300n, 455000n, null, 1170120n, null, 7731680n, null, 7731680n,
    ]);
    assert.deepStrictEqual(rows.map(row => value(row.corporation)), [
      189700n, 310700n, null, 1246500n, 846300n, 867900n, 4653300n, 3885600n, 8538900n,
    ]);
  });
  check('省略の―と制度上の0円を区別する', () => {
    const rows = complete.viewModel.comparisonRows;
    assert.strictEqual(rows.find(row => row.code === 'corporate_taxes').soleProprietor.kind, 'omitted');
    assert.strictEqual(rows.find(row => row.code === 'corporate_taxes').soleProprietor.display, '―');
    const zero = run(goldenState({ businessTaxCategory: 'not_listed' })).viewModel.comparisonRows
      .find(row => row.code === 'sole_proprietor_enterprise_tax').soleProprietor;
    assert.strictEqual(zero.kind, 'amount');
    assert.strictEqual(zero.exactYen, 0n);
    assert.strictEqual(zero.display, '0円');
  });
  check('会社社会保険は内訳表示のみで合計へ再加算しない', () => {
    const row = complete.viewModel.comparisonRows.find(item => item.code === 'social_insurance_employer');
    assert.strictEqual(row.isEmployerSocialInsuranceDetailOnly, true);
    assert(row.note.includes('再加算しません'));
    assert.strictEqual(complete.viewModel.pairedFigures.taxAndInsuranceBurden.corporation.value, 2593200n);
  });
  check('法人税等の行ラベルに5税目の内訳を明示する', () => {
    const label = complete.viewModel.comparisonRows
      .find(row => row.code === 'corporate_taxes').label;
    for (const taxName of ['法人税', '地方法人税', '法人住民税', '法人事業税', '特別法人事業税']) {
      assert(label.includes(taxName), taxName);
    }
  });
  check('結果見出しと結果状態は英語列挙値を出さず日本語で示す', () => {
    assert(complete.viewModel.heading.includes('計算完了'));
    assert(!complete.viewModel.heading.includes('complete'));
    assert.strictEqual(complete.viewModel.resultStatusLabel, '計算完了');
  });
  check('結果DOMは見出し直下・結論カード前に横スクロール可能な判定表を描画する', () => {
    withFakeDocument(({ root }) => {
      const app = mountHojinnariApp(root, {
        services: { validate() { return { ok: true }; }, simulate() {} },
      });
      app.store.setState(state => ({
        ...state, screen: 'result', result: complete.result, viewModel: complete.viewModel,
      }));
      const text = root.textContent;
      assert(text.indexOf(complete.viewModel.heading) < text.indexOf('法人化が有利の試算'));
      assert(text.indexOf('法人化が有利の試算') < text.indexOf('結論'));
      const table = root.querySelector('.hojinnari-summary-table');
      assert(table);
      assert(table.parentNode.classList.contains('hojinnari-table-wrap'));
      assert(root.querySelector('.simulator-key-result'));
      assert.strictEqual(root.querySelector('.simulator-key-result-amount').textContent, '807,220円');
      assert(text.includes('①個人事業②法人成り①−②差引コメント'));
      app.destroy();
    });
  });
  check('計算範囲は11/12・概算は国保・根拠はsnapshotIdを持つ', () => {
    const range = complete.viewModel.calculationRange;
    assert.strictEqual(range.calculatedCount, 11);
    assert.strictEqual(range.targetCount, 12);
    assert.deepStrictEqual(range.estimates.map(item => item.label), ['国民健康保険料']);
    assert(complete.viewModel.grounds.masterSnapshotId.startsWith('tax-masters-'));
  });

  process.stdout.write('\n=== 結論分岐・partial・blocked ===\n');
  check('個人事業有利の入力は断定せず逆向き文言になる', () => {
    const reverse = run(goldenState({
      revenue: '6000000', expenses: '1000000', officerCompensationMonthly: '300000',
    }));
    assert(reverse.result.summary.amount.value < 0n);
    assert(reverse.viewModel.conclusion.text.includes('個人事業のままのほうが'));
    assert(!/(絶対|必ず)/.test(reverse.viewModel.conclusion.text));
    assert.strictEqual(reverse.viewModel.verdictSummary.verdict.bannerText, '個人事業が有利の試算');
    const total = reverse.viewModel.verdictSummary.rows.find(row => row.code === 'total');
    assert(total.difference.exactYen < 0n);
    assert(total.difference.display.startsWith('▲'));
    assert.strictEqual(total.comment, '個人事業有利');
  });
  check('差の絶対値が1万円未満なら「ほぼ同等の試算」と判定する', () => {
    const sourceData = complete.result.breakdown.data;
    const targetDifference = 9999n;
    const currentDifference = complete.viewModel.verdictSummary.rows[2].difference.exactYen;
    const adjustedEmployerValue = sourceData.corporation.burdens.socialInsuranceEmployer.value +
      currentDifference - targetDifference;
    const adjustedData = {
      ...sourceData,
      corporation: {
        ...sourceData.corporation,
        burdens: {
          ...sourceData.corporation.burdens,
          socialInsuranceEmployer: { unit: 'JPY', value: adjustedEmployerValue },
        },
      },
      combinedReferenceDifference: { unit: 'JPY', value: targetDifference },
    };
    const adjustedResult = {
      ...complete.result,
      summary: { ...complete.result.summary, amount: adjustedData.combinedReferenceDifference },
      breakdown: { ...complete.result.breakdown, data: adjustedData },
    };
    const summary = buildResultViewModel(adjustedResult).verdictSummary;
    assert.strictEqual(summary.verdict.bannerText, 'ほぼ同等の試算');
    assert.strictEqual(summary.rows[2].comment, 'ほぼ同等');
  });
  check('計の差引がcombinedReferenceDifferenceと不一致ならビューモデル生成を拒否する', () => {
    const inconsistentResult = {
      ...complete.result,
      breakdown: {
        ...complete.result.breakdown,
        data: {
          ...complete.result.breakdown.data,
          combinedReferenceDifference: { unit: 'JPY', value: 807219n },
        },
      },
    };
    assert.throws(() => buildResultViewModel(inconsistentResult),
      /計の差引がcombinedReferenceDifferenceと一致しません/);
  });
  check('法人所在地noはpartial・除外を返し、completeと数値が同一', () => {
    const partial = run(goldenState({ locationSameAsResidence: 'no' }));
    assert.strictEqual(partial.viewModel.isPartial, true);
    assert.strictEqual(partial.viewModel.partialNotice, '概算の前提が含まれます');
    assert(partial.viewModel.heading.includes('一部概算'));
    assert(partial.viewModel.excludedItems.some(item =>
      item.code === 'HJ_CORPORATE_LOCATION_LOCAL_RATES_EXCLUDED'));
    assert.deepStrictEqual(moneySnapshot(partial.result), moneySnapshot(complete.result));
  });
  check('businessTaxCategory unknownはカタログ文言のalert用データになる', () => {
    const blocked = run(goldenState({ businessTaxCategory: 'unknown' }));
    assert.strictEqual(blocked.result.resultStatus, 'blocked');
    assert(blocked.viewModel.heading.includes('停止'));
    assert(!blocked.viewModel.heading.includes('blocked'));
    assert(blocked.viewModel.alerts.some(item =>
      item.code === 'HJ_BUSINESS_TAX_CATEGORY_UNKNOWN' &&
      item.description.includes('個人事業税の業種区分')));
  });

  process.stdout.write('\n=== CalculationContext・Wire事前検証 ===\n');
  check('6自治体のコード・都道府県・指定都市フラグが固定表どおり', () => {
    const expected = [
      ['shibuya', '13113', '13', false], ['yokohama', '14100', '14', true],
      ['nagoya', '23100', '23', true], ['osaka', '27100', '27', true],
      ['fukuoka', '40130', '40', true], ['sapporo', '01100', '01', true],
    ];
    assert.strictEqual(MUNICIPALITIES.length, 6);
    for (const [key, municipalityCode, prefectureCode, isDesignatedCity] of expected) {
      const context = buildCalculationContext({ municipalityKey: key }, snapshotInfo, calculatedAt);
      assert.strictEqual(context.jurisdiction.municipalityCode, municipalityCode);
      assert.strictEqual(context.jurisdiction.prefectureCode, prefectureCode);
      assert.strictEqual(context.jurisdiction.isDesignatedCity, isDesignatedCity);
      assert.strictEqual(context.calculatedAt, calculatedAt);
      assert.strictEqual(context.asOfDate, snapshotInfo.legalStatusAsOf);
    }
  });
  check('経費確認なしは組立段階で理由コード付き拒否になる', () => {
    const context = buildCalculationContext(goldenState(), snapshotInfo, calculatedAt);
    assert.throws(() => buildHojinnariInput(goldenState({ expensesConfirmed: false }), context),
      error => error instanceof HojinnariInputBuildError &&
        error.errors.some(item => item.code === 'HJ_EXPENSES_EXCLUSION_CONFIRMATION_REQUIRED'));
  });
  check('年齢未入力は統一文言の組立エラーになる', () => {
    assert.throws(() => buildHojinnariInput(goldenState({ ageAtYearEnd: '' }), complete.context), error =>
      error instanceof HojinnariInputBuildError && error.errors.some(item =>
        item.code === 'HJ_SELF_AGE_REQUIRED' && item.message === '年齢を入力してください（0以上の整数）'));
  });
  check('その他自治体＋国保概算は実額必須理由コードで組立拒否になる', () => {
    const context = buildCalculationContext(goldenState(), snapshotInfo, calculatedAt);
    assert.throws(() => buildHojinnariInput(goldenState({ municipalityKey: 'other' }), context),
      error => error instanceof HojinnariInputBuildError &&
        error.errors.some(item => item.code === 'HJ_UI_NHI_ACTUAL_REQUIRED_FOR_OTHER_MUNICIPALITY'));
  });

  process.stdout.write('\n=== 質問カタログ・表示丸め ===\n');
  check('仕様書§4の掲載理由コードをすべてカタログへ登録している', () => {
    for (const code of SPEC_REASON_CODES) assert(Object.hasOwn(QUESTION_CATALOG, code), code);
  });
  check('未知コードは原文メッセージ＋相談導線へフォールバックする', () => {
    const fallback = resolveQuestion({ code: 'HJ_UNKNOWN_TEST', message: '原文メッセージ' });
    assert.strictEqual(fallback.isFallback, true);
    assert.strictEqual(fallback.description, '原文メッセージ');
    assert.strictEqual(fallback.resolutionType, 'consultation');
  });
  check('1万円未満四捨五入を絶対値で行う', () => {
    assert.strictEqual(formatApproxManYen(807220n), '約81万円');
    assert.strictEqual(formatApproxManYen(-3078380n), '約308万円');
  });

  process.stdout.write('\n=== 生成バンドルの公開API ===\n');
  check('vm評価でTaxSimulator.mountHojinnariが関数として公開される', () => {
    const built = builder.build();
    const context = { window: {}, crypto: webcrypto, TextEncoder, Uint8Array, ArrayBuffer };
    vm.runInNewContext(built.bundle, context, { filename: 'tax-simulator.bundle.js' });
    assert.strictEqual(typeof context.window.TaxSimulator.mountHojinnari, 'function');
  });

  // 画面の選択肢値と入力型の列挙値のずれの再発防止。
  // 実際に type3_medical という存在しない値が選択肢に紛れ込み、
  // 3%区分を選ぶと検証エラーになるバグがあった。
  process.stdout.write('\n=== 事業区分の全選択肢が検証を通る ===\n');
  check('第3種・3%区分（type3_reduced）を含む全区分で validate が ok になる', () => {
    for (const category of ['type1', 'type2', 'type3_standard', 'type3_reduced', 'not_listed']) {
      const state = goldenState({ businessTaxCategory: category });
      const context = buildCalculationContext(state, snapshotInfo, calculatedAt);
      const wire = buildHojinnariInput(state, context);
      const validation = service.validate(wire);
      assert.strictEqual(validation.ok, true,
        `${category}: ${JSON.stringify(validation.errors || [])}`);
    }
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
