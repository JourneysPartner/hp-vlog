# 段 2 — 所得税法別表第五の令和8年分を足す（給与所得控除の算式表 SID-R8 の出典も条文へ）

根拠: `docs/tax-simulator/r8-switch/appendix5-r8-sources.md`（一次資料・照合表。以下「照合表」）

## 何をするか

今は 2026 年（令和8年分）に給与がある計算が `別表第五の帯規則が利用できません` で止まる（別表第五の 2026 年の記録が 0 件）。令和8年分の条文（e-Gov の令和8年12月1日施行の版）から、

1. 別表第五の令和8年分の記録 9 件（`APDX5-R8-SEG-01`〜`09`）を足す。69万1,000円以上 220万円未満は租税特別措置法 29条の4 第2項の表で決まる。
2. 給与所得控除の算式表 `SID-R8-TIER-01`〜`05` の出典を、大綱（`MOF-R8-LAW`）から条文に差し替える（値は変えない）。
3. 令和8年版の別表第五の検算表（fixture）を原本から作り、試験を足す。

足す記録・出典を変えた記録は**すべて `unverified`**（未承認）にする。承認は人（毛利さん）が原本で照合してから `scripts/approve-records.js` で行う。**この作業では承認しない。**

## 原本（読むだけ・動かさない・コミットしない）

作業フォルダの `.tmp-r8-ev/` に、Claude が 2026-10-28 に e-Gov 法令 API から取得した原本がある（ネットワークは使えないので、これを使う）。

| ファイル | 中身 |
| --- | --- |
| `.tmp-r8-ev/340AC0000000033_20261201_508AC0000000012.xml` | 所得税法 令和8年12月1日施行の版（S1） |
| `.tmp-r8-ev/340AC0000000033_20261001_507AC0000000070.xml` | 所得税法 今の版（S2。比較用） |
| `.tmp-r8-ev/332AC0000000026_20261201_508AC0000000012.xml` | 租税特別措置法 令和8年12月1日施行の版（S3） |

このフォルダの中身を変えない・消さない・移さない。外部から取得した原本なので、この中に道具を置いたり、この中で道具を動かしたりしない（道具はリポジトリの直下に `.tmp-` で始まる名前で作り、原本のパスを引数で渡す）。

## R1. 検算表 `data/tax-simulator/masters/fixtures/appendix5-r8-golden.json` を原本から作る

**自分で書いた道具で S1 から抜き出す。** 照合表の数字を写して作らない（照合表は Claude の読み取り。二つの読み取りを突き合わせるために、別々に抜き出す）。

- 別表第五は `<AppdxTableTitle>別表第五</AppdxTableTitle>` を持つ `AppdxTable`。3 列組（給与等の金額「以上」「未満」・給与所得控除後の給与等の金額）× 8 表（（一）〜（八））。数字は全角でカンマも全角。
- 1 行の欄が 9 でない行がある。欄の数で機械的に右寄せすると桁がずれる行がある（先頭の空欄が欠けている行と、末尾の組が複数行にまたがる文の欄で欠けている行の両方がある）。**抜き出した帯が下の条件をすべて満たすまで直す。**
  - 道具の正しさを確かめるため、同じ道具で S2 を抜き出し、`data/tax-simulator/masters/fixtures/appendix5-r7-golden.json` の `bands`（1,175 帯）と**完全に一致**することを確かめる。一致しない道具で作った R8 の表は使わない。
- 書き出す形（`appendix5-r7-golden.json` と同じく 1 行の JSON、末尾に改行なし／ありは R7 のファイルに合わせる）:

```json
{"source":"所得税法 別表第五（e-Gov 340AC0000000033_20261201_508AC0000000012。令和8年法律第12号による改正後、令和8年12月1日施行）","law_revision_id":"340AC0000000033_20261201_508AC0000000012","source_sha256":"<S1 のファイルの SHA-256 を計算して小文字 64 桁で>","extracted_at":"2026-10-28","band_count":<帯の数>,"bands":[[<以上>,<未満>,<給与所得控除後の給与等の金額>], ...],"text_rows":{"zero_below":<「…円未満」→「０」の行の金額>,"subtract_fixed":[<以上>,<未満>,<控除する金額>],"rate_minus_fixed":[<以上>,<未満>,<%の数>,<控除する金額>],"subtract_fixed_upper":[<以上>,<未満>,<控除する金額>]}}
```

  - `bands` は数字だけの行（帯）を「以上」の小さい順に並べる。文の行は `text_rows` へ。
  - 「20,000,000円 → 18,050,000円」の行は `bands` にも `text_rows` にも入れない（最終報告に、その行を見つけたかだけ書く）。
