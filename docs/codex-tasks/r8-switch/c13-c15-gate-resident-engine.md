# 台帳 C-13・C-15（エンジンの分） — 公開判定の必須の値と、住民税の配偶者・扶養の所得判定

根拠: 台帳 `docs/tax-simulator/deferred-items.md` の C-13・C-15、地方税法 34条1項6号・10号の2・11号・12号、37条、所得税法 79条。

マスターの JSON の値はこの指示書では変えない（依存表 `simulator-dependencies.json` だけ変える）。62万円の記録と出典の差し替えは次の PR で行う。

## 背景

### C-13

依存表は「必須＝主要結果に不可欠」「任意＝特定の入力があるときだけ使う」と分けている。公開判定（`masters:gate`）は**必須だけ**を見て公開の可否を決める。ところが、家族も控除もない最小の入力で値を 1 つずつ空にして調べると（Claude が 2026-11-01 に実行）、任意に置かれた次の 16 件は、どれが欠けても①④の計算が例外か `blocked` で止まる。

```
income_deduction_specific_relative_special
life_insurance_deduction_new
life_insurance_deduction_old
earthquake_insurance_deduction
donation_deduction_income_cap_rate
donation_deduction_floor
resident_tax_life_insurance_deduction_new
resident_tax_life_insurance_deduction_old
resident_tax_life_insurance_total_cap
resident_tax_earthquake_insurance_deduction
resident_tax_earthquake_insurance_total_cap
donation_basic_credit_rate
furusato_special_credit_rate_table
furusato_special_credit_cap_rate
furusato_special_credit_allocation
resident_tax_housing_loan_credit_limit
```

つまり公開判定は「公開可能」と言うのに、すべての計算が止まる状態がありうる。止まる側なので誤った金額は出ないが、公開判定が役に立っていない。

### C-15

住民税エンジン（`src/tax-engine/resident-tax/resident-tax.js`）の `calculateSpouseDeduction` は、呼び出し側が `claimsSpouseSpecialDeduction` か `deductionType: 'special'` を渡したときだけ配偶者特別控除を見る。①④のサービスも画面もこの指定を渡さない（`src/` に 0 件）。その結果、**配偶者の所得がいくらでも配偶者控除の満額が出る。公開中の令和7年分の結果にもある不具合。**

本人の合計所得 600 万円での実測:

| 配偶者の合計所得 | 今の結果（住民税の控除・税額） | 正しい結果 |
| --- | --- | --- |
| 0 円 | 配偶者控除 33 万円・526,500 円 | 同じ |
| 130 万円 | 配偶者控除 33 万円・526,500 円 | 配偶者特別控除 6 万円・553,500 円 |
| 200 万円 | 配偶者控除 33 万円・526,500 円 | 控除なし・559,500 円 |

所得税のエンジン（`src/tax-engine/income/income-deductions.js`）は配偶者の所得で正しく分けている。住民税だけ漏れている。

