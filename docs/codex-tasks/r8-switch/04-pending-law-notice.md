# 段 4 — 「施行前・概算」の注記と対応年の判定

根拠: 設計書 `docs/tax-simulator/master-data-design.md` §10-4・§11-1、仕様書 `docs/tax-simulator/tax-simulator-spec-reviewed-final.md` §3-1・§48・§50、比較表 `docs/tax-simulator/r8-switch/comparison-income-r8.md` 3-1 の 3・4 と 6 章 #8。

## 何をするか

1. 計算に `legal_status: enacted`（成立・公布済みで適用開始前）の記録を使った結果に「施行前・概算」の注記を付け、`resultStatus` を `partial` にする。導出値（`value_certainty: derived`）の結果にも同じ扱いをする（今は 0 件だが、設計書の要件なので入れる）。
2. 年度マスターの対応年の表（`supported_tax_year`）を見て、対応していない年の計算を `blocked` で止める。
3. 注記を 4 ツールの結果画面の先頭に出す。
4. 記録の注記の古い文を直す。

**計算年は変えない**（`SUPPORTED_YEAR = 2025` のまま。切替は段 5）。公開中の令和7年分の金額・状態・警告はひとつも変わらない。まとめファイルも作り直さないので、この段だけでは公開画面は変わらない。

## 決めたこと（Claude の設計判断。変えない）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| D1 | 注記は**計算年ではなく、実際に使った記録**で決める。`usedMasterRecords` の `legalStatus === 'enacted'` が 1 件でもあれば付ける | 2026 年でも相続税や消費税は `enacted` を使わない計算がある。年で決めると誤って付く |
| D2 | `enacted` を使った結果は `complete` を返さず `partial` にする | 仕様書 §7 の「`complete` は入力条件の範囲で除外・未確定が無いことを意味する」と、設計書 §11-1 の導出値の扱いに揃える |
| D3 | 文言は 1 種類。日付を入れない | `enacted` には令和8年12月1日施行のもの（所得税）のほか、適用開始が先の相続の生前贈与加算（令和9年〜）もある。日付の説明は段 5 の画面の文言で書く |
| D4 | 対応年の判定は ①法人成り・④役員報酬（所得税の年）と ②消費税（課税期間の暦年）で行う。③相続税は行わない | 相続税は相続開始日で記録を引き、無ければ既に止まる。表は 2025〜2027 しか無く、試験は 2028 年の相続開始日を使う |
| D5 | `support_status` の扱い: ①④は `supported`・`supported_with_pending_law` だけ通す。②はそれに加えて `partial` も通す。表に無い年は止める | `TY-SUPPORTED-2027` の `_covered` は基礎控除 R9・相続・3割特例で、給与所得控除が無いので ①④ は計算できない。②は 3割特例を計算する試験がある |
| D6 | 判定の参照は使用記録に載せない（`snapshot.peek`） | `find` で引くと対応年の記録が結果の出典に載り、`TY-SUPPORTED-2026` の出典（大綱）が画面に出る |
| D7 | 対象年は `asOfDate` ではなく、コンテキストの課税年から取る | `asOfDate` は根拠確認日で課税年ではない（`hojinnari/service.js` 579 行の注記）。表の `_how_to_use` の文は R8 で直す |

## R1. `src/tax-engine/masters/snapshot.js`

1. `trackedRecordReference` に 3 項目を足す。
   - `valueCertainty: record.value_certainty ?? null`
   - `requiresResultWarning: record.requires_result_warning === true`
   - `warningText: typeof record._warning_text === 'string' ? record._warning_text : null`
2. `peek(valueKey, criterion)` を足して公開する。中身は `findRecords` をそのまま返すだけで、**使用記録に載せない**。`find` との違いをコメント 1〜2 行で書く。

## R2. `src/simulators/core/result-builder.js`

1. `WARNING_MAP` に足す。

