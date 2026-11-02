# 台帳 C-14・C-15（記録の分） — 大綱のままの記録を条文へ差し替え、住民税の 62万円を年で分ける

根拠: `docs/tax-simulator/r8-switch/c14-c15-sources.md`（一次資料・照合表。以下「照合表」）。先に `c13-c15-gate-resident-engine.md` の修正が入っていること（この枝はその上に作る）。

## 何をするか

1. 基礎控除 BD-R8・BD-R9 の 14 件の出典を大綱から条文へ。値は変えない。
2. インボイス経過措置 INV-TRANS-02〜05・INV-CAP-R8 の 5 件の出典を大綱から条文へ。値は変えない。INV-TRANS-02・INV-CAP-R8 は `effective` にする。
3. 住民税の RT-SPOUSE-SP-S01-T1〜T4・RT-SPECREL-T00・T01 の 6 件を 2025-12-31 で閉じ、所得年 2026 年以後の 6 件を足す。

対象の 31 件は**すべて `unverified`**。承認は人が原本で照合してから `scripts/approve-records.js` で行う。**この作業では承認しない。** 承認までは `npm run masters:gate` と本番のビルドが止まる。

## 原本（読むだけ・動かさない・コミットしない）

`.tmp-prereq/` に Claude が 2026-11-01 に e-Gov 法令 API から取得した原本がある（応答の XML）。このフォルダの中身を変えない・消さない。道具はリポジトリの直下に `.tmp-` で始まる別の名前で作る。

| ファイル | 中身 |
| --- | --- |
| `.tmp-prereq/340AC0000000033_20261201_508AC0000000012.raw` | 所得税法 令和8年12月1日施行の版（S1） |
| `.tmp-prereq/332AC0000000026_20261201_508AC0000000012.raw` | 租税特別措置法 令和8年12月1日施行の版（S2） |
| `.tmp-prereq/ct-cur.raw` | 消費税法 今の版。改正附則を収録（S4） |
| `.tmp-prereq/325AC0000000226_20270101_508AC0000000002.raw` | 地方税法 令和9年1月1日施行の版（S5） |
| `.tmp-prereq/lt-cur.raw` | 地方税法 今の版（S6） |

## R0. 原本の読み取り（報告だけ。ファイルは変えない）

**自分で書いた道具で**原本から次を抜き出し、照合表の原文と**意味が同じか**（金額・号の番号・「以下／超」の向き・日付）を最終報告に書く。照合表の文を写して比べない。

- S1 の 86条1項、S2 の 41条の16の2第1項（1号イ・ロ）
- S4 の `AmendLawNum` が「平成二八年三月三一日法律第一五号」の `SupplProvision` の 52条1項・53条1項（1〜3号）、「令和八年三月三一日法律第一二号」の附則90条3項・1条3号
- S5 の 23条1項7号・9号、292条1項7号・9号、34条1項10号の2（イ(1)・ロ・ハ）・12号イ、S6 の同じ 23条1項7号・9号
- S5 の `AmendLawNum` が「令和八年三月三一日法律第二号」の `SupplProvision` の附則1条2号・3条2項・11条2項

食い違いがあれば、マスターを変える前に止めて【要判断】で報告する。

## R1. `data/tax-simulator/masters/data/basic-deduction/deductions.json`

BD-R8-TIER-01〜07・BD-R9-TIER-01〜07 の 14 件。金額・境目・期間・`tax_year`・`legal_status`・`_composition` は変えない。文字列として該当する行だけ書き換える。

全件に共通

| 項目 | 新しい値 |
| --- | --- |
| `promulgated_at` | `"2026-03-31"` |
| `verified_at` | `null` |
| `verified_by` | `null` |
| `as_of_date` | `"2026-11-01"` |
| `data_review_status` | `"unverified"` |

`source_document_id`・`source_locator`（R8 と R9 で同じ。〈A〉は `令和8年12月1日施行の版 340AC0000000033_20261201_508AC0000000012`、〈B〉は `令和8年12月1日施行の版 332AC0000000026_20261201_508AC0000000012`）

| 段 | `source_document_id` | `source_locator` |
| --- | --- | --- |
| TIER-01 | `EGOV-SPECIAL-TAX-MEASURES` | `租税特別措置法41条の16の2第1項1号イ（〈B〉）・所得税法86条1項1号（〈A〉）` |
| TIER-02 | `EGOV-SPECIAL-TAX-MEASURES` | `租税特別措置法41条の16の2第1項1号ロ（〈B〉）・所得税法86条1項1号（〈A〉）` |
| TIER-03 | `EGOV-INCOME-TAX-ACT` | `所得税法86条1項1号（〈A〉）` |
| TIER-04 | `EGOV-INCOME-TAX-ACT` | `所得税法86条1項2号（〈A〉）` |
| TIER-05 | `EGOV-INCOME-TAX-ACT` | `所得税法86条1項3号（〈A〉）` |
| TIER-06 | `EGOV-INCOME-TAX-ACT` | `所得税法86条1項4号（〈A〉）` |
| TIER-07 | `EGOV-INCOME-TAX-ACT` | `所得税法86条1項柱書（合計所得金額が二千五百万円以下である居住者に限る）（〈A〉）` |