## 決めたこと（Claude の設計判断。変えない）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D1 | C-13 は 16 件を必須へ移す。エンジンの引き方は変えない | 依存表の説明に「判断が分かれるものは必須側へ置く」とある。エンジンを遅延にすると使用記録が変わり、影響が広い |
| D2 | 依存表と実際の計算のずれを試験で見張る（R2） | 手で移しただけだと、また同じ穴が開く |
| D3 | 住民税も所得税と同じく、配偶者・親族の**所得だけ**で控除の種類を決める。`claimsSpouseSpecialDeduction`・`deductionType` は読むのをやめる。`claimsDependentDeduction` と `claimsSpecificRelativeSpecialDeduction` の重複の止める確かめは残すが、`claimsSpecificRelativeSpecialDeduction` で特定親族の表へ進む分岐はなくす | 控除の種類は法律で所得によって決まり、選べない。所得税のエンジン（`calculateSpouseDeduction`・`calculateDependentDeductions`）と同じ形にする |
| D4 | 配偶者の上限は、記録 `resident_tax_deduction_spouse_special` の最下段 `spouse_special_s1` の下限 − 1 から導く。親族の上限は `resident_tax_deduction_specific_relative_special` の `calculation_order === 0` の段の上限。どちらも所得税のエンジンと同じ止まる確かめを付ける | 次の PR で年を分けて記録を足すと、値はそこから自動で決まる。記録の欠け・重なりで黙って違う上限を使わない |
| D5 | `totalIncome` が無い親族は、今までどおり上限以下として扱う（所得 0 円の親族。既存の試験と画面の入力がこの前提）。配偶者の `totalIncome` が無いときは今までどおり `null`（控除なし） | 既存の動作を変えない |
| D6 | 障害者控除の対象は、本人・**同一生計配偶者**・**扶養親族**に限る。配偶者・親族の所得が上限を超えていたら、その人の障害者控除は付けない（住民税・所得税の両方）。`totalIncome` が無い人は今までどおり対象 | 地方税法 34条1項6号・所得税法 79条2項。配偶者の所得判定を入れるのと同じ理由で、同じ PR で直す |
| D7 | 均等割の非課税の人数（施行令47条の3）も同じ。所得が上限を超える配偶者・親族は数えない | 「同一生計配偶者及び扶養親族の数」なので |
| D8 | 調整控除の警告 `RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED` はなくす。配偶者特別控除・特定親族特別控除には、調整控除の差は 0 円 | 地方税法 37条1号イの表: 特定親族の欄は無い。配偶者特別控除の欄（7）は「前年の合計所得金額が五十五万円未満」の配偶者に限るが、58万円以下は控除対象配偶者なので、この欄に当たる人はいない。「未登録」は誤りで、配偶者の所得を見るようになると公開の結果に毎回出てしまう |
| D9 | 住民税の生命保険料控除・基礎控除は変えない | 措法41条の15の5・41条の16の2 は所得税の控除の特例で、住民税には及ばない（地方税法 34条1項5号・2項に定めが無い） |
| D10 | 給与所得は変えない | 令和9年度分・令和10年度分の住民税にも措法29条の4（74万円）が及ぶことを確認済み（地方税法 32条2項・313条2項、大綱の地方税の部、自治体の公式説明）。今のエンジンの動きで正しい |

## R1. `data/tax-simulator/masters/simulator-dependencies.json`

1. 冒頭の 16 件を、`hojinnari` と `yakuin_hoshu` の `optional` の各 `value_keys` から消す。
2. 両方の `required` の末尾に、次の 1 組を足す（16 件はこの順）。

   ```json
   {
     "_basis": "台帳 C-13。入力が0件でもエンジンが毎回引く値。income-deductions.js の calculateIncomeDeductions（扶養の上限・生命保険料・地震保険料・寄附金）と resident-tax.js の所得控除・ふるさと納税・住宅ローン控除の計算が、入力の有無にかかわらず記録を読む。欠けると計算が止まるので必須に置く",
     "value_keys": [ ...冒頭の 16 件... ]
   }
   ```
3. `optional` の `_basis` の文のうち、移した値についての説明が残って嘘になる場合だけ、その文を直す。それ以外の文は変えない。値の無くなった組は消す。
4. `shohizei`・`sozoku` は、R2 の試験で同じ穴が見つかったときだけ直す（同じ形で必須へ移す）。見つかったものは最終報告に書く。

## R2. 試験 `scripts/lib/__tests__/test-simulator-required-keys.js`（新規）

依存表の `optional` が本当に任意かを、実際の計算で確かめる。

- `require.cache` で `src/tax-engine/masters/snapshot.js` の `exports` を差し替え、`find`・`peek` を包む（`exports` は凍結されているので、`Object.assign({}, real, {...})` で新しい物にする。サービスを `require` するより前に差し替える）。指定の `value_key` だけ `[]` を返す。
- 4 サービスそれぞれ、最小の入力で計算する。
  - ①: `test-hojinnari-service.js` の `goldenInput()` と同じ形で、`blueReturn` の青色申告特別控除を使わず、`nationalPension` は実額の入力にする（`blue_return_special_deduction` と `national_pension_*` を引かないため）。実額の入力が通らないときは、その 2 種類だけを理由のコメント付きの除外の一覧に入れる。
  - ④: `test-yakuin-hoshu-service.js` の `modeCInput()`。
  - ②: `test-shohizei-service.js` の `detailedInput()`。
  - ③: `test-sozoku-service.js` の最小の入力。
- 手順: (1) 差し替えなしで計算し、完了することと、引いた `value_key` の集合を取る。(2) 引いた値のうち依存表の `required` にも `optional` にも無いものが 0 件。(3) 引いた値のうち `optional` のものを 1 つずつ空にして計算し、例外も `blocked` も出ないことを確かめる。
- `package.json` の `masters:test` の一覧に足す。`test-simulator-dependencies.js` の直後。