- Claude の抜き出しでは帯は 1,144 だった。**数が違っても Claude に合わせて直さない。** 違えば最終報告に書く（どちらが正しいかは別に確かめる）。

あわせて、S3 から `<Article Num="29_4">` の第2項（第1号〜第5号）と第1項を読み、照合表 3-1 の 1〜7 の区分・金額と一致するかを確かめる。一致しなければ R2・R3 を行わずに止めて報告する。

## R2. `data/tax-simulator/masters/data/salary-income-deduction/appendix5.json`

### R2-1. `r8` ブロックを置き換える

今の `"r8": { "_applies_to": …, "_status": …, "_next_action": … }`（ファイルの最後のブロック）を、次の文面で**そのまま**置き換える（字下げ・並びは `r7` ブロックに合わせてある。`<SHA-256 of S1>` と `<SHA-256 of S3>` だけ、原本のファイルから計算した小文字 64 桁を入れる）。

```json
  "r8": {
    "_applies_to": "令和8年分（令和8年法律第12号による改正後の別表第五と、租税特別措置法29条の4第2項の特例）",
    "_basis": "所得税法28条4項（給与等の収入金額が660万円未満なら別表第五による）。ただし令和8年・令和9年は、収入金額が69万1,000円以上220万円未満なら措法29条の4第2項の表が所法28条2項〜4項に優先する。220万円以上660万円未満は別表第五（令和8年12月1日施行の版）による。",
    "_extraction_source": {
      "law_id": "340AC0000000033",
      "law_revision_id": "340AC0000000033_20261201_508AC0000000012",
      "api": "https://laws.e-gov.go.jp/api/2/law_data/340AC0000000033_20261201_508AC0000000012",
      "sha256": "<SHA-256 of S1>",
      "special_measures_law_revision_id": "332AC0000000026_20261201_508AC0000000012",
      "special_measures_sha256": "<SHA-256 of S3>",
      "fetched_at": "2026-10-28",
      "fixture": "masters/fixtures/appendix5-r8-golden.json",
      "evidence": "docs/tax-simulator/r8-switch/appendix5-r8-sources.md"
    },
    "_rule_verification": "2,200,000〜6,599,999 の帯は「収入を4,000円単位に切り捨てた額に給与所得控除の算式（SID-R8）を当てる」ですべて再現できる。令和8年版の帯は2,026,000から始まる（最初の帯だけ幅2,000円）が、2,200,000未満は措法29条の4第2項が優先するので令和8年分では使わない。2,036,000以上の帯は令和7年分の表と同じ。",
    "_assumption": "令和8年中の最後の給与の支払日が令和8年12月1日以後であること（改正法附則13条2項）。12月1日前なら改正前の別表第五になり、収入651,000〜690,999円で結果が変わる。",
    "records": [
      {
        "record_id": "APDX5-R8-SEG-01",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "0" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "690999" },
        "method": "fixed_result",
        "fixed_result": { "unit": "JPY", "value": "0" },
        "_note": "691,000円未満は給与所得0（別表第五の最初の行）",
        "calculation_order": 1,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-INCOME-TAX-APDX5",
        "source_locator": "別表第五（一） 691,000円未満の行（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-02",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "691000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "740999" },
        "method": "fixed_result",
        "fixed_result": { "unit": "JPY", "value": "0" },
        "_note": "給与所得はないものとする（措法29条の4第2項第1号。令和8年・令和9年の特例で別表第五に優先する）",
        "calculation_order": 2,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-SPECIAL-TAX-MEASURES",
        "source_locator": "租税特別措置法29条の4第2項第1号（令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-03",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "741000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "2190999" },
        "method": "subtract_fixed",
        "subtract_amount": { "unit": "JPY", "value": "740000" },
        "_note": "収入金額から740,000円を控除した残額（措法29条の4第2項第2号。1円単位。帯にしない）",
        "calculation_order": 3,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-SPECIAL-TAX-MEASURES",
        "source_locator": "租税特別措置法29条の4第2項第2号（令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-04",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "2191000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "2192999" },
        "method": "fixed_result",
        "fixed_result": { "unit": "JPY", "value": "1451000" },
        "_note": "給与所得1,451,000円（措法29条の4第2項第3号）",
        "calculation_order": 4,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-SPECIAL-TAX-MEASURES",
        "source_locator": "租税特別措置法29条の4第2項第3号（令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-05",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "2193000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "2195999" },
        "method": "fixed_result",
        "fixed_result": { "unit": "JPY", "value": "1453000" },
        "_note": "給与所得1,453,000円（措法29条の4第2項第4号）",
        "calculation_order": 5,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-SPECIAL-TAX-MEASURES",
        "source_locator": "租税特別措置法29条の4第2項第4号（令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-06",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "2196000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "2199999" },
        "method": "fixed_result",
        "fixed_result": { "unit": "JPY", "value": "1456000" },
        "_note": "給与所得1,456,000円（措法29条の4第2項第5号）",
        "calculation_order": 6,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-SPECIAL-TAX-MEASURES",
        "source_locator": "租税特別措置法29条の4第2項第5号（令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-07",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "2200000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "6599999" },
        "method": "floor_to_band_then_deduction_table",
        "band_step": { "unit": "JPY", "value": "4000" },
        "deduction_table_value_key": "salary_income_deduction_table",
        "_note": "収入を4,000円単位に切り捨てた額Aを求め、Aに給与所得控除の算式（SID-R8）を当てて A − 控除額(A) を給与所得とする。2,200,000〜6,599,999 の全帯で原文と一致することを検証済み（fixtures/appendix5-r8-golden.json）",
        "calculation_order": 7,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-INCOME-TAX-APDX5",
        "source_locator": "別表第五（一）〜（八） 2,200,000〜6,600,000 の帯表（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-08",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "6600000" },
        "revenue_upper_inclusive": { "unit": "JPY", "value": "8499999" },
        "method": "rate_minus_fixed",
        "rate": { "num": "90", "den": "100" },
        "subtract_amount": { "unit": "JPY", "value": "1100000" },
        "_note": "給与等の金額に90%を乗じて算出した金額から1,100,000円を控除した金額（1円未満切り捨て。別表第五の備考）。所法28条4項の対象外（660万円以上）だが、年末調整（190条）で使うため別表第五に含まれる",
        "calculation_order": 8,
        "rounding_rule_id": "R-TRUNC-1-YEN",
        "source_document_id": "EGOV-INCOME-TAX-APDX5",
        "source_locator": "別表第五（八） 6,600,000〜8,500,000 の行と備考（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      },
      {
        "record_id": "APDX5-R8-SEG-09",
        "value_key": "salary_income_after_deduction_appendix5",
        "tax_year": 2026,
        "promulgated_at": "2026-03-31",
        "verified_at": null,
        "verified_by": null,
        "applies_to_period_start_from": null,
        "applies_to_period_start_to": null,
        "applies_to_transaction_from": null,
        "applies_to_transaction_to": null,
        "master_name": "salary_income_deduction_master",
        "tax_or_insurance_type": "income_tax",
        "jurisdiction": { "country": "JP" },
        "effective_from": "2026-01-01",
        "effective_to": "2026-12-31",
        "revenue_lower_inclusive": { "unit": "JPY", "value": "8500000" },
        "revenue_upper_inclusive": null,
        "method": "subtract_fixed",
        "subtract_amount": { "unit": "JPY", "value": "1950000" },
        "_note": "給与等の金額から1,950,000円を控除した金額（給与所得控除の上限）",
        "calculation_order": 9,
        "rounding_rule_id": "R-NONE",
        "source_document_id": "EGOV-INCOME-TAX-APDX5",
        "source_locator": "別表第五（八） 8,500,000〜20,000,000 の行（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）",
        "as_of_date": "2026-10-28",
        "legal_status": "enacted",
        "data_review_status": "unverified"
      }
    ]
  }
```