（〈A〉〈B〉は展開して書く。）

ファイルの `r8`・`r9` ブロックの `_applies_to` などの注記が「大綱」や「推論」「blocked」と書いていて今の状態と合わない場合は、最小の語句だけ直す。`_column_parsing_note` は「R8/R9 の列割当ては条文（所得税法86条・措法41条の16の2）で確かめた（台帳 C-14、2026-11-01）」の 1 文を末尾に足す。

## R2. `data/tax-simulator/masters/data/consumption-tax/rates-and-thresholds.json`

5 件。金額・割合・期間・`applies_to_*` は変えない。

全件に共通: `source_document_id` → `"EGOV-CONSUMPTION-TAX-ACT"`、`promulgated_at` → `"2026-03-31"`、`verified_at`・`verified_by` → `null`、`as_of_date` → `"2026-11-01"`、`data_review_status` → `"unverified"`。

〈C〉は `令和8年法律第12号14条による改正後。e-Gov 消費税法 363AC0000000108_20261101_507AC0000000013 の改正附則に収録`。

| 記録 | `source_locator` | `legal_status` |
| --- | --- | --- |
| INV-TRANS-02 | `所得税法等の一部を改正する法律（平成28年法律第15号）附則53条1項1号（〈C〉）` | `effective` |
| INV-TRANS-03 | `所得税法等の一部を改正する法律（平成28年法律第15号）附則53条1項2号（〈C〉）` | `enacted`（変えない） |
| INV-TRANS-04 | `所得税法等の一部を改正する法律（平成28年法律第15号）附則53条1項3号（〈C〉）` | `enacted`（変えない） |
| INV-TRANS-05 | `所得税法等の一部を改正する法律（平成28年法律第15号）附則53条1項柱書（令和十三年九月三十日まで）（〈C〉）` | `enacted`（変えない） |
| INV-CAP-R8 | `所得税法等の一部を改正する法律（平成28年法律第15号）附則52条1項（〈C〉）。適用は令和8年法律第12号 附則90条3項` | `effective` |

`_note`:
- INV-TRANS-02: `令和8年法律第12号14条で改正。改正前は令和8年10月1日から50%になる予定だったが、70%に引き上げたうえで期間を延長した`
- INV-TRANS-05: `経過措置の最後の段階（30%）が令和13年9月30日で終わるため、令和13年10月1日以後は経過措置なし`
- INV-TRANS-05 の `description` は変えない。

`INV-CAP-R8` の `description` は変えない。

## R3. `data/tax-simulator/masters/data/resident-tax/special-deductions.json`

ファイルの冒頭の `_generated` は「手で編集せず生成し直す」と書いているが、生成の道具はリポジトリに無い。今回は文字列として直接書き換え、`_generated` の文の末尾に `（生成の道具はリポジトリに無い。令和9年度分の 62万円は手で足した。台帳 C-15）` を足す。

冒頭の `_cross_check` の次に足す。

```json
  "_period_basis": "effective_from・effective_to は所得年で持つ。住民税の控除は所得年で引く（resident-tax.js の criteria.income）ので、令和8年度分は 2025-01-01、令和9年度分は 2026-01-01 から。",
```

### R3-1. 閉じる 6 件（RT-SPOUSE-SP-S01-T1〜T4、RT-SPECREL-T00、T01）

金額・境目・`legal_status` は変えない。

| 項目 | 新しい値 |
| --- | --- |
| `effective_to` | `"2025-12-31"` |
| `verified_at` | `null` |
| `verified_by` | `null` |
| `as_of_date` | `"2026-11-01"` |
| `data_review_status` | `"unverified"` |

`source_locator` は今の文の末尾に `（令和8年度分まで。所得要件 58万円は地方税法23条1項7号・9号の今の版 325AC0000000226_20261101_508AC0000000002）` を足す。

### R3-2. 足す 6 件

閉じる記録のすぐ後ろに、次の id で足す。形（項目の並び）は元の記録と同じにする。

| 新しい record_id | 元 | 変える項目 |
| --- | --- | --- |
| `RT-SPOUSE-SP-R9-S01-T1` | `RT-SPOUSE-SP-S01-T1` | 下の共通と、`gte` の条件の `value` を `"620001"`、`description` を `配偶者の合計所得金額 620,001円以上` |
| `RT-SPOUSE-SP-R9-S01-T2` | `…-T2` | 同上 |
| `RT-SPOUSE-SP-R9-S01-T3` | `…-T3` | 同上 |
| `RT-SPOUSE-SP-R9-S01-T4` | `…-T4` | 同上 |
| `RT-SPECREL-R9-T00` | `RT-SPECREL-T00` | 下の共通と、`income_upper_inclusive` を `620000`、`_meaning` の「58万円」を「62万円」 |
| `RT-SPECREL-R9-T01` | `RT-SPECREL-T01` | 下の共通と、`income_lower_inclusive` を `620001`。`_` で始まる注記に 58万円があれば 62万円 |

