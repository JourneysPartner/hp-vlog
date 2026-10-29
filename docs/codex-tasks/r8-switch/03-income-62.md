# 段 3 — 62万円の所得要件（特定親族特別控除・配偶者特別控除の最初の段を年で分ける）

根拠: `docs/tax-simulator/r8-switch/income-62-sources.md`（一次資料・照合表。以下「照合表」）

## 何をするか

令和8年分から、扶養親族と同一生計配偶者の合計所得金額の要件が 58万円以下 → **62万円以下** になる（所得税法 2条1項33号・34号）。エンジンは扶養親族の上限を特定親族特別控除の 0円の段（`IDED-SPECREL-T00`）の上限から、同一生計配偶者の上限を配偶者特別控除の最下段（`IDED-SPOUSE-SP-S01-*`）の下限 − 1 から導くので、

1. 今の 6 件（`IDED-SPECREL-T00`・`T01`、`IDED-SPOUSE-SP-S01-T1`〜`T4`）を **2025-12-31 で閉じる**（値は変えない）。
2. 令和8年分以後の 6 件（`IDED-SPECREL-R8-T00`・`R8-T01`、`IDED-SPOUSE-SP-R8-S01-T1`〜`T4`）を **2026-01-01〜無期限**で足す。
3. 記録が欠けたり重なったりしたとき、エンジンが黙って違う上限を使わないよう、`income-deductions.js` に止まる確かめを 3 つ足す。
4. 試験を足す。

閉じる 6 件・足す 6 件は**すべて `unverified`**（未承認）にする。承認は人（毛利さん）が原本で照合してから `scripts/approve-records.js` で行う。**この作業では承認しない。**

注意: 閉じる 6 件を未承認に戻すので、**承認までは令和7年分（2025 年）の計算も「特定親族特別控除の所得要件を取得できません」で止まる**。`npm run masters:test` は承認前だと多くの試験が落ちる。これは想定どおり。確かめは「確かめること」4 の承認の試しで行う。

## 原本（読むだけ・動かさない・コミットしない）

作業フォルダの `.tmp-r8-ev3/` に、Claude が 2026-10-29 に e-Gov 法令 API から取得した原本がある（ネットワークは使えないので、これを使う）。

| ファイル | 中身 |
| --- | --- |
| `.tmp-r8-ev3/340AC0000000033_20261201_508AC0000000012.xml` | 所得税法 令和8年12月1日施行の版（S1） |
| `.tmp-r8-ev3/340AC0000000033_20261001_507AC0000000070.xml` | 所得税法 今の版（S2。令和7年分に当たる） |

このフォルダの中身を変えない・消さない・移さない。この中に道具を置いたり、この中で道具を動かしたりしない（道具はリポジトリの直下に `.tmp-` で始まる名前で作り、原本のパスを引数で渡す）。

## R0. 原本の読み取り（報告だけ。ファイルは変えない）

**自分で書いた道具で** S1・S2 から次を抜き出し、照合表 3-1〜3-3 の原文と**意味が同じか**（金額・号の番号・「以下／超」の向き）を最終報告に書く。照合表の文を写して比べるのではなく、原本から読んだ文を報告に載せる。

- S1・S2 の 2条1項33号・34号（S1 は「六十二万円以下」、S2 は「五十八万円以下」のはず）
- S1 の 83条の2第1項（1号イ・2号・3号）と 84条の2第1項1号
- S1 の改正法（`AmendLawNum` が「令和八年三月三一日法律第一二号」の `SupplProvision`）の附則1条4号イ・2条1項

食い違いがあれば、マスターを変える前に止めて【要判断】で報告する。

## R1. `data/tax-simulator/masters/data/income-deduction/specific-relative-deduction.json`

### R1-1. 閉じる 2 件（`IDED-SPECREL-T00`・`T01`）

金額（`income_*`・`deduction_amount`）・`effective_from`・`calculation_order`・`legal_status`・`tax_year` は変えない。文字列として該当する行だけ書き換える。

2 件に共通