### R2-2. `r7` ブロックの `_r8_note` を 1 行だけ書き換える

```
今: "_r8_note": "R8改正で最低保障額が690,000円（R8・R9は特例で740,000円）になるため、別表第五も改正される。2026-08-24時点の e-Gov 現行法は651,000円始まりでR7版。R8版は施行後に取得すること。",
新: "_r8_note": "令和8年分は r8 ブロック（令和8年12月1日施行の版を、施行前に e-Gov の未施行の版から2026-10-28に取得）。",
```

ファイル冒頭の `_comment`・`_why_this_exists`・`_extraction_source`・`_rule_verification` と `r7` の記録は変えない（令和7年分の記録として残す）。

## R3. `data/tax-simulator/masters/data/salary-income-deduction/deductions.json` の SID-R8

**値（`revenue_*`・`deduction_type`・`fixed_amount`・`rate`・`rate_addition`）・期間・`tax_year`・`calculation_order`・`rounding_rule_id`・`legal_status`・`source_hash` は変えない。** 文字列として該当する行だけ書き換える（このファイルの書式は `JSON.stringify(…, null, 2)` に近いが、念のため行単位で変える）。

### R3-1. 5 件に共通

`SID-R8-TIER-01`〜`05` のそれぞれで:

| 項目 | 今 | 新 |
| --- | --- | --- |
| `promulgated_at` | `null` | `"2026-03-31"` |
| `verified_at` | `"2026-08-24"` | `null` |
| `verified_by` | `"毛利順活税理士事務所"` | `null` |
| `as_of_date` | `"2026-08-24"` | `"2026-10-28"` |
| `data_review_status` | `"approved"` | `"unverified"` |

