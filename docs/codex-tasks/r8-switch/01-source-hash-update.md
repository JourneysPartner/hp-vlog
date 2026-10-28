# 段 1 — 値が変わらない記録の控え（source_hash）の更新

根拠: `docs/tax-simulator/r8-switch/hash-update-list-r8.md`（148 件の仕分けと 2026-10-28 の毛利さんの決定）

## 何をするか

鮮度チェックが「出典が更新された」と出している 148 件のうち、**値も期間も変わらないと確かめた 132 件**について、控えを今の版に合わせる。値は 1 つも変えない。

## R1. 対象の記録（132 件・13 ファイル）

ファイルごとの `record_id`（この一覧に無い記録は変えない）:

```
data/tax-simulator/masters/data/basic-deduction/deductions.json  (4)
  BD-R2-TIER-01 BD-R2-TIER-02 BD-R2-TIER-03 BD-R2-TIER-04
data/tax-simulator/masters/data/consumption-tax/rates-and-thresholds.json  (4)
  CT-R1-STANDARD CT-H26-OLD-RATE CT-EXEMPT-THRESHOLD CT-SIMPLIFIED-THRESHOLD
data/tax-simulator/masters/data/income-deduction/insurance-deductions.json  (13)
  IDED-LIFE-NEW-T1 IDED-LIFE-NEW-T2 IDED-LIFE-NEW-T3 IDED-LIFE-NEW-T4 IDED-LIFE-OLD-T1 IDED-LIFE-OLD-T2 IDED-LIFE-OLD-T3 IDED-LIFE-OLD-T4 IDED-EQ-T1 IDED-EQ-T2 IDED-EQ-LONG-T1 IDED-EQ-LONG-T2 IDED-EQ-LONG-T3
data/tax-simulator/masters/data/income-deduction/medical-deduction.json  (3)
  IDED-MEDICAL-CAP IDED-MEDICAL-FLOOR-FIXED IDED-MEDICAL-FLOOR-RATE
data/tax-simulator/masters/data/income-deduction/personal-deductions.json  (18)
  IDED-DISABILITY-GENERAL IDED-DISABILITY-SPECIAL IDED-DISABILITY-COHABITING-SPECIAL IDED-WIDOW IDED-SINGLE-PARENT IDED-WORKING-STUDENT IDED-DEPENDENT-GENERAL IDED-DEPENDENT-SPECIFIC IDED-DEPENDENT-ELDERLY IDED-DEPENDENT-ELDERLY-COHABITING IDED-SPOUSE-T1-GENERAL IDED-SPOUSE-T1-ELDERLY IDED-SPOUSE-T2-GENERAL IDED-SPOUSE-T2-ELDERLY IDED-SPOUSE-T3-GENERAL IDED-SPOUSE-T3-ELDERLY IDED-SPOUSE-T4-GENERAL IDED-SPOUSE-T4-ELDERLY
data/tax-simulator/masters/data/income-deduction/specific-relative-deduction.json  (9)
  IDED-SPECREL-T02 IDED-SPECREL-T03 IDED-SPECREL-T04 IDED-SPECREL-T05 IDED-SPECREL-T06 IDED-SPECREL-T07 IDED-SPECREL-T08 IDED-SPECREL-T09 IDED-SPECREL-T10
data/tax-simulator/masters/data/income-deduction/spouse-special-deduction.json  (32)
  IDED-SPOUSE-SP-S02-T1 IDED-SPOUSE-SP-S02-T2 IDED-SPOUSE-SP-S02-T3 IDED-SPOUSE-SP-S03-T1 IDED-SPOUSE-SP-S03-T2 IDED-SPOUSE-SP-S03-T3 IDED-SPOUSE-SP-S04-T1 IDED-SPOUSE-SP-S04-T2 IDED-SPOUSE-SP-S04-T3 IDED-SPOUSE-SP-S05-T1 IDED-SPOUSE-SP-S05-T2 IDED-SPOUSE-SP-S05-T3 IDED-SPOUSE-SP-S06-T1 IDED-SPOUSE-SP-S06-T2 IDED-SPOUSE-SP-S06-T3 IDED-SPOUSE-SP-S07-T1 IDED-SPOUSE-SP-S07-T2 IDED-SPOUSE-SP-S07-T3 IDED-SPOUSE-SP-S08-T1 IDED-SPOUSE-SP-S08-T2 IDED-SPOUSE-SP-S08-T3 IDED-SPOUSE-SP-S09-T1 IDED-SPOUSE-SP-S09-T2 IDED-SPOUSE-SP-S09-T3 IDED-SPOUSE-SP-S02-T4 IDED-SPOUSE-SP-S03-T4 IDED-SPOUSE-SP-S04-T4 IDED-SPOUSE-SP-S05-T4 IDED-SPOUSE-SP-S06-T4 IDED-SPOUSE-SP-S07-T4 IDED-SPOUSE-SP-S08-T4 IDED-SPOUSE-SP-S09-T4
data/tax-simulator/masters/data/income-tax/blue-return-deduction.json  (3)
  BLUE-DEDUCTION-650K BLUE-DEDUCTION-550K BLUE-DEDUCTION-100K
data/tax-simulator/masters/data/income-tax/brackets-h27.json  (8)
  IT-H27-BRACKET-01 IT-H27-BRACKET-02 IT-H27-BRACKET-03 IT-H27-BRACKET-04 IT-H27-BRACKET-05 IT-H27-BRACKET-06 IT-H27-BRACKET-07 IT-R7-HIGHEARNER-SURCHARGE
data/tax-simulator/masters/data/inheritance-tax/brackets-h27.json  (13)
  IHT-H27-BRACKET-01 IHT-H27-BRACKET-02 IHT-H27-BRACKET-03 IHT-H27-BRACKET-04 IHT-H27-BRACKET-05 IHT-H27-BRACKET-06 IHT-H27-BRACKET-07 IHT-H27-BRACKET-08 IHT-H27-BASIC-DEDUCTION IHT-H27-INSURANCE-EXEMPT IHT-H27-RETIREMENT-EXEMPT IHT-H27-SPOUSE-RELIEF IHT-R6-ADDITION-SURCHARGE
data/tax-simulator/masters/data/inheritance-tax/small-residential-land.json  (6)
  IHT-SRL-SPECIFIC-BUSINESS IHT-SRL-SPECIFIC-COMPANY IHT-SRL-SPECIFIC-RESIDENCE IHT-SRL-RENTAL IHT-SRL-LIMIT-NO-RENTAL IHT-SRL-LIMIT-WITH-RENTAL
data/tax-simulator/masters/data/inheritance-tax/tax-credits.json  (8)
  IHT-MINOR-CREDIT IHT-DISABILITY-CREDIT-GENERAL IHT-DISABILITY-CREDIT-SPECIAL IHT-SUCCESSIVE-CREDIT IHT-GIFT-ADDBACK-3Y IHT-GIFT-ADDBACK-TRANSITION IHT-GIFT-ADDBACK-7Y IHT-GIFT-ADDBACK-EXTRA-DEDUCTION
data/tax-simulator/masters/data/salary-income-deduction/deductions.json  (11)
  SID-R7-TIER-01 SID-R7-TIER-02 SID-R7-TIER-03 SID-R7-TIER-04 SID-R7-TIER-05 SID-R2-TIER-01 SID-R2-TIER-02 SID-R2-TIER-03 SID-R2-TIER-04 SID-R2-TIER-05 SID-R2-TIER-06
```

