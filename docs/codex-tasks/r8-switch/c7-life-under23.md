# 台帳 C-7 — 23歳未満の扶養親族がいる場合の生命保険料控除の特例（令和8年分・令和9年分）

根拠: `docs/tax-simulator/r8-switch/c7-life-under23-sources.md`（一次資料・照合表。以下「照合表」）。この枝は `c13-c15-gate-resident-engine.md` の修正の上に作る。

## 背景

計算年を 2026 年にすると、23歳未満の扶養親族がいる人の新生命保険料の控除が最大 2万円少なく出る。特例を実装する。計算年は変えない（`SUPPORTED_YEAR = 2025` のまま）。2025 年の金額はひとつも変わらない。

## 決めたこと（Claude の設計判断。変えない）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D1 | 結果の前提に書いて済ませず、実装する | 該当者は子のいる世帯で、法人成り・役員報酬の検討者に多い。条文は表の読替えだけで単純 |
| D2 | 値の種類を分ける（`life_insurance_deduction_new_under23`）。今の `life_insurance_deduction_new` に段を足さない | 同じ値の種類に足すと、合計の上限の計算（区分の上限×3）が 18万円になる |
| D3 | 期間は 2026-01-01〜2027-12-31 | 措法41条の15の5 は令和8年分・令和9年分だけ |
| D4 | 対象は `life` の区分の新生命保険料だけ。介護医療・個人年金・旧生命保険料の表は変えない | 条文 |
| D5 | 新旧の両方を払った場合の `life` の区分の上限は 6万円。式は今の max(旧, min(新＋旧, 上限)) のまま上限だけ替える | 76条1項3号の読替え |
| D6 | 合計の上限は今の計算のまま（通常の区分の上限×3＝12万円）。特例の 6万円を掛けない | 76条4項は変わらない |
| D7 | 23歳未満の扶養親族の判定はエンジンが親族の行から行う。年齢が 23 未満で、所得が扶養親族の上限以下の親族が 1 人でもいれば該当。16歳未満も含む。配偶者は含まない。`totalIncome` が無い親族は上限以下として扱う | 所得税法 2条1項34号。`c13-c15` の D5 と同じ |
| D8 | 画面に「16歳未満」の人数の欄を足す。特例の有無の質問は作らない | 16〜22歳は今の欄で分かる。16歳未満だけ入力が無い。今のエンジンは 16歳未満を控除 0円で扱い、住民税の非課税の人数にも数えるので、親族の行を足すだけで正しく動く |
| D9 | 値の種類は `required` に置く | 記録が未承認のまま公開されると、該当者に黙って通常の表を使ってしまう。公開判定で止める |
| D10 | 記録が 0 件の年（2025 年以前・2028 年以後）は通常の表 | 特例の対象外の年なので |
| D11 | 住民税は変えない | 地方税法に対応する定めが無い |
| D12 | 特例を使った結果には前提の文を 1 件足す。`partial` にはしない | 法律の値で確定しており概算ではない |

## R1. `data/tax-simulator/masters/data/income-deduction/insurance-deductions.json`

`life_insurance_deduction` の中の `new_contract_tiers` の直後に `new_contract_tiers_under23` を足す。形（項目の並び）は `IDED-LIFE-NEW-T1`〜`T4` と同じ。

| 項目 | T1 | T2 | T3 | T4 |
| --- | --- | --- | --- | --- |
| `record_id` | `IDED-LIFE-NEW-U23-T1` | `-T2` | `-T3` | `-T4` |
| `calculation_order` | 1 | 2 | 3 | 4 |
| `rounding_rule_id` | 元の T1 と同じ | 元の T2 と同じ | 元の T3 と同じ | 元の T4 と同じ |
| `premium_lower_inclusive` | 0 | 30001 | 60001 | 120001 |
| `premium_upper_inclusive` | 30000 | 60000 | 120000 | `null` |
| `deduction_type` | `full_amount` | `formula` | `formula` | `fixed` |
| `rate` | `null` | 1/2 | 1/4 | `null` |
| `rate_addition` | `null` | 15000 | 30000 | `null` |
| `fixed_amount` | `null` | `null` | `null` | 60000 |
| `_formula` | `支払保険料等の全額` | `支払保険料等×1/2+15,000円` | `支払保険料等×1/4+30,000円` | `一律60,000円（区分ごとの上限）` |

共通

