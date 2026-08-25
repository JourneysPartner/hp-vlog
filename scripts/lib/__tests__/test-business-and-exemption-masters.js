'use strict';

/**
 * 個人事業税・繰越欠損金・住民税の非課税限度額のマスターの検証。
 *   node scripts/lib/__tests__/test-business-and-exemption-masters.js
 *
 * 間違えやすい点を固定する。
 *   - 個人事業税の課税標準は所得税の事業所得と違う（青色申告特別控除は引かない）
 *   - 法定業種でない事業は「0円」ではなく「課税されない」。0円とみなすと法人成りの損得が逆転しうる
 *   - 繰越欠損金の中小法人等（法57条11項1号）は軽減税率の中小法人（法66条5項）と条文が別
 *   - 住民税の非課税限度額の扶養親族には16歳未満を含む（所得税の扶養控除と違う）
 *   - 非課税限度額の基本額35万円・加算額21万円は上限であって全国一律の額ではない
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
  if (Array.isArray(doc.records)) out.push(...doc.records);
  for (const v of Object.values(doc)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.records)) out.push(...v.records);
  }
  return out;
}

const yen = (m) => BigInt(m.value);
const ratio = (r) => [BigInt(r.num), BigInt(r.den)];

// ---------------------------------------------------------------- 個人事業税

console.log('\n=== Test 1: 個人事業税の標準税率 ===');
const ibtDoc = load('business-tax', 'individual-business-tax.json');
const ibt = new Map(collect(ibtDoc).map(r => [r.record_id, r]));
{
  const cases = [
    ['IBT-RATE-TYPE1', 5n, '第1種事業は5%'],
    ['IBT-RATE-TYPE2', 4n, '第2種事業は4%（畜産業・水産業・薪炭製造業）'],
    ['IBT-RATE-TYPE3-STANDARD', 5n, '第3種事業（一般）は5%'],
    ['IBT-RATE-TYPE3-REDUCED', 3n, '第3種のあん摩等・装蹄師業は3%'],
  ];
  for (const [id, pct, label] of cases) {
    const r = ibt.get(id);
    const [num, den] = ratio(r.rate);
    assert(num * 100n === pct * den, label);
  }

  const rates = cases.map(([id]) => ibt.get(id));
  assert(new Set(rates.map(r => r.value_key)).size === 1,
    '4区分は同じ value_key（業種で選び分ける）');
  const conds = rates.map(r => JSON.stringify(r.applicability_conditions));
  assert(new Set(conds).size === 4,
    '4区分は applicability_conditions で区別できる（同じ期間に共存するため）');
  assert(rates.every(r => (r.applicability_conditions || [])
    .every(c => c.subject === 'business_tax_category')),
    '判定に使う入力は business_tax_category に統一されている');
}

console.log('\n=== Test 2: 個人事業税の事業主控除 ===');
{
  const d = ibt.get('IBT-OWNER-DEDUCTION');
  assert(yen(d.deduction_amount) === 2900000n, '事業主控除は年290万円');
  assert(d.proration_rule === 'monthly', '事業期間が1年未満なら月割');
  assert(/切上げ|一月とする|１月とする|1月とする/.test(d._month_counting || ''),
    '月数の端数は切り上げる（切り捨てにすると控除を過小にする）');

  // 第3種一般・所得500万円・通年 → (500万 − 290万) × 5% = 10.5万円
  const income = 5000000n;
  const base = income - yen(d.deduction_amount);
  const [num, den] = ratio(ibt.get('IBT-RATE-TYPE3-STANDARD').rate);
  assert(base * num / den === 105000n, '所得500万円の第3種一般で10万5千円になる');

  // 6か月で廃業 → 290万 × 6 ÷ 12 = 145万
  assert(yen(d.deduction_amount) * 6n / 12n === 1450000n,
    '年の途中で法人成りすると事業主控除が月割になる（6か月なら145万円）');
}

console.log('\n=== Test 3: 個人事業税の課税されない場合 ===');
{
  assert(/blocked/.test(ibtDoc._not_taxable_note || ''),
    '法定業種でない事業は blocked にする（0円とみなさない）と明記されている');
  assert(/青色申告特別控除/.test(ibtDoc._taxable_base_note || ''),
    '課税標準に青色申告特別控除を引かないことが明記されている');
  assert(/事業税では適用されない/.test(
    ibtDoc._important_differences?.['青色申告特別控除は引かない'] || ''),
    '所得税の事業所得をそのまま流用しない旨が記録されている');
}

// -------------------------------------------------------------- 繰越欠損金

console.log('\n=== Test 4: 欠損金の繰越控除 ===');
const lossDoc = load('corporate-tax', 'loss-carryforward.json');
const loss = new Map(collect(lossDoc).map(r => [r.record_id, r]));
{
  const p = loss.get('CORP-LOSS-CARRYFORWARD-PERIOD');
  assert(p.carryforward_years === 10, '繰越期間は10年');
  assert(p.applies_to_period_start_from === '2018-04-01',
    '10年は平成30年4月1日以後に開始する事業年度から（それ以前は9年）');
  assert(/9年|九年/.test(p._history || ''), '9年だった経過が記録されている');

  const sme = loss.get('CORP-LOSS-LIMIT-SME');
  const big = loss.get('CORP-LOSS-LIMIT-LARGE');
  const [sn, sd] = ratio(sme.deduction_limit_rate);
  const [bn, bd] = ratio(big.deduction_limit_rate);
  assert(sn * 100n === 100n * sd, '中小法人等の控除限度は所得の100%');
  assert(bn * 100n === 50n * bd, '中小法人等以外の控除限度は所得の50%');
  assert(sme.value_key === big.value_key, '限度割合は同じ value_key');
  assert(JSON.stringify(sme.applicability_conditions) !== JSON.stringify(big.applicability_conditions),
    '中小法人等かどうかを条件で区別できる');

  // 所得1000万・繰越欠損金1200万
  const income = 10000000n, carried = 12000000n;
  const smeLimit = income * sn / sd;
  const bigLimit = income * bn / bd;
  assert((carried < smeLimit ? carried : smeLimit) === 10000000n,
    '中小法人等は所得1000万に対し1000万を控除できる（課税所得0）');
  assert((carried < bigLimit ? carried : bigLimit) === 5000000n,
    '中小法人等以外は500万しか控除できない（課税所得500万が残る）');
}

console.log('\n=== Test 5: 中小法人等の判定を軽減税率と混同しない ===');
{
  const sme = loss.get('CORP-LOSS-LIMIT-SME');
  assert(/66条5項|六十六条第五項/.test(sme._important || ''),
    '軽減税率の中小法人（66条5項）と条文が別である旨が記録されている');
  assert(/57条11項1号|五十七条第十一項第一号/.test(sme._sme_definition || ''),
    '中小法人等の定義の条文が記録されている');

  const blue = loss.get('CORP-LOSS-BLUE-RETURN-REQUIREMENT');
  assert(blue.requires_blue_return === true, '青色申告が要件である');
  assert(/控除できるものとして計算しない/.test(blue._simulator_rule || ''),
    '青色申告の有無が不明なら欠損金を控除しないと決めてある');
}

// ------------------------------------------------ 住民税の非課税限度額

console.log('\n=== Test 6: 住民税の属性による非課税 ===');
const rtDoc = load('resident-tax', 'exemption-thresholds.json');
const rt = new Map(collect(rtDoc).map(r => [r.record_id, r]));
{
  const w = rt.get('RT-EXEMPT-WELFARE');
  const s = rt.get('RT-EXEMPT-SPECIAL-STATUS');
  assert(w.value_key === s.value_key, '2つの属性は同じ value_key');
  assert(w.exemption_category !== s.exemption_category, '属性の種類で区別できる');
  assert(w.income_upper_inclusive === undefined,
    '生活扶助受給者に所得の上限は無い');
  assert(yen(s.income_upper_inclusive) === 1350000n,
    '障害者・未成年者・寡婦・ひとり親は合計所得135万円以下');
}

console.log('\n=== Test 7: 均等割の非課税限度額の基準 ===');
{
  const base = rt.get('RT-EXEMPT-PERCAPITA-BASE');
  const add = rt.get('RT-EXEMPT-PERCAPITA-ADD');
  const flat = rt.get('RT-EXEMPT-PERCAPITA-FLAT');
  assert(yen(base.threshold_amount) === 350000n, '基本額は35万円');
  assert(yen(add.threshold_amount) === 210000n, '加算額は21万円');
  assert(yen(flat.threshold_amount) === 100000n, '一律加算は10万円');

  const limit = (dependents) =>
    yen(base.threshold_amount) * BigInt(dependents + 1)
    + yen(flat.threshold_amount)
    + (dependents > 0 ? yen(add.threshold_amount) : 0n);

  // 公表されている1級地の限度額と突き合わせる（独立した裏付け）
  assert(limit(0) === 450000n, '単身は45万円（給与収入なら100万円に相当）');
  assert(limit(1) === 1010000n, '扶養1人（2人世帯）は101万円');
  assert(limit(2) === 1360000n, '扶養2人（3人世帯）は136万円');

  // 給与収入への換算：給与所得控除の最低保障55万円を足す
  assert(limit(0) + 550000n === 1000000n,
    '単身の給与収入ベースが100万円になる（住民税均等割の壁と一致）');

  assert(add._condition && /有しない者には加算しない/.test(add._condition),
    '扶養がいない場合に加算額を足さないことが明記されている');
}

console.log('\n=== Test 8: 概算であることと適用範囲 ===');
{
  const base = rt.get('RT-EXEMPT-PERCAPITA-BASE');
  const add = rt.get('RT-EXEMPT-PERCAPITA-ADD');
  assert(/上限/.test(base._is_upper_bound || '') && /上限/.test(add._is_upper_bound || ''),
    '基本額・加算額が上限値であること（級地で下がる）が記録されている');
  assert(/条例/.test(rtDoc._critical_caveat || ''),
    '市町村の条例で定まるため全国一律ではない旨が記録されている');
  assert(/概算/.test(rtDoc._simulator_rule || ''),
    '自治体固有の額を確認していない場合は概算として表示すると決めてある');
  assert(/16歳未満/.test(rtDoc.per_capita_threshold_standard?._dependent_scope || ''),
    '扶養親族に16歳未満を含む（所得税の扶養控除と違う）ことが記録されている');
  assert(/所得割/.test(rtDoc._income_threshold_note || '') &&
    /未登録/.test(rtDoc._income_threshold_note || ''),
    '所得割の非課税限度額が未登録であることが明示されている（均等割の値で代用しない）');
}

console.log('\n=== Test 9: 出典と承認状態 ===');
{
  const all = [...collect(ibtDoc), ...collect(lossDoc), ...collect(rtDoc)];
  assert(all.length === 14,
    `3ファイルで14レコード（個人事業税5・繰越欠損金4・住民税非課税5／実: ${all.length}）`);
  assert(all.every(r => r.source_document_id && r.source_locator),
    '全レコードに出典と条文の位置が記録されている');
  assert(all.every(r => r.value_key), '全レコードに value_key がある');
  assert(all.every(r => r.legal_status === 'effective'),
    '全レコードが施行済み（未施行の値を含まない）');
  assert(all.every(r => r.data_review_status === 'approved'),
    '全レコードが承認済み');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