## R3. `src/tax-engine/resident-tax/resident-tax.js`

1. 次の関数を足す。形は `income-deductions.js` の同名の処理に合わせる。
   - `spouseDeductionCeiling(searchCriterion)`: D4。`income-deductions.js` の `calculateSpouseDeduction` の 51〜63 行と同じ確かめ（下限が一意で全体の最小）を行い、下限 − 1 の金額を返す。止めるときの文は `配偶者特別控除の最下段（配偶者の所得要件）が一意に決まりません`。
   - `specificRelativeIncomeCeiling(searchCriterion)`: D4。`income-deductions.js` と同じ（0 件・2 件以上は例外）。
2. `calculateSpouseDeduction`: 配偶者の所得が上限を超えていたら配偶者特別控除の表へ、上限以下なら配偶者控除の表へ進む。`wantsSpecial` を消す。配偶者特別控除の表に当たらない（133万円超）ときは今までどおり `null`。
3. `calculateDependentRows`: `dependent.totalIncome` があるときだけ上限と比べる。
   - 19 歳以上 23 歳未満で上限超 → 特定親族特別控除の表。`findRange` で当たらなければ例外（所得税と同じ文の形）。`kind: 'specificRelativeSpecial'` の行の形は今のまま。
   - それ以外で上限超 → `{ id, kind: 'dependent', category: 'income_over_limit', amount: 0円, differenceSuffix: null }`。
   - 上限以下・`totalIncome` なし → 今の分類。
   - 親族が 0 人なら上限の記録を引かない（`specificRelativeIncomeCeiling` は親族の `totalIncome` を比べるときだけ呼ぶ）。任意のままにするため。
4. `calculateResidentDeductions` の障害者控除: D6。配偶者は `spouse.totalIncome` があって上限を超えるなら除く。親族も同じ。本人は常に対象。
5. `sameLivelihoodSpouseCount(input, searchCriterion)`・`dependentCountForExemption(input, searchCriterion)`: D7。`calculateExemption` から `searchCriterion` を渡す。
6. `adjustmentDifference`: D8。`spouseRow.differenceSuffix` があるときだけ足し、無いときは何もしない。親族の行も同じ。警告を 2 か所とも消す。理由を短いコメントで 1 回だけ書く。

## R4. `src/tax-engine/income/income-deductions.js`

1. `calculateSpouseDeduction` の上限の計算を内部の関数 `spouseDeductionCeiling(searchCriterion)` に切り出す（動きは変えない）。
2. `calculateIncomeDeductions` の障害者控除: D6。今の `disabilityPeople` から、所得が上限を超える配偶者・親族を除く。親族の上限は `specificRelativeIncomeCeiling(searchCriterion)`。

## R5. 試験

金額はすべて手計算で固定した。`scripts/lib/__tests__/test-resident-tax-engine.js` の `calc`（`incomeYear: 2025`）で確かめる。

### 配偶者（本人の合計所得 600 万円）

| 配偶者の合計所得 | spouse | spouseSpecial | 年税額 `annualTaxTotal` |
| --- | --- | --- | --- |
| 0 | 330,000 | 0 | 526,500 |
| 580,000 | 330,000 | 0 | 526,500 |
| 580,001 | 0 | 330,000 | 526,500 |
| 1,000,000 | 0 | 330,000 | 526,500 |
| 1,000,001 | 0 | 310,000 | 528,500 |
| 1,300,000 | 0 | 60,000 | 553,500 |
| 1,300,001 | 0 | 30,000 | 556,500 |
| 1,330,000 | 0 | 30,000 | 556,500 |
| 1,330,001 | 0 | 0 | 559,500 |
| 2,000,000 | 0 | 0 | 559,500 |

検算の例（200 万円）: 課税標準 600万 − 基礎控除 43万 = 557万。市 6% 334,200・県 4% 222,800。調整控除は下限の 5万円で市 3% 1,500・県 2% 1,000。市 332,700・県 221,800。均等割 市 3,000・県 1,000・森林環境税 1,000。計 559,500。

### そのほか