| 項目 | 今 | 新 |
| --- | --- | --- |
| `verified_at` | `"2026-08-24"` | `null` |
| `verified_by` | `"毛利順活税理士事務所"` | `null` |
| `as_of_date` | `"2026-08-24"` | `"2026-10-29"` |
| `data_review_status` | `"approved"` | `"unverified"` |
| `effective_to` | `null` | `"2025-12-31"` |
| `source_document_id` | `"NTA-TA-1177"` | `"EGOV-INCOME-TAX-ACT"` |
| `source_hash` | `"46ed1b1e…"`（64 桁） | `null` |

記録ごと
- `IDED-SPECREL-T00`
  - `source_locator` → `"所得税法2条1項34号（扶養親族: 合計所得金額が五十八万円以下）（令和8年12月1日前の版 340AC0000000033_20261001_507AC0000000070。令和8年法律第12号附則2条1項により令和7年分以前は従前の例）"`
  - `"source_document_id"` の行の直前に 1 行足す: `"_period_note": "令和7年分（2025年）だけ。令和8年分以後は IDED-SPECREL-R8-T00（62万円）",`
- `IDED-SPECREL-T01`
  - `source_locator` → `"所得税法84条の2第1項1号（合計所得金額が八十五万円以下である特定親族 六十三万円）。下限は2条1項34号（扶養親族: 五十八万円以下）の次の1円（令和8年12月1日前の版 340AC0000000033_20261001_507AC0000000070。令和8年法律第12号附則2条1項により令和7年分以前は従前の例）"`
  - `"source_document_id"` の行の直前に 1 行足す: `"_period_note": "令和7年分（2025年）だけ。令和8年分以後は IDED-SPECREL-R8-T01（62万円超85万円以下）",`

### R1-2. 足す 2 件（`IDED-SPECREL-T01` の直後、`IDED-SPECREL-T02` の前に）

ひな形は**直す前の**対応する記録（R8-T00 は T00、R8-T01 は T01）。項目の順番・字下げはひな形と同じにし、次の項目だけ変える。`_period_note` は `"source_document_id"` の行の直前に置く。

2 件に共通

| 項目 | 値 |
| --- | --- |
| `promulgated_at` | `"2026-03-31"` |
| `verified_at` | `null` |
| `verified_by` | `null` |
| `as_of_date` | `"2026-10-29"` |
| `legal_status` | `"enacted"` |
| `data_review_status` | `"unverified"` |
| `effective_from` | `"2026-01-01"` |
| `effective_to` | `null` |
| `source_document_id` | `"EGOV-INCOME-TAX-ACT"` |
| `source_hash` | `null` |

記録ごと

| 項目 | `IDED-SPECREL-R8-T00`（ひな形 T00） | `IDED-SPECREL-R8-T01`（ひな形 T01） |
| --- | --- | --- |
| `record_id` | `"IDED-SPECREL-R8-T00"` | `"IDED-SPECREL-R8-T01"` |
| `income_lower_inclusive.value` | `"0"`（同じ） | `"620001"` |
| `income_upper_inclusive.value` | `"620000"` | `"850000"`（同じ） |
| `deduction_amount.value` | `"0"`（同じ） | `"630000"`（同じ） |
| `_meaning` | `"合計所得金額62万円以下なら扶養親族（所得税法2条1項34号）＝控除対象扶養親族に該当するため、特定親族特別控除ではなく扶養控除（特定扶養親族63万円）を適用する。この控除は0円"` | （ひな形に無い） |
| `_tier_label` | （ひな形に無い） | `"62万円超85万円以下"` |
| `_period_note` | `"令和8年分以後（2026年〜）。令和7年分は IDED-SPECREL-T00（58万円）"` | `"令和8年分以後（2026年〜）。令和7年分は IDED-SPECREL-T01（58万円超85万円以下）"` |
| `source_locator` | `"所得税法2条1項34号（扶養親族: 合計所得金額が六十二万円以下）（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"` | `"所得税法84条の2第1項1号（合計所得金額が八十五万円以下である特定親族 六十三万円）。下限は2条1項34号（扶養親族: 六十二万円以下）の次の1円（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"` |

`_do_not_double_count`（T00）・`_income_basis`（T01）などほかの注記はひな形のまま。