| 項目 | 値 |
| --- | --- |
| `value_key` | `life_insurance_deduction_new_under23` |
| `tax_year` | `null` |
| `promulgated_at` | `"2026-03-31"` |
| `verified_at`・`verified_by` | `null` |
| `effective_from` | `"2026-01-01"` |
| `effective_to` | `"2027-12-31"` |
| `deduction_category` | `life_insurance_new_under23` |
| `source_document_id` | `EGOV-SPECIAL-TAX-MEASURES` |
| `source_locator` | `租税特別措置法41条の15の5第1項（所得税法76条1項1号の読替え。今の版 332AC0000000026_20261101_507AC0000000013）` |
| `source_hash` | `null` |
| `as_of_date` | `"2026-11-01"` |
| `legal_status` | `"effective"` |
| `data_review_status` | `"unverified"` |

## R2. 依存表 `simulator-dependencies.json`

`hojinnari` と `yakuin_hoshu` の `required` の末尾に足す。

```json
{
  "_basis": "租税特別措置法41条の15の5（令和8年分・令和9年分）。23歳未満の扶養親族がいる人だけが使うが、未承認のまま公開すると該当者に黙って通常の表を使うので、必須に置いて公開判定で止める（台帳 C-7）",
  "value_keys": ["life_insurance_deduction_new_under23"]
}
```

## R3. `src/tax-engine/income/income-deductions.js`

1. `calculateLifeInsuranceDeduction(premiums = [], options = {}, { hasUnder23Dependent = false } = {})`。
   - `hasUnder23Dependent` が `true` のときだけ `masters.find('life_insurance_deduction_new_under23', searchCriterion)` を引く（使用記録に載せないため、該当しないときは引かない）。0 件なら特例なし。
   - 特例があるとき、`life` の区分だけ、新生命保険料の表をこの値の種類に、上限を `fixedTierCap('life_insurance_deduction_new_under23', searchCriterion)` に替える。ほかの区分と `overallCap` は変えない。
   - 戻り値に `under23SpecialApplied` を足す。特例があり、かつ `life` の新生命保険料が 0 円より大きいとき `true`。`rows` の形は変えない。
2. 内部の関数 `hasUnder23Dependent(dependents, searchCriterion)`: D7。扶養親族の上限の判定は `c13-c15` で足した処理を使い回す（同じことを二度書かない）。
3. `calculateIncomeDeductions`: この判定を生命保険料の計算に渡し、戻り値に `lifeInsuranceUnder23Applied` を足す。
4. `src/tax-engine/income/income-tax.js`: 結果に `lifeInsuranceUnder23Applied` を載せる（`incomeDeductionDetails` など、今 `lifeInsuranceRows` を載せている場所の近く）。

## R4. サービス

`src/simulators/hojinnari/service.js`（個人側・法人側の両方の所得税の計算）と `src/simulators/yakuin-hoshu/service.js`: `lifeInsuranceUnder23Applied` が `true` なら `assumptions` に次の文を 1 回だけ足す（①で個人側と法人側の両方に当たっても 1 回）。

`23歳未満の扶養親族がいるため、新生命保険料の控除は令和8年分・令和9年分の特例（上限6万円）で計算しています。住民税の生命保険料控除には、この特例はありません。`

## R5. 画面

1. `src/ui/family-input.js` の `DEPENDENT_BANDS` の**先頭**に足す。

   ```js
   Object.freeze({
     key: 'dependentsUnder16',
     label: '16歳未満',
     ageAtYearEnd: 10,
     relation: 'child',
     livesTogether: true,
   }),
   ```

2. `src/ui/hojinnari/app.js`・`src/ui/yakuin-hoshu/app.js`: 既定値 `dependentsUnder16: '0'`、エラーの対応表、`idSuffix` の `dependentsUnder16: 'under-16'`。人数の欄の近くに次の説明を 1 回足す（`shohizei-help` と同じ役割の説明の class を、それぞれの画面の既存のものから使う）。

   `16歳未満の子は扶養控除の対象ではありませんが、住民税の非課税の判定と、生命保険料控除の特例（令和8年分・令和9年分）に使います。`

3. ④→①の受け渡しなど、人数の項目を列挙している箇所があれば同じように足す。`grep dependents16To18 src` で全部確かめる。

## R6. 試験

金額は手計算で固定した。`scripts/lib/__tests__/test-income-tax-engine.js`。

### 表（`taxYear: 2026`、`hasUnder23Dependent: true`、新生命保険料だけ）

