'use strict';

/**
 * マスターデータの形式検証
 *
 *   node masters/scripts/validate-masters.js
 *
 * 鮮度チェック（check-master-freshness.js）が「今の法令に追いついているか」を見るのに対し、
 * こちらは「データとして壊れていないか」を見る。
 *
 *   - Money / Rate が仕様どおりの型か（§3-2。浮動小数を混ぜていないか）
 *   - 段階表に隙間や重なりが無いか
 *   - rounding_rule_id が端数規則表に存在するか
 *   - record_id が重複していないか
 *   - 日付の前後が逆になっていないか
 *
 * 税率の値そのものが正しいかは、ここでは判定できない（出典を読む人の仕事）。
 * ここで見るのは、計算エンジンに渡したときに壊れる形になっていないか。
 */

const fs = require('fs');
const path = require('path');

const MASTERS_DIR = process.env.MASTERS_DIR
  ? path.resolve(process.env.MASTERS_DIR)
  : path.join(__dirname, '..', 'data', 'tax-simulator', 'masters');
const DATA_DIR = path.join(MASTERS_DIR, 'data');

const LEGAL_STATUS = ['draft', 'announced', 'enacted', 'effective', 'expired', 'repealed'];
const REVIEW_STATUS = ['unverified', 'single_checked', 'double_checked', 'approved', 'blocked'];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listDataFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...listDataFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

function collectRecords(node, acc) {
  if (Array.isArray(node)) {
    for (const i of node) collectRecords(i, acc);
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.record_id === 'string') { acc.push(node); return acc; }
  for (const v of Object.values(node)) collectRecords(v, acc);
  return acc;
}

// ── 型の検証 ──────────────────────────────────────────────────
const MONEY_KEYS = /(_amount|_standard|amount|_result|_step|quick_deduction)$/;
const RATE_KEYS = /(^rate$|_rate$|deemed_purchase_rate|deductible_rate|combined_rate)/;

function isMoney(v) {
  return v && typeof v === 'object' && v.unit === 'JPY' && typeof v.value === 'string';
}
function isRate(v) {
  return v && typeof v === 'object' && typeof v.num === 'string' && typeof v.den === 'string';
}

function checkTypes(rec, file, errors) {
  for (const [key, val] of Object.entries(rec)) {
    if (key.startsWith('_')) continue;          // 注記は対象外
    if (val === null || val === undefined) continue;

    if (MONEY_KEYS.test(key)) {
      if (!isMoney(val)) {
        errors.push(`${rec.record_id} (${file}): ${key} が Money 型でない → ${JSON.stringify(val)}`);
        continue;
      }
      if (!/^-?[0-9]+$/.test(val.value)) {
        errors.push(`${rec.record_id} (${file}): ${key}.value が整数文字列でない → "${val.value}"（小数や数値型は不可）`);
      }
    }

    if (RATE_KEYS.test(key)) {
      if (!isRate(val)) {
        errors.push(`${rec.record_id} (${file}): ${key} が Rate 型でない → ${JSON.stringify(val)}`);
        continue;
      }
      if (!/^-?[0-9]+$/.test(val.num) || !/^[1-9][0-9]*$/.test(val.den)) {
        errors.push(`${rec.record_id} (${file}): ${key} の num/den が整数文字列でない → ${JSON.stringify(val)}`);
      }
    }
  }
}

// ── 共通フィールドの検証 ──────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkCommon(rec, file, errors, warnings) {
  // value_key が無いと、エンジンは年度入りの record_id を直書きして値を引くしかなくなる。
  // それでは「税率をコードへ直接書かない」（§3-1）が守れない。
  if (!rec.value_key) {
    errors.push(`${rec.record_id} (${file}): value_key が無い（年度非依存の意味キーが必要）`);
  } else if (!/^[a-z][a-z0-9_]*$/.test(rec.value_key)) {
    errors.push(`${rec.record_id} (${file}): value_key は小文字スネークケースにすること → "${rec.value_key}"`);
  }
  if (rec.legal_status && !LEGAL_STATUS.includes(rec.legal_status)) {
    errors.push(`${rec.record_id} (${file}): legal_status が不正 → "${rec.legal_status}"`);
  }
  if (rec.data_review_status && !REVIEW_STATUS.includes(rec.data_review_status)) {
    errors.push(`${rec.record_id} (${file}): data_review_status が不正 → "${rec.data_review_status}"`);
  }
  if (!rec.data_review_status) {
    warnings.push(`${rec.record_id} (${file}): data_review_status が無い（公開可否を判定できない）`);
  }
  for (const k of ['effective_from', 'effective_to', 'as_of_date']) {
    const v = rec[k];
    if (v === null || v === undefined) continue;
    if (!DATE_RE.test(v)) errors.push(`${rec.record_id} (${file}): ${k} の書式が YYYY-MM-DD でない → "${v}"`);
  }
  if (rec.effective_from && rec.effective_to && rec.effective_from > rec.effective_to) {
    errors.push(`${rec.record_id} (${file}): effective_from が effective_to より後 → ${rec.effective_from} > ${rec.effective_to}`);
  }
  if (!rec.effective_from) {
    warnings.push(`${rec.record_id} (${file}): effective_from が無い（適用開始が不明）`);
  }
}

