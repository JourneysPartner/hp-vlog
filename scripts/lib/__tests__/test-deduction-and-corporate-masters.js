'use strict';

/**
 * 雑損控除・寄附金控除・住宅ローン控除・交際費・定期同額給与・
 * 外国税額控除・国民健康保険のマスターの検証。
 *   node scripts/lib/__tests__/test-deduction-and-corporate-masters.js
 *
 * 間違えやすい点を固定する。
 *   - 寄附金の上限は所得税40%・住民税30%で違う
 *   - ふるさと納税の特例控除の割合は条文の表を引く（90%−税率×1.021 の計算では合わない）
 *   - 指定都市では道府県と市町村の内訳が入れ替わる（合計は同じ）
 *   - 交際費の1人1万円は令和6年4月1日以後の支出から（それ以前は5千円）
 *   - 業績悪化改定事由は減額改定に限る。臨時改定事由は増減とも可
 *   - 国保の子ども・子育て支援納付金は被用者保険の支援金と別建て
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'data', 'tax-simulator', 'masters', 'data');
const load = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

function collect(doc) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.value_key === 'string') out.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  walk(doc);
  return out;
}

const yen = (m) => BigInt(m.value);
const eqFrac = (r, num, den) => BigInt(r.num) * BigInt(den) === BigInt(num) * BigInt(r.den);

// ---------------------------------------------------------------- 雑損控除

console.log('\n=== Test 1: 雑損控除 ===');
const casDoc = load('income-deduction', 'casualty-loss.json');
const cas = new Map(collect(casDoc).map(r => [r.record_id, r]));
{
  const ratio = cas.get('IDED-CASUALTY-FLOOR-INCOME-RATIO');
  const exp = cas.get('IDED-CASUALTY-FLOOR-DISASTER-EXPENSE');
  assert(eqFrac(ratio.rate, 1, 10), '所得の足切りは10分の1');
  assert(yen(exp.threshold_amount) === 50000n, '災害関連支出の足切りは5万円');
  assert(ratio.income_base === 'total_income_and_retirement_and_forestry',
    '分母は総所得金額＋退職所得金額＋山林所得金額（合計所得金額ではない）');
  assert(cas.get('IDED-CASUALTY-CARRYFORWARD').carryforward_years === 3,
    '雑損失は3年繰り越せる');
  assert(/青色申告でなくても/.test(cas.get('IDED-CASUALTY-CARRYFORWARD')._blue_return_not_required || ''),
    '青色申告が要件でないことが記録されている');

  const scope = cas.get('IDED-CASUALTY-SCOPE');
  assert(JSON.stringify(scope.eligible_causes) === JSON.stringify(['disaster', 'theft', 'embezzlement']),
    '対象は災害・盗難・横領の3つ（詐欺・恐喝は対象外）');
}

console.log('\n=== Test 2: 雑損控除の3つの号が1つの式に帰着する ===');
{
  // 条文どおりに計算する関数
  const byStatute = (loss, disasterExpense, incomeBase) => {
    const floor = incomeBase / 10n;
    let threshold;
    if (disasterExpense === loss) {                  // 3号
      threshold = 50000n < floor ? 50000n : floor;
    } else if (disasterExpense > 50000n) {           // 2号
      const a = loss - (disasterExpense - 50000n);
      threshold = a < floor ? a : floor;
    } else {                                          // 1号
      threshold = floor;
    }
    const v = loss - threshold;
    return v > 0n ? v : 0n;
  };
  // 文書が主張している等価な式
  const byEquivalent = (loss, disasterExpense, incomeBase) => {
    const a = loss - incomeBase / 10n;
    const b = disasterExpense - 50000n;
    const m = a > b ? a : b;
    return m > 0n ? m : 0n;
  };

  const cases = [
    [3000000n, 0n, 5000000n, '災害関連支出なし'],
    [3000000n, 30000n, 5000000n, '災害関連支出5万円以下'],
    [3000000n, 500000n, 5000000n, '災害関連支出5万円超'],
    [800000n, 800000n, 5000000n, '損失がすべて災害関連支出'],
    [100000n, 100000n, 5000000n, '同上・少額'],
    [3000000n, 2000000n, 20000000n, '高所得で足切りが大きい'],
    [200000n, 0n, 5000000n, '損失が足切り未満（控除0）'],
  ];
  for (const [loss, de, base, label] of cases) {
    assert(byStatute(loss, de, base) === byEquivalent(loss, de, base),
      `${label}: 条文どおりの計算と等価式が一致（${byStatute(loss, de, base)}円）`);
  }
  assert(/max\(/.test(casDoc._equivalent_formula || ''),
    '等価な式が文書に記録されている');
}

// -------------------------------------------------------------- 寄附金控除

console.log('\n=== Test 3: 寄附金の上限が所得税と住民税で違う ===');
const donDoc = load('income-deduction', 'donation-deduction.json');
const don = new Map(collect(donDoc).map(r => [r.record_id, r]));
{
  assert(eqFrac(don.get('DON-IT-INCOME-CAP').rate, 40, 100), '所得税の上限は総所得金額等の40%');
  assert(eqFrac(don.get('DON-RT-INCOME-CAP').rate, 30, 100), '住民税の上限は前年の総所得金額等の30%');
  assert(don.get('DON-IT-INCOME-CAP').value_key === don.get('DON-RT-INCOME-CAP').value_key,
    '同じ value_key で税目により選び分ける');
  assert(don.get('DON-IT-INCOME-CAP').tax_or_insurance_type === 'income_tax'
    && don.get('DON-RT-INCOME-CAP').tax_or_insurance_type === 'resident_tax',
    '税目が区別されている');
  assert(yen(don.get('DON-IT-FLOOR').threshold_amount) === 2000n
    && yen(don.get('DON-RT-FLOOR').threshold_amount) === 2000n,
    '足切りはいずれも2,000円（根拠条文は別）');
}

console.log('\n=== Test 4: 住民税の基本控除と指定都市の入れ替わり ===');
{
  const ord = don.get('DON-RT-BASIC-ORDINARY');
  const des = don.get('DON-RT-BASIC-DESIGNATED-CITY');
  assert(eqFrac(ord.prefectural_rate, 4, 100) && eqFrac(ord.municipal_rate, 6, 100),
    '通常は道府県4%・市町村6%');
  assert(eqFrac(des.prefectural_rate, 2, 100) && eqFrac(des.municipal_rate, 8, 100),
    '指定都市は道府県2%・市町村8%');
  for (const r of [ord, des]) {
    const sum = BigInt(r.prefectural_rate.num) + BigInt(r.municipal_rate.num);
    assert(sum === 10n && r.prefectural_rate.den === '100', '合計は10%で変わらない');
  }
}

console.log('\n=== Test 5: ふるさと納税の特例控除の割合表 ===');
{
  const t = don.get('DON-FURUSATO-SPECIAL-RATE-TABLE');
  const expect = [
    [1950000n, 85n], [3300000n, 80n], [6950000n, 70n],
    [9000000n, 67n], [18000000n, 57n], [40000000n, 50n], [null, 45n],
  ];
  assert(t.bands.length === 7, `割合表は7段階（実: ${t.bands.length}）`);
  t.bands.forEach((b, i) => {
    const [upper, rate] = expect[i];
    const upOk = upper === null ? b.upper_inclusive === null : yen(b.upper_inclusive) === upper;
    assert(upOk && eqFrac(b.rate, Number(rate), 100),
      `第${i + 1}段階: 上限${upper === null ? '無し' : upper + '円'} → ${rate}%`);
  });

  // 段階に隙間・重なりが無い
  for (let i = 1; i < t.bands.length; i++) {
    const prevUpper = yen(t.bands[i - 1].upper_inclusive);
    const lower = yen(t.bands[i].lower_exclusive);
    assert(prevUpper === lower, `第${i}段階の上限と第${i + 1}段階の下限が一致（${prevUpper}）`);
  }

  // 「90% − 所得税率 × 1.021」では条文の値にならないことを固定する
  // 33%区分: 90 − 33 × 1.021 = 56.307 だが条文は 57
  const computed = 90000n - 33n * 1021n;   // 千分率で 56307
  assert(computed !== 57000n,
    '33%区分は 90%−税率×1.021 の計算値（56.307%）と条文の57%が一致しない → 表を引く必要がある');
  assert(/57/.test(donDoc._critical_traps?.['特例控除の割合は条文の表を使う'] || ''),
    'この食い違いが文書に記録されている');

  const neg = don.get('DON-FURUSATO-SPECIAL-RATE-NEGATIVE');
  assert(eqFrac(neg.rate, 90, 100), '課税所得が0を下回る場合は90%');
  assert(neg.value_key === t.value_key, '同じ value_key');
  assert(Array.isArray(t.applicability_conditions) && Array.isArray(neg.applicability_conditions),
    '2つとも機械可読な条件を持つ（共存できる）');
}

console.log('\n=== Test 6: 特例控除の按分と上限 ===');
{
  const ord = don.get('DON-FURUSATO-ALLOCATION-ORDINARY');
  const des = don.get('DON-FURUSATO-ALLOCATION-DESIGNATED-CITY');
  assert(eqFrac(ord.prefectural_share, 2, 5) && eqFrac(ord.municipal_share, 3, 5),
    '通常は道府県5分の2・市町村5分の3');
  assert(eqFrac(des.prefectural_share, 1, 5) && eqFrac(des.municipal_share, 4, 5),
    '指定都市は道府県5分の1・市町村5分の4');
  for (const r of [ord, des]) {
    assert(BigInt(r.prefectural_share.num) + BigInt(r.municipal_share.num) === 5n,
      '按分の合計は1（5分の5）');
  }
  const cap = don.get('DON-FURUSATO-SPECIAL-CAP');
  assert(eqFrac(cap.rate, 20, 100), '特例控除の上限は所得割の20%');
  assert(/寄附金税額控除|住宅ローン控除|適用する前/.test(cap._cap_base_detail || ''),
    '上限の基数が税額控除前の所得割であることが記録されている');
}

console.log('\n=== Test 7: ワンストップ特例の上乗せ表 ===');
{
  const t = don.get('DON-FURUSATO-ONESTOP-RATE-TABLE');
  const expect = [[1950000n, 5, 85], [3300000n, 10, 80], [6950000n, 20, 70],
                  [9000000n, 23, 67], [null, 33, 57]];
  assert(t.bands.length === 5, `上乗せ表は5段階（実: ${t.bands.length}）`);
  t.bands.forEach((b, i) => {
    const [upper, num, den] = expect[i];
    assert(eqFrac(b.rate, num, den), `第${i + 1}段階: ${num}/${den}`);
  });
  assert(t.bands[t.bands.length - 1].upper_inclusive === null
    && yen(t.bands[t.bands.length - 1].lower_exclusive) === 9000000n,
    '表は900万円超で止まり、所得税率40%・45%の区分が無い');
  assert(/40%|45%/.test(t._table_stops_at_9m || ''),
    '高所得者で確定申告より不利になりうる旨が記録されている');

  // 上乗せ表の分子は所得税の税率、分母は特例控除の割合になっている
  const special = don.get('DON-FURUSATO-SPECIAL-RATE-TABLE');
  for (let i = 0; i < 5; i++) {
    assert(t.bands[i].rate.den === special.bands[i].rate.num,
      `第${i + 1}段階の分母(${t.bands[i].rate.den})が特例控除の割合(${special.bands[i].rate.num})と一致`);
  }
}

// ---------------------------------------------------- 住民税の住宅ローン控除

console.log('\n=== Test 8: 住民税の住宅ローン控除 ===');
const hlDoc = load('resident-tax', 'housing-loan-credit.json');
const hl = new Map(collect(hlDoc).map(r => [r.record_id, r]));
{
  const ord = hl.get('RT-HOUSING-LOAN-ORDINARY');
  assert(eqFrac(ord.combined_limit_rate, 5, 100) && yen(ord.combined_limit_amount) === 97500n,
    '通常の控除限度額は課税総所得金額等の5%・97,500円');
  assert(yen(ord.prefectural_limit_amount) === 39000n && yen(ord.municipal_limit_amount) === 58500n,
    '内訳は道府県39,000円・市町村58,500円');
  assert(yen(ord.prefectural_limit_amount) + yen(ord.municipal_limit_amount) === 97500n,
    '内訳の合計が97,500円');

  const des = hl.get('RT-HOUSING-LOAN-ORDINARY-DESIGNATED');
  assert(yen(des.prefectural_limit_amount) === 19500n && yen(des.municipal_limit_amount) === 78000n,
    '指定都市は道府県19,500円・市町村78,000円');
  assert(yen(des.prefectural_limit_amount) + yen(des.municipal_limit_amount) === 97500n,
    '指定都市でも合計は97,500円');

  const sp = hl.get('RT-HOUSING-LOAN-SPECIAL-ACQUISITION');
  assert(eqFrac(sp.combined_limit_rate, 7, 100) && yen(sp.combined_limit_amount) === 136500n,
    '特定取得等は7%・136,500円');
  assert(eqFrac(sp.prefectural_limit_rate, 28, 1000) && eqFrac(sp.municipal_limit_rate, 42, 1000),
    '2.8%と4.2%は整数対（28/1000・42/1000）で保持している');
  assert(yen(sp.prefectural_limit_amount) + yen(sp.municipal_limit_amount) === 136500n,
    '特定取得等の内訳合計が136,500円');

  const spd = hl.get('RT-HOUSING-LOAN-SPECIAL-DESIGNATED');
  assert(yen(spd.prefectural_limit_amount) + yen(spd.municipal_limit_amount) === 136500n,
    '指定都市の特定取得等も合計136,500円');

  const yrs = hl.get('RT-HOUSING-LOAN-APPLICABLE-YEARS');
  assert(yrs.occupancy_year_to === 2025,
    '居住年の上限は令和7年（2025年）。令和8年以後は延長の確認が要る');
  assert(/blocked/.test(hlDoc._simulator_rule || ''),
    '令和8年以後の入居を blocked とする方針が記録されている');
}

// ------------------------------------------------------------ 交際費

console.log('\n=== Test 9: 交際費等の損金不算入 ===');
const entDoc = load('corporate-tax', 'entertainment-expenses.json');
const ent = new Map(collect(entDoc).map(r => [r.record_id, r]));
{
  const sme = ent.get('CORP-ENTERTAIN-SME-LIMIT');
  assert(yen(sme.annual_limit_amount) === 8000000n, '定額控除限度額は年800万円');
  assert(sme.proration_rule === 'monthly', '事業年度が12月未満なら月割');
  assert(sme.effective_to === '2027-03-31',
    '措法61条の4は令和9年3月31日までに開始する事業年度に適用（期限付き）');
  assert(/66条5項|六十六条第五項/.test(sme._excluded_entities + sme._sme_definition_differs),
    '中小法人の判定が他の規定と一致しないことが記録されている');

  const d50 = ent.get('CORP-ENTERTAIN-DINING-50PCT');
  assert(eqFrac(d50.rate, 50, 100), '接待飲食費の50%まで損金算入');
  assert(/役員と従業員だけの飲食/.test(d50._internal_dining_trap || ''),
    '社内飲食費が接待飲食費に当たらないことが記録されている');

  const pp = ent.get('CORP-ENTERTAIN-PER-PERSON-EXCLUSION');
  assert(yen(pp.threshold_amount) === 10000n, '1人当たり1万円以下は交際費等から除外');
  assert(pp.threshold_basis === 'per_participant', '参加者数で割った金額で判定する');
  assert(pp.effective_from === '2024-04-01' && /5,000円|五千円/.test(pp._history || ''),
    '令和6年4月1日以後の支出から1万円（それ以前は5,000円）');
  assert(/順序を逆にすると/.test(pp._order_of_operations || ''),
    '除外を先に行う順序が記録されている');

  // 800万円 vs 接待飲食費50% の分岐点：接待飲食費1,600万円
  assert(8000000n * 2n === 16000000n,
    '接待飲食費1,600万円で800万円基準と50%基準が一致する（超えると50%基準が有利）');
}

// -------------------------------------------------------- 定期同額給与

console.log('\n=== Test 10: 定期同額給与 ===');
const ocDoc = load('corporate-tax', 'officer-compensation-rules.json');
const oc = new Map(collect(ocDoc).map(r => [r.record_id, r]));
{
  const dl = oc.get('CORP-OFFICER-ORDINARY-REVISION-DEADLINE');
  assert(dl.deadline_months_from_period_start === 3, '通常改定の期限は3月を経過する日まで');
  assert(dl.deadline_basis === 'accounting_period_start',
    '起算点は会計期間の開始の日（事業年度ではない）');

  const ex = oc.get('CORP-OFFICER-EXTRAORDINARY-REVISION');
  const pd = oc.get('CORP-OFFICER-PERFORMANCE-DECLINE-REVISION');
  assert(ex.allows_increase === true && ex.allows_decrease === true,
    '臨時改定事由は増額・減額のいずれも可能');
  assert(pd.allows_increase === false && pd.allows_decrease === true,
    '業績悪化改定事由は減額改定に限る');
  assert(ex.value_key === pd.value_key, '2つの事由は同じ value_key');
  assert(JSON.stringify(ex.applicability_conditions) !== JSON.stringify(pd.applicability_conditions),
    '事由で選び分けられる');

  const net = oc.get('CORP-OFFICER-NET-AMOUNT-DEEMED-EQUAL');
  assert(net.deemed_equal_basis === 'after_withholding_and_social_insurance',
    '源泉税等控除後が同額なら支給額を同額とみなす');
  assert(/MODE B/.test(net._simulator_impact || ''),
    '手取り逆算モードがこの規定と整合することが記録されている');
}

// ---------------------------------------------------- 外国税額控除

console.log('\n=== Test 11: 相続税の外国税額控除 ===');
const ftDoc = load('inheritance-tax', 'foreign-tax-credit.json');
const ft = new Map(collect(ftDoc).map(r => [r.record_id, r]));
{
  const r = ft.get('IHT-FOREIGN-TAX-CREDIT');
  assert(r.calculation_order === 7,
    '税額控除の適用順序で7番目（贈与税額控除→配偶者軽減→未成年者→障害者→相次相続→外国税額）');
  assert(r.credit_method === 'lesser_of_foreign_tax_and_proportional_limit',
    '外国税額と按分上限のいずれか小さい方');
  assert(/第十五条から前条まで|15条から20条/.test(r._order + r._verbatim),
    '基数が15条から20条までを適用した後の金額であることが記録されている');
  assert(/未登録/.test(r._currency || ''), '邦貨換算レートが未登録であることが記録されている');
}

// -------------------------------------------------- 国民健康保険

console.log('\n=== Test 12: 国民健康保険の賦課限度額 ===');
const nhiDoc = load('social-insurance', 'national-health-insurance.json');
const nhi = new Map(collect(nhiDoc).map(r => [r.record_id, r]));
{
  const caps = [
    ['NHI-CAP-MEDICAL', 670000n, '医療分は67万円'],
    ['NHI-CAP-ELDERLY-SUPPORT', 260000n, '後期高齢者支援金分は26万円'],
    ['NHI-CAP-NURSING-CARE', 170000n, '介護納付金分は17万円'],
    ['NHI-CAP-CHILD-SUPPORT', 30000n, '子ども・子育て支援納付金分は3万円'],
  ];
  let total = 0n;
  for (const [id, amt, label] of caps) {
    assert(yen(nhi.get(id).cap_amount) === amt, label);
    total += amt;
  }
  assert(total === 1130000n, `4区分の合計は113万円（実: ${total}）`);

  assert(new Set(caps.map(([id]) => nhi.get(id).value_key)).size === 1,
    '4区分は同じ value_key');
  assert(new Set(caps.map(([id]) => nhi.get(id).levy_component)).size === 4,
    'levy_component で区別できる');

  const child = nhi.get('NHI-CAP-CHILD-SUPPORT');
  assert(/child_support_levy_rate/.test(child._related || ''),
    '被用者保険側の支援金率との関係が記録されている');
  assert(/別建て|流用しない/.test(child._new_component || ''),
    '被用者保険の支援金率を流用しない旨が記録されている');
  assert(nhi.get('NHI-CAP-NURSING-CARE').tax_or_insurance_type === 'nursing_care_insurance',
    '介護納付金分は介護保険の税目で分類されている');
}

console.log('\n=== Test 13: 国民健康保険の軽減判定 ===');
{
  const base = nhi.get('NHI-REDUCTION-BASE');
  assert(yen(base.base_amount) === 430000n, '軽減判定の基準額は43万円');
  assert(yen(base.per_extra_salary_earner_amount) === 100000n,
    '給与所得者等が2人以上なら1人につき10万円加算');
  assert(/314条の2第2項第1号|三百十四条の二第二項第一号/.test(base._verbatim + base._base_source),
    '43万円が地方税法314条の2第2項1号を引いていることが記録されている');

  const tiers = [
    ['NHI-REDUCTION-70PCT', 7, 0n, '7割軽減は基準額以下'],
    ['NHI-REDUCTION-50PCT', 5, 310000n, '5割軽減は被保険者1人につき31万円加算'],
    ['NHI-REDUCTION-20PCT', 2, 570000n, '2割軽減は被保険者1人につき57万円加算'],
  ];
  for (const [id, num, add, label] of tiers) {
    const r = nhi.get(id);
    assert(eqFrac(r.reduction_rate, num, 10) && yen(r.per_insured_addition) === add, label);
  }

  // 単身世帯（被保険者1人・給与所得者1人）の判定境界
  const b = yen(base.base_amount);
  assert(b === 430000n, '単身世帯の7割軽減の境界は43万円');
  assert(b + 310000n === 740000n, '単身世帯の5割軽減の境界は74万円');
  assert(b + 570000n === 1000000n, '単身世帯の2割軽減の境界は100万円');

  assert(/所得割額は軽減されない/.test(nhi.get('NHI-REDUCTION-20PCT')._applies_to_equalization_only || ''),
    '軽減の対象が均等割・平等割に限られることが記録されている');
}

console.log('\n=== Test 14: 国保は概算できないことが明示されている ===');
{
  assert(/市町村の条例で定まる/.test(
    nhiDoc._critical_limitation?.['全国一律の料率は存在しない'] || ''),
    '所得割率・均等割額に全国一律の値が無いことが記録されている');
  assert(/所得割率/.test(JSON.stringify(nhiDoc._not_registered_and_why || {})),
    '未登録の項目と理由が列挙されている');
  assert(/0円として計算すると/.test(nhiDoc._simulator_rule || ''),
    '0円扱いにしない方針が記録されている');
  assert(/derived/.test(nhiDoc._estimation_note || ''),
    '概算を採用する場合に value_certainty を derived にする方針が記録されている');
}

console.log('\n=== Test 15: 出典と承認状態 ===');
{
  const docs = [casDoc, donDoc, hlDoc, entDoc, ocDoc, ftDoc, nhiDoc];
  const all = docs.flatMap(collect);
  assert(all.length === 38,
    `7ファイルで38レコード（雑損4・寄附金12・住宅ローン5・交際費4・役員給与4・外国税額1・国保8／実: ${all.length}）`);
  assert(all.every(r => r.source_document_id && r.source_locator),
    '全レコードに出典と条文の位置がある');
  assert(all.every(r => r.data_review_status === 'approved'), '全レコードが承認済み');
  assert(all.every(r => r.legal_status === 'effective'), '全レコードが施行済み');

  const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, '..', 'sources', 'source-registry.json'), 'utf8'));
  const used = new Set(all.map(r => r.source_document_id));
  for (const id of used) assert(!!registry.sources[id], `出典 ${id} が台帳に登録されている`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