| コード | level | canContinue | userAction |
| --- | --- | --- | --- |
| `MASTER_PENDING_LAW_APPLIED` | `attention` | `true` | `申告や判断に使う前に、施行後の取扱いをご確認ください` |
| `MASTER_DERIVED_VALUE_APPLIED` | `attention` | `true` | `法令で確定した値をご確認ください` |
| `SIM_TAX_YEAR_UNSUPPORTED` | `critical` | `false` | `税理士等の専門家にご確認ください` |

2. 定数を足す（この文のまま）。
   ```js
   const PENDING_LAW_NOTICE = '施行前・概算：この結果には、法律は成立・公布済みですが、まだ適用が始まっていない改正の値を使っています。確定した金額ではなく概算としてご覧ください。';
   const DERIVED_VALUE_NOTICE = '概算：この結果には、法令の本文に明記が無く計算で導いた値を使っています。';
   ```
3. `buildSimulationResult` で、`resultStatus` の値の確かめの**後**に次を行う。`blocked` のときは何もしない。
   - `usedMasterRecords` に `legalStatus === 'enacted'` が 1 件でもあれば、`MASTER_PENDING_LAW_APPLIED` の警告（本文 `PENDING_LAW_NOTICE`）を 1 件足す。
   - `valueCertainty === 'derived'` または `requiresResultWarning === true` の記録があれば、`warningText` の種類ごとに `MASTER_DERIVED_VALUE_APPLIED` の警告を 1 件ずつ足す。`warningText` が `null` の記録は `DERIVED_VALUE_NOTICE` を使う。
   - 上のどちらかを足し、かつ `resultStatus === 'complete'` なら `partial` にする。
4. `PENDING_LAW_NOTICE` は外から使わない。画面は警告の `basis` を読む（R5）。

## R3. 対応年の判定

### R3-1. 新しいファイル `src/simulators/core/supported-year.js`

```js
'use strict';

const snapshot = require('../../tax-engine/masters/snapshot.js');

const UNSUPPORTED_TAX_YEAR_CODE = 'SIM_TAX_YEAR_UNSUPPORTED';
const INCOME_TAX_STATUSES = Object.freeze(['supported', 'supported_with_pending_law']);
const CONSUMPTION_TAX_STATUSES = Object.freeze([...INCOME_TAX_STATUSES, 'partial']);
```

- 内部の関数 `isSupported(year, statuses)`: `snapshot.peek('supported_tax_year', { taxYear: year })` を `record.tax_year === year` で絞り、**ちょうど 1 件**で `support_status` が `statuses` に含まれれば `true`。0 件・2 件以上・値集合の外は `false`（止める側に倒す）。承認されていない記録は `peek` が返さないので止まる。
- `unsupportedIncomeYearReasons(year, fieldPath)`: 対応していなければ理由 1 件の配列、対応していれば空配列。
- `unsupportedConsumptionPeriodReasons(period, fieldPath)`: `period.from`・`period.to` の暦年を含むすべての年を確かめ、対応していない年ごとに理由を返す。
- 理由の形は `{ code, fieldPath, message }`。`message` は `` `${year}年の計算にはまだ対応していません。前年の値では計算しません。` ``。

### R3-2. 呼び出し

| ファイル | 入れる場所 | fieldPath |
| --- | --- | --- |
| `src/simulators/hojinnari/service.js` | `supportedProfileReasons` の先頭で `reasons` に足す。年は `incomeYearFrom(context)` | `$.calculationContext.incomeTaxYear` |
| `src/simulators/yakuin-hoshu/service.js` | `supportedProfileReasons` の先頭で `reasons` に足す。年は `incomeYearFrom(context)` | `$.calculationContext.incomeTaxYear` |
| `src/simulators/shohizei/service.js` | `calculate` の先頭（`globalBlockers` の前）で、理由があれば `blockedCalculation` を返す | `$.calculationContext.consumptionTaxPeriod` |

相続税（`src/simulators/sozoku/service.js`）には入れない（D4）。

## R4. `src/tax-engine/consumption/consumption-tax.js` の先の日付の参照

`checkCounterpartyCap` は `{ onDate: '9999-12-31' }` で `invoice_counterparty_annual_cap` を引くので、令和7年分でも `INV-CAP-R8`（`enacted`）が使用記録に載る。このままだと R2 で**令和7年分の消費税の結果が `partial` に変わる**。使うと決まってから載せるように直す。