// ── 段階表の連続性 ────────────────────────────────────────────
function boundPair(rec) {
  const lo = Object.keys(rec).find(k => k.endsWith('_lower_inclusive'));
  const hi = Object.keys(rec).find(k => k.endsWith('_upper_inclusive'));
  if (!lo || !hi) return null;
  const loV = rec[lo], hiV = rec[hi];
  if (!isMoney(loV)) return null;                      // 下限が無い records は段階表でない
  return {
    lower: BigInt(loV.value),
    upper: isMoney(hiV) ? BigInt(hiV.value) : null,    // null は「以上」
    loKey: lo, hiKey: hi,
  };
}

/**
 * 区分のキー（適用期間を含まない）。
 *
 * value_key が「この値は何か」を年度に依存せず表す。段階表は全行が同じ value_key を共有し、
 * 行の区別は上下限が担う。計算エンジンは value_key と適用日でレコードを引くので、
 * ここで同じキーになるものは、エンジンから見て同じ候補集合に入る。
 *
 * business_type（簡易課税の事業区分）と jurisdiction は、同じ value_key の中で
 * 並列に存在する別軸なので区分に含める。
 */
function categoryKey(rec) {
  return [
    rec.value_key || `(value_key未設定:${rec.record_id})`,
    // 同じ value_key の中で並列に存在する別軸。
    // business_type は簡易課税の事業区分。
    // deduction_category / difference_category は控除の項目名で、
    // 「条件でどれか一つを選ぶ」のではなく「該当するものを全部合算する」関係にある
    // （調整控除の人的控除の差など）。項目が違えば別の表として扱う。
    // 税目。value_key が税目を含まない場合（tax_period_basis のように
    // 税目ごとに1レコードずつ並ぶもの）に必要。
    rec.tax_or_insurance_type || '',
    rec.business_type != null ? `bt${rec.business_type}` : '',
    rec.deduction_category || '',
    rec.difference_category || '',
    rec.insurance_type || '',
    rec.land_category || '',
    JSON.stringify(rec.jurisdiction || {}),
  ].join('|');
}

/**
 * 適用条件の指紋。同じ value_key・同じ期間でも、適用条件が違えば共存できる。
 * 例: 中小法人の軽減税率は通常15%だが、所得10億円超の事業年度は17%。
 */
function conditionKey(rec) {
  const c = rec.applicability_conditions;
  if (!Array.isArray(c) || c.length === 0) return '';
  // description は人が読むための説明なので同一性の判定に使わない。
  // 同じ条件でも書き方が違うだけで別グループになってしまう。
  return JSON.stringify(c.map(x => [x.subject, x.operator, x.value]));
}

/**
 * 同じ段階表とみなすキー。適用期間が違えば別世代の表。
 *
 * 適用条件も含める。同じ value_key でも条件が違えば並列の別表だから。
 * 例: 配偶者控除は「一般の控除対象配偶者」と「老人控除対象配偶者」で
 * 同じ所得区分の表が2本並ぶ。条件を無視すると重なりとして誤検知する。
 */
function seriesKey(rec) {
  return [categoryKey(rec), conditionKey(rec), rec.effective_from || '', rec.effective_to || ''].join('|');
}

function periodsOverlap(a, b) {
  const aFrom = a.effective_from || '0000-01-01';
  const aTo = a.effective_to || '9999-12-31';
  const bFrom = b.effective_from || '0000-01-01';
  const bTo = b.effective_to || '9999-12-31';
  return aFrom <= bTo && bFrom <= aTo;
}