1. 70 歳以上の配偶者（`ageAtYearEnd: 71`）: 所得 580,000 は配偶者控除 380,000、580,001 は配偶者特別控除 330,000。
2. 本人 950 万円・配偶者 100 万円は配偶者特別控除 220,000。本人 10,000,001 円・配偶者 100 万円と本人 10,000,001 円・配偶者 0 円は、どちらも 0 円。
3. 調整控除（本人 250 万円・配偶者 90 万円）: 課税標準 174万円、人的控除差は基礎の 5万円だけ。市調整 1,500・県調整 1,000。年税額 176,500 円。警告に `RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED` が無い。
4. 親族: 17 歳・所得 580,000 は扶養 330,000。17 歳・580,001 は 0 円で `income_over_limit`。20 歳・580,000 は特定扶養 450,000。20 歳・580,001 は特定親族特別控除 450,000。20 歳・950,001 は 410,000。20 歳・1,230,001 は 0 円。`totalIncome` なしの 17 歳は今までどおり 330,000。
5. 調整控除の差: 20 歳・580,000 は 18 万円が差に入る。20 歳・580,001 は入らない。
6. 非課税: `calculateExemption` で、配偶者の所得 0 円は `personCount` 2・`threshold` 1,010,000、配偶者の所得 580,001 円は `personCount` 1・`threshold` 450,000。親族の所得 580,001 円も数えない。16 歳未満の親族は数える（今のコメントのとおり）。
7. 障害者控除（住民税）: 配偶者の所得 580,000・`disability: 'general'` は 26 万円が付く。580,001 は付かない。親族も同じ。本人は所得によらず付く。`disability` の行の人的控除差も同じように増減する。
8. 特定親族の記録の 0 円の段を 2 件にすると止まる、`spouse_special_s1` の下限が 2 種類だと止まる（`test-income-tax-engine.js` の同じ確かめの書き方に合わせる）。

### `scripts/lib/__tests__/test-income-tax-engine.js`

9. 障害者控除（所得税、2025 年）: 配偶者の所得 580,000・`disability: 'general'` は 27 万円が付く。580,001 は付かない。親族（17 歳）も同じ。

### サービス

10. `test-hojinnari-service.js`: 平年度の個人側で、配偶者の所得 200 万円の住民税が、同じ入力の配偶者なしと一致する。所得税も一致する。
11. `test-yakuin-hoshu-service.js`: 同じことを④で確かめる。

既存の試験の金額が変わるときは、上の決定による変化かを手計算で確かめ、理由を最終報告に書く。

## 変えてはいけないもの

- マスターの JSON の値（`simulator-dependencies.json` 以外）。
- `SUPPORTED_YEAR`・`src/simulators/core/versions.js`。
- 公開用のまとめファイル（`assets/js/tax-simulator.*.js`・`tax-simulator-manifest.json`・`tax-simulator-boot.js`）。試験で書き換わったら戻す。作り直しは Claude が行う。
- 住民税の給与所得・生命保険料控除・基礎控除の計算。
- 文書（台帳・README・仕様書）。Claude が直す。

## 確かめること

1. `node scripts/lib/__tests__/test-simulator-required-keys.js`
2. `node scripts/lib/__tests__/test-simulator-dependencies.js`
3. `node scripts/lib/__tests__/test-resident-tax-engine.js`
4. `node scripts/lib/__tests__/test-income-tax-engine.js`
5. `node scripts/lib/__tests__/test-hojinnari-service.js`
6. `node scripts/lib/__tests__/test-yakuin-hoshu-service.js`
7. `node scripts/lib/__tests__/test-golden-cases.js`
8. `npm run masters:validate`・`npm run masters:gate`
9. `git status` で指示書に無いファイルが変わっていないこと。

`npm run masters:test` は Claude が隔離の外で流す。

## レビュー後の修正（Opus 5.5 xhigh レビュー 2026-11-01）

Critical・High は 0 件。差分の外で High 相当の不具合が 1 件見つかったので、F1 として同じ PR で直す（公開中の結果に影響する）。

### F1. 別居の老人扶養親族の人的控除差が 0 円になる（前からの不具合）

`calculateDependentRows` の接尾辞の作り方が誤っていて、`elderly_not_cohabiting` が `DEPENDENT-ELDERLY_ELDERLY` になり、10万円の差が入らない。文字列の置換をやめて対応表にする。

```js
const DEPENDENT_DIFFERENCE_SUFFIX = Object.freeze({
  general: 'DEPENDENT-GENERAL',
  specific: 'DEPENDENT-SPECIFIC',
  elderly_not_cohabiting: 'DEPENDENT-ELDERLY',
  elderly_cohabiting: 'DEPENDENT-ELDERLY-COHABITING',
});
```