```js
function checkCounterpartyCap(item, taxablePeriod, itemIndex, reasons) {
  // 適用開始前の課税期間では上限を使わないので、開始日の確かめは使用記録に載せない。
  const peeked = masters.peek('invoice_counterparty_annual_cap', { onDate: '9999-12-31' });
  if (peeked.length === 1 && taxablePeriod.from < peeked[0].applies_to_period_start_from) return;
  const cap = requiredRecord('invoice_counterparty_annual_cap', { onDate: '9999-12-31' });
```

以後の行は変えない。記録が無い・2 件あるときは、これまでどおり `requiredRecord` が例外で止める（止まる側を保つ）。

## R5. 画面の注記

1. 新しいファイル `src/ui/pending-law-notice.js` に `pendingLawNoticeFrom(result)` を置く。`result.warnings` から `code === 'MASTER_PENDING_LAW_APPLIED'` を探し、あれば `basis` を、無ければ `undefined` を返す。
2. 4 つの結果の表示用データに `pendingLawNotice` を足す。`blocked` では付けない。
   - `src/ui/hojinnari/result-view-model.js` の `buildResultViewModel`
   - `src/ui/yakuin-hoshu/result-view-model.js` の `common`（`blockedViewModel` でも `common` を使うが、`blocked` の結果に警告は無いので `undefined` になる）
   - `src/ui/shohizei/result-view-model.js` の `common`
   - `src/ui/sozoku/result-view-model.js` の `common`
3. 4 つの `app.js` の結果画面で、**見出し（`h1`）の直後・結論や金額より上**に `<p>` で出す。`pendingLawNotice` が無ければ何も出さない。印刷でも消えないようにする（`*-no-print` を付けない）。
   - class は `hojinnari-pending-law-notice`・`yh-pending-law-notice`・`shohizei-pending-law-notice`・`sozoku-pending-law-notice`。各 `app.js` の中にある CSS の文字列に 1 行足す（太字・濃い色・薄い背景など、既存の注意の表示に揃える）。`assets/css` は変えない。
   - ④はモード A・B・C のどの結果でも出す。

## R6. ④→①の受け渡しで警告を捨てない（`src/ui/hojinnari/app.js` 683 行付近）

今は「`sourceResultStatus === 'partial'` かつ ①の結果が `complete`」のときだけ、④の警告と除外項目を①の結果へ足している。段 5 の後は①の結果が常に `partial` になるので、**④の警告が捨てられる**（今も①が `partial` のときは捨てられている）。

- 条件を `sourceHandoff && sourceHandoff.sourceResultStatus === 'partial' && simulated.resultStatus !== 'blocked'` に変える。
- 警告は `code`＋`fieldPath`＋本文（`basis` または `message`）が同じものだけ、除外項目は `code`＋`reason` が同じものだけ重複を除く（④・①の両方に同じ文の `MASTER_PENDING_LAW_APPLIED` があるとき 1 件にする。同じ `code` でも本文が違えば両方残す）。`code` の無い要素はそのまま残す。先に現れたものを残す。
- `§13-1` のコメントは意味に合わせて直す。

## R7. 消費税の免税の表示を `complete` に結び付けない

免税事業者の結果（方式の行が 0 件）が `partial` になると、画面が免税の表示に入らない。次の 2 か所を `result.resultStatus !== 'blocked'` に変える。

- `src/ui/shohizei/app.js` 350 行 `const exempt = result.resultStatus === 'complete' && ...`
- `src/ui/shohizei/result-view-model.js` 167 行 `if (result.resultStatus === 'complete' && methodResults.length === 0)`。あわせて同じ塊の見出し `` `試算結果（${result.periodLabel}・complete）` `` を `${result.resultStatus}` にする。

## R8. 記録の注記（値は変えない。文字列として該当の行だけ書き換える）