function boundsLabel(rec) {
  const b = boundPair(rec);
  if (!b) return 'no-bounds';
  return `${b.lower}..${b.upper === null ? '∞' : b.upper}`;
}

/**
 * 同じ区分・同じ段階なのに適用期間が重なるレコードを探す。
 * 計算エンジンは「この日付に有効なレコード」を引くので、2件返ると
 * どちらを使うか決められない。条件付きで使い分けるなら、
 * その条件を機械が読めるフィールドに書く必要がある（_ 始まりの注記では選べない）。
 */
function checkOverlaps(allRecords, errors) {
  const byCategory = new Map();
  for (const { rec, file } of allRecords) {
    const k = `${categoryKey(rec)}##${boundsLabel(rec)}`;
    if (!byCategory.has(k)) byCategory.set(k, []);
    byCategory.get(k).push({ rec, file });
  }

  for (const [, items] of byCategory) {
    if (items.length < 2) continue;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (!periodsOverlap(a.rec, b.rec)) continue;

        // 適用条件が両方に書かれていて、かつ内容が違えば、エンジンは選び分けられる
        const ca = conditionKey(a.rec), cb = conditionKey(b.rec);
        if (ca && cb && ca !== cb) continue;

        errors.push(
          `適用期間の重なり: ${a.rec.record_id}（${a.rec.effective_from}〜${a.rec.effective_to || '無期限'}）と ` +
          `${b.rec.record_id}（${b.rec.effective_from}〜${b.rec.effective_to || '無期限'}）が ` +
          `value_key "${a.rec.value_key}" ・同じ段階で重なる。` +
          `applicability_conditions で使い分ける条件を機械可読に書くこと（${a.file}）`
        );
      }
    }
  }
}

/**
 * 段階の刻み幅。課税標準が1,000円未満切捨てなら、取りうる値は1,000の倍数しかない。
 * 所得税の速算表が 1,949,000 の次を 1,950,000 と書いているのはそのため。
 * 1円刻みで見ると隙間に見えるが、その間の値は存在しない。
 */
function bracketStep(rec, roundingUnits) {
  const unit = rec.rounding_rule_id ? roundingUnits.get(rec.rounding_rule_id) : null;
  return unit && unit > 0 ? BigInt(unit) : 1n;
}

function checkBrackets(records, file, errors, warnings, roundingUnits) {
  const series = new Map();
  for (const rec of records) {
    const b = boundPair(rec);
    if (!b) continue;
    const k = seriesKey(rec);
    if (!series.has(k)) series.set(k, []);
    series.get(k).push({ rec, b });
  }

  for (const [, items] of series) {
    if (items.length < 2) continue;
    items.sort((a, x) => (a.b.lower < x.b.lower ? -1 : a.b.lower > x.b.lower ? 1 : 0));

    for (let i = 0; i < items.length - 1; i++) {
      const cur = items[i], next = items[i + 1];
      if (cur.b.upper === null) {
        errors.push(`${cur.rec.record_id} (${file}): 上限なしの段階の後に ${next.rec.record_id} がある（順序が不正）`);
        continue;
      }
      const step = bracketStep(cur.rec, roundingUnits);
      const gap = next.b.lower - cur.b.upper;

      if (gap < 1n) {
        errors.push(
          `段階表に重なり (${file}): ${cur.rec.record_id} の上限 ${cur.b.upper} が ` +
          `${next.rec.record_id} の下限 ${next.b.lower} 以上`
        );
      } else if (gap > step) {
        // 刻み幅を超えて空いていると、その間に取りうる値があるのにどの段階にも入らない
        errors.push(
          `段階表に隙間 (${file}): ${cur.rec.record_id} の上限 ${cur.b.upper} と ` +
          `${next.rec.record_id} の下限 ${next.b.lower} の間に、` +
          `${step === 1n ? '' : `${step}円刻みで`}どの段階にも入らない値がある`
        );
      }
    }

    // 最上段が「以上」で閉じているか
    const last = items[items.length - 1];
    if (last.b.upper !== null) {
      warnings.push(`${last.rec.record_id} (${file}): 段階表の最上段に上限がある（上限超の入力を扱えない）`);
    }
    // 最下段より下の扱いが決まっているか。
    // 課税標準が1,000円未満切捨てなら、取りうる値は 0 か1,000以上しかない。
    // 所得税の速算表が1,000円から始まるのはそのためで、隙間ではない
    // （0〜999は切り捨てられて0になり、税額も0）。
    const first = items[0];
    const step = bracketStep(first.rec, roundingUnits);
    if (first.b.lower > step) {
      warnings.push(
        `${first.rec.record_id} (${file}): 段階表が ${first.b.lower} から始まる` +
        `（端数規則の刻みは ${step}）。0〜${first.b.lower - 1n} の入力に対する挙動を計算エンジン側で定義すること`
      );
    }
  }
}