### R1-3. ファイル冒頭

`"_resident_tax"` の行の直後（`"records"` の前）に 1 行足す:

`"_r8_change": "令和8年分以後、扶養親族の合計所得金額の要件が58万円以下から62万円以下になった（所得税法2条1項34号。令和8年法律第12号、令和8年12月1日施行・令和8年分以後に適用＝附則1条4号イ・2条1項）。最初の2段は令和7年分（T00・T01、2025年だけ）と令和8年分以後（R8-T00・R8-T01）に分けた。85万円超の段（T02〜T10）は両年で同じ。根拠と照合表: docs/tax-simulator/r8-switch/income-62-sources.md",`

ほかの冒頭の項目（`_extraction_source`・`_eligibility` など）は変えない。

## R2. `data/tax-simulator/masters/data/income-deduction/spouse-special-deduction.json`

### R2-1. 閉じる 4 件（`IDED-SPOUSE-SP-S01-T1`〜`T4`）

金額・本人の所得の区分・`applicability_conditions`・`effective_from`・`calculation_order`・`legal_status`・`source_document_id`（`NTA-TA-1195` のまま）は変えない。

4 件に共通

| 項目 | 今 | 新 |
| --- | --- | --- |
| `verified_at` | `"2026-08-24"` | `null` |
| `verified_by` | `"毛利順活税理士事務所"` | `null` |
| `as_of_date` | `"2026-08-24"` | `"2026-10-29"` |
| `data_review_status` | `"approved"` | `"unverified"` |
| `effective_to` | `null` | `"2025-12-31"` |
| `source_hash` | `"1e9f2166…"`（64 桁） | `data/nta-sources/taxanswer/shotoku/1195.json` の `html_hash`（`ee1364c5` で始まる 64 桁）。**ファイルから読んで書く**（手で打たない） |

記録ごと
- T1〜T3: `source_locator` の中の「令和7年分以降」を「令和7年分」に替える（ほかの文字は変えない）。T4 の `source_locator` は変えない。
- 4 件とも `"source_document_id"` の行の直前に 1 行足す: `"_period_note": "令和7年分（2025年）だけ。令和8年分以後は IDED-SPOUSE-SP-R8-S01-T<n>（62万円超）",`（`<n>` は 1〜4）

### R2-2. 足す 4 件

置き場所: `IDED-SPOUSE-SP-R8-S01-T1`〜`T3` は `IDED-SPOUSE-SP-S01-T3` の直後（`IDED-SPOUSE-SP-S02-T1` の前）に T1・T2・T3 の順で。`IDED-SPOUSE-SP-R8-S01-T4` は `IDED-SPOUSE-SP-S01-T4` の直後（`IDED-SPOUSE-SP-S02-T4` の前）。

ひな形は**直す前の** `IDED-SPOUSE-SP-S01-T<n>`（同じ `<n>`）。項目の順番・字下げはひな形と同じにし、次の項目だけ変える。`_period_note` は `"source_document_id"` の行の直前に置く。

4 件に共通

| 項目 | 値 |
| --- | --- |
| `record_id` | `"IDED-SPOUSE-SP-R8-S01-T<n>"` |
| `promulgated_at` | `"2026-03-31"` |
| `verified_at` | `null` |
| `verified_by` | `null` |
| `effective_from` | `"2026-01-01"` |
| `effective_to` | `null` |
| `applicability_conditions[0]`（`gte`）の `value.value` | `"620001"` |
| `applicability_conditions[0].description` | `"配偶者の合計所得金額 62万円超95万円以下（下限）"` |
| `applicability_conditions[1]`（`lte`）の `value.value` | `"950000"`（同じ） |
| `applicability_conditions[1].description` | `"配偶者の合計所得金額 62万円超95万円以下（上限）"` |
| `_spouse_income_range` | `"62万円超95万円以下"` |
| `_period_note` | `"令和8年分以後（2026年〜）。令和7年分は IDED-SPOUSE-SP-S01-T<n>（58万円超）"` |
| `source_document_id` | `"EGOV-INCOME-TAX-ACT"` |
| `source_hash` | `null` |
| `as_of_date` | `"2026-10-29"` |
| `legal_status` | `"enacted"` |
| `data_review_status` | `"unverified"` |