いずれも先頭が `_` の注記の項目だけを変える。`data_review_status`・`verified_at`・`verified_by`・`as_of_date`・`legal_status` は変えない。

### R8-1. `data/tax-simulator/masters/data/income-deduction/personal-deductions.json`

- `_eligibility`（334 行付近）→ `"納税者本人の合計所得金額が1,000万円超なら適用なし。配偶者の合計所得金額は62万円以下（令和8年分〜。令和7年分は58万円以下、令和2〜6年分は48万円以下）"`
- `_r7_change` の次の行に足す → `"_r8_change": "配偶者の所得要件58万円→62万円は令和8年12月1日施行・令和8年分から適用（所得税法2条1項33号）。給与のみなら収入136万円以下（令和7年分は123万円以下）",`

### R8-2. `data/tax-simulator/masters/data/tax-year/tax-year-master.json`

- `supported_years._how_to_use` → `"計算の対象年は CalculationContext の課税年（①④は incomeTaxYear、②は課税期間の暦年）で決め、この表で対応可否を確認する（src/simulators/core/supported-year.js）。未対応なら resultStatus: blocked を返し、前年値へ黙ってフォールバックしない（§3-1）。①④は supported と supported_with_pending_law だけ、②は partial も通す。③相続税は相続開始日で記録を引き、無ければ止まるので、この表では判定しない。"`
- `TY-SUPPORTED-2026._covered` → `"上記に加えて、令和8年分の基礎控除・給与所得控除（別表第五・措法29の4）・62万円の所得要件・インボイス経過措置・社会保険料率"`
- `TY-SUPPORTED-2026._caveat` → `"所得税の令和8年度改正は令和8年12月1日施行（令和8年法律第12号）。施行までは legal_status: enacted で、それを使った結果は resultStatus: partial になり「施行前・概算」の注記が付く（src/simulators/core/result-builder.js）。基礎控除 BD-R8 とインボイス経過措置の出典は大綱のまま（台帳 C-14）"`
- `TY-SUPPORTED-2026._action_after_enforcement` → `"施行後に legal_status を effective へ切り替える（別表第五・給与所得控除・62万円の要件の値は条文で確認済み。BD-R8 の出典の差し替えは台帳 C-14）"`

## R9. 試験（足す。今の試験を弱めない・消さない）

### 共通部（`scripts/lib/__tests__/test-simulator-service-core.js`）

1. `enacted` の使用記録あり・`complete` → `partial`・`MASTER_PENDING_LAW_APPLIED` が 1 件・本文に「施行前・概算」。
2. 2 件の `enacted` でも警告は 1 件。
3. `partial` は `partial` のまま、警告は付く。
4. `MASTER_RECORD_NOT_APPROVED` などで `blocked` のときは注記が付かず `blocked` のまま。
5. `enacted` が無ければ状態はそのまま・注記なし。
6. `valueCertainty: 'derived'`（`warningText` あり・なしの両方）、`requiresResultWarning: true` で `partial` と `MASTER_DERIVED_VALUE_APPLIED`。同じ文は 1 件にまとまる。
7. `peek` は使用記録に載らず、`find` は載る。同じ `peek` と `find` の結果の中身は同じ。
8. `trackedRecordReference` の 3 項目が結果の `usedMasterRecords` に入る。
9. 対応年: 2025・2026 は①④で通る。2024・2027・2028 は①④で理由 1 件。②の期間は 2025・2026・2027 が通り、2024・2028 と、2027-07-01〜2028-06-30（2028 だけ理由 1 件）を確かめる。

### サービス（`test-hojinnari-service.js`・`test-yakuin-hoshu-service.js`・`test-shohizei-service.js`・`test-sozoku-service.js`）