## R2. `source_hash` を今の版にする（125 件）

対象の記録のうち `source_hash` を持つ 125 件について、値を次の手順で求めた 64 桁に置き換える。

1. 記録の `source_document_id`（例 `NTA-TA-1180`）で出典台帳 `data/tax-simulator/masters/sources/source-registry.json` の `sources` を引き、`category` と `taxanswer_id` を得る。
2. `data/nta-sources/taxanswer/<category>/<taxanswer_id>.json` の `html_hash`（64 桁の全体）を使う。

置き換えの前に、その記録の今の `source_hash` が出典の**控えの版**（鮮度チェックの `recorded_hash` の 12 桁で始まるもの）であることを確かめる。違っていたら変えずに最終報告に書く。

## R3. `source_hash` が無い 7 件に書き足す

`BD-R2-TIER-02`・`BD-R2-TIER-03`・`BD-R2-TIER-04`・`SID-R2-TIER-03`・`SID-R2-TIER-04`・`SID-R2-TIER-05`・`SID-R2-TIER-06` は記録に `source_hash` が無く、ファイル冒頭の `_extraction_source.html_hash` を控えとして流用している。

- この 7 件に `"source_hash": "<R2 の手順で求めた 64 桁>"` を、`source_locator` の行の直後に 1 行足す（同じファイルの `BD-R2-TIER-01`・`SID-R2-TIER-01` と同じ並び・同じ字下げ）。
- ファイル冒頭の `_extraction_source` は**変えない**（そのファイルを最初に写した版の記録として残す）。

