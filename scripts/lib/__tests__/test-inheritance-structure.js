'use strict';

/**
 * 法定相続分・法定相続人の数・相続時精算課税のマスターの検証。
 *   node scripts/lib/__tests__/test-inheritance-structure.js
 *
 * 間違えやすい点を固定する。
 *   - 相続放棄は民法では「初めから相続人でない」、相続税法では「なかったものとして数える」で逆
 *   - 兄弟姉妹の代襲は1代限り（再代襲なし）。子の代襲は再代襲がある
 *   - 900条4号の「嫡出でない子は2分の1」は削除済み。半血兄弟の2分の1は現在も有効
 *   - 相続時精算課税の基礎控除は本則60万円・措置法の特例110万円
 *   - 基礎控除110万円は毎年、特別控除2,500万円は累積で復活しない
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

// value_key を持つオブジェクトを深さ優先で全部集める
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
// 分数の比較。約分せずに交差乗算で比べる
const eqFrac = (r, num, den) => BigInt(r.num) * BigInt(den) === BigInt(num) * BigInt(r.den);

// ------------------------------------------------------------ 法定相続分

console.log('\n=== Test 1: 相続順位 ===');
const sharesDoc = load('inheritance-tax', 'statutory-shares.json');
const shares = new Map(collect(sharesDoc).map(r => [r.record_id, r]));
{
  assert(shares.get('MINPO-890-SPOUSE').rank === null,
    '配偶者に順位は無い（常に相続人・血族相続人と同順位）');
  assert(shares.get('MINPO-887-CHILD').rank === 1, '子は第1順位');
  assert(shares.get('MINPO-889-ASCENDANT').rank === 2, '直系尊属は第2順位');
  assert(shares.get('MINPO-889-SIBLING').rank === 3, '兄弟姉妹は第3順位');

  // 4区分は同じ value_key で共存する（条件で1つを選ぶ関係ではない）
  const ranks = ['MINPO-890-SPOUSE', 'MINPO-887-CHILD', 'MINPO-889-ASCENDANT', 'MINPO-889-SIBLING']
    .map(id => shares.get(id));
  assert(new Set(ranks.map(r => r.value_key)).size === 1, '4区分は同じ value_key');
  assert(new Set(ranks.map(r => r.heir_class)).size === 4, 'heir_class で区別できる');

  assert(/再代襲/.test(shares.get('MINPO-889-SIBLING')._substitution_trap || ''),
    '兄弟姉妹の代襲が1代限りであることが記録されている');
  assert(/887条2項だけ|八百八十七条第二項の規定は/.test(
    shares.get('MINPO-889-SIBLING')._substitution_trap + shares.get('MINPO-889-SIBLING').source_locator),
    '889条2項が準用するのは887条2項のみである根拠が残っている');
  assert(/代襲相続は無い|代襲相続が無い/.test(shares.get('MINPO-889-ASCENDANT')._no_substitution || ''),
    '直系尊属に代襲が無いことが記録されている');
}

console.log('\n=== Test 2: 組合せ別の法定相続分 ===');
{
  const cases = [
    ['MINPO-900-1-CHILD-SPOUSE', [1, 2], [1, 2], '子と配偶者は各2分の1'],
    ['MINPO-900-2-ASCENDANT-SPOUSE', [2, 3], [1, 3], '配偶者3分の2・直系尊属3分の1'],
    ['MINPO-900-3-SIBLING-SPOUSE', [3, 4], [1, 4], '配偶者4分の3・兄弟姉妹4分の1'],
  ];
  for (const [id, sp, bl, label] of cases) {
    const r = shares.get(id);
    assert(eqFrac(r.spouse_share, sp[0], sp[1]) && eqFrac(r.blood_relative_share, bl[0], bl[1]), label);
    // 配偶者分＋血族分＝1 になること
    const a = BigInt(r.spouse_share.num) * BigInt(r.blood_relative_share.den);
    const b = BigInt(r.blood_relative_share.num) * BigInt(r.spouse_share.den);
    const d = BigInt(r.spouse_share.den) * BigInt(r.blood_relative_share.den);
    assert(a + b === d, `${label}: 合計が1になる`);
  }

  assert(eqFrac(shares.get('MINPO-900-SPOUSE-ONLY').spouse_share, 1, 1),
    '血族相続人がいなければ配偶者が全部');
  assert(eqFrac(shares.get('MINPO-900-NO-SPOUSE').blood_relative_share, 1, 1),
    '配偶者がいなければ血族相続人が全部');

  // 5レコードすべてが条件で選び分けられる（同時に成立してはいけない）
  const combos = collect(sharesDoc).filter(r => r.value_key === 'statutory_share_by_combination');
  assert(combos.length === 5, `組合せは5通り（実: ${combos.length}）`);
  assert(combos.every(r => Array.isArray(r.applicability_conditions) && r.applicability_conditions.length > 0),
    '5通りすべてに機械可読な適用条件がある');
  assert(new Set(combos.map(r => JSON.stringify(r.applicability_conditions.map(c => [c.subject, c.operator, c.value])))).size === 5,
    '5通りの条件がすべて異なる');
}

console.log('\n=== Test 3: 同順位者の分け方 ===');
{
  const eq = shares.get('MINPO-900-4-EQUAL');
  const half = shares.get('MINPO-900-4-HALF-BLOOD');
  assert(eq.division_method === 'equal', '同順位者は均等');
  assert(eqFrac(half.half_blood_ratio, 1, 2), '半血兄弟姉妹は全血の2分の1');
  assert(/削除|適用されない/.test(eq._repealed_provision || ''),
    '嫡出でない子のただし書が削除済みであることが記録されている');
  assert(/現在も有効/.test(half._still_effective || ''),
    '半血のただし書が現在も有効であることが記録されている');
  assert(eq.effective_from === '2013-09-05' && half.effective_from === '2013-09-05',
    '現行の900条4号は平成25年9月5日以後に開始した相続に適用（改正法附則2項）');

  // 全血2人・半血1人 → 全血 2/5 ずつ・半血 1/5
  const N = 2n, M = 1n;
  const denom = 2n * N + M;
  assert(denom === 5n && 2n * N + M * 1n === 5n, '全血2人・半血1人なら分母は5');

  const sub = shares.get('MINPO-901-SUBSTITUTION');
  assert(sub.division_method === 'inherit_substituted_share',
    '代襲相続人は被代襲者の相続分をそのまま受ける');
}

console.log('\n=== Test 4: 民法と相続税法の食い違いが記録されている ===');
{
  assert(/939/.test(sharesDoc._renunciation_note || '') && /15条2項/.test(sharesDoc._renunciation_note || ''),
    '相続放棄の扱いが民法と相続税法で逆であることが記録されている');
  assert(/同一視しない/.test(sharesDoc._not_a_tax_law || ''),
    '民法上の相続人と相続税法上の法定相続人の数を同一視しない旨が記録されている');
}

// -------------------------------------------------- 法定相続人の数

console.log('\n=== Test 5: 相続税法上の法定相続人の数 ===');
const countDoc = load('inheritance-tax', 'heir-count-rules.json');
const count = new Map(collect(countDoc).map(r => [r.record_id, r]));
{
  const ren = count.get('IHT-HEIRCOUNT-RENUNCIATION');
  assert(ren.treat_renunciation_as_not_occurred === true,
    '相続放棄はなかったものとして数える');
  assert(/非課税の適用を受けられない/.test(ren._insurance_exception || ''),
    '人数には数えるが保険金非課税は受けられない、という食い違いが記録されている');

  const withReal = count.get('IHT-HEIRCOUNT-ADOPTED-WITH-REAL');
  const noReal = count.get('IHT-HEIRCOUNT-ADOPTED-NO-REAL');
  assert(withReal.adopted_children_countable === 1, '実子がいれば養子は1人まで');
  assert(noReal.adopted_children_countable === 2, '実子がいなければ養子は2人まで');
  assert(withReal.value_key === noReal.value_key, '2つの制限は同じ value_key');
  assert(JSON.stringify(withReal.applicability_conditions) !== JSON.stringify(noReal.applicability_conditions),
    '実子の有無で選び分けられる');
}

console.log('\n=== Test 6: 実子とみなす者 ===');
{
  const deemed = collect(countDoc).filter(r => r.value_key === 'statutory_heir_count_deemed_real_child');
  assert(deemed.length === 2, `実子とみなす者は2区分（実: ${deemed.length}）`);
  const kinds = deemed.flatMap(r => r.applicability_conditions.flatMap(c =>
    Array.isArray(c.value) ? c.value : [c.value]));
  assert(kinds.includes('special_adoption'), '特別養子が含まれる');
  assert(kinds.includes('step_child_of_spouse'), '配偶者の実子で養子となった者が含まれる');
  assert(kinds.includes('substitute_for_descendant'), '代襲相続人となった直系卑属が含まれる');

  const sp = count.get('IHT-HEIRCOUNT-DEEMED-REAL-SPECIAL');
  assert(/2つを同時に誤る|同時に誤る/.test(sp._double_effect || ''),
    '実子とみなされることで養子枠が1人に減る二重の効果が記録されている');
  assert(/政令|施行令/.test(sp._ordinance_pending || ''),
    '「政令で定める者」が未登録であることが記録されている');

  // 計算手順が書かれている（実装者が順序を誤らないため）
  assert(Array.isArray(countDoc._calculation_procedure) && countDoc._calculation_procedure.length >= 5,
    '人数の算定手順が段階として記録されている');
  assert(/63条/.test(countDoc._anti_abuse_note || ''),
    '養子の否認規定（相法63条）に触れており、シミュレーターは判定しない旨が記録されている');
}

// ------------------------------------------------ 相続時精算課税

console.log('\n=== Test 7: 相続時精算課税の適用要件 ===');
const stDoc = load('inheritance-tax', 'settlement-taxation.json');
const st = new Map(collect(stDoc).map(r => [r.record_id, r]));
{
  const e = st.get('IHT-SETTLEMENT-ELIGIBILITY');
  assert(e.recipient_min_age === 18, '受贈者は18歳以上');
  assert(e.donor_min_age === 60, '贈与者は60歳以上');
  assert(e.age_determination_date === 'january_1_of_gift_year',
    '年齢はその年1月1日で判定する（贈与日ではない）');
  assert(e.effective_from === '2022-04-01',
    '18歳への引下げは令和4年4月1日から（成年年齢引下げに伴う）');
  assert(/撤回できない/.test(e._irrevocable || ''),
    '届出を撤回できず暦年課税へ戻せないことが記録されている');
}

console.log('\n=== Test 8: 基礎控除は本則60万円・特例110万円 ===');
{
  const law = st.get('IHT-SETTLEMENT-BASIC-DEDUCTION-LAW');
  const spc = st.get('IHT-SETTLEMENT-BASIC-DEDUCTION-SPECIAL');
  assert(yen(law.deduction_amount) === 600000n, '相続税法本則は60万円');
  assert(yen(spc.deduction_amount) === 1100000n, '措置法の特例は110万円');
  assert(law.value_key === spc.value_key, '2つは同じ value_key');
  assert(law.provision_kind === 'general_law' && spc.provision_kind === 'special_measures_law',
    '本則と特例を区別できる');
  assert(law.source_document_id === 'EGOV-INHERITANCE-TAX-ACT'
    && spc.source_document_id === 'EGOV-SPECIAL-TAX-MEASURES',
    '出典が相続税法と租税特別措置法に分かれている');
  assert(spc.effective_from === '2024-01-01', '特例は令和6年1月1日以後の贈与から');
  assert(/こちらを使わない/.test(law._do_not_use_alone || ''),
    '本則60万円を計算に使わない旨が記録されている');
  assert(/本則|60万円|六十万円/.test(stDoc._critical_trap?.['本則は60万円・特例が110万円'] || ''),
    '110万円が措置法の特例である罠が文書の先頭に記録されている');
}

console.log('\n=== Test 9: 特別控除と税率 ===');
{
  const sd = st.get('IHT-SETTLEMENT-SPECIAL-DEDUCTION');
  assert(yen(sd.deduction_amount) === 25000000n, '特別控除は2,500万円');
  assert(sd.is_cumulative === true, '累積枠である（毎年使えるわけではない）');
  assert(sd.per_donor === true, '特定贈与者ごとの枠である');
  assert(/復活しない/.test(sd._no_revival || ''), '使い切った枠が復活しないことが記録されている');
  assert(/順序を逆にしない|前条第一項の規定による控除後/.test((sd._order || '') + (sd._verbatim || '')),
    '基礎控除を先に引き、その後に特別控除を引く順序が記録されている');

  const rate = st.get('IHT-SETTLEMENT-RATE');
  const [n, d] = [BigInt(rate.rate.num), BigInt(rate.rate.den)];
  assert(n * 100n === 20n * d, '税率は一律20%');
  assert(/超過累進|税率表を適用しない/.test(rate._not_progressive || ''),
    '暦年課税の税率表を使わないことが記録されている');

  // 1年で3,000万円贈与した場合: (3000万 − 110万 − 2500万) × 20% = 78万円
  const gift = 30000000n;
  const afterBasic = gift - yen(st.get('IHT-SETTLEMENT-BASIC-DEDUCTION-SPECIAL').deduction_amount);
  const afterSpecial = afterBasic - yen(sd.deduction_amount);
  assert(afterSpecial * n / d === 780000n,
    '3,000万円の贈与で贈与税78万円になる（110万→2,500万→20%の順）');
}

console.log('\n=== Test 10: 相続時の加算 ===');
{
  const ab = st.get('IHT-SETTLEMENT-ADDBACK');
  assert(ab.addback_basis === 'value_after_basic_deduction',
    '加算するのは基礎控除後の残額');
  assert(ab.addback_period_years === null,
    '暦年課税の生前贈与加算と違い年数の制限が無い');
  assert(/贈与時の価額/.test(ab._valuation_date || ''),
    '加算する価額が贈与時の価額であることが記録されている');
  assert(/みなす/.test(ab._basic_deduction_effect || ''),
    '措置法の110万円控除が相法21条の11の2による控除とみなされる旨が記録されている');
  assert(/別制度/.test(stDoc._relation_to_gift_addback || ''),
    '暦年課税の生前贈与加算と別制度であることが記録されている');

  // 5年間 毎年110万円ずつ贈与 → 加算額0円
  const basic = yen(st.get('IHT-SETTLEMENT-BASIC-DEDUCTION-SPECIAL').deduction_amount);
  let addback = 0n;
  for (let y = 0; y < 5; y++) {
    const g = 1100000n;
    addback += (g > basic ? g - basic : 0n);
  }
  assert(addback === 0n, '毎年110万円ちょうどの贈与を5年続けても相続財産への加算は0円');
}

console.log('\n=== Test 11: 出典と承認状態 ===');
{
  const all = [...collect(sharesDoc), ...collect(countDoc), ...collect(stDoc)];
  assert(all.length === 23,
    `3ファイルで23レコード（法定相続分12・法定相続人の数5・相続時精算課税6／実: ${all.length}）`);
  assert(all.every(r => r.source_document_id && r.source_locator),
    '全レコードに出典と条文の位置がある');
  assert(all.every(r => r.legal_status === 'effective'), '全レコードが施行済み');
  assert(all.every(r => r.data_review_status === 'approved'), '全レコードが承認済み');
  assert(all.filter(r => r._verbatim).length >= 8,
    '主要な規定は条文の文言をそのまま保存している（出典URLの死活に依存せず照合できる）');

  const ids = new Set(['EGOV-CIVIL-CODE', 'EGOV-INHERITANCE-TAX-ACT', 'EGOV-SPECIAL-TAX-MEASURES']);
  const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, '..', 'sources', 'source-registry.json'), 'utf8'));
  for (const id of ids) assert(!!registry.sources[id], `出典 ${id} が台帳に登録されている`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