### R3-2. 記録ごと

`SID-R8-TIER-01`
- `source_document_id`: `"MOF-R8-LAW"` → `"EGOV-SPECIAL-TAX-MEASURES"`
- `_composition`: → `"措法29条の4第1項が、令和8年・令和9年の給与収入220万円以下の給与所得控除額を74万円と定める（所法28条3項1号の最低額69万円に5万円を上乗せした額）。収入が74万円に満たないときは控除額＝収入（同項の括弧書き）だが、660万円未満の給与所得は別表第五・措法29条の4第2項で求め、この表を直接使わないので記録には持たない"`
- `source_locator`: → `"租税特別措置法29条の4第1項（令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012）"`
- `value_certainty`: `"derived"` → `"confirmed_from_source"`
- `requires_result_warning`・`_derivation`・`_warning_text`・`_affected_range` の 4 行を削る（前の行の末尾のカンマを JSON として正しく保つ）

`SID-R8-TIER-02`
- `source_document_id`: `"MOF-R8-LAW"` → `"EGOV-INCOME-TAX-ACT"`
- `_note`: → `"所得税法28条3項1号（令和8年版）の算式。下限2,200,001円は措法29条の4第1項の「二百二十万円以下」の次の1円"`
- `source_locator`: → `"所得税法28条3項1号（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）と租税特別措置法29条の4第1項（同 332AC0000000026_20261201_508AC0000000012）"`
- `value_certainty`: `"derived"` → `"confirmed_from_source"`
- `requires_result_warning`・`_derivation`・`_warning_text`・`_affected_range` の 4 行を削る

`SID-R8-TIER-03`
- `source_document_id`: `"MOF-R8-LAW"` → `"EGOV-INCOME-TAX-ACT"`
- `_note`: → `"令和7年版の28条3項3号と同じ算式。令和8年版では28条3項2号（116万円＋(収入−360万円)×20%）"`
- `source_locator`: → `"所得税法28条3項2号（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"`

`SID-R8-TIER-04`
- `source_document_id`: `"MOF-R8-LAW"` → `"EGOV-INCOME-TAX-ACT"`
- `_note`: → `"令和7年版の28条3項4号と同じ算式。令和8年版では28条3項3号（176万円＋(収入−660万円)×10%）"`
- `source_locator`: → `"所得税法28条3項3号（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"`

`SID-R8-TIER-05`
- `source_document_id`: `"MOF-R8-LAW"` → `"EGOV-INCOME-TAX-ACT"`
- `_note`: → `"上限。令和7年版の28条3項5号と同じ。令和8年版では28条3項4号"`
- `source_locator`: → `"所得税法28条3項4号（令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012）"`