試験（`calc`、2025 年、本人の合計所得 250 万円、親族 71 歳）

| 親族 | 所得控除 | 課税標準 | 人的控除差 | 市調整 | 県調整 | 年税額 |
| --- | --- | --- | --- | --- | --- | --- |
| 親・別居（`relation: 'parent'`・`livesTogether: false`） | 43万＋38万 | 1,690,000 | 5万＋10万 | 4,500 | 3,000 | 166,500 |
| 親・同居（`relation: 'parent'`・`livesTogether: true`） | 43万＋45万 | 1,620,000 | 5万＋13万 | 5,400 | 3,600 | 158,000 |

どちらも警告 `RT_ADJUSTMENT_DIFFERENCE_UNREGISTERED` が無い。

### F2. 本人の段が欠けると黙って 0 円になる（Medium 1）

記録の欠けで黙って 0 円にしない。次の 3 か所で、`findRange` が当たらないときは例外にする。

- `resident-tax.js` の配偶者特別控除: `配偶者特別控除の本人の所得の段がありません: ` ＋金額（所得税と同じ文）。
- `resident-tax.js` の配偶者控除: `配偶者控除の本人の所得の段がありません: ` ＋金額。
- `income-deductions.js` の `calculateSpouseDeduction`: 同じ文。

どの年の記録も本人の所得の全範囲を覆っている（1,000万円超の段は 0 円の記録がある）ので、正しい記録では今の動きは変わらない。

試験: `RT-SPOUSE-SP-S01-T2` を除いた記録で本人 920 万円・配偶者 60 万円が止まる（`test-income-tax-engine.js` の記録を差し替える確かめの書き方に合わせる）。

### F3. 「同一生計配偶者か」「扶養親族か」の判定を 1 か所にする（Medium 2）

`resident-tax.js`・`income-deductions.js` のそれぞれに内部の関数を置き、障害者控除の絞り込みと人数の両方で使う。

- `isSameLivelihoodSpouse(spouse, searchCriterion)`: `spouse` があり、`exists !== false`、`isSameLivelihood !== false`、`isSameLivelihoodSpouse !== false`、かつ `totalIncome` が無いか上限以下。
- `isDependentRelative(dependent, searchCriterion)`: `isDependent !== false`、かつ `totalIncome` が無いか上限以下。

`dependentCountForExemption` の `countsForResidentTaxExemption !== false` は人数だけの条件なのでそのまま残す。住民税の `calculateSpouseDeduction` の冒頭でも `isSameLivelihood === false`・`isSameLivelihoodSpouse === false` なら `null` を返す。

試験: `spouse: { exists: false, disability: 'general', totalIncome: 0円 }` に障害者控除が付かない（住民税・所得税）。

### F4. 必須の値の試験で「止まらないが金額が変わる」も見る（Medium 3・Low 1）

`test-simulator-required-keys.js`

1. `findBracket` も包む。空にするときは `null` を返す。
2. 任意の値を空にした結果を、差し替えなしの結果と比べる（`summary` と `breakdown.data`。BigInt は文字列にして比べる）。違えば失敗にする。
3. `small_business_special_deduction` は、空にしても `complete` のまま推奨が 2割特例の 20万円から簡易課税の 50万円に変わる。`shohizei` の `required` へ移す（`_basis` に `台帳 C-13。欠けても止まらず推奨が変わるので必須に置く`）。ほかに同じものが見つかったら同じように移し、最終報告に書く。

### F5. 上限の記録が取れないときは `blocked` の経路へ（Low 3）

`resident-tax.js` の `spouseDeductionCeiling`・`specificRelativeIncomeCeiling` と F2 の例外に `error.code = 'RT_MASTER_UNAVAILABLE'` を付ける（`requiredRecord` と同じ）。試験の期待も合わせる。

### F6. 境目の試験を足す（Low 4）

`calc`、2025 年。配偶者の所得 0 円（配偶者控除）と 60 万円（配偶者特別控除）の両方で、本人の合計所得ごとの控除額を確かめる。

| 本人の合計所得 | 控除額 |
| --- | --- |
| 9,000,000 | 330,000 |
| 9,000,001 | 220,000 |
| 9,500,000 | 220,000 |
| 9,500,001 | 110,000 |
| 10,000,000 | 110,000 |
| 10,000,001 | 0 |