10. ①（平年度と移行年度）・④（A・B・C）を `incomeTaxYear: 2026` で呼ぶと `partial`・注記あり・`blocked` にならない。**マスターが足りずに止まる・例外になるときは、値を足さずに【要判断】で報告する。**
11. ①・④を 2025 年で呼ぶと、状態・警告は今までどおりで、注記が付かない。
12. ①・④を 2024 年・2027 年で呼ぶと `blocked`、`SIM_TAX_YEAR_UNSUPPORTED`（`level: 'critical'`、`canContinue: false`）、`breakdown` なし。
13. ②: 2025 年の課税期間で、適格請求書のない仕入れ（経過措置）を含む入力の結果に `INV-CAP-R8` が使用記録に**載らず**、注記が付かず、状態が今までどおり。
14. ②: 2026-10-01 以後の取引日の経過措置の仕入れを含む 2026 年の課税期間で、`INV-TRANS-02` を使い注記が付く。
15. ②: 2027 年は今の試験のまま通り、3割特例の記録を使うので注記が付く。2028 年は `blocked`。
16. ③: 相続開始日 2026-08-29 は `complete`・注記なし。2028-06-01（生前贈与加算）は `partial`・注記あり、金額の確かめは今の試験のまま。
17. ②の免税の結果: 使用記録に `enacted` がなく `complete` の今の試験を保つ。

### 画面（`test-hojinnari-ui.js`・`test-yakuin-ui.js`・`test-shohizei-ui.js`・`test-sozoku-ui.js`）

18. 注記の警告を含む結果を渡すと、表示用データの `pendingLawNotice` に文が入り、描いた画面で見出しの後・結論より前に出る。警告が無い結果では `pendingLawNotice` が `undefined` で、画面に要素が無い。
19. ④→①: `sourceResultStatus: 'partial'` のとき、①が `complete` でも `partial` でも④の警告が残り、同じ `code` が重ならない。①が `blocked` なら `blocked` のまま。
20. ②: `partial` で方式の行が 0 件の結果が免税の表示になる。

`scripts/run-test-files.js` に渡す一覧（`package.json` の `masters:test`）に新しい試験ファイルを足す場合は `package.json` も変える。既存の試験ファイルに足すなら変えない。

## 変えてはいけないもの

- `SUPPORTED_YEAR`、画面の年の文言と入力（`src/ui/**/app.js`・`input-builder.js`・`browser-entry.js` の 2025）。段 5 で変える。
- 金額・率・境目・期間・`legal_status`・`data_review_status`。R8 の注記の項目以外のマスターの行。
- `src/simulators/core/versions.js`（`calculationVersion`）。段 5 で判断する。
- `assets/js/tax-simulator.*.js`・`tax-simulator-manifest.json`・`tax-simulator-boot.js`。試験で書き換わったら戻す。
- `src/simulators/sozoku/service.js`（R3 の対象外）。
- `sources/source-registry.json`、`data/nta-sources/`、`data/tax-simulator/masters/data/` の R8 に書いていないファイル。

## 確かめること

1. `npm run masters:validate` が通る（警告は今の 3 件のまま）。
2. `npm run masters:test` が通る。子プロセスの EPERM で落ちる試験は、名前とエラーの 1 行目を報告する。
3. `npm run masters:gate` が 4 サービスとも公開可。
4. `git status --short` に、この指示書に書いたファイル以外が無い。`assets/` の差は戻す。
5. `git diff -- data/tax-simulator/masters/data` の変わった行が R8 の行だけ（`_` で始まる項目だけ）。

## レビューの後で足したこと（2026-10-31、Opus 5.5 xhigh。Critical・High 0、Medium 1、Low 4）

- R6 の重複の除き方を上の文に直した（Medium 1。`code` だけだと本文の違う警告を失う）。
- `consumption-tax.js` の `invoiceTransitionRecord` は、取引日が無いとき 2 件の記録が同じと確かめてから使用記録に載せる（D1。止まる方式の記録で注記が付かないように）。
- ④の `blocked` の表示用データは `warning.message` が無ければ `warning.basis` を読む（`SIM_TAX_YEAR_UNSUPPORTED` の本文が空になるのを防ぐ）。
- 記録するだけで直さないこと: ②の 2027 年で 3割特例の対象外でも、判定の `find` が `CT-SPECIAL-3WARI` を使用記録に載せるので注記が付く（`eligibility.js` の `specialRecord`）。注記が多く出る側のずれで、2027 年は画面から届かない。