### R3-3. `r8` ブロックとファイル冒頭の説明

- `r8._basis`: → `"所得税法28条3項（令和8年法律第12号による改正後。最低額69万円）と租税特別措置法29条の4第1項（令和8年・令和9年は給与収入220万円以下で74万円）。条文は e-Gov の令和8年12月1日施行の版（未施行）で確認した（docs/tax-simulator/r8-switch/appendix5-r8-sources.md）。"`
- `r8._status`: → `"施行前。令和8年12月1日施行・令和8年分以後に適用（改正法附則1条4号イ・3条1項）。legal_status は enacted。"`
- `r8._derived_boundary_warning`: 項目名を `_derived_boundary_resolved` に変え、値を → `"2026-10-28: 第1段階の上限2,200,000円は措法29条の4第1項に「二百二十万円以下」と書かれていることを条文で確かめた。2026-08-24に大綱から導いた値と同じ。"`
- `r8._usable_as_estimate`: → `"2026-10-28 に導出値は無くなった（TIER-01・02 を confirmed_from_source にした）。"`
- ファイル冒頭の `_r8_reform_note`: → `"令和8年分は r8 ブロック。最低保障額65万→69万（所法28条3項1号、令和8年分以後）＋令和8年・令和9年は74万（措法29条の4第1項）。条文は令和8年12月1日施行の版で確かめた（2026-10-28）。"`

## R4. 試験

### R4-1. `scripts/lib/__tests__/test-appendix5-rule.js` に令和8年分を足す（令和7年分の試験は変えない）

マスターの JSON をそのまま読む（承認の状態によらない）。数値の期待値は**下の表と原本から作った検算表**から取り、マスターの記録から作らない。

1. 検算表の健全性: `band_count === bands.length`、帯が連続している、最初の帯が `[2026000, 2028000, 1336000]`、それ以外の帯の幅がすべて 4,000円、上端が 6,600,000、`text_rows.zero_below === 691000`、`text_rows.subtract_fixed` が `[691000, 2026000, 690000]`、`rate_minus_fixed` が `[6600000, 8500000, 90, 1100000]`、`subtract_fixed_upper` が `[8500000, 20000000, 1950000]`。
2. 規則が表を再現: `r8.records` を、`deductions.json` の `r8.records`（SID-R8）を算式表として実行し、検算表の帯のうち下端が 2,200,000 以上の全帯（Claude の数えでは 1,100 帯）について、帯の下端・下端＋1,999・上端−1 の 3 点で一致すること。
3. 令和7年版との差が頭だけ: 検算表の帯のうち下端が 2,036,000 以上の全帯が、`appendix5-r7-golden.json` の同じ下端の帯と完全に同じ（Claude の数えでは 1,141 帯）。2,026,000〜2,036,000 の 3 帯は R7 と違う。
4. 区分の並び: `r8.records` の 9 件が `calculation_order` 1〜9、下端 0 から上限なしまで隙間も重なりも無い、期間がすべて 2026-01-01〜2026-12-31、`floor_to_band_then_deduction_table` がちょうど 1 件。
5. 期待値（照合表 4-4。法令の文言から計算したもの）を `r8.records` の規則で計算して一致すること:

```
収入        給与所得
0           0
690999      0
691000      0
740999      0
741000      1000
1000000     260000
2190999     1450999
2191000     1451000
2192999     1451000
2193000     1453000
2195999     1453000
2196000     1456000
2199999     1456000
2200000     1460000
2203999     1460000
2204000     1462800
3000000     2020000
3600000     2440000
3603999     2440000
3604000     2443200
6599999     4836800
6600000     4840000
8499999     6549999
8500000     6550000
```

（`10000000 → 8050000` は 660万円以上で算式表を使う値なので、R4-2 のエンジンの試験だけで確かめる。）

### R4-2. `scripts/lib/__tests__/test-income-tax-engine.js` に令和8年分（2026 年）を足す（今の試験は変えない）

承認の前後で両方とも意味のある確かめになる形にする。`appendix5.json` の `r8.records` と `deductions.json` の `r8.records` の 14 件を読み、