## R4. 確認日を入れる（132 件）

対象の 132 件すべてで、
- `as_of_date` を `"2026-10-28"` にする（今は 2026-08-23 が 40 件、2026-08-24 が 92 件）。
- `verified_at` を `"2026-10-28"` にする（今は 132 件とも 2026-08-24）。

`verified_by` は変えない。

## R5. 変えてはいけないもの

- 対象の記録の、R2〜R4 の 3 項目以外のすべて（値・期間 `effective_from`/`effective_to`・`legal_status`・`data_review_status`・`source_document_id`・`source_locator`・`verified_by`・`tax_year` など）。
- 次の 16 件（同じファイルにあるが対象外。控えも日付も今のまま）:
  ```
  CT-R1-REDUCED ST-TYPE1 ST-TYPE2 ST-TYPE3 ST-TYPE4 ST-TYPE5 ST-TYPE6
  IDED-SELFMED-FLOOR IDED-SELFMED-CAP IT-H25-RECONSTRUCTION-SURTAX
  IDED-SPECREL-T00 IDED-SPECREL-T01
  IDED-SPOUSE-SP-S01-T1 IDED-SPOUSE-SP-S01-T2 IDED-SPOUSE-SP-S01-T3 IDED-SPOUSE-SP-S01-T4
  ```
- 上の 13 ファイル以外のファイル（マスターのほかのファイル、`data/nta-sources/`、`sources/`、`data/tax-year/`、`assets/js/`、`scripts/`、`src/`、試験、ワークフロー、文書）。
- ファイルの書式。**文字列として、該当する行だけを書き換える**（R3 の 7 行を足す以外に行の増減を作らない）。`JSON.stringify` で書き直さない（13 本のうち 9 本で書式が変わる）。改行は LF のまま、UTF-8（BOM なし）。

道具を作るなら `.tmp-` で始まる名前にし、終わったら消す。

## 確かめること（最終報告に結果を書く）

1. `npm run masters:validate` が通る。
2. `node scripts/check-master-freshness.js --as-of 2026-10-28 --json` の `findings.hashMismatch` が **16 件**で、`record_id` が R5 の 16 件と一致する。`hashUntracked`・`sourceUnknown`・`sourceMissing`・`blocked`・`notApproved` は 0 件のまま。
3. `git diff --numstat` が上の 13 ファイルだけで、追加された行の合計 − 消えた行の合計 = 7（R3 の 7 行）。
4. 変わった行の数: `source_hash` 125 行（置き換え）＋7 行（追加）、`as_of_date` 132 行、`verified_at` 132 行。これ以外の行は変わっていない。
5. 各ファイルを `JSON.parse` して、対象の記録の R2〜R4 以外の項目が変更前（`git show HEAD:<file>`）と同じであること、対象外の記録がまるごと同じであることを、道具で確かめる。
6. `node scripts/lib/__tests__/test-check-master-freshness.js` と `npm run masters:test` を流す（子プロセスの起動が EPERM で落ちる試験は、名前とエラーの 1 行目だけ書く）。

## 試験について

この段は控えの項目だけを変えるので、新しい試験は足さない。鮮度チェックの試験（`test-check-master-freshness.js` の試験 6）は、実データで「別の出典を引く記録の `source_hash` にファイル冒頭の控えを書き写していない」ことを確かめている。R3 の 7 件は冒頭と同じ出典（`NTA-TA-1199`・`NTA-TA-1410`）なので、この確認の対象外になる。