| 新生命保険料 | 特例の控除額 | 特例なしの控除額 |
| --- | --- | --- |
| 20,000 | 20,000 | 20,000 |
| 30,000 | 30,000 | 25,000 |
| 60,000 | 45,000 | 35,000 |
| 120,000 | 60,000 | 40,000 |
| 120,001 | 60,000 | 40,000 |
| 200,000 | 60,000 | 40,000 |

検算: 60,000 は 60,000×1/2＋15,000。通常の表は 60,000×1/4＋20,000。120,000 は 120,000×1/4＋30,000。

### 新旧の組み合わせ（同じ条件）

| 新 | 旧 | 特例の控除額 | 特例なしの控除額 |
| --- | --- | --- | --- |
| 120,000 | 100,000 | 60,000 | 50,000 |
| 10,000 | 100,000 | 60,000 | 50,000 |
| 0 | 100,000 | 50,000 | 50,000 |
| 30,000 | 25,000 | 55,000 | 40,000 |

検算: 3 行目まで旧の控除は 5 万円。4 行目は新 30,000（特例の T1）＋旧 25,000 ＝ 55,000 で上限 6 万円以下。特例なしは新 25,000＋旧 25,000 ＝ 50,000 で上限 4 万円。

### 区分と合計

- 介護医療・個人年金の新契約 200,000 は特例があっても 40,000。
- `life` 200,000・`nursing_medical` 200,000・`annuity` 200,000 は `amount` 120,000（6万＋4万＋4万の 14万円が 12 万円の上限で止まる）。`overallCap` は 120,000。

### 年

- `hasUnder23Dependent: true` で 2025 年は通常の表。2027 年は特例。2028 年は通常の表（2028 年は扶養の記録などの都合で全体が計算できなくても、この関数だけを確かめる）。

### 親族の判定（`calculateIncomeDeductions`、2026 年、新生命保険料 120,000）

| 親族 | 生命保険料控除 |
| --- | --- |
| なし | 40,000 |
| 10 歳 | 60,000 |
| 17 歳 | 60,000 |
| 22 歳・所得 620,000 | 60,000 |
| 22 歳・所得 620,001（特定親族） | 40,000 |
| 23 歳 | 40,000 |
| 配偶者 30 歳だけ | 40,000 |

`lifeInsuranceUnder23Applied` が 60,000 の行で `true`、それ以外で `false`。新生命保険料が 0 円のときは親族がいても `false`。

### 住民税

`test-resident-tax-engine.js`: 2026 年、新生命保険料 120,000、17 歳の親族の有無で、住民税の生命保険料控除が同じ（通常の表の 28,000 円）。

### サービス

- `test-hojinnari-service.js`・`test-yakuin-hoshu-service.js`: 2026 年に 17 歳の親族と新生命保険料 120,000 で、R4 の文が `assumptions` に 1 回だけある。`usedMasterRecords` に `IDED-LIFE-NEW-U23-T4` が載る。結果の状態を特例の有無で変えない。親族が 23 歳なら文も記録も無い。2025 年は 17 歳でも無い。

### 画面

- `test-hojinnari-ui.js`・`test-yakuin-ui.js`: 「16歳未満」の欄が出る。`dependentsUnder16: '2'` で `ageAtYearEnd: 10` の親族が 2 人渡る。空欄・`0` は 0 人。負の数・文字はエラー。説明の文が 1 回出る。
- `family-input` の既存の障害者の人数の確かめが、16歳未満の親族を数えても正しく動く。

既存の試験の金額が変わるときは止めて最終報告に書く（2025 年の結果は変わらないはず）。

## 変えてはいけないもの

- 既存の記録の値・`source-registry.json`・`data/nta-sources/`。
- 住民税の生命保険料控除の計算。
- `SUPPORTED_YEAR`・`versions.js`、公開用のまとめファイル。
- 文書（台帳・README・仕様書・照合表）。Claude が直す。

## 確かめること

1. `npm run masters:validate`。
2. `node scripts/approve-records.js` の内訳がこの 4 件だけ（書き込まない）。
3. **承認の試し**: 作業中のファイルに `node scripts/approve-records.js --by "試し" --write` → 上の試験と `test-simulator-dependencies.js`・`test-simulator-required-keys.js`・`test-golden-cases.js` を流す → **必ず元に戻す**（`verified_by` に `試し` が残っていないことを確かめる）。
4. `git status` で指示書に無いファイルが変わっていないこと。

`npm run masters:test` は Claude が隔離の外で流す。