- **14 件すべてが `approved` のとき**: `salaryEngine.calculateSalaryIncome(yen(収入), { taxYear: 2026 })` が R4-1 の 5 の表どおり、かつ `10000000 → 8050000`、かつ検算表の 2,200,000 以上の全帯の下端と上端−1 で検算表どおりになること。
- **1 件でも `approved` でないとき**: 収入 3,000,000 と 8,000,000 の 2 つで、`taxYear: 2026` の計算が `別表第五の帯規則が利用できません` を含む例外で**止まる**こと（前年の値で黙って計算しない＝止まる側に倒れることの確かめ）。
- どちらを確かめたかを出力に書く（例: `令和8年分の記録は未承認: 止まることを確かめる`）。
- 一部だけ承認されている状態（14 件のうち一部だけ `approved`）は試験の失敗にする（承認は 14 件まとめて行う約束のため）。

### R4-3. 試験の追加で変えないもの

`package.json` の `masters:test` の一覧は変えない（2 本とも既に入っている）。

## R5. 変えてはいけないもの

- `data_review_status` を `approved` にしない。`verified_by` に人の名前を書かない。`scripts/approve-records.js` を `--write` で動かさない。
- R2・R3 に書いた以外の記録・項目（`appendix5.json` の `r7`、`deductions.json` の `r7`・`r2_to_r6`、`_comment`・`_do_not_use_below_6600000`・`_extraction_source`）。
- 次のファイル: `data/tax-simulator/masters/sources/source-registry.json`、`data/tax-simulator/masters/simulator-dependencies.json`、`data/tax-year/`、`data/nta-sources/`、`src/`、`scripts/`（R4 の試験 2 本を除く）、`docs/`、`.github/`、`package.json`。
- `assets/js/` の公開用まとめファイルと `tax-simulator-manifest.json`。画面の試験を流すと書き換わる。**戻さなくてよいので、書き換わったファイルを最終報告に列挙する**（Claude が戻す）。
- `.tmp-r8-ev/` の中身。
- エンジン（`src/tax-engine/`）は変えない。今の方式（`fixed_result`・`subtract_fixed`・`floor_to_band_then_deduction_table`・`rate_minus_fixed`）で表せる。表せないと分かったら変えずに【要判断】で報告する。

## 確かめること

1. `npm run masters:validate` が通る。
2. `node scripts/lib/__tests__/test-appendix5-rule.js` が通る（令和7年分と令和8年分）。
3. `node scripts/lib/__tests__/test-income-tax-engine.js` が通る（このときは「未承認: 止まる」側）。
4. **承認後の試し**（必ず元に戻す）: `appendix5.json` と `deductions.json` を `.tmp-` で始まる名前で控え、14 件の `data_review_status` だけを `approved` にして 3 の試験を流し、「承認済み: 期待値どおり」側が通ることを確かめる。終わったら控えから戻し、戻したファイルの SHA-256 が控えと同じことを確かめる。控えは消す。
5. `node scripts/approve-records.js`（`--write` を付けない）で「承認できる: 14 件」「見送り: 0 件」になり、対象がこの 14 件であること。
6. `node scripts/check-master-freshness.js --as-of 2026-10-28 --json` で: 「出典が更新された」16 件（今と同じ）、「対象期間のレコード無し」3 件（NTA-TA-1410・NTA-TA-1199・NTA-INCOME-R8。今と同じ）、「未承認」14 件（この 14 件）、公開判定は `hojinnari`・`yakuin_hoshu` が公開不可、`shohizei`・`sozoku` が公開可能（承認までの想定どおり）。違えば報告する。
7. `npm run masters:test` を流す。落ちた試験があれば名前とエラーの 1 行目を報告する（子プロセスの EPERM で落ちるものは環境のせいとして分けて書く）。
8. 変えたファイルが次の 5 本（＋試験で書き換わった `assets/js/` 等）だけであること:
   - `data/tax-simulator/masters/data/salary-income-deduction/appendix5.json`
   - `data/tax-simulator/masters/data/salary-income-deduction/deductions.json`
   - `data/tax-simulator/masters/fixtures/appendix5-r8-golden.json`（新規）
   - `scripts/lib/__tests__/test-appendix5-rule.js`
   - `scripts/lib/__tests__/test-income-tax-engine.js`

道具を作るなら `.tmp-` で始まる名前にし、終わったら消す（`.tmp-r8-ev/` は消さない）。