// ── 中身が決まっているかの検査 ────────────────────────────────
// 項目を null で埋めれば充足率は100%になるが、それは「考えた上で該当なし」なのか
// 「まだ決めていない」のか区別がつかない。値が要るはずの場所だけを名指しで出す。

/** 金額を生む（＝端数処理の判断が要る）レコードか */
function producesMoney(rec) {
  return Object.entries(rec).some(([k, v]) =>
    !k.startsWith('_') && MONEY_KEYS.test(k) && isMoney(v)
  ) || Object.entries(rec).some(([k, v]) =>
    !k.startsWith('_') && RATE_KEYS.test(k) && isRate(v)
  );
}

function checkSubstance(allRecords, warnings) {
  const noRounding = [];
  const noLocator = [];
  for (const { rec, file } of allRecords) {
    if (producesMoney(rec) && rec.rounding_rule_id === null) {
      noRounding.push(`${rec.record_id} (${file})`);
    }
    if (!rec.source_locator) {
      noLocator.push(`${rec.record_id} (${file})`);
    }
  }
  if (noRounding.length) {
    warnings.push(
      `端数処理が未決定のレコード ${noRounding.length} 件: 金額・率を持つが rounding_rule_id が null。` +
      `丸めが不要なら端数規則表に「丸めなし」の規則を作って明示すること。該当: ` +
      noRounding.slice(0, 8).join(', ') + (noRounding.length > 8 ? ` ほか${noRounding.length - 8}件` : '')
    );
  }
  if (noLocator.length) {
    warnings.push(
      `出典内の位置が未記載のレコード ${noLocator.length} 件: source_locator が無く、` +
      `出典のどこを見れば確認できるか分からない。該当: ` +
      noLocator.slice(0, 8).join(', ') + (noLocator.length > 8 ? ` ほか${noLocator.length - 8}件` : '')
    );
  }
}

/**
 * 台帳にあるのにどのレコードからも参照されていない出典を探す。
 * 使われない出典を監視し続けると、鮮度チェックが鳴り続けて無視されるようになる。
 * 端数規則の根拠のように、レコードから参照しないが残す必要があるものは
 * reference_only: true を立てて除外する。
 */
function checkOrphanSources(allRecords, registryPath, warnings) {
  if (!fs.existsSync(registryPath)) return;
  const reg = readJson(registryPath);
  const used = new Set(allRecords.map(({ rec }) => rec.source_document_id).filter(Boolean));
  const orphans = Object.entries(reg.sources || {})
    .filter(([id, s]) => !used.has(id) && !s.reference_only
      // 年度カバレッジの対象は、レコードが無いこと自体を鮮度チェックが報告するので二重に出さない
      && (!s.coverage_basis || s.coverage_basis === 'none'))
    .map(([id, s]) => `${id}（${s.label}）`);
  if (orphans.length) {
    warnings.push(
      `どのレコードからも参照されていない出典 ${orphans.length} 件: ` +
      `使わないなら台帳から外し、参照しないが残すなら reference_only: true を立てること。該当: ${orphans.join(', ')}`
    );
  }
}

// ── 仕様書 §3-1 が要求するフィールドの充足率 ──────────────────
// 個々のレコードごとに警告を出すと106件×十数項目で読めなくなるため、
// 「どのフィールドが何件で埋まっているか」を一覧にする。
const SPEC_REQUIRED = [
  'value_key', 'jurisdiction', 'tax_or_insurance_type', 'effective_from', 'effective_to',
  'as_of_date', 'legal_status', 'data_review_status', 'source_document_id',
];
const SPEC_EXPECTED = [
  'tax_year', 'calculation_order', 'rounding_rule_id',
  'source_locator', 'source_hash', 'promulgated_at', 'verified_at', 'verified_by',
  'applies_to_period_start_from', 'applies_to_period_start_to',
  'applies_to_transaction_from', 'applies_to_transaction_to',
];