本人の所得の区分（`income_*`）・`deduction_amount`・`calculation_order`・`deduction_category`・`_self_income_range`・`_income_basis`・`_meaning` はひな形のまま（T1 380,000／T2 260,000／T3 130,000／T4 0）。

`source_locator`

| 記録 | 値 |
| --- | --- |
| R8-S01-T1 | `"所得税法83条の2第1項1号イ（合計所得金額が九十五万円以下である配偶者 三十八万円）。下限は2条1項33号（同一生計配偶者: 六十二万円以下）の次の1円（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"` |
| R8-S01-T2 | `"所得税法83条の2第1項2号（1号イの三十八万円の三分の二を1万円未満切り上げ＝26万円）。下限は2条1項33号（同一生計配偶者: 六十二万円以下）の次の1円（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"` |
| R8-S01-T3 | `"所得税法83条の2第1項3号（1号イの三十八万円の三分の一を1万円未満切り上げ＝13万円）。下限は2条1項33号（同一生計配偶者: 六十二万円以下）の次の1円（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"` |
| R8-S01-T4 | `"所得税法83条の2第1項（合計所得金額が千万円以下である当該居住者の配偶者に限る）。本人1,000万円超は適用なし（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"` |

### R2-3. ファイル冒頭

`"_r7_change"` の行の直後に 1 行足す:

`"_r8_change": "令和8年分以後、同一生計配偶者の合計所得金額の要件が58万円以下から62万円以下になり、最下段の下限が58万円超から62万円超になった（所得税法2条1項33号。令和8年法律第12号、令和8年12月1日施行・令和8年分以後に適用＝附則1条4号イ・2条1項）。83条の2の本文は変わらない。最下段は令和7年分（S01-T1〜T4、2025年だけ）と令和8年分以後（R8-S01-T1〜T4）に分けたので記録は40件。95万円超の段（S02〜S09）は両年で同じ。根拠と照合表: docs/tax-simulator/r8-switch/income-62-sources.md",`

ほかの冒頭の項目は変えない。

## R3. `src/tax-engine/income/income-deductions.js` — 止まる確かめを 3 つ

承認済みの記録がそろっていれば、結果は 1 円も変わらないこと。

1. `calculateSpouseDeduction`: 配偶者控除の上限を導く前に、その年の `income_deduction_spouse_special` のうち `deduction_category === 'spouse_special_s1'` の記録の `spouse_total_income` の `gte` の値を集め、**ちょうど 1 種類**であることを確かめる。0 種類・2 種類以上なら `Error('配偶者特別控除の最下段（配偶者の所得要件）が一意に決まりません')` を投げる。上限はその値 − 1。あわせて、その値が全記録の `gte` の最小値と同じことを確かめ、違えば同じ例外を投げる（今の「全記録の最小値 − 1」と結果が同じになることの確かめ）。
2. `specificRelativeIncomeCeiling`: `calculation_order === 0` の記録が 0 件なら今と同じ `Error('特定親族特別控除の所得要件を取得できません')`、2 件以上なら `Error('特定親族特別控除の所得要件（0円の段）が一意に決まりません')`。
3. `calculateDependentDeductions` の 19〜22歳で上限を超える場合: `findRange` が記録を返さないときは 0 円にせず `Error('特定親族特別控除の段がありません: <所得>')` を投げる（`<所得>` は `relativeIncome.value`）。

ほかの関数・ファイル（`resident-tax.js` を含む）は変えない。

## R4. 試験

### R4-1. `scripts/lib/__tests__/test-special-deductions.js`（記録を JSON から直接読む試験）