共通

| 項目 | 値 |
| --- | --- |
| `promulgated_at` | `"2026-03-31"` |
| `verified_at`・`verified_by` | `null` |
| `effective_from` | `"2026-01-01"` |
| `effective_to` | `null` |
| `source_document_id` | `"SOUMU-RESIDENT-TAX"` |
| `source_locator` | 元の文の末尾に `・23条1項7号・9号（令和9年1月1日施行の版 325AC0000000226_20270101_508AC0000000002）。適用は令和8年法律第2号 附則3条2項・11条2項（令和9年度分以後）` |
| `source_hash` | `null` |
| `as_of_date` | `"2026-11-01"` |
| `legal_status` | `"enacted"` |
| `data_review_status` | `"unverified"` |

`deduction_category`（`spouse_special_s1` など）・`calculation_order`・金額は元と同じ。

## R4. 試験

金額は手計算で固定した。承認前は試験の一部が通らない（基礎控除の 2026 年、配偶者の 2025 年）。「確かめること」の手順で確かめる。

### `scripts/lib/__tests__/test-resident-tax-engine.js`

本人の合計所得 600 万円（`previousYearTotalIncome`）。

| `incomeYear` | 配偶者の合計所得 | spouse | spouseSpecial | 年税額 |
| --- | --- | --- | --- | --- |
| 2025 | 580,000 | 330,000 | 0 | 526,500 |
| 2025 | 580,001 | 0 | 330,000 | 526,500 |
| 2026 | 580,001 | 330,000 | 0 | 526,500 |
| 2026 | 620,000 | 330,000 | 0 | 526,500 |
| 2026 | 620,001 | 0 | 330,000 | 526,500 |

`residentTaxFiscalYear` は指定しない（`incomeYear` と同じになる。均等割などの記録はその年で引く）。2026 年の結果に `MASTER_PENDING_LAW_APPLIED` が付くかは、サービスの層で確かめる（エンジンの戻り値には付かない。付く層は段 4 のまま）。

親族（2026 年）: 17 歳・620,000 は扶養 330,000。17 歳・620,001 は 0 円。20 歳・620,000 は特定扶養 450,000。20 歳・620,001 は特定親族特別控除 450,000。同じ親族を 2025 年の 580,000・580,001 でも確かめる。

### `scripts/lib/__tests__/test-special-deductions.js`

今の 81〜82 行などの住民税の境目の確かめを、2025 年（580,000 / 580,001）と 2026 年（620,000 / 620,001）の両方に広げる。消さない。

### 記録の形

`scripts/lib/__tests__/test-simulator-dependencies.js` か、合う試験のファイルに足す。

- BD-R8・BD-R9 の 14 件の `source_document_id` に `MOF-` で始まるものが無い。TIER-01・02 の金額が `620000 + 420000`・`620000 + 50000` に等しい。
- INV-TRANS-02〜05・INV-CAP-R8 の出典が `EGOV-CONSUMPTION-TAX-ACT`。INV-TRANS-02・INV-CAP-R8 が `effective`、INV-TRANS-03〜05 が `enacted`。
- 住民税の新旧の 12 件で、同じ段の金額が等しく、期間が重ならず隙間も無い。

### ②の注記

`scripts/lib/__tests__/test-shohizei-service.js` の「2026年10月1日の仕入はINV-TRANS-02を使い施行前注記付きpartial」の試験を、この決定に合わせて書き換える（消さない）。INV-TRANS-02 が `effective` になるので、2026 年の課税期間で `transactionDate: '2026-10-01'` のインボイスなし仕入れがある一般課税に、`MASTER_PENDING_LAW_APPLIED` は INV-TRANS-02 を理由に付かない。`usedMasterRecords` に INV-TRANS-02 が載ることは確かめ続ける。結果の状態が `complete` にならない場合は、理由になった記録の id を最終報告に書く。

## 変えてはいけないもの

- `source-registry.json`、`data/nta-sources/`、`data/tax-year/`。
- 指示書に無い記録。INV-TRANS-01 も変えない。
- `src/` のコード。エンジンの変更は要らない。必要に見えたら変えずに【要判断】で報告する。
- `SUPPORTED_YEAR`・`versions.js`、公開用のまとめファイル。
- 文書（台帳・README・仕様書・照合表）。Claude が直す。

## 確かめること

1. `npm run masters:validate`（警告の増減を最終報告に書く）。
2. `node scripts/approve-records.js` の内訳が 31 件だけ（書き込まない）。
3. **承認の試し**: 作業中のファイルに `node scripts/approve-records.js --by "試し" --write` → 上の試験と `test-golden-cases.js`・`test-resident-tax-engine.js`・`test-income-tax-engine.js`・`test-hojinnari-service.js`・`test-yakuin-hoshu-service.js`・`test-shohizei-service.js` を流す → **必ず元に戻す**（`git diff --stat` で承認の前と同じ変更量であること、`verified_by` に `試し` が残っていないことを確かめる）。
4. `git status` で指示書に無いファイルが変わっていないこと。

`npm run masters:test` は Claude が隔離の外で流す。