function specCoverage(allRecords) {
  const count = (field) => allRecords.filter(({ rec }) =>
    Object.prototype.hasOwnProperty.call(rec, field)).length;
  return {
    total: allRecords.length,
    required: SPEC_REQUIRED.map(f => ({ field: f, present: count(f) })),
    expected: SPEC_EXPECTED.map(f => ({ field: f, present: count(f) })),
  };
}

// ── main ──────────────────────────────────────────────────────
function main() {
  const errors = [];
  const warnings = [];
  const seenIds = new Map();

  // 端数規則の一覧
  const roundingPath = path.join(DATA_DIR, 'rounding-rules', 'rules.json');
  const roundingIds = new Set();
  const roundingUnits = new Map();
  if (fs.existsSync(roundingPath)) {
    for (const r of readJson(roundingPath).rules || []) {
      roundingIds.add(r.rounding_rule_id);
      roundingUnits.set(r.rounding_rule_id, r.unit);
    }
  } else {
    errors.push('端数規則表 data/rounding-rules/rules.json が見つかりません');
  }

  let total = 0;
  const allRecords = [];
  for (const f of listDataFiles(DATA_DIR)) {
    const rel = path.relative(MASTERS_DIR, f).replace(/\\/g, '/');
    let data;
    try {
      data = readJson(f);
    } catch (e) {
      errors.push(`${rel}: JSON として読めません → ${e.message}`);
      continue;
    }
    const records = collectRecords(data, []);
    total += records.length;

    for (const rec of records) {
      allRecords.push({ rec, file: rel });
      if (seenIds.has(rec.record_id)) {
        errors.push(`record_id の重複: "${rec.record_id}" が ${seenIds.get(rec.record_id)} と ${rel} の両方にある`);
      } else {
        seenIds.set(rec.record_id, rel);
      }
      checkTypes(rec, rel, errors);
      checkCommon(rec, rel, errors, warnings);

      if (rec.rounding_rule_id && !roundingIds.has(rec.rounding_rule_id)) {
        errors.push(`${rec.record_id} (${rel}): rounding_rule_id "${rec.rounding_rule_id}" が端数規則表に無い`);
      }
    }
    checkBrackets(records, rel, errors, warnings, roundingUnits);
  }

  checkOverlaps(allRecords, errors);
  checkSubstance(allRecords, warnings);
  checkOrphanSources(allRecords, path.join(MASTERS_DIR, 'sources', 'source-registry.json'), warnings);

  // ── 出力 ──
  console.log(`マスターデータ形式検証: ${total} レコード / ${listDataFiles(DATA_DIR).length} ファイル\n`);

  if (errors.length > 0) {
    console.log(`■ エラー（${errors.length} 件）— 計算エンジンに渡すと壊れます`);
    errors.forEach(e => console.log(`  - ${e}`));
    console.log('');
  }
  if (warnings.length > 0) {
    console.log(`■ 警告（${warnings.length} 件）— 設計判断の確認が要ります`);
    warnings.forEach(w => console.log(`  - ${w}`));
    console.log('');
  }
  if (errors.length === 0 && warnings.length === 0) {
    console.log('■ 形式上の問題は見つかりませんでした\n');
  }

  // 仕様書 §3-1 の充足率
  const cov = specCoverage(allRecords);
  console.log(`■ 仕様書 §3-1 のフィールド充足率（${cov.total} レコード中）`);
  console.log('  [必須]');
  for (const { field, present } of cov.required) {
    const mark = present === cov.total ? '✓' : '✗';
    console.log(`    ${mark} ${field.padEnd(30)} ${present}/${cov.total}`);
  }
  console.log('  [仕様書が列挙しているが未充足のもの]');
  for (const { field, present } of cov.expected) {
    const mark = present === cov.total ? '✓' : present === 0 ? '✗' : '△';
    console.log(`    ${mark} ${field.padEnd(30)} ${present}/${cov.total}`);
  }
  console.log('');

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    fs.appendFileSync(ghOut, `errors=${errors.length}\n`);
    fs.appendFileSync(ghOut, `warnings=${warnings.length}\n`);
  }

  if (errors.length > 0) process.exitCode = 1;
}

module.exports = { collectRecords, boundPair, seriesKey, checkBrackets, isMoney, isRate };

if (require.main === module) main();