- 年で絞る補助関数を足す: その年の 1/1〜12/31 と記録の期間（`effective_from`〜`effective_to`、`null` は無期限）が重なる記録だけを返す。
- 今の Test 1・2・5・6 は**令和7年分（2025 年）に絞った記録**で、今の確かめをそのまま残す（件数 36・境目 580,000／580,001 など。弱めない）。
- Test 1 に 1 つ足す: 2025 年で配偶者 600,000 → 380,000（58万円超なので配偶者特別控除）。
- 令和8年分（2026 年）を足す（照合表 5-2 と 3 章の値）:
  - 配偶者特別控除: 2026 年の記録は 36 件。`lookup(R, 0, 620000) === null`（62万円以下は表に無い＝配偶者控除の範囲）、`(0, 620001) → 380000`、`(9200000, 620001) → 260000`、`(9800000, 620001) → 130000`、`(10500000, 620001) → 0`、`(0, 600000) → null`、`(0, 960000) → 360000`、`(0, 1320000) → 30000`。
  - 特定親族特別控除: 2026 年の記録は 11 件。`500000 → 0`、`600000 → 0`、`620000 → 0`、`620001 → 630000`、`850000 → 630000`、`850001 → 610000`、`1220000 → 30000`、`1300000 → 0`。
  - Test 5（所得税と住民税の突き合わせ）と Test 6（段の連続性）を 2026 年の記録でも流す。
- ファイル全体の件数: 配偶者特別控除 40 件、特定親族特別控除 13 件。
- 期間の切れ目: 2025・2026・2027 年のそれぞれで、配偶者特別控除は「配偶者の所得 [0, 580000, 580001, 600000, 620000, 620001, 950000, 950001, 1330000] × 本人の所得 [0, 9000000, 9000001, 9500001, 10000001]」、特定親族特別控除は「[0, 580000, 580001, 620000, 620001, 850000, 850001, 1230000, 1230001]」の各点で、当たる記録が **2 件以上にならない**こと。閉じた 6 件の `effective_to` が `"2025-12-31"`、足した 6 件の `effective_from` が `"2026-01-01"` であること。

### R4-2. `scripts/lib/__tests__/test-income-tax-engine.js`（今の試験は変えない。末尾の `console.log(... passed ...)` の前に足す）

**A. 本物のデータ（承認の状態で分ける）**
- 段 3 の 12 件（閉じる 6 件・足す 6 件）の `data_review_status` を JSON から読む。
- 12 件すべて `approved` のとき: 照合表 5-2 の表を `{ taxYear: 2026 }` と `{ taxYear: 2025 }` で確かめる（配偶者は `calculateSpouseDeduction`・`calculateSpouseSpecialDeduction`、扶養は `calculateDependentDeductions` の `rows` の `kind`・`category`・`amount`）。2025 年は 580,000／580,001 の境目も。
- 1 件でも `approved` でないとき: 「段 3 の 12 件がまとめて承認されていない（承認済み n 件）」で**試験失敗**にする（承認前に落ちるのは想定どおり。承認後に通る）。

**B. データを差し替えて確かめる（承認の状態によらず流れる）**

`scripts/lib/__tests__/test-tax-engine-common.js` の `loadSnapshotWithOneUnapprovedRecord` と同じやり方（`fs.readFileSync` を一時的に包み、`require.cache` から外して読み直す）で、2 つのマスターファイルを差し替えた `income-deductions.js` を作る。`snapshot.js` と、それを読み込むモジュール（`income-deductions.js` ほか）を読み直し、**終わったら `fs.readFileSync` と `require.cache` を元に戻す**（後の試験が本物のデータを使うように）。差し替えでは、まず段 3 の 12 件をすべて `approved` にしてから、下の変更を加える。

| # | 差し替え | 確かめること |
| --- | --- | --- |
| B0 | 変更なし（12 件を承認しただけ） | 照合表 5-2 の表が 2026 年・2025 年とも期待どおり |
| B1 | `IDED-SPOUSE-SP-R8-S01-T1`〜`T4` を `unverified` | 2026 年の `calculateSpouseDeduction`（本人 5,200,000、72歳・600,000）が「一意に決まりません」を含む例外。2025 年の同じ計算は 0 円で止まらない |
| B2 | `IDED-SPOUSE-SP-S01-T1`〜`T4` の `effective_to` を `null`（2026 年に 2 世代が重なる） | 2026 年の同じ計算が「一意に決まりません」を含む例外 |
| B3 | `IDED-SPECREL-T00` の `effective_to` を `null` | 2026 年の `calculateDependentDeductions([{ 30歳・600,000 }])` が「一意に決まりません」を含む例外 |
| B4 | `IDED-SPECREL-R8-T01` を `unverified` | 2026 年の 20歳・700,000 が「特定親族特別控除の段がありません」を含む例外。20歳・0 円は 630,000（特定扶養）で止まらない |

### R4-3. 試験の追加で変えないもの

`package.json` の `masters:test` の一覧は変えない（2 本とも既に入っている）。

## R5. 変えてはいけないもの

- `data_review_status` を `approved` にしない。`verified_by` に人の名前を書かない。`scripts/approve-records.js` を `--write` で動かさない（「確かめること」4 の一時的な試しを除き、必ず元に戻す）。
- R1・R2 に書いた以外の記録・項目（T02〜T10、S02〜S09 の各記録、`_extraction_source`・`_eligibility`・`_structure` など）。
- 次のファイル: `data/tax-simulator/masters/sources/source-registry.json`、`data/tax-simulator/masters/simulator-dependencies.json`、`data/tax-year/`、`data/nta-sources/`、`data/tax-simulator/masters/data/resident-tax/`、`src/`（R3 の 1 本を除く）、`scripts/`（R4 の試験 2 本を除く）、`docs/`、`.github/`、`package.json`。
- `assets/js/` の公開用まとめファイルと `tax-simulator-manifest.json`。画面の試験を流すと書き換わる。**戻さなくてよいので、書き換わったファイルを最終報告に列挙する**（Claude が戻す）。
- `.tmp-r8-ev3/` の中身。

## 確かめること

1. `npm run masters:validate` が通る。
2. `node scripts/lib/__tests__/test-special-deductions.js` が通る（承認の状態によらない）。
3. `node scripts/lib/__tests__/test-income-tax-engine.js` は承認前だと落ちる（2025 年の扶養の試験で止まる）。落ちた最初の試験名とエラーの 1 行目を報告する。
4. **承認後の試し**（必ず元に戻す）: 2 つのマスターファイルを `.tmp-` で始まる名前で控え、`node scripts/approve-records.js --by "試し" --write` を流して（対象が 12 件だけであることを 5 で先に確かめておく）、`node scripts/lib/__tests__/test-income-tax-engine.js` と `npm run masters:test` を流す。終わったら控えから戻し、戻したファイルの SHA-256 が控えと同じことを確かめる。控えは消す。
5. `node scripts/approve-records.js`（`--write` を付けない）で「承認できる」が 12 件・「見送り」が 0 件で、対象が段 3 の 12 件だけであること。
6. `node scripts/check-master-freshness.js --as-of 2026-10-29 --json` で: 「出典が更新された」10 件（今の 16 件から段 3 の 6 件が消える。残るのは CT-R1-REDUCED・ST-TYPE1〜6・IDED-SELFMED-FLOOR・-CAP・IT-H25-RECONSTRUCTION-SURTAX）、「対象期間のレコード無し」3 件（NTA-TA-1410・NTA-TA-1199・NTA-INCOME-R8。今と同じ）、「未承認」12 件（段 3 の 12 件）、公開判定は `hojinnari`・`yakuin_hoshu` が公開不可、`shohizei`・`sozoku` が公開可能。違えば報告する。
7. 変えたファイルが次の 5 本（＋試験で書き換わった `assets/js/` 等）だけであること:
   - `data/tax-simulator/masters/data/income-deduction/specific-relative-deduction.json`
   - `data/tax-simulator/masters/data/income-deduction/spouse-special-deduction.json`
   - `src/tax-engine/income/income-deductions.js`
   - `scripts/lib/__tests__/test-special-deductions.js`
   - `scripts/lib/__tests__/test-income-tax-engine.js`
8. 2 つのマスターファイルの `git diff` で、R1・R2 に書いた項目以外の行が変わっていないこと（足した記録・注記の行を除く）。

道具を作るなら `.tmp-` で始まる名前にし、終わったら消す（`.tmp-r8-ev3/` は消さない）。
